import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { seedDemo, seededTables } from '../src/server/demo/seed.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { invite, setupOwner, type Member } from './helpers/ledger.ts';

/**
 * The last step of `seed:demo`: the tables it filled are analysed through the owner role, and the step is checked, not
 * assumed. Autovacuum is off on those tables here, so their statistics come from the seed command alone.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

const admin = async <T>(run: (client: pg.Client) => Promise<T>) => {
  const client = new pg.Client({ connectionString: database.adminUrl });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
};
/** reltuples per seeded table: -1 until the table has statistics. */
const statistics = () => admin(async client => Object.fromEntries((await client.query<{ name: string; tuples: number }>(
  'SELECT relname AS name, reltuples::float8 AS tuples FROM pg_class WHERE oid = ANY($1::text[]::regclass[]) ORDER BY relname', [seededTables])).rows.map(row => [row.name, row.tuples])));
const emailOf = async (member: Member) => (await member.browser.call('/api/me')).body.user.email as string;
/** Seeds starter-trading for a new member (a company of their own) with MIGRATION_DATABASE_URL set to `url`; the printed lines. */
async function seedWith(url: string | undefined): Promise<string[]> {
  const member = await invite(owner.browser, owner.workspaceId, 'viewer');
  const saved = process.env.MIGRATION_DATABASE_URL;
  if (url === undefined) delete process.env.MIGRATION_DATABASE_URL; else process.env.MIGRATION_DATABASE_URL = url;
  const lines: string[] = [];
  try { await seedDemo({ email: await emailOf(member), company: 'starter-trading', yes: true }, line => lines.push(line)); }
  finally { process.env.MIGRATION_DATABASE_URL = saved; }
  return lines;
}

before(async () => {
  database = await freshDatabase('demo_statistics');
  owner = await setupOwner();
  await admin(async client => { for (const table of seededTables) await client.query(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`); });
});
after(async () => { await database?.drop(); });

const unanalysed = Object.fromEntries(seededTables.map(table => [table, -1]));

test('without the owner URL the seed succeeds, says the statistics were not refreshed, and the tables stay unanalysed', async () => {
  const lines = await seedWith(undefined);
  assert.match(lines[0], /^Starter Trading \(starter-trading\): seeded$/);
  assert.equal(lines.at(-1), 'statistics not refreshed: MIGRATION_DATABASE_URL is not set; set MIGRATION_DATABASE_URL and run again, or wait for autoanalyze');
  assert.deepEqual(await statistics(), unanalysed);
});

test('the application role in that variable is reported as not refreshed, not passed on its skipping notice', async () => {
  const lines = await seedWith(process.env.DATABASE_URL);
  assert.equal(lines.at(-1), 'statistics not refreshed: the role of MIGRATION_DATABASE_URL may not analyse voucher, voucher_line, inventory_line (it is not the owner role); set MIGRATION_DATABASE_URL and run again, or wait for autoanalyze');
  assert.deepEqual(await statistics(), unanalysed);
});

test('with the owner URL the seeded tables have statistics afterwards, and the summary says so', async () => {
  const lines = await seedWith(process.env.MIGRATION_DATABASE_URL);
  assert.equal(lines.at(-1), 'statistics refreshed for voucher, voucher_line, inventory_line');
  const after = await statistics();
  assert.ok(seededTables.every(table => after[table] >= 0), JSON.stringify(after));
  assert.equal(after.voucher, 54, 'the three companies\' 18 vouchers each');
});
