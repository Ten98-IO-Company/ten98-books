import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrationFiles } from '../src/server/db.ts';
import { createCurrency } from '../src/server/ledger/currencies.ts';
import { createLedger } from '../src/server/ledger/masters.ts';
import { createVoucher } from '../src/server/ledger/vouchers.ts';
import { migrateDatabase } from '../src/server/startup-migrate.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { inCompany } from './helpers/ledger.ts';

/**
 * Migration 0012 on a database an earlier release left with two companies (AED with 2 decimals, KWD with 3) holding
 * vouchers, bills and cost rows: each company gets one base currency row with its code and decimals, every ledger states
 * the base code, the four foreign keys to currency are validated, seeding again adds nothing, nothing posted or logged
 * changes, and the migrated books take a foreign currency and a ledger in it.
 */
const thisMigration = '0012_currencies.sql';
const earlier = migrationFiles.slice(0, migrationFiles.indexOf(thisMigration));
let database: TestDatabase;
let admin: pg.Client;
const user = randomUUID();
const companies = [{ id: randomUUID(), base: 'AED', minor: 2 }, { id: randomUUID(), base: 'KWD', minor: 3 }];
const snapshot = async () => (await admin.query(`SELECT
    (SELECT string_agg(company_id || ':' || id || ':' || revision, ',' ORDER BY company_id, id) FROM ledger) AS ledgers,
    (SELECT string_agg(company_id || ':' || ledger_id || ':' || side || ':' || amount || ':' || currency, ',' ORDER BY company_id, voucher_id, line_no) FROM voucher_line) AS lines,
    (SELECT count(*)::int FROM bill) AS bills, (SELECT count(*)::int FROM bill_allocation) AS bill_rows, (SELECT count(*)::int FROM cost_allocation) AS cost_rows,
    (SELECT count(*)::int FROM revision_log) AS revisions`)).rows[0];
let before0012: unknown;

/** One company as the earlier release left it: a sale to a bill-wise party, with a bill on the party line and a cost row on the sales line. */
async function earlierCompany(company: { id: string; base: string; minor: number }): Promise<void> {
  const amount = 100 * 10 ** company.minor;
  await admin.query("INSERT INTO workspace (id, name) VALUES ($1, 'Earlier Currencies')", [company.id]);
  await admin.query("INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [company.id, user]);
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', $1, true)", [company.id]);
  await admin.query(`INSERT INTO company (company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
    VALUES ($1, $2, $3, 1, 1, '2026-01-01', 'Asia/Dubai')`, [company.id, company.base, company.minor]);
  await admin.query('SELECT ledger_seed_company($1)', [company.id]);
  const group = async (key: string) => (await admin.query('SELECT id FROM account_group WHERE company_id = $1 AND system_key = $2', [company.id, key])).rows[0].id;
  const sales = (await admin.query('INSERT INTO ledger (company_id, group_id, name, cost_centres) VALUES ($1, $2, $3, true) RETURNING id', [company.id, await group('sales'), 'Sales'])).rows[0].id;
  const party = (await admin.query('INSERT INTO ledger (company_id, group_id, name, bill_wise) VALUES ($1, $2, $3, true) RETURNING id', [company.id, await group('receivables'), 'Party'])).rows[0].id;
  const category = (await admin.query("SELECT id FROM cost_category WHERE company_id = $1 AND system_key = 'primary'", [company.id])).rows[0].id;
  const centre = (await admin.query("INSERT INTO cost_centre (company_id, category_id, name) VALUES ($1, $2, 'Showroom') RETURNING id", [company.id, category])).rows[0].id;
  const type = (await admin.query("SELECT id, numbering_series FROM voucher_type WHERE company_id = $1 AND kind = 'sales'", [company.id])).rows[0];
  const voucher = (await admin.query(`INSERT INTO voucher (company_id, voucher_type_id, series, date, status, idempotency_key, request_hash, created_by)
    VALUES ($1, $2, $3, '2026-01-05', 'optional', $4, $5, $6) RETURNING id`, [company.id, type.id, type.numbering_series, `earlier-${randomUUID()}`, 'a'.repeat(64), user])).rows[0].id;
  await admin.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
    VALUES ($1, $2, 1, $3, 'Dr', $5, $6, $5, 1), ($1, $2, 2, $4, 'Cr', $5, $6, $5, 1)`, [company.id, voucher, party, sales, amount, company.base]);
  const bill = (await admin.query('INSERT INTO bill (company_id, ledger_id, name, currency) VALUES ($1, $2, $3, $4) RETURNING id', [company.id, party, 'INV-1', company.base])).rows[0].id;
  await admin.query(`INSERT INTO bill_allocation (company_id, ledger_id, voucher_id, line_no, kind, bill_id, currency, side, amount, currency_amount, due_date)
    VALUES ($1, $2, $3, 1, 'new_ref', $4, $5, 'Dr', $6, $6, '2026-01-05')`, [company.id, party, voucher, bill, company.base, amount]);
  await admin.query(`INSERT INTO cost_allocation (company_id, voucher_id, line_no, ledger_id, category_id, cost_centre_id, side, amount)
    VALUES ($1, $2, 2, $3, $4, $5, 'Cr', $6)`, [company.id, voucher, sales, category, centre, amount]);
  await admin.query('COMMIT');
}

before(async () => {
  database = await freshDatabase('currencyupgrade', { migrations: earlier });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await admin.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [user, `owner-${user}@books.test`]);
  for (const company of companies) await earlierCompany(company);
  before0012 = await snapshot();
  await migrateDatabase({ log: () => undefined });
});
after(async () => { await admin?.end(); await database?.drop(); });

test('each company has one base row with its code and decimals, every ledger states the base, and the keys are validated', async () => {
  const bases = (await admin.query('SELECT company_id, code, system_key, symbol, formal_name, decimals FROM currency ORDER BY company_id')).rows;
  assert.deepEqual(bases.map(row => [row.company_id, row.code, row.system_key, row.symbol, row.formal_name, row.decimals]).sort(),
    companies.map(company => [company.id, company.base, 'base', company.base, company.base, company.minor]).sort());
  const ledgers = (await admin.query('SELECT l.company_id, l.currency = c.base_currency AS base FROM ledger l JOIN company c ON c.company_id = l.company_id')).rows;
  assert.ok(ledgers.length >= 8 && ledgers.every(row => row.base), 'every ledger holds its company\'s base code');
  const keys = (await admin.query(`SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1) ORDER BY 1`,
    [['bill_allocation_currency_fkey', 'bill_currency_fkey', 'ledger_currency_fkey', 'voucher_line_currency_fkey']])).rows;
  assert.deepEqual(keys, [{ conname: 'bill_allocation_currency_fkey', convalidated: true }, { conname: 'bill_currency_fkey', convalidated: true },
    { conname: 'ledger_currency_fkey', convalidated: true }, { conname: 'voucher_line_currency_fkey', convalidated: true }]);
  assert.deepEqual(await snapshot(), before0012, 'nothing posted, billed, allocated or logged changes, and no ledger revision moves');
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), migrationFiles.length);
});

test('seeding again adds nothing', async () => {
  const counts = async () => (await admin.query(`SELECT (SELECT count(*)::int FROM currency) AS currencies, (SELECT count(*)::int FROM ledger) AS ledgers,
    (SELECT count(*)::int FROM account_group) AS groups, (SELECT count(*)::int FROM voucher_type) AS types`)).rows[0];
  const once = await counts();
  for (const company of companies) {
    await admin.query('BEGIN');
    await admin.query("SELECT set_config('app.company_ids', $1, true)", [company.id]);
    await admin.query('SELECT ledger_seed_company($1)', [company.id]);
    await admin.query('COMMIT');
  }
  assert.deepEqual(await counts(), once);
});

test('the migrated books take a foreign currency, a ledger in it and a base posting on that ledger', async () => {
  const [first] = companies;
  await inCompany(user, first.id, async context => {
    await createCurrency(context, { code: 'USD', symbol: '$', formalName: 'US Dollar', decimals: 2 });
    const group = (await context.client.query("SELECT id FROM account_group WHERE company_id = $1 AND system_key = 'bank_accounts'", [first.id])).rows[0].id;
    const bank = await createLedger(context, { name: 'USD Bank', groupId: group, currency: 'USD' });
    const capital = await createLedger(context, { name: 'Capital', groupId: (await context.client.query("SELECT id FROM account_group WHERE company_id = $1 AND system_key = 'capital'", [first.id])).rows[0].id });
    const journal = (await context.client.query("SELECT id FROM voucher_type WHERE company_id = $1 AND kind = 'journal'", [first.id])).rows[0].id;
    const posted = await createVoucher(context, { idempotencyKey: `after-${randomUUID()}`, voucherTypeId: journal, date: '2026-02-01',
      lines: [{ ledgerId: bank.id, side: 'Dr', amount: '50' }, { ledgerId: capital.id, side: 'Cr', amount: '50' }] });
    assert.deepEqual([bank.currency, posted.voucher.lines[0].currency], ['USD', 'AED']);
  }, 'write');
});
