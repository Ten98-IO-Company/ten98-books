import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { handleApi } from '../src/server/api.ts';
import { getConfig } from '../src/server/config.ts';
import { createPool, getDatabase } from '../src/server/db.ts';
import { assertApplicationRole } from '../src/server/startup-migrate.ts';
import { assertDatabaseRoles, companyNotFound, DatabaseRoleError, withCompany } from '../src/server/tenancy.ts';
import { Browser, freshDatabase, type TestDatabase } from './helpers/database.ts';

let database: TestDatabase;
const browser = () => new Browser(handleApi, getConfig().appUrl);
const books = { baseCurrency: 'AED', financialYearStart: { month: 1, day: 1 }, booksBeginning: '2026-01-01', timeZone: 'Asia/Dubai' };
const password = 'correct horse battery staple';
// A owns workspace W1 with company C1, and W2. B is an admin of W2 only and creates company C2 there.
const fixture = { aId: '', bId: '', c1: '', c2: '' };
let a: Browser, b: Browser;

before(async () => {
  database = await freshDatabase('tenancy');
  a = browser(); b = browser();
  const aEmail = `a-${randomUUID()}@books.test`, bEmail = `b-${randomUUID()}@books.test`;
  assert.equal((await a.call('/api/auth/setup', { name: 'A', email: aEmail, password, workspaceName: 'W1' })).status, 200);
  const me = (await a.call('/api/me')).body;
  fixture.aId = me.user.id;
  fixture.c1 = (await a.call(`/api/workspaces/${me.workspaces[0].id}/companies`, { name: 'C1', ...books })).body.company.id;
  const w2 = (await a.call('/api/workspaces', { name: 'W2' })).body.workspace.id as string;
  const invite = (await a.call(`/api/workspaces/${w2}/invitations`, { email: bEmail, role: 'admin' })).body.inviteUrl as string;
  const accepted = await b.call('/api/invitations/accept', { token: new URL(invite).hash.replace('#invite=', ''), name: 'B', password });
  assert.equal(accepted.body.signedIn, true);
  fixture.bId = (await b.call('/api/me')).body.user.id;
  // B is a member of W2 only, so C1 is outside B's reach.
  fixture.c2 = (await b.call(`/api/workspaces/${w2}/companies`, { name: 'C2', ...books, baseCurrency: 'SAR' })).body.company.id;
  assert.ok(fixture.c1 && fixture.c2);
});
after(async () => { await database?.drop(); });

test('the application role passes the boot assertion; a superuser or the table owner is refused', async () => {
  await assertDatabaseRoles(getDatabase().pool);
  await assertApplicationRole();
  const superuser = createPool(database.adminUrl, { max: 1 });
  const migrator = createPool(process.env.MIGRATION_DATABASE_URL!, { max: 1 });
  try {
    await assert.rejects(assertDatabaseRoles(superuser), (error: unknown) => error instanceof DatabaseRoleError && /superuser/.test(error.message) && /bypasses row-level security/.test(error.message));
    await assert.rejects(assertApplicationRole(superuser), /unsafe for company data/);
    await assert.rejects(assertDatabaseRoles(migrator), (error: unknown) => error instanceof DatabaseRoleError && /owns or inherits the owner of .*company/.test(error.message));
    // An accounting table without forced RLS is refused even for the right role.
    await assert.rejects(assertDatabaseRoles(getDatabase().pool, ['company', 'user']), /not enabled and forced on user/);
  } finally { await superuser.end(); await migrator.end(); }
});

test('a user from another workspace gets the same not-found answer as for a missing company, on read and write', async () => {
  const missing = randomUUID();
  const foreign = await b.call(`/api/companies/${fixture.c1}`);
  const absent = await b.call(`/api/companies/${missing}`);
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign, absent);
  assert.deepEqual(foreign.body, { error: companyNotFound });
  assert.equal((await b.call(`/api/companies/${fixture.c2}`)).status, 200, 'the member still reads their own company');

  let ran = false;
  const write = (companyId: string) => withCompany(fixture.bId, companyId, 'write', async client => { ran = true; return client.query("UPDATE company SET time_zone = 'UTC'") });
  for (const companyId of [fixture.c1, missing, 'not-a-uuid']) {
    await assert.rejects(write(companyId), (error: unknown) => (error as { status?: number }).status === 404 && (error as Error).message === companyNotFound);
  }
  assert.equal(ran, false, 'no company work runs before authorization succeeds');
  // Creating a company in a workspace the user is not in is refused the same way as a missing workspace.
  const w1 = (await a.call('/api/me')).body.workspaces.find((w: { name: string }) => w.name === 'W1').id;
  const intruding = await b.call(`/api/workspaces/${w1}/companies`, { name: 'Intruder', ...books });
  assert.deepEqual(intruding, await b.call(`/api/workspaces/${randomUUID()}/companies`, { name: 'Intruder', ...books }));
  assert.equal(intruding.status, 404);
});

test('row-level security hides company rows from hand-written SQL through the application role', async () => {
  const { pool } = getDatabase();
  const admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  try { assert.equal(Number((await admin.query('SELECT count(*) FROM company')).rows[0].count), 2, 'both companies exist'); }
  finally { await admin.end(); }

  // No app.company_ids: nothing is visible or writable.
  assert.equal((await pool.query('SELECT * FROM company')).rowCount, 0);
  assert.equal((await pool.query(`UPDATE company SET time_zone = 'UTC' WHERE company_id = $1`, [fixture.c1])).rowCount, 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.company_ids', '', true)");
    assert.equal((await client.query('SELECT * FROM company')).rowCount, 0, 'an empty list admits nothing');
    await client.query("SELECT set_config('app.company_ids', $1, true)", [fixture.c2]);
    assert.deepEqual((await client.query('SELECT company_id FROM company')).rows, [{ company_id: fixture.c2 }]);
    assert.equal((await client.query('SELECT * FROM company WHERE company_id = $1', [fixture.c1])).rowCount, 0, "another company's id returns no rows");
    assert.equal((await client.query(`UPDATE company SET time_zone = 'UTC' WHERE company_id = $1`, [fixture.c1])).rowCount, 0);
    await client.query('COMMIT');
    // The setting is transaction-local: the next transaction on the same connection sees nothing again.
    assert.equal((await client.query('SELECT * FROM company')).rowCount, 0);
    // A row for a company outside the list cannot be written in.
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.company_ids', $1, true)", [fixture.c2]);
    await assert.rejects(client.query(`INSERT INTO company(company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
      VALUES ($1, 'AED', 2, 1, 1, '2026-01-01', 'UTC')`, [fixture.c1]), (error: unknown) => (error as { code?: string }).code === '42501');
    await client.query('ROLLBACK');
    // The application role cannot switch the policy off.
    await assert.rejects(client.query('ALTER TABLE company NO FORCE ROW LEVEL SECURITY'), (error: unknown) => (error as { code?: string }).code === '42501');
  } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
});
