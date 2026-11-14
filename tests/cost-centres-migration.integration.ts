import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrationFiles } from '../src/server/db.ts';
import { toJson } from '../src/server/api/http.ts';
import { readLedger } from '../src/server/ledger/masters.ts';
import { migrateDatabase } from '../src/server/startup-migrate.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { inCompany } from './helpers/ledger.ts';

/**
 * Migration 0008 on a database an earlier release left with two companies that have postings: every company gets the
 * general cost category once, existing income and expense ledgers take cost centres (each with a logged alter whose
 * snapshots are the ledger as the API returns it), other ledgers and the company feature stay off, and nothing posted
 * changes.
 */
const thisMigration = '0008_cost_centres.sql';
const earlier = migrationFiles.slice(0, migrationFiles.indexOf(thisMigration));
let database: TestDatabase;
let admin: pg.Client;
const user = randomUUID();
const companies = [randomUUID(), randomUUID()];
const ledgers: Record<string, Record<string, string>> = {};
const balances = () => admin.query(`SELECT company_id, ledger_id, side, sum(amount)::text AS amount FROM voucher_line GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`).then(result => result.rows);
let before0008: unknown[] = [];

before(async () => {
  database = await freshDatabase('costupgrade', { migrations: earlier });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await admin.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [user, `owner-${user}@books.test`]);
  for (const company of companies) {
    await admin.query("INSERT INTO workspace (id, name) VALUES ($1, 'Earlier Costs')", [company]);
    await admin.query("INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [company, user]);
    await admin.query('BEGIN');
    await admin.query("SELECT set_config('app.company_ids', $1, true)", [company]);
    await admin.query(`INSERT INTO company (company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
      VALUES ($1, 'AED', 2, 1, 1, '2026-01-01', 'Asia/Dubai')`, [company]);
    await admin.query('SELECT ledger_seed_company($1)', [company]);
    const group = async (key: string) => (await admin.query('SELECT id FROM account_group WHERE company_id = $1 AND system_key = $2', [company, key])).rows[0].id;
    const add = async (name: string, groupKey: string) => (await admin.query('INSERT INTO ledger (company_id, group_id, name) VALUES ($1, $2, $3) RETURNING id',
      [company, await group(groupKey), name])).rows[0].id as string;
    ledgers[company] = { sales: await add('Sales', 'sales'), rent: await add('Rent', 'indirect_expenses'), equipment: await add('Equipment', 'fixed_assets') };
    ledgers[company].cash = (await admin.query("SELECT id FROM ledger WHERE company_id = $1 AND system_key = 'cash'", [company])).rows[0].id;
    const type = (await admin.query("SELECT id, numbering_series FROM voucher_type WHERE company_id = $1 AND kind = 'journal'", [company])).rows[0];
    const voucher = (await admin.query(`INSERT INTO voucher (company_id, voucher_type_id, series, date, status, idempotency_key, request_hash, created_by)
      VALUES ($1, $2, $3, '2026-01-05', 'optional', $4, $5, $6) RETURNING id`, [company, type.id, type.numbering_series, `earlier-${randomUUID()}`, 'a'.repeat(64), user])).rows[0].id;
    await admin.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
      VALUES ($1, $2, 1, $3, 'Dr', 100, 'AED', 100, 1), ($1, $2, 2, $4, 'Cr', 100, 'AED', 100, 1)`, [company, voucher, ledgers[company].rent, ledgers[company].sales]);
    await admin.query('COMMIT');
  }
  before0008 = await balances();
  await migrateDatabase({ log: () => undefined });
});
after(async () => { await admin?.end(); await database?.drop(); });

test('each company gets the general category once, and seeding it again changes nothing', async () => {
  const general = async () => (await admin.query(`SELECT company_id, system_key, name, allocate_revenue, allocate_non_revenue FROM cost_category ORDER BY company_id`)).rows;
  const once = await general();
  assert.deepEqual(once.map(row => [row.system_key, row.name, row.allocate_revenue, row.allocate_non_revenue]), [['primary', 'General', true, true], ['primary', 'General', true, true]]);
  assert.deepEqual(once.map(row => row.company_id).sort(), [...companies].sort());
  for (const company of companies) {
    await admin.query('BEGIN');
    await admin.query("SELECT set_config('app.company_ids', $1, true)", [company]);
    await admin.query('SELECT ledger_seed_company($1)', [company]);
    await admin.query('COMMIT');
  }
  assert.deepEqual(await general(), once);
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), migrationFiles.length);
});

test('existing income and expense ledgers take cost centres, each with a logged alter in the API\'s shape; the rest and the company feature stay off', async () => {
  const flags = await admin.query(`SELECT l.company_id, l.name, l.cost_centres, l.revision FROM ledger l WHERE l.name IN ('Sales', 'Rent', 'Equipment') OR l.system_key IS NOT NULL ORDER BY 1, 2`);
  for (const company of companies) {
    const mine = flags.rows.filter(row => row.company_id === company);
    assert.deepEqual(mine.filter(row => ['Sales', 'Rent', 'Equipment'].includes(row.name)).map(row => [row.name, row.cost_centres, row.revision]),
      [['Equipment', false, 1], ['Rent', true, 2], ['Sales', true, 2]]);
    assert.ok(mine.filter(row => !['Sales', 'Rent', 'Equipment'].includes(row.name)).every(row => !row.cost_centres), 'seeded ledgers (cash, profit and loss) stay off');
    const log = (await admin.query(`SELECT entity_id, action, actor_id, before, after FROM revision_log WHERE company_id = $1 AND actor_id = 'migration:0008_cost_centres' ORDER BY entity_id`, [company])).rows;
    assert.deepEqual(log.map(row => [row.entity_id, row.action]).sort(), [[ledgers[company].rent, 'alter'], [ledgers[company].sales, 'alter']].sort());
    for (const entry of log) {
      const now = JSON.parse(toJson(await inCompany(user, company, context => readLedger(context, entry.entity_id))));
      assert.deepEqual(entry.after, now, 'the after snapshot is the ledger as the API reads it');
      assert.deepEqual(entry.before, { ...now, costCentres: false, revision: now.revision - 1 });
    }
  }
  assert.deepEqual((await admin.query('SELECT DISTINCT cost_centres_enabled FROM company')).rows, [{ cost_centres_enabled: false }]);
  assert.deepEqual(await balances(), before0008, 'nothing posted changes');
  assert.equal(Number((await admin.query('SELECT count(*) FROM cost_allocation')).rows[0].count), 0);
});
