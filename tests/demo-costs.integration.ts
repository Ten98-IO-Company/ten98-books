import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { compareDataset, formatCompareResult } from '../src/server/demo/compare.ts';
import { parseDataset, type Dataset } from '../src/server/demo/dataset.ts';
import { formatSeedReport, seedDataset } from '../src/server/demo/seed.ts';
import { listCostCategories, listCostCentres, alterCostCentre } from '../src/server/ledger/cost-centres.ts';
import { alterLedger, listLedgers } from '../src/server/ledger/masters.ts';
import { listVouchers } from '../src/server/ledger/vouchers.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { inCompany, invite, setupOwner, type Member } from './helpers/ledger.ts';

/**
 * The seeder posts a dataset's cost keys through the ledger module (the company switch, categories, centres with their
 * tree, ledger settings, each line's rows) and its vouchers cancelled without lines as voids that take their numbers;
 * rows on a line the ledger cannot carry are counted and named; the comparison reads the centre totals back. Master names
 * are matched under the name match key, so a master the user spelled differently is found again.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('demo_costs');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

const line = (ledger: string, side: 'Dr' | 'Cr', amount: string, extras?: Record<string, unknown>) => ({ ledger, side, amount, ...extras ? { extras } : {} });
type Centres = Record<string, { debit: string; credit: string }>;

/**
 * A small books year: a void that takes receipt number 1, a receipt with rows in two categories, a payment on a sub-centre,
 * a payment on a ledger that takes no cost centres (its row cannot be carried), and a sales voucher with bill rows and cost rows.
 */
const costsDataset = (centres?: Centres): Dataset => parseDataset({
  company: { slug: 'costs-check', name: 'Costs Check', country: 'AE', baseCurrency: 'AED', minorUnits: 2, financialYearStart: { month: 1, day: 1 }, booksBeginning: '2026-01-01', timeZone: 'Asia/Dubai', features: ['accounting', 'billWise', 'costCentres'] },
  ledgers: [
    { key: 'cash', name: 'Cash', group: 'cash_in_hand', standard: 'cash', opening: { amount: '1000.00', side: 'Dr' } },
    { key: 'capital', name: 'Capital', group: 'capital', opening: { amount: '1000.00', side: 'Cr' } },
    { key: 'debtor', name: 'Debtor', group: 'receivables' },
    { key: 'sales', name: 'Sales', group: 'sales', extras: { costCentres: true } },
    { key: 'rent', name: 'Rent', group: 'indirect_expenses', extras: { costCentres: true } },
    { key: 'stationery', name: 'Stationery', group: 'indirect_expenses', extras: { costCentres: false } },
  ],
  vouchers: [
    { key: 'receipt-void', type: 'receipt', date: '2026-02-01', status: 'cancelled', postDated: false, expectedNumber: 1, lines: [], extras: { noAccountingEffect: true } },
    { key: 'receipt-1', type: 'receipt', date: '2026-02-02', status: 'regular', postDated: false, expectedNumber: 2, lines: [
      line('cash', 'Dr', '500.00'), line('sales', 'Cr', '500.00', { costCentres: [{ centre: 'north', amount: '300.00' }, { centre: 'south', amount: '200.00' }, { centre: 'job-1', amount: '500.00' }] })] },
    { key: 'payment-1', type: 'payment', date: '2026-02-05', status: 'regular', postDated: false, expectedNumber: 1, lines: [
      line('rent', 'Dr', '100.00', { costCentres: [{ centre: 'job-1a', amount: '100.00' }] }), line('cash', 'Cr', '100.00')] },
    { key: 'payment-2', type: 'payment', date: '2026-02-06', status: 'regular', postDated: false, expectedNumber: 2, lines: [
      line('stationery', 'Dr', '40.00', { costCentres: [{ centre: 'job-1', amount: '40.00' }] }), line('cash', 'Cr', '40.00')] },
    { key: 'sales-1', type: 'sales', date: '2026-02-10', status: 'regular', postDated: false, expectedNumber: 1, lines: [
      line('debtor', 'Dr', '200.00', { bills: [{ kind: 'new', name: 'INV-1', creditDays: 30, amount: '200.00' }] }),
      line('sales', 'Cr', '200.00', { costCentres: [{ centre: 'north', amount: '120.00' }, { centre: 'south', amount: '80.00' }] })] },
  ],
  expected: {
    period: { from: '2026-01-01', to: '2026-12-31' }, voucherCount: 5, vouchersByType: { receipt: 2, payment: 2, sales: 1 },
    // The 40.00 row of payment-2 sits on a ledger that takes no centres, so Job-1 holds the sub-centre's 100.00 only.
    costCentres: { from: '2026-01-01', to: '2026-12-31', centres: centres ?? {
      north: { debit: '0.00', credit: '420.00' }, south: { debit: '0.00', credit: '280.00' }, 'job-1': { debit: '100.00', credit: '500.00' }, 'job-1a': { debit: '100.00', credit: '0.00' } } },
  },
  extraFiles: {
    'costCategories.json': [{ key: 'channel', name: 'Channel', allocateRevenue: true }, { key: 'jobs', name: 'Jobs', allocateRevenue: true, allocateNonRevenue: true }],
    'costCentres.json': [{ key: 'north', name: 'North', category: 'channel' }, { key: 'south', name: 'South', category: 'channel' }, { key: 'job-1', name: 'Job-1', category: 'jobs' },
      { key: 'job-1a', name: 'Job 1A', category: 'jobs', parent: 'job-1' }],
  },
}, 'demo/costs-check');

const voucherCount = (userId: string, companyId: string) => inCompany(userId, companyId, async context =>
  (await listVouchers(context, { from: '2000-01-01', to: '2100-01-01', limit: 500 })).vouchers.length);

test('cost rows are posted, a void takes its number, the rows a ledger cannot carry are counted, and the centre totals compare', async () => {
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  const report = await seedDataset(user.userId, costsDataset());
  assert.deepEqual([report.vouchers.created, report.voided], [5, 1], 'the void is posted with the others');
  assert.deepEqual([report.costs.switchedOn, report.costs.categories, report.costs.centres], [true, { created: 2, present: 0 }, { created: 4, present: 0 }]);
  // receipt-1 (3 rows), payment-1 (1) and sales-1 (2) are carried; the one row of payment-2 is not.
  assert.deepEqual([report.costs.rowsPosted, report.costs.leftOutRows, report.costs.leftOut], [6, 1, ['payment-2 line 1 (Stationery)']]);
  assert.deepEqual(report.costs.warnings, { cost_ignored: ['payment-2 line 1'] });
  assert.deepEqual([report.bills.rowsPosted, report.bills.warnings], [1, {}]);
  assert.deepEqual([report.numbers.checked, report.numbers.matched, report.numberDifferences], [5, 5, []], 'the void holds receipt number 1, so receipt-1 is number 2');
  const printed = formatSeedReport(report).join('\n');
  assert.match(printed, /vouchers: 5 created, 0 already present; 1 cancelled without lines \(voids\)/);
  assert.match(printed, /cost centres: switched on; categories 2 created, 0 already present; centres 4 created, 0 already present/);
  assert.match(printed, /cost rows: 6 posted with the vouchers/);
  assert.match(printed, /cost rows left out: 1 on 1 line\(s\) whose ledger takes no cost centres .*; e\.g\. payment-2 line 1 \(Stationery\)/);
  assert.match(printed, /cost warnings raised by the postings:\n\s+cost_ignored: 1 \(e\.g\. payment-2 line 1\)/);

  await inCompany(user.userId, report.companyId, async context => {
    const stationery = (await listLedgers(context)).find(ledger => ledger.name === 'Stationery')!;
    assert.equal(stationery.costCentres, false, 'the dataset\'s ledger setting is applied');
    assert.deepEqual((await listCostCentres(context)).map(centre => [centre.name, centre.parentId !== null]).sort(), [['Job 1A', true], ['Job-1', false], ['North', false], ['South', false]]);
  });

  const result = await compareDataset(user.userId, costsDataset());
  const text = formatCompareResult(result).join('\n');
  assert.equal(result.differences, 0, text);
  assert.ok(!result.lines.some(item => item.label.includes('shifted')), 'no number is shifted by a voucher cancelled without lines');
  const byLabel = Object.fromEntries(result.lines.filter(item => item.block.startsWith('Cost centres ')).map(item => [item.label, item]));
  assert.deepEqual([byLabel['Cost centre North'].expected, byLabel['Cost centre North'].actual, byLabel['Cost centre North'].ok], ['Dr 0.00 / Cr 420.00', 'Dr 0.00 / Cr 420.00', true]);
  assert.deepEqual([byLabel['Cost centre Job-1'].actual, byLabel['Cost centre Job-1'].ok], ['Dr 100.00 / Cr 500.00', true], 'a sub-centre is rolled into its top-most centre');
  assert.match(byLabel['Cost centre Job 1A'].reason!, /rolls a sub-centre into its top-most centre/);
  assert.equal(result.lines.find(item => item.label === 'Voucher count (types ten98-books has)')!.ok, true, 'the void is counted');
  assert.deepEqual((await companyVoucherNumbers(user.userId, report.companyId)).filter(item => item.startsWith('receipt')), ['receipt 1 cancelled', 'receipt 2 regular']);

  const again = await seedDataset(user.userId, costsDataset());
  assert.deepEqual([again.companyCreated, again.vouchers, again.voided, again.costs.switchedOn, again.costs.categories, again.costs.centres, again.costs.rowsPosted, again.costs.warnings],
    [false, { created: 0, present: 5, cancelled: 0 }, 0, false, { created: 0, present: 2 }, { created: 0, present: 4 }, 0, {}], 'a rerun changes nothing');
  assert.equal(formatSeedReport(again)[0], 'Costs Check (costs-check): already present, nothing changed');
});

async function companyVoucherNumbers(userId: string, companyId: string): Promise<string[]> {
  return inCompany(userId, companyId, async context => (await listVouchers(context, { from: '2000-01-01', to: '2100-01-01', limit: 500 })).vouchers.map(voucher => `${voucher.kind} ${voucher.number} ${voucher.status}`));
}

test('a cost figure that differs stays a difference, naming the vouchers whose rows the books cannot show', async () => {
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  // Job-1 expected with the 40.00 row of payment-2 counted, and North 10.00 higher.
  const wrong: Centres = { north: { debit: '0.00', credit: '430.00' }, south: { debit: '0.00', credit: '280.00' }, 'job-1': { debit: '140.00', credit: '500.00' } };
  await seedDataset(user.userId, costsDataset(wrong));
  const result = await compareDataset(user.userId, costsDataset(wrong));
  const differs = result.lines.filter(item => !item.ok && !item.reason);
  assert.deepEqual(differs.map(item => [item.label, item.difference]), [['Cost centre North', 'Dr 0.00 / Cr -10.00'], ['Cost centre Job-1', 'Dr -40.00 / Cr 0.00']]);
  assert.equal(differs[0].note, undefined, 'nothing in the dataset explains North');
  assert.match(differs[1].note!, /rows of this centre on 1 voucher\(s\) are not in the books' figures .*: payment-2/);
});

test('masters only seeds the cost masters and ledger settings; a master the user spelled differently is found under the name match key, and the full seed uses it', async () => {
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  const masters = await seedDataset(user.userId, costsDataset(), true);
  assert.deepEqual([masters.costs.switchedOn, masters.costs.categories.created, masters.costs.centres.created, masters.costs.rowsPosted, masters.vouchers.created], [true, 2, 4, 0, 0]);
  assert.equal(await voucherCount(user.userId, masters.companyId), 0);
  const unchanged = await seedDataset(user.userId, costsDataset(), true);
  assert.deepEqual([unchanged.costs.switchedOn, unchanged.costs.categories.created, unchanged.costs.centres.created], [false, 0, 0]);

  // The user respells a ledger, a centre and a category; each is still the same name under the key.
  await inCompany(user.userId, masters.companyId, async context => {
    const rent = (await listLedgers(context)).find(ledger => ledger.name === 'Rent')!;
    await alterLedger(context, rent.id, { name: 'R e-n t', secondLanguageName: rent.secondLanguageName, groupId: rent.groupId, opening: { amount: '0.00', side: 'Dr' }, revision: rent.revision });
    const north = (await listCostCentres(context)).find(centre => centre.name === 'North')!;
    await alterCostCentre(context, north.id, { name: 'No rth', categoryId: north.categoryId, parentId: null, revision: north.revision });
    assert.ok((await listCostCategories(context)).some(category => category.name === 'Channel'));
  }, 'write');
  const full = await seedDataset(user.userId, costsDataset());
  assert.deepEqual([full.companyId, full.ledgers.created, full.ledgers.present, full.costs.categories.created, full.costs.centres.created, full.costs.centres.present], [masters.companyId, 0, 6, 0, 0, 4], 'the respelled masters are found, not created again');
  assert.deepEqual([full.vouchers.created, full.costs.rowsPosted], [5, 6]);
  const result = await compareDataset(user.userId, costsDataset());
  assert.equal(result.differences, 0, formatCompareResult(result).join('\n'));
  assert.ok(result.lines.some(item => item.label === 'Cost centre No rth' || item.label === 'Cost centre North'));
});

test('a company seeded before cost rows were sent keeps its vouchers as posted, says so, and a changed voucher still stops the seed', async () => {
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  const full = costsDataset();
  // What an earlier seeder posted: no cost masters, no voids, and the vouchers without their cost rows (bill rows were sent).
  const before = structuredClone(full);
  before.extraFiles = {};
  before.vouchers = before.vouchers.filter(voucher => voucher.key !== 'receipt-void');
  for (const voucher of before.vouchers) for (const row of voucher.lines) if (row.extras) delete (row.extras as { costCentres?: unknown }).costCentres;
  for (const entry of before.ledgers) delete (entry.extras as { costCentres?: unknown } | undefined)?.costCentres;
  const first = await seedDataset(user.userId, before);
  assert.deepEqual([first.vouchers.created, first.costs.rowsPosted, first.costs.masters], [4, 0, false]);

  const again = await seedDataset(user.userId, full);
  assert.deepEqual([again.companyId, again.costs.switchedOn, again.costs.categories.created, again.costs.centres.created], [first.companyId, true, 2, 4], 'the cost masters are added to the company');
  assert.deepEqual(again.costs.keptWithoutCostRows, ['receipt-1', 'payment-1', 'payment-2', 'sales-1'], 'the four vouchers with cost rows keep their earlier shape');
  assert.deepEqual(again.bills.keptWithoutBills, [], 'sales-1 keeps its bill rows: only its cost rows were missing');
  assert.deepEqual([again.vouchers.present, again.vouchers.created, again.voided, again.costs.rowsPosted, again.costs.leftOutRows], [4, 1, 1, 0, 0], 'the void is new');
  assert.match(formatSeedReport(again).join('\n'), /vouchers already posted before cost rows were sent, kept as they were without cost rows: 4 \(e\.g\. receipt-1, payment-1, payment-2\); seed into a new company to get their cost figures/);
  // The void is posted after the vouchers already there, so it takes the next number and the dataset's number 1 is not its.
  assert.deepEqual((await companyVoucherNumbers(user.userId, first.companyId)).filter(item => item.startsWith('receipt')), ['receipt 2 cancelled', 'receipt 1 regular'], 'listed by date: the void dated first holds number 2');
  assert.ok(again.numberDifferences.length > 0, 'the numbers that the void now shifts are reported, not forced');

  const changed = structuredClone(full);
  (changed.vouchers[2].lines[0] as { amount: string }).amount = '101.00';
  (changed.vouchers[2].lines[1] as { amount: string }).amount = '101.00';
  await assert.rejects(() => seedDataset(user.userId, changed), /already used for a different voucher/);
});
