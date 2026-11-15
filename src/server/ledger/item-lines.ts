import { addMoney, assertMoneyInRange, multiplyMoney, parseMoney, type MoneyExponent } from '@ten98/runtime';
import { itemInvoiceKinds as invoiceKinds, type InventoryLine, type ItemLineInput, type Side, type StockWarning, type Voucher, type VoucherKind } from '../../lib/ledger.ts';
import { lastRateQuery, stockQuantityQuery, type LastRate, type StockQuantity } from '../../lib/stock.ts';
import { ledgerError, parseAmount, parseInput, refusal, type LedgerContext } from './context.ts';
import { derivedRateFits, inventoryEnabled } from './stock-masters.ts';

/**
 * Item lines on vouchers (M2b slice b1, migration 0013). On a sales, purchase, credit-note or debit-note voucher each
 * item line posts to a sales or purchase ledger, and the server derives one voucher line per ledger (in order of first
 * use) worth the sum of its items: screens never compute it. A stock journal holds item lines only, in either
 * direction, and posts nothing to the accounts. Quantities move; stock values stay at the opening rows until valuation
 * (slice c). The database repeats the kind, the sums and the unit's places (`inventory_line_guard`,
 * `inventory_line_assert_line`, `voucher_assert_balanced`).
 *
 * Locks, after the ledgers: the items, then their units, share-locked in id order, then the locations key-shared in id
 * order, all before any item line is written. A share lock conflicts with the update that lowers a unit's decimals or
 * changes an item's unit, so such a change in flight is waited for and its result checked (the database's guard locks
 * the same rows again, row by row, and finds them held).
 */

export const takesItemLines = (kind: VoucherKind) => kind === 'stock_journal' || kind in invoiceKinds;

export type PlannedItemLine = {
  entryNo: number; itemId: string; locationId: string | undefined; direction: 'in' | 'out'; quantity: string;
  /** The rate to store; null when it is derived from the amount (in the database, to six places). */
  rate: string | null; discountPercent: string | null; amount: bigint; ledgerId: string | null; lineNo: number | null;
};
export type DerivedLine = { lineNo: number; ledgerId: string; side: Side; amount: bigint };
export type ItemLinePlan = { rows: PlannedItemLine[]; derived: DerivedLine[] };

const refuse = (message: string) => { throw ledgerError(400, message, 'validation'); };

type Decimal = { units: bigint; scale: number };
const decimal = (text: string): Decimal => {
  const [whole, fraction = ''] = text.split('.');
  return { units: BigInt(whole + fraction), scale: fraction.length };
};
const decimalText = ({ units, scale }: Decimal) => {
  if (scale === 0) return units.toString();
  const digits = units.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
};
/** quantity × (1 − discount ÷ 100), exactly: the factor a line's rate is multiplied by. */
export function lineFactor(quantity: string, discountPercent: string | null): string {
  const q = decimal(quantity);
  if (discountPercent === null) return decimalText(q);
  const d = decimal(discountPercent);
  return decimalText({ units: q.units * (100n * 10n ** BigInt(d.scale) - d.units), scale: q.scale + d.scale + 2 });
}
/** A line's amount from its rate: quantity × rate × (1 − discount), rounded half-up to the currency, once per line. */
export const lineAmount = (rate: string, quantity: string, discountPercent: string | null, exponent: MoneyExponent) =>
  multiplyMoney(parseMoney(rate, exponent), lineFactor(quantity, discountPercent), 'half-up');

/**
 * Checks a voucher's item lines and derives its ledger lines; no database read. Each line gives a quantity and a rate,
 * an amount, or both: a rate gives the amount (rounded half-up per line); an amount sent with the rate's own amount
 * keeps the rate; any other amount wins and the rate is derived from it. `lineCount` is the number of the client's
 * lines; derived lines are numbered after them.
 */
export function planItemLines(context: LedgerContext, kind: VoucherKind, rows: ItemLineInput[], itemLedgerId: string | null, lineCount: number): ItemLinePlan {
  const { exponent } = context.company;
  const invoice = invoiceKinds[kind];
  if (!rows.length) {
    if (kind === 'stock_journal') refuse('A stock journal needs at least one item line.');
    return { rows: [], derived: [] };
  }
  if (!takesItemLines(kind)) refuse(`A ${kind.replace('_', ' ')} voucher takes no item lines.`);
  if (!invoice && itemLedgerId !== null) refuse('A stock journal posts to no ledger: leave out the item ledger.');
  const derived: DerivedLine[] = [];
  const planned = rows.map((row, index): PlannedItemLine => {
    const where = `item line ${index + 1}`;
    if (!/[1-9]/.test(row.quantity)) refuse(`The quantity of ${where} must be more than zero.`);
    const discountPercent = row.discountPercent ?? null;
    let direction: 'in' | 'out', ledgerId: string | null = null;
    if (invoice) {
      if (row.direction !== undefined && row.direction !== invoice.direction) refuse(`On a ${kind.replace('_', ' ')} every item line goes ${invoice.direction}; ${where} says ${row.direction}.`);
      direction = invoice.direction;
      ledgerId = row.ledgerId ?? itemLedgerId;
      if (ledgerId === null) refuse(`Choose the ledger ${where} posts to, or the voucher's item ledger.`);
    } else {
      if (row.direction === undefined) refuse(`Say whether ${where} goes in or out.`);
      if (row.ledgerId !== undefined) refuse(`A stock journal posts to no ledger: leave out the ledger of ${where}.`);
      if (discountPercent !== null) refuse(`A stock journal line takes no discount (${where}).`);
      direction = row.direction!;
    }
    if (row.rate === undefined && row.amount === undefined) refuse(`Enter a rate or an amount for ${where}.`);
    // A rate that makes the amount has at most the currency's places. Sent with an amount, a finer rate (one the server
    // derived, read back) is not used: the amount wins and the rate is derived again.
    const usable = row.rate !== undefined && (row.rate.split('.')[1] ?? '').length <= exponent;
    if (row.rate !== undefined && !usable && row.amount === undefined) refuse(`Enter the rate of ${where} with at most ${exponent} decimal places.`);
    const fromRate = usable ? lineAmount(row.rate!, row.quantity, discountPercent, exponent) : null;
    const sent = row.amount === undefined ? null : parseAmount(row.amount, exponent, `The amount of ${where}`);
    if (sent !== null && sent < 0n) refuse(`The amount of ${where} cannot be negative.`);
    const amount = sent ?? fromRate!;
    try { assertMoneyInRange(amount); } catch { refuse(`The amount of ${where} is too large.`); }
    // The rate's own amount keeps the rate (a line read and sent back is unchanged); any other amount wins.
    const rate = fromRate !== null && fromRate === amount ? row.rate! : null;
    if (rate === null && !derivedRateFits(amount, lineFactor(row.quantity, discountPercent), exponent)) {
      refuse(`The amount of ${where} is too large for its quantity: the rate it gives must stay below 100,000,000,000,000.`);
    }
    if (invoice && amount === 0n) refuse(`Item line ${index + 1} has no amount. Enter a rate or an amount, or remove the line.`);
    let lineNo: number | null = null;
    if (invoice) {
      let line = derived.find(entry => entry.ledgerId === ledgerId);
      if (!line) { line = { lineNo: lineCount + derived.length + 1, ledgerId: ledgerId!, side: invoice.side, amount: 0n }; derived.push(line); }
      line.amount = addMoney(line.amount, amount);
      try { assertMoneyInRange(line.amount); } catch { refuse('The item lines on one ledger add up to too large an amount.'); }
      lineNo = line.lineNo;
    }
    return { entryNo: index + 1, itemId: row.itemId, locationId: row.locationId, direction, quantity: row.quantity, rate, discountPercent, amount, ledgerId, lineNo };
  });
  if (lineCount + derived.length > 500) refuse(`A voucher holds at most 500 lines: ${lineCount} entered and ${derived.length} derived from the item lines.`);
  return { rows: planned, derived };
}

/**
 * Takes the item lines' locks in the posting order (items, then units, share-locked; then locations, key-shared; each
 * in id order) and checks what they name against the rows as locked: items and locations of this company, each
 * quantity's places against its unit, and the location, which may be left out only while the company has one.
 * Refused with `feature_off` while the company keeps no inventory.
 */
export async function lockItemLines(context: LedgerContext, rows: PlannedItemLine[]): Promise<void> {
  if (!rows.length) return;
  const { client, company } = context;
  if (!await inventoryEnabled(context)) throw ledgerError(409, 'Inventory is switched off for this company. An owner or admin switches it on first.', 'feature_off');
  const itemIds = [...new Set(rows.map(row => row.itemId))].sort();
  const { rows: items } = await client.query<{ id: string; unit_id: string }>(
    'SELECT id, unit_id FROM stock_item WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR SHARE', [company.companyId, itemIds]);
  const unitOf = new Map(items.map(item => [item.id, item.unit_id]));
  const missing = rows.find(row => !unitOf.has(row.itemId));
  if (missing) throw ledgerError(400, `The item on item line ${missing.entryNo} was not found in this company.`, 'not_found');
  const { rows: units } = await client.query<{ id: string; symbol: string; decimals: number }>(
    'SELECT id, symbol, decimals FROM stock_unit WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR SHARE', [company.companyId, [...new Set(unitOf.values())].sort()]);
  const unitById = new Map(units.map(unit => [unit.id, unit]));
  for (const row of rows) {
    const unit = unitById.get(unitOf.get(row.itemId)!)!;
    if ((row.quantity.split('.')[1] ?? '').length > unit.decimals) {
      refuse(`The quantity of item line ${row.entryNo} has more decimal places than the unit ${unit.symbol} allows (${unit.decimals}).`);
    }
  }
  if (rows.some(row => row.locationId === undefined)) {
    const { rows: locations } = await client.query<{ id: string }>('SELECT id FROM stock_location WHERE company_id = $1 ORDER BY id LIMIT 2', [company.companyId]);
    const unnamed = rows.find(row => row.locationId === undefined)!;
    if (locations.length !== 1) refuse(`Choose the location of item line ${unnamed.entryNo}: this company has more than one.`);
    for (const row of rows) row.locationId ??= locations[0].id;
  }
  const locationIds = [...new Set(rows.map(row => row.locationId!))].sort();
  const { rows: found } = await client.query<{ id: string }>(
    'SELECT id FROM stock_location WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR KEY SHARE', [company.companyId, locationIds]);
  const known = new Set(found.map(row => row.id));
  const stray = rows.find(row => !known.has(row.locationId!));
  if (stray) throw ledgerError(400, `The location of item line ${stray.entryNo} was not found in this company.`, 'not_found');
}

const itemLineRefusals = {
  inventory_line_quantity_places: ledgerError(400, 'An item line has more decimal places than its item\'s unit allows.', 'validation'),
  inventory_line_company_id_item_id_fkey: ledgerError(400, 'An item of the item lines was not found in this company.', 'not_found'),
  inventory_line_company_id_location_id_fkey: ledgerError(400, 'A location of the item lines was not found in this company.', 'not_found'),
};

/** Writes the planned item lines (their locks are held: `lockItemLines`); a derived rate is computed in the database. */
export async function insertItemLines(context: LedgerContext, voucherId: string, rows: PlannedItemLine[]): Promise<void> {
  if (!rows.length) return;
  const { companyId, exponent } = context.company;
  await context.client.query(
    `INSERT INTO inventory_line (company_id, voucher_id, entry_no, item_id, location_id, direction, quantity, rate, discount_percent, amount, ledger_id, line_no)
     SELECT $1, $2, t.entry_no, t.item_id, t.location_id, t.direction, t.quantity,
       coalesce(t.rate, round(t.amount::numeric / power(10::numeric, $3::integer) / (t.quantity * (100 - coalesce(t.discount, 0)) / 100), 6)),
       t.discount, t.amount, t.ledger_id, t.line_no
     FROM unnest($4::smallint[], $5::uuid[], $6::uuid[], $7::text[], $8::numeric[], $9::numeric[], $10::numeric[], $11::bigint[], $12::uuid[], $13::smallint[])
       AS t(entry_no, item_id, location_id, direction, quantity, rate, discount, amount, ledger_id, line_no)`,
    [companyId, voucherId, exponent, rows.map(row => row.entryNo), rows.map(row => row.itemId), rows.map(row => row.locationId), rows.map(row => row.direction),
      rows.map(row => row.quantity), rows.map(row => row.rate), rows.map(row => row.discountPercent), rows.map(row => row.amount), rows.map(row => row.ledgerId), rows.map(row => row.lineNo)])
    .catch(error => refusal(error, itemLineRefusals));
}

/**
 * A voucher's item lines as stored, in entry order: the quantity in its unit's places, the rate with at least the
 * currency's. The voucher's own lines are taken first (MATERIALIZED, by voucher through inventory_line_line_idx), and
 * only then their item, unit and location by id. As a plain join, without statistics, the planner started from the
 * company's locations and items and probed each item's lines through inventory_line_item_idx, which since migration
 * 0014 does not lead with company_id and so always looks cheap: every line of each item read to find this voucher's
 * (22,000 for a 500-line voucher beside one item's history, measured). The shape must not be flattened.
 */
export async function readItemLines(context: LedgerContext, voucherId: string): Promise<InventoryLine[]> {
  const { rows } = await context.client.query<InventoryLine>(
    `WITH own AS MATERIALIZED (SELECT * FROM inventory_line WHERE voucher_id = $2 AND company_id = $1)
     SELECT l.entry_no AS "entryNo", l.item_id AS "itemId", i.name AS "itemName", l.location_id AS "locationId", s.name AS "locationName", l.direction,
       round(l.quantity, u.decimals)::text AS quantity,
       CASE WHEN l.rate = round(l.rate, $3::integer) THEN round(l.rate, $3::integer)::text ELSE trim_scale(l.rate)::text END AS rate,
       trim_scale(l.discount_percent)::text AS "discountPercent", l.amount, l.ledger_id AS "ledgerId", l.line_no AS "lineNo"
     FROM own l JOIN stock_item i ON i.company_id = l.company_id AND i.id = l.item_id
       JOIN stock_unit u ON u.company_id = i.company_id AND u.id = i.unit_id
       JOIN stock_location s ON s.company_id = l.company_id AND s.id = l.location_id
     ORDER BY l.entry_no`, [context.company.companyId, voucherId, context.company.exponent]);
  return rows;
}

// ---- Reads (M2b slice b2) ----
//
// The item lines are sought first, by item (and location) through inventory_line_item_idx, in a MATERIALIZED CTE: a
// plain join lets the planner start from the vouchers instead (without statistics it read every voucher of the company
// and every line of each, measured), and company_id = $n beside the item would let it take the company-led primary
// key. The forced policy keeps the scope. Only then are their vouchers joined, by primary key, for status, deletion
// and date. Opening rows are read by their primary key.

/** The item's lines (at `$4` when `location` is set) that count: regular, undeleted vouchers; `l` and `v` for the caller. */
const countedLines = (location: boolean) => `(WITH sought AS MATERIALIZED (
    SELECT company_id, voucher_id, entry_no, direction, quantity, rate FROM inventory_line WHERE item_id = $2${location ? ' AND location_id = $4' : ''})
  SELECT s.*, v.date, v.voucher_type_id FROM sought s JOIN voucher v ON v.company_id = s.company_id AND v.id = s.voucher_id
  WHERE v.status = 'regular' AND v.deleted_at IS NULL) l`;
const itemNotFound = ledgerError(404, 'Stock item not found.', 'not_found');

/**
 * An item's quantity at the end of `date`: its opening rows and the item lines of regular, undeleted vouchers dated on
 * or before it, at one location or in all, in the unit's places.
 */
export async function readStockQuantity(context: LedgerContext, itemId: string, value: unknown): Promise<StockQuantity> {
  const query = parseInput(stockQuantityQuery, value, path => path[0] === 'locationId' ? 'the location' : path[0] === 'date' ? 'the date' : 'the query');
  const location = query.locationId ?? null;
  const { rows } = await context.client.query<{ quantity: string; located: boolean }>(
    `SELECT ${location ? 'EXISTS (SELECT 1 FROM stock_location sl WHERE sl.company_id = $1 AND sl.id = $4)' : 'true'} AS located,
       round(coalesce((SELECT sum(o.quantity) FROM stock_opening o WHERE o.company_id = $1 AND o.item_id = i.id${location ? ' AND o.location_id = $4' : ''}), 0)
       + coalesce((SELECT sum(CASE l.direction WHEN 'in' THEN l.quantity ELSE -l.quantity END) FROM ${countedLines(location !== null)} WHERE l.date <= $3), 0), u.decimals)::text AS quantity
     FROM stock_item i JOIN stock_unit u ON u.company_id = i.company_id AND u.id = i.unit_id WHERE i.company_id = $1 AND i.id = $2`,
    [context.company.companyId, itemId, query.date, ...location ? [location] : []]);
  if (!rows[0]) throw itemNotFound;
  // Another company's location, or a made-up one, is not found, like an item.
  if (!rows[0].located) throw ledgerError(404, 'Stock location not found.', 'not_found');
  return { itemId, locationId: location, date: query.date, quantity: rows[0].quantity };
}

/**
 * The rate of the item's latest sale dated on or before `date` (sales vouchers only, regular and undeleted; ties by the
 * later voucher, uuidv7 order, then the later entry), as `readItemLines` shows a rate; null when there is none.
 */
export async function readLastRate(context: LedgerContext, itemId: string, value: unknown): Promise<LastRate> {
  const query = parseInput(lastRateQuery, value, path => path[0] === 'date' ? 'the date' : 'the query');
  const { rows } = await context.client.query<{ rate: string | null }>(
    `SELECT (SELECT CASE WHEN l.rate = round(l.rate, $4::integer) THEN round(l.rate, $4::integer)::text ELSE trim_scale(l.rate)::text END
         FROM ${countedLines(false)} WHERE l.date <= $3
           AND EXISTS (SELECT 1 FROM voucher_type t WHERE t.company_id = l.company_id AND t.id = l.voucher_type_id AND t.kind = 'sales')
         ORDER BY l.date DESC, l.voucher_id DESC, l.entry_no DESC LIMIT 1) AS rate
     FROM stock_item i WHERE i.company_id = $1 AND i.id = $2`,
    [context.company.companyId, itemId, query.date, context.company.exponent]);
  if (!rows[0]) throw itemNotFound;
  return { itemId, date: query.date, rate: rows[0].rate };
}

type Pair = { itemId: string; locationId: string };
const pairKey = (row: Pair) => `${row.itemId}|${row.locationId}`;
/** A quantity in ten-thousandths, exactly (quantities carry at most four places). */
const tenThousandths = (quantity: string) => { const [whole, fraction = ''] = quantity.split('.'); return BigInt(whole + fraction.padEnd(4, '0')); };
/** The inward quantity of a voucher per (item, location), when the voucher counts (regular, not deleted). */
function inwards(voucher: Voucher | null): Map<string, { pair: Pair; quantity: bigint }> {
  const result = new Map<string, { pair: Pair; quantity: bigint }>();
  if (!voucher || voucher.status !== 'regular' || voucher.deleted) return result;
  for (const row of voucher.inventory) {
    if (row.direction !== 'in') continue;
    const entry = result.get(pairKey(row)) ?? { pair: { itemId: row.itemId, locationId: row.locationId }, quantity: 0n };
    entry.quantity += tenThousandths(row.quantity);
    result.set(pairKey(row), entry);
  }
  return result;
}

/** The stock check's own statement time budget; it is advice, so it gives up rather than slow the posting past it. */
export const stockCheckTimeout = '2s';

/**
 * The stock warnings of a change, which can never fail, slow past `stockCheckTimeout` or abort the posting: the check runs
 * in a savepoint under that statement timeout, and if it fails for any database reason (a timeout, a lock wait cut short)
 * the posting goes on and the answer says `stock_check_incomplete` instead of leaving the warning out silently. The
 * savepoint holds only the check's reads, so it is rolled back on success too, which also ends its timeout. A lost
 * connection is not caught: there is no posting left to save.
 */
export async function stockWarnings(context: LedgerContext, before: Voucher | null, after: Voucher | null): Promise<StockWarning[]> {
  const pairs = checkedPairs(before, after);
  if (!pairs.length) return [];
  const { client } = context;
  await client.query(`SAVEPOINT stock_check; SET LOCAL statement_timeout = '${stockCheckTimeout}'`);
  const close = () => client.query('ROLLBACK TO SAVEPOINT stock_check; RELEASE SAVEPOINT stock_check');
  let warnings: StockWarning[];
  try { warnings = await negativeStock(context, pairs); }
  catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (typeof code !== 'string' || code.startsWith('08')) throw error;
    warnings = [{ code: 'stock_check_incomplete' }];
  }
  await close();
  return warnings;
}

/**
 * The (item, location) pairs a change from `before` to `after` (either null: a create, or nothing left) can lower. Checked:
 * each (item, location) the voucher moves out when it counts after the change, and each one whose inward quantity the
 * change reduces (an alter, a cancel or a delete). An optional voucher never warns and does not count. The balance is
 * over every date, later-dated vouchers included, from opening rows and the lines of regular, undeleted vouchers: one
 * sum per pair through the item index, linear in that pair's history. Read after the writes, in the same transaction.
 */
function checkedPairs(before: Voucher | null, after: Voucher | null): Pair[] {
  const pairs = new Map<string, Pair>();
  if (after && after.status === 'regular' && !after.deleted) {
    for (const row of after.inventory) if (row.direction === 'out') pairs.set(pairKey(row), { itemId: row.itemId, locationId: row.locationId });
  }
  const was = inwards(before), is = inwards(after);
  for (const [key, entry] of was) if ((is.get(key)?.quantity ?? 0n) < entry.quantity) pairs.set(key, entry.pair);
  return [...pairs.values()].sort((x, y) => pairKey(x).localeCompare(pairKey(y)));
}

/** The pairs among `list` whose balance is below zero, with that balance. */
async function negativeStock(context: LedgerContext, list: Pair[]): Promise<StockWarning[]> {
  const { rows } = await context.client.query<{ itemId: string; locationId: string; quantity: string }>(
    `WITH pairs AS (SELECT * FROM unnest($2::uuid[], $3::uuid[]) WITH ORDINALITY AS p(item_id, location_id, ord)),
       sought AS MATERIALIZED (
         SELECT p.ord, l.company_id, l.voucher_id, l.direction, l.quantity FROM pairs p
           JOIN inventory_line l ON l.item_id = p.item_id AND l.location_id = p.location_id),
       moved AS (SELECT s.ord, sum(CASE s.direction WHEN 'in' THEN s.quantity ELSE -s.quantity END) AS quantity
         FROM sought s JOIN voucher v ON v.company_id = s.company_id AND v.id = s.voucher_id
         WHERE v.status = 'regular' AND v.deleted_at IS NULL GROUP BY s.ord)
     SELECT p.item_id AS "itemId", p.location_id AS "locationId", round(coalesce(o.quantity, 0) + coalesce(m.quantity, 0), u.decimals)::text AS quantity
     FROM pairs p JOIN stock_item i ON i.company_id = $1 AND i.id = p.item_id JOIN stock_unit u ON u.company_id = i.company_id AND u.id = i.unit_id
       CROSS JOIN LATERAL (SELECT sum(o.quantity) AS quantity FROM stock_opening o WHERE o.company_id = $1 AND o.item_id = p.item_id AND o.location_id = p.location_id) o
       LEFT JOIN moved m ON m.ord = p.ord
     WHERE coalesce(o.quantity, 0) + coalesce(m.quantity, 0) < 0 ORDER BY p.ord`,
    [context.company.companyId, list.map(pair => pair.itemId), list.map(pair => pair.locationId)]);
  return rows.map(row => ({ code: 'negative_stock', itemId: row.itemId, locationId: row.locationId, quantity: row.quantity }));
}
