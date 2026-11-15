import { formatMoney, subtractMoney, type MoneyExponent } from '@ten98/runtime';
import { nameMatchKey } from '../../lib/names.ts';
import type { LedgerContext } from '../ledger/context.ts';
import { listCostCentres } from '../ledger/cost-centres.ts';
import { listLedgers } from '../ledger/masters.ts';
import { costCategorySummary, costCentreBreakup } from '../reports/cost-centres.ts';
import { readLineCosts } from './cost-rows.ts';
import type { CompareLine } from './compare.ts';
import { toMinor, type Dataset } from './dataset.ts';

/**
 * The cost centre figures of expected.json (each centre's debit and credit for the period) and of the scenario
 * checkpoints (from the start of the period to each date), compared with the cost category summary of the seeded company.
 * A centre is compared on its two totals, one line per centre and range. A top-level centre is read from the summary; a centre
 * that sits under another is not listed there (the summary rolls it into its top-most centre), so it is read from its own
 * break-up report, whose totals are the centre's own rows and those of its sub-centres. A difference is never adjusted away: when the
 * dataset's own rows explain part of the gap (rows the ledger module left out because their ledger takes no cost
 * centres, or vouchers that are not in the books) the line names those vouchers, and stays a difference.
 */

type Figure = { debit: string; credit: string };
type Range = { block: string; from: string; to: string; centres: Record<string, Figure> };

/** Every range the dataset states cost centre figures for: the period of expected.json first, then each checkpoint date. */
function expectedRanges(dataset: Dataset): Range[] {
  const found: Range[] = [];
  const { costCentres } = dataset.expected;
  if (costCentres) found.push({ block: `Cost centres ${costCentres.from} to ${costCentres.to}`, from: costCentres.from, to: costCentres.to, centres: costCentres.centres as Record<string, Figure> });
  const dates = (dataset.extraFiles['checkpoints.json'] as { dates?: Record<string, { costCentres?: Record<string, Figure> }> } | undefined)?.dates ?? {};
  for (const day of Object.keys(dates).sort()) {
    const figures = dates[day].costCentres;
    if (figures) found.push({ block: `Cost centres ${dataset.expected.period.from} to ${day}`, from: dataset.expected.period.from, to: day, centres: figures });
  }
  return found;
}

/** `seeded` is the set of dataset voucher keys that are in the books (the comparison reads it once). */
export async function compareCosts(context: LedgerContext, dataset: Dataset, seeded: ReadonlySet<string>): Promise<CompareLine[]> {
  const ranges = expectedRanges(dataset);
  if (!ranges.length) return [];
  const exponent: MoneyExponent = context.company.exponent;
  const money = (value: bigint) => formatMoney(value, exponent);
  const both = (debit: bigint, credit: bigint) => `Dr ${money(debit)} / Cr ${money(credit)}`;
  const entries = (dataset.extraFiles['costCentres.json'] ?? []) as { key: string; name: string; parent?: string }[];
  const stored = await listLedgers(context);
  const takesCentres = (ledgerKey: string) => {
    const entry = dataset.ledgers.find(item => item.key === ledgerKey)!;
    return stored.find(item => entry.standard ? item.systemKey === entry.standard : nameMatchKey(item.name) === nameMatchKey(entry.name))?.costCentres === true;
  };
  const centreIds = new Map((await listCostCentres(context)).map(centre => [nameMatchKey(centre.name), centre.id]));
  const lines: CompareLine[] = [];
  for (const { block, from, to, centres } of ranges) {
    const summary = await costCategorySummary(context, { from, to });
    const actual = new Map(summary.categories.flatMap(category => category.centres.map((centre): [string, { debit: bigint; credit: bigint }] => [nameMatchKey(centre.name), { debit: centre.debit, credit: centre.credit }])));
    for (const [key, figure] of Object.entries(centres)) {
      const entry = entries.find(item => item.key === key)!;
      const [wantedDebit, wantedCredit] = [toMinor(figure.debit, exponent), toMinor(figure.credit, exponent)];
      const centreId = centreIds.get(nameMatchKey(entry.name));
      if (centreId === undefined) { lines.push({ block, label: `Cost centre ${entry.name}`, expected: both(wantedDebit, wantedCredit), actual: 'centre missing', difference: 'n/a', ok: false }); continue; }
      // A sub-centre has its own figure in its break-up; a top-level centre with no figures in the period has no row in the summary and reads as zero.
      const got = entry.parent !== undefined ? (await costCentreBreakup(context, centreId, { from, to })).totals : actual.get(nameMatchKey(entry.name)) ?? { debit: 0n, credit: 0n };
      const [differenceDebit, differenceCredit] = [subtractMoney(got.debit, wantedDebit), subtractMoney(got.credit, wantedCredit)];
      const ok = differenceDebit === 0n && differenceCredit === 0n;
      const line: CompareLine = { block, label: `Cost centre ${entry.name}`, expected: both(wantedDebit, wantedCredit), actual: both(got.debit, got.credit),
        difference: both(differenceDebit, differenceCredit), ok };
      if (!ok) {
        // The vouchers of the dataset with rows on this centre that the books cannot show: not seeded, or on a ledger that takes no centres.
        const unreproduced = dataset.vouchers.filter(voucher => voucher.status === 'regular' && voucher.date >= from && voucher.date <= to
          && voucher.lines.some(row => readLineCosts(row.extras).some(cost => cost.centre === key) && (!seeded.has(voucher.key) || !takesCentres(row.ledger)))).map(voucher => voucher.key);
        if (unreproduced.length) line.note = `rows of this centre on ${unreproduced.length} voucher(s) are not in the books' figures (voucher not seeded, or its ledger takes no cost centres): ${unreproduced.slice(0, 6).join(', ')}${unreproduced.length > 6 ? ', ...' : ''}`;
      }
      lines.push(line);
    }
  }
  return lines;
}
