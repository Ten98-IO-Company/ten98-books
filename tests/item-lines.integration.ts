import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * Item lines over the HTTP contract (M2b slice b1): ledger lines derived from item lines, the line arithmetic, zero
 * amounts, the stock journal, kinds and type changes, the alter round trip, cost rows on derived lines, the limits,
 * the inventory switch, the location default, cancel and delete, and the day book's count. The database's own guards
 * and the races are in item-lines-guards.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let companyId = '';
let accounts: Chart;
const ids = { kg: '', nos: '', fine: '', rod: '', bolt: '', dust: '', main: '', yard: '', sales: '', export: '', purchases: '', customer: '', supplier: '' };

const call = (path: string, body?: unknown, company = companyId) => owner.browser.call(`/api/companies/${company}${path}`, body);
const ok = async (path: string, body?: unknown, status = body === undefined ? 200 : 201, company = companyId) => {
  const answer = await call(path, body, company);
  assert.equal(answer.status, status, `${path}: ${JSON.stringify(answer.body)}`);
  return answer.body;
};
const refused = async (path: string, body: unknown, status: number, code: string, what: string, message?: string | RegExp, company = companyId) => {
  const answer = await call(path, body, company);
  assert.deepEqual([answer.status, answer.body?.code], [status, code], `${what}: ${JSON.stringify(answer.body)}`);
  if (typeof message === 'string') assert.equal(answer.body.error, message, what);
  else if (message) assert.match(answer.body.error, message, what);
};
type Row = Record<string, unknown>;
const body = (kind: string, lines: [string, 'Dr' | 'Cr', string][], inventory: Row[], extra: Row = {}) => ({
  idempotencyKey: `item-${randomUUID()}`, voucherTypeId: accounts.type(kind), date: '2026-02-10',
  lines: lines.map(([ledgerId, side, amount]) => ({ ledgerId, side, amount })), inventory, ...extra,
});
const sale = (inventory: Row[], total: string, extra: Row = {}) => body('sales', [[ids.customer, 'Dr', total]], inventory, { itemLedgerId: ids.sales, ...extra });
const posted = async (payload: unknown) => (await ok('/vouchers', payload)).voucher;
/** A voucher as read, mapped to the input shape and sent back unchanged (derived lines included, marked). */
const asInput = (voucher: any, changes: Row = {}) => ({
  date: voucher.date, narration: voucher.narration, status: voucher.status, postDated: voucher.postDated, reference: voucher.reference, referenceDate: voucher.referenceDate,
  lines: voucher.lines.map((line: any) => ({ ledgerId: line.ledgerId, side: line.side, amount: line.amount, ...(line.derived ? { derived: true } : {}) })),
  inventory: voucher.inventory.map((row: any) => ({ itemId: row.itemId, locationId: row.locationId, quantity: row.quantity, rate: row.rate, amount: row.amount, direction: row.direction,
    ...(row.discountPercent ? { discountPercent: row.discountPercent } : {}), ...(row.ledgerId ? { ledgerId: row.ledgerId } : {}) })),
  revision: voucher.revision, ...changes,
});
const shape = (voucher: any) => ({
  lines: voucher.lines.map((line: any) => [line.lineNo, line.ledgerName, line.side, line.amount, line.derived]),
  inventory: voucher.inventory.map((row: any) => [row.entryNo, row.itemName, row.locationName, row.direction, row.quantity, row.rate, row.discountPercent, row.amount, row.lineNo]),
});

before(async () => {
  database = await freshDatabase('item_lines');
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, { name: 'Item Lines' });
  accounts = await chart(owner.browser, companyId);
  const ledger = async (name: string, group: string) => (await ok('/ledgers', { name, groupId: accounts.group(group) })).ledger.id as string;
  ids.sales = await ledger('Trade Sales', 'sales');
  ids.export = await ledger('Export Sales', 'sales');
  ids.purchases = await ledger('Trade Purchases', 'purchases');
  ids.customer = await ledger('Customer North', 'receivables');
  ids.supplier = await ledger('Supplier South', 'payables');
  ids.kg = (await ok('/stock-units', { symbol: 'Kg', decimals: 2 })).stockUnit.id;
  ids.nos = (await ok('/stock-units', { symbol: 'Nos' })).stockUnit.id;
  ids.fine = (await ok('/stock-units', { symbol: 'Gram', decimals: 4 })).stockUnit.id;
  ids.rod = (await ok('/stock-items', { name: 'Rod', unitId: ids.kg })).stockItem.id;
  ids.bolt = (await ok('/stock-items', { name: 'Bolt', unitId: ids.nos })).stockItem.id;
  ids.dust = (await ok('/stock-items', { name: 'Dust', unitId: ids.fine })).stockItem.id;
  ids.main = ((await ok('/stock-locations')).stockLocations as any[]).find(row => row.systemKey === 'main').id;
  ids.yard = (await ok('/stock-locations', { name: 'Yard' })).stockLocation.id;
});
after(async () => { await database?.drop(); });

test('item lines derive one ledger line per ledger, in order of first use, marked derived in the read with the item lines pointing at it', async () => {
  const one = await posted(sale([
    { itemId: ids.rod, locationId: ids.main, quantity: '2', rate: '10.00' },
    { itemId: ids.bolt, locationId: ids.yard, quantity: '3', rate: '5.00' },
  ], '35.00'));
  assert.deepEqual(shape(one), {
    lines: [[1, 'Customer North', 'Dr', '35.00', false], [2, 'Trade Sales', 'Cr', '35.00', true]],
    inventory: [[1, 'Rod', 'Main Store', 'out', '2.00', '10.00', null, '20.00', 2], [2, 'Bolt', 'Yard', 'out', '3', '5.00', null, '15.00', 2]],
  });
  assert.deepEqual(one.inventory.map((row: any) => row.ledgerId), [ids.sales, ids.sales]);
  const two = await posted(sale([
    { itemId: ids.bolt, locationId: ids.main, quantity: '1', rate: '4.00', ledgerId: ids.export },
    { itemId: ids.rod, locationId: ids.main, quantity: '1', rate: '6.00' },
    { itemId: ids.bolt, locationId: ids.main, quantity: '1', rate: '2.00', ledgerId: ids.export },
  ], '12.00'));
  assert.deepEqual(shape(two).lines, [[1, 'Customer North', 'Dr', '12.00', false], [2, 'Export Sales', 'Cr', '6.00', true], [3, 'Trade Sales', 'Cr', '6.00', true]]);
  assert.deepEqual(two.inventory.map((row: any) => row.lineNo), [2, 3, 2]);
  // A purchase derives a debit; a client line on the item ledger stays a line of its own.
  const purchase = await posted(body('purchase', [[ids.supplier, 'Cr', '15.00'], [ids.purchases, 'Dr', '5.00']], [{ itemId: ids.bolt, locationId: ids.main, quantity: '2', rate: '5.00' }], { itemLedgerId: ids.purchases }));
  assert.deepEqual(shape(purchase).lines, [[1, 'Supplier South', 'Cr', '15.00', false], [2, 'Trade Purchases', 'Dr', '5.00', false], [3, 'Trade Purchases', 'Dr', '10.00', true]]);
  assert.equal(purchase.inventory[0].direction, 'in');
});

test('line arithmetic: half-up per line, an amount typed over the rate wins, the rate\'s own amount keeps the rate, and the refusals', async () => {
  const line = async (row: Row, total: string) => (await posted(sale([{ locationId: ids.main, ...row }], total))).inventory[0];
  assert.deepEqual([(await line({ itemId: ids.bolt, quantity: '3', rate: '0.33' }, '0.99')).amount], ['0.99'], '3 x 0.33');
  assert.equal((await line({ itemId: ids.dust, quantity: '1.2345', rate: '10.00' }, '12.35')).amount, '12.35', '1.2345 x 10.00, half-up');
  assert.deepEqual(Object.values((({ rate, amount }) => ({ rate, amount }))(await line({ itemId: ids.bolt, quantity: '4', rate: '30.00', amount: '200.00' }, '200.00'))), ['50.00', '200.00'], 'the amount wins');
  assert.deepEqual(Object.values((({ rate, amount }) => ({ rate, amount }))(await line({ itemId: ids.rod, quantity: '0.5', rate: '2.01', amount: '1.01' }, '1.01'))), ['2.01', '1.01'], 'the rate\'s own amount keeps it');
  assert.equal((await line({ itemId: ids.bolt, quantity: '3', amount: '100.00' }, '100.00')).rate, '33.333333', 'a derived rate to six places');
  assert.equal((await line({ itemId: ids.bolt, quantity: '4', rate: '25.00', discountPercent: '12.5' }, '87.50')).amount, '87.50', 'a discount');
  // Rounded per line: two lines of 1 x 0.01 at 50 % are 0.01 each.
  const halves = await posted(sale([1, 2].map(() => ({ itemId: ids.bolt, locationId: ids.main, quantity: '1', rate: '0.01', discountPercent: '50' })), '0.02'));
  assert.deepEqual([halves.inventory.map((row: any) => row.amount), halves.lines[1].amount], [['0.01', '0.01'], '0.02']);

  const cases: [Row, string, RegExp][] = [
    [{ itemId: ids.bolt, quantity: '1', rate: '0.3333' }, 'a rate with more places than the currency', /^Enter the rate of item line 1 with at most 2 decimal places\.$/],
    [{ itemId: ids.dust, quantity: '0.0001', amount: '10000000000.00' }, 'a rate beyond the column', /^The amount of item line 1 is too large for its quantity/],
    [{ itemId: ids.bolt, quantity: '9999999999999999', rate: '99999999999999.99' }, 'an amount beyond the money range', /^The amount of item line 1 is too large\.$/],
    [{ itemId: ids.bolt, quantity: '0', rate: '1.00' }, 'a zero quantity', /^The quantity of item line 1 must be more than zero\.$/],
    [{ itemId: ids.bolt, quantity: '1' }, 'neither a rate nor an amount', /^Enter a rate or an amount for item line 1\.$/],
    [{ itemId: ids.bolt, quantity: '1', rate: '1.00', discountPercent: '100' }, 'a discount of 100', /discount/],
    [{ itemId: ids.rod, quantity: '1.125', rate: '1.00' }, 'more places than the unit', /^The quantity of item line 1 has more decimal places than the unit Kg allows \(2\)\.$/],
    [{ itemId: ids.bolt, quantity: '1', rate: '1.00', direction: 'in' }, 'a sale coming in', /^On a sales every item line goes out; item line 1 says in\.$/],
  ];
  // Balanced at the line's own amount where it has one, so each refusal is the one named.
  for (const [row, what, message] of cases) await refused('/vouchers', sale([{ locationId: ids.main, ...row }], row.quantity === '1.125' ? '1.13' : '1.00'), 400, 'validation', what, message);
});

test('zero: an invoice item line without an amount is refused with a plain message, a stock journal line at zero cost is accepted', async () => {
  await refused('/vouchers', body('purchase', [[ids.supplier, 'Cr', '10.00']], [
    { itemId: ids.bolt, locationId: ids.main, quantity: '10', rate: '1.00' }, { itemId: ids.rod, locationId: ids.main, quantity: '4', rate: '0.00' },
  ], { itemLedgerId: ids.purchases }), 400, 'validation', 'a zero-value line beside a valued one', 'Item line 2 has no amount. Enter a rate or an amount, or remove the line.');
  const journal = await posted(body('stock_journal', [], [{ itemId: ids.bolt, locationId: ids.main, quantity: '2', amount: '0.00', direction: 'in' }]));
  assert.deepEqual(shape(journal), { lines: [], inventory: [[1, 'Bolt', 'Main Store', 'in', '2', '0.00', null, '0.00', null]] });
});

test('a stock journal holds item lines only, in either direction and with unequal sides, and takes no ledger, item ledger or discount', async () => {
  const journal = await posted(body('stock_journal', [], [
    { itemId: ids.rod, locationId: ids.main, quantity: '5', rate: '4.00', direction: 'out' },
    { itemId: ids.rod, locationId: ids.yard, quantity: '5', amount: '20.12', direction: 'in' },
  ]));
  assert.deepEqual(journal.inventory.map((row: any) => [row.direction, row.amount, row.ledgerId, row.lineNo]), [['out', '20.00', null, null], ['in', '20.12', null, null]]);
  assert.equal(journal.total, '0.00');
  for (const [payload, what, message] of [
    [body('stock_journal', [[ids.customer, 'Dr', '1.00']], [{ itemId: ids.rod, locationId: ids.main, quantity: '1', rate: '1.00', direction: 'in' }]), 'a ledger line', /^A stock journal has no ledger lines/],
    [body('stock_journal', [], []), 'no item line', /^A stock journal needs at least one item line\.$/],
    [body('stock_journal', [], [{ itemId: ids.rod, locationId: ids.main, quantity: '1', rate: '1.00' }]), 'no direction', /^Say whether item line 1 goes in or out\.$/],
    [body('stock_journal', [], [{ itemId: ids.rod, locationId: ids.main, quantity: '1', rate: '1.00', direction: 'in', discountPercent: '5' }]), 'a discount', /takes no discount/],
    [body('stock_journal', [], [{ itemId: ids.rod, locationId: ids.main, quantity: '1', rate: '1.00', direction: 'in', ledgerId: ids.sales }]), 'a ledger on a row', /posts to no ledger/],
    [body('stock_journal', [], [{ itemId: ids.rod, locationId: ids.main, quantity: '1', rate: '1.00', direction: 'in' }], { itemLedgerId: ids.sales }), 'an item ledger', /posts to no ledger/],
    [body('journal', [[ids.customer, 'Dr', '1.00'], [ids.sales, 'Cr', '1.00']], [{ itemId: ids.rod, locationId: ids.main, quantity: '1', rate: '1.00' }]), 'item lines on a journal', /^A journal voucher takes no item lines\.$/],
  ] as const) await refused('/vouchers', payload, 400, 'validation', what, message);
});

test('the alter round trip: a voucher read and sent back is unchanged; without inventory it is refused; an empty inventory removes the items; a duplicate posts once', async () => {
  const voucher = await posted(sale([
    { itemId: ids.rod, locationId: ids.main, quantity: '0.5', rate: '2.01' },
    { itemId: ids.bolt, locationId: ids.yard, quantity: '3', amount: '100.00', discountPercent: '10' },
  ], '101.01'));
  const again = (await ok(`/vouchers/${voucher.id}`, asInput(voucher), 200)).voucher;
  assert.deepEqual(shape(again), shape(voucher), 'unchanged');
  assert.equal(again.revision, voucher.revision + 1);
  const { inventory: _left, ...withoutItems } = asInput(again);
  await refused(`/vouchers/${voucher.id}`, withoutItems, 400, 'validation', 'a body on today\'s shape', 'This voucher has item lines. Send them as inventory, or send an empty inventory to remove them.');
  const emptied = (await ok(`/vouchers/${voucher.id}`, asInput(again, {
    inventory: [], lines: [{ ledgerId: ids.customer, side: 'Dr', amount: '101.01' }, { ledgerId: ids.sales, side: 'Cr', amount: '101.01' }],
  }), 200)).voucher;
  assert.deepEqual(shape(emptied), { lines: [[1, 'Customer North', 'Dr', '101.01', false], [2, 'Trade Sales', 'Cr', '101.01', false]], inventory: [] });
  // A body with derived lines marked, posted as a new voucher (a duplicate), derives them once.
  const { revision: _revision, ...duplicate } = asInput(again);
  const copy = await posted({ ...duplicate, idempotencyKey: `dup-${randomUUID()}`, voucherTypeId: accounts.type('sales') });
  assert.deepEqual(shape(copy), shape(again));
  // History: the alter entry holds the item lines before and after.
  const revisions = (await ok(`/vouchers/${voucher.id}/revisions`)).revisions as any[];
  const emptying = revisions.find(entry => entry.action === 'alter' && entry.after.inventory.length === 0);
  assert.ok(emptying, JSON.stringify(revisions.map(entry => entry.action)));
  assert.equal(emptying.before.inventory.length, 2);
});

test('a type change applies the new kind: item lines on a journal are refused, dropped with balanced lines it is accepted', async () => {
  const voucher = await posted(sale([{ itemId: ids.bolt, locationId: ids.main, quantity: '1', rate: '9.00' }], '9.00', { status: 'optional' }));
  await refused(`/vouchers/${voucher.id}`, asInput(voucher, { voucherTypeId: accounts.type('journal') }), 400, 'validation', 'keeping the item lines', /^A journal voucher takes no item lines\.$/);
  const moved = (await ok(`/vouchers/${voucher.id}`, asInput(voucher, {
    voucherTypeId: accounts.type('journal'), inventory: [], lines: [{ ledgerId: ids.customer, side: 'Dr', amount: '9.00' }, { ledgerId: ids.sales, side: 'Cr', amount: '9.00' }],
  }), 200)).voucher;
  assert.deepEqual([moved.kind, moved.inventory], ['journal', []]);
});

test('derived lines take no cost rows: posted on a cost-centre ledger without rows; an alter that would carry a line\'s rows onto one is refused', async () => {
  await ok('/cost-centres-setting', { enabled: true }, 200);
  const general = ((await ok('/cost-categories')).costCategories as any[]).find(row => row.systemKey === 'primary').id;
  const centre = (await ok('/cost-centres', { name: 'Showroom', categoryId: general, parentId: null })).costCentre.id;
  const costed = (await ok('/ledgers', { name: 'Costed Sales', groupId: accounts.group('sales'), costCentres: true })).ledger.id;
  const plain = await posted(sale([{ itemId: ids.bolt, locationId: ids.main, quantity: '1', rate: '7.00' }], '7.00', { itemLedgerId: costed }));
  assert.deepEqual(plain.lines[1].costAllocations, [], 'a derived line posts without rows');
  const accounting = await posted(body('sales', [[ids.customer, 'Dr', '8.00']], [], {
    lines: [{ ledgerId: ids.customer, side: 'Dr', amount: '8.00' }, { ledgerId: costed, side: 'Cr', amount: '8.00', costAllocations: [{ costCentreId: centre, amount: '8.00' }] }],
  }));
  assert.equal(accounting.lines[1].costAllocations.length, 1);
  await refused(`/vouchers/${accounting.id}`, asInput(accounting, {
    lines: [{ ledgerId: ids.customer, side: 'Dr', amount: '8.00' }], itemLedgerId: costed, inventory: [{ itemId: ids.bolt, locationId: ids.main, quantity: '1', rate: '8.00' }],
  }), 400, 'validation', 'rows that would move onto a derived line', /^The line on Costed Sales carries cost allocations, and a ledger line derived from item lines takes none yet/);
  await ok('/cost-centres-setting', { enabled: false }, 200);
});

test('limits: at most 500 lines with the derived ones, at most 500 item lines', async () => {
  const lines = Array.from({ length: 499 }, () => ({ ledgerId: ids.customer, side: 'Dr', amount: '1.00' }));
  await refused('/vouchers', { ...body('sales', [], [
    { itemId: ids.bolt, locationId: ids.main, quantity: '1', rate: '1.00' }, { itemId: ids.bolt, locationId: ids.main, quantity: '1', rate: '1.00', ledgerId: ids.export },
  ], { itemLedgerId: ids.sales }), lines }, 400, 'validation', '499 lines and two derived', /^A voucher holds at most 500 lines: 499 entered and 2 derived/);
  await refused('/vouchers', sale(Array.from({ length: 501 }, () => ({ itemId: ids.bolt, locationId: ids.main, quantity: '1', rate: '1.00' })), '501.00'), 400, 'validation', '501 item lines');
});

test('the location may be left out only while the company has one; item lines need inventory on', async () => {
  await refused('/vouchers', sale([{ itemId: ids.bolt, quantity: '1', rate: '1.00' }], '1.00'), 400, 'validation', 'two locations', /^Choose the location of item line 1: this company has more than one\.$/);
  const single = await createCompany(owner.browser, { name: 'One Location' });
  const theirs = await chart(owner.browser, single);
  const unit = (await ok('/stock-units', { symbol: 'Box' }, 201, single)).stockUnit.id;
  const item = (await ok('/stock-items', { name: 'Crate', unitId: unit }, 201, single)).stockItem.id;
  const customer = (await ok('/ledgers', { name: 'Walk-in', groupId: theirs.group('receivables') }, 201, single)).ledger.id;
  const sales = (await ok('/ledgers', { name: 'Shop Sales', groupId: theirs.group('sales') }, 201, single)).ledger.id;
  const sold = (await ok('/vouchers', { idempotencyKey: `one-${randomUUID()}`, voucherTypeId: theirs.type('sales'), date: '2026-02-10',
    lines: [{ ledgerId: customer, side: 'Dr', amount: '3.00' }], itemLedgerId: sales, inventory: [{ itemId: item, quantity: '1', rate: '3.00' }] }, 201, single)).voucher;
  assert.equal(sold.inventory[0].locationName, 'Main Store');
  await asAdmin(database.adminUrl, admin => admin.query('UPDATE company SET inventory_enabled = false WHERE company_id = $1', [single]));
  await refused('/vouchers', { idempotencyKey: `off-${randomUUID()}`, voucherTypeId: theirs.type('sales'), date: '2026-02-10',
    lines: [{ ledgerId: customer, side: 'Dr', amount: '3.00' }], itemLedgerId: sales, inventory: [{ itemId: item, quantity: '1', rate: '3.00' }] }, 409, 'feature_off', 'inventory off', undefined, single);
  // Items and locations of another company are not found here.
  await refused('/vouchers', sale([{ itemId: item, locationId: ids.main, quantity: '1', rate: '1.00' }], '1.00'), 400, 'not_found', 'another company\'s item', /^The item on item line 1 was not found in this company\.$/);
});

test('cancel and delete keep a voucher\'s item lines for the record; masters with item lines are in use', async () => {
  const cancelled = await posted(sale([{ itemId: ids.rod, locationId: ids.yard, quantity: '1', rate: '1.00' }], '1.00'));
  const afterCancel = (await ok(`/vouchers/${cancelled.id}/cancel`, { revision: cancelled.revision }, 200)).voucher;
  assert.deepEqual([afterCancel.status, afterCancel.inventory.length], ['cancelled', 1]);
  const deleted = await posted(sale([{ itemId: ids.rod, locationId: ids.yard, quantity: '1', rate: '1.00' }], '1.00'));
  await ok(`/vouchers/${deleted.id}/delete`, { revision: deleted.revision }, 200);
  assert.equal((await ok(`/vouchers/${deleted.id}`)).voucher.inventory.length, 1);
  const item = (await ok(`/stock-items/${ids.dust}`)).stockItem;
  await refused(`/stock-items/${ids.dust}/delete`, { revision: item.revision }, 409, 'in_use', 'an item with item lines', /^This item has item lines and cannot be deleted\.$/);
  const yard = (await ok(`/stock-locations/${ids.yard}`)).stockLocation;
  await refused(`/stock-locations/${ids.yard}/delete`, { revision: yard.revision }, 409, 'in_use', 'a location with item lines', /used by opening stock or item lines/);
  const gram = (await ok(`/stock-units/${ids.fine}`)).stockUnit;
  await refused(`/stock-units/${ids.fine}`, { symbol: 'Gram', decimals: 2, revision: gram.revision }, 409, 'in_use', 'lowering a used unit\'s decimals', /used by opening stock or item lines/);
  await refused(`/stock-items/${ids.dust}`, { name: 'Dust', unitId: ids.kg, revision: item.revision }, 409, 'in_use', 'changing a used item\'s unit', /opening stock or item lines/);
});

test('the day book counts a stock journal, which has no ledger lines', async () => {
  const other = await createCompany(owner.browser, { name: 'Day Book Items' });
  const theirs = await chart(owner.browser, other);
  const unit = (await ok('/stock-units', { symbol: 'Each' }, 201, other)).stockUnit.id;
  const item = (await ok('/stock-items', { name: 'Widget', unitId: unit }, 201, other)).stockItem.id;
  const cash = theirs.ledger('Cash');
  const income = (await ok('/ledgers', { name: 'Sundry Income', groupId: theirs.group('indirect_income') }, 201, other)).ledger.id;
  await ok('/vouchers', { idempotencyKey: `db-${randomUUID()}`, voucherTypeId: theirs.type('stock_journal'), date: '2026-03-02', lines: [], inventory: [{ itemId: item, quantity: '1', rate: '1.00', direction: 'in' }] }, 201, other);
  await ok('/vouchers', { idempotencyKey: `db-${randomUUID()}`, voucherTypeId: theirs.type('receipt'), date: '2026-03-03', lines: [{ ledgerId: cash, side: 'Dr', amount: '5.00' }, { ledgerId: income, side: 'Cr', amount: '5.00' }] }, 201, other);
  const book = (await ok('/reports/day-book?from=2026-03-01&to=2026-03-31', undefined, 200, other)).report;
  assert.deepEqual([book.totals.vouchers, book.rows.length, book.rows[0].particulars, book.rows[0].amount], [2, 2, null, '0.00']);
});
