import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg, { type PoolClient } from 'pg';
import { getDatabase, migrationFiles } from '../src/server/db.ts';
import { alterItem, alterUnit, createItem, createTree, createUnit, deleteTree, deleteUnit, readItem } from '../src/server/ledger/stock-masters.ts';
import { migrateDatabase } from '../src/server/startup-migrate.ts';
import { accountingTables, assertDatabaseRoles, setCompanyScope } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, inCompany } from './helpers/ledger.ts';
import { earlierCompany } from './helpers/master-names-migration.ts';

/**
 * Stock master guards in the database (M2b slice a): migration 0011 on companies an earlier release created (main
 * location seeded, inventory left off), hand-written SQL as the application role (the path an application bug would
 * take), the tenancy shape of the six tables, the period lock on opening rows, unit and item changes racing an opening
 * write (through the API and by direct SQL), and the index paths of the unit check proven by the transaction's own
 * table counters, without and with table statistics.
 */
let database: TestDatabase;
let admin: pg.Client;
const user = randomUUID(), companyId = randomUUID(), other = randomUUID();
const ids = { kg: '', nos: '', main: '', yard: '', shed: '', item: '', group: '', child: '', category: '', otherUnit: '', otherLocation: '' };
const stockTables = ['stock_unit', 'stock_group', 'stock_category', 'stock_location', 'stock_item', 'stock_opening'];

const code = (expected: string, constraint?: string) => (error: unknown) => {
  const { code: actual, constraint: name } = error as { code?: string; constraint?: string };
  return actual === expected && (constraint === undefined || name === constraint);
};
/** One raw transaction as the application role, scoped to `scope`; rolled back on any error. */
async function asApp(run: (client: PoolClient) => Promise<unknown>, scope: string[] = [companyId]): Promise<void> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await setCompanyScope(client, scope);
    await run(client);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}
const write = <T>(run: Parameters<typeof inCompany<T>>[2]) => inCompany(user, companyId, run, 'write');
const one = async (sql: string, values: unknown[]) => (await asAdmin(database.adminUrl, client => client.query(sql, values))).rows[0];

before(async () => {
  database = await freshDatabase('stock_guards', { migrations: migrationFiles.slice(0, migrationFiles.indexOf('0011_stock_masters.sql')) });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await earlierCompany(admin, user, companyId);
  await admin.query(`INSERT INTO workspace (id, name) VALUES ($1, 'Other Stock')`, [other]);
  await admin.query("INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [other, user]);
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', $1, true)", [other]);
  await admin.query(`INSERT INTO company (company_id, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
    VALUES ($1, 'AED', 2, 1, 1, '2026-01-01', 'Asia/Dubai')`, [other]);
  await admin.query('SELECT ledger_seed_company($1)', [other]);
  await admin.query('COMMIT');
  await migrateDatabase({ log: () => undefined });
});
after(async () => { await admin?.end(); await database?.drop(); });

test('0011 seeds the main location of every existing company and leaves its inventory off', async () => {
  const rows = (await admin.query(`SELECT c.company_id, c.inventory_enabled, l.name, l.system_key FROM company c
    LEFT JOIN stock_location l ON l.company_id = c.company_id ORDER BY c.company_id`)).rows;
  assert.deepEqual(rows.map(row => [row.inventory_enabled, row.name, row.system_key]), [[false, 'Main Store', 'main'], [false, 'Main Store', 'main']]);
  assert.equal(Number((await admin.query('SELECT count(*) FROM schema_version')).rows[0].count), migrationFiles.length);
  // The fixture: inventory switched on, units, locations, a tree and an item with opening stock.
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('app.company_ids', $1, true)", [`${companyId},${other}`]);
  await admin.query('UPDATE company SET inventory_enabled = true');
  await admin.query('COMMIT');
  await write(async context => {
    ids.kg = (await createUnit(context, { symbol: 'Kg', decimals: 2 })).id;
    ids.nos = (await createUnit(context, { symbol: 'Nos' })).id;
    ids.main = (await context.client.query("SELECT id FROM stock_location WHERE company_id = $1 AND system_key = 'main'", [companyId])).rows[0].id;
    ids.yard = (await context.client.query("INSERT INTO stock_location (company_id, name) VALUES ($1, 'Yard') RETURNING id", [companyId])).rows[0].id;
    ids.shed = (await context.client.query("INSERT INTO stock_location (company_id, name) VALUES ($1, 'Shed') RETURNING id", [companyId])).rows[0].id;
    ids.group = (await context.client.query("INSERT INTO stock_group (company_id, name) VALUES ($1, 'Metals') RETURNING id", [companyId])).rows[0].id;
    ids.child = (await context.client.query("INSERT INTO stock_group (company_id, name, parent_id) VALUES ($1, 'Steel', $2) RETURNING id", [companyId, ids.group])).rows[0].id;
    ids.category = (await context.client.query("INSERT INTO stock_category (company_id, name) VALUES ($1, 'Bulk') RETURNING id", [companyId])).rows[0].id;
    ids.item = (await createItem(context, { name: 'Rod', unitId: ids.kg, groupId: ids.child, openings: [{ locationId: ids.main, quantity: '10.5', rate: '2.00' }, { locationId: ids.shed, quantity: '1', value: '5.00' }] })).id;
  });
  await inCompany(user, other, async context => {
    ids.otherUnit = (await createUnit(context, { symbol: 'Theirs' })).id;
    ids.otherLocation = (await context.client.query("SELECT id FROM stock_location WHERE company_id = $1 AND system_key = 'main'", [other])).rows[0].id;
  }, 'write');
});

test('the database refuses, as the application role inside the company scope, what the API refuses first', async () => {
  const opening = (values: Record<string, unknown> = {}) => (client: PoolClient) => {
    const row = { company_id: companyId, item_id: ids.item, location_id: ids.yard, quantity: '1', rate: '1', value: 100, ...values };
    return client.query(`INSERT INTO stock_opening (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map((_, index) => `$${index + 1}`).join(', ')})`, Object.values(row));
  };
  const cases: [string, (client: PoolClient) => Promise<unknown>, (error: unknown) => boolean][] = [
    ['a unit with five decimal places', client => client.query("INSERT INTO stock_unit (company_id, symbol, decimals) VALUES ($1, 'Five', 5)", [companyId]), code('23514', 'stock_unit_decimals_check')],
    ['lowering the decimals of a unit opening stock uses', client => client.query('UPDATE stock_unit SET decimals = 1 WHERE company_id = $1 AND id = $2', [companyId, ids.kg]), code('23514', 'stock_unit_decimals')],
    ['an opening quantity with more places than its unit', opening({ quantity: '1.125' }), code('23514', 'stock_opening_quantity_places')],
    ['a zero opening quantity', opening({ quantity: '0' }), code('23514', 'stock_opening_quantity_check')],
    ['a negative opening value', opening({ value: -1 }), code('23514', 'stock_opening_value_check')],
    ['an opening row at another company\'s location', opening({ location_id: ids.otherLocation }), code('23503')],
    ['changing an opening row', client => client.query('UPDATE stock_opening SET value = 1 WHERE company_id = $1', [companyId]), code('42501')],
    ['changing the unit of an item with opening stock', client => client.query('UPDATE stock_item SET unit_id = $3 WHERE company_id = $1 AND id = $2', [companyId, ids.item, ids.nos]), code('23514', 'stock_item_unit_fixed')],
    ['an item on another company\'s unit', client => client.query("INSERT INTO stock_item (company_id, name, unit_id) VALUES ($1, 'Stray', $2)", [companyId, ids.otherUnit]), code('23503')],
    ['an item named like another under the key', client => client.query("INSERT INTO stock_item (company_id, name, unit_id) VALUES ($1, 'r-o-d', $2)", [companyId, ids.kg]), code('23505', 'stock_item_name_idx')],
    ['a unit symbol like another under the key', client => client.query("INSERT INTO stock_unit (company_id, symbol) VALUES ($1, 'K.G')", [companyId]), code('23505', 'stock_unit_symbol_idx')],
    ['deleting the main location', client => client.query('DELETE FROM stock_location WHERE company_id = $1 AND id = $2', [companyId, ids.main]), code('23514', 'stock_location_builtin')],
    ['changing a location\'s system key', client => client.query("UPDATE stock_location SET system_key = NULL WHERE company_id = $1 AND id = $2", [companyId, ids.main]), code('42501')],
    ['a second main location', client => client.query("INSERT INTO stock_location (company_id, system_key, name) VALUES ($1, 'main', 'Second')", [companyId]), code('23505')],
    ['deleting a location holding opening stock', client => client.query('DELETE FROM stock_location WHERE company_id = $1 AND id = $2', [companyId, ids.shed]), code('23503')],
    ['a group under its own sub-group', client => client.query('UPDATE stock_group SET parent_id = $3 WHERE company_id = $1 AND id = $2', [companyId, ids.group, ids.child]), code('23514', 'stock_group_cycle')],
    ['a group under itself', client => client.query('UPDATE stock_group SET parent_id = id WHERE company_id = $1 AND id = $2', [companyId, ids.group]), code('23514')],
    ['deleting a group holding items', client => client.query('DELETE FROM stock_group WHERE company_id = $1 AND id = $2', [companyId, ids.child]), code('23503')],
    ['a category under itself', client => client.query('UPDATE stock_category SET parent_id = id WHERE company_id = $1 AND id = $2', [companyId, ids.category]), code('23514')],
    ['a location under the location it holds', async client => {
      await client.query('UPDATE stock_location SET parent_id = $3 WHERE company_id = $1 AND id = $2', [companyId, ids.yard, ids.main]);
      await client.query('UPDATE stock_location SET parent_id = $3 WHERE company_id = $1 AND id = $2', [companyId, ids.main, ids.yard]);
    }, code('23514', 'stock_location_cycle')],
    ['a row written for a company outside the scope', client => client.query("INSERT INTO stock_unit (company_id, symbol) VALUES ($1, 'Outside')", [other]), code('42501')],
    ['switching the guards off', client => client.query('ALTER TABLE stock_opening DISABLE TRIGGER USER'), code('42501')],
  ];
  for (const [name, run, expected] of cases) await assert.rejects(asApp(run), expected, name);
  assert.equal(Number((await one('SELECT count(*) FROM stock_opening WHERE company_id = $1', [companyId])).count), 2, 'nothing was written');
  // Raising the decimals of a used unit stays allowed.
  await assert.doesNotReject(asApp(client => client.query('UPDATE stock_unit SET decimals = 3 WHERE company_id = $1 AND id = $2', [companyId, ids.kg])));
});

test('the six tables lead with company_id, reference only within the company, are forced under the company policy and give no UPDATE on opening rows', async () => {
  await assert.doesNotReject(assertDatabaseRoles(getDatabase().pool), 'the boot assertion covers them');
  for (const table of stockTables) assert.ok(accountingTables.includes(table as never), table);
  await asAdmin(database.adminUrl, client => client.query('ALTER TABLE stock_opening NO FORCE ROW LEVEL SECURITY'));
  try {
    await assert.rejects(assertDatabaseRoles(getDatabase().pool), /not enabled and forced on stock_opening/, 'the boot assertion fails when a stock table loses forced RLS');
  } finally { await asAdmin(database.adminUrl, client => client.query('ALTER TABLE stock_opening FORCE ROW LEVEL SECURITY')); }
  const shape = await asAdmin(database.adminUrl, async client => ({
    first: (await client.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1) AND ordinal_position = 1 ORDER BY 1`, [stockTables])).rows,
    keys: (await client.query(`SELECT conrelid::regclass::text AS "table", conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE contype IN ('f', 'p', 'u') AND conrelid::regclass::text = ANY($1) ORDER BY 1, 2`, [stockTables])).rows,
    grants: (await client.query(`SELECT t, p, has_table_privilege('books_app', t, p) AS granted FROM unnest($1::text[]) t CROSS JOIN unnest('{SELECT,INSERT,UPDATE,DELETE,TRUNCATE}'::text[]) p ORDER BY 1, 2`, [stockTables])).rows,
    columns: (await client.query(`SELECT table_name || '.' || column_name AS col FROM information_schema.column_privileges
      WHERE grantee = 'books_app' AND privilege_type = 'UPDATE' AND (table_name LIKE 'stock_%' OR (table_name = 'company' AND column_name = 'inventory_enabled')) ORDER BY 1`)).rows.map(row => row.col),
    definers: (await client.query(`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
      AND (proname LIKE 'stock_%' OR proname = 'ledger_seed_company') AND (prosecdef OR NOT coalesce(array_to_string(proconfig, ',') LIKE '%search_path=public, pg_temp%', false))`)).rows,
  }));
  assert.deepEqual(shape.first.map(row => row.column_name), stockTables.map(() => 'company_id'));
  for (const key of shape.keys) assert.match(key.definition, /^(PRIMARY KEY|UNIQUE|FOREIGN KEY) \(company_id[,)]/, `${key.table}.${key.conname}: ${key.definition}`);
  const granted = (table: string) => shape.grants.filter(row => row.t === table && row.granted).map(row => row.p);
  assert.deepEqual(stockTables.map(granted), stockTables.map(() => ['DELETE', 'INSERT', 'SELECT']), 'no table-wide UPDATE or TRUNCATE');
  assert.deepEqual(shape.columns, [
    'company.inventory_enabled',
    'stock_category.name', 'stock_category.parent_id', 'stock_category.revision', 'stock_category.second_language_name',
    'stock_group.add_quantities', 'stock_group.name', 'stock_group.parent_id', 'stock_group.revision', 'stock_group.second_language_name',
    'stock_item.category_id', 'stock_item.group_id', 'stock_item.name', 'stock_item.revision', 'stock_item.second_language_name', 'stock_item.standard_selling_rate', 'stock_item.unit_id',
    'stock_location.name', 'stock_location.parent_id', 'stock_location.revision', 'stock_location.second_language_name',
    'stock_unit.decimals', 'stock_unit.formal_name', 'stock_unit.revision', 'stock_unit.symbol']);
  assert.deepEqual(shape.definers, [], 'no SECURITY DEFINER, and a fixed search path on each function');
});

const state = (promise: Promise<unknown>) => Promise.race([promise.then(() => 'settled', () => 'settled'), new Promise(resolve => setTimeout(() => resolve('waiting'), 400))]);

/** Runs `first` in a write transaction held open until `second` has been started and seen waiting; returns both outcomes. */
async function race<A, B>(first: Parameters<typeof write<A>>[0], second: Parameters<typeof write<B>>[0]): Promise<{ firstResult: A; second: Promise<B> }> {
  let release!: () => void, done!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { done = resolve; });
  const firstWrite = write(async context => { const result = await first(context); done(); await held; return result; });
  await started;
  const secondWrite = write(second);
  const waited = await state(secondWrite);
  release();
  const firstResult = await firstWrite;
  await secondWrite.catch(() => undefined);
  assert.equal(waited, 'waiting', 'the second write waits for the first');
  return { firstResult, second: secondWrite };
}

test('lowering a unit\'s decimals while an opening write is in flight is refused once its rows are committed', async () => {
  // The unit's update itself waits for the opening write's lock on the unit, so this holds whatever lock the alter takes
  // first; the opening guard's own locks are proven by direct SQL below.
  const unit = await write(context => createUnit(context, { symbol: 'Litre', decimals: 2 }));
  const item = await write(context => createItem(context, { name: 'Oil', unitId: unit.id }));
  const { second } = await race(
    context => alterItem(context, item.id, { name: 'Oil', unitId: unit.id, openings: [{ locationId: ids.main, quantity: '1.5', rate: '3.00' }], revision: item.revision }),
    context => alterUnit(context, unit.id, { symbol: 'Litre', decimals: 0, revision: unit.revision }));
  await assert.rejects(second, (error: { code?: string }) => error.code === 'in_use', 'refused once the rows are committed');
  assert.deepEqual((await inCompany(user, companyId, context => readItem(context, item.id))).openings.map(row => row.quantity), ['1.50']);
});

test('an opening write waits for a unit alter in flight and is checked against the lowered decimals', async () => {
  const unit = await write(context => createUnit(context, { symbol: 'Gallon', decimals: 2 }));
  const item = await write(context => createItem(context, { name: 'Paint', unitId: unit.id }));
  // The unit is share-locked before the row's check, which reads the decimals the alter committed, not those before it.
  const { second } = await race(
    context => alterUnit(context, unit.id, { symbol: 'Gallon', decimals: 0, revision: unit.revision }),
    context => alterItem(context, item.id, { name: 'Paint', unitId: unit.id, openings: [{ locationId: ids.main, quantity: '1.5', rate: '3.00' }], revision: item.revision }));
  await assert.rejects(second, (error: { code?: string }) => error.code === 'validation', 'refused against the committed decimals');
  assert.deepEqual((await inCompany(user, companyId, context => readItem(context, item.id))).openings, []);
});

/** A raw transaction as the application role, held open: statements run on `client` until `end`. */
async function openApp(): Promise<{ client: PoolClient; end: (how: 'COMMIT' | 'ROLLBACK') => Promise<void> }> {
  const client = await getDatabase().pool.connect();
  await client.query('BEGIN');
  await setCompanyScope(client, [companyId]);
  let open = true;
  return { client, end: async how => { if (!open) return; open = false; try { await client.query(how); } finally { client.release(); } } };
}
const insertOpening = (itemId: string, quantity: string) => (client: PoolClient) => client.query(
  'INSERT INTO stock_opening (company_id, item_id, location_id, quantity, rate, value) VALUES ($1, $2, $3, $4, 2, 300)', [companyId, itemId, ids.main, quantity]);

/**
 * Direct SQL as the application role, the path item lines and imports will also take: the change that `setup` returns
 * runs in a transaction held open while an opening row of 1.5 is inserted on a second connection. The insert must wait
 * for it, then be checked against what it committed, or be accepted once it rolls back (each on fresh masters).
 */
async function openingDuring(setup: (suffix: string) => Promise<{ change: (client: PoolClient) => Promise<unknown>; itemId: string }>): Promise<void> {
  for (const end of ['COMMIT', 'ROLLBACK'] as const) {
    const { change, itemId } = await setup(end === 'COMMIT' ? '' : ' 2');
    const first = await openApp();
    let insert: Promise<unknown> | undefined;
    try {
      await change(first.client);
      insert = asApp(insertOpening(itemId, '1.5'));
      assert.equal(await state(insert), 'waiting', `the insert waits for the open change (${end})`);
      await first.end(end);
      if (end === 'COMMIT') await assert.rejects(insert, code('23514', 'stock_opening_quantity_places'), 'checked against the committed change');
      else await assert.doesNotReject(insert, 'accepted once the change rolled back');
    } finally {
      await first.end('ROLLBACK');
      await insert?.catch(() => undefined);
    }
    assert.equal(Number((await one('SELECT count(*) FROM stock_opening WHERE company_id = $1 AND item_id = $2', [companyId, itemId])).count), end === 'COMMIT' ? 0 : 1, end);
  }
}

test('by direct SQL, an opening row inserted while a unit\'s decimals are lowered in an open transaction waits and is checked against the lowered decimals', async () => {
  await openingDuring(async suffix => {
    const unit = await write(context => createUnit(context, { symbol: `Drum${suffix}`, decimals: 2 }));
    const item = await write(context => createItem(context, { name: `Resin${suffix}`, unitId: unit.id }));
    return { itemId: item.id, change: client => client.query('UPDATE stock_unit SET decimals = 0 WHERE company_id = $1 AND id = $2', [companyId, unit.id]) };
  });
});

test('by direct SQL, an opening row inserted while its item\'s unit is changed in an open transaction waits and is checked against the new unit', async () => {
  await openingDuring(async suffix => {
    const fine = await write(context => createUnit(context, { symbol: `Sack${suffix}`, decimals: 2 }));
    const whole = await write(context => createUnit(context, { symbol: `Bale${suffix}`, decimals: 0 }));
    const item = await write(context => createItem(context, { name: `Cotton${suffix}`, unitId: fine.id }));
    return { itemId: item.id, change: client => client.query('UPDATE stock_item SET unit_id = $3 WHERE company_id = $1 AND id = $2', [companyId, item.id, whole.id]) };
  });
});

test('an item created while its unit, stock group or stock category is being deleted waits and is answered not_found', async () => {
  const unit = await write(context => createUnit(context, { symbol: 'Vanishing', decimals: 0 }));
  const { second: onUnit } = await race(
    context => deleteUnit(context, unit.id, { revision: unit.revision }),
    context => createItem(context, { name: 'Orphan', unitId: unit.id }));
  await assert.rejects(onUnit, (error: { code?: string; message?: string }) => error.code === 'not_found' && error.message === 'The unit was not found.', 'the unit');
  const kept = await write(context => createUnit(context, { symbol: 'Staying', decimals: 0 }));
  for (const [name, field, what] of [['stock-groups', 'groupId', 'stock group'], ['stock-categories', 'categoryId', 'stock category']] as const) {
    const master = await write(context => createTree(context, name, { name: `Vanishing ${what}` }));
    const { second } = await race(
      context => deleteTree(context, name, master.id, { revision: master.revision }),
      context => createItem(context, { name: `Orphan in ${what}`, unitId: kept.id, [field]: master.id }));
    await assert.rejects(second, (error: { code?: string; message?: string }) => error.code === 'not_found' && error.message === `The ${what} was not found.`, `the ${what}`);
  }
  assert.equal(Number((await one("SELECT count(*) FROM stock_item WHERE company_id = $1 AND name LIKE 'Orphan%'", [companyId])).count), 0);
});

test('deleting a unit while an opening write holds one of its items answers in_use at once instead of deadlocking', async () => {
  const unit = await write(context => createUnit(context, { symbol: 'Crate', decimals: 0 }));
  const item = await write(context => createItem(context, { name: 'Melon', unitId: unit.id }));
  const first = await openApp();
  let deletion: Promise<void> | undefined;
  try {
    // An opening write's first lock (an item's alter holds its row), then the unit and the row, as the API does.
    await first.client.query('SELECT 1 FROM stock_item WHERE company_id = $1 AND id = $2 FOR UPDATE', [companyId, item.id]);
    deletion = write(context => deleteUnit(context, unit.id, { revision: unit.revision }));
    await state(deletion);
    await first.client.query('SELECT 1 FROM stock_unit WHERE company_id = $1 AND id = $2 FOR SHARE', [companyId, unit.id]);
    await insertOpening(item.id, '2')(first.client);
    await first.end('COMMIT');
    await assert.rejects(deletion, (error: { code?: string }) => error.code === 'in_use', 'the unit has an item');
  } finally {
    await first.end('ROLLBACK');
    await deletion?.catch(() => undefined);
  }
  assert.equal(Number((await one('SELECT count(*) FROM stock_opening WHERE company_id = $1 AND item_id = $2', [companyId, item.id])).count), 1, 'the opening write committed');
});

test('by direct SQL, opening rows are neither written nor removed while the locked-through date reaches the books beginning', async () => {
  const unit = await write(context => createUnit(context, { symbol: 'Roll', decimals: 0 }));
  const item = await write(context => createItem(context, { name: 'Twine', unitId: unit.id }));
  const kept = await write(context => createItem(context, { name: 'Wire', unitId: unit.id, openings: [{ locationId: ids.main, quantity: '4', rate: '1.00' }] }));
  const { books_beginning: beginning } = await one("SELECT books_beginning::text FROM company WHERE company_id = $1", [companyId]);
  await admin.query('UPDATE company SET locked_through = $2 WHERE company_id = $1', [companyId, beginning]);
  try {
    await assert.rejects(asApp(insertOpening(item.id, '1')), code('23514', 'stock_opening_locked'), 'a new row');
    await assert.rejects(asApp(client => client.query('DELETE FROM stock_opening WHERE company_id = $1 AND item_id = $2', [companyId, kept.id])), code('23514', 'stock_opening_locked'), 'a removed row');
    await assert.rejects(asApp(client => client.query('DELETE FROM stock_item WHERE company_id = $1 AND id = $2', [companyId, kept.id])), code('23514', 'stock_opening_locked'), 'an item deleted with its rows');
    // A lock that ends before the books begin leaves the openings open.
    await admin.query("UPDATE company SET locked_through = $2::date - 1 WHERE company_id = $1", [companyId, beginning]);
    await assert.doesNotReject(asApp(insertOpening(item.id, '1')));
  } finally {
    await admin.query('UPDATE company SET locked_through = NULL WHERE company_id = $1', [companyId]);
  }
  assert.equal(Number((await one('SELECT count(*) FROM stock_opening WHERE company_id = $1 AND item_id = $2', [companyId, kept.id])).count), 1, 'the locked rows stayed');
});

type Counters = { seq_scan: number; seq_tup_read: number; idx_scan: number; idx_tup_fetch: number };
const counters = async (client: PoolClient, table: string): Promise<Counters> => {
  const { rows } = await client.query<Record<keyof Counters, string>>('SELECT seq_scan, seq_tup_read, idx_scan, idx_tup_fetch FROM pg_stat_xact_user_tables WHERE relname = $1', [table]);
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)])) as Counters;
};

test('the unit check seeks the unit\'s own items: lowering an unused unit\'s decimals among 3,000 stocked items reads no item, without and with table statistics', async () => {
  const unused = await write(context => createUnit(context, { symbol: 'Spare', decimals: 3 }));
  await asAdmin(database.adminUrl, async client => {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.company_ids', $1, true)", [companyId]);
    await client.query(`INSERT INTO stock_item (company_id, name, unit_id) SELECT $1, 'Bulk ' || n, $2 FROM generate_series(1, 3000) n`, [companyId, ids.nos]);
    await client.query(`INSERT INTO stock_opening (company_id, item_id, location_id, quantity, rate, value)
      SELECT company_id, id, $2, 1, 1, 100 FROM stock_item WHERE company_id = $1 AND name LIKE 'Bulk %'`, [companyId, ids.main]);
    await client.query('COMMIT');
  });
  let revision = unused.revision;
  for (const tables of ['without statistics', 'analysed'] as const) {
    if (tables === 'analysed') await asAdmin(database.adminUrl, client => client.query('ANALYZE stock_item; ANALYZE stock_opening'));
    await write(async context => {
      const items = await counters(context.client, 'stock_item'), openings = await counters(context.client, 'stock_opening');
      revision = (await alterUnit(context, unused.id, { symbol: 'Spare', decimals: tables === 'analysed' ? 1 : 2, revision })).revision;
      const itemDelta = await counters(context.client, 'stock_item'), openingDelta = await counters(context.client, 'stock_opening');
      // The API's check and the trigger's each seek the unit's items through stock_item_unit_idx: none, so nothing is fetched.
      assert.deepEqual([itemDelta.seq_scan - items.seq_scan, itemDelta.seq_tup_read - items.seq_tup_read, itemDelta.idx_tup_fetch - items.idx_tup_fetch], [0, 0, 0], `${tables}: ${JSON.stringify(itemDelta)}`);
      assert.ok(itemDelta.idx_scan - items.idx_scan >= 2, `${tables}: the item index was used`);
      assert.deepEqual([openingDelta.seq_tup_read - openings.seq_tup_read, openingDelta.idx_tup_fetch - openings.idx_tup_fetch], [0, 0], `${tables}: no opening row read`);
    });
  }
});

test('the unit check costs one probe of the openings and one of the item lines per item of the unit, beside 3,000 stocked items, without and with statistics and with generic plans', async () => {
  // A unit of 1,000 items with no opening and no line, beside the 3,000 stocked items of the test above (their unit is
  // another): lowering its decimals reads the unit's items twice (once per loop of stock_unit_guard), probes the openings
  // and the item lines once per item and finds nothing, and reads none of the company's other items or openings.
  const many = await write(context => createUnit(context, { symbol: 'Many', decimals: 4 }));
  await asAdmin(database.adminUrl, async client => {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.company_ids', $1, true)", [companyId]);
    await client.query(`INSERT INTO stock_item (company_id, name, unit_id) SELECT $1, 'Loose ' || n, $2 FROM generate_series(1, 1000) n`, [companyId, many.id]);
    await client.query('COMMIT');
  });
  const items = 1000;
  let revision = many.revision, decimals = 4;
  const states = [['without statistics', false, false], ['without statistics, generic plan', false, true], ['analysed', true, false], ['analysed, generic plan', true, true]] as const;
  for (const [label, analysed, generic] of states) {
    await asAdmin(database.adminUrl, async client => {
      if (analysed) { await client.query('ANALYZE stock_item; ANALYZE stock_opening; ANALYZE inventory_line'); return; }
      for (const table of ['stock_item', 'stock_opening', 'inventory_line']) {
        await client.query("SELECT pg_clear_relation_stats('public', $1)", [table]);
        await client.query(`SELECT count(pg_clear_attribute_stats('public', $1, attname, false)) FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`, [table]);
      }
    });
    await write(async context => {
      if (generic) await context.client.query('SET LOCAL plan_cache_mode = force_generic_plan');
      const before = { item: await counters(context.client, 'stock_item'), opening: await counters(context.client, 'stock_opening'), line: await counters(context.client, 'inventory_line') };
      decimals -= 1;
      revision = (await alterUnit(context, many.id, { symbol: 'Many', decimals, revision })).revision;
      const after = { item: await counters(context.client, 'stock_item'), opening: await counters(context.client, 'stock_opening'), line: await counters(context.client, 'inventory_line') };
      const read = (table: 'item' | 'opening' | 'line') => [after[table].seq_tup_read - before[table].seq_tup_read, after[table].idx_tup_fetch - before[table].idx_tup_fetch];
      assert.deepEqual(read('item'), [0, 2 * items], `${label}: the unit's items, once per loop, and no other item`);
      assert.deepEqual([read('opening'), read('line')], [[0, 0], [0, 0]], `${label}: one probe per item finds no row; no opening or item line is read`);
      // A probe is an index scan, or once analysed a sequential scan of zero rows when the table is empty (no item line
      // exists in this database): counted either way, and reading nothing (above).
      const probes = (table: 'opening' | 'line') => after[table].idx_scan + after[table].seq_scan - before[table].idx_scan - before[table].seq_scan;
      assert.deepEqual([probes('opening'), probes('line')], [items, items], `${label}: one probe per item`);
    });
    if (decimals === 0) break;
  }
});
