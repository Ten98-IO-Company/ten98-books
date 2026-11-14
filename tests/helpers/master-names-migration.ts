import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { migrationFiles } from '../../src/server/db.ts';

export const thisMigration = '0010_master_names.sql';
export const earlier = migrationFiles.slice(0, migrationFiles.indexOf(thisMigration));

/** A company as an earlier release created it (workspace, membership, company row and its seeded masters). */
export async function earlierCompany(admin: pg.Client, user: string, company: string): Promise<void> {
  await admin.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [user, `owner-${user}@books.test`]);
  await admin.query("INSERT INTO workspace (id, name) VALUES ($1, 'Earlier Names')", [company]);
  await admin.query("INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [company, user]);
  await inEarlierCompany(admin, company, async () => {
    await admin.query(`INSERT INTO company (company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
      VALUES ($1, 'AED', 2, 1, 1, '2026-01-01', 'Asia/Dubai')`, [company]);
    await admin.query('SELECT ledger_seed_company($1)', [company]);
  });
}

/** Runs `work` as the admin in one transaction scoped to `company`. */
export async function inEarlierCompany(admin: pg.Client, company: string, work: () => Promise<unknown>): Promise<void> {
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', $1, true)", [company]);
  try { await work(); } catch (error) { await admin.query('ROLLBACK'); throw error; }
  await admin.query('COMMIT');
}

/**
 * The migration runner reports only the SQLSTATE; run as the migrator (and rolled back), the file's own refusal names the
 * tables, the company and the names.
 */
export async function assertMigrationRefuses(expected: RegExp): Promise<void> {
  const migrator = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await migrator.connect();
  try {
    await migrator.query('BEGIN');
    await assert.rejects(migrator.query(readFileSync(join(process.cwd(), 'migrations', thisMigration), 'utf8')), expected);
  } finally { await migrator.query('ROLLBACK').catch(() => undefined); await migrator.end(); }
}
