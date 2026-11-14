import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { PoolClient } from 'pg';
import { getDatabase } from '../src/server/db.ts';
import { alterLedger, readLedger } from '../src/server/ledger/masters.ts';
import { createVoucher } from '../src/server/ledger/vouchers.ts';
import { runLedger } from '../src/server/ledger/context.ts';
import { setCompanyScope } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, inCompany, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * Bill guards in the database (M2a slice 1): each case drives hand-written SQL as the application role (the path an
 * application bug would take) or two real postings racing, and checks the refusal and that nothing changed. The bypass
 * attempts that were tried against M1's guards are repeated against the new triggers.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let companyId = '', other = '';
let books: Chart;
const ids = { sales: '', bank: '', party: '', second: '', invoice: '', invoiceBill: '', receipt: '' };

const call = (path: string, body?: unknown) => owner.browser.call(`/api/companies/${companyId}${path}`, body);
async function post(kind: string, date: string, lines: unknown[], extra: Record<string, unknown> = {}) {
  const posted = await call('/vouchers', { idempotencyKey: `guards-${randomUUID()}`, voucherTypeId: books.type(kind), date, lines, ...extra });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  return posted.body.voucher;
}
const sale = (name: string, amount = '100', party = ids.party) => ({
  idempotencyKey: `race-${randomUUID()}`, voucherTypeId: books.type('sales'), date: '2026-03-10',
  lines: [{ ledgerId: party, side: 'Dr', amount, bills: [{ kind: 'new_ref', name, amount }] }, { ledgerId: ids.sales, side: 'Cr', amount }],
});

before(async () => {
  database = await freshDatabase('bills_guards');
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, { name: 'Guarded Bills' });
  other = await createCompany(owner.browser, { name: 'Neighbour Bills' });
  books = await chart(owner.browser, companyId);
  const ledger = async (name: string, group: string) => (await call('/ledgers', { name, groupId: books.group(group) })).body.ledger.id as string;
  ids.sales = await ledger('Sales', 'sales');
  ids.bank = await ledger('Bank', 'bank_accounts');
  ids.party = await ledger('Party', 'receivables');
  ids.second = await ledger('Second Party', 'receivables');
  const invoice = await post('sales', '2026-03-01', sale('B-1').lines);
  ids.invoice = invoice.id;
  ids.invoiceBill = invoice.lines[0].bills[0].billId;
  ids.receipt = (await post('receipt', '2026-03-02', [{ ledgerId: ids.bank, side: 'Dr', amount: '40' },
    { ledgerId: ids.party, side: 'Cr', amount: '40', bills: [{ kind: 'against_ref', name: 'B-1', amount: '40' }] }])).id;
});
after(async () => { await database?.drop(); });

const code = (expected: string, constraint?: string) => (error: unknown) => {
  const { code: actual, constraint: name } = error as { code?: string; constraint?: string };
  return actual === expected && (constraint === undefined || name === constraint);
};
/** One raw transaction as the application role, scoped to `scope`; rolled back on any error. */
async function asApp(run: (client: PoolClient) => Promise<unknown>, scope: string[] = [companyId]): Promise<void> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await setCompanyScope(client, scope);
    await run(client);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}
const count = async (sql: string, values: unknown[]) => Number((await asAdmin(database.adminUrl, admin => admin.query(sql, values))).rows[0].count);
const billRows = () => count('SELECT count(*) FROM bill_allocation WHERE company_id = $1', [companyId]);
const bills = () => count('SELECT count(*) FROM bill WHERE company_id = $1', [companyId]);
const insertRow = (client: PoolClient, row: Record<string, unknown>) => {
  const values = { company_id: companyId, ledger_id: ids.party, voucher_id: ids.invoice, line_no: 1, kind: 'against_ref', bill_id: ids.invoiceBill,
    currency: 'AED', side: 'Cr', amount: 1, currency_amount: 1, ...row };
  const keys = Object.keys(values);
  return client.query(`INSERT INTO bill_allocation (${keys.join(', ')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(', ')})`, Object.values(values));
};

test('the per-voucher check runs again after SET CONSTRAINTS ALL IMMEDIATE, for lines (M1\'s rule) and for bill rows', async () => {
  const lines = await count('SELECT count(*) FROM voucher_line WHERE voucher_id = $1', [ids.invoice]);
  await assert.rejects(asApp(async client => {
    await client.query('UPDATE voucher SET narration = narration WHERE company_id = $1 AND id = $2', [companyId, ids.invoice]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('DELETE FROM voucher_line WHERE company_id = $1 AND voucher_id = $2 AND line_no = 2', [companyId, ids.invoice]);
  }), code('23514', 'voucher_balanced'));
  await assert.rejects(asApp(async client => {
    await client.query('UPDATE voucher SET narration = narration WHERE company_id = $1 AND id = $2', [companyId, ids.invoice]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await insertRow(client, { kind: 'on_account', bill_id: null, side: 'Dr', amount: 1, currency_amount: 1 });
  }), code('23514', 'bill_allocation_total'));
  // The reviewed bypass: deleting one line of a 100/60/40 voucher and then setting a "checked" mark for the voucher in
  // this transaction. No session setting skips the check any more.
  const split = await post('journal', '2026-03-03', [{ ledgerId: ids.party, side: 'Dr', amount: '100' },
    { ledgerId: ids.sales, side: 'Cr', amount: '60' }, { ledgerId: ids.second, side: 'Cr', amount: '40' }]);
  await assert.rejects(asApp(async client => {
    await client.query('DELETE FROM voucher_line WHERE company_id = $1 AND voucher_id = $2 AND line_no = 3', [companyId, split.id]);
    await client.query("SELECT set_config('app.voucher_checked', pg_current_xact_id()::text || ':' || $1, true)", [split.id]);
  }), code('23514', 'voucher_balanced'));
  assert.equal(await count('SELECT count(*) FROM voucher_line WHERE voucher_id = $1', [split.id]), 3);
  assert.equal(await count('SELECT count(*) FROM voucher_line WHERE voucher_id = $1', [ids.invoice]), lines);
});

test('bill rows are checked at commit and cannot be hidden by clearing or changing the company scope', async () => {
  const rows = await billRows();
  for (const scope of ['', other]) {
    await assert.rejects(asApp(async client => {
      await insertRow(client, { kind: 'on_account', bill_id: null, side: 'Dr' });
      await client.query("SELECT set_config('app.company_ids', $1, true)", [scope]);
    }), code('42501', 'ledger_company_scope'), `scope "${scope}" at commit`);
  }
  // Amounts are minor units: the invoice line is 10000 (100.00), already fully allocated to B-1.
  await assert.rejects(asApp(client => insertRow(client, { kind: 'on_account', bill_id: null, side: 'Dr' })), code('23514', 'bill_allocation_total'));
  assert.equal(await billRows(), rows);
});

test('bills and bill rows keep their keys, shapes and families; nothing is updated in place or bypassed by the role', async () => {
  const rows = await billRows(), count0 = await bills();
  const cases: [string, (client: PoolClient) => Promise<unknown>, (error: unknown) => boolean][] = [
    ['a row naming a bill of another ledger', client => insertRow(client, { ledger_id: ids.second, voucher_id: null, line_no: null, kind: 'new_ref', side: 'Dr', bill_date: '2025-12-31', due_date: '2025-12-31' }), code('23503')],
    ['a row on a line of another ledger', client => insertRow(client, { ledger_id: ids.second }), code('23514', 'bill_allocation_line')],
    ['a row in another currency than its line', client => insertRow(client, { currency: 'USD' }), code('23514', 'bill_allocation_line')],
    ['a row whose amounts differ', client => insertRow(client, { amount: 2, currency_amount: 1 }), code('23514', 'bill_allocation_base_currency_only')],
    ['terms on an on-account row', client => insertRow(client, { kind: 'on_account', bill_id: null, due_date: '2026-04-01' }), code('23514', 'bill_allocation_terms')],
    ['a due date that does not follow the credit period', client => insertRow(client, { kind: 'new_ref', side: 'Dr', due_date: '2026-03-02', credit_count: 30, credit_unit: 'day' }), code('23514', 'bill_allocation_terms')],
    ['a bill without rows', client => client.query('INSERT INTO bill (company_id, ledger_id, name, currency) VALUES ($1, $2, $3, $4)', [companyId, ids.party, 'EMPTY', 'AED']), code('23514', 'bill_used')],
    ['a second bill differing only by case', client => client.query('INSERT INTO bill (company_id, ledger_id, name, currency) VALUES ($1, $2, $3, $4)', [companyId, ids.party, 'b-1', 'AED']), code('23505', 'bill_identity_idx')],
    ['a bill in another currency', client => client.query('INSERT INTO bill (company_id, ledger_id, name, currency) VALUES ($1, $2, $3, $4)', [companyId, ids.party, 'USD-1', 'USD']), code('23514', 'bill_base_currency_only')],
    ['a bill whose name has no key', client => client.query('INSERT INTO bill (company_id, ledger_id, name, currency) VALUES ($1, $2, $3, $4)', [companyId, ids.party, '-/-', 'AED']), code('23514', 'bill_name_key')],
    ['a bill with an untrimmed name', client => client.query('INSERT INTO bill (company_id, ledger_id, name, currency) VALUES ($1, $2, $3, $4)', [companyId, ids.party, ' X ', 'AED']), code('23514')],
    ['a bill on the bank ledger', async client => {
      const { rows: [bill] } = await client.query('INSERT INTO bill (company_id, ledger_id, name, currency) VALUES ($1, $2, $3, $4) RETURNING id', [companyId, ids.bank, 'BANK', 'AED']);
      const receiptLine = await client.query('SELECT line_no FROM voucher_line WHERE company_id = $1 AND voucher_id = $2 AND ledger_id = $3', [companyId, ids.receipt, ids.bank]);
      await insertRow(client, { ledger_id: ids.bank, voucher_id: ids.receipt, line_no: receiptLine.rows[0].line_no, kind: 'new_ref', bill_id: bill.id, side: 'Dr', due_date: '2026-03-02' });
    }, code('23514', 'ledger_bill_wise_family')],
    ['renaming a bill', client => client.query('UPDATE bill SET name = $3 WHERE company_id = $1 AND id = $2', [companyId, ids.invoiceBill, 'B-9']), code('42501')],
    ['deleting a bill that has rows', client => client.query('DELETE FROM bill WHERE company_id = $1 AND id = $2', [companyId, ids.invoiceBill]), code('23503')],
    ['changing a bill row', client => client.query('UPDATE bill_allocation SET amount = 1 WHERE company_id = $1', [companyId]), code('42501')],
    ['switching the guards off', client => client.query('ALTER TABLE bill_allocation DISABLE TRIGGER USER'), code('42501')],
    ['replica mode', client => client.query("SET session_replication_role = 'replica'"), code('42501')],
    ['an ageing column of another company', client => client.query('INSERT INTO ageing_bucket (company_id, position, from_days) VALUES ($1, 1, 0)', [other]), code('42501')],
    ['a bill-wise bank ledger', client => client.query('UPDATE ledger SET bill_wise = true WHERE company_id = $1 AND id = $2', [companyId, ids.bank]), code('23514', 'ledger_bill_wise_family')],
    ['a ledger with bills moved under the bank group', client => client.query('UPDATE ledger SET bill_wise = false, group_id = $3 WHERE company_id = $1 AND id = $2', [companyId, ids.party, books.group('bank_accounts')]), code('23514', 'ledger_bill_wise_family')],
    ['a group holding bill-wise ledgers moved under the bank group', client => client.query('UPDATE account_group SET parent_id = $3 WHERE company_id = $1 AND id = $2', [companyId, books.group('receivables'), books.group('bank_accounts')]), code('23514', 'ledger_bill_wise_family')],
  ];
  for (const [name, run, expected] of cases) await assert.rejects(asApp(run), expected, name);
  assert.deepEqual([await billRows(), await bills()], [rows, count0]);
});

test('bill rows of a cancelled voucher are frozen; opening rows follow the opening balance', async () => {
  const cancelled = await post('sales', '2026-03-05', sale('C-1').lines);
  assert.equal((await call(`/vouchers/${cancelled.id}/cancel`, { revision: cancelled.revision })).status, 200);
  await assert.rejects(asApp(client => client.query('DELETE FROM bill_allocation WHERE company_id = $1 AND voucher_id = $2', [companyId, cancelled.id])), code('23514', 'voucher_lines_frozen'));

  const opening = (await call('/ledgers', { name: 'Opening Party', groupId: books.group('receivables'),
    opening: { amount: '100', side: 'Dr', bills: [{ name: 'OB-1', amount: '10' }] } })).body.ledger.id as string;
  const openingBill = (await asAdmin(database.adminUrl, admin => admin.query('SELECT id FROM bill WHERE ledger_id = $1', [opening]))).rows[0].id;
  const openingRow = (row: Record<string, unknown>) => (client: PoolClient) => insertRow(client, { ledger_id: opening, voucher_id: null, line_no: null, bill_id: openingBill,
    kind: 'new_ref', bill_date: '2025-12-31', due_date: '2025-12-31', side: 'Dr', amount: 4000, currency_amount: 4000, ...row });
  await assert.rejects(asApp(openingRow({ amount: 15000, currency_amount: 15000 })), code('23514', 'bill_allocation_opening_total'));
  await assert.rejects(asApp(openingRow({ side: 'Cr' })), code('23514', 'bill_allocation_opening_total'), 'opening bills are on the opening side');
  await assert.rejects(asApp(openingRow({ kind: 'on_account', bill_id: null, due_date: null })), code('23514', 'bill_allocation_opening_shape'), 'opening rows are new bills only');
  await assert.rejects(asApp(openingRow({ bill_date: '2026-01-02' })), code('23514', 'bill_allocation_opening_date'));
  await asApp(openingRow({}));
  await assert.rejects(asApp(client => client.query('UPDATE ledger SET opening_amount = 4000 WHERE company_id = $1 AND id = $2', [companyId, opening])), code('23514', 'bill_allocation_opening_total'));
  await asAdmin(database.adminUrl, admin => admin.query("UPDATE company SET locked_through = '2026-01-31' WHERE company_id = $1", [companyId]));
  try {
    await assert.rejects(asApp(openingRow({ amount: 1000, currency_amount: 1000 })), code('23514', 'bill_allocation_opening_locked'));
    await assert.rejects(asApp(client => client.query('DELETE FROM bill_allocation WHERE company_id = $1 AND ledger_id = $2', [companyId, opening])), code('23514', 'bill_allocation_opening_locked'));
  } finally {
    await asAdmin(database.adminUrl, admin => admin.query('UPDATE company SET locked_through = NULL WHERE company_id = $1', [companyId]));
  }
});

const gate = () => { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; };
/** Whether `promise` is still waiting after a moment (a lock wait), or has settled. */
const state = (promise: Promise<unknown>) => Promise.race([promise.then(() => 'settled', () => 'settled'), new Promise(resolve => setTimeout(() => resolve('waiting'), 400))]);
const billsNamed = (name: string) => count('SELECT count(*) FROM bill WHERE company_id = $1 AND lower(name) = lower($2)', [companyId, name]);
const rowsNamed = (name: string) => count('SELECT count(*) FROM bill_allocation a JOIN bill b ON b.company_id = a.company_id AND b.id = a.bill_id WHERE a.company_id = $1 AND lower(b.name) = lower($2)', [companyId, name]);

for (const outcome of ['commits', 'rolls back'] as const) {
  test(`two postings creating one new name for one party end with one bill: the first ${outcome}, the second waits and then attaches or creates`, async () => {
    const name = `R-${randomUUID().slice(0, 6)}`;
    const hold = gate(), started = gate();
    const first = inCompany(owner.userId, companyId, async context => {
      await createVoucher(context, sale(name, '100'));
      started.open();
      await hold.promise;
      if (outcome === 'rolls back') throw new Error('first posting rolled back');
    }, 'write');
    await started.promise;
    const second = inCompany(owner.userId, companyId, context => createVoucher(context, sale(name.toLowerCase(), '50')), 'write');
    assert.equal(await state(second), 'waiting', 'the second waits on the first one\'s new bill');
    hold.open();
    if (outcome === 'commits') await first; else await assert.rejects(first, /rolled back/);
    const result = await second;
    assert.deepEqual(result.warnings.map(item => item.code), outcome === 'commits' ? ['bill_attached'] : []);
    assert.deepEqual([await billsNamed(name), await rowsNamed(name)], [1, outcome === 'commits' ? 2 : 1]);
  });
}

for (const order of ['posting first', 'flag change first'] as const) {
  test(`switching bill-wise off and posting a bill row serialise (${order})`, async () => {
    const party = (await call('/ledgers', { name: `Racing ${order}`, groupId: books.group('receivables') })).body.ledger.id as string;
    const name = `F-${randomUUID().slice(0, 6)}`;
    const hold = gate(), started = gate();
    const off = async () => inCompany(owner.userId, companyId, async context => {
      const ledger = await readLedger(context, party);
      await alterLedger(context, party, { name: ledger.name, groupId: ledger.groupId, billWise: false, revision: ledger.revision });
      if (order === 'flag change first') { started.open(); await hold.promise; }
    }, 'write');
    const posting = async () => inCompany(owner.userId, companyId, async context => {
      const result = await createVoucher(context, sale(name, '30', party));
      if (order === 'posting first') { started.open(); await hold.promise; }
      return result;
    }, 'write');
    const first = order === 'posting first' ? posting() : off();
    await started.promise;
    const second = order === 'posting first' ? off() : posting();
    assert.equal(await state(second), 'waiting', 'the second waits for the first to commit');
    hold.open();
    const [a, b] = await Promise.all([first, second]);
    const result = (order === 'posting first' ? a : b) as Awaited<ReturnType<typeof createVoucher>>;
    if (order === 'posting first') {
      assert.deepEqual([result.warnings, await rowsNamed(name)], [[], 1], 'the row was posted while the ledger was bill-wise and stays');
    } else {
      assert.deepEqual([result.warnings.map(item => item.code), await rowsNamed(name)], [['bills_ignored'], 0], 'the posting saw the flag off');
    }
  });
}

test('the bill named after a voucher number can deadlock with a posting naming it explicitly; the loser answers retry', async () => {
  const { rows: [counter] } = await asAdmin(database.adminUrl, admin => admin.query(
    'SELECT c.last_number FROM voucher_counter c WHERE c.company_id = $1 AND c.voucher_type_id = $2', [companyId, books.type('sales')]));
  const next = String(Number(counter.last_number) + 1);
  // The other side does what a sales posting that names its bill "next" does: its bill first, then the sales counter.
  const client = await getDatabase().pool.connect();
  let rawError: unknown = null;
  try {
    await client.query('BEGIN');
    await setCompanyScope(client, [companyId]);
    await client.query('INSERT INTO bill (company_id, ledger_id, name, currency) VALUES ($1, $2, $3, $4)', [companyId, ids.party, next, 'AED']);
    const unnamed = sale('unused');
    unnamed.lines[0].bills = [{ kind: 'new_ref', amount: '100' } as never];
    const api = runLedger(owner.userId, companyId, 'write', context => createVoucher(context, unnamed)).then(value => ({ value }), error => ({ error }));
    assert.equal(await state(api), 'waiting', 'the automatic name waits on the other side\'s bill, holding the counter');
    await client.query('UPDATE voucher_counter SET last_number = last_number + 1 WHERE company_id = $1 AND voucher_type_id = $2', [companyId, books.type('sales')])
      .catch(error => { rawError = error; });
    const outcome = await api as { value?: unknown; error?: { status?: number; code?: string } };
    if (outcome.error) assert.deepEqual([outcome.error.status, outcome.error.code], [409, 'retry'], 'the posting lost: retry, not a server error');
    else assert.ok(code('40P01')(rawError), 'the other side lost the deadlock instead');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});
