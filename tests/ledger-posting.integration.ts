import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { getDatabase } from '../src/server/db.ts';
import { trialBalance } from '../src/server/ledger/reports.ts';
import { setCompanyScope, withCompany } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { addLedger, asAdmin, chart, createCompany, inCompany, post, setupOwner, voucherBody, type Chart, type Line, type Member } from './helpers/ledger.ts';

let database: TestDatabase;
let owner: Member & { workspaceId: string };
let companyId = '';
let books: Chart;
const ids = { bank: '', capital: '', rent: '', sales: '', customer: '' };

before(async () => {
  database = await freshDatabase('ledger_posting');
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, { name: 'Rules Trading' });
  books = await chart(owner.browser, companyId);
  ids.bank = await addLedger(owner.browser, companyId, 'Main Bank', books.group('bank_accounts'), { amount: '5000', side: 'Dr' });
  ids.capital = await addLedger(owner.browser, companyId, 'Capital Account', books.group('capital'), { amount: '5000', side: 'Cr' });
  ids.rent = await addLedger(owner.browser, companyId, 'Rent', books.group('indirect_expenses'));
  ids.sales = await addLedger(owner.browser, companyId, 'Sales Income', books.group('sales'));
  ids.customer = await addLedger(owner.browser, companyId, 'A Customer', books.group('receivables'));
});
after(async () => { await database?.drop(); });

const vouchers = `/api/companies/${'{company}'}/vouchers`;
const url = (path = '') => vouchers.replace('{company}', companyId) + path;
const attempt = (kind: string, date: string, lines: Line[], extra: Record<string, unknown> = {}) => owner.browser.call(url(), voucherBody(books.type(kind), date, lines, extra));
const closing = async (ledgerId: string, to = '2026-12-31', from = '2026-01-01') => {
  const row = (await inCompany(owner.userId, companyId, context => trialBalance(context, from, to))).rows.find(item => item.ledgerId === ledgerId)!;
  return row.closingDebit - row.closingCredit;
};
const voucherCount = async () => Number((await asAdmin(database.adminUrl, admin => admin.query('SELECT count(*) FROM voucher WHERE company_id = $1', [companyId]))).rows[0].count);

test('posting rules refuse bad vouchers with plain-language messages and write nothing', async () => {
  const cash = books.ledger('Cash');
  const foreign = await createCompany(owner.browser, { name: 'Other Books' });
  const foreignCash = (await chart(owner.browser, foreign)).ledger('Cash');
  const cases: [string, Promise<{ status: number; body: any }>, number, RegExp][] = [
    ['unbalanced', attempt('payment', '2026-02-01', [[ids.rent, 'Dr', '100'], [cash, 'Cr', '90']]), 400, /Debits \(100\.00\) and credits \(90\.00\) must be equal/],
    ['single line', attempt('journal', '2026-02-01', [[ids.rent, 'Dr', '100']]), 400, /at least two lines/],
    ['zero amount', attempt('payment', '2026-02-01', [[ids.rent, 'Dr', '0'], [cash, 'Cr', '0']]), 400, /line 1 must be more than zero/],
    ['negative amount', attempt('payment', '2026-02-01', [[ids.rent, 'Dr', '100'], [cash, 'Cr', '-100'], [cash, 'Cr', '200']]), 400, /line 2 must be more than zero/],
    ['out of range', attempt('payment', '2026-02-01', [[ids.rent, 'Dr', '99999999999999999.99'], [cash, 'Cr', '99999999999999999.99']]), 400, /line 1 is too large/],
    ['total out of range', attempt('payment', '2026-02-01', [[ids.rent, 'Dr', '90000000000000000'], [ids.rent, 'Dr', '90000000000000000'], [cash, 'Cr', '1']]), 400, /total is too large/],
    ['too many decimals', attempt('payment', '2026-02-01', [[ids.rent, 'Dr', '1.005'], [cash, 'Cr', '1.005']]), 400, /at most 2 decimal places/],
    ['not a number', attempt('payment', '2026-02-01', [[ids.rent, 'Dr', '1,000'], [cash, 'Cr', '1000']]), 400, /Check the amount on line 1/],
    ['wrong ledger', attempt('payment', '2026-02-01', [[ids.rent, 'Dr', '100'], [foreignCash, 'Cr', '100']]), 400, /ledger on line 2 was not found in this company/],
    ['before books beginning', attempt('payment', '2025-12-31', [[ids.rent, 'Dr', '100'], [cash, 'Cr', '100']]), 400, /before the books begin on 2026-01-01/],
    ['contra with another ledger', attempt('contra', '2026-02-01', [[ids.bank, 'Dr', '100'], [ids.rent, 'Cr', '100']]), 400, /contra voucher moves money between cash and bank/],
    ['payment without cash or bank credit', attempt('payment', '2026-02-01', [[ids.rent, 'Dr', '100'], [ids.capital, 'Cr', '100']]), 400, /payment must credit at least one cash or bank/],
    ['payment debiting cash', attempt('payment', '2026-02-01', [[cash, 'Dr', '100'], [ids.bank, 'Cr', '100']]), 400, /payment cannot debit a cash or bank ledger \(line 1\)/],
    ['receipt without cash or bank debit', attempt('receipt', '2026-02-01', [[ids.rent, 'Dr', '100'], [ids.sales, 'Cr', '100']]), 400, /receipt must debit at least one cash or bank/],
    ['journal touching bank', attempt('journal', '2026-02-01', [[ids.rent, 'Dr', '100'], [ids.bank, 'Cr', '100']]), 400, /journal cannot use a cash or bank ledger \(line 2\)/],
    ['unknown voucher type', owner.browser.call(url(), voucherBody(randomUUID(), '2026-02-01', [[ids.rent, 'Dr', '1'], [cash, 'Cr', '1']])), 400, /voucher type was not found/],
  ];
  for (const [name, response, status, message] of cases) {
    const { status: actual, body } = await response;
    assert.equal(actual, status, `${name}: ${JSON.stringify(body)}`);
    assert.match(body.error, message, name);
  }
  assert.equal(await voucherCount(), 0, 'no refused voucher was written');
});

test('the database itself refuses an unbalanced or single-line voucher and a changed number', async () => {
  const cash = books.ledger('Cash');
  const valid = await post(owner.browser, companyId, books.type('payment'), '2026-01-10', [[ids.rent, 'Dr', '10'], [cash, 'Cr', '10']]);
  const asApp = async (statements: (client: import('pg').PoolClient) => Promise<unknown>) => {
    const client = await getDatabase().pool.connect();
    try {
      await client.query('BEGIN');
      await setCompanyScope(client, [companyId]);
      await statements(client);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  };
  const voucherType = books.type('journal');
  // Optional, so no number is needed: the only thing left to refuse is the balance itself.
  const insertHeader = (client: import('pg').PoolClient) => client.query<{ id: string }>(
    `INSERT INTO voucher (company_id, voucher_type_id, series, status, date, idempotency_key, request_hash, created_by)
     VALUES ($1, $2, 'main', 'optional', '2026-01-11', $3, repeat('a', 64), $4) RETURNING id`, [companyId, voucherType, `sql-${randomUUID()}`, owner.userId]);
  const line = (client: import('pg').PoolClient, voucherId: string, lineNo: number, ledgerId: string, side: string, amount: number) => client.query(
    `INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate) VALUES ($1, $2, $3, $4, $5, $6, 'AED', $6, 1)`,
    [companyId, voucherId, lineNo, ledgerId, side, amount]);
  const balanceRefusal = (error: unknown) => (error as { code?: string; constraint?: string }).code === '23514' && (error as { constraint?: string }).constraint === 'voucher_balanced';
  await assert.rejects(asApp(async client => {
    const { rows } = await insertHeader(client);
    await line(client, rows[0].id, 1, ids.rent, 'Dr', 100);
    await line(client, rows[0].id, 2, ids.capital, 'Cr', 99);
  }), balanceRefusal, 'debits must equal credits at commit');
  await assert.rejects(asApp(async client => {
    const { rows } = await insertHeader(client);
    await line(client, rows[0].id, 1, ids.rent, 'Dr', 100);
  }), balanceRefusal, 'one line is never a voucher');
  await assert.rejects(asApp(client => client.query('DELETE FROM voucher_line WHERE company_id = $1 AND voucher_id = $2 AND line_no = 2', [companyId, valid.id])), balanceRefusal);
  await assert.rejects(asApp(client => client.query('UPDATE voucher SET number = 77 WHERE company_id = $1 AND id = $2', [companyId, valid.id])), /voucher number cannot change/);
  await assert.rejects(asApp(client => client.query('UPDATE voucher SET series = $3 WHERE company_id = $1 AND id = $2', [companyId, valid.id, 'other'])),
    (error: unknown) => (error as { code?: string }).code === '42501', 'the series is not writable by the application role');
  await assert.rejects(asApp(client => client.query('DELETE FROM voucher WHERE company_id = $1', [companyId])), (error: unknown) => (error as { code?: string }).code === '42501', 'vouchers are never hard-deleted');
  await assert.rejects(asApp(client => line(client, valid.id, 3, ids.rent, 'Dr', 0)), (error: unknown) => (error as { code?: string }).code === '23514', 'amounts are positive');
  const lines = await asAdmin(database.adminUrl, admin => admin.query('SELECT count(*) FROM voucher_line WHERE company_id = $1 AND voucher_id = $2', [companyId, valid.id]));
  assert.equal(Number(lines.rows[0].count), 2);
});

test('numbers are gapless under 50 concurrent posts and never reused or renumbered after delete, alter or a back-dated entry', async () => {
  const cash = books.ledger('Cash');
  const type = books.type('receipt');
  const posted = await Promise.all(Array.from({ length: 50 }, (_, index) =>
    owner.browser.call(url(), voucherBody(type, '2026-03-01', [[ids.sales, 'Cr', String(index + 1)], [cash, 'Dr', String(index + 1)]]))));
  assert.ok(posted.every(response => response.status === 201), JSON.stringify(posted.find(response => response.status !== 201)?.body));
  const numbers = posted.map(response => response.body.voucher.number as number).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: 50 }, (_, index) => index + 1), 'one to fifty, no duplicates, no gaps');

  const highest = posted.find(response => response.body.voucher.number === 50)!.body.voucher;
  assert.equal((await owner.browser.call(url(`/${highest.id}/delete`), { revision: highest.revision })).status, 200);
  const afterDelete = await post(owner.browser, companyId, type, '2026-03-02', [[ids.sales, 'Cr', '5'], [cash, 'Dr', '5']]);
  assert.equal(afterDelete.number, 51, 'the deleted number stays a gap');

  const altered = await owner.browser.call(url(`/${afterDelete.id}`), { date: '2026-01-15', narration: null, status: 'regular', postDated: false, revision: afterDelete.revision, lines: [{ ledgerId: ids.sales, side: 'Cr', amount: '6' }, { ledgerId: cash, side: 'Dr', amount: '6' }] });
  assert.equal(altered.status, 200, JSON.stringify(altered.body));
  assert.deepEqual([altered.body.voucher.number, altered.body.voucher.date, altered.body.voucher.total, altered.body.voucher.revision], [51, '2026-01-15', '6.00', 2], 'an altered voucher keeps its number when its date moves');

  const backDated = await post(owner.browser, companyId, type, '2026-01-02', [[ids.sales, 'Cr', '7'], [cash, 'Dr', '7']]);
  assert.equal(backDated.number, 52, 'an earlier date takes the next free number; nothing is renumbered');
  const stored = await asAdmin(database.adminUrl, admin => admin.query<{ number: number }>(`SELECT number FROM voucher WHERE company_id = $1 AND voucher_type_id = $2 ORDER BY number`, [companyId, type]));
  assert.deepEqual(stored.rows.map(row => row.number), Array.from({ length: 52 }, (_, index) => index + 1), 'the deleted voucher keeps its row and number');
});

test('cancelled and optional vouchers have no accounting effect; a post-dated voucher counts from its date', async () => {
  const cash = books.ledger('Cash');
  const type = books.type('payment');
  const rentBefore = await closing(ids.rent);
  const cancelled = await post(owner.browser, companyId, type, '2026-04-01', [[ids.rent, 'Dr', '300'], [cash, 'Cr', '300']]);
  assert.equal(await closing(ids.rent), rentBefore + 30000n);
  const cancel = await owner.browser.call(url(`/${cancelled.id}/cancel`), { revision: cancelled.revision });
  assert.equal(cancel.status, 200);
  assert.deepEqual([cancel.body.voucher.status, cancel.body.voucher.number, cancel.body.voucher.lines.length], ['cancelled', cancelled.number, 2], 'it keeps its number and row');
  assert.equal(await closing(ids.rent), rentBefore, 'a cancelled voucher has no effect');
  assert.equal((await owner.browser.call(url(`/${cancelled.id}`), { date: '2026-04-02', narration: null, status: 'regular', postDated: false, revision: cancel.body.voucher.revision, lines: [] })).status, 409, 'and cannot be altered');

  const optional = await post(owner.browser, companyId, type, '2026-04-03', [[ids.rent, 'Dr', '50'], [cash, 'Cr', '50']], { status: 'optional' });
  assert.deepEqual([optional.status, optional.number], ['optional', null], 'an optional voucher takes no number');
  assert.equal(await closing(ids.rent), rentBefore, 'and stays out of the books');
  const next = await post(owner.browser, companyId, type, '2026-04-04', [[ids.rent, 'Dr', '1'], [cash, 'Cr', '1']]);
  assert.equal(next.number, cancelled.number + 1, 'the next regular voucher is not affected by the optional one');
  const regular = await owner.browser.call(url(`/${optional.id}`), { date: '2026-04-03', narration: null, status: 'regular', postDated: false, revision: optional.revision, lines: optional.lines.map((line: { ledgerId: string; side: string; amount: string }) => ({ ledgerId: line.ledgerId, side: line.side, amount: line.amount })) });
  assert.equal(regular.status, 200, JSON.stringify(regular.body));
  assert.deepEqual([regular.body.voucher.status, regular.body.voucher.number], ['regular', next.number + 1], 'made regular, it takes the next number then');
  assert.equal(await closing(ids.rent), rentBefore + 5100n);
  const backToOptional = await owner.browser.call(url(`/${optional.id}`), { date: '2026-04-03', narration: null, status: 'optional', postDated: false, revision: regular.body.voucher.revision, lines: optional.lines.map((line: { ledgerId: string; side: string; amount: string }) => ({ ledgerId: line.ledgerId, side: line.side, amount: line.amount })) });
  assert.equal(backToOptional.status, 409);

  const postDated = await post(owner.browser, companyId, type, '2026-05-20', [[ids.rent, 'Dr', '700'], [ids.bank, 'Cr', '700']], { postDated: true });
  assert.ok(postDated.number > 0 && postDated.postDated, 'a post-dated voucher is numbered');
  assert.equal(await closing(ids.rent, '2026-05-19'), rentBefore + 5100n, 'not counted before its date');
  assert.equal(await closing(ids.rent, '2026-05-20'), rentBefore + 75100n, 'counted from its date');
});

test('an idempotency key returns the first result for the same body and refuses a different one', async () => {
  const cash = books.ledger('Cash');
  const body = voucherBody(books.type('receipt'), '2026-06-01', [[ids.sales, 'Cr', '42'], [cash, 'Dr', '42']], { narration: 'Retried' });
  const before = await voucherCount();
  const [first, second] = await Promise.all([owner.browser.call(url(), body), owner.browser.call(url(), body)]);
  assert.deepEqual([first.status, second.status].sort(), [200, 201], 'one posts, the concurrent retry waits and replays');
  assert.equal(first.body.voucher.id, second.body.voucher.id);
  const third = await owner.browser.call(url(), body);
  assert.deepEqual([third.status, third.body.replayed, third.body.voucher.id], [200, true, first.body.voucher.id]);
  const different = await owner.browser.call(url(), { ...body, narration: 'Something else' });
  assert.equal(different.status, 409);
  assert.match(different.body.error, /already used for a different voucher/);
  assert.equal(await voucherCount(), before + 1);
});

test('a stale revision is refused for vouchers and masters', async () => {
  const cash = books.ledger('Cash');
  const voucher = await post(owner.browser, companyId, books.type('payment'), '2026-06-02', [[ids.rent, 'Dr', '5'], [cash, 'Cr', '5']]);
  const change = { date: '2026-06-03', narration: null, status: 'regular', postDated: false, revision: voucher.revision, lines: [{ ledgerId: ids.rent, side: 'Dr', amount: '6' }, { ledgerId: cash, side: 'Cr', amount: '6' }] };
  assert.equal((await owner.browser.call(url(`/${voucher.id}`), change)).status, 200);
  const stale = await owner.browser.call(url(`/${voucher.id}`), change);
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed by someone else/);
  const ledger = (await owner.browser.call(`/api/companies/${companyId}/ledgers/${ids.rent}`)).body.ledger;
  assert.equal((await owner.browser.call(`/api/companies/${companyId}/ledgers/${ids.rent}`, { name: 'Office Rent', groupId: ledger.groupId, revision: ledger.revision })).status, 200);
  assert.equal((await owner.browser.call(`/api/companies/${companyId}/ledgers/${ids.rent}`, { name: 'Rent Again', groupId: ledger.groupId, revision: ledger.revision })).status, 409);
});

test('every change writes a complete revision log entry that the application role cannot change', async () => {
  const cash = books.ledger('Cash');
  const voucher = await post(owner.browser, companyId, books.type('payment'), '2026-07-01', [[ids.rent, 'Dr', '12.34'], [cash, 'Cr', '12.34']], { narration: 'Logged' });
  const altered = (await owner.browser.call(url(`/${voucher.id}`), { date: '2026-07-02', narration: 'Logged again', status: 'regular', postDated: false, revision: 1, lines: [{ ledgerId: ids.rent, side: 'Dr', amount: '20' }, { ledgerId: cash, side: 'Cr', amount: '20' }] })).body.voucher;
  const cancelled = (await owner.browser.call(url(`/${voucher.id}/cancel`), { revision: altered.revision })).body.voucher;
  assert.equal((await owner.browser.call(url(`/${voucher.id}/delete`), { revision: cancelled.revision })).status, 200);
  const history = (await owner.browser.call(url(`/${voucher.id}/revisions`))).body.revisions;
  assert.deepEqual(history.map((entry: { action: string }) => entry.action), ['create', 'alter', 'cancel', 'delete']);
  assert.ok(history.every((entry: { actorId: string; at: string }) => entry.actorId === owner.userId && !Number.isNaN(Date.parse(entry.at))));
  assert.equal(history[0].before, null);
  assert.deepEqual([history[0].after.number, history[0].after.lines[0].amount, history[0].after.narration], [voucher.number, '1234', 'Logged'], 'amounts are exact minor units');
  assert.deepEqual([history[1].before.date, history[1].after.date, history[1].after.lines[0].amount], ['2026-07-01', '2026-07-02', '2000']);
  assert.deepEqual([history[2].before.status, history[2].after.status], ['regular', 'cancelled']);
  assert.deepEqual([history[3].before.deleted, history[3].after.deleted], [false, true]);
  assert.equal((await owner.browser.call(url(`/${voucher.id}`))).body.voucher.deleted, true, 'a deleted voucher stays readable by id');

  const group = (await owner.browser.call(`/api/companies/${companyId}/groups`, { name: 'Temporary Group', parentId: books.group('indirect_expenses') })).body.group;
  const renamed = (await owner.browser.call(`/api/companies/${companyId}/groups/${group.id}`, { name: 'Temporary Costs', parentId: group.parentId, revision: group.revision })).body.group;
  assert.equal((await owner.browser.call(`/api/companies/${companyId}/groups/${group.id}/delete`, { revision: renamed.revision })).status, 200);
  const groupHistory = (await owner.browser.call(`/api/companies/${companyId}/groups/${group.id}/revisions`)).body.revisions;
  assert.deepEqual(groupHistory.map((entry: { action: string }) => entry.action), ['create', 'alter', 'delete']);
  assert.deepEqual([groupHistory[1].before.name, groupHistory[1].after.name, groupHistory[2].after], ['Temporary Group', 'Temporary Costs', null]);
  const type = (await owner.browser.call(`/api/companies/${companyId}/voucher-types`)).body.voucherTypes.find((row: { kind: string }) => row.kind === 'journal');
  assert.equal((await owner.browser.call(`/api/companies/${companyId}/voucher-types/${type.id}`, { name: 'General Journal', secondLanguageName: 'قيد يومية', revision: type.revision })).status, 200);
  assert.deepEqual((await owner.browser.call(`/api/companies/${companyId}/voucher-types/${type.id}/revisions`)).body.revisions.map((entry: { action: string }) => entry.action), ['alter']);

  await withCompany(owner.userId, companyId, 'write', async client => {
    for (const statement of ["UPDATE revision_log SET actor_id = 'someone else'", 'DELETE FROM revision_log', 'TRUNCATE revision_log']) {
      await client.query('SAVEPOINT attempt');
      await assert.rejects(client.query(statement), (error: unknown) => (error as { code?: string }).code === '42501', statement);
      await client.query('ROLLBACK TO SAVEPOINT attempt');
    }
  });
  const entries = await asAdmin(database.adminUrl, admin => admin.query<{ actor_id: string }>('SELECT DISTINCT actor_id FROM revision_log WHERE company_id = $1', [companyId]));
  assert.deepEqual(entries.rows.map(row => row.actor_id), [owner.userId], 'the log is unchanged');
});

test('masters: built-in rows are renamed but never deleted or moved across natures; rows in use are kept', async () => {
  const base = `/api/companies/${companyId}`;
  const groups = (await owner.browser.call(`${base}/groups`)).body.groups as { id: string; systemKey: string | null; revision: number; parentId: string | null }[];
  const bankGroup = groups.find(group => group.systemKey === 'bank_accounts')!;
  const renamed = await owner.browser.call(`${base}/groups/${bankGroup.id}`, { name: 'Banks', secondLanguageName: 'البنوك', parentId: bankGroup.parentId, revision: bankGroup.revision });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.deepEqual([renamed.body.group.name, renamed.body.group.systemKey], ['Banks', 'bank_accounts']);
  const acrossNatures = await owner.browser.call(`${base}/groups/${bankGroup.id}`, { name: 'Banks', parentId: books.group('capital'), revision: renamed.body.group.revision });
  assert.equal(acrossNatures.status, 400);
  assert.match(acrossNatures.body.error, /keeps its nature/);
  const sameNature = await owner.browser.call(`${base}/groups/${bankGroup.id}`, { name: 'Banks', parentId: books.group('investments'), revision: renamed.body.group.revision });
  assert.equal(sameNature.status, 200, 'moving within the same nature is allowed');
  assert.equal((await owner.browser.call(`${base}/groups/${bankGroup.id}/delete`, { revision: sameNature.body.group.revision })).status, 409);

  const cashLedger = (await owner.browser.call(`${base}/ledgers/${books.ledger('Cash')}`)).body.ledger;
  assert.equal((await owner.browser.call(`${base}/ledgers/${cashLedger.id}/delete`, { revision: cashLedger.revision })).status, 409);
  assert.equal((await owner.browser.call(`${base}/ledgers/${cashLedger.id}`, { name: 'Cash', groupId: books.group('capital'), revision: cashLedger.revision })).status, 400, 'a built-in ledger keeps its nature');
  const profitAndLoss = (await owner.browser.call(`${base}/ledgers`)).body.ledgers.find((row: { systemKey: string }) => row.systemKey === 'profit_and_loss');
  assert.equal(profitAndLoss.groupId, null);
  assert.equal((await owner.browser.call(`${base}/ledgers/${profitAndLoss.id}`, { name: 'Profit and Loss', groupId: books.group('capital'), revision: profitAndLoss.revision })).status, 400);

  // A database-level backstop for the same rule, beneath the API's own check.
  await withCompany(owner.userId, companyId, 'write', async client => {
    await assert.rejects(client.query('DELETE FROM ledger WHERE company_id = $1 AND id = $2', [companyId, cashLedger.id]), /built-in ledger cannot be deleted/);
  });

  const rent = (await owner.browser.call(`${base}/ledgers/${ids.rent}`)).body.ledger;
  const inUse = await owner.browser.call(`${base}/ledgers/${ids.rent}/delete`, { revision: rent.revision });
  assert.deepEqual([inUse.status, inUse.body.error], [409, 'This ledger is used in vouchers and cannot be deleted.']);
  const parent = (await owner.browser.call(`${base}/groups`, { name: 'Outer', nature: 'expense' })).body.group;
  const child = (await owner.browser.call(`${base}/groups`, { name: 'Inner', parentId: parent.id })).body.group;
  assert.equal(child.nature, 'expense');
  const cycle = await owner.browser.call(`${base}/groups/${parent.id}`, { name: 'Outer', parentId: child.id, revision: parent.revision });
  assert.equal(cycle.status, 400);
  assert.match(cycle.body.error, /own sub-groups/);
  // Changing a primary group's nature carries its sub-groups along.
  const income = await owner.browser.call(`${base}/groups/${parent.id}`, { name: 'Outer', nature: 'income', grossProfit: true, revision: parent.revision });
  assert.deepEqual([income.status, income.body.group.nature, income.body.group.grossProfit], [200, 'income', true]);
  const movedChild = (await owner.browser.call(`${base}/groups/${child.id}`)).body.group;
  assert.deepEqual([movedChild.nature, movedChild.grossProfit, movedChild.revision], ['income', true, 2], 'the cascade bumps the sub-group revision');
  const childHistory = (await owner.browser.call(`${base}/groups/${child.id}/revisions`)).body.revisions;
  assert.deepEqual(childHistory.map((entry: { action: string; before: { nature: string } | null; after: { nature: string } }) => [entry.action, entry.before?.nature ?? null, entry.after.nature]),
    [['create', null, 'expense'], ['alter', 'expense', 'income']], 'and the cascaded change is logged on the sub-group');
  const inUseGroup = await owner.browser.call(`${base}/groups/${parent.id}/delete`, { revision: income.body.group.revision });
  assert.deepEqual([inUseGroup.status, inUseGroup.body.error], [409, 'This group still holds sub-groups or ledgers. Move or delete them first.']);
  const spare = await addLedger(owner.browser, companyId, 'Spare Ledger', child.id);
  assert.equal((await owner.browser.call(`${base}/groups/${child.id}/delete`, { revision: movedChild.revision })).status, 409, 'a group with ledgers stays');
  assert.equal((await owner.browser.call(`${base}/ledgers/${spare}/delete`, { revision: 1 })).status, 200, 'an unused ledger is deleted');
  assert.equal((await owner.browser.call(`${base}/groups/${child.id}/delete`, { revision: movedChild.revision })).status, 200);
  assert.equal((await owner.browser.call(`${base}/groups/${parent.id}/delete`, { revision: income.body.group.revision })).status, 200);
  assert.equal((await owner.browser.call(`${base}/groups`, { name: 'Odd', nature: 'asset', grossProfit: true })).status, 400);
  assert.equal((await owner.browser.call(`${base}/groups`, { name: 'Banks', parentId: books.group('capital') })).status, 409, 'names are unique per company');
});

test('a locked period refuses new, altered, cancelled and deleted vouchers on or before the lock, and opening balance changes', async () => {
  const cash = books.ledger('Cash');
  const early = await post(owner.browser, companyId, books.type('payment'), '2026-01-20', [[ids.rent, 'Dr', '3'], [cash, 'Cr', '3']]);
  await asAdmin(database.adminUrl, admin => admin.query(`UPDATE company SET locked_through = '2026-01-31' WHERE company_id = $1`, [companyId]));
  try {
    const refusals = [
      await attempt('payment', '2026-01-31', [[ids.rent, 'Dr', '3'], [cash, 'Cr', '3']]),
      await owner.browser.call(url(`/${early.id}`), { date: '2026-02-05', narration: null, status: 'regular', postDated: false, revision: early.revision, lines: [{ ledgerId: ids.rent, side: 'Dr', amount: '3' }, { ledgerId: cash, side: 'Cr', amount: '3' }] }),
      await owner.browser.call(url(`/${early.id}/cancel`), { revision: early.revision }),
      await owner.browser.call(url(`/${early.id}/delete`), { revision: early.revision }),
    ];
    for (const refusal of refusals) {
      assert.equal(refusal.status, 409, JSON.stringify(refusal.body));
      assert.match(refusal.body.error, /locked through 2026-01-31/);
    }
    const bank = (await owner.browser.call(`/api/companies/${companyId}/ledgers/${ids.bank}`)).body.ledger;
    const opening = await owner.browser.call(`/api/companies/${companyId}/ledgers/${ids.bank}`, { name: bank.name, groupId: bank.groupId, opening: { amount: '6000', side: 'Dr' }, revision: bank.revision });
    assert.equal(opening.status, 409);
    assert.match(opening.body.error, /Opening balances are locked/);
    assert.equal((await attempt('payment', '2026-02-01', [[ids.rent, 'Dr', '3'], [cash, 'Cr', '3']])).status, 201, 'the day after the lock is open');
  } finally {
    await asAdmin(database.adminUrl, admin => admin.query('UPDATE company SET locked_through = NULL WHERE company_id = $1', [companyId]));
  }
});

test('openings are computed at report time: income and expense of earlier years carry into the profit and loss ledger', async () => {
  const company = await createCompany(owner.browser, { name: 'Two Years' });
  const chartOf = await chart(owner.browser, company);
  const fees = await addLedger(owner.browser, company, 'Fees', chartOf.group('indirect_expenses'));
  const profitAndLoss = chartOf.ledger('Profit and Loss');
  await post(owner.browser, company, chartOf.type('payment'), '2026-03-10', [[fees, 'Dr', '100'], [chartOf.ledger('Cash'), 'Cr', '100']]);
  await post(owner.browser, company, chartOf.type('payment'), '2027-01-05', [[fees, 'Dr', '40'], [chartOf.ledger('Cash'), 'Cr', '40']]);
  const report = await inCompany(owner.userId, company, context => trialBalance(context, '2027-01-01', '2027-01-31'));
  const row = (id: string) => report.rows.find(item => item.ledgerId === id)!;
  assert.deepEqual([row(fees).openingDebit, row(fees).debit, row(fees).closingDebit], [0n, 4000n, 4000n], 'an expense ledger starts the new year at zero');
  assert.deepEqual([row(profitAndLoss).openingDebit, row(profitAndLoss).closingDebit], [10000n, 10000n], 'last year\'s loss sits in the profit and loss ledger');
  assert.deepEqual([row(chartOf.ledger('Cash')).openingCredit, row(chartOf.ledger('Cash')).closingCredit], [10000n, 14000n]);
  assert.equal(report.totals.closingDebit, report.totals.closingCredit);
  assert.equal(report.totals.openingDebit, report.totals.openingCredit);
});

test('opening balances may be out of balance during setup; the trial balance shows the difference', async () => {
  const company = await createCompany(owner.browser, { name: 'Setting Up' });
  const chartOf = await chart(owner.browser, company);
  await addLedger(owner.browser, company, 'Setup Bank', chartOf.group('bank_accounts'), { amount: '750.50', side: 'Dr' });
  const report = (await owner.browser.call(`/api/companies/${company}/trial-balance?from=2026-01-01&to=2026-01-31`)).body.trialBalance;
  assert.deepEqual(report.openingDifference, { amount: '750.50', side: 'Dr' });
  assert.deepEqual([report.totals.closingDebit, report.totals.closingCredit], ['750.50', '0.00']);
});
