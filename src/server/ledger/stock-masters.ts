import { assertMoneyInRange, multiplyMoney, parseMoney } from '@ten98/runtime';
import { revisionInput, type Revision } from '../../lib/ledger.ts';
import {
  inventorySettingInput, stockCategoryAlterInput, stockCategoryCreateInput, stockGroupAlterInput, stockGroupCreateInput,
  stockItemAlterInput, stockItemCreateInput, stockLocationAlterInput, stockLocationCreateInput, stockUnitAlterInput,
  stockUnitCreateInput, type InventorySetting, type StockItem, type StockOpening, type StockUnit, type StockUnitListItem,
} from '../../lib/stock.ts';
import type { FoundationError } from '../auth.ts';
import { conflict, ledgerError, parseAmount, parseInput, refusal, type LedgerContext } from './context.ts';
import { missingAs } from './masters.ts';
import { logRevision } from './revisions.ts';

/**
 * Stock masters (M2b slice a): units, stock groups, stock categories, locations and stock items with their opening
 * stock per location. Names (and unit symbols) are unique within each kind under the name match key, by the tables'
 * unique indexes; kinds are separate name spaces. Deletes of used rows are refused by the database's foreign keys, and
 * the database repeats the unit, opening and main-location rules (migration 0011).
 *
 * Locks, in this order: items, units, locations. An alter or delete of a unit, item or location takes the row's FOR
 * UPDATE lock (a unit delete first looks for its items, so it never holds the unit while waiting for an item); an
 * opening write holds its item (locked by the item's own write), share-locks its unit, then key-shares its locations in
 * id order. The database's opening guard takes the item and unit locks again for every row and checks against them, so
 * a unit alter or an item's unit change in flight is waited for, whichever path writes the rows.
 */

const notFound = (what: string) => ledgerError(404, `${what} not found.`, 'not_found');
const field = (labels: Record<string, string>, fallback: string) => (path: readonly PropertyKey[]) => labels[String(path[0])] ?? fallback;
const treeFields = (what: string) => field({ name: `the ${what} name`, secondLanguageName: 'the second-language name', parentId: `the parent ${what}`, addQuantities: 'the add quantities setting', revision: 'the revision' }, `the ${what} details`);
const unitFields = field({ symbol: 'the unit symbol', formalName: 'the formal name', decimals: 'the number of decimal places (0 to 4)', revision: 'the revision' }, 'the unit details');
const itemFields = (path: readonly PropertyKey[]) => path[0] === 'openings'
  ? typeof path[1] === 'number' ? `opening row ${path[1] + 1}` : 'the opening stock'
  : ({ name: 'the item name', secondLanguageName: 'the second-language name', groupId: 'the stock group', categoryId: 'the stock category', unitId: 'the unit', standardSellingRate: 'the standard selling rate', revision: 'the revision' } as Record<string, string>)[String(path[0])] ?? 'the item details';

const lockedOpenings = (context: LedgerContext) => ledgerError(409, `Opening stock is locked: the books are locked through ${context.company.lockedThrough}.`, 'locked_period');
/** Opening stock is as of the books beginning, so a lock through that date freezes it, as it does ledger openings (D-09). */
function assertOpeningOpen(context: LedgerContext): void {
  const { lockedThrough, booksBeginning } = context.company;
  if (lockedThrough !== null && lockedThrough >= booksBeginning) throw lockedOpenings(context);
}

// ---- Trees: stock groups, stock categories, locations ----

type TreeKind = {
  table: 'stock_group' | 'stock_category' | 'stock_location'; entity: Revision['entity']; what: string; title: string;
  /** Extra columns beyond the shared ones, as `column AS "field"`, and the input fields they take on create and alter. */
  extra: { select: string; columns: string[]; values: (input: Record<string, unknown>, before?: Record<string, unknown>) => unknown[] };
  /** What else refuses a delete besides children (items in a group or category, opening rows at a location). */
  usedSql: string;
  refusals: Record<string, FoundationError>;
  createInput: typeof stockGroupCreateInput | typeof stockCategoryCreateInput | typeof stockLocationCreateInput;
  alterInput: typeof stockGroupAlterInput | typeof stockCategoryAlterInput | typeof stockLocationAlterInput;
};

const treeRefusals = (table: string, what: string): Record<string, FoundationError> => ({
  [`${table}_name_idx`]: ledgerError(409, `A ${what} with this name already exists.`, 'duplicate_name'),
  [`${table}_cycle`]: ledgerError(400, `A ${what} cannot be placed under one of its own sub-${what}s.`, 'cycle'),
  [`${table}_not_own_parent`]: ledgerError(400, `A ${what} cannot be placed under itself.`, 'cycle'),
});

const trees = {
  'stock-groups': {
    table: 'stock_group', entity: 'stock_group', what: 'stock group', title: 'Stock group',
    extra: { select: ', t.add_quantities AS "addQuantities"', columns: ['add_quantities'], values: (input, before) => [input.addQuantities ?? before?.addQuantities ?? false] },
    usedSql: 'EXISTS (SELECT 1 FROM stock_item x WHERE x.group_id = t.id AND x.company_id = t.company_id)',
    refusals: treeRefusals('stock_group', 'stock group'), createInput: stockGroupCreateInput, alterInput: stockGroupAlterInput,
  },
  'stock-categories': {
    table: 'stock_category', entity: 'stock_category', what: 'stock category', title: 'Stock category',
    extra: { select: '', columns: [], values: () => [] },
    usedSql: 'EXISTS (SELECT 1 FROM stock_item x WHERE x.category_id = t.id AND x.company_id = t.company_id)',
    refusals: treeRefusals('stock_category', 'stock category'), createInput: stockCategoryCreateInput, alterInput: stockCategoryAlterInput,
  },
  'stock-locations': {
    table: 'stock_location', entity: 'stock_location', what: 'location', title: 'Location',
    extra: { select: ', t.system_key AS "systemKey"', columns: [], values: () => [] },
    usedSql: 'EXISTS (SELECT 1 FROM stock_opening x WHERE x.location_id = t.id AND x.company_id = t.company_id) OR EXISTS (SELECT 1 FROM inventory_line x WHERE x.location_id = t.id AND x.company_id = t.company_id)',
    refusals: { ...treeRefusals('stock_location', 'location'), stock_location_builtin: ledgerError(409, 'The main location can be renamed but not deleted.', 'seeded_row') },
    createInput: stockLocationCreateInput, alterInput: stockLocationAlterInput,
  },
} satisfies Record<string, TreeKind>;
export type TreeKindName = keyof typeof trees;
export const treeKinds = Object.keys(trees) as TreeKindName[];

const treeColumns = (kind: TreeKind) => `t.id, t.parent_id AS "parentId", t.name, t.second_language_name AS "secondLanguageName"${kind.extra.select}, t.revision`;
const inUseSql = (kind: TreeKind) => `(EXISTS (SELECT 1 FROM ${kind.table} c WHERE c.parent_id = t.id AND c.company_id = t.company_id) OR ${kind.usedSql})`;
type TreeRow = { id: string; parentId: string | null; revision: number; systemKey?: string | null } & Record<string, unknown>;

export async function listTree(context: LedgerContext, name: TreeKindName): Promise<TreeRow[]> {
  const kind: TreeKind = trees[name];
  const { rows } = await context.client.query<TreeRow>(
    `SELECT ${treeColumns(kind)}, ${inUseSql(kind)} AS "inUse" FROM ${kind.table} t WHERE t.company_id = $1 ORDER BY lower(t.name), t.id`, [context.company.companyId]);
  return rows;
}

export async function getTree(context: LedgerContext, name: TreeKindName, id: string): Promise<TreeRow> {
  const kind: TreeKind = trees[name];
  const { rows } = await context.client.query<TreeRow>(
    `SELECT ${treeColumns(kind)}, ${inUseSql(kind)} AS "inUse" FROM ${kind.table} t WHERE t.company_id = $1 AND t.id = $2`, [context.company.companyId, id]);
  if (!rows[0]) throw notFound(kind.title);
  return rows[0];
}

async function readTree(context: LedgerContext, kind: TreeKind, id: string, lock = false): Promise<TreeRow> {
  const { rows } = await context.client.query<TreeRow>(
    `SELECT ${treeColumns(kind)} FROM ${kind.table} t WHERE t.company_id = $1 AND t.id = $2${lock ? ' FOR UPDATE' : ''}`, [context.company.companyId, id]);
  if (!rows[0]) throw notFound(kind.title);
  return rows[0];
}

/** One move in the company's tree of this kind at a time (the database trigger takes the same lock), before any row lock. */
const lockTree = (context: LedgerContext, kind: TreeKind) => context.client.query('SELECT stock_tree_lock($1, $2)', [kind.table, context.company.companyId]);

export async function createTree(context: LedgerContext, name: TreeKindName, value: unknown): Promise<TreeRow> {
  const kind: TreeKind = trees[name];
  const input = parseInput(kind.createInput, value, treeFields(kind.what)) as Record<string, unknown> & { name: string; secondLanguageName: string | null; parentId: string | null };
  if (input.parentId) {
    await lockTree(context, kind);
    await readTree(context, kind, input.parentId).catch(missingAs(ledgerError(400, `The parent ${kind.what} was not found.`, 'not_found')));
  }
  const columns = ['company_id', 'parent_id', 'name', 'second_language_name', ...kind.extra.columns];
  const values = [context.company.companyId, input.parentId, input.name, input.secondLanguageName, ...kind.extra.values(input)];
  const { rows } = await context.client.query<{ id: string }>(
    `INSERT INTO ${kind.table} (${columns.join(', ')}) VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING id`, values)
    .catch(error => refusal(error, kind.refusals));
  const created = await readTree(context, kind, rows[0].id);
  await logRevision(context, kind.entity, created.id, 'create', null, created);
  return created;
}

export async function alterTree(context: LedgerContext, name: TreeKindName, id: string, value: unknown): Promise<TreeRow> {
  const kind: TreeKind = trees[name];
  const input = parseInput(kind.alterInput, value, treeFields(kind.what)) as Record<string, unknown> & { name: string; secondLanguageName: string | null; parentId: string | null; revision: number };
  await lockTree(context, kind);
  const before = await readTree(context, kind, id, true);
  if (before.revision !== input.revision) throw conflict(kind.what);
  if (input.parentId && input.parentId !== before.parentId) {
    await readTree(context, kind, input.parentId).catch(missingAs(ledgerError(400, `The parent ${kind.what} was not found.`, 'not_found')));
  }
  const sets = ['parent_id', 'name', 'second_language_name', ...kind.extra.columns].map((column, index) => `${column} = $${index + 3}`);
  await context.client.query(`UPDATE ${kind.table} SET ${sets.join(', ')}, revision = revision + 1 WHERE company_id = $1 AND id = $2`,
    [context.company.companyId, id, input.parentId, input.name, input.secondLanguageName, ...kind.extra.values(input, before)])
    .catch(error => refusal(error, kind.refusals));
  const after = await readTree(context, kind, id);
  await logRevision(context, kind.entity, id, 'alter', before, after);
  return after;
}

export async function deleteTree(context: LedgerContext, name: TreeKindName, id: string, value: unknown): Promise<void> {
  const kind: TreeKind = trees[name];
  const input = parseInput(revisionInput, value, treeFields(kind.what));
  const before = await readTree(context, kind, id, true);
  if (before.revision !== input.revision) throw conflict(kind.what);
  if (before.systemKey) throw kind.refusals.stock_location_builtin;
  const inUse = ledgerError(409, `This ${kind.what} holds sub-${kind.what}s or is used${kind.table === 'stock_location' ? ' by opening stock or item lines' : ' by stock items'} and cannot be deleted.`, 'in_use');
  await context.client.query(`DELETE FROM ${kind.table} WHERE company_id = $1 AND id = $2`, [context.company.companyId, id])
    .catch(error => refusal(error, { ...kind.refusals, '23503': inUse }));
  await logRevision(context, kind.entity, id, 'delete', before, null);
}

// ---- Units ----

const unitColumns = 'u.id, u.symbol, u.formal_name AS "formalName", u.decimals, u.revision';
const unitInUseSql = 'EXISTS (SELECT 1 FROM stock_item x WHERE x.unit_id = u.id AND x.company_id = u.company_id)';
const unitRefusals = {
  stock_unit_symbol_idx: ledgerError(409, 'A unit with this symbol already exists.', 'duplicate_name'),
  stock_unit_decimals: ledgerError(409, 'This unit is used by opening stock or item lines, so its decimal places cannot be lowered. Raising them is allowed.', 'in_use'),
};

export async function listUnits(context: LedgerContext): Promise<StockUnitListItem[]> {
  const { rows } = await context.client.query<StockUnitListItem>(
    `SELECT ${unitColumns}, ${unitInUseSql} AS "inUse" FROM stock_unit u WHERE u.company_id = $1 ORDER BY lower(u.symbol), u.id`, [context.company.companyId]);
  return rows;
}

export async function getUnit(context: LedgerContext, unitId: string): Promise<StockUnitListItem> {
  const { rows } = await context.client.query<StockUnitListItem>(
    `SELECT ${unitColumns}, ${unitInUseSql} AS "inUse" FROM stock_unit u WHERE u.company_id = $1 AND u.id = $2`, [context.company.companyId, unitId]);
  if (!rows[0]) throw notFound('Unit');
  return rows[0];
}

async function readUnit(context: LedgerContext, unitId: string, lock: '' | 'FOR UPDATE' | 'FOR SHARE' = ''): Promise<StockUnit> {
  const { rows } = await context.client.query<StockUnit>(`SELECT ${unitColumns} FROM stock_unit u WHERE u.company_id = $1 AND u.id = $2 ${lock}`, [context.company.companyId, unitId]);
  if (!rows[0]) throw notFound('Unit');
  return rows[0];
}

export async function createUnit(context: LedgerContext, value: unknown): Promise<StockUnit> {
  const input = parseInput(stockUnitCreateInput, value, unitFields);
  const { rows } = await context.client.query<{ id: string }>(
    'INSERT INTO stock_unit (company_id, symbol, formal_name, decimals) VALUES ($1, $2, $3, $4) RETURNING id',
    [context.company.companyId, input.symbol, input.formalName, input.decimals ?? 0]).catch(error => refusal(error, unitRefusals));
  const unit = await readUnit(context, rows[0].id);
  await logRevision(context, 'stock_unit', unit.id, 'create', null, unit);
  return unit;
}

/**
 * Renames a unit or changes its decimals. The row lock waits for opening writes in flight (they share-lock the unit), so
 * the check that refuses lowering the decimals of a used unit sees their rows.
 */
export async function alterUnit(context: LedgerContext, unitId: string, value: unknown): Promise<StockUnit> {
  const input = parseInput(stockUnitAlterInput, value, unitFields);
  const before = await readUnit(context, unitId, 'FOR UPDATE');
  if (before.revision !== input.revision) throw conflict('unit');
  const decimals = input.decimals ?? before.decimals;
  if (decimals < before.decimals) {
    const { rows: [use] } = await context.client.query<{ used: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM stock_item i JOIN stock_opening o ON o.company_id = i.company_id AND o.item_id = i.id WHERE i.unit_id = $2 AND i.company_id = $1) AS used`,
      [context.company.companyId, unitId]);
    if (use.used) throw unitRefusals.stock_unit_decimals;
  }
  await context.client.query('UPDATE stock_unit SET symbol = $3, formal_name = $4, decimals = $5, revision = revision + 1 WHERE company_id = $1 AND id = $2',
    [context.company.companyId, unitId, input.symbol, input.formalName, decimals]).catch(error => refusal(error, unitRefusals));
  const after = await readUnit(context, unitId);
  await logRevision(context, 'stock_unit', unitId, 'alter', before, after);
  return after;
}

export async function deleteUnit(context: LedgerContext, unitId: string, value: unknown): Promise<void> {
  const input = parseInput(revisionInput, value, unitFields);
  const inUse = ledgerError(409, 'This unit is used by stock items and cannot be deleted.', 'in_use');
  // Items come before units in the lock order: holding the unit while the foreign key check waits for an item that an
  // opening write holds (and that write waiting for the unit) would deadlock. An item committed after this read is still
  // caught by the foreign key.
  const { rows: [use] } = await context.client.query<{ used: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM stock_item WHERE unit_id = $2 AND company_id = $1) AS used', [context.company.companyId, unitId]);
  if (use.used) throw inUse;
  const before = await readUnit(context, unitId, 'FOR UPDATE');
  if (before.revision !== input.revision) throw conflict('unit');
  await context.client.query('DELETE FROM stock_unit WHERE company_id = $1 AND id = $2', [context.company.companyId, unitId])
    .catch(error => refusal(error, { ...unitRefusals, '23503': inUse }));
  await logRevision(context, 'stock_unit', unitId, 'delete', before, null);
}

// ---- Items and opening stock ----

const itemRefusals = {
  stock_item_name_idx: ledgerError(409, 'A stock item with this name already exists.', 'duplicate_name'),
  stock_item_unit_fixed: ledgerError(409, 'This item has opening stock or item lines, so its unit cannot change.', 'in_use'),
  stock_opening_quantity_places: ledgerError(400, 'An opening quantity has more decimal places than the item\'s unit allows.', 'validation'),
  stock_opening_locked: ledgerError(409, 'Opening stock is locked: the books are locked through the books beginning.', 'locked_period'),
  stock_unit_decimals: unitRefusals.stock_unit_decimals,
  // A unit, group or category deleted while this write waited on its foreign key check.
  stock_item_company_id_unit_id_fkey: ledgerError(400, 'The unit was not found.', 'not_found'),
  stock_item_company_id_group_id_fkey: ledgerError(400, 'The stock group was not found.', 'not_found'),
  stock_item_company_id_category_id_fkey: ledgerError(400, 'The stock category was not found.', 'not_found'),
  // An item delete refused by the item lines' key (M2b slice b1).
  inventory_line_company_id_item_id_fkey: ledgerError(409, 'This item has item lines and cannot be deleted.', 'in_use'),
};

type ItemRow = Omit<StockItem, 'openings' | 'openingValue'>;
const itemColumns = `i.id, i.name, i.second_language_name AS "secondLanguageName", i.group_id AS "groupId", g.name AS "groupName",
  i.category_id AS "categoryId", k.name AS "categoryName", i.unit_id AS "unitId", u.symbol AS "unitSymbol",
  trim_scale(i.standard_selling_rate)::text AS "standardSellingRate", i.revision`;
const itemFrom = `stock_item i JOIN stock_unit u ON u.company_id = i.company_id AND u.id = i.unit_id
  LEFT JOIN stock_group g ON g.company_id = i.company_id AND g.id = i.group_id
  LEFT JOIN stock_category k ON k.company_id = i.company_id AND k.id = i.category_id`;

/** Opening rows of the items `ids`: the quantity in its unit's places, a rate shown with at least the currency's places. */
async function openingsOf(context: LedgerContext, ids: string[]): Promise<Map<string, StockOpening[]>> {
  const { rows } = await context.client.query<StockOpening & { itemId: string }>(
    `SELECT o.item_id AS "itemId", o.location_id AS "locationId", l.name AS "locationName", round(o.quantity, u.decimals)::text AS quantity,
       CASE WHEN o.rate = round(o.rate, $3::integer) THEN round(o.rate, $3::integer)::text ELSE trim_scale(o.rate)::text END AS rate, o.value
     FROM stock_opening o JOIN stock_item i ON i.company_id = o.company_id AND i.id = o.item_id
       JOIN stock_unit u ON u.company_id = i.company_id AND u.id = i.unit_id
       JOIN stock_location l ON l.company_id = o.company_id AND l.id = o.location_id
     WHERE o.company_id = $1 AND o.item_id = ANY($2::uuid[]) ORDER BY o.item_id, lower(l.name), l.id`,
    [context.company.companyId, ids, context.company.exponent]);
  const byItem = new Map<string, StockOpening[]>();
  for (const { itemId, ...row } of rows) byItem.set(itemId, [...byItem.get(itemId) ?? [], row]);
  return byItem;
}

const withOpenings = (item: ItemRow, openings: StockOpening[] = []): StockItem =>
  ({ ...item, openings, openingValue: openings.reduce((sum, row) => sum + row.value, 0n) });

export async function listItems(context: LedgerContext): Promise<StockItem[]> {
  const { rows } = await context.client.query<ItemRow>(`SELECT ${itemColumns} FROM ${itemFrom} WHERE i.company_id = $1 ORDER BY lower(i.name), i.id`, [context.company.companyId]);
  const openings = await openingsOf(context, rows.map(row => row.id));
  return rows.map(row => withOpenings(row, openings.get(row.id)));
}

export async function readItem(context: LedgerContext, itemId: string, lock = false): Promise<StockItem> {
  if (lock) await context.client.query('SELECT 1 FROM stock_item WHERE company_id = $1 AND id = $2 FOR UPDATE', [context.company.companyId, itemId]);
  const { rows } = await context.client.query<ItemRow>(`SELECT ${itemColumns} FROM ${itemFrom} WHERE i.company_id = $1 AND i.id = $2`, [context.company.companyId, itemId]);
  if (!rows[0]) throw notFound('Stock item');
  return withOpenings(rows[0], (await openingsOf(context, [itemId])).get(itemId));
}

type OpeningPlan = { locationId: string; quantity: string; rate: string | null; value: bigint };

/** Whether value ÷ quantity, rounded half-up to six places as the database derives it, fits the rate column (numeric(20, 6)). */
export function derivedRateFits(value: bigint, quantity: string, exponent: number): boolean {
  const [whole, fraction = ''] = quantity.split('.');
  const millionths = value * 10n ** BigInt(6 + fraction.length), per = 10n ** BigInt(exponent) * BigInt(whole + fraction);
  return (2n * millionths + per) / (2n * per) < 10n ** 20n;
}

/**
 * Checks the item's opening rows against its unit and the currency: a quantity above zero with at most the unit's
 * decimals; a rate with at most the currency's places (the value is quantity × rate, half-up), or a value (the rate is
 * derived by the database, value ÷ quantity to six places); one row per location.
 */
function planOpenings(context: LedgerContext, unit: StockUnit, rows: NonNullable<ReturnType<typeof stockItemCreateInput.parse>['openings']>): OpeningPlan[] {
  const { exponent } = context.company;
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const where = `opening row ${index + 1}`;
    if (seen.has(row.locationId)) throw ledgerError(400, `The location of ${where} already has an opening row on this item.`, 'validation');
    seen.add(row.locationId);
    if (!/[1-9]/.test(row.quantity)) throw ledgerError(400, `The quantity of ${where} must be more than zero.`, 'validation');
    if ((row.quantity.split('.')[1] ?? '').length > unit.decimals) {
      throw ledgerError(400, `The quantity of ${where} has more decimal places than the unit ${unit.symbol} allows (${unit.decimals}).`, 'validation');
    }
    if (row.value !== undefined) {
      const value = parseAmount(row.value, exponent, `The value of ${where}`);
      if (value < 0n) throw ledgerError(400, `The value of ${where} cannot be negative.`, 'validation');
      if (!derivedRateFits(value, row.quantity, exponent)) {
        throw ledgerError(400, `The value of ${where} is too large for its quantity: the rate it gives must stay below 100,000,000,000,000.`, 'validation');
      }
      return { locationId: row.locationId, quantity: row.quantity, rate: null, value };
    }
    if ((row.rate!.split('.')[1] ?? '').length > exponent) throw ledgerError(400, `Enter the rate of ${where} with at most ${exponent} decimal places.`, 'validation');
    const value = multiplyMoney(parseMoney(row.rate!, exponent), row.quantity, 'half-up');
    try { assertMoneyInRange(value); } catch { throw ledgerError(400, `The value of ${where} is too large.`, 'validation'); }
    return { locationId: row.locationId, quantity: row.quantity, rate: row.rate!, value };
  });
}

/** Inserts the opening rows of an item that has none (new, or just emptied): share-locks the unit, key-shares the locations in id order. */
async function writeOpenings(context: LedgerContext, itemId: string, unitId: string, rows: OpeningPlan[]): Promise<void> {
  const { companyId, exponent } = context.company;
  if (!rows.length) return;
  await readUnit(context, unitId, 'FOR SHARE');
  const locationIds = [...new Set(rows.map(row => row.locationId))].sort();
  const { rows: found } = await context.client.query<{ id: string }>(
    'SELECT id FROM stock_location WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR KEY SHARE', [companyId, locationIds]);
  if (found.length !== locationIds.length) throw ledgerError(400, 'A location of the opening stock was not found in this company.', 'not_found');
  await context.client.query(
    `INSERT INTO stock_opening (company_id, item_id, location_id, quantity, rate, value)
     SELECT $1, $2, t.location_id, t.quantity, coalesce(t.rate, round(t.value::numeric / power(10::numeric, $3::integer) / t.quantity, 6)), t.value
     FROM unnest($4::uuid[], $5::numeric[], $6::numeric[], $7::bigint[]) AS t(location_id, quantity, rate, value)`,
    [companyId, itemId, exponent, rows.map(row => row.locationId), rows.map(row => row.quantity), rows.map(row => row.rate), rows.map(row => row.value)])
    .catch(error => refusal(error, itemRefusals));
}

const itemUnit = (context: LedgerContext, unitId: string) => readUnit(context, unitId).catch(missingAs(ledgerError(400, 'The unit was not found.', 'not_found')));
async function assertReferences(context: LedgerContext, input: { groupId: string | null; categoryId: string | null }): Promise<void> {
  if (input.groupId) await readTree(context, trees['stock-groups'], input.groupId).catch(missingAs(ledgerError(400, 'The stock group was not found.', 'not_found')));
  if (input.categoryId) await readTree(context, trees['stock-categories'], input.categoryId).catch(missingAs(ledgerError(400, 'The stock category was not found.', 'not_found')));
}

export async function createItem(context: LedgerContext, value: unknown): Promise<StockItem> {
  const input = parseInput(stockItemCreateInput, value, itemFields);
  if (!await inventoryEnabled(context)) throw ledgerError(409, 'Inventory is switched off for this company. An owner or admin switches it on first.', 'feature_off');
  await assertReferences(context, input);
  const unit = await itemUnit(context, input.unitId);
  const openings = planOpenings(context, unit, input.openings ?? []);
  if (openings.length) assertOpeningOpen(context);
  const { rows } = await context.client.query<{ id: string }>(
    `INSERT INTO stock_item (company_id, group_id, category_id, unit_id, name, second_language_name, standard_selling_rate) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [context.company.companyId, input.groupId, input.categoryId, unit.id, input.name, input.secondLanguageName, input.standardSellingRate])
    .catch(error => refusal(error, itemRefusals));
  await writeOpenings(context, rows[0].id, unit.id, openings);
  const item = await readItem(context, rows[0].id);
  await logRevision(context, 'stock_item', item.id, 'create', null, item);
  return item;
}

/** A decimal string without leading or trailing zeros, so equal quantities compare equal as text. */
const decimalKey = (text: string) => text.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
/** The same rows: location, quantity and value, and the rate too when one is sent (a value sent derives the same rate). */
const sameOpenings = (before: StockOpening[], after: OpeningPlan[]) => before.length === after.length
  && before.every(row => after.some(plan => plan.locationId === row.locationId && plan.value === row.value && decimalKey(plan.quantity) === decimalKey(row.quantity)
    && (plan.rate === null || decimalKey(plan.rate) === decimalKey(row.rate))));

/**
 * Alters an item. `openings`, when sent, replaces its rows whole (refused while the lock reaches the books beginning,
 * unless the set is unchanged); the unit cannot change while the item has rows (API and database).
 */
export async function alterItem(context: LedgerContext, itemId: string, value: unknown): Promise<StockItem> {
  const input = parseInput(stockItemAlterInput, value, itemFields);
  const before = await readItem(context, itemId, true);
  if (before.revision !== input.revision) throw conflict('stock item');
  await assertReferences(context, input);
  const unit = await itemUnit(context, input.unitId);
  const openings = input.openings === undefined ? null : planOpenings(context, unit, input.openings);
  const rowsAfter = openings ?? before.openings;
  if (unit.id !== before.unitId && rowsAfter.length) throw itemRefusals.stock_item_unit_fixed;
  // The same set re-sent is no change, so it is kept as stored (and allowed under the lock).
  const replacement = openings && !sameOpenings(before.openings, openings) ? openings : null;
  if (replacement) assertOpeningOpen(context);
  // Before the update, so an item whose rows go may change its unit.
  if (replacement) await context.client.query('DELETE FROM stock_opening WHERE company_id = $1 AND item_id = $2', [context.company.companyId, itemId]);
  await context.client.query(
    `UPDATE stock_item SET group_id = $3, category_id = $4, unit_id = $5, name = $6, second_language_name = $7, standard_selling_rate = $8, revision = revision + 1
     WHERE company_id = $1 AND id = $2`,
    [context.company.companyId, itemId, input.groupId, input.categoryId, unit.id, input.name, input.secondLanguageName, input.standardSellingRate])
    .catch(error => refusal(error, itemRefusals));
  if (replacement) await writeOpenings(context, itemId, unit.id, replacement);
  const after = await readItem(context, itemId);
  await logRevision(context, 'stock_item', itemId, 'alter', before, after);
  return after;
}

/** Deletes an item with its opening rows; refused while the lock reaches the books beginning if it has any. */
export async function deleteItem(context: LedgerContext, itemId: string, value: unknown): Promise<void> {
  const input = parseInput(revisionInput, value, itemFields);
  const before = await readItem(context, itemId, true);
  if (before.revision !== input.revision) throw conflict('stock item');
  if (before.openings.length) assertOpeningOpen(context);
  await context.client.query('DELETE FROM stock_opening WHERE company_id = $1 AND item_id = $2', [context.company.companyId, itemId]);
  await context.client.query('DELETE FROM stock_item WHERE company_id = $1 AND id = $2', [context.company.companyId, itemId]).catch(error => refusal(error, itemRefusals));
  await logRevision(context, 'stock_item', itemId, 'delete', before, null);
}

// ---- The company's inventory switch ----

/**
 * Whether the company keeps inventory. Read here rather than with the company settings every request loads, so the
 * shared ledger context stays readable on a database before migration 0011. A writer already share-locks the company
 * row (ledgerContext), so a switch in flight, which locks it for update, commits before this reads.
 */
export async function inventoryEnabled(context: LedgerContext): Promise<boolean> {
  const { rows } = await context.client.query<{ enabled: boolean }>('SELECT inventory_enabled AS enabled FROM company WHERE company_id = $1', [context.company.companyId]);
  return rows[0].enabled;
}

export const readInventorySetting = async (context: LedgerContext): Promise<InventorySetting> => ({ enabled: await inventoryEnabled(context) });

/**
 * Switches inventory on or off (owners and admins; anyone else is told the company is not there, as for the cost
 * centres switch). Off is refused while the company has stock items. The company row is locked for update, so an item
 * create in flight (which share-locks it) commits first and is seen.
 */
export async function saveInventorySetting(context: LedgerContext, value: unknown): Promise<InventorySetting> {
  if (context.role !== 'owner' && context.role !== 'admin') throw ledgerError(404, 'Company not found or unavailable.', 'not_found');
  const input = parseInput(inventorySettingInput, value, () => 'the inventory setting');
  await context.client.query('SELECT 1 FROM company WHERE company_id = $1 FOR UPDATE', [context.company.companyId]);
  if (!input.enabled) {
    const { rows: [items] } = await context.client.query<{ any: boolean }>('SELECT EXISTS (SELECT 1 FROM stock_item WHERE company_id = $1) AS any', [context.company.companyId]);
    if (items.any) throw ledgerError(409, 'This company has stock items, so inventory cannot be switched off.', 'in_use');
  }
  await context.client.query('UPDATE company SET inventory_enabled = $2 WHERE company_id = $1', [context.company.companyId, input.enabled]);
  return input;
}

// ---- Statements ----

/**
 * The company's opening stock: the sum of its opening rows' values, or null when it has none. Until valuation arrives
 * (slice c) this is the stock value at every date.
 */
export async function openingStockValue(context: LedgerContext): Promise<bigint | null> {
  const { rows } = await context.client.query<{ value: bigint | null }>('SELECT sum(value)::bigint AS value FROM stock_opening WHERE company_id = $1', [context.company.companyId]);
  return rows[0].value;
}
