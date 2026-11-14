import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { join } from 'node:path';
import { createMigrationLedger } from '@ten98/runtime';
import { migrationFiles, migrationLockKey } from '../src/server/db.ts';
import { migrateDatabase } from '../src/server/startup-migrate.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';

/**
 * Migration 0006 on a database an earlier release left: receivables and payables ledgers with no voucher lines and no
 * opening balance become bill-wise, each with a logged alter; ledgers with history, and every other ledger, stay as
 * they were (their owner opts in). No bill rows are created.
 */
const thisMigration = '0006_bills.sql';
const earlier = migrationFiles.slice(0, migrationFiles.indexOf(thisMigration));
let database: TestDatabase;
let admin: pg.Client;
const workspace = randomUUID(), user = randomUUID();
const ledgers: Record<string, string> = {};

before(async () => {
  database = await freshDatabase('billsupgrade', { migrations: earlier });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await admin.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [user, `owner-${user}@books.test`]);
  await admin.query("INSERT INTO workspace (id, name) VALUES ($1, 'Earlier Books')", [workspace]);
  await admin.query("INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspace, user]);
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', $1, true)", [workspace]);
  await admin.query(`INSERT INTO company (company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
    VALUES ($1, 'AED', 2, 1, 1, '2026-01-01', 'Asia/Dubai')`, [workspace]);
  await admin.query('SELECT ledger_seed_company($1)', [workspace]);
  const group = async (key: string) => (await admin.query('SELECT id FROM account_group WHERE company_id = $1 AND system_key = $2', [workspace, key])).rows[0].id;
  const add = async (name: string, groupKey: string, opening = 0) => {
    ledgers[name] = (await admin.query('INSERT INTO ledger (company_id, group_id, name, opening_amount) VALUES ($1, $2, $3, $4) RETURNING id',
      [workspace, await group(groupKey), name, opening])).rows[0].id;
  };
  await add('Clean Debtor', 'receivables');
  await add('Clean Creditor', 'payables');
  await add('Opening Debtor', 'receivables', 5000);
  await add('Posted Debtor', 'receivables');
  await add('Rent', 'indirect_expenses');
  // An optional voucher gives the posted debtor lines without needing a number.
  const type = (await admin.query("SELECT id, numbering_series FROM voucher_type WHERE company_id = $1 AND kind = 'journal'", [workspace])).rows[0];
  const voucher = (await admin.query(`INSERT INTO voucher (company_id, voucher_type_id, series, date, status, idempotency_key, request_hash, created_by)
    VALUES ($1, $2, $3, '2026-01-05', 'optional', $4, $5, $6) RETURNING id`, [workspace, type.id, type.numbering_series, `earlier-${randomUUID()}`, 'a'.repeat(64), user])).rows[0].id;
  await admin.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
    VALUES ($1, $2, 1, $3, 'Dr', 100, 'AED', 100, 1), ($1, $2, 2, $4, 'Cr', 100, 'AED', 100, 1)`, [workspace, voucher, ledgers['Posted Debtor'], ledgers.Rent]);
  await admin.query('COMMIT');
  // This migration alone: later ones (0008 flips income and expense ledgers to cost centres) have their own tests.
  const through = migrationFiles.slice(0, migrationFiles.indexOf(thisMigration) + 1);
  await migrateDatabase({ ledger: createMigrationLedger({ directory: join(process.cwd(), 'migrations'), files: through, lockKey: migrationLockKey }), log: () => undefined });
});
after(async () => { await admin?.end(); await database?.drop(); });

test('only receivables and payables ledgers without history become bill-wise, each with a logged alter by the migration', async () => {
  const { rows } = await admin.query('SELECT name, bill_wise, revision FROM ledger WHERE company_id = $1 AND system_key IS NULL ORDER BY name', [workspace]);
  assert.deepEqual(rows.map(row => [row.name, row.bill_wise, row.revision]), [
    ['Clean Creditor', true, 2], ['Clean Debtor', true, 2], ['Opening Debtor', false, 1], ['Posted Debtor', false, 1], ['Rent', false, 1]]);
  const log = (await admin.query(`SELECT entity_id, action, actor_id, before, after FROM revision_log WHERE company_id = $1 AND entity = 'ledger' ORDER BY id`, [workspace])).rows;
  assert.deepEqual(log.map(row => [row.entity_id, row.action, row.actor_id]).sort(), [
    [ledgers['Clean Creditor'], 'alter', 'migration:0006_bills'], [ledgers['Clean Debtor'], 'alter', 'migration:0006_bills']].sort());
  const debtor = log.find(row => row.entity_id === ledgers['Clean Debtor']);
  assert.deepEqual([debtor.before.billWise, debtor.before.revision, debtor.after.billWise, debtor.after.revision, debtor.after.name, debtor.after.openingBills],
    [false, 1, true, 2, 'Clean Debtor', []]);
  assert.equal(Number((await admin.query('SELECT count(*) FROM bill_allocation')).rows[0].count), 0, 'no bill rows are created');
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), migrationFiles.indexOf(thisMigration) + 1);
});
