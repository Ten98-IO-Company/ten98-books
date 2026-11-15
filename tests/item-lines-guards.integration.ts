import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg, { type PoolClient } from 'pg';
import { getDatabase, migrationFiles } from '../src/server/db.ts';
import type { LedgerContext } from '../src/server/ledger/context.ts';
import { alterUnit, deleteItem, deleteTree, deleteUnit } from '../src/server/ledger/stock-masters.ts';
import { cancelVoucher, createVoucher, deleteVoucher } from '../src/server/ledger/vouchers.ts';
import { migrateDatabase } from '../src/server/startup-migrate.ts';
import { accountingTables, assertDatabaseRoles, setCompanyScope } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, inCompany } from './helpers/ledger.ts';
import { earlierCompany, inEarlierCompany } from './helpers/master-names-migration.ts';

/**
 * Item lines in the database (M2b slice b1, migration 0013): the migration on companies at 0012 (its pre-check on a
 * voucher type renamed to the stock journal's name, the seeding of the new type), hand-written SQL as the application
 * role (the path an application bug or a later import would take), the kind rules at commit including a type change,
 * the share locks of the item-line guard raced by two sessions, and the index paths proven by transaction counters.
 */
const thisMigration = '0013_item_lines.sql';
const earlier = migrationFiles.slice(0, migrationFiles.indexOf(thisMigration));
let database: TestDatabase;
let admin: pg.Client;
const user = randomUUID(), companyId = randomUUID(), renamed = randomUUID(), other = randomUUID();
const ids = { kg: '', nos: '', rod: '', bolt: '', main: '', yard: '', sales: '', purchases: '', customer: '', otherItem: '' };
const types: Record<string, { id: string; series: string }> = {};

const code = (expected: string, constraint?: string | string[]) => (error: unknown) => {
  const { code: actual, constraint: name } = error as { code?: string; constraint?: string };
  return actual === expected && (constraint === undefined || [constraint].flat().includes(name ?? ''));
};
/** One raw transaction as the application role, scoped to the company; rolled back on any error. */
async function asApp(run: (client: PoolClient) => Promise<unknown>): Promise<void> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await setCompanyScope(client, [companyId]);
    await run(client);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}
/** A raw transaction as the application role, held open: statements run on `client` until `end`. */
async function openApp(isolation: 'READ COMMITTED' | 'REPEATABLE READ' = 'READ COMMITTED'): Promise<{ client: PoolClient; end: (how: 'COMMIT' | 'ROLLBACK') => Promise<void> }> {
  const client = await getDatabase().pool.connect();
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await setCompanyScope(client, [companyId]);
  let open = true;
  return { client, end: async how => { if (!open) return; open = false; try { await client.query(how); } finally { client.release(); } } };
}
const one = async (sql: string, values: unknown[]) => (await asAdmin(database.adminUrl, client => client.query(sql, values))).rows[0];
const state = (promise: Promise<unknown>) => Promise.race([promise.then(() => 'settled', () => 'settled'), new Promise(resolve => setTimeout(() => resolve('waiting'), 400))]);

type ItemRow = { item?: string; location?: string; direction: 'in' | 'out'; quantity: string; amount: number; rate?: string; discount?: string | null; ledger?: string | null; line?: number | null };
type LineRow = [ledger: string, side: 'Dr' | 'Cr', amount: number];
/**
 * Writes a voucher of `kind` with its lines and item rows by hand, as the application role would. Optional by default
 * (an optional voucher needs no number); `status: 'cancelled'` with no lines gives a void.
 */
async function writeVoucher(client: PoolClient, kind: string, lines: LineRow[], items: ItemRow[], status: 'optional' | 'cancelled' = 'optional'): Promise<string> {
  const type = types[kind];
  const { rows: [voucher] } = await client.query<{ id: string }>(
    `INSERT INTO voucher (company_id, voucher_type_id, series, date, status, idempotency_key, request_hash, created_by)
     VALUES ($1, $2, $3, '2026-02-01', $4, $5, $6, $7) RETURNING id`, [companyId, type.id, type.series, status, `guard-${randomUUID()}`, 'a'.repeat(64), user]);
  for (const [index, [ledger, side, amount]] of lines.entries()) {
    await client.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
      VALUES ($1, $2, $3, $4, $5, $6, 'AED', $6, 1)`, [companyId, voucher.id, index + 1, ledger, side, amount]);
  }
  for (const [index, row] of items.entries()) {
    await client.query(`INSERT INTO inventory_line (company_id, voucher_id, entry_no, item_id, location_id, direction, quantity, rate, discount_percent, amount, ledger_id, line_no)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [companyId, voucher.id, index + 1, row.item ?? ids.rod, row.location ?? ids.main, row.direction, row.quantity, row.rate ?? '1', row.discount ?? null, row.amount,
        row.ledger === undefined ? ids.sales : row.ledger, row.line === undefined ? 1 : row.line]);
  }
  return voucher.id;
}
/** A sales voucher by hand: the customer debited, one sales line credited with the item rows on it. */
const sale = (items: ItemRow[], total = items.reduce((sum, row) => sum + row.amount, 0)) => (client: PoolClient) =>
  writeVoucher(client, 'sales', [[ids.sales, 'Cr', total], [ids.customer, 'Dr', total]], items);
const journalRows = (rows: Omit<ItemRow, 'ledger' | 'line'>[]) => rows.map(row => ({ ...row, ledger: null, line: null }));

before(async () => {
  database = await freshDatabase('item_guards', { migrations: earlier });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await earlierCompany(admin, user, companyId);
  // A second owner's company whose user renamed a voucher type to a name equal to the new type's under the name key.
  const renamedOwner = randomUUID();
  await earlierCompany(admin, renamedOwner, renamed);
  await inEarlierCompany(admin, renamed, () => admin.query("UPDATE voucher_type SET name = 'stock-journal' WHERE company_id = $1 AND system_key = 'journal'", [renamed]));
  await admin.query(`INSERT INTO workspace (id, name) VALUES ($1, 'Other Items')`, [other]);
  await admin.query("INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [other, user]);
  await inEarlierCompany(admin, other, async () => {
    await admin.query(`INSERT INTO company (company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
      VALUES ($1, 'AED', 2, 1, 1, '2026-01-01', 'Asia/Dubai')`, [other]);
    await admin.query('SELECT ledger_seed_company($1)', [other]);
  });
});
after(async () => { await admin?.end(); await database?.drop(); });

const countRows = async (tables: readonly string[]) => {
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', $1, true)", [[companyId, renamed, other].join(',')]);
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = Number((await admin.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  await admin.query('COMMIT');
  return counts;
};

test('0013 stops, naming the company and the type, while a voucher type has the stock journal\'s name under the key; renamed, it seeds one stock journal type in every company', async () => {
  const tables = accountingTables.filter(table => table !== 'inventory_line');
  const beforeCounts = await countRows(tables);
  const flags = async () => {
    await admin.query('BEGIN');
    await admin.query("SELECT set_config('app.company_ids', $1, true)", [[companyId, renamed, other].join(',')]);
    const rows = (await admin.query('SELECT company_id, inventory_enabled FROM company ORDER BY company_id')).rows;
    await admin.query('COMMIT');
    return rows;
  };
  const flagsBefore = await flags();
  await assert.rejects(migrateDatabase({ log: () => undefined }), /Database migration failed \(PostgreSQL error P0001\) and was rolled back; nothing was applied/);
  // The runner reports only the SQLSTATE; run as the migrator (and rolled back), the file's own refusal names the rows.
  const migrator = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await migrator.connect();
  try {
    await migrator.query('BEGIN');
    await assert.rejects(migrator.query(readFileSync(join(process.cwd(), 'migrations', thisMigration), 'utf8')),
      new RegExp(`these voucher types have the name the stock journal type takes; rename them first: company ${renamed}: voucher type "stock-journal"$`));
  } finally { await migrator.query('ROLLBACK').catch(() => undefined); await migrator.end(); }
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), earlier.length, '0013 was not applied');

  await inEarlierCompany(admin, renamed, () => admin.query("UPDATE voucher_type SET name = 'Journal' WHERE company_id = $1 AND system_key = 'journal'", [renamed]));
  await migrateDatabase({ log: () => undefined });
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), migrationFiles.length);
  const afterCounts = await countRows(tables);
  // Exactly one new type and its numbering row per company; nothing else moved.
  assert.deepEqual(afterCounts, { ...beforeCounts, voucher_type: beforeCounts.voucher_type + 3, voucher_numbering_restart: beforeCounts.voucher_numbering_restart + 3 });
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', $1, true)", [[companyId, renamed, other].join(',')]);
  const seeded = (await admin.query(`SELECT t.company_id, t.name, t.kind, count(r.*)::int AS restarts FROM voucher_type t
    LEFT JOIN voucher_numbering_restart r ON r.company_id = t.company_id AND r.voucher_type_id = t.id
    WHERE t.system_key = 'stock_journal' GROUP BY 1, 2, 3 ORDER BY 1`)).rows;
  await admin.query('COMMIT');
  assert.deepEqual(seeded.map(row => [row.name, row.kind, row.restarts]), [0, 1, 2].map(() => ['Stock Journal', 'stock_journal', 1]));
  assert.deepEqual(await flags(), flagsBefore, 'the inventory flags are untouched');
  assert.deepEqual(seeded.map(row => row.company_id).sort(), [companyId, renamed, other].sort());

  // The fixture for the guards below.
  await inEarlierCompany(admin, companyId, async () => {
    await admin.query('UPDATE company SET inventory_enabled = true WHERE company_id = $1', [companyId]);
    const insert = async (sql: string, values: unknown[]) => (await admin.query(sql, values)).rows[0].id as string;
    ids.kg = await insert("INSERT INTO stock_unit (company_id, symbol, decimals) VALUES ($1, 'Kg', 2) RETURNING id", [companyId]);
    ids.nos = await insert("INSERT INTO stock_unit (company_id, symbol) VALUES ($1, 'Nos') RETURNING id", [companyId]);
    ids.rod = await insert("INSERT INTO stock_item (company_id, name, unit_id) VALUES ($1, 'Rod', $2) RETURNING id", [companyId, ids.kg]);
    ids.bolt = await insert("INSERT INTO stock_item (company_id, name, unit_id) VALUES ($1, 'Bolt', $2) RETURNING id", [companyId, ids.nos]);
    ids.main = (await admin.query("SELECT id FROM stock_location WHERE company_id = $1 AND system_key = 'main'", [companyId])).rows[0].id;
    ids.yard = await insert("INSERT INTO stock_location (company_id, name) VALUES ($1, 'Yard') RETURNING id", [companyId]);
    const group = async (key: string) => (await admin.query('SELECT id FROM account_group WHERE company_id = $1 AND system_key = $2', [companyId, key])).rows[0].id;
    ids.sales = await insert("INSERT INTO ledger (company_id, group_id, name, currency) VALUES ($1, $2, 'Trade Sales', 'AED') RETURNING id", [companyId, await group('sales')]);
    ids.purchases = await insert("INSERT INTO ledger (company_id, group_id, name, currency) VALUES ($1, $2, 'Trade Purchases', 'AED') RETURNING id", [companyId, await group('purchases')]);
    ids.customer = await insert("INSERT INTO ledger (company_id, group_id, name, currency) VALUES ($1, $2, 'Customer', 'AED') RETURNING id", [companyId, await group('receivables')]);
    for (const row of (await admin.query('SELECT kind, id, numbering_series AS series FROM voucher_type WHERE company_id = $1', [companyId])).rows) types[row.kind] = { id: row.id, series: row.series };
  });
  await inEarlierCompany(admin, other, async () => {
    const unit = (await admin.query("INSERT INTO stock_unit (company_id, symbol) VALUES ($1, 'Theirs') RETURNING id", [other])).rows[0].id;
    ids.otherItem = (await admin.query("INSERT INTO stock_item (company_id, name, unit_id) VALUES ($1, 'Theirs', $2) RETURNING id", [other, unit])).rows[0].id;
  });
});

test('inventory_line leads with company_id, references only within the company, is forced under the company policy and gives no UPDATE', async () => {
  await assert.doesNotReject(assertDatabaseRoles(getDatabase().pool), 'the boot assertion covers it');
  assert.ok(accountingTables.includes('inventory_line'));
  await asAdmin(database.adminUrl, client => client.query('ALTER TABLE inventory_line NO FORCE ROW LEVEL SECURITY'));
  try {
    await assert.rejects(assertDatabaseRoles(getDatabase().pool), /not enabled and forced on inventory_line/, 'the boot assertion fails when the table loses forced RLS');
  } finally { await asAdmin(database.adminUrl, client => client.query('ALTER TABLE inventory_line FORCE ROW LEVEL SECURITY')); }
  const shape = await asAdmin(database.adminUrl, async client => ({
    keys: (await client.query(`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE contype IN ('f', 'p', 'u') AND conrelid = 'inventory_line'::regclass ORDER BY 1`)).rows,
    grants: (await client.query(`SELECT p FROM unnest('{SELECT,INSERT,UPDATE,DELETE,TRUNCATE}'::text[]) p WHERE has_table_privilege('books_app', 'inventory_line', p) ORDER BY 1`)).rows.map(row => row.p),
    definers: (await client.query(`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
      AND (proname LIKE 'inventory_%' OR proname IN ('voucher_assert_balanced', 'stock_unit_guard', 'stock_item_guard', 'ledger_seed_company'))
      AND (prosecdef OR NOT coalesce(array_to_string(proconfig, ',') LIKE '%search_path=public, pg_temp%', false))`)).rows,
  }));
  for (const key of shape.keys) assert.match(key.definition, /^(PRIMARY KEY|FOREIGN KEY) \(company_id[,)]/, `${key.conname}: ${key.definition}`);
  assert.equal(shape.keys.length, 7, 'the primary key, the company key and five composite foreign keys');
  assert.deepEqual(shape.grants, ['DELETE', 'INSERT', 'SELECT']);
  assert.deepEqual(shape.definers, [], 'no SECURITY DEFINER, and a fixed search path on each function');
});

test('the database accepts item rows that fit their kind: an invoice line carrying its items, a stock journal in both directions, a zero-cost stock journal row', async () => {
  await assert.doesNotReject(asApp(sale([{ direction: 'out', quantity: '1.25', amount: 500 }, { item: ids.bolt, direction: 'out', quantity: '3', amount: 300, discount: '10' }])));
  await assert.doesNotReject(asApp(client => writeVoucher(client, 'stock_journal', [], journalRows([
    { direction: 'out', quantity: '2', amount: 400 }, { direction: 'in', location: ids.yard, quantity: '2', amount: 400 }, { item: ids.bolt, direction: 'in', quantity: '1', amount: 0 }]))));
  await assert.doesNotReject(asApp(client => writeVoucher(client, 'purchase', [[ids.purchases, 'Dr', 900], [ids.customer, 'Cr', 900]],
    [{ direction: 'in', quantity: '3', amount: 900, ledger: ids.purchases }])));
});

test('the database refuses, as the application role inside the company scope, item rows that break the kind, the sums or the unit', async () => {
  const kind = code('23514', ['inventory_line_kind', 'voucher_inventory_kind']);
  const cases: [string, (client: PoolClient) => Promise<unknown>, (error: unknown) => boolean][] = [
    ['a sales row coming in', sale([{ direction: 'in', quantity: '1', amount: 100 }]), code('23514', 'inventory_line_kind')],
    ['a zero amount on an invoice row', sale([{ direction: 'out', quantity: '1', amount: 0 }, { direction: 'out', quantity: '1', amount: 100 }]), code('23514', 'inventory_line_kind')],
    ['a row on a journal', client => writeVoucher(client, 'journal', [[ids.sales, 'Cr', 100], [ids.customer, 'Dr', 100]], [{ direction: 'out', quantity: '1', amount: 100 }]), code('23514', 'inventory_line_kind')],
    ['a row whose ledger is not its line\'s', sale([{ direction: 'out', quantity: '1', amount: 100, ledger: ids.purchases }]), code('23514', 'inventory_line_kind')],
    ['a row on a line of the other side', client => writeVoucher(client, 'sales', [[ids.sales, 'Dr', 100], [ids.customer, 'Cr', 100]], [{ direction: 'out', quantity: '1', amount: 100 }]), code('23514', 'inventory_line_kind')],
    ['an invoice row without a line', sale([{ direction: 'out', quantity: '1', amount: 100, ledger: null, line: null }], 100), code('23514', 'inventory_line_kind')],
    ['items not adding up to their line', sale([{ direction: 'out', quantity: '1', amount: 100 }], 150), code('23514', 'inventory_line_total')],
    ['items above their line', sale([{ direction: 'out', quantity: '1', amount: 150 }], 100), code('23514', 'inventory_line_total')],
    ['a credit note row going out (on the right line and side)', client => writeVoucher(client, 'credit_note', [[ids.sales, 'Dr', 100], [ids.customer, 'Cr', 100]], [{ direction: 'out', quantity: '1', amount: 100 }]), code('23514', 'inventory_line_kind')],
    ['a stock journal carrying ledger lines beside its rows', client => writeVoucher(client, 'stock_journal', [[ids.sales, 'Cr', 100], [ids.customer, 'Dr', 100]], journalRows([{ direction: 'in', quantity: '1', amount: 100 }])), code('23514', 'voucher_inventory_kind')],
    ['a stock journal row on a line', client => writeVoucher(client, 'stock_journal', [[ids.sales, 'Cr', 100], [ids.customer, 'Dr', 100]], [{ direction: 'out', quantity: '1', amount: 100 }]), kind],
    ['a stock journal without item rows', client => writeVoucher(client, 'stock_journal', [], []), code('23514', 'voucher_inventory_kind')],
    ['a discount on a stock journal row', client => writeVoucher(client, 'stock_journal', [], journalRows([{ direction: 'in', quantity: '1', amount: 100, discount: '5' }])), code('23514', 'inventory_line_kind')],
    ['more quantity places than the unit', sale([{ direction: 'out', quantity: '1.125', amount: 100 }]), code('23514', 'inventory_line_quantity_places')],
    ['an item of another company', sale([{ item: ids.otherItem, direction: 'out', quantity: '1', amount: 100 }]), code('23503')],
    ['a discount of 100', sale([{ direction: 'out', quantity: '1', amount: 100, discount: '100' }]), code('23514', 'inventory_line_discount_percent_check')],
    ['an item row on a void', client => writeVoucher(client, 'sales', [], [{ direction: 'out', quantity: '1', amount: 100, ledger: null, line: null }], 'cancelled'), code('23514', 'voucher_lines_frozen')],
    ['changing an item row', client => client.query('UPDATE inventory_line SET amount = 1 WHERE company_id = $1', [companyId]), code('42501')],
    ['a row written for a company outside the scope', client => client.query(`INSERT INTO inventory_line (company_id, voucher_id, entry_no, item_id, location_id, direction, quantity, rate, amount)
      VALUES ($1, $2, 1, $3, $3, 'in', 1, 1, 1)`, [other, randomUUID(), ids.otherItem]), code('42501')],
    ['switching the guards off', client => client.query('ALTER TABLE inventory_line DISABLE TRIGGER USER'), code('42501')],
  ];
  const before = Number((await one('SELECT count(*) FROM inventory_line', [])).count);
  for (const [name, run, expected] of cases) await assert.rejects(asApp(run), expected, name);
  assert.equal(Number((await one('SELECT count(*) FROM inventory_line', [])).count), before, 'nothing was written');
});

test('a stock journal keeps at least one item row, and the remaining rows of an invoice line must still add up', async () => {
  let journal = '', invoice = '';
  await asApp(async client => {
    journal = await writeVoucher(client, 'stock_journal', [], journalRows([{ direction: 'in', quantity: '1', amount: 100 }, { direction: 'in', quantity: '2', amount: 200 }]));
    invoice = await sale([{ direction: 'out', quantity: '1', amount: 100 }, { direction: 'out', quantity: '1', amount: 50 }])(client);
  });
  await assert.doesNotReject(asApp(client => client.query('DELETE FROM inventory_line WHERE company_id = $1 AND voucher_id = $2 AND entry_no = 2', [companyId, journal])), 'one row may go');
  await assert.rejects(asApp(client => client.query('DELETE FROM inventory_line WHERE company_id = $1 AND voucher_id = $2', [companyId, journal])), code('23514', 'inventory_line_kind'), 'not the last');
  await assert.rejects(asApp(client => client.query('DELETE FROM inventory_line WHERE company_id = $1 AND voucher_id = $2 AND entry_no = 2', [companyId, invoice])), code('23514', 'inventory_line_total'), 'an invoice line keeps its sum');
  // The line removed takes its rows with it (an alter replaces both).
  await assert.doesNotReject(asApp(async client => {
    await client.query('DELETE FROM voucher_line WHERE company_id = $1 AND voucher_id = $2', [companyId, invoice]);
    await client.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
      VALUES ($1, $2, 1, $3, 'Cr', 70, 'AED', 70, 1), ($1, $2, 2, $4, 'Dr', 70, 'AED', 70, 1)`, [companyId, invoice, ids.sales, ids.customer]);
    await client.query(`INSERT INTO inventory_line (company_id, voucher_id, entry_no, item_id, location_id, direction, quantity, rate, amount, ledger_id, line_no)
      VALUES ($1, $2, 1, $3, $4, 'out', 1, 0.7, 70, $5, 1)`, [companyId, invoice, ids.rod, ids.main, ids.sales]);
  }));
  assert.equal(Number((await one('SELECT count(*) FROM inventory_line WHERE company_id = $1 AND voucher_id = $2', [companyId, invoice])).count), 1);
});

test('a voucher moved to another type by direct SQL is checked again: its item rows must fit the new kind (defect 6)', async () => {
  let invoice = '';
  await asApp(async client => { invoice = await sale([{ direction: 'out', quantity: '1', amount: 100 }])(client); });
  for (const target of ['journal', 'purchase', 'stock_journal']) {
    await assert.rejects(asApp(client => client.query('UPDATE voucher SET voucher_type_id = $3, series = $4 WHERE company_id = $1 AND id = $2', [companyId, invoice, types[target].id, types[target].series])),
      code('23514', 'voucher_inventory_kind'), target);
  }
  // A credit note is the other direction too; a debit note takes sales' direction and side, so it fits.
  await assert.rejects(asApp(client => client.query('UPDATE voucher SET voucher_type_id = $3, series = $4 WHERE company_id = $1 AND id = $2', [companyId, invoice, types.credit_note.id, types.credit_note.series])),
    code('23514', 'voucher_inventory_kind'), 'credit_note');
  await assert.doesNotReject(asApp(client => client.query('UPDATE voucher SET voucher_type_id = $3, series = $4 WHERE company_id = $1 AND id = $2', [companyId, invoice, types.debit_note.id, types.debit_note.series])), 'debit_note');
});

/**
 * Direct SQL as the application role: `change` (on the unit, or on the item's unit) and an insert of an item row of
 * 1.5 on an item of a two-place unit run in two sessions. Whichever comes first holds its transaction open; the second
 * must wait for it and then be checked against what it committed, or go through once it rolled back. Each order runs
 * on fresh masters.
 */
async function raceItemRow(name: string, change: (client: PoolClient, unit: string, item: string, whole: string) => Promise<unknown>, changeRefusal: string): Promise<void> {
  for (const first of ['change', 'insert'] as const) {
    for (const end of ['COMMIT', 'ROLLBACK'] as const) {
      const tag = `${name} ${first} ${end}`;
      let unit = '', whole = '', item = '';
      await asApp(async client => {
        unit = (await client.query("INSERT INTO stock_unit (company_id, symbol, decimals) VALUES ($1, $2, 2) RETURNING id", [companyId, `U ${tag}`])).rows[0].id;
        whole = (await client.query("INSERT INTO stock_unit (company_id, symbol, decimals) VALUES ($1, $2, 0) RETURNING id", [companyId, `W ${tag}`])).rows[0].id;
        item = (await client.query('INSERT INTO stock_item (company_id, name, unit_id) VALUES ($1, $2, $3) RETURNING id', [companyId, `I ${tag}`, unit])).rows[0].id;
      });
      const held = await openApp();
      let waiting: Promise<unknown> | undefined;
      try {
        if (first === 'change') {
          await change(held.client, unit, item, whole);
          waiting = asApp(sale([{ item, direction: 'out', quantity: '1.5', amount: 150 }]));
        } else {
          await sale([{ item, direction: 'out', quantity: '1.5', amount: 150 }])(held.client);
          waiting = asApp(client => change(client, unit, item, whole));
        }
        assert.equal(await state(waiting), 'waiting', `${tag}: the second session waits for the first`);
        await held.end(end);
        if (end === 'ROLLBACK') await assert.doesNotReject(waiting, `${tag}: accepted once the first rolled back`);
        else if (first === 'change') await assert.rejects(waiting, code('23514', 'inventory_line_quantity_places'), `${tag}: checked against the committed change`);
        else await assert.rejects(waiting, code('23514', changeRefusal), `${tag}: the change sees the committed row`);
      } finally {
        await held.end('ROLLBACK');
        await waiting?.catch(() => undefined);
      }
    }
  }
}

test('by direct SQL, an item row and a unit\'s decimals lowered in two sessions wait for each other, in either order, with commit and rollback', async () => {
  await raceItemRow('decimals', (client, unit) => client.query('UPDATE stock_unit SET decimals = 0 WHERE company_id = $1 AND id = $2', [companyId, unit]), 'stock_unit_decimals');
});

test('by direct SQL, an item row and its item\'s unit changed in two sessions wait for each other, in either order, with commit and rollback', async () => {
  await raceItemRow('unit', (client, _unit, item, whole) => client.query('UPDATE stock_item SET unit_id = $3 WHERE company_id = $1 AND id = $2', [companyId, item, whole]), 'stock_item_unit_fixed');
});

type Counters = { seq_scan: number; seq_tup_read: number; idx_scan: number; idx_tup_fetch: number };
const counters = async (client: PoolClient, table: string): Promise<Counters> => {
  const { rows } = await client.query<Record<keyof Counters, string>>('SELECT seq_scan, seq_tup_read, idx_scan, idx_tup_fetch FROM pg_stat_xact_user_tables WHERE relname = $1', [table]);
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)])) as Counters;
};
const delta = (after: Counters, before: Counters) => ({ seq_tup_read: after.seq_tup_read - before.seq_tup_read, idx_tup_fetch: after.idx_tup_fetch - before.idx_tup_fetch, idx_scan: after.idx_scan - before.idx_scan });

test('the guards seek item rows by item and the per-line check by its line: beside 3,000 other items with item rows, without and with table statistics', async () => {
  let spare = '', mover = '';
  await asAdmin(database.adminUrl, async client => {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.company_ids', $1, true)", [companyId]);
    spare = (await client.query("INSERT INTO stock_unit (company_id, symbol, decimals) VALUES ($1, 'Spare', 3) RETURNING id", [companyId])).rows[0].id;
    // Two items of the unit without item rows: one stays, one moves to another unit and back.
    await client.query("INSERT INTO stock_item (company_id, name, unit_id) VALUES ($1, 'Spare item', $2)", [companyId, spare]);
    mover = (await client.query("INSERT INTO stock_item (company_id, name, unit_id) VALUES ($1, 'Moving item', $2) RETURNING id", [companyId, spare])).rows[0].id;
    // 3,000 other items of the unit Nos, each with one item row: six stock journals of 500 rows.
    await client.query(`INSERT INTO stock_item (company_id, name, unit_id) SELECT $1, 'Bulk ' || n, $2 FROM generate_series(1, 3000) n`, [companyId, ids.nos]);
    for (let journal = 0; journal < 6; journal++) {
      const voucher = (await client.query(`INSERT INTO voucher (company_id, voucher_type_id, series, date, status, idempotency_key, request_hash, created_by)
        VALUES ($1, $2, $3, '2026-03-01', 'optional', $4, $5, $6) RETURNING id`, [companyId, types.stock_journal.id, types.stock_journal.series, `bulk-${randomUUID()}`, 'a'.repeat(64), user])).rows[0].id;
      await client.query(`INSERT INTO inventory_line (company_id, voucher_id, entry_no, item_id, location_id, direction, quantity, rate, amount)
        SELECT $1, $2, row_number() OVER (ORDER BY i.id), i.id, $3, 'in', 1, 1, 100
        FROM (SELECT id FROM stock_item WHERE company_id = $1 AND name LIKE 'Bulk %' ORDER BY id OFFSET $4 LIMIT 500) i`, [companyId, voucher, ids.main, journal * 500]);
    }
    await client.query('COMMIT');
  });
  for (const tables of ['without statistics', 'analysed'] as const) {
    if (tables === 'analysed') await asAdmin(database.adminUrl, client => client.query('ANALYZE inventory_line; ANALYZE stock_item; ANALYZE voucher_line'));
    await asApp(async client => {
      // Lowering the decimals of a unit whose items have no rows, and changing one item's unit, fetch no item row.
      // Seven rounds in one session, so the guards' cached plans pass PL/pgSQL's switch to a generic plan (after five).
      for (let round = 0; round < 7; round++) {
        await client.query('UPDATE stock_unit SET decimals = 4 WHERE company_id = $1 AND id = $2', [companyId, spare]);
        for (const [what, sql, value] of [
          ['lowering the decimals', 'UPDATE stock_unit SET decimals = 1 WHERE company_id = $1 AND id = $2', [spare]],
          ['changing the unit', 'UPDATE stock_item SET unit_id = $3 WHERE company_id = $1 AND id = $2', [mover, round % 2 ? spare : ids.kg]],
        ] as const) {
          const start = await counters(client, 'inventory_line');
          await client.query(sql, [companyId, ...value]);
          const guard = delta(await counters(client, 'inventory_line'), start);
          assert.deepEqual([guard.seq_tup_read, guard.idx_tup_fetch], [0, 0], `${tables}, round ${round}, ${what}: ${JSON.stringify(guard)}`);
          assert.ok(guard.idx_scan >= 1, `${tables}, round ${round}, ${what}: the item index was used`);
        }
      }
      // Back on the unit, for the next pass.
      await client.query('UPDATE stock_item SET unit_id = $3 WHERE company_id = $1 AND id = $2', [companyId, mover, spare]);
      // A sale of four items on one line: the checks at commit read only this voucher's rows.
      const posted = await counters(client, 'inventory_line');
      await sale([1, 2, 3, 4].map(() => ({ item: ids.bolt, direction: 'out' as const, quantity: '1', amount: 25 })))(client);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      const checks = delta(await counters(client, 'inventory_line'), posted);
      assert.equal(checks.seq_tup_read, 0, `${tables}, checks: ${JSON.stringify(checks)}`);
      // Per row, its line's 4 rows (16); per firing of the voucher check (the voucher and its two lines), the voucher's 4
      // rows counted (12); the kind re-check on the voucher's own event, its 4 rows (4).
      assert.ok(checks.idx_tup_fetch <= 4 * 4 + 3 * 4 + 4, `${tables}, checks fetch only this voucher's rows: ${JSON.stringify(checks)}`);
    });
  }
});

const write = <T>(run: (context: LedgerContext) => Promise<T>) => inCompany(user, companyId, run, 'write');
/** Runs `first` in a write transaction held open until `second` has been started and seen waiting (or not); returns both. */
async function race<A, B>(first: (context: LedgerContext) => Promise<A>, second: (context: LedgerContext) => Promise<B>): Promise<{ waited: unknown; second: Promise<B> }> {
  let release!: () => void, done!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { done = resolve; });
  const firstWrite = write(async context => { const result = await first(context); done(); await held; return result; });
  await started;
  const secondWrite = write(second);
  const waited = await state(secondWrite);
  release();
  await firstWrite;
  await secondWrite.catch(() => undefined);
  return { waited, second: secondWrite };
}
const masters = async (tag: string, decimals = 2) => {
  let unit = '', item = '', location = '';
  await asApp(async client => {
    unit = (await client.query('INSERT INTO stock_unit (company_id, symbol, decimals) VALUES ($1, $2, $3) RETURNING id', [companyId, `Unit ${tag}`, decimals])).rows[0].id;
    item = (await client.query('INSERT INTO stock_item (company_id, name, unit_id) VALUES ($1, $2, $3) RETURNING id', [companyId, `Item ${tag}`, unit])).rows[0].id;
    location = (await client.query('INSERT INTO stock_location (company_id, name) VALUES ($1, $2) RETURNING id', [companyId, `Store ${tag}`])).rows[0].id;
  });
  return { unit, item, location };
};
const posting = (item: string, location: string, quantity = '1.5') => (context: LedgerContext) => createVoucher(context, {
  idempotencyKey: `race-${randomUUID()}`, voucherTypeId: types.sales.id, date: '2026-02-10',
  lines: [{ ledgerId: ids.customer, side: 'Dr', amount: '7.50' }], itemLedgerId: ids.sales,
  inventory: [{ itemId: item, locationId: location, quantity, amount: '7.50' }],
});
const refusedWith = (expected: string) => (error: { code?: string }) => error.code === expected;

test('through the API: lowering the decimals of a unit while a posting on it is in flight waits, then is refused', async () => {
  const { unit, item, location } = await masters('decimals');
  const { waited, second } = await race(posting(item, location), context => alterUnit(context, unit, { symbol: 'Unit decimals', decimals: 0, revision: 1 }));
  assert.equal(waited, 'waiting');
  await assert.rejects(second, refusedWith('in_use'));
});

test('through the API: a unit delete while a posting holds one of its items answers in_use at once', async () => {
  const { unit, item, location } = await masters('delete unit');
  const { waited, second } = await race(posting(item, location), context => deleteUnit(context, unit, { revision: 1 }));
  assert.equal(waited, 'settled', 'no wait, so no deadlock');
  await assert.rejects(second, refusedWith('in_use'));
});

test('through the API: an item or location deleted while a posting waits on it answers not_found; deleted after it, in_use', async () => {
  const gone = await masters('gone item');
  const { waited: itemWaited, second: onItem } = await race(context => deleteItem(context, gone.item, { revision: 1 }), posting(gone.item, gone.location));
  assert.equal(itemWaited, 'waiting');
  await assert.rejects(onItem, (error: { code?: string; message?: string }) => error.code === 'not_found' && /^The item on item line 1 was not found/.test(error.message ?? ''));
  const store = await masters('gone store');
  const { waited: storeWaited, second: onStore } = await race(context => deleteTree(context, 'stock-locations', store.location, { revision: 1 }), posting(store.item, store.location));
  assert.equal(storeWaited, 'waiting');
  await assert.rejects(onStore, (error: { code?: string; message?: string }) => error.code === 'not_found' && /^The location of item line 1 was not found/.test(error.message ?? ''));
  const kept = await masters('kept item');
  const { second: late } = await race(posting(kept.item, kept.location), context => deleteItem(context, kept.item, { revision: 1 }));
  await assert.rejects(late, refusedWith('in_use'));
  const { second: lateStore } = await race(posting(kept.item, kept.location, '2'), context => deleteTree(context, 'stock-locations', kept.location, { revision: 1 }));
  await assert.rejects(lateStore, refusedWith('in_use'));
});

test('more refusals the database makes alone: a cancelled voucher\'s rows stay, a tampered scope is caught at commit, a type change into a stock journal with lines', async () => {
  // A regular voucher, posted and cancelled through the API: its item rows are frozen.
  const posted = await write(posting(ids.bolt, ids.main, '1'));
  await write(context => cancelVoucher(context, posted.voucher.id, { revision: posted.voucher.revision }));
  await assert.rejects(asApp(client => client.query('DELETE FROM inventory_line WHERE company_id = $1 AND voucher_id = $2', [companyId, posted.voucher.id])), code('23514', 'voucher_lines_frozen'));
  // The check at commit asserts the scope: a scope changed after a delete would otherwise hide the voucher and skip it.
  let journal = '';
  await asApp(async client => { journal = await writeVoucher(client, 'stock_journal', [], journalRows([{ direction: 'in', quantity: '1', amount: 100 }, { direction: 'in', quantity: '1', amount: 100 }])); });
  await assert.rejects(asApp(async client => {
    await client.query('DELETE FROM inventory_line WHERE company_id = $1 AND voucher_id = $2 AND entry_no = 2', [companyId, journal]);
    await client.query("SELECT set_config('app.company_ids', $1, true)", [other]);
  }), code('42501', 'ledger_company_scope'));
  // A voucher with ledger lines and no item rows moved into the stock journal kind.
  let plain = '';
  await asApp(async client => { plain = await writeVoucher(client, 'sales', [[ids.sales, 'Cr', 100], [ids.customer, 'Dr', 100]], []); });
  await assert.rejects(asApp(client => client.query('UPDATE voucher SET voucher_type_id = $3, series = $4 WHERE company_id = $1 AND id = $2', [companyId, plain, types.stock_journal.id, types.stock_journal.series])),
    code('23514', 'voucher_inventory_kind'));
  // A stock journal may be entered as a void (cancelled, nothing in it), as any voucher may.
  const voided = await write(context => createVoucher(context, { idempotencyKey: `void-${randomUUID()}`, voucherTypeId: types.stock_journal.id, date: '2026-02-10', status: 'cancelled', lines: [] }));
  assert.deepEqual([voided.voucher.status, voided.voucher.number !== null, voided.voucher.inventory], ['cancelled', true, []]);
});

/** A sales voucher with its sales line and no item rows, so an item row of `amount` may be added to line 1 on its own. */
const bareSale = async (amount = 100) => {
  let voucher = '';
  await asApp(async client => { voucher = await writeVoucher(client, 'sales', [[ids.sales, 'Cr', amount], [ids.customer, 'Dr', amount]], []); });
  return voucher;
};
const addRow = (voucher: string, quantity = '1', amount = 100, entry = 1, item = ids.bolt) => (client: PoolClient) => client.query(
  `INSERT INTO inventory_line (company_id, voucher_id, entry_no, item_id, location_id, direction, quantity, rate, amount, ledger_id, line_no)
   VALUES ($1, $2, $3, $4, $5, 'out', $6, 1, $7, $8, 1)`, [companyId, voucher, entry, item, ids.main, quantity, amount, ids.sales]);
const toJournal = (voucher: string) => (client: PoolClient) =>
  client.query('UPDATE voucher SET voucher_type_id = $3, series = $4 WHERE company_id = $1 AND id = $2', [companyId, voucher, types.journal.id, types.journal.series]);

test('in REPEATABLE READ, a type change, a unit\'s decimals lowered and an item\'s unit changed are refused: their checks would read an older snapshot', async () => {
  // Each case: the first session takes its snapshot; a second inserts and commits a row the change must see; the change
  // in the first session is refused at once, where it would otherwise pass against its snapshot.
  const cases: [string, () => Promise<{ setup: (client: PoolClient) => Promise<unknown>; change: (client: PoolClient) => Promise<unknown> }>, string][] = [
    ['a type change past an item row', async () => { const voucher = await bareSale(); return { setup: addRow(voucher), change: toJournal(voucher) }; }, 'voucher_inventory_kind'],
    ['lowering decimals past an item row', async () => { const m = await masters('rr item row'); const voucher = await bareSale(150);
      return { setup: addRow(voucher, '1.5', 150, 1, m.item), change: client => client.query('UPDATE stock_unit SET decimals = 0 WHERE company_id = $1 AND id = $2', [companyId, m.unit]) }; }, 'stock_unit_decimals'],
    ['lowering decimals past an opening row', async () => { const m = await masters('rr opening row');
      return { setup: client => client.query('INSERT INTO stock_opening (company_id, item_id, location_id, quantity, rate, value) VALUES ($1, $2, $3, 1.5, 2, 300)', [companyId, m.item, ids.main]),
        change: client => client.query('UPDATE stock_unit SET decimals = 0 WHERE company_id = $1 AND id = $2', [companyId, m.unit]) }; }, 'stock_unit_decimals'],
    ['changing the unit past an item row', async () => { const m = await masters('rr unit item'); const voucher = await bareSale(150);
      return { setup: addRow(voucher, '1.5', 150, 1, m.item), change: client => client.query('UPDATE stock_item SET unit_id = $3 WHERE company_id = $1 AND id = $2', [companyId, m.item, ids.nos]) }; }, 'stock_item_unit_fixed'],
    ['changing the unit past an opening row', async () => { const m = await masters('rr unit opening');
      return { setup: client => client.query('INSERT INTO stock_opening (company_id, item_id, location_id, quantity, rate, value) VALUES ($1, $2, $3, 1.5, 2, 300)', [companyId, m.item, ids.main]),
        change: client => client.query('UPDATE stock_item SET unit_id = $3 WHERE company_id = $1 AND id = $2', [companyId, m.item, ids.nos]) }; }, 'stock_item_unit_fixed'],
  ];
  for (const [what, prepare, constraint] of cases) {
    const { setup, change } = await prepare();
    const first = await openApp('REPEATABLE READ');
    try {
      await first.client.query('SELECT 1 FROM company');
      await asApp(setup);
      await assert.rejects(change(first.client), code('25001', constraint), what);
    } finally { await first.end('ROLLBACK'); }
  }
});

test('in READ COMMITTED, a type change and an item row inserted beside it wait for each other, in either order: the key index makes the change a key update', async () => {
  for (const order of ['row first', 'type first'] as const) {
    const voucher = await bareSale();
    const first = await openApp();
    let second: Promise<unknown> | undefined;
    try {
      await (order === 'row first' ? addRow(voucher) : toJournal(voucher))(first.client);
      second = asApp(order === 'row first' ? toJournal(voucher) : addRow(voucher));
      assert.equal(await state(second), 'waiting', `${order}: the second waits`);
      await first.end('COMMIT');
      await assert.rejects(second, code('23514', order === 'row first' ? 'voucher_inventory_kind' : 'inventory_line_kind'), `${order}: checked against the first`);
    } finally { await first.end('ROLLBACK'); await second?.catch(() => undefined); }
  }
});

test('two sessions deleting one row each of a two-row stock journal: the second waits for the first and is refused; in REPEATABLE READ the delete is refused', async () => {
  let journal = '';
  await asApp(async client => { journal = await writeVoucher(client, 'stock_journal', [], journalRows([{ direction: 'in', quantity: '1', amount: 100 }, { direction: 'in', quantity: '1', amount: 100 }])); });
  const drop = (entry: number) => async (client: PoolClient) => {
    await client.query('DELETE FROM inventory_line WHERE company_id = $1 AND voucher_id = $2 AND entry_no = $3', [companyId, journal, entry]);
    // Both checks run before either session commits.
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  };
  const first = await openApp();
  let second: Promise<unknown> | undefined;
  try {
    await drop(1)(first.client);
    second = asApp(drop(2));
    assert.equal(await state(second), 'waiting', 'the second check waits for the first');
    await first.end('COMMIT');
    await assert.rejects(second, code('23514', 'inventory_line_kind'), 'and then sees the first delete');
  } finally { await first.end('ROLLBACK'); await second?.catch(() => undefined); }
  assert.equal(Number((await one('SELECT count(*) FROM inventory_line WHERE company_id = $1 AND voucher_id = $2', [companyId, journal])).count), 1);
  const repeatable = await openApp('REPEATABLE READ');
  try {
    await repeatable.client.query('INSERT INTO inventory_line (company_id, voucher_id, entry_no, item_id, location_id, direction, quantity, rate, amount) VALUES ($1, $2, 3, $3, $4, \'in\', 1, 1, 100)', [companyId, journal, ids.rod, ids.main]);
    await repeatable.client.query('DELETE FROM inventory_line WHERE company_id = $1 AND voucher_id = $2 AND entry_no = 2', [companyId, journal]);
    await assert.rejects(repeatable.client.query('SET CONSTRAINTS ALL IMMEDIATE'), code('25001', 'inventory_line_kind'));
  } finally { await repeatable.end('ROLLBACK'); }
});

test('two rows added to one invoice line cannot pass its sum check together: in READ COMMITTED the second waits and is refused; in REPEATABLE READ it is refused', async () => {
  // Write skew: each session adds 100 to a line of 100 and runs its checks before either commits.
  const skewed = await bareSale(100);
  const add = (entry: number) => async (client: PoolClient) => { await addRow(skewed, '1', 100, entry)(client); await client.query('SET CONSTRAINTS ALL IMMEDIATE'); };
  const first = await openApp();
  let second: Promise<unknown> | undefined;
  try {
    await add(1)(first.client);
    second = asApp(add(2));
    assert.equal(await state(second), 'waiting', 'the second check waits for the first');
    await first.end('COMMIT');
    await assert.rejects(second, code('23514', 'inventory_line_total'), 'and then sees the first row');
  } finally { await first.end('ROLLBACK'); await second?.catch(() => undefined); }
  // A stale snapshot, no concurrency needed: a row committed after the snapshot would be missed.
  const stale = await bareSale(100);
  const repeatable = await openApp('REPEATABLE READ');
  try {
    await repeatable.client.query('SELECT 1 FROM company');
    await asApp(addRow(stale, '1', 100, 1));
    await addRow(stale, '1', 100, 2)(repeatable.client);
    await assert.rejects(repeatable.client.query('SET CONSTRAINTS ALL IMMEDIATE'), code('25001', 'inventory_line_total'));
  } finally { await repeatable.end('ROLLBACK'); }
  for (const voucher of [skewed, stale]) {
    assert.equal(Number((await one('SELECT coalesce(sum(amount), 0) AS sum FROM inventory_line WHERE company_id = $1 AND voucher_id = $2', [companyId, voucher])).sum), 100, 'the line still carries 100');
  }
});

test('a soft-deleted voucher\'s item rows are frozen like a cancelled one\'s', async () => {
  const posted = await write(posting(ids.bolt, ids.main, '1'));
  await write(context => deleteVoucher(context, posted.voucher.id, { revision: posted.voucher.revision }));
  await assert.rejects(asApp(client => client.query('DELETE FROM inventory_line WHERE company_id = $1 AND voucher_id = $2', [companyId, posted.voucher.id])), code('23514', 'voucher_lines_frozen'));
  await assert.rejects(asApp(addRow(posted.voucher.id, '1', 750, 2)), code('23514', 'voucher_lines_frozen'));
});
