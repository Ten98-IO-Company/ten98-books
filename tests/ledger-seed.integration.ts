import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createMigrationLedger } from '@ten98/runtime';
import { asAdmin, createCompany, setupOwner } from './helpers/ledger.ts';

/**
 * Seeding (D-10) and its backfill. This file builds its own database at the schema before the ledger migration, adds a
 * company there, then applies the remaining migrations, so the backfill is exercised exactly as an upgrade runs it.
 */
const local = new Set(['localhost', '127.0.0.1', '[::1]']);
const name = `books_ledger_seed_${randomBytes(4).toString('hex')}`;
let adminUrl = '';
// A company of the earlier model (a project); from migration 0005 on, its books live under its workspace id (D-03).
const legacyCompany = randomUUID(), legacyWorkspace = randomUUID();

const primaryGroups = ['branches', 'capital', 'current_assets', 'current_liabilities', 'deferred_expenses', 'direct_expenses', 'direct_income', 'fixed_assets',
  'indirect_expenses', 'indirect_income', 'investments', 'loans', 'purchases', 'sales', 'suspense'];
const subGroups = ['advances_given:current_assets', 'bank_accounts:current_assets', 'bank_overdraft:loans', 'cash_in_hand:current_assets',
  'deposits_paid:current_assets', 'duties_taxes:current_liabilities', 'inventory:current_assets', 'payables:current_liabilities',
  'provisions:current_liabilities', 'receivables:current_assets', 'reserves:capital', 'secured_loans:loans', 'unsecured_loans:loans'];

function url(variable: string): URL {
  const value = process.env[variable];
  assert.ok(value, `${variable} is required for integration tests.`);
  const parsed = new URL(value);
  assert.ok(local.has(parsed.hostname), `${variable} must point at a local test server.`);
  return parsed;
}

/** The chart of one company as `key:parentKey:nature` lines, plus its ledgers and voucher types, read past RLS. */
async function seeded(companyId: string) {
  return asAdmin(adminUrl, async admin => ({
    groups: (await admin.query<{ line: string }>(`SELECT g.system_key || ':' || coalesce(p.system_key, '') || ':' || g.nature || ':' || g.gross_profit AS line
      FROM account_group g LEFT JOIN account_group p ON p.company_id = g.company_id AND p.id = g.parent_id WHERE g.company_id = $1 ORDER BY 1`, [companyId])).rows.map(row => row.line),
    ledgers: (await admin.query<{ line: string }>(`SELECT l.system_key || ':' || coalesce(g.system_key, '') AS line FROM ledger l
      LEFT JOIN account_group g ON g.company_id = l.company_id AND g.id = l.group_id WHERE l.company_id = $1 ORDER BY 1`, [companyId])).rows.map(row => row.line),
    types: (await admin.query<{ line: string }>(`SELECT system_key || ':' || kind AS line FROM voucher_type WHERE company_id = $1 ORDER BY 1`, [companyId])).rows.map(row => row.line),
  }));
}

before(async () => {
  const admin = url('TEST_ADMIN_DATABASE_URL'), application = url('DATABASE_URL'), migrator = url('MIGRATION_DATABASE_URL');
  process.env.AUTH_SECRET ??= randomBytes(32).toString('hex');
  const client = new pg.Client({ connectionString: admin.href });
  await client.connect();
  try { await client.query(`CREATE DATABASE ${name} OWNER books_migrator`); } finally { await client.end(); }
  for (const [key, target] of [['DATABASE_URL', application], ['MIGRATION_DATABASE_URL', migrator]] as const) { target.pathname = `/${name}`; process.env[key] = target.href; }
  const scoped = new URL(admin.href); scoped.pathname = `/${name}`; adminUrl = scoped.href;

  const { migrateDatabase } = await import('../src/server/startup-migrate.ts');
  const { createPool, migrationFiles, migrationLockKey } = await import('../src/server/db.ts');
  // Every migration that precedes the ledger one, so the backfill is observed on a database that predates it.
  const beforeFiles = migrationFiles.slice(0, migrationFiles.indexOf('0004_ledger.sql'));
  const pool = createPool(process.env.MIGRATION_DATABASE_URL!, { max: 2 });
  try {
    const beforeLedger = createMigrationLedger({ directory: join(process.cwd(), 'migrations'), files: beforeFiles, lockKey: migrationLockKey });
    await migrateDatabase({ pool, ledger: beforeLedger, log: () => undefined });
    await asAdmin(adminUrl, async admin => {
      await admin.query(`INSERT INTO workspace (id, name) VALUES ($1, 'Existing')`, [legacyWorkspace]);
      await admin.query(`INSERT INTO project (id, workspace_id, name) VALUES ($1, $2, 'Company before the ledger')`, [legacyCompany, legacyWorkspace]);
      await admin.query(`INSERT INTO company (company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
        VALUES ($1, 'OMR', 3, 1, 1, '2025-01-01', 'Asia/Muscat')`, [legacyCompany]);
    });
    // The ledger migration alone performs the backfill; the later ones then run as an upgrade would.
    const throughLedger = createMigrationLedger({ directory: join(process.cwd(), 'migrations'), files: migrationFiles.slice(0, beforeFiles.length + 1), lockKey: migrationLockKey });
    assert.deepEqual(await migrateDatabase({ pool, ledger: throughLedger, log: () => undefined }), ['0004']);
    assert.deepEqual(await migrateDatabase({ pool, log: () => undefined }), migrationFiles.slice(beforeFiles.length + 1).map(file => file.slice(0, 4)));
  } finally { await pool.end(); }
});

after(async () => {
  const { closeDatabase } = await import('../src/server/db.ts');
  await closeDatabase();
  const client = new pg.Client({ connectionString: url('TEST_ADMIN_DATABASE_URL').href });
  await client.connect();
  try { await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await client.end(); }
});

test('the migration backfills the default chart for a company created before it', async () => {
  const chart = await seeded(legacyWorkspace);
  const natures: Record<string, string> = { branches: 'liability', capital: 'liability', current_assets: 'asset', current_liabilities: 'liability', deferred_expenses: 'asset',
    direct_expenses: 'expense', direct_income: 'income', fixed_assets: 'asset', indirect_expenses: 'expense', indirect_income: 'income', investments: 'asset',
    loans: 'liability', purchases: 'expense', sales: 'income', suspense: 'liability' };
  const gross = new Set(['direct_expenses', 'direct_income', 'purchases', 'sales']);
  const expected = [
    ...primaryGroups.map(key => `${key}::${natures[key]}:${gross.has(key)}`),
    ...subGroups.map(entry => { const [key, parent] = entry.split(':'); return `${key}:${parent}:${natures[parent]}:false`; }),
  ].sort();
  assert.equal(chart.groups.length, 28);
  assert.deepEqual(chart.groups, expected);
  assert.deepEqual(chart.ledgers, ['cash:cash_in_hand', 'profit_and_loss:']);
  assert.deepEqual(chart.types, ['contra:contra', 'credit_note:credit_note', 'debit_note:debit_note', 'journal:journal', 'payment:payment', 'purchase:purchase', 'receipt:receipt', 'sales:sales']);
});

test('company creation seeds the same chart, and seeding again changes nothing', async () => {
  const owner = await setupOwner();
  const companyId = await createCompany(owner.browser);
  assert.deepEqual(await seeded(companyId), await seeded(legacyWorkspace), 'creation and backfill run the same routine');

  const { getDatabase } = await import('../src/server/db.ts');
  const { withCompany } = await import('../src/server/tenancy.ts');
  const { seedCompanyLedger } = await import('../src/server/ledger/seed.ts');
  const groups = (await owner.browser.call(`/api/companies/${companyId}/groups`)).body.groups as { id: string; systemKey: string; parentId: string | null; revision: number }[];
  const sales = groups.find(group => group.systemKey === 'sales')!;
  assert.equal((await owner.browser.call(`/api/companies/${companyId}/groups/${sales.id}`, { name: 'Revenue', parentId: null, revision: sales.revision })).status, 200);
  await withCompany(owner.userId, companyId, 'write', async client => { await seedCompanyLedger(client, companyId); await seedCompanyLedger(client, companyId); });
  const again = (await owner.browser.call(`/api/companies/${companyId}/groups`)).body.groups as { systemKey: string; name: string }[];
  assert.equal(again.length, 28);
  assert.equal(again.find(group => group.systemKey === 'sales')!.name, 'Revenue', 'a renamed built-in group keeps its new name');
  assert.ok(!again.some(group => group.name === 'Sales'), 'no second sales group appears');
  assert.equal((await getDatabase().pool.query('SELECT * FROM account_group')).rowCount, 0, 'the seeded rows are invisible without company context');
});

test('the boot assertion fails when one ledger table loses its policy or its forced row-level security', async () => {
  const { getDatabase } = await import('../src/server/db.ts');
  const { assertDatabaseRoles } = await import('../src/server/tenancy.ts');
  const { pool } = getDatabase();
  await assertDatabaseRoles(pool);
  const scope = "company_id = ANY (string_to_array(current_setting('app.company_ids', true), ','))";
  await asAdmin(adminUrl, admin => admin.query('DROP POLICY voucher_line_company_scope ON voucher_line'));
  try {
    await assert.rejects(assertDatabaseRoles(pool), /company policy is missing, altered or accompanied by another policy on voucher_line/);
  } finally {
    await asAdmin(adminUrl, admin => admin.query(`CREATE POLICY voucher_line_company_scope ON voucher_line USING (${scope}) WITH CHECK (${scope})`));
  }
  await asAdmin(adminUrl, admin => admin.query('ALTER TABLE revision_log NO FORCE ROW LEVEL SECURITY'));
  try {
    await assert.rejects(assertDatabaseRoles(pool), /not enabled and forced on revision_log/);
  } finally {
    await asAdmin(adminUrl, admin => admin.query('ALTER TABLE revision_log FORCE ROW LEVEL SECURITY'));
  }
  await assertDatabaseRoles(pool);
});
