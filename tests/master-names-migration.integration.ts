import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrationFiles } from '../src/server/db.ts';
import { createCostCategory, createCostCentre } from '../src/server/ledger/cost-centres.ts';
import { createGroup } from '../src/server/ledger/masters.ts';
import { migrateDatabase } from '../src/server/startup-migrate.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { inCompany } from './helpers/ledger.ts';
import { assertMigrationRefuses, earlier, earlierCompany, inEarlierCompany } from './helpers/master-names-migration.ts';

/**
 * Migration 0010 on a database an earlier release left: names that were apart under lower-case comparison and become one
 * under the name match key, here in two tables at once (groups and ledgers), stop the migration, which names every clash
 * and changes nothing; once renamed, the migration applies and the masters keep their rows and names.
 * master-names-centres-migration covers a clash in cost centres alone.
 */
let database: TestDatabase;
let admin: pg.Client;
const user = randomUUID(), company = randomUUID();
const ids: Record<string, string> = {};

before(async () => {
  database = await freshDatabase('masternames', { migrations: earlier });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await earlierCompany(admin, user, company);
  // Names an earlier release kept apart (it compared them in lower case only).
  await inCompany(user, company, async context => {
    const group = async (key: string) => (await context.client.query('SELECT id FROM account_group WHERE company_id = $1 AND system_key = $2', [company, key])).rows[0].id;
    const expenses = await group('indirect_expenses');
    ids.first = (await context.client.query('INSERT INTO ledger (company_id, group_id, name) VALUES ($1, $2, $3) RETURNING id', [company, expenses, 'Rent-A'])).rows[0].id;
    ids.second = (await context.client.query('INSERT INTO ledger (company_id, group_id, name) VALUES ($1, $2, $3) RETURNING id', [company, expenses, 'RentA'])).rows[0].id;
    ids.group = (await createGroup(context, { name: 'Office Costs', parentId: expenses })).id;
    ids.groupTwin = (await createGroup(context, { name: 'OfficeCosts', parentId: expenses })).id;
    const category = (await createCostCategory(context, { name: 'Area' })).id;
    ids.centre = (await createCostCentre(context, { name: 'North_1', categoryId: category, parentId: null })).id;
  }, 'write');
});
after(async () => { await admin?.end(); await database?.drop(); });

test('names that become one under the key in two tables stop the migration, which names both; renamed, it applies and keeps every row', async () => {
  await assert.rejects(migrateDatabase({ log: () => undefined }), /Database migration failed \(PostgreSQL error P0001\) and was rolled back; nothing was applied/);
  await assertMigrationRefuses(/rename them first: groups in company [^:]+: (Office Costs, OfficeCosts|OfficeCosts, Office Costs); ledgers in company [^:]+: (Rent-A, RentA|RentA, Rent-A)$/);
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), earlier.length, '0010 was not applied');

  // Renaming one side of one clash is not enough: the other table still stops the migration.
  await inEarlierCompany(admin, company, () => admin.query("UPDATE ledger SET name = 'Rent B', revision = revision + 1 WHERE company_id = $1 AND id = $2", [company, ids.second]));
  await assertMigrationRefuses(/rename them first: groups in company [^:]+: (Office Costs, OfficeCosts|OfficeCosts, Office Costs)$/);
  await inEarlierCompany(admin, company, () => admin.query("UPDATE account_group SET name = 'Office Costs 2', revision = revision + 1 WHERE company_id = $1 AND id = $2", [company, ids.groupTwin]));

  const counts = async () => (await admin.query('SELECT (SELECT count(*) FROM account_group)::int AS groups, (SELECT count(*) FROM ledger)::int AS ledgers, (SELECT count(*) FROM cost_centre)::int AS centres')).rows[0];
  const before = await counts();
  await migrateDatabase({ log: () => undefined });
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), migrationFiles.length);
  assert.deepEqual(await counts(), before);
  assert.deepEqual((await admin.query('SELECT name FROM ledger WHERE id = ANY($1)', [[ids.first, ids.second]])).rows.map(row => row.name).sort(), ['Rent B', 'Rent-A'].sort());
  assert.deepEqual((await admin.query('SELECT name FROM account_group WHERE id = ANY($1)', [[ids.group, ids.groupTwin]])).rows.map(row => row.name).sort(), ['Office Costs', 'Office Costs 2'].sort());
});
