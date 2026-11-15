import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { demoRoot, listDatasetFolders, loadDataset, type Dataset } from '../src/server/demo/dataset.ts';
import { seedDataset } from '../src/server/demo/seed.ts';
import { migrationFiles } from '../src/server/db.ts';
import { migrateDatabase } from '../src/server/startup-migrate.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { chart, createCompany, setupOwner } from './helpers/ledger.ts';

/**
 * Migration 0014 on a database at 0013 that holds the five demo companies. Two rows sharing an id (possible only by
 * direct SQL, here with the guards off) stop it before any index is built, named by table and count, never by id;
 * removed, it applies, every row is as it was, and seeding again changes nothing. Then a create request that carries an
 * id is refused on every route that creates rows of the five tables (the ids are the server's: docs/TENANCY.md).
 */
const thisMigration = '0014_lookup_by_id.sql';
const earlier = migrationFiles.slice(0, migrationFiles.indexOf(thisMigration));
const indexed = ['ledger', 'stock_item', 'stock_unit', 'voucher', 'voucher_type'];
let database: TestDatabase;
let admin: pg.Client;
let datasets: Dataset[];
const user = randomUUID();

/** Statements under the all-company scope (every company is a workspace). */
const scoped = async <T>(run: () => Promise<T>, guardsOff = false): Promise<T> => {
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', coalesce((SELECT string_agg(id, ',') FROM workspace), ''), true)");
  if (guardsOff) await admin.query('SET LOCAL session_replication_role = replica');
  try { const result = await run(); await admin.query('COMMIT'); return result; }
  catch (error) { await admin.query('ROLLBACK'); throw error; }
};
/** Each indexed table's row count and a digest of its rows, so "nothing changed" compares every row. */
const snapshot = () => scoped(async () => Object.fromEntries(await Promise.all([...indexed, 'voucher_line', 'inventory_line'].map(async table =>
  [table, (await admin.query(`SELECT count(*)::int AS rows, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest FROM ${table} t`)).rows[0]]))));

before(async () => {
  database = await freshDatabase('lookupbyid_migration', { migrations: earlier });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await admin.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [user, `owner-${user}@books.test`]);
  datasets = await Promise.all((await listDatasetFolders(demoRoot)).map(slug => loadDataset(join(demoRoot, slug))));
  for (const dataset of datasets) await seedDataset(user, dataset);
});
after(async () => { await admin?.end(); await database?.drop(); });

test('two rows sharing an id stop 0014 before any index, named by table and count only; removed, it applies and changes no row', async () => {
  const before0014 = await snapshot();
  // A voucher and a ledger of one demo company written again, with the same ids, into another.
  const shared = await scoped(async () => {
    const [from, to] = (await admin.query('SELECT company_id FROM company ORDER BY company_id LIMIT 2')).rows.map(row => row.company_id as string);
    const voucher = (await admin.query('SELECT * FROM voucher WHERE company_id = $1 LIMIT 1', [from])).rows[0];
    const ledger = (await admin.query('SELECT * FROM ledger WHERE company_id = $1 AND system_key IS NULL LIMIT 1', [from])).rows[0];
    await admin.query(`INSERT INTO voucher (company_id, id, voucher_type_id, series, date, status, idempotency_key, request_hash, created_by)
      SELECT $1, $2, id, numbering_series, '2026-01-05', 'optional', 'shared-id', $3, $4 FROM voucher_type WHERE company_id = $1 AND kind = 'journal'`, [to, voucher.id, 'a'.repeat(64), user]);
    await admin.query('INSERT INTO ledger (company_id, id, group_id, name, currency) SELECT $1, $2, group_id, $3, currency FROM ledger WHERE id = $2 AND company_id = $4',
      [to, ledger.id, 'Shared id', from]);
    return { to, voucher: voucher.id as string, ledger: ledger.id as string };
  }, true);

  await assert.rejects(migrateDatabase({ log: () => undefined }), /Database migration failed \(PostgreSQL error P0001\) and was rolled back; nothing was applied/);
  // The runner reports only the SQLSTATE; run as the migrator (and rolled back), the file's own refusal names the tables.
  const migrator = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await migrator.connect();
  try {
    await migrator.query('BEGIN');
    await assert.rejects(migrator.query(readFileSync(join(process.cwd(), 'migrations', thisMigration), 'utf8')), (error: Error) => {
      assert.equal(error.message, 'these tables hold ids shared by more than one row, which the unique id indexes cannot take; correct them first: ledger: 1 id(s); voucher: 1 id(s)');
      assert.ok(!error.message.includes(shared.voucher) && !error.message.includes(shared.ledger), 'never an id');
      return true;
    });
  } finally { await migrator.query('ROLLBACK').catch(() => undefined); await migrator.end(); }
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), earlier.length, '0014 was not applied');
  assert.equal((await admin.query("SELECT count(*)::int AS found FROM pg_class WHERE relname = 'voucher_id_key'")).rows[0].found, 0, 'no index was built');

  await scoped(async () => {
    await admin.query('DELETE FROM voucher WHERE company_id = $1 AND id = $2', [shared.to, shared.voucher]);
    await admin.query('DELETE FROM ledger WHERE company_id = $1 AND id = $2', [shared.to, shared.ledger]);
  }, true);
  await migrateDatabase({ log: () => undefined });
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), migrationFiles.length);
  const definitions = Object.fromEntries((await admin.query(`SELECT indexrelid::regclass::text AS name, pg_get_indexdef(indexrelid) AS definition FROM pg_index
    WHERE indexrelid::regclass::text = ANY($1)`, [[...indexed.map(table => `${table}_id_key`), 'inventory_line_item_idx']])).rows.map(row => [row.name, row.definition]));
  for (const table of indexed) assert.match(definitions[`${table}_id_key`] ?? '', new RegExp(`^CREATE UNIQUE INDEX ${table}_id_key ON public\\.${table} USING btree \\(id\\)$`), table);
  assert.match(definitions.inventory_line_item_idx ?? '', /USING btree \(item_id, location_id\) INCLUDE \(direction, quantity, amount\)$/);
  assert.deepEqual(await snapshot(), before0014, 'every row as it was');
});

test('after 0014 seeding the five demo companies again changes nothing', async () => {
  for (const dataset of datasets) {
    const report = await seedDataset(user, dataset);
    assert.deepEqual([report.companyCreated, report.vouchers.created, report.ledgers.created, report.stock.items.created], [false, 0, 0, 0], dataset.slug);
  }
});

test('a create request that carries an id is refused on every route that creates rows of the five tables', async () => {
  const owner = await setupOwner();
  const company = await createCompany(owner.browser, { name: 'Ids Are Ours' });
  const accounts = await chart(owner.browser, company);
  const call = (path: string, body: unknown) => owner.browser.call(`/api/companies/${company}${path}`, body);
  const id = randomUUID();
  const unit = await call('/stock-units', { symbol: 'Box' });
  const cash = accounts.ledger('Cash'), group = accounts.group('indirect_expenses');
  const bodies: [string, Record<string, unknown>][] = [
    ['/stock-units', { symbol: 'Crate' }],
    ['/stock-items', { name: 'Widget', unitId: unit.body.stockUnit.id }],
    ['/ledgers', { name: 'Rent', groupId: group }],
    ['/vouchers', { idempotencyKey: `with-id-${id}`, voucherTypeId: accounts.type('journal'), date: '2026-02-01',
      lines: [{ ledgerId: cash, side: 'Dr', amount: '1.00' }, { ledgerId: cash, side: 'Cr', amount: '1.00' }] }],
  ];
  for (const [path, body] of bodies) {
    const refused = await call(path, { ...body, id });
    assert.deepEqual([refused.status, refused.body.code], [400, 'validation'], `${path} with an id`);
  }
  assert.equal((await call('/stock-units', { symbol: 'Crate' })).status, 201, 'the same body without the id is accepted');
});
