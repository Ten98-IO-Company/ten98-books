import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { PoolClient } from 'pg';
import { getDatabase } from '../src/server/db.ts';
import { setCompanyScope } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { createVoucher } from '../src/server/ledger/vouchers.ts';
import { addLedger, asAdmin, chart, createCompany, inCompany, post, setupOwner, voucherBody, type Chart, type Member } from './helpers/ledger.ts';

/**
 * Database guards and the rules added after the independent review: each test drives the exact path that once let a
 * broken state through (raw SQL as the application role, or the API) and checks it is refused and nothing changed.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let companyId = '';
let other = '';
let books: Chart;
const ids = { rent: '', bank: '' };

before(async () => {
  database = await freshDatabase('ledger_guards');
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, owner.workspaceId, { name: 'Guarded Books' });
  other = await createCompany(owner.browser, owner.workspaceId, { name: 'Neighbour Books' });
  books = await chart(owner.browser, companyId);
  ids.rent = await addLedger(owner.browser, companyId, 'Rent', books.group('indirect_expenses'));
  ids.bank = await addLedger(owner.browser, companyId, 'Bank', books.group('bank_accounts'));
});
after(async () => { await database?.drop(); });

const base = () => `/api/companies/${companyId}`;
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
const lineCount = async (voucherId: string) => Number((await asAdmin(database.adminUrl, admin => admin.query('SELECT count(*) FROM voucher_line WHERE voucher_id = $1', [voucherId]))).rows[0].count);
const payment = (amount = '10', date = '2026-01-10') => post(owner.browser, companyId, books.type('payment'), date, [[ids.rent, 'Dr', amount], [books.ledger('Cash'), 'Cr', amount]]);

test('the deferred balance check cannot be skipped by clearing or changing the company scope before commit', async () => {
  const voucher = await payment();
  for (const scope of ['', other]) {
    await assert.rejects(asApp(async client => {
      await client.query('DELETE FROM voucher_line WHERE company_id = $1 AND voucher_id = $2 AND line_no = 2', [companyId, voucher.id]);
      await client.query("SELECT set_config('app.company_ids', $1, true)", [scope]);
    }), code('42501', 'ledger_company_scope'), `scope "${scope}" at commit`);
  }
  assert.equal(await lineCount(voucher.id), 2, 'the voucher keeps both lines');
});

test('the cash ledger stays in the cash and bank family, and groups holding built-in rows keep their nature', async () => {
  const cash = (await owner.browser.call(`${base()}/ledgers/${books.ledger('Cash')}`)).body.ledger;
  const primary = (await owner.browser.call(`${base()}/groups`, { name: 'Holding Assets', nature: 'asset' })).body.group;
  const intoPrimary = await owner.browser.call(`${base()}/ledgers/${cash.id}`, { name: 'Cash', groupId: primary.id, revision: cash.revision });
  assert.deepEqual([intoPrimary.status, intoPrimary.body.error], [400, 'The cash ledger must stay under a cash or bank group.']);
  await assert.rejects(asApp(client => client.query('UPDATE ledger SET group_id = $2 WHERE company_id = $1 AND id = $3', [companyId, primary.id, cash.id])), code('23514', 'ledger_cash_family'));

  // Inside the family it may move; the sub-group holding it may not then leave the family.
  const tills = (await owner.browser.call(`${base()}/groups`, { name: 'Tills', parentId: books.group('bank_accounts') })).body.group;
  const moved = await owner.browser.call(`${base()}/ledgers/${cash.id}`, { name: 'Cash', groupId: tills.id, revision: cash.revision });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const leave = await owner.browser.call(`${base()}/groups/${tills.id}`, { name: 'Tills', parentId: primary.id, revision: tills.revision });
  assert.deepEqual([leave.status, leave.body.error], [400, 'The cash ledger must stay under a cash or bank group, so this group cannot move there.']);
  await assert.rejects(asApp(client => client.query('UPDATE account_group SET parent_id = $2 WHERE company_id = $1 AND id = $3', [companyId, primary.id, tills.id])), code('23514', 'ledger_cash_family'));

  // The reviewed exploit: a built-in group moved under a user group, whose nature then changes.
  const banks = (await owner.browser.call(`${base()}/groups/${books.group('bank_accounts')}`)).body.group;
  assert.equal((await owner.browser.call(`${base()}/groups/${banks.id}`, { name: banks.name, parentId: primary.id, revision: banks.revision })).status, 200, 'same nature: allowed');
  const flip = await owner.browser.call(`${base()}/groups/${primary.id}`, { name: 'Holding Assets', nature: 'expense', revision: primary.revision });
  assert.equal(flip.status, 409);
  assert.match(flip.body.error, /cannot change its nature while it holds built-in groups or ledgers/);
  await assert.rejects(asApp(client => client.query(`UPDATE account_group SET nature = 'expense' WHERE company_id = $1 AND id = $2`, [companyId, primary.id])), code('23514', 'account_group_builtin'));
  const ledgers = (await owner.browser.call(`${base()}/ledgers`)).body.ledgers as { id: string; nature: string; cashOrBank: boolean }[];
  assert.deepEqual(ledgers.filter(row => row.id === cash.id).map(row => [row.nature, row.cashOrBank]), [['asset', true]]);
});

test('a group with posted ledgers or opening balances keeps its nature; moving the ledgers out reclassifies them', async () => {
  const group = (await owner.browser.call(`${base()}/groups`, { name: 'Misc Costs', nature: 'expense' })).body.group;
  const used = await addLedger(owner.browser, companyId, 'Sundries', group.id);
  await post(owner.browser, companyId, books.type('payment'), '2026-01-12', [[used, 'Dr', '4'], [books.ledger('Cash'), 'Cr', '4']]);
  const posted = await owner.browser.call(`${base()}/groups/${group.id}`, { name: 'Misc Costs', nature: 'income', revision: group.revision });
  assert.equal(posted.status, 409, 'posted lines');
  const moveUnder = await owner.browser.call(`${base()}/groups/${group.id}`, { name: 'Misc Costs', parentId: books.group('capital'), revision: group.revision });
  assert.equal(moveUnder.status, 409, 'a move under another nature is a nature change too');
  const sundries = (await owner.browser.call(`${base()}/ledgers/${used}`)).body.ledger;
  assert.equal((await owner.browser.call(`${base()}/ledgers/${used}`, { name: 'Sundries', groupId: books.group('indirect_expenses'), revision: sundries.revision })).status, 200, 'the ledger moves out');
  const opening = await addLedger(owner.browser, companyId, 'Prepaid Item', group.id, { amount: '1', side: 'Dr' });
  assert.equal((await owner.browser.call(`${base()}/groups/${group.id}`, { name: 'Misc Costs', nature: 'income', revision: group.revision })).status, 409, 'opening balance');
  const prepaid = (await owner.browser.call(`${base()}/ledgers/${opening}`)).body.ledger;
  assert.equal((await owner.browser.call(`${base()}/ledgers/${opening}`, { name: 'Prepaid Item', groupId: books.group('current_assets'), revision: prepaid.revision })).status, 200);
  assert.equal((await owner.browser.call(`${base()}/groups/${group.id}`, { name: 'Misc Costs', nature: 'income', revision: group.revision })).status, 200, 'an emptied group may change');
});

test('altering a voucher states its status and post-dated flag; omitting them is refused, not defaulted', async () => {
  const optional = await post(owner.browser, companyId, books.type('payment'), '2026-01-14', [[ids.rent, 'Dr', '8'], [books.ledger('Cash'), 'Cr', '8']], { status: 'optional', postDated: true });
  const lines = [{ ledgerId: ids.rent, side: 'Dr', amount: '9' }, { ledgerId: books.ledger('Cash'), side: 'Cr', amount: '9' }];
  for (const omitted of ['status', 'postDated', 'narration']) {
    const body: Record<string, unknown> = { date: '2026-01-14', narration: null, status: 'optional', postDated: true, lines, revision: optional.revision };
    delete body[omitted];
    const refused = await owner.browser.call(`${base()}/vouchers/${optional.id}`, body);
    assert.equal(refused.status, 400, omitted);
  }
  const unchanged = (await owner.browser.call(`${base()}/vouchers/${optional.id}`)).body.voucher;
  assert.deepEqual([unchanged.status, unchanged.number, unchanged.postDated, unchanged.total, unchanged.revision], ['optional', null, true, '8.00', 1]);
});

test('concurrent opposite group moves give one success and one refusal, never a cycle or a server error', async () => {
  const make = async (name: string) => (await owner.browser.call(`${base()}/groups`, { name, nature: 'liability' })).body.group;
  const [x, y] = [await make('Group X'), await make('Group Y')];
  const results = await Promise.all([
    owner.browser.call(`${base()}/groups/${x.id}`, { name: 'Group X', parentId: y.id, revision: x.revision }),
    owner.browser.call(`${base()}/groups/${y.id}`, { name: 'Group Y', parentId: x.id, revision: y.revision }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400], JSON.stringify(results.map(result => result.body)));

  // The same race as two raw application-role transactions: the second waits on the tree lock, then sees the first.
  const [p, q] = [await make('Group P'), await make('Group Q')];
  const first = await getDatabase().pool.connect();
  try {
    await first.query('BEGIN');
    await setCompanyScope(first, [companyId]);
    await first.query('UPDATE account_group SET parent_id = $2 WHERE company_id = $1 AND id = $3', [companyId, q.id, p.id]);
    const second = asApp(client => client.query('UPDATE account_group SET parent_id = $2 WHERE company_id = $1 AND id = $3', [companyId, p.id, q.id]));
    await new Promise(resolve => setTimeout(resolve, 300));
    await first.query('COMMIT');
    await assert.rejects(second, code('23514', 'account_group_cycle'));
  } finally { await first.query('ROLLBACK').catch(() => undefined); first.release(); }
  const cycles = await asAdmin(database.adminUrl, admin => admin.query(
    'SELECT count(*) FROM account_group a JOIN account_group b ON b.company_id = a.company_id AND b.id = a.parent_id WHERE a.company_id = $1 AND b.parent_id = a.id', [companyId]));
  assert.equal(Number(cycles.rows[0].count), 0);
  const repeatable = await getDatabase().pool.connect();
  try {
    await repeatable.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await setCompanyScope(repeatable, [companyId]);
    await assert.rejects(repeatable.query('UPDATE account_group SET parent_id = NULL WHERE company_id = $1 AND id = $2', [companyId, p.id]),
      code('25001'), 'moves need READ COMMITTED so the walk sees concurrent moves');
  } finally { await repeatable.query('ROLLBACK'); repeatable.release(); }
});

test('numbers and counters cannot be forged or rewound by direct SQL', async () => {
  const voucher = await payment('11');
  const counter = { company: companyId, type: books.type('payment') };
  const counterRefusal = code('23514', 'voucher_counter_sequence');
  await assert.rejects(asApp(client => client.query('UPDATE voucher_counter SET last_number = 1 WHERE company_id = $1 AND voucher_type_id = $2', [counter.company, counter.type])), counterRefusal, 'rewind');
  await assert.rejects(asApp(client => client.query('UPDATE voucher_counter SET last_number = last_number + 2 WHERE company_id = $1 AND voucher_type_id = $2', [counter.company, counter.type])), counterRefusal, 'skip');
  await assert.rejects(asApp(client => client.query(`INSERT INTO voucher_counter (company_id, voucher_type_id, series, last_number) VALUES ($1, $2, 'other', 9)`, [counter.company, counter.type])), counterRefusal, 'start past one');
  await assert.rejects(asApp(client => client.query(
    `INSERT INTO voucher (company_id, voucher_type_id, series, number, date, idempotency_key, request_hash, created_by) VALUES ($1, $2, 'main', 999, '2026-01-11', $3, repeat('a', 64), $4)`,
    [companyId, counter.type, `forged-${randomUUID()}`, owner.userId])), code('23514', 'voucher_numbered'), 'a number the counter never issued');
  const optional = await post(owner.browser, companyId, books.type('payment'), '2026-01-15', [[ids.rent, 'Dr', '2'], [books.ledger('Cash'), 'Cr', '2']], { status: 'optional' });
  await assert.rejects(asApp(client => client.query(`UPDATE voucher SET status = 'regular', number = $3 WHERE company_id = $1 AND id = $2`, [companyId, optional.id, voucher.number + 1])), code('23514', 'voucher_numbered'));
  // The next real posting is not jammed: the counter is where the API left it.
  assert.equal((await payment('12')).number, voucher.number + 1);
});

test('lines of a cancelled or deleted voucher cannot be added, changed or removed', async () => {
  const cancelled = await payment('13');
  const cancelledNow = (await owner.browser.call(`${base()}/vouchers/${cancelled.id}/cancel`, { revision: cancelled.revision })).body.voucher;
  const deleted = await payment('14');
  assert.equal((await owner.browser.call(`${base()}/vouchers/${deleted.id}/delete`, { revision: deleted.revision })).status, 200);
  const frozen = code('23514', 'voucher_lines_frozen');
  for (const voucher of [cancelledNow, deleted]) {
    await assert.rejects(asApp(client => client.query('DELETE FROM voucher_line WHERE company_id = $1 AND voucher_id = $2', [companyId, voucher.id])), frozen);
    await assert.rejects(asApp(client => client.query(
      `INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate) VALUES ($1, $2, 3, $3, 'Dr', 5, 'AED', 5, 1)`,
      [companyId, voucher.id, ids.rent])), frozen);
    assert.equal(await lineCount(voucher.id), 2);
  }
});

test('the voucher list pages by date and entry order with a bounded page size', async () => {
  const company = await createCompany(owner.browser, owner.workspaceId, { name: 'Paged Books' });
  const chartOf = await chart(owner.browser, company);
  const fee = await addLedger(owner.browser, company, 'Fee', chartOf.group('indirect_expenses'));
  const dates = ['2026-03-02', '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-01'];
  const posted = [];
  for (const [index, date] of dates.entries()) posted.push(await post(owner.browser, company, chartOf.type('payment'), date, [[fee, 'Dr', String(index + 1)], [chartOf.ledger('Cash'), 'Cr', String(index + 1)]]));
  const expected = posted.map((voucher, index) => ({ id: voucher.id, date: dates[index], index })).sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index).map(row => row.id);
  const seen: string[] = [];
  let next: string | null = null;
  do {
    const page = await owner.browser.call(`/api/companies/${company}/vouchers?from=2026-03-01&to=2026-03-31&limit=2${next ? `&after=${next}` : ''}`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.ok(page.body.vouchers.length <= 2);
    seen.push(...page.body.vouchers.map((voucher: { id: string }) => voucher.id));
    next = page.body.next;
  } while (next && seen.length < 20);
  assert.deepEqual(seen, expected, 'every voucher once, by date then entry order');
  assert.equal((await owner.browser.call(`/api/companies/${company}/vouchers?from=2026-03-01&to=2026-03-31`)).body.vouchers.length, 5, 'default page size covers a small period');
  assert.equal((await owner.browser.call(`/api/companies/${company}/vouchers?from=2026-03-01&to=2026-03-31&limit=501`)).status, 400);
  assert.equal((await owner.browser.call(`/api/companies/${company}/vouchers?from=2026-03-01&to=2026-03-31&after=bm90LWEtY3Vyc29y`)).status, 400);
});

/** Starts `run` in a raw application-role transaction and returns handles to finish it later; the transaction stays open. */
async function openTransaction(run: (client: PoolClient) => Promise<unknown>): Promise<{ commit: () => Promise<void>; rollback: () => Promise<void> }> {
  const client = await getDatabase().pool.connect();
  await client.query('BEGIN');
  await setCompanyScope(client, [companyId]);
  try { await run(client); } catch (error) { await client.query('ROLLBACK'); client.release(); throw error; }
  let done = false;
  const finish = async (statement: string) => { if (done) return; done = true; try { await client.query(statement); } finally { client.release(); } };
  return { commit: () => finish('COMMIT'), rollback: () => finish('ROLLBACK') };
}
const settledWithin = async (promise: Promise<unknown>, ms: number) => {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, ms));
  return settled;
};

test('the cash ledger cannot leave its family through a ledger move racing a group move', async () => {
  const userAssets = (await owner.browser.call(`${base()}/groups`, { name: 'Race Assets', nature: 'asset' })).body.group;
  for (let round = 0; round < 10; round++) {
    const cash = (await owner.browser.call(`${base()}/ledgers/${books.ledger('Cash')}`)).body.ledger;
    const drawer = (await owner.browser.call(`${base()}/groups`, { name: `Drawer ${round}`, parentId: books.group('bank_accounts') })).body.group;
    const [ledgerMove, groupMove] = await Promise.all([
      owner.browser.call(`${base()}/ledgers/${cash.id}`, { name: 'Cash', groupId: drawer.id, revision: cash.revision }),
      owner.browser.call(`${base()}/groups/${drawer.id}`, { name: `Drawer ${round}`, parentId: userAssets.id, revision: drawer.revision }),
    ]);
    assert.deepEqual([ledgerMove.status, groupMove.status].sort(), [200, 400], `round ${round}: ${JSON.stringify([ledgerMove.body, groupMove.body])}`);
    assert.equal((await owner.browser.call(`${base()}/ledgers/${cash.id}`)).body.ledger.cashOrBank, true, `round ${round}: cash stays a cash ledger`);
  }
  // The same race as raw application-role transactions: the group move waits for the ledger move, then refuses.
  const cash = (await owner.browser.call(`${base()}/ledgers/${books.ledger('Cash')}`)).body.ledger;
  const box = (await owner.browser.call(`${base()}/groups`, { name: 'Raw Box', parentId: books.group('bank_accounts') })).body.group;
  const ledgerMove = await openTransaction(client => client.query('UPDATE ledger SET group_id = $2 WHERE company_id = $1 AND id = $3', [companyId, box.id, cash.id]));
  const groupMove = asApp(client => client.query('UPDATE account_group SET parent_id = $2 WHERE company_id = $1 AND id = $3', [companyId, userAssets.id, box.id]));
  let waited: boolean;
  try { waited = !(await settledWithin(groupMove, 300)); } finally { await ledgerMove.commit(); }
  assert.equal(waited, true, 'the group move waits for the ledger move');
  await assert.rejects(groupMove, code('23514', 'ledger_cash_family'));
});

test('a nature change waits for an in-flight posting or ledger creation, then refuses', async () => {
  const group = (await owner.browser.call(`${base()}/groups`, { name: 'Pending Costs', nature: 'expense' })).body.group;
  const ledger = await addLedger(owner.browser, companyId, 'Pending Ledger', group.id);
  // A posting to the group's ledger, still uncommitted when the nature change arrives.
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const posting = inCompany(owner.userId, companyId, async context => {
    await createVoucher(context, voucherBody(books.type('payment'), '2026-01-20', [[ledger, 'Dr', '3'], [books.ledger('Cash'), 'Cr', '3']]));
    await hold;
  }, 'write');
  await new Promise(resolve => setTimeout(resolve, 100));
  const change = owner.browser.call(`${base()}/groups/${group.id}`, { name: 'Pending Costs', nature: 'income', revision: group.revision });
  let waited: boolean;
  try { waited = !(await settledWithin(change, 300)); } finally { release(); await posting; }
  assert.equal(waited, true, 'the nature change waits for the posting');
  const refused = await change;
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal((await owner.browser.call(`${base()}/groups/${group.id}`)).body.group.nature, 'expense');

  // A ledger with an opening balance being created in an empty group, still uncommitted.
  const empty = (await owner.browser.call(`${base()}/groups`, { name: 'Fresh Costs', nature: 'expense' })).body.group;
  const creation = await openTransaction(client => client.query(
    `INSERT INTO ledger (company_id, group_id, name, opening_amount, opening_side) VALUES ($1, $2, 'Late Opening', 500, 'Dr')`, [companyId, empty.id]));
  const flip = owner.browser.call(`${base()}/groups/${empty.id}`, { name: 'Fresh Costs', nature: 'income', revision: empty.revision });
  try { waited = !(await settledWithin(flip, 300)); } finally { await creation.commit(); }
  assert.equal(waited, true, 'the nature change waits for the ledger creation');
  assert.equal((await flip).status, 409);
});

test('postings running alongside nature changes all complete without deadlocks or server errors', async () => {
  const groups = await Promise.all(['Busy A', 'Busy B'].map(async name => (await owner.browser.call(`${base()}/groups`, { name, nature: 'expense' })).body.group));
  const ledgers = await Promise.all(groups.map((group, index) => addLedger(owner.browser, companyId, `Busy Ledger ${index}`, group.id)));
  const posts = Array.from({ length: 16 }, (_, index) => owner.browser.call(`${base()}/vouchers`,
    voucherBody(books.type('payment'), '2026-01-21', [[ledgers[index % 2], 'Dr', '1'], [ledgers[(index + 1) % 2], 'Dr', '1'], [books.ledger('Cash'), 'Cr', '2']])));
  const changes = groups.map(group => owner.browser.call(`${base()}/groups/${group.id}`, { name: group.name, nature: 'income', revision: group.revision }));
  const results = await Promise.all([...posts, ...changes]);
  assert.ok(results.slice(0, 16).every(result => result.status === 201), JSON.stringify(results.filter(result => result.status !== 201).map(result => result.body)));
  for (const [index, result] of results.slice(16).entries()) {
    assert.ok([200, 409].includes(result.status), JSON.stringify(result.body));
    const group = (await owner.browser.call(`${base()}/groups/${groups[index].id}`)).body.group;
    // Either it changed before any posting reached its ledger, or it refused and kept its nature.
    assert.equal(group.nature, result.status === 200 ? 'income' : 'expense');
  }
  const posted = await asAdmin(database.adminUrl, admin => admin.query<{ nature: string; lines: string }>(
    `SELECT g.nature, count(x.*) AS lines FROM account_group g JOIN ledger l ON l.company_id = g.company_id AND l.group_id = g.id
     LEFT JOIN voucher_line x ON x.company_id = l.company_id AND x.ledger_id = l.id WHERE g.company_id = $1 AND g.id = ANY($2::uuid[]) GROUP BY g.id, g.nature`,
    [companyId, groups.map(group => group.id)]));
  assert.ok(posted.rows.every(row => Number(row.lines) === 16), 'every posting reached both ledgers');
});

test('a series exists only as its voucher type\'s series', async () => {
  const type = books.type('payment');
  await assert.rejects(asApp(client => client.query(`INSERT INTO voucher_counter (company_id, voucher_type_id, series, last_number) VALUES ($1, $2, 'invented', 1)`, [companyId, type])), code('23503'));
  await assert.rejects(asApp(client => client.query(
    `INSERT INTO voucher (company_id, voucher_type_id, series, status, date, idempotency_key, request_hash, created_by) VALUES ($1, $2, 'invented', 'optional', '2026-01-11', $3, repeat('a', 64), $4)`,
    [companyId, type, `series-${randomUUID()}`, owner.userId])), code('23503'));
});

test('a counter cannot advance without a voucher for each number it issues', async () => {
  const type = books.type('payment');
  const counterRefusal = code('23514', 'voucher_counter_sequence');
  const advance = (client: PoolClient) => client.query<{ last_number: number }>('UPDATE voucher_counter SET last_number = last_number + 1 WHERE company_id = $1 AND voucher_type_id = $2 RETURNING last_number', [companyId, type]);
  await assert.rejects(asApp(advance), counterRefusal, 'an advance with no voucher');
  await assert.rejects(asApp(async client => {
    await advance(client);
    const { rows } = await advance(client);
    const voucher = await client.query<{ id: string }>(
      `INSERT INTO voucher (company_id, voucher_type_id, series, number, date, idempotency_key, request_hash, created_by) VALUES ($1, $2, 'main', $3, '2026-01-11', $4, repeat('a', 64), $5) RETURNING id`,
      [companyId, type, rows[0].last_number, `double-${randomUUID()}`, owner.userId]);
    for (const [lineNo, ledgerId, side] of [[1, ids.rent, 'Dr'], [2, books.ledger('Cash'), 'Cr']] as const) {
      await client.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate) VALUES ($1, $2, $3, $4, $5, 7, 'AED', 7, 1)`,
        [companyId, voucher.rows[0].id, lineNo, ledgerId, side]);
    }
  }), counterRefusal, 'two advances matched by one voucher');
  const last = await asAdmin(database.adminUrl, admin => admin.query<{ last_number: number }>('SELECT last_number FROM voucher_counter WHERE company_id = $1 AND voucher_type_id = $2', [companyId, type]));
  assert.equal((await payment('15')).number, last.rows[0].last_number + 1, 'the series continues without a gap');
});
