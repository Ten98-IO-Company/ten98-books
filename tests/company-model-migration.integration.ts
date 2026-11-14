import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { listCompanies } from '../src/server/companies.ts';
import { getDatabase, migrationFiles } from '../src/server/db.ts';
import { migrateDatabase } from '../src/server/startup-migrate.ts';
import { accountingTables, assertDatabaseRoles, companyNotFound, withCompany } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';

/**
 * Migration 0005 (D-03 as amended) on a database an earlier release left behind: prepared with every migration before
 * it, filled as that release stored companies (each a project of a workspace), then migrated. Fixtures are written as a
 * superuser because no application code for the old model remains.
 *   (a) workspace A with one company and books;
 *   (b) workspace B with three companies, each with vouchers, and four members with different roles and a two-factor rule;
 *   (c) workspace C with no company.
 */
const thisMigration = '0005_company_is_workspace.sql';
const earlier = migrationFiles.slice(0, migrationFiles.indexOf(thisMigration));

let database: TestDatabase;
let admin: pg.Client;
const users = { owner: randomUUID(), editor: randomUUID(), viewer: randomUUID(), manager: randomUUID(), outsider: randomUUID() };
const workspaces = { a: randomUUID(), b: randomUUID(), c: randomUUID() };
const companies = { a: randomUUID(), b1: randomUUID(), b2: randomUUID(), b3: randomUUID() };
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
const before0005: Record<keyof typeof companies, Snapshot> = {} as never;
let keysBefore: { table: string; name: string; definition: string }[] = [];

async function scoped<T>(companyId: string, run: () => Promise<T>): Promise<T> {
  await admin.query('BEGIN');
  try {
    await admin.query("SELECT set_config('app.company_ids', $1, true)", [companyId]);
    const result = await run();
    await admin.query('COMMIT');
    return result;
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}

async function addCompany(id: string, workspaceId: string, name: string, createdAt: string, currency = 'AED', minorUnits = 2): Promise<void> {
  await admin.query('INSERT INTO project (id, workspace_id, name, created_at) VALUES ($1, $2, $3, $4)', [id, workspaceId, name, createdAt]);
  await scoped(id, async () => {
    await admin.query(`INSERT INTO company (company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
      VALUES ($1, $2, $3, 1, 1, '2026-01-01', 'Asia/Dubai')`, [id, currency, minorUnits]);
    await admin.query('SELECT ledger_seed_company($1)', [id]);
    await admin.query(`INSERT INTO ledger (company_id, name, group_id, opening_amount, opening_side)
      SELECT $1, 'Owner Capital', id, 50000, 'Cr' FROM account_group WHERE company_id = $1 AND system_key = 'capital'`, [id]);
    await admin.query(`INSERT INTO ledger (company_id, name, group_id) SELECT $1, 'Shop Sales', id FROM account_group WHERE company_id = $1 AND system_key = 'sales'`, [id]);
    await admin.query(`INSERT INTO ledger (company_id, name, group_id) SELECT $1, 'Rent', id FROM account_group WHERE company_id = $1 AND system_key = 'indirect_expenses'`, [id]);
  });
}

/** Posts the way the ledger does: header, lines, then the next number from the locked counter, plus its revision row. */
async function post(companyId: string, kind: string, date: string, lines: [ledger: string, side: 'Dr' | 'Cr', amount: number][]): Promise<string> {
  return scoped(companyId, async () => {
    const type = (await admin.query('SELECT id, numbering_series FROM voucher_type WHERE company_id = $1 AND kind = $2', [companyId, kind])).rows[0];
    const key = `seed-${randomUUID()}`;
    const voucher = (await admin.query(`INSERT INTO voucher (company_id, voucher_type_id, series, date, idempotency_key, request_hash, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [companyId, type.id, type.numbering_series, date, key, createHash('sha256').update(key).digest('hex'), users.owner])).rows[0].id;
    for (const [index, [ledger, side, amount]] of lines.entries()) {
      await admin.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
        SELECT $1, $2, $3, id, $4, $5, 'AED', $5, 1 FROM ledger WHERE company_id = $1 AND name = $6`, [companyId, voucher, index + 1, side, amount, ledger]);
    }
    const number = (await admin.query(`INSERT INTO voucher_counter (company_id, voucher_type_id, series, last_number) VALUES ($1, $2, $3, 1)
      ON CONFLICT (company_id, voucher_type_id, series) DO UPDATE SET last_number = voucher_counter.last_number + 1 RETURNING last_number`, [companyId, type.id, type.numbering_series])).rows[0].last_number;
    await admin.query('UPDATE voucher SET number = $3 WHERE company_id = $1 AND id = $2', [companyId, voucher, number]);
    await admin.query(`INSERT INTO revision_log (company_id, entity, entity_id, action, actor_id, after) VALUES ($1, 'voucher', $2, 'create', $3, '{}')`, [companyId, voucher, users.owner]);
    return voucher;
  });
}

/**
 * What must survive the move, keyed by names and numbers rather than ids: settings, every ledger's balance, every voucher
 * with its number and idempotency key, the counters, and the size of each table. `client` is a superuser (before) or the
 * application role inside withCompany (after), so the second also proves row-level security admits exactly these rows.
 */
async function snapshot(client: pg.Client | pg.PoolClient, companyId: string) {
  const rows = async (sql: string) => (await client.query(sql, [companyId])).rows;
  return {
    settings: await rows(`SELECT base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning::text, time_zone FROM company WHERE company_id = $1`),
    balances: await rows(`SELECT l.name, (CASE l.opening_side WHEN 'Dr' THEN l.opening_amount ELSE -l.opening_amount END
        + coalesce(sum(CASE x.side WHEN 'Dr' THEN x.amount ELSE -x.amount END) FILTER (WHERE v.deleted_at IS NULL AND v.status = 'regular'), 0))::text AS balance
      FROM ledger l LEFT JOIN voucher_line x ON x.company_id = l.company_id AND x.ledger_id = l.id
      LEFT JOIN voucher v ON v.company_id = x.company_id AND v.id = x.voucher_id
      WHERE l.company_id = $1 GROUP BY l.company_id, l.id ORDER BY l.name`),
    vouchers: await rows(`SELECT t.kind, v.series, v.number, v.date::text, v.status, v.deleted_at IS NOT NULL AS deleted, v.idempotency_key, v.request_hash,
        (SELECT count(*) FROM voucher_line x WHERE x.company_id = v.company_id AND x.voucher_id = v.id)::int AS lines
      FROM voucher v JOIN voucher_type t ON t.company_id = v.company_id AND t.id = v.voucher_type_id WHERE v.company_id = $1 ORDER BY t.kind, v.number`),
    counters: await rows(`SELECT t.kind, c.series, c.last_number FROM voucher_counter c JOIN voucher_type t ON t.company_id = c.company_id AND t.id = c.voucher_type_id
      WHERE c.company_id = $1 ORDER BY t.kind`),
    sizes: await rows(`SELECT ${accountingTables.map(table => `(SELECT count(*) FROM ${table} WHERE company_id = $1)::int AS ${table}`).join(', ')}`),
  };
}

const foreignKeys = async () => (await admin.query<{ table: string; name: string; definition: string }>(
  `SELECT conrelid::regclass::text AS table, conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
   WHERE contype = 'f' AND (conrelid::regclass::text = ANY ($1) OR confrelid::regclass::text = ANY ($1)) ORDER BY 1, 2`, [accountingTables])).rows;

before(async () => {
  database = await freshDatabase('companymodel', { migrations: earlier });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), earlier.length, 'prepared with the earlier migrations only');

  for (const [key, id] of Object.entries(users)) await admin.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`, [id, key, `${key}-${id}@books.test`]);
  await admin.query("INSERT INTO workspace (id, name, created_at) VALUES ($1, 'Group A', '2026-01-01'), ($2, 'Group B', '2026-01-02'), ($3, 'Group C', '2026-01-03')", [workspaces.a, workspaces.b, workspaces.c]);
  await admin.query(`INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $3, 'owner'), ($2, $3, 'owner'), ($2, $4, 'editor'), ($2, $5, 'viewer'),
    ($2, $6, 'admin'), ($7, $8, 'owner')`, [workspaces.a, workspaces.b, users.owner, users.editor, users.viewer, users.manager, workspaces.c, users.outsider]);
  await admin.query('INSERT INTO workspace_two_factor_requirement (workspace_id) VALUES ($1)', [workspaces.b]);
  await admin.query(`INSERT INTO workspace_invitation (id, workspace_id, inviter_id, email, role, token_hash, expires_at)
    VALUES ($1, $2, $3, 'later@books.test', 'viewer', $4, now() + interval '7 days')`, [randomUUID(), workspaces.b, users.owner, 'f'.repeat(64)]);

  await addCompany(companies.a, workspaces.a, 'Alpha Trading', '2026-02-01');
  // b2 is the oldest, so it keeps workspace B; b3 counts in fils.
  await addCompany(companies.b1, workspaces.b, 'Beta One', '2026-02-03');
  await addCompany(companies.b2, workspaces.b, 'Beta Two', '2026-02-02');
  await addCompany(companies.b3, workspaces.b, 'Beta Three', '2026-02-04', 'KWD', 3);
  for (const [index, id] of Object.values(companies).entries()) {
    await post(id, 'receipt', '2026-01-05', [['Cash', 'Dr', 1000 + index], ['Shop Sales', 'Cr', 1000 + index]]);
    await post(id, 'receipt', '2026-01-06', [['Cash', 'Dr', 200], ['Shop Sales', 'Cr', 200]]);
    const gone = await post(id, 'payment', '2026-01-07', [['Rent', 'Dr', 300 + index], ['Cash', 'Cr', 300 + index]]);
    await post(id, 'payment', '2026-01-08', [['Rent', 'Dr', 50], ['Cash', 'Cr', 50]]);
    // A deleted voucher keeps its number as a permanent gap (D-04).
    await scoped(id, () => admin.query('UPDATE voucher SET deleted_at = now(), deleted_by = $3 WHERE company_id = $1 AND id = $2', [id, gone, users.owner]));
  }
  for (const key of Object.keys(companies) as (keyof typeof companies)[]) before0005[key] = await snapshot(admin, companies[key]);
  keysBefore = await foreignKeys();

  await migrateDatabase({ log: () => undefined });
});
after(async () => { await admin?.end(); await database?.drop(); });

/** Where each company's books live after the move. */
const after0005 = () => ({ a: workspaces.a, b1: companies.b1, b2: workspaces.b, b3: companies.b3 });

test('every company is its own workspace: the first keeps the workspace id and the others become workspaces named after them', async () => {
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), migrationFiles.length);
  const rows = (await admin.query('SELECT w.id, w.name, (c.company_id IS NOT NULL) AS books FROM workspace w LEFT JOIN company c ON c.company_id = w.id ORDER BY w.created_at, w.id')).rows;
  assert.deepEqual(rows, [
    { id: workspaces.a, name: 'Alpha Trading', books: true },
    { id: workspaces.b, name: 'Beta Two', books: true },
    { id: workspaces.c, name: 'Group C', books: false },
    { id: companies.b1, name: 'Beta One', books: true },
    { id: companies.b3, name: 'Beta Three', books: true },
  ]);
  assert.equal(Number((await admin.query('SELECT count(*) FROM project')).rows[0].count), 0, 'project rows meant companies and are gone; the table stays');
  assert.equal(Number((await admin.query("SELECT count(*) FROM pg_class WHERE relname = 'company_move'")).rows[0].count), 0);
});

test('balances, voucher numbers, gaps, counters, revisions and idempotency keys are unchanged per company', async () => {
  const target = after0005();
  for (const key of Object.keys(companies) as (keyof typeof companies)[]) {
    assert.deepEqual(await snapshot(admin, target[key]), before0005[key], key);
    // Through the application role: the company's own scope admits exactly the same rows, and nothing of any other company.
    const seen = await withCompany(users.owner, target[key], 'read', async client => {
      const others: number[] = [];
      for (const table of accountingTables) others.push(Number((await client.query(`SELECT count(*) FROM ${table} WHERE company_id <> $1`, [target[key]])).rows[0].count));
      return { snapshot: await snapshot(client, target[key]), others };
    });
    assert.deepEqual(seen.snapshot, before0005[key], `${key} through withCompany`);
    assert.deepEqual(seen.others, accountingTables.map(() => 0), `${key} sees no other company`);
  }
  assert.ok(before0005.b2.vouchers.length === 4 && before0005.b2.counters.length === 2, 'the fixture has vouchers and counters to compare');
});

test('members, roles and the two-factor rule follow every company; invitations stay with the workspace they were sent for', async () => {
  const members = async (id: string) => (await admin.query('SELECT user_id, role FROM membership WHERE workspace_id = $1 ORDER BY user_id', [id])).rows;
  const original = [[users.owner, 'owner'], [users.editor, 'editor'], [users.viewer, 'viewer'], [users.manager, 'admin']]
    .map(([user_id, role]) => ({ user_id, role })).sort((x, y) => x.user_id.localeCompare(y.user_id));
  for (const id of [workspaces.b, companies.b1, companies.b3]) {
    assert.deepEqual(await members(id), original, id);
    assert.equal(Number((await admin.query('SELECT count(*) FROM workspace_two_factor_requirement WHERE workspace_id = $1', [id])).rows[0].count), 1);
  }
  assert.deepEqual(await members(workspaces.a), [{ user_id: users.owner, role: 'owner' }]);
  assert.deepEqual((await admin.query('SELECT workspace_id FROM workspace_invitation')).rows, [{ workspace_id: workspaces.b }]);

  // The list a member sees: every company, with the role in it. The two-factor rule hides B's companies' settings
  // from members without a factor, so turn it off for this check.
  await admin.query('DELETE FROM workspace_two_factor_requirement');
  const listed = await listCompanies(users.viewer);
  assert.deepEqual(listed.map(item => [item.id, item.name, item.role, item.company?.baseCurrency ?? null]),
    [[workspaces.b, 'Beta Two', 'viewer', 'AED'], [companies.b1, 'Beta One', 'viewer', 'AED'], [companies.b3, 'Beta Three', 'viewer', 'KWD']]);
  assert.deepEqual((await listCompanies(users.outsider)).map(item => [item.id, item.company]), [[workspaces.c, null]], 'a workspace without a company is not set up yet');
});

test('after the move: a viewer reads but cannot write, a non-member gets not found, and SQL without a company context sees nothing', async () => {
  const refused = (error: unknown) => (error as { status?: number }).status === 404 && (error as Error).message === companyNotFound;
  let wrote = false;
  for (const id of [companies.b1, companies.b3]) {
    await withCompany(users.viewer, id, 'read', async () => undefined);
    await assert.rejects(withCompany(users.viewer, id, 'write', async () => { wrote = true; }), refused);
    await assert.rejects(withCompany(users.outsider, id, 'read', async () => { wrote = true; }), refused);
  }
  await assert.rejects(withCompany(users.owner, companies.b2, 'read', async () => { wrote = true; }), refused, 'the old id of the company that kept the workspace is gone');
  assert.equal(wrote, false);
  const { pool } = getDatabase();
  for (const table of accountingTables) assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
  assert.equal((await pool.query("UPDATE company SET time_zone = 'UTC'")).rowCount, 0);
});

test('keys, guards, policies and grants are back as before; company now references workspace', async () => {
  await assertDatabaseRoles(getDatabase().pool);
  const keysAfter = await foreignKeys();
  const companyKey = (keys: typeof keysAfter) => keys.find(key => key.table === 'company' && key.name === 'company_company_id_fkey');
  assert.match(companyKey(keysBefore)!.definition, /REFERENCES project\(id\) ON DELETE CASCADE/);
  assert.equal(companyKey(keysAfter)!.definition, 'FOREIGN KEY (company_id) REFERENCES workspace(id) ON DELETE CASCADE');
  assert.deepEqual(keysAfter.filter(key => key !== companyKey(keysAfter)), keysBefore.filter(key => key !== companyKey(keysBefore)));
  assert.deepEqual((await admin.query(`SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND t.tgenabled <> 'O'`)).rows, [], 'every guard trigger is enabled');
  // A guard still fires: a counter cannot jump.
  await assert.rejects(scoped(companies.b1, () => admin.query('UPDATE voucher_counter SET last_number = last_number + 5 WHERE company_id = $1', [companies.b1])),
    (error: unknown) => (error as { constraint?: string }).constraint === 'voucher_counter_sequence');
});
