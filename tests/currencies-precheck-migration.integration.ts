import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrationFiles } from '../src/server/db.ts';
import { migrateDatabase } from '../src/server/startup-migrate.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';

/**
 * Migration 0012 on a database whose voucher lines carry another currency code (legal before 0012: the base-only check
 * tests the rate and the amounts, not the code). The migration stops and names them, and applies nothing; corrected, it
 * applies and its keys are validated against the rows (under the all-workspace scope: without one the forced company
 * policy hides every row and a validation passes without checking anything).
 */
const thisMigration = '0012_currencies.sql';
const earlier = migrationFiles.slice(0, migrationFiles.indexOf(thisMigration));
let database: TestDatabase;
let admin: pg.Client;
const user = randomUUID(), company = randomUUID();
let voucher = '';
const scoped = async (run: () => Promise<unknown>) => {
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', $1, true)", [company]);
  await run();
  await admin.query('COMMIT');
};

before(async () => {
  database = await freshDatabase('currencyprecheck', { migrations: earlier });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await admin.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [user, `owner-${user}@books.test`]);
  await admin.query("INSERT INTO workspace (id, name) VALUES ($1, 'Coded Lines')", [company]);
  await admin.query("INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [company, user]);
  await scoped(async () => {
    await admin.query(`INSERT INTO company (company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
      VALUES ($1, 'AED', 2, 1, 1, '2026-01-01', 'Asia/Dubai')`, [company]);
    await admin.query('SELECT ledger_seed_company($1)', [company]);
    const group = (await admin.query("SELECT id FROM account_group WHERE company_id = $1 AND system_key = 'capital'", [company])).rows[0].id;
    const capital = (await admin.query("INSERT INTO ledger (company_id, group_id, name) VALUES ($1, $2, 'Capital') RETURNING id", [company, group])).rows[0].id;
    const cash = (await admin.query("SELECT id FROM ledger WHERE company_id = $1 AND system_key = 'cash'", [company])).rows[0].id;
    const type = (await admin.query("SELECT id, numbering_series FROM voucher_type WHERE company_id = $1 AND kind = 'journal'", [company])).rows[0];
    voucher = (await admin.query(`INSERT INTO voucher (company_id, voucher_type_id, series, date, status, idempotency_key, request_hash, created_by)
      VALUES ($1, $2, $3, '2026-01-05', 'optional', $4, $5, $6) RETURNING id`, [company, type.id, type.numbering_series, `coded-${randomUUID()}`, 'a'.repeat(64), user])).rows[0].id;
    await admin.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
      VALUES ($1, $2, 1, $3, 'Dr', 100, 'USD', 100, 1), ($1, $2, 2, $4, 'Cr', 100, 'USD', 100, 1)`, [company, voucher, cash, capital]);
  });
});
after(async () => { await admin?.end(); await database?.drop(); });

test('lines in another currency code stop the migration, which names them and applies nothing; corrected, it applies with validated keys', async () => {
  await assert.rejects(migrateDatabase({ log: () => undefined }), /Database migration failed \(PostgreSQL error P0001\) and was rolled back; nothing was applied/);
  // The runner reports only the SQLSTATE; run as the migrator (and rolled back), the file's own refusal names the rows.
  const migrator = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await migrator.connect();
  try {
    await migrator.query('BEGIN');
    await assert.rejects(migrator.query(readFileSync(join(process.cwd(), 'migrations', thisMigration), 'utf8')),
      new RegExp(`carry a currency other than their company's base currency; correct them first: voucher lines in company ${company}: 2 row\\(s\\), e\\.g\\. voucher ${voucher} line 1 in USD, voucher ${voucher} line 2 in USD$`));
  } finally { await migrator.query('ROLLBACK').catch(() => undefined); await migrator.end(); }
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), earlier.length, '0012 was not applied');

  await scoped(() => admin.query("UPDATE voucher_line SET currency = 'AED' WHERE company_id = $1 AND voucher_id = $2", [company, voucher]));
  await migrateDatabase({ log: () => undefined });
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), migrationFiles.length);
  const keys = (await admin.query(`SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1) ORDER BY 1`, [['bill_allocation_currency_fkey', 'bill_currency_fkey', 'ledger_currency_fkey', 'voucher_line_currency_fkey']])).rows;
  assert.deepEqual(keys.map(key => [key.conname, key.convalidated]), [['bill_allocation_currency_fkey', true], ['bill_currency_fkey', true], ['ledger_currency_fkey', true], ['voucher_line_currency_fkey', true]]);
});
