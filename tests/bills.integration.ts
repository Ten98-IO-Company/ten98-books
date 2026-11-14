import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { handleApi } from '../src/server/api.ts';
import { getConfig } from '../src/server/config.ts';
import { chart, createCompany, invite, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * Bills (M2a slice 1) through the HTTP contract as the application role. Each case reproduces a behaviour observed on
 * the reference workflow (`observed/30`, private notes) with the figures recorded there, or a decision recorded in the
 * slice-1 design; the golden company replays the analyst's scenario and checks the observed lists.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('bills');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

type Row = { kind: string; name?: string; billId?: string; amount: string; side?: 'Dr' | 'Cr'; creditPeriod?: unknown };
type Line = [ledgerId: string, side: 'Dr' | 'Cr', amount: string, bills?: Row[]];
const newRef = (name: string | undefined, amount: string, extra: Partial<Row> = {}): Row => ({ kind: 'new_ref', ...(name ? { name } : {}), amount, ...extra });
const against = (name: string, amount: string, extra: Partial<Row> = {}): Row => ({ kind: 'against_ref', name, amount, ...extra });
const days = (count: number) => ({ creditPeriod: { count, unit: 'day' } });

/** One company's API with the helpers the cases need. */
async function books(name: string, member: Member = owner) {
  const companyId = await createCompany(member.browser, { name });
  const accounts: Chart = await chart(member.browser, companyId);
  const call = (path: string, body?: unknown) => member.browser.call(`/api/companies/${companyId}${path}`, body);
  const ledger = async (ledgerName: string, groupKey: string, extra: Record<string, unknown> = {}) => {
    const created = await call('/ledgers', { name: ledgerName, groupId: accounts.group(groupKey), ...extra });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.ledger.id as string;
  };
  const voucher = async (kind: string, date: string, lines: Line[], extra: Record<string, unknown> = {}, status = 201) => {
    const posted = await call('/vouchers', {
      idempotencyKey: `bills-${randomUUID()}`, voucherTypeId: accounts.type(kind), date, ...extra,
      lines: lines.map(([ledgerId, side, amount, bills]) => ({ ledgerId, side, amount, ...(bills ? { bills } : {}) })),
    });
    assert.equal(posted.status, status, JSON.stringify(posted.body));
    return posted.body;
  };
  /** Re-sends a voucher as read, with `changes` applied: the alter body states everything. */
  const alter = async (voucher: any, changes: Record<string, unknown> = {}, status = 200) => {
    const body = {
      date: voucher.date, narration: voucher.narration, status: voucher.status, postDated: voucher.postDated, reference: voucher.reference,
      referenceDate: voucher.referenceDate, revision: voucher.revision,
      lines: voucher.lines.map((line: any) => ({ ledgerId: line.ledgerId, side: line.side, amount: line.amount,
        bills: line.bills.map((row: any) => ({ kind: row.kind, amount: row.amount, side: row.side, ...(row.kind === 'on_account' ? {} : { name: row.billName }),
          ...(row.kind === 'new_ref' || row.kind === 'advance' ? { creditPeriod: row.creditPeriod ?? { dueDate: row.dueDate } } : {}) })) })),
      ...changes,
    };
    const altered = await call(`/vouchers/${voucher.id}`, body);
    assert.equal(altered.status, status, JSON.stringify(altered.body));
    return altered.body;
  };
  const report = async (path: string) => {
    const read = await call(`/reports/${path}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    return read.body.report;
  };
  const listed = async (side: 'receivable' | 'payable', asOf: string) =>
    (await report(`bills-outstanding?side=${side}&asOf=${asOf}`)).bills.map((bill: any) => [bill.name, bill.ledgerName, bill.amount, bill.dueDate]);
  const partyBills = async (ledgerId: string, asOf: string) => report(`party-bills/${ledgerId}?asOf=${asOf}`);
  const pending = async (ledgerId: string, asOf: string) =>
    Object.fromEntries((await partyBills(ledgerId, asOf)).bills.map((bill: any) => [bill.name, bill.pending]));
  return { companyId, accounts, call, ledger, voucher, alter, report, listed, partyBills, pending };
}

test('golden scenario: the analyst\'s receivables and payables lists, on account, ageing and overdue days', async () => {
  const g = await books('Golden Bills');
  const sales = await g.ledger('Sales', 'sales'), tax = await g.ledger('Tax Payable', 'duties_taxes'), bank = await g.ledger('Bank', 'bank_accounts');
  const costs = await g.ledger('Project Costs', 'purchases'), b = await g.ledger('Debtor B', 'receivables'), c = await g.ledger('Creditor C', 'payables');
  const a = await g.ledger('Debtor A', 'receivables', { opening: { amount: '5000', side: 'Dr', bills: [
    { kind: 'new_ref', name: 'OB-1', billDate: '2025-12-31', amount: '3000', creditPeriod: { dueDate: '2026-01-15' } },
    { kind: 'new_ref', name: 'OB-2', billDate: '2025-12-20', amount: '1500', ...days(30) }] } });

  await g.voucher('sales', '2026-01-05', [[a, 'Dr', '10500', [newRef('S-1', '10500', days(30))]], [sales, 'Cr', '10000'], [tax, 'Cr', '500']]);
  await g.voucher('receipt', '2026-01-20', [[bank, 'Dr', '4000'], [a, 'Cr', '4000', [against('OB-1', '3000'), against('S-1', '800'), { kind: 'on_account', amount: '200' }]]]);
  await g.voucher('receipt', '2026-01-25', [[bank, 'Dr', '2000'], [b, 'Cr', '2000', [{ kind: 'advance', name: 'ADV-B', amount: '2000' }]]]);
  await g.voucher('sales', '2026-02-01', [[b, 'Dr', '5250', [against('ADV-B', '2000'), newRef('S-2', '3250', days(30))]], [sales, 'Cr', '5000'], [tax, 'Cr', '250']]);
  await g.voucher('purchase', '2026-02-03', [[costs, 'Dr', '8400'], [c, 'Cr', '8400', [newRef('C-77', '8400', days(45))]]]);
  await g.voucher('payment', '2026-02-10', [[c, 'Dr', '5000', [against('C-77', '5000')]], [bank, 'Cr', '5000']]);
  await g.voucher('credit_note', '2026-02-12', [[sales, 'Dr', '500'], [tax, 'Dr', '25'], [a, 'Cr', '525', [against('S-1', '525')]]]);
  const settle = (await g.voucher('receipt', '2026-02-14', [[bank, 'Dr', '1000'], [a, 'Cr', '1000', [against('S-1', '1000')]]])).voucher;
  const extra = (await g.voucher('sales', '2026-02-15', [[b, 'Dr', '700', [newRef('S-3', '700', days(30))]], [sales, 'Cr', '700']])).voucher;

  // Observed before the cancel and the delete (28 Feb): S-1 8,175.00 and S-3 listed.
  assert.deepEqual(await g.listed('receivable', '2026-02-28'), [
    ['OB-2', 'Debtor A', '1500.00', '2026-01-19'], ['S-1', 'Debtor A', '8175.00', '2026-02-04'],
    ['S-2', 'Debtor B', '3250.00', '2026-03-03'], ['S-3', 'Debtor B', '700.00', '2026-03-17']]);
  const cancelled = await g.call(`/vouchers/${settle.id}/cancel`, { revision: settle.revision });
  assert.deepEqual([cancelled.status, cancelled.body.warnings], [200, []]);
  const deleted = await g.call(`/vouchers/${extra.id}/delete`, { revision: extra.revision });
  assert.deepEqual([deleted.status, deleted.body], [200, { deleted: true, warnings: [] }]);

  // Observed after (28 Feb): S-1 back to 9,175.00, S-3 gone; bills payable C-77 3,400.00.
  assert.deepEqual(await g.listed('receivable', '2026-02-28'), [
    ['OB-2', 'Debtor A', '1500.00', '2026-01-19'], ['S-1', 'Debtor A', '9175.00', '2026-02-04'], ['S-2', 'Debtor B', '3250.00', '2026-03-03']]);
  assert.deepEqual(await g.listed('payable', '2026-02-28'), [['C-77', 'Creditor C', '3400.00', '2026-03-20']]);
  const receivable = await g.report('bills-outstanding?side=receivable&asOf=2026-02-28');
  assert.equal(receivable.total, '13925.00');
  assert.deepEqual(receivable.groups.map((group: any) => group.name), ['Trade Receivables', 'Trade Payables'], 'by default a list covers both trade groups');

  // Debtors 14,225.00 at 28 Feb: A 10,975 (bills 10,675 and 300 on account: 500 opening less 200 received), B 3,250.
  const partyA = await g.partyBills(a, '2026-02-28');
  assert.deepEqual([partyA.balance, partyA.onAccount], ['10975.00', '300.00']);
  const partyB = await g.partyBills(b, '2026-02-28');
  assert.deepEqual([partyB.balance, partyB.onAccount, partyB.bills.map((bill: any) => bill.name)], ['3250.00', '0.00', ['S-2']]);

  // Observed overdue days at 31 Mar: OB-2 71, S-1 55, S-2 28; C-77 11.
  const overdue = async (side: 'receivable' | 'payable') =>
    (await g.report(`bills-outstanding?side=${side}&asOf=2026-03-31`)).bills.map((bill: any) => [bill.name, bill.overdueDays]);
  assert.deepEqual(await overdue('receivable'), [['OB-2', 71], ['S-1', 55], ['S-2', 28]]);
  assert.deepEqual(await overdue('payable'), [['C-77', 11]]);

  // Observed ageing at 20 Mar by bill date with columns 0-30, 30-60, 60-90, over 90: OB-2 (90 days old) and S-1 in
  // 60 to 90, S-2 in 30 to 60. A bill on a boundary day sits in the earlier column.
  const noColumns = await g.report('ageing?side=receivable&asOf=2026-03-20');
  assert.deepEqual([noColumns.buckets, noColumns.totals.buckets, noColumns.totals.total], [[{ fromDays: 0, toDays: null }], ['13925.00'], '13925.00'],
    'no columns are defined by default; one open column keeps the total');
  // A closed last column gets an open one after it, so the columns add up to the total.
  assert.equal((await g.call('/ageing-buckets', { buckets: [{ fromDays: 0, toDays: 30 }] })).status, 200);
  const closed = await g.report('ageing?side=receivable&asOf=2026-03-20');
  assert.deepEqual([closed.buckets, closed.totals.buckets], [[{ fromDays: 0, toDays: 30 }, { fromDays: 30, toDays: null }], ['0.00', '13925.00']]);
  // The list pages; the total covers every page.
  const first = await g.report('bills-outstanding?side=receivable&asOf=2026-02-28&limit=2');
  assert.deepEqual([first.bills.map((bill: any) => bill.name), first.total], [['OB-2', 'S-1'], '13925.00']);
  const second = await g.report(`bills-outstanding?side=receivable&asOf=2026-02-28&limit=2&after=${first.next}`);
  assert.deepEqual([second.bills.map((bill: any) => bill.name), second.total, second.next], [['S-2'], null, null], 'the total comes with the first page');
  // One bill a page, through a party's settled bills (OB-1, ADV-B): the walk returns exactly the full list, in order.
  const walked: string[] = [];
  for (let next: string | null = null, guard = 0; guard < 10; guard += 1) {
    const page: any = await g.report(`bills-outstanding?side=receivable&asOf=2026-02-28&limit=1${next ? `&after=${next}` : ''}`);
    walked.push(...page.bills.map((bill: any) => `${bill.ledgerName}/${bill.name}`));
    next = page.next;
    if (!next) break;
  }
  assert.deepEqual(walked, ['Debtor A/OB-2', 'Debtor A/S-1', 'Debtor B/S-2']);
  const saved = await g.call('/ageing-buckets', { buckets: [{ fromDays: 0, toDays: 30 }, { fromDays: 30, toDays: 60 }, { fromDays: 60, toDays: 90 }, { fromDays: 90, toDays: null }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const ageing = await g.report('ageing?side=receivable&asOf=2026-03-20&basis=bill');
  assert.deepEqual(ageing.parties.map((party: any) => [party.name, party.buckets, party.total]), [
    ['Debtor A', ['0.00', '0.00', '10675.00', '0.00'], '10675.00'], ['Debtor B', ['0.00', '3250.00', '0.00', '0.00'], '3250.00']]);
  assert.equal(ageing.totals.total, receivable.total);
  const byDue = await g.report('ageing?side=receivable&asOf=2026-03-02&basis=due');
  assert.deepEqual(byDue.parties.map((party: any) => [party.name, party.notDue, party.buckets]), [
    ['Debtor A', '0.00', ['9175.00', '1500.00', '0.00', '0.00']], ['Debtor B', '3250.00', ['0.00', '0.00', '0.00', '0.00']]]);

  // Reconciliation, computed both ways: for every party at several dates, pending bills plus on account (from the lines)
  // equals the balance from the ledger read model.
  for (const asOf of ['2026-01-01', '2026-01-20', '2026-02-12', '2026-02-28', '2026-06-30']) {
    for (const party of [a, b, c]) {
      const read = await g.partyBills(party, asOf);
      const sum = read.bills.reduce((total: number, bill: any) => total + Math.round(Number(bill.pending) * 100), Math.round(Number(read.onAccount) * 100));
      assert.equal(sum, Math.round(Number(read.balance) * 100), `${asOf} ${read.ledger.name}`);
    }
  }
});

test('each list holds the bills lying on its side: a customer advance is a payable, a supplier debit bill a receivable, ageing follows (observed)', async () => {
  const g = await books('Bills By Side');
  const bank = await g.ledger('Bank', 'bank_accounts'), sales = await g.ledger('Sales', 'sales'), costs = await g.ledger('Costs', 'purchases');
  const customer = await g.ledger('Customer', 'receivables'), supplier = await g.ledger('Supplier', 'payables');
  await g.voucher('sales', '2026-03-01', [[customer, 'Dr', '500', [newRef('INV-1', '500')]], [sales, 'Cr', '500']]);
  await g.voucher('receipt', '2026-03-02', [[bank, 'Dr', '800'], [customer, 'Cr', '800', [{ kind: 'advance', name: 'ADV-C', amount: '800' }]]]);
  await g.voucher('purchase', '2026-03-03', [[costs, 'Dr', '300'], [supplier, 'Cr', '300', [newRef('SUP-1', '300')]]]);
  await g.voucher('payment', '2026-03-04', [[supplier, 'Dr', '200', [{ kind: 'advance', name: 'ADV-S', amount: '200' }]], [bank, 'Cr', '200']]);
  assert.deepEqual(await g.listed('receivable', '2026-03-31'), [['INV-1', 'Customer', '500.00', '2026-03-01'], ['ADV-S', 'Supplier', '200.00', '2026-03-04']]);
  assert.deepEqual(await g.listed('payable', '2026-03-31'), [['ADV-C', 'Customer', '800.00', '2026-03-02'], ['SUP-1', 'Supplier', '300.00', '2026-03-03']]);
  const payables = await g.report('bills-outstanding?side=payable&asOf=2026-03-31');
  assert.equal(payables.total, '1100.00');
  const ageing = await g.report('ageing?side=payable&asOf=2026-03-31');
  assert.deepEqual([ageing.parties.map((party: any) => [party.name, party.total]), ageing.totals.total], [[['Customer', '800.00'], ['Supplier', '300.00']], '1100.00']);
  // A group asked for limits the list to that group's parties, on the list's side.
  const onlyDebtors = await g.report(`bills-outstanding?side=payable&asOf=2026-03-31&groupId=${g.accounts.group('receivables')}`);
  assert.deepEqual([onlyDebtors.groups.map((group: any) => group.name), onlyDebtors.bills.map((bill: any) => bill.name)], [['Trade Receivables'], ['ADV-C']]);
  const csv = await (await raw(owner, `/api/companies/${g.companyId}/reports/bills-outstanding/export?side=payable&asOf=2026-03-31`)).text();
  assert.match(csv, /"2026-03-02","ADV-C","Customer","800.00"/);
});

test('bills are listed by name as text, ignoring case and punctuation: the ten observed names in their observed order', async () => {
  const g = await books('Bills By Name');
  const sales = await g.ledger('Sales', 'sales'), party = await g.ledger('Ten Bills', 'receivables');
  const observed = ['10', '9', 'A-020', 'A-100', 'a2', 'B-050', 'B1', 'b3', 'B-300', 'C-200'];
  for (const name of ['B-300', 'a2', 'C-200', '9', 'B1', 'A-100', '10', 'b3', 'A-020', 'B-050']) {
    await g.voucher('sales', '2026-03-01', [[party, 'Dr', '10', [newRef(name, '10')]], [sales, 'Cr', '10']]);
  }
  const picker = async (direction: string) => ((await g.call(`/ledgers/${party}/bills?asOf=2026-03-31&sort=name&direction=${direction}`)).body.bills as any[]).map(bill => bill.name);
  assert.deepEqual(await picker('asc'), observed, 'the pending list for entry');
  assert.deepEqual(await picker('desc'), [...observed].reverse());
  assert.deepEqual((await g.listed('receivable', '2026-03-31')).map((bill: any) => bill[0]), observed, 'the bills receivable list, in the database order');
  // Paged one bill at a time, the list keeps the order (the cursor carries the bill id: names may compare equal).
  const walked: string[] = [];
  let after: string | null = null;
  do {
    const page: any = await g.report(`bills-outstanding?side=receivable&asOf=2026-03-31&limit=1${after ? `&after=${after}` : ''}`);
    walked.push(...page.bills.map((bill: any) => bill.name));
    after = page.next;
  } while (after);
  assert.deepEqual(walked, observed);
});

test('a bill is the party\'s name ignoring case: reuse attaches, also after settlement or deletion; another party has its own', async () => {
  const g = await books('Reuse Bills');
  const sales = await g.ledger('Sales', 'sales'), bank = await g.ledger('Bank', 'bank_accounts');
  const p6 = await g.ledger('Party Six', 'receivables'), p7 = await g.ledger('Party Seven', 'receivables');
  const first = await g.voucher('sales', '2026-03-10', [[p6, 'Dr', '300', [newRef('X-1', '300')]], [sales, 'Cr', '300']]);
  assert.deepEqual(first.warnings, []);
  const second = await g.voucher('sales', '2026-03-11', [[p6, 'Dr', '200', [newRef('X-1', '200')]], [sales, 'Cr', '200']]);
  assert.deepEqual(second.warnings.map((item: any) => [item.code, item.billName]), [['bill_attached', 'X-1']]);
  const lower = await g.voucher('sales', '2026-03-13', [[p6, 'Dr', '100', [newRef('x-1', '100')]], [sales, 'Cr', '100']]);
  assert.equal(lower.voucher.lines[0].bills[0].billName, 'X-1', 'a case variant takes the first spelling');
  await g.voucher('sales', '2026-03-12', [[p7, 'Dr', '100', [newRef('X-1', '100')]], [sales, 'Cr', '100']]);
  assert.deepEqual(await g.pending(p6, '2026-03-31'), { 'X-1': '600.00' });
  assert.deepEqual(await g.pending(p7, '2026-03-31'), { 'X-1': '100.00' });
  const ids = [first, second, lower].map(posted => posted.voucher.lines[0].bills[0].billId);
  assert.equal(new Set(ids).size, 1, 'one bill id for the three rows');

  // After full settlement the name reopens the same bill (observed N-5: 500 settled, then 250 more).
  const p5 = await g.ledger('Party Five', 'receivables');
  const n5 = await g.voucher('sales', '2026-03-10', [[p5, 'Dr', '500', [newRef('N-5', '500')]], [sales, 'Cr', '500']]);
  await g.voucher('receipt', '2026-03-12', [[bank, 'Dr', '500'], [p5, 'Cr', '500', [against('N-5', '500')]]]);
  assert.deepEqual(await g.pending(p5, '2026-03-16'), {});
  const again = await g.voucher('sales', '2026-03-17', [[p5, 'Dr', '250', [newRef('N-5', '250')]], [sales, 'Cr', '250']]);
  assert.equal(again.voucher.lines[0].bills[0].billId, n5.voucher.lines[0].bills[0].billId);
  assert.deepEqual(await g.pending(p5, '2026-03-31'), { 'N-5': '250.00' });
  const detail = await g.report(`bill/${n5.voucher.lines[0].bills[0].billId}?asOf=2026-03-31`);
  assert.deepEqual(detail.rows.map((row: any) => [row.date, row.kind, row.method, row.pending]), [
    ['2026-03-10', 'new_ref', 'new_ref', '500.00'], ['2026-03-12', 'against_ref', 'against_ref', '0.00'], ['2026-03-17', 'new_ref', 'against_ref', '250.00']]);
});

test('cancelling or deleting a part-settled invoice leaves the receipt as its own bill dated the receipt, with a warning', async () => {
  const g = await books('Origin Bills');
  const sales = await g.ledger('Sales', 'sales'), bank = await g.ledger('Bank', 'bank_accounts');
  const p1 = await g.ledger('Party One', 'receivables'), p2 = await g.ledger('Party Two', 'receivables');
  const inv16 = (await g.voucher('sales', '2026-03-10', [[p1, 'Dr', '1000', [newRef('N-1', '1000', days(30))]], [sales, 'Cr', '1000']])).voucher;
  const inv17 = (await g.voucher('sales', '2026-03-10', [[p2, 'Dr', '1000', [newRef('N-2', '1000', days(30))]], [sales, 'Cr', '1000']])).voucher;
  await g.voucher('receipt', '2026-03-12', [[bank, 'Dr', '400'], [p1, 'Cr', '400', [against('N-1', '400')]]]);
  await g.voucher('receipt', '2026-03-12', [[bank, 'Dr', '400'], [p2, 'Cr', '400', [against('N-2', '400')]]]);
  assert.deepEqual([await g.pending(p1, '2026-03-31'), await g.pending(p2, '2026-03-31')], [{ 'N-1': '600.00' }, { 'N-2': '600.00' }]);

  const cancelled = await g.call(`/vouchers/${inv16.id}/cancel`, { revision: inv16.revision });
  assert.deepEqual(cancelled.body.warnings.map((item: any) => [item.code, item.billName]), [['bill_split', 'N-1']]);
  const deleted = await g.call(`/vouchers/${inv17.id}/delete`, { revision: inv17.revision });
  assert.deepEqual(deleted.body.warnings.map((item: any) => [item.code, item.billName]), [['bill_split', 'N-2']]);
  for (const [party, name] of [[p1, 'N-1'], [p2, 'N-2']]) {
    const [bill] = (await g.partyBills(party, '2026-03-31')).bills;
    assert.deepEqual([bill.name, bill.pending, bill.billDate, bill.dueDate, bill.method], [name, '-400.00', '2026-03-12', '2026-04-11', 'new_ref'],
      'the receipt row stands as a bill dated the receipt, with the copied 30 days');
  }
  assert.deepEqual(await g.listed('receivable', '2026-03-31'), [], 'credit bills are not listed in bills receivable (observed)');
  // A later invoice with the name absorbs the orphan (observed N-2: 700 - 400 = 300).
  await g.voucher('sales', '2026-03-20', [[p2, 'Dr', '700', [newRef('N-2', '700')]], [sales, 'Cr', '700']]);
  assert.deepEqual(await g.pending(p2, '2026-03-31'), { 'N-2': '300.00' });
});

test('renaming a settled reference or changing its party leaves the settlement on the old bill; other alters keep the bill', async () => {
  const g = await books('Rename Bills');
  const sales = await g.ledger('Sales', 'sales'), bank = await g.ledger('Bank', 'bank_accounts');
  const p3 = await g.ledger('Party Three', 'receivables'), p4 = await g.ledger('Party Four', 'receivables'), p1 = await g.ledger('Party One', 'receivables');
  const inv18 = (await g.voucher('sales', '2026-03-10', [[p3, 'Dr', '1000', [newRef('N-3', '1000', days(30))]], [sales, 'Cr', '1000']])).voucher;
  const inv19 = (await g.voucher('sales', '2026-03-10', [[p4, 'Dr', '1000', [newRef('N-4', '1000', days(30))]], [sales, 'Cr', '1000']])).voucher;
  await g.voucher('receipt', '2026-03-12', [[bank, 'Dr', '400'], [p3, 'Cr', '400', [against('N-3', '400')]]]);
  await g.voucher('receipt', '2026-03-12', [[bank, 'Dr', '400'], [p4, 'Cr', '400', [against('N-4', '400')]]]);

  // An alter that keeps the name keeps the bill: no split, the same pending.
  const kept = await g.alter(inv18, { narration: 'Checked' });
  assert.deepEqual(kept.warnings, []);
  assert.deepEqual(await g.pending(p3, '2026-03-31'), { 'N-3': '600.00' });

  const renamed = await g.alter(kept.voucher, { lines: [
    { ledgerId: p3, side: 'Dr', amount: '1000', bills: [newRef('N-3R', '1000', days(30))] }, { ledgerId: sales, side: 'Cr', amount: '1000' }] });
  assert.deepEqual(renamed.warnings.map((item: any) => [item.code, item.billName]), [['bill_split', 'N-3']]);
  assert.deepEqual(await g.pending(p3, '2026-03-31'), { 'N-3': '-400.00', 'N-3R': '1000.00' });

  const moved = await g.alter(inv19, { lines: [
    { ledgerId: p1, side: 'Dr', amount: '1000', bills: [newRef('N-4', '1000', days(30))] }, { ledgerId: sales, side: 'Cr', amount: '1000' }] });
  assert.deepEqual(moved.warnings.map((item: any) => [item.code, item.billName]), [['bill_split', 'N-4']]);
  assert.deepEqual([await g.pending(p1, '2026-03-31'), await g.pending(p4, '2026-03-31')], [{ 'N-4': '1000.00' }, { 'N-4': '-400.00' }]);
  const history = (await g.call(`/vouchers/${inv18.id}/revisions`)).body.revisions;
  assert.equal(history.at(-1).after.lines[0].bills[0].billName, 'N-3R', 'the revision snapshot records the bill rows');
});

test('a bill is dated by its earliest new reference; a back-dated settlement does not take over its dates', async () => {
  const g = await books('Order Bills');
  const sales = await g.ledger('Sales', 'sales'), bank = await g.ledger('Bank', 'bank_accounts'), p = await g.ledger('Party', 'receivables');
  await g.voucher('sales', '2026-03-10', [[p, 'Dr', '1000', [newRef('N-7', '1000', days(30))]], [sales, 'Cr', '1000']]);
  const receipt = await g.voucher('receipt', '2026-03-05', [[bank, 'Dr', '400'], [p, 'Cr', '400', [against('N-7', '400')]]]);
  assert.deepEqual(receipt.voucher.lines[1].bills[0].creditPeriod, { count: 30, unit: 'day' }, 'the settlement copies the bill\'s terms');
  const [bill] = (await g.partyBills(p, '2026-03-20')).bills;
  assert.deepEqual([bill.pending, bill.billDate, bill.dueDate, bill.overdueDays], ['600.00', '2026-03-10', '2026-04-09', 0]);
  const [early] = (await g.partyBills(p, '2026-03-07')).bills;
  assert.deepEqual([early.pending, early.billDate], ['-400.00', '2026-03-10'], 'before the invoice\'s date only the receipt counts; the invoice still dates the bill');
  assert.deepEqual((await g.call(`/ledgers/${p}/bills?asOf=2026-03-07`)).body.bills, [], 'the pending list for a voucher dated before the bill does not offer it');

  // Observed (N-9): invoice on 10 Jun, a receipt of 400 on 5 Jun, then a second new reference on 3 Jun for 200: one bill,
  // pending 800, dated 3 Jun and due 3 Jul (the earliest new reference's date and credit days).
  await g.voucher('sales', '2026-06-10', [[p, 'Dr', '1000', [newRef('N-9', '1000', days(30))]], [sales, 'Cr', '1000']]);
  await g.voucher('receipt', '2026-06-05', [[bank, 'Dr', '400'], [p, 'Cr', '400', [against('N-9', '400')]]]);
  await g.voucher('sales', '2026-06-03', [[p, 'Dr', '200', [newRef('N-9', '200', days(30))]], [sales, 'Cr', '200']]);
  const n9 = async (asOf: string) => (await g.partyBills(p, asOf)).bills.find((bill: any) => bill.name === 'N-9');
  const june = await n9('2026-06-20');
  assert.deepEqual([june.pending, june.billDate, june.dueDate, june.overdueDays], ['800.00', '2026-06-03', '2026-07-03', 0]);
  assert.equal((await n9('2026-07-05')).overdueDays, 2);
});

test('a settlement names a bill with live entries; its terms are copied when it is posted', async () => {
  const g = await books('Settled Bills');
  const sales = await g.ledger('Sales', 'sales'), bank = await g.ledger('Bank', 'bank_accounts'), p = await g.ledger('Party', 'receivables');
  const first = (await g.voucher('sales', '2026-03-12', [[p, 'Dr', '1000', [newRef('T-1', '1000', days(30))]], [sales, 'Cr', '1000']])).voucher;
  await g.voucher('receipt', '2026-03-13', [[bank, 'Dr', '100'], [p, 'Cr', '100', [against('T-1', '100')]]]);
  await g.call(`/vouchers/${first.id}/delete`, { revision: first.revision });
  const [kept] = (await g.partyBills(p, '2026-03-31')).bills;
  assert.deepEqual([kept.name, kept.dueDate], ['T-1', '2026-04-12'], 'the receipt keeps the 30 days copied when it was posted');

  const second = (await g.voucher('sales', '2026-03-12', [[p, 'Dr', '500', [newRef('T-2', '500', days(30))]], [sales, 'Cr', '500']])).voucher;
  await g.call(`/vouchers/${second.id}/delete`, { revision: second.revision });
  const refused = await g.voucher('receipt', '2026-03-13', [[bank, 'Dr', '100'], [p, 'Cr', '100', [against('T-2', '100')]]], {}, 409);
  assert.equal(refused.code, 'bill_inactive', 'a bill without live entries is not offered for settlement');
  const reused = await g.voucher('sales', '2026-03-20', [[p, 'Dr', '50', [newRef('T-2', '50')]], [sales, 'Cr', '50']]);
  assert.equal(reused.voucher.lines[0].bills[0].billName, 'T-2', 'a new reference on that name still attaches (observed)');
});

test('partial, over and opposite-side rows are accepted as observed; rows beyond the line are refused', async () => {
  const g = await books('Allocation Bills');
  const sales = await g.ledger('Sales', 'sales'), bank = await g.ledger('Bank', 'bank_accounts');
  const p7 = await g.ledger('Party Seven', 'receivables'), p9 = await g.ledger('Party Nine', 'receivables'), p10 = await g.ledger('Party Ten', 'receivables');
  await g.voucher('sales', '2026-03-10', [[p7, 'Dr', '1000', [newRef('Q4-A', '600')]], [sales, 'Cr', '1000']]);
  const partial = await g.partyBills(p7, '2026-03-31');
  assert.deepEqual([partial.bills.map((bill: any) => [bill.name, bill.pending]), partial.onAccount], [[['Q4-A', '600.00']], '400.00']);

  await g.voucher('sales', '2026-03-21', [[p9, 'Dr', '500', [newRef('OV-1', '500')]], [sales, 'Cr', '500']]);
  const over = await g.voucher('receipt', '2026-03-22', [[bank, 'Dr', '700'], [p9, 'Cr', '700', [against('OV-1', '700')]]]);
  assert.deepEqual(over.warnings.map((item: any) => [item.code, item.billName, item.amount]), [['bill_over_settled', 'OV-1', '200.00']]);
  assert.deepEqual(await g.listed('receivable', '2026-03-31'), [['Q4-A', 'Party Seven', '600.00', '2026-03-10']], 'OV-1 is cleared from bills receivable');

  await g.voucher('sales', '2026-03-21', [[p10, 'Dr', '1000', [newRef('OP-1', '1000', days(30))]], [sales, 'Cr', '1000']]);
  const opposite = await g.voucher('receipt', '2026-03-23', [[bank, 'Dr', '600'], [p10, 'Cr', '600', [against('OP-1', '700'), newRef('OP-2', '100', { side: 'Dr', ...days(30) })]]]);
  assert.deepEqual(opposite.warnings, []);
  const op = await g.partyBills(p10, '2026-03-31');
  assert.deepEqual(op.bills.map((bill: any) => [bill.name, bill.pending, bill.dueDate]), [['OP-1', '300.00', '2026-04-20'], ['OP-2', '100.00', '2026-04-22']]);

  const both = await g.voucher('receipt', '2026-03-24', [[bank, 'Dr', '100'], [p10, 'Cr', '100', [against('OP-1', '150'), against('OP-1', '50', { side: 'Dr' })]]]);
  assert.deepEqual(both.warnings.map((item: any) => item.code), ['bill_both_sides']);
  for (const [rows, message] of [
    [[against('OP-1', '200')], 'add up to 200.00, more than its 100.00'],
    [[against('OP-1', '50'), against('OP-1', '160', { side: 'Dr' })], 'add up to its other side'],
  ] as const) {
    const refused = await g.voucher('receipt', '2026-03-25', [[bank, 'Dr', '100'], [p10, 'Cr', '100', [...rows]]], {}, 400);
    assert.equal(refused.code, 'allocation_total');
    assert.match(refused.error, new RegExp(message));
  }
  const missing = await g.voucher('receipt', '2026-03-25', [[bank, 'Dr', '100'], [p10, 'Cr', '100', [against('NOPE', '100')]]], {}, 400);
  assert.equal(missing.code, 'not_found');
});

test('optional bills count once regular; post-dated ones from their date; an unnamed reference takes the number or the supplier reference', async () => {
  const g = await books('Naming Bills');
  const sales = await g.ledger('Sales', 'sales'), costs = await g.ledger('Costs', 'purchases'), p8 = await g.ledger('Party Eight', 'receivables');
  const c = await g.ledger('Creditor C', 'payables');
  const optional = (await g.voucher('sales', '2026-03-15', [[p8, 'Dr', '700', [newRef('O-1', '700')]], [sales, 'Cr', '700']], { status: 'optional' })).voucher;
  await g.voucher('sales', '2026-03-20', [[p8, 'Dr', '600', [newRef('PD-1', '600')]], [sales, 'Cr', '600']], { postDated: true });
  assert.deepEqual(await g.pending(p8, '2026-03-15'), {});
  assert.deepEqual(await g.pending(p8, '2026-03-20'), { 'PD-1': '600.00' });
  await g.alter(optional, { status: 'regular' });
  assert.deepEqual(await g.pending(p8, '2026-03-31'), { 'O-1': '700.00', 'PD-1': '600.00' });

  // Sales: an unnamed new reference is named by the voucher number; on an optional voucher it is refused.
  const unnamed = await g.voucher('sales', '2026-03-21', [[p8, 'Dr', '50', [newRef(undefined, '50')]], [sales, 'Cr', '50']]);
  assert.equal(unnamed.voucher.lines[0].bills[0].billName, String(unnamed.voucher.number));
  const refusedOptional = await g.voucher('sales', '2026-03-21', [[p8, 'Dr', '50', [newRef(undefined, '50')]], [sales, 'Cr', '50']], { status: 'optional' }, 400);
  assert.equal(refusedOptional.code, 'validation');
  // A journal that names a bill after a sales number joins it: the caller is told.
  const journal = await g.voucher('journal', '2026-03-22', [[p8, 'Dr', '5', [newRef(String(unnamed.voucher.number), '5')]], [sales, 'Cr', '5']]);
  assert.deepEqual(journal.warnings.map((item: any) => item.code), ['bill_attached']);

  // Purchases: the supplier's invoice number names the bill; the reference date moves neither bill date nor due date (SI-9).
  const purchase = await g.voucher('purchase', '2026-03-10', [[costs, 'Dr', '900'], [c, 'Cr', '900', [newRef(undefined, '900', days(30))]]],
    { reference: 'SI-9', referenceDate: '2026-03-01' });
  assert.deepEqual([purchase.voucher.reference, purchase.voucher.referenceDate, purchase.voucher.lines[1].bills[0].billName], ['SI-9', '2026-03-01', 'SI-9']);
  const [bill] = (await g.partyBills(c, '2026-03-31')).bills;
  assert.deepEqual([bill.billDate, bill.dueDate], ['2026-03-10', '2026-04-09']);
  const noReference = await g.voucher('purchase', '2026-03-10', [[costs, 'Dr', '9'], [c, 'Cr', '9', [newRef(undefined, '9')]]], {}, 400);
  assert.equal(noReference.code, 'validation');
  const note = await g.voucher('debit_note', '2026-03-11', [[c, 'Dr', '100', [newRef(undefined, '100')]], [costs, 'Cr', '100']], { reference: 'DN-4' });
  assert.equal(note.voucher.lines[0].bills[0].billName, 'DN-4');
});

test('credit periods are kept as entered; the credit-days check counts overdue bills when it is on', async () => {
  const g = await books('Credit Bills');
  const sales = await g.ledger('Sales', 'sales');
  const p = await g.ledger('Checked Party', 'receivables', { creditPeriod: { count: 2, unit: 'week' }, creditDaysCheck: true });
  const party = (await g.call(`/ledgers/${p}`)).body.ledger;
  assert.deepEqual([party.billWise, party.creditPeriod, party.creditDaysCheck], [true, { count: 2, unit: 'week' }, true]);
  const post = (date: string, name: string, extra: Partial<Row> = {}) => g.voucher('sales', date, [[p, 'Dr', '100', [newRef(name, '100', extra)]], [sales, 'Cr', '100']]);
  await post('2026-01-31', 'W-1');
  await post('2026-01-31', 'M-1', { creditPeriod: { count: 1, unit: 'month' } });
  await post('2026-01-31', 'D-1', { creditPeriod: { dueDate: '2026-03-15' } });
  await post('2026-02-10', 'L-1', days(45));
  const dues = Object.fromEntries((await g.partyBills(p, '2026-02-28')).bills.map((bill: any) => [bill.name, bill.dueDate]));
  assert.deepEqual(dues, { 'W-1': '2026-02-14', 'M-1': '2026-02-28', 'D-1': '2026-03-15', 'L-1': '2026-03-27' }, 'weeks, a month from the 31st, a date, and days');

  const check = async (date: string) => (await g.call(`/ledgers/${p}/credit-check?date=${date}`)).body.creditCheck;
  assert.deepEqual(await check('2026-02-13'), { check: true, overdueBills: 0 });
  assert.deepEqual(await check('2026-02-14'), { check: true, overdueBills: 1 }, 'a bill due on the voucher date counts (observed)');
  assert.deepEqual(await check('2026-02-28'), { check: true, overdueBills: 2 }, 'the month bill is due that day');
  assert.deepEqual(await check('2026-06-30'), { check: true, overdueBills: 4 });
  const quiet = await g.ledger('Unchecked Party', 'receivables');
  await g.voucher('sales', '2026-01-31', [[quiet, 'Dr', '100', [newRef('Q-1', '100')]], [sales, 'Cr', '100']]);
  assert.deepEqual((await g.call(`/ledgers/${quiet}/credit-check?date=2026-06-30`)).body.creditCheck, { check: false, overdueBills: 0 });
});

test('bill-wise is a ledger setting: switched off it keeps old bills and drops new rows; cash and bank never keep bills', async () => {
  const g = await books('Switch Bills');
  const sales = await g.ledger('Sales', 'sales'), bank = await g.ledger('Bank', 'bank_accounts');
  const p6 = await g.ledger('Party Six', 'receivables');
  const invoice = (await g.voucher('sales', '2026-03-10', [[p6, 'Dr', '600', [newRef('X-1', '600')]], [sales, 'Cr', '600']])).voucher;
  const before = (await g.call(`/ledgers/${p6}`)).body.ledger;
  const off = await g.call(`/ledgers/${p6}`, { name: before.name, groupId: before.groupId, billWise: false, revision: before.revision });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual(await g.pending(p6, '2026-03-31'), { 'X-1': '600.00' }, 'the existing bill stays pending');
  const dropped = await g.voucher('sales', '2026-03-12', [[p6, 'Dr', '50', [newRef('X-2', '50')]], [sales, 'Cr', '50']]);
  assert.deepEqual([dropped.warnings.map((item: any) => [item.code, item.line]), dropped.voucher.lines[0].bills], [[['bills_ignored', 1]], []]);
  // Defect 5: altering the old invoice keeps its rows on the line whose ledger is no longer bill-wise.
  const altered = await g.alter(invoice, { narration: 'Kept' });
  assert.deepEqual([altered.warnings.map((item: any) => item.code), altered.voucher.lines[0].bills.length], [['bills_kept'], 1]);
  assert.deepEqual(await g.pending(p6, '2026-03-31'), { 'X-1': '600.00' });
  const shrunk = await g.alter(altered.voucher, { lines: [{ ledgerId: p6, side: 'Dr', amount: '500' }, { ledgerId: sales, side: 'Cr', amount: '500' }] }, 400);
  assert.equal(shrunk.code, 'allocation_total', 'kept rows must still fit the line');

  const onBank = await g.voucher('receipt', '2026-03-13', [[bank, 'Dr', '10', [newRef('BANK-R1', '10')]], [sales, 'Cr', '10']]);
  assert.deepEqual(onBank.warnings.map((item: any) => item.code), ['bills_ignored']);
  const bankLedger = (await g.call(`/ledgers/${bank}`)).body.ledger;
  const bankBillWise = await g.call(`/ledgers/${bank}`, { name: 'Bank', groupId: bankLedger.groupId, billWise: true, revision: bankLedger.revision });
  assert.deepEqual([bankBillWise.status, bankBillWise.body.code], [400, 'family_rule']);

  // A group holding a bill-wise ledger (or one with bills) does not move under the bank group.
  const groupId = (await g.call('/groups', { name: 'Key Accounts', parentId: g.accounts.group('receivables') })).body.group.id;
  const keyParty = await g.call('/ledgers', { name: 'Key Party', groupId });
  assert.equal(keyParty.body.ledger.billWise, true, 'a ledger below trade receivables is bill-wise by default');
  const group = (await g.call(`/groups/${groupId}`)).body.group;
  const move = await g.call(`/groups/${groupId}`, { name: group.name, parentId: g.accounts.group('bank_accounts'), revision: group.revision });
  assert.deepEqual([move.status, move.body.code], [400, 'family_rule']);
});

test('opening bills: new bills on the opening side, dated before the books begin by default, within the opening balance', async () => {
  const g = await books('Opening Bills');
  const p = await g.ledger('Opening Party', 'receivables', { opening: { amount: '1000', side: 'Dr', bills: [
    { name: 'OB-1', amount: '600' }, { kind: 'new_ref', name: 'OB-2', amount: '100', billDate: '2025-11-30', creditPeriod: { count: 30, unit: 'day' } }] } });
  const ledger = (await g.call(`/ledgers/${p}`)).body.ledger;
  assert.deepEqual(ledger.openingBills.map((row: any) => [row.kind, row.billName, row.billDate, row.dueDate, row.amount, row.side]), [
    ['new_ref', 'OB-1', '2025-12-31', '2025-12-31', '600.00', 'Dr'], ['new_ref', 'OB-2', '2025-11-30', '2025-12-30', '100.00', 'Dr']]);
  const read = await g.partyBills(p, '2026-01-01');
  assert.deepEqual([read.bills.map((bill: any) => [bill.name, bill.pending]), read.onAccount], [[['OB-2', '100.00'], ['OB-1', '600.00']], '300.00'],
    'the unallocated rest is on account');

  const refusals: [unknown, string][] = [
    [{ amount: '1000', side: 'Dr', bills: [{ kind: 'new_ref', name: 'A', amount: '1200' }] }, 'allocation_total'],
    [{ amount: '1000', side: 'Dr', bills: [{ kind: 'new_ref', name: 'A', amount: '100', billDate: '2026-01-02' }] }, 'validation'],
    [{ amount: '1000', side: 'Dr', bills: [{ kind: 'advance', name: 'A', amount: '100' }] }, 'validation'],
    [{ amount: '1000', side: 'Dr', bills: [{ kind: 'new_ref', name: 'A', amount: '100', side: 'Cr' }] }, 'validation'],
  ];
  for (const [opening, code] of refusals) {
    const refused = await g.call(`/ledgers/${p}`, { name: ledger.name, groupId: ledger.groupId, opening, revision: ledger.revision });
    assert.deepEqual([refused.status, refused.body.code], [400, code]);
  }
  const lower = await g.call(`/ledgers/${p}`, { name: ledger.name, groupId: ledger.groupId, opening: { amount: '600', side: 'Dr' }, revision: ledger.revision });
  assert.deepEqual([lower.status, lower.body.code], [400, 'allocation_total'], 'kept opening rows must fit a lower opening balance');
  const plain = await g.ledger('Plain', 'indirect_expenses');
  const plainLedger = (await g.call(`/ledgers/${plain}`)).body.ledger;
  assert.equal(plainLedger.billWise, false, 'only receivables and payables ledgers are bill-wise by default');
  const notBillWise = await g.call(`/ledgers/${plain}`, { name: 'Plain', groupId: plainLedger.groupId, opening: { amount: '10', side: 'Dr', bills: [{ kind: 'new_ref', name: 'Z', amount: '10' }] }, revision: plainLedger.revision });
  assert.deepEqual([notBillWise.status, notBillWise.body.code], [400, 'validation']);
});

test('ageing columns are the company\'s, contiguous from 0; viewers read them, editors change them; the picker sorts', async () => {
  const g = await books('Ageing Bills');
  const sales = await g.ledger('Sales', 'sales'), bank = await g.ledger('Bank', 'bank_accounts'), p = await g.ledger('Party', 'receivables');
  for (const [body, ok] of [
    [{ buckets: [{ fromDays: 5, toDays: 30 }] }, false], [{ buckets: [{ fromDays: 0, toDays: 30 }, { fromDays: 31, toDays: null }] }, false],
    [{ buckets: [{ fromDays: 0, toDays: null }, { fromDays: 30, toDays: 60 }] }, false], [{ buckets: [] }, true],
  ] as const) {
    const saved = await g.call('/ageing-buckets', body);
    assert.equal(saved.status, ok ? 200 : 400, JSON.stringify([body, saved.body]));
  }
  const viewer = await invite(owner.browser, g.companyId, 'viewer');
  assert.equal((await viewer.browser.call(`/api/companies/${g.companyId}/ageing-buckets`)).status, 200);
  const write = await viewer.browser.call(`/api/companies/${g.companyId}/ageing-buckets`, { buckets: [] });
  assert.deepEqual([write.status, write.body.code], [404, 'not_found']);

  await g.voucher('sales', '2026-03-01', [[p, 'Dr', '300', [newRef('B-2', '300')]], [sales, 'Cr', '300']]);
  await g.voucher('sales', '2026-03-02', [[p, 'Dr', '100', [newRef('A-1', '100')]], [sales, 'Cr', '100']]);
  await g.voucher('receipt', '2026-03-20', [[bank, 'Dr', '100'], [p, 'Cr', '100', [against('A-1', '100')]]]);
  const picker = async (query: string) => (await g.call(`/ledgers/${p}/bills?${query}`)).body.bills.map((bill: any) => [bill.name, bill.pending, bill.finalPending]);
  assert.deepEqual(await picker('asOf=2026-03-10'), [['B-2', '300.00', '300.00'], ['A-1', '100.00', '0.00']], 'pending at the date, final over all dates');
  assert.deepEqual(await picker('asOf=2026-03-31'), [['B-2', '300.00', '300.00']]);
  assert.deepEqual(await picker('asOf=2026-03-10&sort=name'), [['A-1', '100.00', '0.00'], ['B-2', '300.00', '300.00']]);
  assert.deepEqual(await picker('asOf=2026-03-10&sort=pending&direction=desc'), [['B-2', '300.00', '300.00'], ['A-1', '100.00', '0.00']]);
  assert.equal((await g.call(`/ledgers/${p}/bills?asOf=2026-03-10&extra=1`)).status, 400, 'unknown parameters are refused');

  for (const path of ['bills-outstanding?side=receivable&asOf=2026-03-31', 'ageing?side=receivable&asOf=2026-03-31', `party-bills/${p}?asOf=2026-03-31`]) {
    const exported = await raw(owner, `/api/companies/${g.companyId}/reports/${path.replace('?', '/export?')}`);
    assert.equal(exported.status, 200, path);
    assert.match(String(exported.headers.get('content-type')), /text\/csv/);
    assert.match(await exported.text(), /Total|Balance/);
  }
});

test('another workspace\'s user gets "not found" from every bill route and changes nothing', async () => {
  const g = await books('Private Bills');
  const sales = await g.ledger('Sales', 'sales'), p = await g.ledger('Party', 'receivables');
  const posted = await g.voucher('sales', '2026-03-01', [[p, 'Dr', '300', [newRef('P-1', '300')]], [sales, 'Cr', '300']]);
  const billId = posted.voucher.lines[0].bills[0].billId;
  const stranger = await setupStranger();
  const base = `/api/companies/${g.companyId}`;
  for (const path of [`/reports/bills-outstanding?side=receivable&asOf=2026-03-31`, `/reports/ageing?side=receivable&asOf=2026-03-31`,
    `/reports/party-bills/${p}?asOf=2026-03-31`, `/reports/bill/${billId}?asOf=2026-03-31`, `/reports/bills-outstanding/export?side=receivable&asOf=2026-03-31`,
    `/ledgers/${p}/bills?asOf=2026-03-31`, `/ledgers/${p}/credit-check?date=2026-03-31`, '/ageing-buckets']) {
    const read = await stranger.call(`${base}${path}`);
    assert.deepEqual([read.status, read.body?.code], [404, 'not_found'], path);
  }
  const write = await stranger.call(`${base}/ageing-buckets`, { buckets: [{ fromDays: 0, toDays: null }] });
  assert.deepEqual([write.status, write.body.code], [404, 'not_found']);
  assert.deepEqual((await g.call('/ageing-buckets')).body.buckets, [], 'nothing was written');
});

/** A GET through the API as `member`, answered as a raw response (CSV exports are not JSON). */
function raw(member: Member, path: string): Promise<Response> {
  const cookie = [...member.browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  return handleApi(new Request(new URL(path, getConfig().appUrl), { headers: { cookie } }));
}

/** A signed-in user of another workspace (their own company), who is not a member of the tested ones. */
async function setupStranger() {
  const stranger = (await invite(owner.browser, await createCompany(owner.browser), 'editor')).browser;
  return stranger;
}

test('a ledger left with only a bill that has no rows can be deleted; the bill goes with it', async () => {
  const g = await books('Leftover Bills');
  const sales = await g.ledger('Sales', 'sales'), from = await g.ledger('From Party', 'receivables'), to = await g.ledger('To Party', 'receivables');
  const invoice = (await g.voucher('sales', '2026-03-01', [[from, 'Dr', '10', [newRef('L-1', '10')]], [sales, 'Cr', '10']])).voucher;
  await g.alter(invoice, { lines: [{ ledgerId: to, side: 'Dr', amount: '10', bills: [newRef('L-1', '10')] }, { ledgerId: sales, side: 'Cr', amount: '10' }] });
  const left = (await g.call(`/ledgers/${from}`)).body.ledger;
  assert.equal(left.inUse, false, 'a bill without rows does not keep the ledger in use');
  const removed = await g.call(`/ledgers/${from}/delete`, { revision: left.revision });
  assert.deepEqual([removed.status, removed.body], [200, { deleted: true }]);
});

test('the API addresses a bill and a ledger of this company only', async () => {
  const g = await books('Scoped Bills');
  const sales = await g.ledger('Sales', 'sales'), p = await g.ledger('Party', 'receivables');
  const other = await books('Other Bills');
  const otherParty = await other.ledger('Party', 'receivables'), otherSales = await other.ledger('Sales', 'sales');
  const foreign = await other.voucher('sales', '2026-03-01', [[otherParty, 'Dr', '10', [newRef('F-1', '10')]], [otherSales, 'Cr', '10']]);
  const foreignBill = foreign.voucher.lines[0].bills[0].billId;
  const refused = await g.voucher('receipt', '2026-03-02', [[await g.ledger('Bank', 'bank_accounts'), 'Dr', '10'], [p, 'Cr', '10', [{ kind: 'against_ref', billId: foreignBill, amount: '10' }]]], {}, 400);
  assert.equal(refused.code, 'not_found', 'another company\'s bill does not exist here');
  assert.equal((await g.call(`/reports/bill/${foreignBill}?asOf=2026-03-31`)).status, 404);
  assert.equal((await g.call(`/reports/party-bills/${otherParty}?asOf=2026-03-31`)).status, 404);
  const own = await g.voucher('sales', '2026-03-01', [[p, 'Dr', '10', [newRef('G-1', '10')]], [sales, 'Cr', '10']]);
  const wrongLedger = await g.voucher('sales', '2026-03-02', [[await g.ledger('Party Two', 'receivables'), 'Dr', '10', [{ kind: 'against_ref', billId: own.voucher.lines[0].bills[0].billId, amount: '10' }]], [sales, 'Cr', '10']], {}, 400);
  assert.equal(wrongLedger.code, 'posting_rule', 'a bill of another ledger is refused');
});

