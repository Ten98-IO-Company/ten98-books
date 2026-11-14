import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { compareDataset, formatCompareResult } from '../src/server/demo/compare.ts';
import { parseDataset, type Dataset } from '../src/server/demo/dataset.ts';
import { formatSeedReport, seedDataset } from '../src/server/demo/seed.ts';
import { listLedgers, listVoucherTypes } from '../src/server/ledger/masters.ts';
import { createVoucher, listVouchers } from '../src/server/ledger/vouchers.ts';
import { partyBillsReport } from '../src/server/reports/bills.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { inCompany, invite, setupOwner, type Member } from './helpers/ledger.ts';

/**
 * The seeder posts a dataset's bill keys through the ledger module (opening bills and bill-wise settings with the ledgers,
 * bill rows with the vouchers), leaves out what ten98-books cannot hold (foreign-currency lines, settlements of bills that
 * nothing posted creates), seeds masters only on request, and the comparison reads the pending bills back per party.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('demo_bills');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

const line = (ledger: string, side: 'Dr' | 'Cr', amount: string, extras?: Record<string, unknown>) => ({ ledger, side, amount, ...extras ? { extras } : {} });
const usd = { currency: 'USD', currencyAmount: '100.00', rate: '3.67' };

/**
 * A small books year with every kind of bill row: opening bills in the dataset's second spelling (`opening.bills`, kind new),
 * an invoice, a part settlement, a settlement of an opening bill with an on-account row, an advance, a second invoice that
 * joins the first one's name, a foreign-currency invoice and its settlement, a settlement of a bill nothing creates, and a
 * supplier bill in the first spelling (`type`, `ref`).
 */
const billsDataset = (expectedDebtor: Record<string, { pending: string; side: 'Dr' | 'Cr'; dueDate: string }>): Dataset => parseDataset({
  company: { slug: 'bills-check', name: 'Bills Check', country: 'AE', baseCurrency: 'AED', minorUnits: 2, financialYearStart: { month: 1, day: 1 }, booksBeginning: '2026-01-01', timeZone: 'Asia/Dubai', features: ['accounting', 'billWise'] },
  ledgers: [
    { key: 'cash', name: 'Cash', group: 'cash_in_hand', standard: 'cash' },
    { key: 'debtor', name: 'Debtor', group: 'receivables', opening: { amount: '5000.00', side: 'Dr' },
      extras: { billWise: true, creditDays: 30, opening: { bills: [
        { kind: 'new', name: 'OB-1', billDate: '2025-12-16', creditDays: 30, amount: '3000.00', side: 'Dr' }, { kind: 'new', name: 'OB-2', billDate: '2025-12-20', creditDays: 30, amount: '1500.00', side: 'Dr' }] } } },
    { key: 'debtor-usd', name: 'Debtor USD', group: 'receivables', extras: { billWise: true, creditDays: 30 } },
    { key: 'creditor', name: 'Creditor', group: 'payables', extras: { creditPeriodDays: 30, billWise: true, openingBills: [] } },
    { key: 'sales', name: 'Sales', group: 'sales' }, { key: 'purchases', name: 'Purchases', group: 'purchases' },
  ],
  vouchers: [
    { key: 'sales-1', type: 'sales', date: '2026-02-01', status: 'regular', postDated: false, lines: [
      line('debtor', 'Dr', '1050.00', { bills: [{ kind: 'new', name: 'INV-1', creditDays: 45, amount: '1050.00' }] }), line('sales', 'Cr', '1050.00')] },
    { key: 'receipt-1', type: 'receipt', date: '2026-02-10', status: 'regular', postDated: false, lines: [
      line('cash', 'Dr', '400.00'), line('debtor', 'Cr', '400.00', { bills: [{ kind: 'against', name: 'INV-1', amount: '400.00' }] })] },
    { key: 'receipt-2', type: 'receipt', date: '2026-02-15', status: 'regular', postDated: false, lines: [
      line('cash', 'Dr', '600.00'), line('debtor', 'Cr', '600.00', { bills: [{ kind: 'against', name: 'OB-1', amount: '500.00' }, { kind: 'on_account', amount: '100.00' }] })] },
    { key: 'receipt-3', type: 'receipt', date: '2026-02-20', status: 'regular', postDated: false, lines: [
      line('cash', 'Dr', '3000.00'), line('debtor', 'Cr', '3000.00', { bills: [{ kind: 'advance', name: 'ADV-1', amount: '3000.00' }] })] },
    { key: 'sales-2', type: 'sales', date: '2026-03-01', status: 'regular', postDated: false, lines: [
      line('debtor', 'Dr', '500.00', { bills: [{ kind: 'new', name: 'INV-1', creditDays: 30, amount: '500.00' }] }), line('sales', 'Cr', '500.00')] },
    { key: 'sales-3', type: 'sales', date: '2026-03-05', status: 'regular', postDated: false, lines: [
      line('debtor-usd', 'Dr', '367.00', { ...usd, bills: [{ kind: 'new', name: 'USD-1', creditDays: 30, amount: '100.00' }] }), line('sales', 'Cr', '367.00', usd)] },
    { key: 'receipt-4', type: 'receipt', date: '2026-03-10', status: 'regular', postDated: false, lines: [
      line('cash', 'Dr', '367.00'), line('debtor-usd', 'Cr', '367.00', { ...usd, bills: [{ kind: 'against', name: 'USD-1', amount: '100.00' }] })] },
    { key: 'receipt-5', type: 'receipt', date: '2026-03-12', status: 'regular', postDated: false, lines: [
      line('cash', 'Dr', '10.00'), line('debtor', 'Cr', '10.00', { bills: [{ kind: 'against', name: 'GHOST-1', amount: '10.00' }] })] },
    { key: 'purchase-1', type: 'purchase', date: '2026-03-15', status: 'regular', postDated: false, lines: [
      line('purchases', 'Dr', '200.00'), line('creditor', 'Cr', '200.00', { bills: [{ type: 'new', ref: 'SI-9', amount: '200.00', creditDays: 15 }] })] },
  ],
  expected: {
    period: { from: '2026-01-01', to: '2026-12-31' },
    outstanding: { asOf: '2026-12-31', ledgers: {
      debtor: { bills: { bills: expectedDebtor } },
      creditor: { bills: { bills: { 'SI-9': { pending: '200.00', side: 'Cr', dueDate: '30-Mar-26' } } } },
      'debtor-usd': { bills: { bills: { 'USD-1': { pending: '367.00', side: 'Dr', dueDate: '4-Apr-26' } } } },
    } },
  },
}, 'demo/bills-check');

/** What the ledger module should end with, worked out by hand from the rows above (not read back from the books). */
const pendingDebtor = {
  'OB-1': { pending: '2500.00', side: 'Dr' as const, dueDate: '15-Jan-26' }, 'OB-2': { pending: '1500.00', side: 'Dr' as const, dueDate: '19-Jan-26' },
  'INV-1': { pending: '1150.00', side: 'Dr' as const, dueDate: '18-Mar-26' }, 'ADV-1': { pending: '3000.00', side: 'Cr' as const, dueDate: '22-Mar-26' },
  'GHOST-1': { pending: '10.00', side: 'Cr' as const, dueDate: '12-Mar-26' },
};

test('bill keys are posted with their kinds, credit days and opening bills; the foreign-currency rows and an unknown settlement are left out and counted', async () => {
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  const dataset = billsDataset(pendingDebtor);
  const report = await seedDataset(user.userId, dataset);
  assert.equal(report.bills.openingBills, 2, 'the two opening bills of Debtor');
  // 10 bill rows in the dataset; the foreign invoice and its settlement (2) and the settlement of GHOST-1 (1) are left out; the on-account row is posted.
  assert.equal(report.bills.rowsPosted, 7);
  assert.deepEqual(report.bills.skipped.map(text => text.replace(/;.*/, '')), [
    '2 bill rows on foreign-currency lines (bills are base currency only until currencies are built)',
    '1 against rows settling a bill that no posted row creates (it belongs to a foreign-currency line, or to a voucher the dataset carries without lines)',
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(report.bills.warnings)), { bill_attached: ['sales-2 line 1 bill "INV-1"'] }, 'the second INV-1 joins the first one, and the ledger module says so');
  const text = formatSeedReport(report).join('\n');
  assert.match(text, /opening bills: 2 set with the ledgers created/);
  assert.match(text, /bill rows: 7 posted with the vouchers/);
  assert.match(text, /bill warnings raised by the postings:\n\s+bill_attached: 1 \(e\.g\. sales-2 line 1 bill "INV-1"\)/);

  await inCompany(user.userId, report.companyId, async context => {
    const ledgers = await listLedgers(context);
    const debtor = ledgers.find(ledger => ledger.name === 'Debtor')!;
    assert.equal(debtor.billWise, true);
    assert.deepEqual(debtor.creditPeriod, { count: 30, unit: 'day' });
    assert.deepEqual(debtor.openingBills.map(bill => [bill.billName, bill.amount, bill.billDate, bill.creditPeriod]), [
      ['OB-1', 300000n, '2025-12-16', { count: 30, unit: 'day' }], ['OB-2', 150000n, '2025-12-20', { count: 30, unit: 'day' }]]);
    const bills = await partyBillsReport(context, debtor.id, { asOf: '2026-12-31' });
    // Worked out by hand: OB-1 3000 less 500; OB-2 1500; INV-1 1050 + 500 less 400 (due 45 days after the first invoice); ADV-1 3000 credit.
    assert.deepEqual(bills.bills.map(bill => [bill.name, bill.pending, bill.dueDate]).sort(), [
      ['ADV-1', -300000n, '2026-03-22'], ['INV-1', 115000n, '2026-03-18'], ['OB-1', 250000n, '2026-01-15'], ['OB-2', 150000n, '2026-01-19']]);
    const usdBills = await partyBillsReport(context, ledgers.find(ledger => ledger.name === 'Debtor USD')!.id, { asOf: '2026-12-31' });
    assert.deepEqual(usdBills.bills, [], 'the foreign-currency invoice carries no bill: its row was left out');
    const creditor = await partyBillsReport(context, ledgers.find(ledger => ledger.name === 'Creditor')!.id, { asOf: '2026-12-31' });
    assert.deepEqual(creditor.bills.map(bill => [bill.name, bill.pending, bill.dueDate]), [['SI-9', -20000n, '2026-03-30']]);
  });

  // A second run replays every voucher: nothing is posted and nothing is warned about.
  const again = await seedDataset(user.userId, dataset);
  assert.deepEqual([again.bills.openingBills, again.bills.rowsPosted, again.bills.warnings], [0, 0, {}]);
});

test('the pending bills are compared per party and date; foreign-currency parties and a bill nothing creates are not yet comparable, with their reasons', async () => {
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  await seedDataset(user.userId, billsDataset(pendingDebtor));
  const result = await compareDataset(user.userId, billsDataset(pendingDebtor));
  const bills = result.lines.filter(item => item.block === 'Bills as at 2026-12-31');
  const by = (label: string) => bills.find(item => item.label === label)!;
  assert.deepEqual([by('Pending bills of Debtor').ok, by('Pending bills of Creditor').ok, by('Due dates of Debtor').ok, by('Due dates of Creditor').ok], [true, true, true, true]);
  // GHOST-1: expected as pending, but the dataset's only row for it is a settlement of a bill nothing creates.
  assert.deepEqual([by('Pending bills of Debtor').expected, by('Pending bills of Debtor').actual], ['4 bill(s), 2150.00 Dr', '4 bill(s), 2150.00 Dr']);
  const ghost = bills.find(item => item.label.startsWith('Pending bills not compared (settlement left out) of Debtor'))!;
  assert.deepEqual([ghost.expected, ghost.actual, ghost.ok], ['1 bill(s), 10.00 Cr', 'not compared', false]);
  assert.match(ghost.reason!, /settlement of this bill was left out/);
  const foreign = bills.find(item => item.label.startsWith('Pending bills not compared (foreign currency) of Debtor USD'))!;
  assert.match(foreign.reason!, /base currency only/);
  assert.equal(result.lines.filter(item => !item.ok && !item.reason).length, 0, formatCompareResult(result).join('\n'));
});

test('a pending amount or due date that differs stays a difference, naming the bill', async () => {
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  const wrong = { ...pendingDebtor, 'INV-1': { pending: '1100.00', side: 'Dr' as const, dueDate: '19-Mar-26' } };
  await seedDataset(user.userId, billsDataset(wrong));
  const result = await compareDataset(user.userId, billsDataset(wrong));
  const failing = result.lines.filter(item => !item.ok && !item.reason);
  assert.deepEqual(failing.map(item => item.label), ['Pending bills of Debtor', 'Due dates of Debtor']);
  assert.match(failing[0].note!, /INV-1: expected 1100\.00 Dr, books 1150\.00 Dr/);
  assert.match(failing[1].note!, /INV-1 expected 2026-03-19, books 2026-03-18/);
  // An expected bill the books lack, and one the books hold that expected.json does not list, are both differences.
  const { 'OB-1': _gone, ...fewer } = pendingDebtor;
  const missing = await compareDataset(user.userId, billsDataset(fewer));
  assert.match(missing.lines.find(item => item.label === 'Pending bills of Debtor')!.note!, /OB-1: pending 2500\.00 Dr in the books, not in expected\.json/);
});

test('masters only: the company, groups and ledgers with their bill settings and opening bills, no vouchers, idempotent, and the full seed adds the vouchers to the same company', async () => {
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  const dataset = billsDataset(pendingDebtor);
  const first = await seedDataset(user.userId, dataset, true);
  assert.deepEqual([first.mastersOnly, first.companyCreated, first.vouchers, first.bills.openingBills, first.bills.rowsPosted], [true, true, { created: 0, present: 0, cancelled: 0 }, 2, 0]);
  assert.ok(formatSeedReport(first).includes('  vouchers: not posted (masters only)'));
  await inCompany(user.userId, first.companyId, async context => {
    assert.equal((await listVouchers(context, { from: '2000-01-01', to: '2100-01-01', limit: 500 })).vouchers.length, 0);
    const debtor = (await listLedgers(context)).find(ledger => ledger.name === 'Debtor')!;
    assert.deepEqual([debtor.billWise, debtor.creditPeriod, debtor.openingBills.length], [true, { count: 30, unit: 'day' }, 2]);
  });

  const again = await seedDataset(user.userId, dataset, true);
  assert.deepEqual([again.companyCreated, again.companyId, again.groups.created, again.ledgers.created, again.bills.openingBills], [false, first.companyId, 0, 0, 0]);
  assert.equal(formatSeedReport(again)[0], 'Bills Check (bills-check): already present, nothing changed');

  // A person enters a voucher by hand against the same masters; the full seed still finds the company and adds the rest.
  const handEntered = await inCompany(user.userId, first.companyId, async context => {
    const ledgers = await listLedgers(context);
    const types = await listVoucherTypes(context);
    return (await createVoucher(context, {
      idempotencyKey: 'entered-by-hand', voucherTypeId: types.find(type => type.systemKey === 'receipt')!.id, date: '2026-04-01',
      lines: [{ ledgerId: ledgers.find(ledger => ledger.name === 'Cash')!.id, side: 'Dr', amount: '5.00' }, { ledgerId: ledgers.find(ledger => ledger.name === 'Debtor')!.id, side: 'Cr', amount: '5.00' }],
    })).voucher.id;
  }, 'write');
  const full = await seedDataset(user.userId, dataset);
  assert.deepEqual([full.companyCreated, full.companyId, full.vouchers.created, full.bills.rowsPosted, full.bills.openingBills], [false, first.companyId, 9, 7, 0]);
  await inCompany(user.userId, first.companyId, async context => {
    const vouchers = (await listVouchers(context, { from: '2000-01-01', to: '2100-01-01', limit: 500 })).vouchers;
    assert.equal(vouchers.length, 10, 'the nine seeded vouchers and the one entered by hand');
    assert.ok(vouchers.some(voucher => voucher.id === handEntered));
  });
});
