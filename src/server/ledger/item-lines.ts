import { addMoney, assertMoneyInRange, multiplyMoney, parseMoney, type MoneyExponent } from '@ten98/runtime';
import type { InventoryLine, ItemLineInput, Side, VoucherKind } from '../../lib/ledger.ts';
import { ledgerError, parseAmount, refusal, type LedgerContext } from './context.ts';
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

/** The kinds that take item lines, with their direction and the side of their derived ledger lines. */
const invoiceKinds: Partial<Record<VoucherKind, { direction: 'in' | 'out'; side: Side }>> = {
  sales: { direction: 'out', side: 'Cr' }, purchase: { direction: 'in', side: 'Dr' },
  credit_note: { direction: 'in', side: 'Dr' }, debit_note: { direction: 'out', side: 'Cr' },
};
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
 * Whether the item lines' table exists. Migration tests post vouchers through this code on a schema before 0013, then
 * migrate; once the table is seen it stays, so a running server asks once.
 */
let itemLinesTable = false;
async function hasItemLinesTable(context: LedgerContext): Promise<boolean> {
  if (!itemLinesTable) itemLinesTable = (await context.client.query<{ present: boolean }>("SELECT to_regclass('inventory_line') IS NOT NULL AS present")).rows[0].present;
  return itemLinesTable;
}

/** A voucher's item lines as stored, in entry order: the quantity in its unit's places, the rate with at least the currency's. */
export async function readItemLines(context: LedgerContext, voucherId: string): Promise<InventoryLine[]> {
  if (!await hasItemLinesTable(context)) return [];
  const { rows } = await context.client.query<InventoryLine>(
    `SELECT l.entry_no AS "entryNo", l.item_id AS "itemId", i.name AS "itemName", l.location_id AS "locationId", s.name AS "locationName", l.direction,
       round(l.quantity, u.decimals)::text AS quantity,
       CASE WHEN l.rate = round(l.rate, $3::integer) THEN round(l.rate, $3::integer)::text ELSE trim_scale(l.rate)::text END AS rate,
       trim_scale(l.discount_percent)::text AS "discountPercent", l.amount, l.ledger_id AS "ledgerId", l.line_no AS "lineNo"
     FROM inventory_line l JOIN stock_item i ON i.company_id = l.company_id AND i.id = l.item_id
       JOIN stock_unit u ON u.company_id = i.company_id AND u.id = i.unit_id
       JOIN stock_location s ON s.company_id = l.company_id AND s.id = l.location_id
     WHERE l.company_id = $1 AND l.voucher_id = $2 ORDER BY l.entry_no`, [context.company.companyId, voucherId, context.company.exponent]);
  return rows;
}
