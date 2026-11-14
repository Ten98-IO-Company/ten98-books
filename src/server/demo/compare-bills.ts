import { addMoney, formatMoney, subtractMoney, type MoneyExponent } from '@ten98/runtime';
import type { LedgerContext } from '../ledger/context.ts';
import { listLedgers } from '../ledger/masters.ts';
import { billsOutstandingReport, partyBillsReport } from '../reports/bills.ts';
import { parseDueDate, readLineBills } from './bill-rows.ts';
import { planBills, type BillPlan } from './bills.ts';
import type { CompareLine } from './compare.ts';
import { dispositionOf, toMinor, type Dataset } from './dataset.ts';

/**
 * The bill figures of expected.json (pending bills per party at the end of the period, the count and total of pending
 * receivable and payable bills) and of the scenario checkpoints, compared with the bill reports of the seeded company.
 * Pending bills are read per party (`partyBillsReport`) at each date; a bill is compared by name, ignoring case, on its
 * pending amount and side and on its due date. The seeder leaves some rows out (see bills.ts), so some bills cannot be
 * reproduced; those are listed as not yet comparable, each with its reason, never dropped and never counted as a match.
 */

type Figure = { pending: string; side: 'Dr' | 'Cr'; dueDate: string };
type Expected = { asOf: string; block: string; ledgers: Record<string, Record<string, Figure>> };

const reasons = {
  foreign: 'a bill of a party with foreign-currency lines: ten98-books keeps bills in the base currency only, so those rows were left out of the postings (the reference also shows such bills restated at the report date)',
  unknown: 'a settlement of this bill was left out because the bill is created by a foreign-currency line or by a voucher the dataset carries without lines, which ten98-books cannot post',
  uncreated: 'no voucher ten98-books posts creates this bill, and the party has a voucher the dataset carries without lines (cancelled or with no accounting effect), which ten98-books cannot post',
} as const;

/** Every date the dataset states pending bills for, with the figures, the end of the period first. */
function expectedBills(dataset: Dataset): Expected[] {
  const found: Expected[] = [];
  const { outstanding } = dataset.expected;
  if (outstanding) {
    found.push({ asOf: outstanding.asOf, block: `Bills as at ${outstanding.asOf}`,
      ledgers: Object.fromEntries(Object.entries(outstanding.ledgers).map(([key, entry]) => [key, entry.bills.bills as Record<string, Figure>])) });
  }
  const dates = (dataset.extraFiles['checkpoints.json'] as { dates?: Record<string, { outstanding?: Record<string, { bills: Record<string, Figure> }> }> } | undefined)?.dates ?? {};
  for (const day of Object.keys(dates).sort()) {
    const figures = dates[day].outstanding;
    if (figures) found.push({ asOf: day, block: `Bills as at ${day}`, ledgers: Object.fromEntries(Object.entries(figures).map(([key, entry]) => [key, entry.bills])) });
  }
  return found;
}

export async function compareBills(context: LedgerContext, dataset: Dataset, plan: BillPlan = planBills(dataset)): Promise<CompareLine[]> {
  const exponent: MoneyExponent = context.company.exponent;
  const money = (value: bigint) => formatMoney(value, exponent);
  const signed = (value: bigint) => value === 0n ? money(0n) : `${money(value < 0n ? subtractMoney(0n, value) : value)} ${value < 0n ? 'Cr' : 'Dr'}`;
  const lines: CompareLine[] = [];
  const stored = await listLedgers(context);
  const appLedger = (key: string) => {
    const entry = dataset.ledgers.find(ledger => ledger.key === key)!;
    return { entry, ledger: stored.find(item => entry.standard ? item.systemKey === entry.standard : item.name.toLowerCase() === entry.name.toLowerCase()) };
  };

  for (const { asOf, block, ledgers } of expectedBills(dataset)) {
    for (const [key, bills] of Object.entries(ledgers)) {
      const { entry, ledger } = appLedger(key);
      const label = (what: string) => `${what} of ${entry.name}`;
      const wanted = new Map(Object.entries(bills).map(([name, figure]): [string, { name: string; pending: bigint; dueDate: string }] =>
        [name.toLowerCase(), { name, pending: figure.side === 'Dr' ? toMinor(figure.pending, exponent) : subtractMoney(0n, toMinor(figure.pending, exponent)), dueDate: parseDueDate(figure.dueDate)! }]));
      if (!ledger) { lines.push({ block, label: label('Pending bills'), expected: `${wanted.size} bill(s)`, actual: 'ledger missing', difference: 'n/a', ok: false }); continue; }
      const report = await partyBillsReport(context, ledger.id, { asOf });
      const actual = new Map(report.bills.map(bill => [bill.name.toLowerCase(), bill]));
      // A bill is left out of the comparison only for a reason the dataset itself shows. Bills the books hold that
      // expected.json does not list are always compared, also on a party with foreign-currency lines.
      const unposted = dataset.vouchers.some(voucher => dispositionOf(voucher) !== 'post' && voucher.extras?.party === key);
      const exclusion = (name: string): keyof typeof reasons | undefined => {
        const affected = plan.affected.get(key)?.get(name);
        if (affected) return affected;
        if (!wanted.has(name)) return undefined;
        if (plan.foreignLedgers.has(key)) return 'foreign';
        // Not named by any posted row: evidence is a voucher of this party that cannot be posted (it has no lines); without it, a typo in the name would hide here.
        return !actual.has(name) && !plan.created.get(key)?.has(name) && unposted ? 'uncreated' : undefined;
      };
      const names = [...new Set([...wanted.keys(), ...actual.keys()])].sort();
      const compared = names.filter(name => !exclusion(name));
      const sum = (pick: (name: string) => bigint) => compared.reduce((total, name) => addMoney(total, pick(name)), 0n);
      const wantedTotal = sum(name => wanted.get(name)?.pending ?? 0n), actualTotal = sum(name => actual.get(name)?.pending ?? 0n);
      const countOf = (map: Map<string, unknown>) => compared.filter(name => map.has(name)).length;
      const differing: string[] = [];
      for (const name of compared) {
        const [want, have] = [wanted.get(name), actual.get(name)];
        if (!have) differing.push(`${want!.name}: expected ${signed(want!.pending)}, not pending in the books${plan.created.get(key)?.has(name) ? '' : ' (no posted voucher of the dataset names this bill)'}`);
        else if (!want) differing.push(`${have.name}: pending ${signed(have.pending)} in the books, not in expected.json`);
        else if (want.pending !== have.pending) differing.push(`${want.name}: expected ${signed(want.pending)}, books ${signed(have.pending)}`);
      }
      if (compared.length || !names.length) {
        lines.push({ block, label: label('Pending bills'), expected: `${countOf(wanted)} bill(s), ${signed(wantedTotal)}`, actual: `${countOf(actual)} bill(s), ${signed(actualTotal)}`,
          difference: signed(subtractMoney(actualTotal, wantedTotal)), ok: differing.length === 0,
          ...differing.length ? { note: `${differing.length} bill(s) differ: ${differing.slice(0, 4).join('; ')}${differing.length > 4 ? '; ...' : ''}` } : {} });
        const both = compared.filter(name => wanted.has(name) && actual.has(name));
        const dueDiffering = both.filter(name => wanted.get(name)!.dueDate !== actual.get(name)!.dueDate);
        if (both.length) {
          lines.push({ block, label: label('Due dates'), expected: `${both.length} bill(s)`, actual: `${both.length - dueDiffering.length} bill(s) equal`, difference: String(-dueDiffering.length), ok: dueDiffering.length === 0,
            ...dueDiffering.length ? { note: `${dueDiffering.length} due date(s) differ: ${dueDiffering.slice(0, 4).map(name => `${wanted.get(name)!.name} expected ${wanted.get(name)!.dueDate}, books ${actual.get(name)!.dueDate ?? 'none'}`).join('; ')}${dueDiffering.length > 4 ? '; ...' : ''}` } : {} });
        }
      }
      // Bills ten98-books cannot reproduce, one line per reason.
      for (const reason of Object.keys(reasons) as (keyof typeof reasons)[]) {
        const those = names.filter(name => exclusion(name) === reason && wanted.has(name));
        if (!those.length) continue;
        lines.push({ block, label: label(`Pending bills not compared (${reason === 'foreign' ? 'foreign currency' : reason === 'unknown' ? 'settlement left out' : 'bill not created'})`),
          expected: `${those.length} bill(s), ${signed(those.reduce((total, name) => addMoney(total, wanted.get(name)!.pending), 0n))}`, actual: 'not compared', difference: 'n/a', ok: false, reason: reasons[reason] });
      }
    }
  }

  // Count and total of the pending bills of one side at the end of the period (gulfline and najd).
  for (const [side, name] of [['receivable', 'receivables'], ['payable', 'payables']] as const) {
    const figures = dataset.expected[name];
    if (!figures) continue;
    const to = dataset.expected.period.to;
    let count = 0, total = 0n;
    for (let after: string | undefined;;) {
      const page = await billsOutstandingReport(context, { side, asOf: to, limit: 1000, ...after ? { after } : {} });
      count += page.bills.length;
      total = page.total ?? total;
      if (!page.next) break;
      after = page.next;
    }
    const block = `Bills ${side} as at ${to}`;
    const wanted = toMinor(figures.pendingTotal, exponent);
    // The reference lists bills by the side they lie on; ten98-books lists the bills of the ledgers below receivables or
    // payables. Pending bills on the other group's ledgers that lie on this side (an advance from a customer is a credit
    // bill on a receivable ledger) are what would close a gap, so they are named when they do.
    const otherGroup = side === 'payable' ? 'receivables' : 'payables';
    const other: { count: number; total: bigint; which: string[] } = { count: 0, total: 0n, which: [] };
    for (const entry of dataset.ledgers.filter(candidate => candidate.group === otherGroup)) {
      const { ledger } = appLedger(entry.key);
      if (!ledger) continue;
      for (const bill of (await partyBillsReport(context, ledger.id, { asOf: to })).bills) {
        if (side === 'payable' ? bill.pending >= 0n : bill.pending <= 0n) continue;
        const keys = dataset.vouchers.filter(voucher => voucher.lines.some(line => line.ledger === entry.key && readLineBills(line.extras).found.some(row => row.name?.toLowerCase() === bill.name.toLowerCase() && (row.method === 'advance' || row.method === 'new_ref')))).map(voucher => voucher.key);
        other.count++;
        other.total = addMoney(other.total, bill.pending < 0n ? subtractMoney(0n, bill.pending) : bill.pending);
        other.which.push(`${bill.name} on ${entry.name} (${keys.join(', ')})`);
      }
    }
    // Only rows left out on a ledger below this side's group can explain a gap in its count or total.
    const within = (group: string | undefined, root: string): boolean => {
      for (let key = group, guard = 0; key && guard < 50; key = dataset.groups.find(candidate => candidate.key === key)?.under, guard++) if (key === root) return true;
      return false;
    };
    const left = plan.skipped.filter(row => within(dataset.ledgers.find(candidate => candidate.key === row.ledger)?.group, name));
    const reason = left.length ? `${left.length} bill row(s) on ledgers below ${name} were left out of the postings (see the seed output), so the pending bills cannot be reproduced exactly` : undefined;
    const explained = other.count > 0 && count + other.count === figures.pendingBills && addMoney(total, other.total) === wanted;
    const cause = explained ? `the difference is exactly ${other.count} pending ${side} bill(s) lying on ledgers below ${otherGroup} (${money(other.total)}): ${other.which.join('; ')}; the reference lists bills by the side they lie on, ten98-books by the ledgers below the group` : undefined;
    const add = (label: string, expectedText: string, actualText: string, difference: string, ok: boolean) =>
      lines.push({ block, label, expected: expectedText, actual: actualText, difference, ok, ...!ok && reason ? { reason } : {}, ...!ok && cause ? { note: cause } : {} });
    add(`Pending ${side} bills (count)`, String(figures.pendingBills), String(count), String(count - figures.pendingBills), count === figures.pendingBills);
    add(`Pending ${side} bills (total)`, money(wanted), money(total), money(subtractMoney(total, wanted)), total === wanted);
  }
  return lines;
}
