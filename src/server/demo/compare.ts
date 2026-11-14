import { formatMoney, subtractMoney, type MoneyExponent } from '@ten98/runtime';
import { financialYearOf } from '../../lib/company.ts';
import { FoundationError } from '../auth.ts';
import { ledgerContext } from '../ledger/context.ts';
import { listLedgers } from '../ledger/masters.ts';
import { balanceSheetReport, profitAndLossReport, trialBalanceReport } from '../reports/statements.ts';
import { listVouchers } from '../ledger/vouchers.ts';
import { withCompany } from '../tenancy.ts';
import { DemoError, dispositionOf, openingStockValue, seededVoucherTypeKeys, toMinor, type Dataset, type ItemsFile } from './dataset.ts';
import { findDemoCompany, findUserId, selectDatasets, type DemoSelection } from './seed.ts';

/**
 * Compares a seeded company's figures, read through the report modules (never SQL of its own), with the dataset's
 * expected.json. Amounts are compared exactly in minor units. A block of expected.json that ten98-books cannot compute
 * yet is named in `notComparable` and never counts as a difference.
 */

export type CompareLine = { block: string; label: string; expected: string; actual: string; difference: string; ok: boolean };
export type CompareResult = { slug: string; companyName: string; companyId: string; role: string; period: { from: string; to: string }; lines: CompareLine[]; notComparable: string[]; differences: number };

const comparable = { top: ['period', 'voucherCount', 'vouchersByType', 'trialBalance', 'profitAndLoss', 'balanceSheet'],
  trialBalance: ['totalDebit', 'totalCredit', 'ledgers'],
  profitAndLoss: ['grossProfit', 'netProfit', 'grossProfitExcludingStock', 'netProfitExcludingStock'], balanceSheet: ['total', 'closingStockInAssets'] };

/** Keys that only describe where a figure came from (report names, notes); they carry no figure, so they are not listed. */
const annotations = ['source', 'voucherCountNote', 'report', 'note'];

/** Why a whole block of expected.json cannot be compared yet; any other block gets the general reason. */
const blockReasons: Record<string, string> = {
  stockSummary: 'needs inventory',
  receivables: 'needs bill-wise receivables, which ten98-books does not track yet',
  payables: 'needs bill-wise payables, which ten98-books does not track yet',
  vat: 'needs the VAT return, which ten98-books does not compute yet',
};

/** Blocks and fields of expected.json that the comparison does not read, named with their reason. */
export function notComparable(expected: Record<string, unknown>): string[] {
  const names = Object.keys(expected).filter(key => !comparable.top.includes(key) && !annotations.includes(key)).map(key => `${key} (${blockReasons[key] ?? 'a feature block ten98-books cannot compute yet'})`);
  for (const block of ['trialBalance', 'profitAndLoss', 'balanceSheet'] as const) {
    const value = expected[block];
    if (value && typeof value === 'object') for (const key of Object.keys(value)) if (!comparable[block].includes(key) && !annotations.includes(key)) names.push(`${block}.${key} (not computed yet)`);
  }
  return names;
}

export async function compareDataset(userId: string, dataset: Dataset): Promise<CompareResult> {
  const company = await findDemoCompany(userId, dataset, 'read');
  if (!company) throw new DemoError(`"${dataset.company.name}" (${dataset.slug}) has not been seeded for this user. Run the seed command first.`);
  const { expected } = dataset;
  const { from, to } = expected.period;
  const lines: CompareLine[] = [];
  const skipped = notComparable(expected);

  await withCompany(userId, company.id, 'read', async (client, access) => {
    const context = await ledgerContext(client, access.companyId, userId, 'read');
    const exponent: MoneyExponent = context.company.exponent;
    const money = (value: bigint) => formatMoney(value, exponent);
    const balance = (signed: bigint) => signed === 0n ? money(0n) : `${money(signed < 0n ? subtractMoney(0n, signed) : signed)} ${signed < 0n ? 'Cr' : 'Dr'}`;
    const push = (block: string, label: string, expectedText: string, actualText: string, difference: string, ok: boolean) =>
      lines.push({ block, label, expected: expectedText, actual: actualText, difference, ok });
    const amount = (block: string, label: string, wanted: string, actual: bigint) => {
      const difference = subtractMoney(actual, toMinor(wanted, exponent));
      push(block, label, money(toMinor(wanted, exponent)), money(actual), money(difference), difference === 0n);
    };
    const number = (block: string, label: string, wanted: number, actual: number) => push(block, label, String(wanted), String(actual), String(actual - wanted), wanted === actual);

    // Voucher counts: every undeleted voucher dated in the period, whatever its status, for the types ten98-books has.
    // Vouchers of other types, and vouchers without lines (cancelled or no accounting effect), are never posted, so they
    // are taken out of the expected counts and named instead.
    if (expected.voucherCount !== undefined || expected.vouchersByType) {
      const byType = new Map<string, number>();
      let total = 0;
      for (let after: string | undefined;;) {
        const page = await listVouchers(context, { from, to, limit: 500, after });
        for (const voucher of page.vouchers) { byType.set(voucher.kind, (byType.get(voucher.kind) ?? 0) + 1); total++; }
        if (!page.next) break;
        after = page.next;
      }
      const unposted = dataset.vouchers.filter(voucher => voucher.date >= from && voucher.date <= to && dispositionOf(voucher) !== 'post');
      const unpostedOf = (type: string) => unposted.filter(voucher => voucher.type === type && dispositionOf(voucher) === 'no-entries').length;
      if (expected.voucherCount !== undefined) number('Vouchers', 'Voucher count (types ten98-books has)', expected.voucherCount - unposted.length, total);
      const expectedTypes = expected.vouchersByType ?? {};
      for (const type of [...new Set([...Object.keys(expectedTypes), ...expected.vouchersByType ? byType.keys() : []])].sort()) {
        if (!seededVoucherTypeKeys.includes(type)) continue;
        number('Vouchers', `Vouchers of type ${type}`, (expectedTypes[type] ?? 0) - unpostedOf(type), byType.get(type) ?? 0);
      }
      const listed = (counts: [string, number][]) => counts.map(([type, count]) => `${type} ${count}`).join(', ');
      const unsupported = Object.entries(expectedTypes).filter(([type]) => !seededVoucherTypeKeys.includes(type));
      if (unsupported.length) skipped.push(`voucher types ten98-books does not have, left out of the voucher counts: ${listed(unsupported)} (needs those voucher types)`);
      const noEntries = [...new Set(unposted.filter(voucher => dispositionOf(voucher) === 'no-entries').map(voucher => voucher.type))].map((type): [string, number] => [type, unpostedOf(type)]);
      if (noEntries.length) skipped.push(`vouchers without lines of supported types (cancelled or no accounting effect) cannot be represented yet, left out of the voucher counts: ${listed(noEntries)}`);
    }

    // Trial balance: totals, each named ledger's closing balance and side, and every ledger the file leaves out.
    const trial = expected.trialBalance;
    if (trial) {
      const report = await trialBalanceReport(context, { from, to });
      amount('Trial balance', 'Total debit', trial.totalDebit, report.grandTotals.closingDebit);
      amount('Trial balance', 'Total credit', trial.totalCredit, report.grandTotals.closingCredit);
      // Opening stock is not a ledger balance: ledger openings alone leave a difference of exactly its value (credit side
      // when capital was entered with the stock counted).
      const stockItems = dataset.extraFiles['items.json'] as ItemsFile | undefined;
      const stock = openingStockValue(stockItems, exponent);
      if (stockItems && stock > 0n) {
        const difference = report.openingDifference;
        const actual = difference.side === 'Dr' ? difference.amount : difference.side === 'Cr' ? subtractMoney(0n, difference.amount) : 0n;
        const wanted = subtractMoney(0n, stock);
        push('Trial balance', 'Opening-balance difference (equals the opening stock value)', balance(wanted), balance(actual), balance(subtractMoney(actual, wanted)), actual === wanted);
      }
      const stored = await listLedgers(context);
      const closing = new Map(report.nodes.filter(node => node.kind === 'ledger').map(node => [node.id, subtractMoney(node.closingDebit, node.closingCredit)]));
      const appLedger = (entry: Dataset['ledgers'][number]) =>
        stored.find(item => entry.standard ? item.systemKey === entry.standard : item.name.toLowerCase() === entry.name.toLowerCase());
      const matched = new Set<string>();
      for (const [key, figure] of Object.entries(trial.ledgers)) {
        const entry = dataset.ledgers.find(ledger => ledger.key === key)!;
        const ledger = appLedger(entry);
        const closingAmount = toMinor(figure.closing, exponent);
        const wanted = figure.side === 'Dr' ? closingAmount : subtractMoney(0n, closingAmount);
        const label = `Closing balance of ${entry.name}`;
        if (!ledger || !closing.has(ledger.id)) { push('Trial balance', label, balance(wanted), 'ledger missing', 'n/a', false); continue; }
        matched.add(ledger.id);
        const actual = closing.get(ledger.id)!;
        const difference = subtractMoney(actual, wanted);
        push('Trial balance', label, balance(wanted), balance(actual), balance(difference), difference === 0n);
      }
      // Ledgers expected.json does not list: a dataset ledger missing from the app, or any ledger of the app with a
      // balance, is a difference; a zero closing is not, but it is named rather than skipped.
      for (const entry of dataset.ledgers) if (!appLedger(entry) && !(entry.key in trial.ledgers)) {
        push('Trial balance', `Ledger ${entry.name}`, 'in the dataset', 'ledger missing', 'n/a', false);
      }
      const unlisted: string[] = [];
      for (const ledger of stored) {
        if (matched.has(ledger.id) || !closing.has(ledger.id)) continue;
        const actual = closing.get(ledger.id)!;
        const entry = dataset.ledgers.find(item => appLedger(item)?.id === ledger.id);
        if (actual === 0n) { unlisted.push(ledger.name); continue; }
        push('Trial balance', `Closing balance of ${entry?.name ?? ledger.name}${entry ? '' : ' (not in the dataset)'}`, 'not in expected.json', balance(actual), balance(actual), false);
      }
      if (unlisted.length) skipped.push(`trialBalance: ${unlisted.length} ledger(s) not listed in expected.json close at zero and were not compared (${unlisted.join(', ')})`);
    }

    // Profit and loss: a profit is positive, a loss negative.
    if (expected.profitAndLoss) {
      if (financialYearOf(context.company.financialYearStart, from).to < to) {
        // The one condition the report refuses; any other error is a failure, not a reason to skip.
        skipped.push('profitAndLoss (the period spans more than one financial year; ten98-books prepares one year at a time)');
      } else {
        const report = await profitAndLossReport(context, { from, to });
        const figures = expected.profitAndLoss;
        // When the file gives figures from the ledgers alone, the stock-inclusive ones cannot be compared (no stock here).
        const excludingStock = figures.grossProfitExcludingStock !== undefined || figures.netProfitExcludingStock !== undefined;
        if (excludingStock) {
          if (figures.grossProfitExcludingStock !== undefined) amount('Profit and loss', 'Gross profit (excluding stock)', figures.grossProfitExcludingStock, report.grossProfit);
          if (figures.netProfitExcludingStock !== undefined) amount('Profit and loss', 'Net profit (excluding stock)', figures.netProfitExcludingStock, report.netProfit);
          skipped.push('profitAndLoss.grossProfit and profitAndLoss.netProfit (include opening and closing stock; need inventory)');
        } else {
          amount('Profit and loss', 'Gross profit', figures.grossProfit, report.grossProfit);
          amount('Profit and loss', 'Net profit', figures.netProfit, report.netProfit);
        }
      }
    }

    // Balance sheet as at the end of the period; both sides are compared with the one expected total.
    if (expected.balanceSheet) {
      if (expected.balanceSheet.closingStockInAssets !== undefined) {
        skipped.push('balanceSheet.total and balanceSheet.closingStockInAssets (include closing stock; need inventory)');
      } else {
        const report = await balanceSheetReport(context, { date: to });
        amount('Balance sheet', 'Total capital and liabilities', expected.balanceSheet.total, report.totals.liabilities);
        amount('Balance sheet', 'Total assets', expected.balanceSheet.total, report.totals.assets);
      }
    }
  }).catch(error => {
    // A refusal of the report (a period the reports do not take) is a problem in expected.json, named as such.
    if (error instanceof FoundationError) throw new DemoError(`demo/${dataset.slug}/expected.json: the reports refused the period ${from} to ${to}: ${error.message}`);
    throw error;
  });
  return { slug: dataset.slug, companyName: company.name, companyId: company.id, role: company.role, period: expected.period, lines, notComparable: skipped, differences: lines.filter(line => !line.ok).length };
}

/** A readable table: one block per heading, then expected, actual and difference per line. */
export function formatCompareResult(result: CompareResult): string[] {
  const width = (pick: (line: CompareLine) => string, head: string) => Math.max(head.length, ...result.lines.map(line => pick(line).length));
  const [wl, we, wa, wd] = [width(l => l.label, 'Line'), width(l => l.expected, 'Expected'), width(l => l.actual, 'Actual'), width(l => l.difference, 'Difference')];
  const row = (label: string, e: string, a: string, d: string, mark: string) => `  ${label.padEnd(wl)}  ${e.padStart(we)}  ${a.padStart(wa)}  ${d.padStart(wd)}  ${mark}`;
  const out = [`${result.companyName} (${result.slug}), company ${result.companyId} (${result.role}), ${result.period.from} to ${result.period.to}`, row('Line', 'Expected', 'Actual', 'Difference', '')];
  let block = '';
  for (const line of result.lines) {
    if (line.block !== block) { block = line.block; out.push(`  ${block}`); }
    out.push(row(line.label, line.expected, line.actual, line.difference, line.ok ? 'ok' : 'DIFFERS'));
  }
  out.push(`  ${result.lines.length} line(s) compared, ${result.differences} differ.`);
  if (result.notComparable.length) out.push('  Not yet comparable:', ...result.notComparable.map(name => `    ${name}`));
  return out;
}

/** The `demo-compare` command; returns how many comparable lines differ, over every selected dataset. */
export async function compareDemo(selection: DemoSelection, print: (line: string) => void = console.log): Promise<number> {
  const userId = await findUserId(selection.email);
  let differences = 0;
  for (const dataset of await selectDatasets(selection)) {
    const result = await compareDataset(userId, dataset);
    for (const line of formatCompareResult(result)) print(line);
    differences += result.differences;
  }
  return differences;
}
