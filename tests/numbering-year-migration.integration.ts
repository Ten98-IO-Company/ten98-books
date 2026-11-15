import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrationFiles } from '../src/server/db.ts';
import { getDatabase } from '../src/server/db.ts';
import { createVoucher } from '../src/server/ledger/vouchers.ts';
import { migrateDatabase } from '../src/server/startup-migrate.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { assertDatabaseRoles } from '../src/server/tenancy.ts';
import { inCompany, voucherBody } from './helpers/ledger.ts';

/**
 * Migration 0007 on a database an earlier release left, whose single running journal sequence already crossed into
 * 2027 (a December voucher entered after January ones took the next running number). Every voucher keeps its number;
 * each year's counter continues from the highest number present in that year, deleted vouchers included.
 */
const thisMigration = '0007_numbering_year.sql';
const earlier = migrationFiles.slice(0, migrationFiles.indexOf(thisMigration));
let database: TestDatabase;
let admin: pg.Client;
const company = randomUUID(), user = randomUUID();
const ids = { journal: '', payment: '', rent: '', capital: '', cash: '' };
const vouchers: { id: string; label: string; number: number | null }[] = [];

/** One voucher the way the earlier release posted it: the type's single counter advanced in the same transaction. */
async function earlierPost(label: string, type: 'journal' | 'payment', date: string, { optional = false, deleted = false } = {}): Promise<void> {
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', $1, true)", [company]);
  let number: number | null = null;
  if (!optional) {
    number = (await admin.query(`INSERT INTO voucher_counter (company_id, voucher_type_id, series, last_number) VALUES ($1, $2, 'main', 1)
      ON CONFLICT (company_id, voucher_type_id, series) DO UPDATE SET last_number = voucher_counter.last_number + 1 RETURNING last_number`, [company, ids[type]])).rows[0].last_number;
  }
  const id = (await admin.query(`INSERT INTO voucher (company_id, voucher_type_id, series, number, date, status, idempotency_key, request_hash, created_by)
    VALUES ($1, $2, 'main', $3, $4, $5, $6, $7, $8) RETURNING id`, [company, ids[type], number, date, optional ? 'optional' : 'regular', `earlier-${randomUUID()}`, 'a'.repeat(64), user])).rows[0].id;
  const credit = type === 'payment' ? ids.cash : ids.capital;
  await admin.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
    VALUES ($1, $2, 1, $3, 'Dr', 100, 'AED', 100, 1), ($1, $2, 2, $4, 'Cr', 100, 'AED', 100, 1)`, [company, id, ids.rent, credit]);
  if (deleted) await admin.query('UPDATE voucher SET deleted_at = now(), deleted_by = $3 WHERE company_id = $1 AND id = $2', [company, id, user]);
  await admin.query('COMMIT');
  vouchers.push({ id, label, number });
}

before(async () => {
  database = await freshDatabase('numberingupgrade', { migrations: earlier });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await admin.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [user, `owner-${user}@books.test`]);
  await admin.query("INSERT INTO workspace (id, name) VALUES ($1, 'Running Books')", [company]);
  await admin.query("INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [company, user]);
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', $1, true)", [company]);
  await admin.query(`INSERT INTO company (company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
    VALUES ($1, 'AED', 2, 1, 1, '2026-02-15', 'Asia/Dubai')`, [company]);
  await admin.query('SELECT ledger_seed_company($1)', [company]);
  const one = async (sql: string, values: unknown[]) => (await admin.query(sql, values)).rows[0].id as string;
  ids.journal = await one("SELECT id FROM voucher_type WHERE company_id = $1 AND kind = 'journal'", [company]);
  ids.payment = await one("SELECT id FROM voucher_type WHERE company_id = $1 AND kind = 'payment'", [company]);
  ids.cash = await one("SELECT id FROM ledger WHERE company_id = $1 AND system_key = 'cash'", [company]);
  const group = async (key: string) => one('SELECT id FROM account_group WHERE company_id = $1 AND system_key = $2', [company, key]);
  ids.rent = await one('INSERT INTO ledger (company_id, group_id, name) VALUES ($1, $2, $3) RETURNING id', [company, await group('indirect_expenses'), 'Rent']);
  ids.capital = await one('INSERT INTO ledger (company_id, group_id, name) VALUES ($1, $2, $3) RETURNING id', [company, await group('capital'), 'Owner Capital']);
  await admin.query('COMMIT');
  await earlierPost('march', 'journal', '2026-03-01');
  await earlierPost('june', 'journal', '2026-06-01');
  await earlierPost('optional', 'journal', '2026-07-01', { optional: true });
  await earlierPost('january-5', 'journal', '2027-01-05');
  await earlierPost('january-6', 'journal', '2027-01-06');
  await earlierPost('late-december', 'journal', '2026-12-20');
  await earlierPost('january-7-deleted', 'journal', '2027-01-07', { deleted: true });
  await earlierPost('payment', 'payment', '2027-01-08');
  await migrateDatabase({ log: () => undefined });
});
after(async () => { await admin?.end(); await database?.drop(); });

test('every voucher keeps its number and is filed under the year of its date', async () => {
  assert.deepEqual(vouchers.map(voucher => [voucher.label, voucher.number]), [
    ['march', 1], ['june', 2], ['optional', null], ['january-5', 3], ['january-6', 4], ['late-december', 5], ['january-7-deleted', 6], ['payment', 1]]);
  const { rows } = await admin.query<{ id: string; number: number | null; period: string | null }>(
    `SELECT id, number, to_char(number_period, 'YYYY-MM-DD') AS period FROM voucher WHERE company_id = $1`, [company]);
  const after = new Map(rows.map(row => [row.id, row]));
  assert.deepEqual(vouchers.map(voucher => [voucher.label, after.get(voucher.id)?.number, after.get(voucher.id)?.period]), [
    ['march', 1, '2026-01-01'], ['june', 2, '2026-01-01'], ['optional', null, null], ['january-5', 3, '2027-01-01'], ['january-6', 4, '2027-01-01'],
    ['late-december', 5, '2026-01-01'], ['january-7-deleted', 6, '2027-01-01'], ['payment', 1, '2027-01-01']]);
  const counters = await admin.query(`SELECT voucher_type_id AS type, to_char(period_start, 'YYYY-MM-DD') AS period, last_number AS last
    FROM voucher_counter WHERE company_id = $1 ORDER BY voucher_type_id = $2 DESC, period_start`, [company, ids.journal]);
  assert.deepEqual(counters.rows, [
    { type: ids.journal, period: '2026-01-01', last: 5 }, { type: ids.journal, period: '2027-01-01', last: 6 }, { type: ids.payment, period: '2027-01-01', last: 1 }]);
  const rules = await admin.query(`SELECT to_char(applicable_from, 'YYYY-MM-DD') AS "from", starting_number AS start, periodicity, count(*)::int AS types
    FROM voucher_numbering_restart WHERE company_id = $1 GROUP BY 1, 2, 3`, [company]);
  assert.deepEqual(rules.rows, [{ from: '2026-01-01', start: 1, periodicity: 'yearly', types: 9 }], 'each existing voucher type gets the default restart rule, dated on the financial year start, not the books beginning (15 February)');
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), migrationFiles.length);
  await assertDatabaseRoles(getDatabase().pool);
  // The company existed before 0007; its financial year start is now fixed too, even for the migrating owner.
  await assert.rejects(admin.query('UPDATE company SET fy_start_month = 4 WHERE company_id = $1', [company]),
    (error: unknown) => (error as { constraint?: string }).constraint === 'company_financial_year_fixed');
});

test('each year continues from its own highest number, so an earlier year may repeat a later year\'s number', async () => {
  const postAs = (type: string, date: string, credit: string) => inCompany(user, company,
    context => createVoucher(context, voucherBody(type, date, [[ids.rent, 'Dr', '1'], [credit, 'Cr', '1']])), 'write').then(result => result.voucher.number);
  assert.equal(await postAs(ids.journal, '2026-12-21', ids.capital), 6, '2026 continues after 5 and repeats the (deleted) 2027 number 6');
  assert.equal(await postAs(ids.journal, '2027-01-09', ids.capital), 7, '2027 continues after its own 6');
  assert.equal(await postAs(ids.payment, '2026-03-02', ids.cash), 1, 'a year with no numbers yet starts at 1');
  const sixes = await admin.query(`SELECT to_char(number_period, 'YYYY') AS year FROM voucher WHERE company_id = $1 AND voucher_type_id = $2 AND number = 6 ORDER BY 1`, [company, ids.journal]);
  assert.deepEqual(sixes.rows.map(row => row.year), ['2026', '2027']);
});
