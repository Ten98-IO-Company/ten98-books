import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { handleApi } from '../src/server/api.ts';
import { getConfig } from '../src/server/config.ts';
import { createPool, getDatabase } from '../src/server/db.ts';
import { assertApplicationRole } from '../src/server/startup-migrate.ts';
import { assertDatabaseRoles, companyNotFound, companyNotSetUp, DatabaseRoleError, withCompany } from '../src/server/tenancy.ts';
import { Browser, freshDatabase, type TestDatabase } from './helpers/database.ts';

let database: TestDatabase;
const browser = () => new Browser(handleApi, getConfig().appUrl);
const books = { baseCurrency: 'AED', financialYearStart: { month: 1, day: 1 }, booksBeginning: '2026-01-01', timeZone: 'Asia/Dubai' };
const password = 'correct horse battery staple';
// D-03: a company is a workspace. A owns W1 (from first-user setup, not set up yet), company C1 and company C2.
// B is an admin of C2 only.
const fixture = { aId: '', bId: '', c1: '', c2: '', w1: '', inviteToken: '' };
let a: Browser, b: Browser;

before(async () => {
  database = await freshDatabase('tenancy');
  a = browser(); b = browser();
  const aEmail = `a-${randomUUID()}@books.test`, bEmail = `b-${randomUUID()}@books.test`;
  assert.equal((await a.call('/api/auth/setup', { name: 'A', email: aEmail, password, workspaceName: 'W1' })).status, 200);
  const me = (await a.call('/api/me')).body;
  fixture.aId = me.user.id;
  fixture.w1 = me.workspaces[0].id;
  fixture.c1 = (await a.call('/api/companies', { name: 'C1', ...books })).body.company.id;
  fixture.c2 = (await a.call('/api/companies', { name: 'C2', ...books, baseCurrency: 'SAR' })).body.company.id;
  const invite = (await a.call(`/api/workspaces/${fixture.c2}/invitations`, { email: bEmail, role: 'admin' })).body.inviteUrl as string;
  fixture.inviteToken = new URL(invite).hash.replace('#invite=', '');
  const accepted = await b.call('/api/invitations/accept', { token: fixture.inviteToken, name: 'B', password });
  assert.equal(accepted.body.signedIn, true);
  fixture.bId = (await b.call('/api/me')).body.user.id;
  // B is a member of C2 only, so C1 and W1 are outside B's reach.
  assert.ok(fixture.c1 && fixture.c2);
  assert.deepEqual((await b.call('/api/companies')).body.companies.map((item: { id: string; role: string }) => [item.id, item.role]), [[fixture.c2, 'admin']]);
});

/** A superuser connection to this test database, for fixtures the application role must not be able to create. */
async function asAdmin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: database.adminUrl });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}
const refusedAsMissing = (error: unknown) => (error as { status?: number }).status === 404 && (error as Error).message === companyNotFound;
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

test('a user from another company gets the same not-found answer as for a missing company, on read and write', async () => {
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
  // Setting up a company the user is not in is refused the same way as a missing company, and writes nothing.
  const intruding = await b.call(`/api/companies/${fixture.w1}/setup`, { name: 'Intruder', ...books });
  assert.deepEqual(intruding, await b.call(`/api/companies/${randomUUID()}/setup`, { name: 'Intruder', ...books }));
  assert.deepEqual(intruding, { status: 404, body: { error: companyNotFound } });
  assert.equal(Number((await asAdmin(admin => admin.query('SELECT count(*) FROM company WHERE company_id = $1', [fixture.w1]))).rows[0].count), 0);
  assert.equal((await asAdmin(admin => admin.query('SELECT name FROM workspace WHERE id = $1', [fixture.w1]))).rows[0].name, 'W1');
  // Nor can they read or change its team.
  assert.equal((await b.call(`/api/workspaces/${fixture.c1}/team`)).status, 404);
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
    // A row for a company outside the list cannot be written in. The target is a real workspace with no company row yet,
    // so neither a duplicate key nor a missing foreign key could explain the refusal: only the policy can.
    const unused = randomUUID();
    await asAdmin(admin => admin.query("INSERT INTO workspace(id, name) VALUES ($1, 'Unused')", [unused]));
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.company_ids', $1, true)", [fixture.c2]);
    await assert.rejects(client.query(`INSERT INTO company(company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
      VALUES ($1, 'AED', 2, 1, 1, '2026-01-01', 'UTC')`, [unused]), (error: unknown) => (error as { code?: string }).code === '42501');
    await client.query('ROLLBACK');
    assert.equal(Number((await asAdmin(admin => admin.query('SELECT count(*) FROM company WHERE company_id = $1', [unused]))).rows[0].count), 0);
    // The application role cannot switch the policy off.
    await assert.rejects(client.query('ALTER TABLE company NO FORCE ROW LEVEL SECURITY'), (error: unknown) => (error as { code?: string }).code === '42501');
  } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
});

test('the boot assertion requires exactly the company policy on every accounting table', async () => {
  const { pool } = getDatabase();
  await asAdmin(async admin => {
    for (const table of ['probe_exact', 'probe_open', 'probe_extra']) {
      await admin.query(`CREATE TABLE ${table} (company_id text NOT NULL)`);
      await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await admin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    const scope = "company_id = ANY (string_to_array(current_setting('app.company_ids', true), ','))";
    await admin.query(`CREATE POLICY probe_exact_scope ON probe_exact USING (${scope}) WITH CHECK (${scope})`);
    await admin.query('CREATE POLICY probe_open_scope ON probe_open USING (true) WITH CHECK (true)');
    await admin.query(`CREATE POLICY probe_extra_scope ON probe_extra USING (${scope}) WITH CHECK (${scope})`);
    await admin.query('CREATE POLICY probe_extra_read ON probe_extra FOR SELECT USING (true)');
  });
  // The same expression the migration declares passes, so the check matches PostgreSQL's stored form.
  await assertDatabaseRoles(pool, ['company', 'probe_exact']);
  await assert.rejects(assertDatabaseRoles(pool, ['company', 'probe_open']), /company policy is missing, altered or accompanied by another policy on probe_open/);
  await assert.rejects(assertDatabaseRoles(pool, ['company', 'probe_extra']), /company policy is missing, altered or accompanied by another policy on probe_extra/);
});

test('the company scope ends with the withCompany transaction and never leaks to the pooled connection', async () => {
  const { pool } = getDatabase();
  let backend = 0;
  await withCompany(fixture.bId, fixture.c2, 'read', async client => {
    backend = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    assert.equal((await client.query('SELECT * FROM company')).rowCount, 1);
  });
  // pg-pool hands out the most recently released idle client, so this is the connection withCompany just used.
  const client = await pool.connect();
  try {
    assert.equal((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid, backend, 'the same pooled connection');
    assert.ok(!(await client.query<{ scope: string | null }>("SELECT current_setting('app.company_ids', true) AS scope")).rows[0].scope);
    assert.equal((await client.query('SELECT * FROM company')).rowCount, 0);
  } finally { client.release(); }
});

test('a used invitation cannot be accepted again', async () => {
  const members = async () => (await getDatabase().pool.query('SELECT user_id FROM membership WHERE workspace_id = $1 ORDER BY user_id', [fixture.c2])).rows;
  const before = await members();
  const stranger = await browser().call('/api/invitations/accept', { token: fixture.inviteToken, name: 'Someone else', password });
  assert.ok(stranger.status >= 400 && stranger.status < 500, `refused, got ${stranger.status}`);
  const again = await b.call('/api/invitations/accept', { token: fixture.inviteToken });
  assert.ok(again.status >= 400 && again.status < 500, `refused, got ${again.status}`);
  assert.deepEqual(await members(), before);
});

test('a company without books settings reports that it is not set up; an owner or admin sets it up once', async () => {
  const listed = (await a.call('/api/companies')).body.companies.find((item: { id: string }) => item.id === fixture.w1);
  assert.deepEqual(listed, { id: fixture.w1, name: 'W1', role: 'owner', twoFactorLocked: false, company: null });
  // Members are told the company is not set up on every books route; a non-member gets the answer for a missing company.
  const notSetUp = { status: 409, body: { error: companyNotSetUp, code: 'not_set_up' } };
  const period = 'from=2026-01-01&to=2026-01-31';
  const bookRoutes = (id: string) => [`/api/companies/${id}`, `/api/companies/${id}/groups`, `/api/companies/${id}/ledgers`, `/api/companies/${id}/voucher-types`,
    `/api/companies/${id}/vouchers?${period}`, `/api/companies/${id}/trial-balance?${period}`, `/api/companies/${id}/reports/defaults`,
    `/api/companies/${id}/reports/trial-balance?${period}`, `/api/companies/${id}/reports/trial-balance/export?${period}`];
  for (const path of bookRoutes(fixture.w1)) {
    assert.deepEqual(await a.call(path), notSetUp, path);
    const missing = path.replace(fixture.w1, randomUUID());
    assert.deepEqual(await b.call(path), await b.call(missing), `${path}: a non-member's answer is the missing company's`);
    assert.equal((await b.call(path)).status, 404, path);
  }
  assert.deepEqual(await a.call(`/api/companies/${fixture.w1}/vouchers`, { idempotencyKey: `x-${randomUUID()}`, voucherTypeId: randomUUID(), date: '2026-01-02', lines: [] }), notSetUp, 'writes too');

  // An editor of the company may not set it up; the refusal writes nothing.
  const editorEmail = `editor-${randomUUID()}@books.test`;
  const token = new URL((await a.call(`/api/workspaces/${fixture.w1}/invitations`, { email: editorEmail, role: 'editor' })).body.inviteUrl).hash.replace('#invite=', '');
  const editor = browser();
  assert.equal((await editor.call('/api/invitations/accept', { token, name: 'Editor', password })).body.signedIn, true);
  assert.equal((await editor.call(`/api/companies/${fixture.w1}/setup`, { name: 'Editor Books', ...books })).status, 403);

  const setUp = await a.call(`/api/companies/${fixture.w1.toUpperCase()}/setup`, { name: 'W1 Trading', ...books });
  assert.equal(setUp.status, 200, JSON.stringify(setUp.body));
  assert.equal(setUp.body.company.id, fixture.w1);
  assert.equal(setUp.body.company.name, 'W1 Trading', 'the name entered at setup becomes the company name');
  assert.deepEqual((await editor.call(`/api/companies/${fixture.w1}`)).body, setUp.body, 'every member now reads the company');
  assert.equal((await editor.call(`/api/companies/${fixture.w1}/groups`)).status, 200, 'and its seeded chart');
  assert.deepEqual(await a.call(`/api/companies/${fixture.w1}/setup`, { name: 'Again', ...books, baseCurrency: 'USD' }),
    { status: 409, body: { error: 'This company is already set up.', code: 'already_set_up' } });
  assert.equal((await a.call(`/api/companies/${fixture.w1}`)).body.company.baseCurrency, 'AED');

  // Renaming the company renames the workspace: one name. Owners and admins only.
  assert.equal((await editor.call(`/api/workspaces/${fixture.w1}/rename`, { name: 'Editor Name' })).status, 404);
  assert.equal((await a.call(`/api/workspaces/${fixture.w1}/rename`, { name: 'W1 Holdings' })).status, 200);
  assert.equal((await editor.call(`/api/companies/${fixture.w1}`)).body.company.name, 'W1 Holdings');
  assert.equal((await editor.call('/api/me')).body.workspaces[0].name, 'W1 Holdings');
});

test('creating a company is atomic: when seeding fails, no workspace, membership or settings remain', async () => {
  const counts = () => asAdmin(async admin => (await admin.query(
    'SELECT (SELECT count(*) FROM workspace) AS workspaces, (SELECT count(*) FROM membership) AS memberships, (SELECT count(*) FROM company) AS companies, (SELECT count(*) FROM account_group) AS groups')).rows[0]);
  const before = await counts();
  await asAdmin(admin => admin.query('REVOKE EXECUTE ON FUNCTION ledger_seed_company(text) FROM books_app'));
  try {
    assert.equal((await a.call('/api/companies', { name: 'Half Made', ...books })).status, 500);
  } finally { await asAdmin(admin => admin.query('GRANT EXECUTE ON FUNCTION ledger_seed_company(text) TO books_app')); }
  assert.deepEqual(await counts(), before);
  assert.ok(!(await a.call('/api/companies')).body.companies.some((item: { name: string }) => item.name === 'Half Made'));
  assert.equal((await a.call('/api/companies', { name: 'Whole', ...books })).status, 201, 'the same request succeeds once seeding works');
});

test('a company that requires two-factor lists its name only to a member without a factor and refuses its routes', async () => {
  await asAdmin(admin => admin.query('INSERT INTO workspace_two_factor_requirement(workspace_id) VALUES ($1)', [fixture.c2]));
  try {
    assert.deepEqual((await b.call('/api/companies')).body.companies, [{ id: fixture.c2, name: 'C2', role: 'admin', twoFactorLocked: true, company: null }]);
    assert.equal((await b.call(`/api/companies/${fixture.c2}`)).status, 403);
    assert.equal((await b.call(`/api/companies/${fixture.c2}/groups`)).status, 403);
  } finally { await asAdmin(admin => admin.query('DELETE FROM workspace_two_factor_requirement WHERE workspace_id = $1', [fixture.c2])); }
  assert.equal((await b.call(`/api/companies/${fixture.c2}`)).status, 200);
});

test('companies come only from first-user setup and create company; a repeated create with one key makes one company', async () => {
  const workspaces = async () => Number((await asAdmin(admin => admin.query('SELECT count(*) FROM workspace'))).rows[0].count);
  const start = await workspaces();
  assert.equal((await a.call('/api/workspaces', { name: 'Bare workspace' })).status, 404, 'no workspace without books settings');
  assert.equal(await workspaces(), start);

  // A double submit: both requests carry the form's key and arrive together.
  const body = { name: 'Twice Submitted', ...books, idempotencyKey: `create-${randomUUID()}` };
  const [first, second] = await Promise.all([a.call('/api/companies', body), a.call('/api/companies', body)]);
  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  assert.equal(first.body.company.id, second.body.company.id);
  assert.deepEqual([first.body.replayed, second.body.replayed].sort(), [false, true]);
  assert.equal(await workspaces(), start + 1);
  assert.deepEqual(await a.call('/api/companies', { ...body, name: 'Something Else' }), { status: 409,
    body: { error: 'This request key was already used for a different company. Send a new key for a new company.', code: 'idempotency_mismatch' } });
  // The key is the caller's own: another user with the same key creates their own company.
  const other = await b.call('/api/companies', body);
  assert.equal(other.status, 201);
  assert.notEqual(other.body.company.id, first.body.company.id);
  assert.equal((await a.call('/api/companies', { ...body, idempotencyKey: 'short' })).status, 400);
  assert.equal(await workspaces(), start + 2);
});

test('setting up a company never makes a non-member wait on, or lock, its workspace row', async () => {
  const holder = new pg.Client({ connectionString: database.adminUrl });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM workspace WHERE id = $1 FOR UPDATE', [fixture.w1]);
    const started = Date.now();
    const refused = await b.call(`/api/companies/${fixture.w1}/setup`, { name: 'Intruder', ...books });
    assert.deepEqual(refused, { status: 404, body: { error: companyNotFound } });
    assert.ok(Date.now() - started < 2000, 'answered while the row stayed locked');
  } finally { await holder.query('ROLLBACK').catch(() => undefined); await holder.end(); }
});

// Last: these change B's membership.
test('a demotion waits for an in-flight company write; then the viewer, and later the removed member, cannot write', async () => {
  const write = () => withCompany(fixture.bId, fixture.c2, 'write', client => client.query("UPDATE company SET time_zone = 'Asia/Riyadh' WHERE company_id = $1", [fixture.c2]));
  let demotion: Promise<{ status: number }> | undefined;
  let settled = false;
  await withCompany(fixture.bId, fixture.c2, 'write', async client => {
    demotion = a.call(`/api/workspaces/${fixture.c2}/members/${fixture.bId}/role`, { role: 'viewer' }).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal(settled, false, 'the demotion cannot commit while the write that checked the old role is open');
    assert.equal((await client.query("UPDATE company SET time_zone = 'Asia/Riyadh' WHERE company_id = $1", [fixture.c2])).rowCount, 1);
  });
  assert.equal((await demotion!).status, 200);

  await assert.rejects(write(), refusedAsMissing, 'a viewer cannot write');
  assert.equal((await b.call(`/api/companies/${fixture.c2}`)).status, 200, 'a viewer still reads');

  assert.equal((await a.call(`/api/workspaces/${fixture.c2}/members/${fixture.bId}/remove`, {})).status, 200);
  await assert.rejects(write(), refusedAsMissing, 'a removed member cannot write');
  await assert.rejects(withCompany(fixture.bId, fixture.c2, 'read', async () => undefined), refusedAsMissing, 'a removed member cannot read');
  assert.deepEqual((await b.call(`/api/companies/${fixture.c2}`)).body, { error: companyNotFound });
});
