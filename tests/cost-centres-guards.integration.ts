import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { PoolClient } from 'pg';
import { getDatabase } from '../src/server/db.ts';
import { alterCostCentre, deleteCostCentre, readCostCentre } from '../src/server/ledger/cost-centres.ts';
import { createVoucher } from '../src/server/ledger/vouchers.ts';
import { accountingTables, assertDatabaseRoles, setCompanyScope } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, inCompany, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * Cost centre guards in the database (M2a slice 2): hand-written SQL as the application role (the path an application
 * bug would take), the tenancy shape of the three tables, and real postings racing centre changes.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let companyId = '', other = '';
let books: Chart;
const ids = { sales: '', party: '', channel: '', projects: '', general: '', showroom: '', online: '', north: '', voucher: '', otherCentre: '', otherCategory: '' };
const costTables = ['cost_category', 'cost_centre', 'cost_allocation'];

const call = (path: string, body?: unknown, company = companyId) => owner.browser.call(`/api/companies/${company}${path}`, body);
const made = async (path: string, body: unknown, key: string, company = companyId) => {
  const answer = await call(path, body, company);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  return answer.body[key].id as string;
};
const sale = (amount: string, cost: [string, string][]) => ({
  idempotencyKey: `guards-${randomUUID()}`, voucherTypeId: books.type('sales'), date: '2026-03-10',
  lines: [{ ledgerId: ids.party, side: 'Dr', amount }, { ledgerId: ids.sales, side: 'Cr', amount, costAllocations: cost.map(([costCentreId, value]) => ({ costCentreId, amount: value })) }],
});

before(async () => {
  database = await freshDatabase('cost_guards');
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, { name: 'Guarded Costs' });
  other = await createCompany(owner.browser, { name: 'Neighbour Costs' });
  books = await chart(owner.browser, companyId);
  for (const company of [companyId, other]) assert.equal((await call('/cost-centres-setting', { enabled: true }, company)).status, 200);
  ids.sales = await made('/ledgers', { name: 'Sales', groupId: books.group('sales') }, 'ledger');
  ids.party = await made('/ledgers', { name: 'Party', groupId: books.group('receivables') }, 'ledger');
  ids.channel = await made('/cost-categories', { name: 'Channel' }, 'costCategory');
  ids.projects = await made('/cost-categories', { name: 'Projects' }, 'costCategory');
  ids.general = ((await call('/cost-categories')).body.costCategories as any[]).find(row => row.systemKey === 'primary').id;
  ids.showroom = await made('/cost-centres', { name: 'Showroom', categoryId: ids.channel }, 'costCentre');
  ids.online = await made('/cost-centres', { name: 'Online', categoryId: ids.channel }, 'costCentre');
  ids.north = await made('/cost-centres', { name: 'P-North', categoryId: ids.projects }, 'costCentre');
  const posted = await call('/vouchers', sale('100', [[ids.showroom, '60'], [ids.online, '40']]));
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  ids.voucher = posted.body.voucher.id;
  ids.otherCategory = await made('/cost-categories', { name: 'Elsewhere' }, 'costCategory', other);
  ids.otherCentre = await made('/cost-centres', { name: 'Their Centre', categoryId: ids.otherCategory }, 'costCentre', other);
});
after(async () => { await database?.drop(); });

const code = (expected: string, constraint?: string) => (error: unknown) => {
  const { code: actual, constraint: name } = error as { code?: string; constraint?: string };
  return actual === expected && (constraint === undefined || name === constraint);
};
/** One raw transaction as the application role, scoped to `scope`; rolled back on any error, or always with `rollback`. */
async function asApp(run: (client: PoolClient) => Promise<unknown>, scope: string[] = [companyId], rollback = false): Promise<void> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await setCompanyScope(client, scope);
    await run(client);
    await client.query(rollback ? 'ROLLBACK' : 'COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}
const count = async (sql: string, values: unknown[]) => Number((await asAdmin(database.adminUrl, admin => admin.query(sql, values))).rows[0].count);
const costRows = () => count('SELECT count(*) FROM cost_allocation WHERE company_id = $1', [companyId]);
const insertRow = (client: PoolClient, row: Record<string, unknown> = {}) => {
  const values = { company_id: companyId, voucher_id: ids.voucher, line_no: 2, ledger_id: ids.sales, category_id: ids.projects, cost_centre_id: ids.north, side: 'Cr', amount: 1000, ...row };
  const keys = Object.keys(values);
  return client.query(`INSERT INTO cost_allocation (${keys.join(', ')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(', ')})`, Object.values(values));
};

test('the per-line check runs again after SET CONSTRAINTS ALL IMMEDIATE: a row inserted, a row deleted, a line deleted and put back with a row short', async () => {
  const rows = await costRows();
  await assert.rejects(asApp(async client => {
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await insertRow(client, { amount: 4000 });
  }), code('23514', 'cost_allocation_total'), 'a category short of the line');
  await assert.rejects(asApp(async client => {
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('DELETE FROM cost_allocation WHERE company_id = $1 AND voucher_id = $2 AND cost_centre_id = $3', [companyId, ids.voucher, ids.online]);
  }), code('23514', 'cost_allocation_total'), 'a row deleted');
  // A deleted line takes its rows with it; put back with only one of them, the line's category no longer adds up.
  await assert.rejects(asApp(async client => {
    await client.query('DELETE FROM voucher_line WHERE company_id = $1 AND voucher_id = $2 AND line_no = 2', [companyId, ids.voucher]);
    await client.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
      VALUES ($1, $2, 2, $3, 'Cr', 10000, 'AED', 10000, 1)`, [companyId, ids.voucher, ids.sales]);
    await insertRow(client, { category_id: ids.channel, cost_centre_id: ids.showroom, amount: 6000 });
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  }), code('23514', 'cost_allocation_total'), 'a line deleted and put back');
  // The same line put back whole passes the check (and the voucher's balance): the check reads the new line's rows.
  await asApp(async client => {
    await client.query('DELETE FROM voucher_line WHERE company_id = $1 AND voucher_id = $2 AND line_no = 2', [companyId, ids.voucher]);
    await client.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
      VALUES ($1, $2, 2, $3, 'Cr', 10000, 'AED', 10000, 1)`, [companyId, ids.voucher, ids.sales]);
    await insertRow(client, { category_id: ids.channel, cost_centre_id: ids.showroom, amount: 6000 });
    await insertRow(client, { category_id: ids.channel, cost_centre_id: ids.online, amount: 4000 });
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  }, [companyId], true);
  assert.equal(await costRows(), rows);
});

test('cost rows are checked at commit and cannot be hidden by clearing or changing the company scope', async () => {
  const rows = await costRows();
  for (const scope of ['', other]) {
    await assert.rejects(asApp(async client => {
      await insertRow(client);
      await client.query("SELECT set_config('app.company_ids', $1, true)", [scope]);
    }), code('42501', 'ledger_company_scope'), `scope "${scope}" at commit`);
  }
  await assert.rejects(asApp(client => insertRow(client)), code('23514', 'cost_allocation_total'), 'a whole line\'s amount in a new category, short of nothing, is fine; 10.00 of 100.00 is not');
  assert.equal(await costRows(), rows);
});

test('rows keep their line\'s ledger, their company\'s centres and categories; nothing is updated in place or bypassed by the role', async () => {
  const rows = await costRows();
  const pl = (await asAdmin(database.adminUrl, admin => admin.query("SELECT id FROM ledger WHERE company_id = $1 AND system_key = 'profit_and_loss'", [companyId]))).rows[0].id;
  const cases: [string, (client: PoolClient) => Promise<unknown>, (error: unknown) => boolean][] = [
    ['a row on another ledger than its line\'s', client => insertRow(client, { ledger_id: ids.party, amount: 10000 }), code('23514', 'cost_allocation_line')],
    ['a row on a line that does not exist', client => insertRow(client, { line_no: 9, amount: 10000 }), code('23514', 'cost_allocation_line')],
    ['another company\'s centre', client => insertRow(client, { cost_centre_id: ids.otherCentre, amount: 10000 }), code('23503')],
    ['another company\'s category', client => insertRow(client, { category_id: ids.otherCategory, amount: 10000 }), code('23503')],
    ['a row of another company', client => insertRow(client, { company_id: other, amount: 10000 }), code('42501')],
    ['the same centre twice in one category on a line', client => insertRow(client, { category_id: ids.channel, cost_centre_id: ids.online, amount: 1 }), code('23505', 'cost_allocation_line_idx')],
    ['a zero row', client => insertRow(client, { amount: 0 }), code('23514')],
    ['changing a row', client => client.query('UPDATE cost_allocation SET amount = amount WHERE company_id = $1', [companyId]), code('42501')],
    ['deleting the seeded category', client => client.query('DELETE FROM cost_category WHERE company_id = $1 AND id = $2', [companyId, ids.general]), code('23514', 'cost_category_builtin')],
    ['giving a category a system key', client => client.query("UPDATE cost_category SET system_key = 'primary' WHERE company_id = $1 AND id = $2", [companyId, ids.channel]), code('42501')],
    ['a centre under its own sub-centre', async client => {
      await client.query('UPDATE cost_centre SET parent_id = $3 WHERE company_id = $1 AND id = $2', [companyId, ids.online, ids.showroom]);
      await client.query('UPDATE cost_centre SET parent_id = $3 WHERE company_id = $1 AND id = $2', [companyId, ids.showroom, ids.online]);
    }, code('23514', 'cost_centre_cycle')],
    ['a centre under itself', client => client.query('UPDATE cost_centre SET parent_id = id WHERE company_id = $1 AND id = $2', [companyId, ids.online]), code('23514')],
    ['a centre under another company\'s centre', client => client.query('UPDATE cost_centre SET parent_id = $3 WHERE company_id = $1 AND id = $2', [companyId, ids.online, ids.otherCentre]), code('23503')],
    ['a used centre deleted', client => client.query('DELETE FROM cost_centre WHERE company_id = $1 AND id = $2', [companyId, ids.online]), code('23503')],
    ['the profit and loss ledger taking cost centres', client => client.query('UPDATE ledger SET cost_centres = true WHERE company_id = $1 AND id = $2', [companyId, pl]), code('23514', 'ledger_cost_centres_group')],
    ['switching the guards off', client => client.query('ALTER TABLE cost_allocation DISABLE TRIGGER USER'), code('42501')],
    ['replica mode', client => client.query("SET session_replication_role = 'replica'"), code('42501')],
  ];
  for (const [name, run, expected] of cases) await assert.rejects(asApp(run), expected, name);
  assert.equal(await costRows(), rows);
});

test('rows of a cancelled voucher are frozen', async () => {
  const posted = await call('/vouchers', sale('50', [[ids.showroom, '50']]));
  const cancelled = await call(`/vouchers/${posted.body.voucher.id}/cancel`, { revision: posted.body.voucher.revision });
  assert.equal(cancelled.status, 200);
  await assert.rejects(asApp(client => client.query('DELETE FROM cost_allocation WHERE company_id = $1 AND voucher_id = $2', [companyId, posted.body.voucher.id])), code('23514', 'voucher_lines_frozen'));
  await assert.rejects(asApp(client => insertRow(client, { voucher_id: posted.body.voucher.id, amount: 5000 })), code('23514', 'voucher_lines_frozen'));
});

test('the three tables lead with company_id, reference only within the company, are forced under the company policy and give no UPDATE on rows', async () => {
  await assert.doesNotReject(assertDatabaseRoles(getDatabase().pool), 'the boot assertion covers them');
  for (const table of costTables) assert.ok(accountingTables.includes(table as never), table);
  const shape = await asAdmin(database.adminUrl, async admin => ({
    first: (await admin.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1) AND ordinal_position = 1 ORDER BY 1`, [costTables])).rows,
    keys: (await admin.query(`SELECT conrelid::regclass::text AS "table", conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE contype IN ('f', 'p', 'u') AND conrelid::regclass::text = ANY($1) ORDER BY 1, 2`, [costTables])).rows,
    grants: (await admin.query(`SELECT t, p, has_table_privilege('books_app', t, p) AS granted FROM unnest($1::text[]) t CROSS JOIN unnest('{SELECT,INSERT,UPDATE,DELETE,TRUNCATE}'::text[]) p ORDER BY 1, 2`, [costTables])).rows,
    columns: (await admin.query(`SELECT table_name || '.' || column_name AS col FROM information_schema.column_privileges
      WHERE grantee = 'books_app' AND privilege_type = 'UPDATE' AND table_name = ANY($1) ORDER BY 1`, [[...costTables, 'ledger', 'company']])).rows.map(row => row.col),
    definers: (await admin.query(`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
      AND (proname LIKE 'cost_%' OR proname = 'ledger_seed_company') AND (prosecdef OR NOT coalesce(array_to_string(proconfig, ',') LIKE '%search_path=public, pg_temp%', false))`)).rows,
  }));
  assert.deepEqual(shape.first.map(row => row.column_name), ['company_id', 'company_id', 'company_id']);
  for (const key of shape.keys) assert.match(key.definition, /^(PRIMARY KEY|UNIQUE|FOREIGN KEY) \(company_id[,)]/, `${key.table}.${key.conname}: ${key.definition}`);
  assert.ok(shape.keys.some(key => key.table === 'cost_allocation' && /REFERENCES voucher_line\(company_id, voucher_id, line_no\) ON DELETE CASCADE/.test(key.definition)));
  const granted = (table: string) => shape.grants.filter(row => row.t === table && row.granted).map(row => row.p);
  assert.deepEqual([granted('cost_category'), granted('cost_centre'), granted('cost_allocation')], [['DELETE', 'INSERT', 'SELECT'], ['DELETE', 'INSERT', 'SELECT'], ['DELETE', 'INSERT', 'SELECT']],
    'no table-wide UPDATE or TRUNCATE');
  assert.deepEqual(shape.columns.filter(col => col.startsWith('cost_') || col.endsWith('cost_centres') || col.endsWith('cost_centres_enabled')), [
    'company.cost_centres_enabled', 'cost_category.allocate_non_revenue', 'cost_category.allocate_revenue', 'cost_category.name', 'cost_category.revision', 'cost_category.second_language_name',
    'cost_centre.category_id', 'cost_centre.name', 'cost_centre.parent_id', 'cost_centre.revision', 'cost_centre.second_language_name', 'ledger.cost_centres']);
  assert.deepEqual(shape.definers, [], 'no SECURITY DEFINER, and a fixed search path on each function');
});

const gate = () => { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; };
const state = (promise: Promise<unknown>) => Promise.race([promise.then(() => 'settled', () => 'settled'), new Promise(resolve => setTimeout(() => resolve('waiting'), 400))]);

for (const order of ['posting first', 'centre changes first'] as const) {
  test(`a posting key-sharing two centres and changes to them serialise (${order}): one changes category, the other moves`, async () => {
    const a = await made('/cost-centres', { name: `Race A ${order}`, categoryId: ids.channel }, 'costCentre');
    const b = await made('/cost-centres', { name: `Race B ${order}`, categoryId: ids.channel }, 'costCentre');
    const hold = gate(), started = gate();
    const posting = () => inCompany(owner.userId, companyId, async context => {
      const result = await createVoucher(context, sale('20', [[a, '10'], [b, '10']]));
      if (order === 'posting first') { started.open(); await hold.promise; }
      return result;
    }, 'write');
    const changes = () => inCompany(owner.userId, companyId, async context => {
      const first = await readCostCentre(context, a);
      await alterCostCentre(context, a, { name: first.name, categoryId: ids.projects, parentId: null, revision: first.revision });
      const second = await readCostCentre(context, b);
      await alterCostCentre(context, b, { name: second.name, categoryId: ids.channel, parentId: ids.showroom, revision: second.revision });
      if (order === 'centre changes first') { started.open(); await hold.promise; }
    }, 'write');
    const first = order === 'posting first' ? posting() : changes();
    await started.promise;
    const second = order === 'posting first' ? changes() : posting();
    assert.equal(await state(second), 'waiting', 'the second waits for the first to commit');
    hold.open();
    if (order === 'posting first') {
      const [result] = await Promise.all([first, second]) as [Awaited<ReturnType<typeof createVoucher>>, unknown];
      assert.deepEqual(result.voucher.lines[1].costAllocations.map(row => row.categoryName), ['Channel', 'Channel'], 'the rows keep the category they were saved with');
    } else {
      await first;
      // The posting reads the centres under its lock, after the change: A is in Projects now, so neither category adds up.
      await assert.rejects(second, (error: { code?: string }) => error.code === 'allocation_total');
    }
    const moved = await asAdmin(database.adminUrl, admin => admin.query('SELECT category_id, parent_id FROM cost_centre WHERE id = ANY($1) ORDER BY name', [[a, b]]));
    assert.deepEqual(moved.rows.map(row => [row.category_id, row.parent_id]), [[ids.projects, null], [ids.channel, ids.showroom]]);
  });
}

test('two opposite centre moves at once: one succeeds, the other is refused as a cycle, never a deadlock', async () => {
  const a = await made('/cost-centres', { name: 'Swing A', categoryId: ids.projects }, 'costCentre');
  const b = await made('/cost-centres', { name: 'Swing B', categoryId: ids.projects }, 'costCentre');
  const move = (centre: string, parent: string) => inCompany(owner.userId, companyId, async context => {
    const current = await readCostCentre(context, centre);
    await alterCostCentre(context, centre, { name: current.name, categoryId: ids.projects, parentId: parent, revision: current.revision });
  }, 'write').then(() => 'moved', (error: { code?: string }) => error.code ?? String(error));
  const outcomes = (await Promise.all([move(a, b), move(b, a)])).sort();
  assert.deepEqual(outcomes, ['cycle', 'moved']);
});

test('a centre delete waits for a posting in flight that uses it, then is refused as in use', async () => {
  const centre = await made('/cost-centres', { name: 'Briefly', categoryId: ids.channel }, 'costCentre');
  const hold = gate(), started = gate();
  const posting = inCompany(owner.userId, companyId, async context => {
    await createVoucher(context, sale('5', [[centre, '5']]));
    started.open();
    await hold.promise;
  }, 'write');
  await started.promise;
  const removal = inCompany(owner.userId, companyId, context => deleteCostCentre(context, centre, { revision: 1 }), 'write')
    .then(() => 'deleted', (error: { code?: string }) => error.code);
  assert.equal(await state(removal), 'waiting');
  hold.open();
  await posting;
  assert.equal(await removal, 'in_use');
});

// Removing a company whose vouchers have lines fails on M1's voucher_line to ledger key (no product path removes a
// company yet; reported as a gap), so this removes a company with cost masters and no postings.
test('removing a company removes its cost categories and centres; the guards let the removal through', async () => {
  const doomed = await createCompany(owner.browser, { name: 'Doomed Costs' });
  const doomedBooks = await chart(owner.browser, doomed);
  assert.equal((await call('/cost-centres-setting', { enabled: true }, doomed)).status, 200);
  await made('/ledgers', { name: 'Sales', groupId: doomedBooks.group('sales') }, 'ledger', doomed);
  const category = await made('/cost-categories', { name: 'Doomed' }, 'costCategory', doomed);
  const parent = await made('/cost-centres', { name: 'Doomed Centre', categoryId: category }, 'costCentre', doomed);
  await made('/cost-centres', { name: 'Doomed Child', categoryId: category, parentId: parent }, 'costCentre', doomed);
  assert.equal(await count('SELECT count(*) FROM cost_category WHERE company_id = $1', [doomed]), 2, 'the seeded category and one more');
  await asAdmin(database.adminUrl, async admin => {
    await admin.query('BEGIN');
    await admin.query("SELECT set_config('app.company_ids', $1, true)", [doomed]);
    await admin.query('DELETE FROM workspace WHERE id = $1', [doomed]);
    await admin.query('COMMIT');
  });
  for (const table of costTables) assert.equal(await count(`SELECT count(*) FROM ${table} WHERE company_id = $1`, [doomed]), 0, table);
  assert.ok(await costRows() > 0, 'other companies keep theirs');
});
