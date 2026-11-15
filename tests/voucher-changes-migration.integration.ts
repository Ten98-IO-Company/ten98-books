import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrationFiles } from '../src/server/db.ts';
import { createCostCategory, createCostCentre, saveCostCentresSetting } from '../src/server/ledger/cost-centres.ts';
import { alterVoucher, createVoucher, readVoucher } from '../src/server/ledger/vouchers.ts';
import { migrateDatabase } from '../src/server/startup-migrate.ts';
import { moneyToWire } from '../src/lib/money.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { inCompany } from './helpers/ledger.ts';

/**
 * Migration 0009 on a database an earlier release left with two companies holding vouchers, bills and cost rows: the
 * bill indexes are replaced, the checks and the voucher guard are replaced in place, nothing posted changes, every
 * existing voucher stays an ordinary one (not a void), and posting, altering and moving a voucher to another type work
 * on the migrated data.
 */
const thisMigration = '0009_voucher_changes.sql';
const earlier = migrationFiles.slice(0, migrationFiles.indexOf(thisMigration));
let database: TestDatabase;
let admin: pg.Client;
const user = randomUUID();
const companies = [randomUUID(), randomUUID()];
const vouchers: Record<string, string> = {};
const snapshot = async () => (await admin.query(`SELECT
    (SELECT count(*) FROM voucher)::int AS vouchers, (SELECT count(*) FROM voucher_line)::int AS lines, (SELECT count(*) FROM bill)::int AS bills,
    (SELECT count(*) FROM bill_allocation)::int AS bill_rows, (SELECT count(*) FROM cost_allocation)::int AS cost_rows,
    (SELECT string_agg(company_id || ':' || number || ':' || status, ',' ORDER BY company_id, number) FROM voucher) AS numbers`)).rows[0];
let before0009: unknown;
const types = async (company: string, kind: string) => (await admin.query('SELECT id FROM voucher_type WHERE company_id = $1 AND kind = $2', [company, kind])).rows[0].id as string;

/**
 * One company as the earlier release left it: a sales voucher posted by the server code with a cost row on the sales line
 * and, written as that release stored them, new bills on the party line named `billNames` (the current posting code
 * already needs 0009's bill key).
 */
async function earlierCompany(client: pg.Client, company: string, billNames: string[]): Promise<string> {
  await client.query("INSERT INTO workspace (id, name) VALUES ($1, 'Earlier Changes')", [company]);
  await client.query("INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [company, user]);
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.company_ids', $1, true)", [company]);
  await client.query(`INSERT INTO company (company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
    VALUES ($1, 'AED', 2, 1, 1, '2026-01-01', 'Asia/Dubai')`, [company]);
  await client.query("SELECT ledger_seed_company($1)", [company]);
  await client.query("COMMIT");
  const posted = await inCompany(user, company, async context => {
    context.role = "owner";
    await saveCostCentresSetting(context, { enabled: true });
    const group = async (key: string) => (await context.client.query("SELECT id FROM account_group WHERE company_id = $1 AND system_key = $2", [company, key])).rows[0].id;
    const sales = (await context.client.query('INSERT INTO ledger (company_id, group_id, name, cost_centres) VALUES ($1, $2, $3, true) RETURNING id', [company, await group("sales"), "Sales"])).rows[0].id;
    const party = (await context.client.query('INSERT INTO ledger (company_id, group_id, name, bill_wise) VALUES ($1, $2, $3, true) RETURNING id', [company, await group("receivables"), "Party"])).rows[0].id;
    const centre = (await createCostCentre(context, { name: "Showroom", categoryId: (await createCostCategory(context, { name: "Channel" })).id, parentId: null })).id;
    const type = (await context.client.query("SELECT id FROM voucher_type WHERE company_id = $1 AND kind = 'sales'", [company])).rows[0].id;
    return (await createVoucher(context, { idempotencyKey: `earlier-${randomUUID()}`, voucherTypeId: type, date: "2026-02-01", lines: [
      { ledgerId: party, side: "Dr", amount: "100" }, { ledgerId: sales, side: "Cr", amount: "100", costAllocations: [{ costCentreId: centre, amount: "100" }] }] })).voucher;
  }, "write");
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.company_ids', $1, true)", [company]);
  for (const name of billNames) {
    const bill = (await client.query("INSERT INTO bill (company_id, ledger_id, name, currency) VALUES ($1, $2, $3, 'AED') RETURNING id", [company, posted.lines[0].ledgerId, name])).rows[0].id;
    const amount = 10000 / billNames.length;
    await client.query(`INSERT INTO bill_allocation (company_id, ledger_id, voucher_id, line_no, kind, bill_id, currency, side, amount, currency_amount, due_date)
      VALUES ($1, $2, $3, 1, 'new_ref', $4, 'AED', 'Dr', $5, $5, '2026-02-01')`, [company, posted.lines[0].ledgerId, posted.id, bill, amount]);
  }
  await client.query("COMMIT");
  return posted.id;
}

before(async () => {
  database = await freshDatabase("changesupgrade", { migrations: earlier });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await admin.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [user, `owner-${user}@books.test`]);
  for (const company of companies) vouchers[company] = await earlierCompany(admin, company, ["INV-1"]);
  before0009 = await snapshot();
  await migrateDatabase({ log: () => undefined });
});
after(async () => { await admin?.end(); await database?.drop(); });

test('the bill indexes are led by the line and the bill, bills are identified by the bill key, and nothing posted changed', async () => {
  const indexes = (await admin.query(`SELECT indexrelid::regclass::text AS name, pg_get_indexdef(indexrelid) AS definition FROM pg_index
    WHERE indrelid IN ('bill_allocation'::regclass, 'bill'::regclass) ORDER BY 1`)).rows;
  const definition = (name: string) => indexes.find(row => row.name === name)?.definition ?? '';
  assert.match(definition('bill_allocation_line_idx'), /\(voucher_id, line_no\)$/);
  assert.match(definition('bill_allocation_bill_idx'), /\(bill_id\)$/);
  assert.match(definition('bill_identity_idx'), /\(company_id, ledger_id, name_key\)$/);
  assert.match(definition('bill_ledger_order_idx'), /\(ledger_id, name_key, id\)$/);
  assert.deepEqual((await admin.query('SELECT DISTINCT name_key = name_match_key(name) AS same FROM bill')).rows, [{ same: true }], 'the stored key is the key of every existing name');
  assert.deepEqual(await snapshot(), before0009);
  assert.deepEqual((await admin.query('SELECT DISTINCT created_cancelled FROM voucher')).rows, [{ created_cancelled: false }], 'existing vouchers are not voids');
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), migrationFiles.length);
});

test('on the migrated data a voucher alters, moves to another type and a void posts; the checks still refuse a short bill line', async () => {
  for (const company of companies) {
    await inCompany(user, company, async context => {
      const read = moneyToWire(await readVoucher(context, vouchers[company]), 2) as any;
      const body = {
        date: read.date, narration: 'after 0009', status: read.status, postDated: read.postDated, reference: read.reference, referenceDate: read.referenceDate,
        revision: read.revision, voucherTypeId: await types(company, 'journal'),
        lines: read.lines.map((item: any) => ({ ledgerId: item.ledgerId, side: item.side, amount: item.amount,
          bills: item.bills.map((row: any) => ({ kind: row.kind, name: row.billName, amount: row.amount, creditPeriod: { dueDate: row.dueDate } })),
          costAllocations: item.costAllocations.map((row: any) => ({ costCentreId: row.costCentreId, amount: row.amount })) })),
      };
      const moved = await alterVoucher(context, vouchers[company], body);
      assert.deepEqual([moved.voucher.kind, moved.voucher.number, moved.voucher.lines[0].bills.length, moved.voucher.lines[1].costAllocations.length], ['journal', 1, 1, 1]);
      const voided = await createVoucher(context, { idempotencyKey: `after-${randomUUID()}`, voucherTypeId: await types(company, 'sales'), date: '2026-02-02', status: 'cancelled', lines: [] });
      assert.deepEqual([voided.voucher.number, voided.voucher.status], [2, 'cancelled'], 'sales number 1 stays a gap');
    }, 'write');
  }
  await assert.rejects(admin.query('BEGIN').then(async () => {
    await admin.query("SELECT set_config('app.company_ids', $1, true)", [companies[0]]);
    await admin.query(`INSERT INTO bill_allocation (company_id, ledger_id, voucher_id, line_no, kind, currency, side, amount, currency_amount)
      SELECT company_id, ledger_id, voucher_id, line_no, 'on_account', 'AED', 'Dr', 100000, 100000 FROM voucher_line WHERE company_id = $1 AND voucher_id = $2 AND line_no = 1`,
    [companies[0], vouchers[companies[0]]]);
    await admin.query('COMMIT');
  }), (error: { constraint?: string }) => error.constraint === 'bill_allocation_total');
  await admin.query('ROLLBACK').catch(() => undefined);
});

