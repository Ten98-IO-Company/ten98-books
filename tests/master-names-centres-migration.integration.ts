import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrationFiles } from '../src/server/db.ts';
import { createCostCategory, createCostCentre } from '../src/server/ledger/cost-centres.ts';
import { migrateDatabase } from '../src/server/startup-migrate.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { inCompany } from './helpers/ledger.ts';
import { assertMigrationRefuses, earlier, earlierCompany, inEarlierCompany } from './helpers/master-names-migration.ts';

/**
 * Migration 0010 when the only names the key makes one are cost centres (in two categories: centre names are unique
 * across categories): the refusal names the cost centres alone; renamed, the migration applies.
 */
let database: TestDatabase;
let admin: pg.Client;
const user = randomUUID(), company = randomUUID();
const ids: Record<string, string> = {};

before(async () => {
  database = await freshDatabase('masternamescentres', { migrations: earlier });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await earlierCompany(admin, user, company);
  await inCompany(user, company, async context => {
    const area = (await createCostCategory(context, { name: 'Area' })).id, channel = (await createCostCategory(context, { name: 'Channel' })).id;
    ids.first = (await createCostCentre(context, { name: 'North-1', categoryId: area, parentId: null })).id;
    ids.second = (await createCostCentre(context, { name: 'north1', categoryId: channel, parentId: null })).id;
  }, 'write');
});
after(async () => { await admin?.end(); await database?.drop(); });

test('a clash in cost centres alone stops the migration, which names only the cost centres; renamed, it applies', async () => {
  await assert.rejects(migrateDatabase({ log: () => undefined }), /Database migration failed \(PostgreSQL error P0001\)/);
  await assertMigrationRefuses(/rename them first: cost centres in company [^:]+: (North-1, north1|north1, North-1)$/);
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), earlier.length, '0010 was not applied');

  await inEarlierCompany(admin, company, () => admin.query("UPDATE cost_centre SET name = 'North 2', revision = revision + 1 WHERE company_id = $1 AND id = $2", [company, ids.second]));
  await migrateDatabase({ log: () => undefined });
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), migrationFiles.length);
  assert.deepEqual((await admin.query('SELECT name FROM cost_centre WHERE id = ANY($1)', [[ids.first, ids.second]])).rows.map(row => row.name).sort(), ['North 2', 'North-1'].sort());
});
