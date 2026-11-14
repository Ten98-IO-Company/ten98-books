import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { compareDataset, formatCompareResult } from '../src/server/demo/compare.ts';
import { demoRoot, loadDataset } from '../src/server/demo/dataset.ts';
import { seedDataset } from '../src/server/demo/seed.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { setupOwner, type Member } from './helpers/ledger.ts';

/**
 * The four large companies (gulfline and najd: 319 vouchers each with orders, stock journals, cancelled entries and
 * opening stock; harbourview: bills, cost centres, foreign currencies; sunrise: item invoices, bills of materials,
 * manufacturing stock journals) seeded as books_app and compared with their expected.json.
 *
 * Every remaining difference is asserted by name, not hidden, so a change in the data or the tools fails here on purpose.
 * Journals may use cash and bank ledgers and numbers restart each financial year, so no comparable line differs; the
 * numbers that differ are all shifted by vouchers cancelled without lines, which ten98-books cannot post yet.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('demo_large');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

type Expectation = {
  slug: string; created: number; unsupported: Record<string, number>; noEntries: Record<string, number>;
  numbers: { checked: number; matched: number }; counts: [matches: number, differences: number, pending: number]; differs: string[];
  /** Bill rows: opening bills set, rows posted, rows left out (foreign-currency lines) and the ledger module's warnings by code. */
  bills: { opening: number; posted: number; foreign: number; warnings: Record<string, number> };
};
/** The reference lists the three customer advances (credit-side bills on receivable ledgers) among its payable bills; ten98-books lists the bills of the payable ledgers. */
const payableByLedgers = ['Pending payable bills (count)', 'Pending payable bills (total)'];
const tradingUnsupported = { sales_order: 3, delivery_note: 3, purchase_order: 2, receipt_note: 1, stock_journal: 4, memorandum: 2, reversing_journal: 1 };
const expectations: Expectation[] = [
  { slug: 'gulfline', created: 301, unsupported: tradingUnsupported, noEntries: { journal: 2 }, numbers: { checked: 300, matched: 298 }, counts: [62, 2, 1], differs: payableByLedgers,
    bills: { opening: 3, posted: 244, foreign: 0, warnings: {} } },
  { slug: 'najd', created: 301, unsupported: tradingUnsupported, noEntries: { journal: 2 }, numbers: { checked: 300, matched: 298 }, counts: [62, 2, 1], differs: payableByLedgers,
    bills: { opening: 3, posted: 244, foreign: 0, warnings: {} } },
  // 93 harbourview numbers are shifted by four sales, receipt and payment vouchers cancelled without lines.
  { slug: 'harbourview', created: 188, unsupported: { memorandum: 2, reversing_journal: 1 }, noEntries: { receipt: 2, sales: 1, payment: 1 }, numbers: { checked: 185, matched: 92 }, counts: [66, 0, 13], differs: [],
    bills: { opening: 2, posted: 121, foreign: 17, warnings: {} } },
  { slug: 'sunrise', created: 214, unsupported: { stock_journal: 36, sales_order: 2, delivery_note: 2, memorandum: 2, purchase_order: 1, receipt_note: 1, reversing_journal: 1 }, noEntries: { journal: 1, receipt: 1 },
    numbers: { checked: 212, matched: 198 }, counts: [58, 0, 1], differs: [],
    // payment-048 settles SI-STE-11 in full after debit-note-001 already took 88.20 of it: the ledger module accepts that and says so.
    bills: { opening: 1, posted: 145, foreign: 0, warnings: { bill_over_settled: 1 } } },
];

for (const expectation of expectations) {
  test(`${expectation.slug}: seeds its postable vouchers, reports every skip, runs again without change, and compares apart from the named differences`, async t => {
    const dataset = await loadDataset(join(demoRoot, expectation.slug));
    let started = Date.now();
    const first = await seedDataset(owner.userId, dataset);
    t.diagnostic(`first seed of ${dataset.vouchers.length} vouchers: ${Date.now() - started} ms`);
    assert.equal(first.companyCreated, true);
    assert.deepEqual(first.vouchers, { created: expectation.created, present: 0, cancelled: 0 });
    assert.deepEqual(first.unsupportedTypes, expectation.unsupported);
    assert.deepEqual(first.noEntries, expectation.noEntries);
    assert.deepEqual(first.refused, [], 'a journal may use cash and bank ledgers, so nothing is refused');
    assert.deepEqual(first.numbers, { ...expectation.numbers, unnumbered: 0, kind: 'confirmed against the reference' });
    assert.ok(first.skipped.some(line => line.includes('not yet supported') || line.includes('not modelled')));
    assert.equal(first.bills.openingBills, expectation.bills.opening);
    assert.equal(first.bills.rowsPosted, expectation.bills.posted);
    assert.deepEqual(Object.fromEntries(Object.entries(first.bills.warnings).map(([code, which]) => [code, which.length])), expectation.bills.warnings);
    assert.equal(first.bills.skipped.length, expectation.bills.foreign ? 1 : 0);
    if (expectation.bills.foreign) assert.match(first.bills.skipped[0], new RegExp(`^${expectation.bills.foreign} bill rows on foreign-currency lines`));

    started = Date.now();
    const again = await seedDataset(owner.userId, dataset);
    t.diagnostic(`second seed (nothing to do): ${Date.now() - started} ms`);
    assert.deepEqual([again.companyCreated, again.vouchers, again.groups.created, again.ledgers.created], [false, { created: 0, present: expectation.created, cancelled: 0 }, 0, 0]);
    assert.deepEqual([again.bills.openingBills, again.bills.rowsPosted, again.bills.warnings], [0, 0, {}], 'a second run posts no bill rows and raises no warning');
    assert.deepEqual(again.numberDifferences, first.numberDifferences);
    assert.ok(first.numberDifferences.every(line => line.includes('which accounts for the whole difference')), 'every differing number is shifted by vouchers cancelled without lines');

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
    assert.equal(result.lines.filter(line => line.reason).length, 1, 'only the shifted numbers are not yet comparable');
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
  for (const block of ['costCentres', 'exchangeDifferences']) assert.ok(result.notComparable.some(line => line.startsWith(`${block} (`)), block);
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
    assert.deepEqual(lines.filter(line => line.ok).map(line => line.label), ['Pending receivable bills (count)', 'Pending receivable bills (total)']);
    const payable = lines.filter(line => !line.ok);
    assert.deepEqual(payable.map(line => [line.label, line.expected, line.actual]), slug === 'gulfline'
      ? [['Pending payable bills (count)', '5', '2'], ['Pending payable bills (total)', '82415.06', '73415.06']]
      : [['Pending payable bills (count)', '5', '2'], ['Pending payable bills (total)', '89406.97', '80406.97']]);
    // The three customer advances (receipt-100 to receipt-102) account for the whole difference; it stays a difference, with that cause.
    for (const line of payable) assert.match(line.note!, /exactly 3 pending payable bill\(s\) lying on ledgers below receivables \(9000\.00\): .*ADV-PDC-1.*receipt-100/);
  }
});
