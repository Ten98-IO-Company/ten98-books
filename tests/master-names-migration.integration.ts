import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrationFiles } from '../src/server/db.ts';
import { createCostCategory, createCostCentre } from '../src/server/ledger/cost-centres.ts';
import { createGroup, createLedger } from '../src/server/ledger/masters.ts';
import { migrateDatabase } from '../src/server/startup-migrate.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { inCompany } from './helpers/ledger.ts';

/**
 * Migration 0010 on a database an earlier release left: names that were apart under lower-case comparison and become one
 * under the name match key stop the migration, which names them and changes nothing; once renamed, the migration
 * applies and the masters keep their rows and names.
 */
const thisMigration = '0010_master_names.sql';
const earlier = migrationFiles.slice(0, migrationFiles.indexOf(thisMigration));
let database: TestDatabase;
let admin: pg.Client;
const user = randomUUID(), company = randomUUID();
const ids: Record<string, string> = {};

before(async () => {
  database = await freshDatabase('masternames', { migrations: earlier });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await admin.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [user, `owner-${user}@books.test`]);
  await admin.query("INSERT INTO workspace (id, name) VALUES ($1, 'Earlier Names')", [company]);
  await admin.query("INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [company, user]);
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', $1, true)", [company]);
  await admin.query(`INSERT INTO company (company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
    VALUES ($1, 'AED', 2, 1, 1, '2026-01-01', 'Asia/Dubai')`, [company]);
  await admin.query('SELECT ledger_seed_company($1)', [company]);
  await admin.query('COMMIT');
  // Names an earlier release kept apart (it compared them in lower case only).
  await inCompany(user, company, async context => {
    const group = async (key: string) => (await context.client.query('SELECT id FROM account_group WHERE company_id = $1 AND system_key = $2', [company, key])).rows[0].id;
    const expenses = await group('indirect_expenses');
    ids.first = (await createLedger(context, { name: 'Rent-A', groupId: expenses })).id;
    ids.second = (await createLedger(context, { name: 'RentA', groupId: expenses })).id;
    ids.group = (await createGroup(context, { name: 'Office Costs', parentId: expenses })).id;
    const category = (await createCostCategory(context, { name: 'Area' })).id;
    ids.centre = (await createCostCentre(context, { name: 'North_1', categoryId: category, parentId: null })).id;
  }, 'write');
});
after(async () => { await admin?.end(); await database?.drop(); });

test('names that become one under the key stop the migration, which names them; renamed, it applies and keeps every row', async () => {
  await assert.rejects(migrateDatabase({ log: () => undefined }), /Database migration failed \(PostgreSQL error P0001\) and was rolled back; nothing was applied/);
  // The runner reports only the SQLSTATE; run as the migrator, the file's own refusal names the table, company and names.
  const migrator = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await migrator.connect();
  try {
    await migrator.query('BEGIN');
    await assert.rejects(migrator.query(readFileSync(join(process.cwd(), 'migrations', thisMigration), 'utf8')),
      /these master names become one name under the name match key; rename them first: ledgers in company [^:]+: Rent-A, RentA/);
  } finally { await migrator.query('ROLLBACK').catch(() => undefined); await migrator.end(); }
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), earlier.length, '0010 was not applied');

  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', $1, true)", [company]);
  await admin.query("UPDATE ledger SET name = 'Rent B', revision = revision + 1 WHERE company_id = $1 AND id = $2", [company, ids.second]);
  await admin.query('COMMIT');
  const before = (await admin.query('SELECT (SELECT count(*) FROM account_group)::int AS groups, (SELECT count(*) FROM ledger)::int AS ledgers, (SELECT count(*) FROM cost_centre)::int AS centres')).rows[0];
  await migrateDatabase({ log: () => undefined });
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), migrationFiles.length);
  assert.deepEqual((await admin.query('SELECT (SELECT count(*) FROM account_group)::int AS groups, (SELECT count(*) FROM ledger)::int AS ledgers, (SELECT count(*) FROM cost_centre)::int AS centres')).rows[0], before);
  assert.deepEqual((await admin.query('SELECT name FROM ledger WHERE id = ANY($1)', [[ids.first, ids.second]])).rows.map(row => row.name).sort(), ['Rent B', 'Rent-A'].sort());
});
