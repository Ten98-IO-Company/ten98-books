import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { compareDataset, formatCompareResult } from '../src/server/demo/compare.ts';
import { demoRoot, loadDataset } from '../src/server/demo/dataset.ts';
import { seedDataset } from '../src/server/demo/seed.ts';
import { balanceSheetReport, profitAndLossReport, trialBalanceReport } from '../src/server/reports/statements.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { inCompany, setupOwner, type Member } from './helpers/ledger.ts';

/**
 * The four large companies (gulfline and najd: 319 vouchers each with orders, stock journals, cancelled entries and
 * opening stock; harbourview: bills, cost centres, foreign currencies; sunrise: item invoices, bills of materials,
 * manufacturing stock journals) seeded as books_app and compared with their expected.json.
 *
 * Every remaining difference is asserted by name, not hidden, so a change in the data or the tools fails here on purpose.
 * Journals may use cash and bank ledgers, numbers restart each financial year and vouchers cancelled without lines are
 * posted as voids that take their numbers, so no comparable line differs and every voucher number matches.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('demo_large');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

type Expectation = {
  slug: string; created: number; voids: number; unsupported: Record<string, number>; noEntries: Record<string, number>;
  numbers: { checked: number; matched: number }; counts: [matches: number, differences: number, pending: number]; differs: string[];
  /** Bill rows: opening bills set, rows posted, rows left out (foreign-currency lines) and the ledger module's warnings by code. */
  bills: { opening: number; posted: number; foreign: number; warnings: Record<string, number> };
  /** Cost centres: categories and centres created, rows posted, rows left out and the ledger module's warnings by code. */
  costs: { categories: number; centres: number; posted: number; leftOut: number; warnings: Record<string, number> };
};
const tradingUnsupported = { sales_order: 3, delivery_note: 3, purchase_order: 2, receipt_note: 1, stock_journal: 4, memorandum: 2, reversing_journal: 1 };
const expectations: Expectation[] = [
  { slug: 'gulfline', created: 303, voids: 2, unsupported: tradingUnsupported, noEntries: {}, numbers: { checked: 302, matched: 302 }, counts: [65, 0, 0], differs: [],
    bills: { opening: 3, posted: 244, foreign: 0, warnings: {} }, costs: { categories: 0, centres: 0, posted: 0, leftOut: 0, warnings: {} } },
  { slug: 'najd', created: 303, voids: 2, unsupported: tradingUnsupported, noEntries: {}, numbers: { checked: 302, matched: 302 }, counts: [65, 0, 0], differs: [],
    bills: { opening: 3, posted: 244, foreign: 0, warnings: {} }, costs: { categories: 0, centres: 0, posted: 0, leftOut: 0, warnings: {} } },
  // The four vouchers cancelled without lines (receipt, sales, payment) are voids and hold their numbers, so all 189 numbers match.
  { slug: 'harbourview', created: 192, voids: 4, unsupported: { memorandum: 2, reversing_journal: 1 }, noEntries: {}, numbers: { checked: 189, matched: 189 }, counts: [81, 0, 12], differs: [],
    bills: { opening: 2, posted: 121, foreign: 17, warnings: {} }, costs: { categories: 2, centres: 5, posted: 147, leftOut: 0, warnings: {} } },
  { slug: 'sunrise', created: 216, voids: 2, unsupported: { stock_journal: 36, sales_order: 2, delivery_note: 2, memorandum: 2, purchase_order: 1, receipt_note: 1, reversing_journal: 1 }, noEntries: {},
    numbers: { checked: 214, matched: 214 }, counts: [65, 0, 0], differs: [],
    // payment-048 settles SI-STE-11 in full after debit-note-001 already took 88.20 of it: the ledger module accepts that and says so.
    bills: { opening: 1, posted: 145, foreign: 0, warnings: { bill_over_settled: 1 } }, costs: { categories: 1, centres: 6, posted: 25, leftOut: 0, warnings: {} } },
];

for (const expectation of expectations) {
  test(`${expectation.slug}: seeds its postable vouchers, reports every skip, runs again without change, and compares apart from the named differences`, async t => {
    const dataset = await loadDataset(join(demoRoot, expectation.slug));
    let started = Date.now();
    const first = await seedDataset(owner.userId, dataset);
    t.diagnostic(`first seed of ${dataset.vouchers.length} vouchers: ${Date.now() - started} ms`);
    assert.equal(first.companyCreated, true);
    assert.deepEqual(first.vouchers, { created: expectation.created, present: 0, cancelled: 0 });
    assert.equal(first.voided, expectation.voids, 'the vouchers cancelled without lines are posted as voids');
    assert.deepEqual(first.unsupportedTypes, expectation.unsupported);
    assert.deepEqual(first.noEntries, expectation.noEntries);
    assert.deepEqual(first.refused, [], 'a journal may use cash and bank ledgers, so nothing is refused');
    assert.deepEqual(first.numbers, { ...expectation.numbers, unnumbered: 0, kind: 'confirmed against the reference' });
    assert.ok(first.skipped.some(line => line.includes('not yet supported') || line.includes('not modelled')));
    assert.equal(first.bills.openingBills, expectation.bills.opening);
    assert.equal(first.bills.rowsPosted, expectation.bills.posted);
    assert.deepEqual(Object.fromEntries(Object.entries(first.bills.warnings).map(([code, which]) => [code, which.length])), expectation.bills.warnings);
    assert.equal(first.costs.switchedOn, expectation.costs.categories > 0);
    assert.deepEqual([first.costs.categories.created, first.costs.centres.created, first.costs.rowsPosted, first.costs.leftOutRows], [expectation.costs.categories, expectation.costs.centres, expectation.costs.posted, expectation.costs.leftOut]);
    assert.deepEqual(Object.fromEntries(Object.entries(first.costs.warnings).map(([code, which]) => [code, which.length])), expectation.costs.warnings);
    assert.equal(first.bills.skipped.length, expectation.bills.foreign ? 1 : 0);
    if (expectation.bills.foreign) assert.match(first.bills.skipped[0], new RegExp(`^${expectation.bills.foreign} bill rows on foreign-currency lines`));

    started = Date.now();
    const again = await seedDataset(owner.userId, dataset);
    t.diagnostic(`second seed (nothing to do): ${Date.now() - started} ms`);
    assert.deepEqual([again.companyCreated, again.vouchers, again.groups.created, again.ledgers.created], [false, { created: 0, present: expectation.created, cancelled: 0 }, 0, 0]);
    assert.deepEqual([again.bills.openingBills, again.bills.rowsPosted, again.bills.warnings], [0, 0, {}], 'a second run posts no bill rows and raises no warning');
    assert.deepEqual([again.voided, again.costs.rowsPosted, again.costs.categories.created, again.costs.centres.created, again.costs.switchedOn, again.costs.warnings], [0, 0, 0, 0, false, {}], 'a second run posts no void and no cost row and creates no cost master');
    assert.deepEqual([again.stock.units.created, again.stock.locations.created, again.stock.groups.created, again.stock.items.created, again.stock.switchedOn], [0, 0, 0, 0, false], 'and creates no stock master');
    assert.deepEqual(again.numberDifferences, first.numberDifferences);
    assert.deepEqual(first.numberDifferences, [], 'every voucher number equals the dataset\'s');

    const result = await compareDataset(owner.userId, dataset);
    t.diagnostic(`${result.lines.length} lines compared: ${result.matches} match, ${result.differences} differ, ${result.pending} not yet comparable`);
    const text = formatCompareResult(result).join('\n');
    assert.deepEqual([result.matches, result.differences, result.pending], expectation.counts, text);
    assert.deepEqual(result.lines.filter(line => !line.ok && !line.reason).map(line => line.label).sort(), expectation.differs, text);
    assert.equal(result.lines.find(line => line.label === 'Vouchers of type journal')!.ok, true, 'every journal is posted');
    assert.match(text, /MATCHES \(\d+\)[^]*DIFFERS \(\d+\)[^]*NOT YET COMPARABLE \(\d+ line\(s\)/);
    assert.ok(result.notComparable.some(line => line.startsWith('voucher types ten98-books does not have, left out of the voucher counts')));
  });
}

test('gulfline and najd: the 16 closings per company that were once recorded as zero are compared and match, and so is the loss', async () => {
  for (const slug of ['gulfline', 'najd']) {
    const result = await compareDataset(owner.userId, await loadDataset(join(demoRoot, slug)));
    const ledgers = result.lines.filter(line => line.block === 'Trial balance' && line.label.startsWith('Closing balance of'));
    assert.equal(ledgers.length, 46, slug);
    assert.ok(ledgers.every(line => line.ok), `${slug}: ${ledgers.filter(line => !line.ok).map(line => line.label).join(', ')}`);
    assert.equal(ledgers.filter(line => line.expected !== '0.00').length, 31, 'the 16 formerly zero ledgers and the 15 others are all compared with a real figure');
    const net = result.lines.find(line => line.label === 'Net profit (excluding stock)')!;
    assert.deepEqual([net.expected, net.actual, net.ok], ['-52839.06', '-52839.06', true]);
    assert.equal(result.lines.filter(line => line.reason).length, 0, 'nothing is left not yet comparable: the voids hold their numbers');
    assert.ok(!result.lines.some(line => line.label === 'Voucher numbers shifted by vouchers ten98-books does not post'));
  }
});

test('harbourview: the foreign-currency ledgers and the totals differ from expected by exactly the reference\'s restatement and its unrealised row, so they are not yet comparable', async () => {
  const result = await compareDataset(owner.userId, await loadDataset(join(demoRoot, 'harbourview')));
  const pending = Object.fromEntries(result.lines.filter(line => line.reason && line.block !== 'Voucher numbers' && !line.block.startsWith('Bills')).map(line => [line.label, [line.expected, line.actual]]));
  assert.deepEqual(pending, {
    'Total debit': ['587116.25', '586846.25'], 'Total credit': ['587116.25', '586846.25'],
    'Closing balance of Creditor G Overseas': ['15120.00 Cr', '14850.00 Cr'], 'Closing balance of Debtor F Overseas': ['60555.00 Dr', '60663.75 Dr'],
    'Unrealised exchange-difference row (a separate row in the expected trial balance)': ['378.75 Dr', 'not computed'],
    'Total capital and liabilities': ['318012.75', '317742.75'], 'Total assets': ['318012.75', '317742.75'],
  });
  const reason = result.lines.find(line => line.label === 'Total debit')!.reason!;
  assert.match(reason, /Expected total debit 587116\.25 = app 586846\.25 \+ restated ledgers -108\.75 \+ the row 378\.75; expected total credit 587116\.25 = app 586846\.25 \+ restated ledgers 270\.00 \+ the row 0\.00\. Without the row the expected totals would be 586737\.50 and 587116\.25, which do not balance/);
  // The realised difference is an ordinary ledger and is compared (it matches).
  const forex = result.lines.find(line => line.label === 'Closing balance of Forex Gain and Loss')!;
  assert.deepEqual([forex.expected, forex.actual, forex.ok], ['354.00 Dr', '354.00 Dr', true]);
  assert.ok(!result.notComparable.some(line => line.startsWith('outstanding (')), 'the pending bills are compared');
  assert.ok(result.notComparable.some(line => line.startsWith('exchangeDifferences (')));
  assert.ok(!result.notComparable.some(line => line.startsWith('costCentres (')), 'the cost centre figures are compared');
});

test('bills: every pending bill and due date of the parties ten98-books can hold matches; the rest is named, not hidden', async () => {
  const harbour = (await compareDataset(owner.userId, await loadDataset(join(demoRoot, 'harbourview')))).lines.filter(line => line.block.startsWith('Bills as at'));
  assert.equal(harbour.filter(line => line.ok).length, 28, 'pending amounts and due dates of the five base-currency parties, at the end of the year and at both checkpoints');
  assert.ok(harbour.filter(line => !line.ok).every(line => line.reason && /Debtor F Overseas|Creditor G Overseas/.test(line.label) && /base currency only/.test(line.reason)), 'only the two foreign-currency parties are not compared');
  assert.equal(harbour.filter(line => !line.ok).length, 5);

  const sunrise = (await compareDataset(owner.userId, await loadDataset(join(demoRoot, 'sunrise')))).lines.filter(line => line.block.startsWith('Bills as at'));
  assert.deepEqual([sunrise.length, sunrise.filter(line => line.ok).length], [14, 14], 'seven parties, pending amounts and due dates');

  for (const slug of ['gulfline', 'najd']) {
    const lines = (await compareDataset(owner.userId, await loadDataset(join(demoRoot, slug)))).lines.filter(line => line.block.startsWith('Bills '));
    // Each list holds the bills lying on its side (observed): the three customer advances (receipt-100 to receipt-102) are
    // payables, so the five expected payable bills match.
    assert.deepEqual(lines.map(line => [line.label, line.ok]), [['Pending receivable bills (count)', true], ['Pending receivable bills (total)', true],
      ['Pending payable bills (count)', true], ['Pending payable bills (total)', true]]);
    assert.deepEqual(lines.filter(line => line.label.startsWith('Pending payable')).map(line => line.actual), slug === 'gulfline' ? ['5', '82415.06'] : ['5', '89406.97']);
  }
});

test('cost centres: every centre total of the year and of both checkpoints matches expected.json, seeded from the dataset itself', async () => {
  const harbour = (await compareDataset(owner.userId, await loadDataset(join(demoRoot, 'harbourview')))).lines.filter(line => line.block.startsWith('Cost centres '));
  assert.deepEqual([...new Set(harbour.map(line => line.block))], ['Cost centres 2026-01-01 to 2026-12-31', 'Cost centres 2026-01-01 to 2026-02-28', 'Cost centres 2026-01-01 to 2026-03-31']);
  assert.deepEqual([harbour.length, harbour.filter(line => line.ok).length], [15, 15], 'five centres, three ranges');
  const sunrise = (await compareDataset(owner.userId, await loadDataset(join(demoRoot, 'sunrise')))).lines.filter(line => line.block.startsWith('Cost centres '));
  assert.deepEqual([sunrise.length, sunrise.filter(line => line.ok).length], [6, 6], 'six job centres');
  assert.deepEqual(sunrise.find(line => line.label === 'Cost centre JOB-101')!.expected, 'Dr 28400.00 / Cr 6200.00');
});

test('opening stock: sunrise and gulfline hold it in every statement, their openings agree with it, and profit stays the ledgers\' alone', async () => {
  const cases = [
    // sunrise: the profit and loss excluding stock of expected.json; the balance sheet without its loss line is expected.json's
    // 233,357.70 less the 53,382.95 stock change that valuation adds (the reference deducts a loss on the liabilities side,
    // ten98-books shows it with the assets, so both of its totals carry the 341,322.50 loss as well).
    { slug: 'sunrise', stock: 3727000n, gross: -9268150n, net: -34132250n, balanceSheet: 17997475n, stockItems: 8 },
    { slug: 'gulfline', stock: 36944000n, gross: null, net: null, balanceSheet: null, stockItems: 14 },
  ];
  for (const expected of cases) {
    const dataset = await loadDataset(join(demoRoot, expected.slug));
    const { companyId, period } = await compareDataset(owner.userId, dataset);
    await inCompany(owner.userId, companyId, async context => {
      const items = await context.client.query('SELECT count(*)::int AS items FROM stock_item WHERE company_id = $1', [companyId]);
      assert.equal(items.rows[0].items, expected.stockItems, `${expected.slug}: every item seeded`);
      const nextYear = String(Number(period.to.slice(0, 4)) + 1);
      for (const [from, to] of [[period.from, period.to], [`${nextYear}-01-01`, `${nextYear}-12-31`]]) {
        const trial = await trialBalanceReport(context, { from, to });
        const row = trial.nodes.find(node => node.kind === 'stock')!;
        const parent = trial.nodes.find(node => node.key === row.parentKey)!;
        assert.deepEqual([row.name, row.openingDebit, row.closingDebit, parent.systemKey], ['Opening stock', expected.stock, expected.stock, 'current_assets'], `${expected.slug} ${from}`);
        assert.deepEqual(trial.openingDifference, { amount: 0n, side: null }, `${expected.slug} ${from}: no difference`);
        assert.deepEqual([trial.grandTotals.openingDebit, trial.grandTotals.closingDebit], [trial.grandTotals.openingCredit, trial.grandTotals.closingCredit], `${expected.slug} ${from}: balanced`);
        // Without the row the ledger openings alone fall short by exactly the opening stock, on the credit side.
        if (from === period.from) assert.equal(trial.grandTotals.openingCredit - (trial.grandTotals.openingDebit - expected.stock), expected.stock);
      }
      const profit = await profitAndLossReport(context, { from: period.from, to: period.to });
      assert.deepEqual(profit.stock, { opening: expected.stock, closing: expected.stock }, expected.slug);
      if (expected.gross !== null) assert.deepEqual([profit.grossProfit, profit.netProfit], [expected.gross, expected.net]);
      const sheet = await balanceSheetReport(context, { date: period.to });
      assert.equal(sheet.closingStock, expected.stock);
      assert.equal(sheet.totals.liabilities, sheet.totals.assets, `${expected.slug}: the balance sheet balances`);
      const retained = sheet.profitAndLoss.broughtForward + sheet.profitAndLoss.currentPeriod;
      if (expected.balanceSheet !== null) assert.equal(sheet.totals.assets + (retained < 0n ? retained : 0n), expected.balanceSheet);
    });
  }
});
