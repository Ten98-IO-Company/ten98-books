import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrationFiles } from '../src/server/db.ts';
import { createLedger } from '../src/server/ledger/masters.ts';
import { createVoucher } from '../src/server/ledger/vouchers.ts';
import { migrateDatabase } from '../src/server/startup-migrate.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { inCompany } from './helpers/ledger.ts';

/**
 * Migration 0009 on a database whose party holds two bills that the new bill key makes one (AB1 and A-B1): the
 * migration stops, names them and changes nothing, rather than merging them silently.
 */
const earlier = migrationFiles.slice(0, migrationFiles.indexOf('0009_voucher_changes.sql'));
let database: TestDatabase;
let admin: pg.Client;
const user = randomUUID(), company = randomUUID();

before(async () => {
  database = await freshDatabase('billkeyclash', { migrations: earlier });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await admin.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [user, `owner-${user}@books.test`]);
  await admin.query("INSERT INTO workspace (id, name) VALUES ($1, 'Clashing Bills')", [company]);
  await admin.query("INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [company, user]);
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', $1, true)", [company]);
  await admin.query(`INSERT INTO company (company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
    VALUES ($1, 'AED', 2, 1, 1, '2026-01-01', 'Asia/Dubai')`, [company]);
  await admin.query('SELECT ledger_seed_company($1)', [company]);
  await admin.query('COMMIT');
  const posted = await inCompany(user, company, async context => {
    const group = async (key: string) => (await context.client.query('SELECT id FROM account_group WHERE company_id = $1 AND system_key = $2', [company, key])).rows[0].id;
    const sales = (await createLedger(context, { name: 'Sales', groupId: await group('sales') })).id;
    const party = (await createLedger(context, { name: 'Party', groupId: await group('receivables') })).id;
    const type = (await context.client.query("SELECT id FROM voucher_type WHERE company_id = $1 AND kind = 'sales'", [company])).rows[0].id;
    return (await createVoucher(context, { idempotencyKey: `earlier-${randomUUID()}`, voucherTypeId: type, date: '2026-02-01',
      lines: [{ ledgerId: party, side: 'Dr', amount: '100' }, { ledgerId: sales, side: 'Cr', amount: '100' }] })).voucher;
  }, 'write');
  // The earlier release kept these apart (it compared names by case only).
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', $1, true)", [company]);
  for (const name of ['AB1', 'A-B1']) {
    const bill = (await admin.query("INSERT INTO bill (company_id, ledger_id, name, currency) VALUES ($1, $2, $3, 'AED') RETURNING id", [company, posted.lines[0].ledgerId, name])).rows[0].id;
    await admin.query(`INSERT INTO bill_allocation (company_id, ledger_id, voucher_id, line_no, kind, bill_id, currency, side, amount, currency_amount, due_date)
      VALUES ($1, $2, $3, 1, 'new_ref', $4, 'AED', 'Dr', 5000, 5000, '2026-02-01')`, [company, posted.lines[0].ledgerId, posted.id, bill]);
  }
  await admin.query('COMMIT');
});
after(async () => { await admin?.end(); await database?.drop(); });

test('two bills of one party that the new key makes one stop the migration, which names them and merges nothing', async () => {
  await assert.rejects(migrateDatabase({ log: () => undefined }), /Database migration failed \(PostgreSQL error P0001\) and was rolled back; nothing was applied/);
  // The runner reports only the SQLSTATE to operators; the database log carries the text. Run as the migrator, the
  // file's own refusal names the company, the party and both spellings.
  const migrator = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await migrator.connect();
  try {
    await migrator.query("BEGIN");
    await assert.rejects(migrator.query(readFileSync(join(process.cwd(), "migrations", "0009_voucher_changes.sql"), "utf8")),
      /become one bill under the new name match key; rename or merge them first: company [^,]+, ledger [^:]+: A-B1, AB1/);
  } finally { await migrator.query("ROLLBACK").catch(() => undefined); await migrator.end(); }
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), earlier.length, '0009 was not applied');
  assert.equal(Number((await admin.query('SELECT count(*) FROM bill')).rows[0].count), 2, 'nothing was merged');
});
