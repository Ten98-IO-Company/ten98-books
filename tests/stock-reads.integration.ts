import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { PoolClient } from 'pg';
import { readLastRate, readStockQuantity, stockWarnings } from '../src/server/ledger/item-lines.ts';
import { readVoucher } from '../src/server/ledger/vouchers.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, inCompany, invite, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * Stock reads and the negative-stock warning (M2b slice b2): an item's quantity at a date, at a location or in all;
 * its last sale rate; the warning of a create, alter, cancel and delete; the rows each reads, by transaction counters
 * on a busy item, with no statistics and then analysed; and the wrong-company answers.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let viewer: Member;
let companyId = '', other = '';
let accounts: Chart;
const ids = { nos: '', main: '', yard: '', sales: '', purchases: '', customer: '', supplier: '' };

const call = (path: string, body?: unknown, member: Member = owner, company = companyId) => member.browser.call(`/api/companies/${company}${path}`, body);
const ok = async (path: string, body?: unknown, status = body === undefined ? 200 : 201) => {
  const answer = await call(path, body);
  assert.equal(answer.status, status, `${path}: ${JSON.stringify(answer.body)}`);
  return answer.body;
};
type Row = Record<string, unknown>;
const item = async (name: string, openings: Row[] = []) => (await ok('/stock-items', { name, unitId: ids.nos, openings })).stockItem.id as string;
const voucher = (kind: string, date: string, inventory: Row[], extra: Row = {}) => {
  const total = (inventory.reduce((sum, row) => sum + (row.amount !== undefined ? Number(row.amount) : Number(row.quantity) * Number(row.rate ?? 0)), 0)).toFixed(2);
  const [party, partySide, ledger] = kind === 'purchase' || kind === 'credit_note' ? [ids.supplier, kind === 'purchase' ? 'Cr' : 'Cr', ids.purchases] : [ids.customer, 'Dr', ids.sales];
  const lines = kind === 'stock_journal' ? [] : [{ ledgerId: kind === 'credit_note' ? ids.customer : party, side: kind === 'credit_note' ? 'Cr' : partySide, amount: total }];
  return { idempotencyKey: `reads-${randomUUID()}`, voucherTypeId: accounts.type(kind), date, lines, inventory,
    ...kind === 'stock_journal' ? {} : { itemLedgerId: kind === 'credit_note' ? ids.sales : ledger }, ...extra };
};
const post = async (payload: Row, status = 201) => {
  const answer = await call('/vouchers', payload);
  assert.equal(answer.status, status, JSON.stringify(answer.body));
  return answer.body as { voucher: any; warnings: any[] };
};
const stock = async (itemId: string, date: string, locationId?: string) =>
  (await ok(`/stock-items/${itemId}/stock?date=${date}${locationId ? `&locationId=${locationId}` : ''}`)).stock.quantity as string;
const lastRate = async (itemId: string, date: string) => (await ok(`/stock-items/${itemId}/last-rate?date=${date}`)).lastRate.rate as string | null;
const stockOnly = (warnings: any[]) => warnings.filter(warning => warning.code === 'negative_stock').map(warning => [warning.locationId, warning.quantity]);

before(async () => {
  database = await freshDatabase('stock_reads');
  // Statistics come only from the ANALYZE of the counter test, never from autovacuum, so its plans cannot flip.
  await asAdmin(database.adminUrl, admin => admin.query(['inventory_line', 'voucher', 'stock_opening'].map(table => `ALTER TABLE ${table} SET (autovacuum_enabled = false)`).join('; ')));
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, { name: 'Stock Reads' });
  other = await createCompany(owner.browser, { name: 'Other Reads' });
  viewer = await invite(owner.browser, companyId, 'viewer');
  accounts = await chart(owner.browser, companyId);
  const ledger = async (name: string, group: string) => (await ok('/ledgers', { name, groupId: accounts.group(group) })).ledger.id as string;
  ids.sales = await ledger('Trade Sales', 'sales');
  ids.purchases = await ledger('Trade Purchases', 'purchases');
  ids.customer = await ledger('Customer North', 'receivables');
  ids.supplier = await ledger('Supplier South', 'payables');
  ids.nos = (await ok('/stock-units', { symbol: 'Nos' })).stockUnit.id;
  ids.main = ((await ok('/stock-locations')).stockLocations as any[]).find(row => row.systemKey === 'main').id;
  ids.yard = (await ok('/stock-locations', { name: 'Yard' })).stockLocation.id;
});
after(async () => { await database?.drop(); });

test('the stock read: opening rows and the lines of regular, undeleted vouchers dated by the date, at a location or in all', async () => {
  const widget = await item('Widget', [{ locationId: ids.main, quantity: '10', rate: '1.00' }]);
  await post(voucher('purchase', '2026-02-01', [{ itemId: widget, locationId: ids.yard, quantity: '5', rate: '2.00' }]));
  assert.deepEqual([await stock(widget, '2026-02-01', ids.main), await stock(widget, '2026-02-01', ids.yard), await stock(widget, '2026-02-01')], ['10', '5', '15']);
  assert.equal(await stock(widget, '2026-01-31'), '10', 'a purchase dated after the date does not count');
  // Cancelled, deleted and optional sales do not count; a regular one does.
  const cancelled = await post(voucher('sales', '2026-02-02', [{ itemId: widget, locationId: ids.main, quantity: '1', rate: '3.00' }]));
  await ok(`/vouchers/${cancelled.voucher.id}/cancel`, { revision: cancelled.voucher.revision }, 200);
  const deleted = await post(voucher('sales', '2026-02-02', [{ itemId: widget, locationId: ids.main, quantity: '2', rate: '3.00' }]));
  await ok(`/vouchers/${deleted.voucher.id}/delete`, { revision: deleted.voucher.revision }, 200);
  await post(voucher('sales', '2026-02-02', [{ itemId: widget, locationId: ids.main, quantity: '3', rate: '3.00' }], { status: 'optional' }));
  assert.equal(await stock(widget, '2026-02-02', ids.main), '10');
  await post(voucher('sales', '2026-02-03', [{ itemId: widget, locationId: ids.main, quantity: '4', rate: '3.00' }]));
  assert.deepEqual([await stock(widget, '2026-02-03', ids.main), await stock(widget, '2026-02-03')], ['6', '11']);
  // A stock journal moves both ways.
  await post(voucher('stock_journal', '2026-02-04', [{ itemId: widget, locationId: ids.main, quantity: '6', rate: '1.00', direction: 'out' }, { itemId: widget, locationId: ids.yard, quantity: '6', rate: '1.00', direction: 'in' }]));
  assert.deepEqual([await stock(widget, '2026-02-04', ids.main), await stock(widget, '2026-02-04', ids.yard), await stock(widget, '2026-02-04')], ['0', '11', '11']);
});

test('the last rate: the latest regular sale on or before the date, the later voucher on a tie; null before the first', async () => {
  const gadget = await item('Gadget', [{ locationId: ids.main, quantity: '100', rate: '1.00' }]);
  await post(voucher('sales', '2026-03-10', [{ itemId: gadget, locationId: ids.main, quantity: '1', rate: '50.00' }]));
  await post(voucher('sales', '2026-03-20', [{ itemId: gadget, locationId: ids.main, quantity: '1', rate: '55.00' }]));
  assert.deepEqual([await lastRate(gadget, '2026-03-31'), await lastRate(gadget, '2026-03-15'), await lastRate(gadget, '2026-03-01')], ['55.00', '50.00', null]);
  // Not counted [assumption until observed]: a later credit note and a later optional sale.
  await post(voucher('credit_note', '2026-03-25', [{ itemId: gadget, locationId: ids.main, quantity: '1', rate: '70.00' }]));
  await post(voucher('sales', '2026-03-26', [{ itemId: gadget, locationId: ids.main, quantity: '1', rate: '80.00' }], { status: 'optional' }));
  assert.equal(await lastRate(gadget, '2026-03-31'), '55.00');
  // Two sales on one date: the later voucher [assumption]; a rate the amount derived shows as stored.
  await post(voucher('sales', '2026-03-28', [{ itemId: gadget, locationId: ids.main, quantity: '1', rate: '60.00' }]));
  await post(voucher('sales', '2026-03-28', [{ itemId: gadget, locationId: ids.main, quantity: '3', amount: '100.00' }]));
  assert.equal(await lastRate(gadget, '2026-03-31'), '33.333333');
});

test('the warning: a regular voucher taking a location below zero warns for that location only; never an optional one, nor a later positive balance', async () => {
  const bolt = await item('Bolt', [{ locationId: ids.main, quantity: '2', rate: '1.00' }, { locationId: ids.yard, quantity: '6', rate: '1.00' }]);
  const sold = await post(voucher('sales', '2026-04-01', [{ itemId: bolt, locationId: ids.main, quantity: '4', rate: '2.00' }]));
  assert.deepEqual(stockOnly(sold.warnings), [[ids.main, '-2']], '-2 at Main although the item holds 4 in all');
  const optional = await post(voucher('sales', '2026-04-01', [{ itemId: bolt, locationId: ids.yard, quantity: '100', rate: '2.00' }], { status: 'optional' }));
  assert.deepEqual(stockOnly(optional.warnings), [], 'an optional voucher never warns');
  // A sale dated before the first inward, with a positive balance over every date: no warning [screen, once].
  const nut = await item('Nut');
  await post(voucher('purchase', '2026-04-10', [{ itemId: nut, locationId: ids.main, quantity: '10', rate: '1.00' }]));
  const early = await post(voucher('sales', '2026-04-05', [{ itemId: nut, locationId: ids.main, quantity: '3', rate: '2.00' }]));
  assert.deepEqual(stockOnly(early.warnings), []);
});

test('the warning on an alter, a cancel and a delete that reduce what came in', async () => {
  const pin = await item('Pin');
  const bought = await post(voucher('purchase', '2026-05-01', [{ itemId: pin, locationId: ids.main, quantity: '10', rate: '1.00' }]));
  await post(voucher('sales', '2026-05-02', [{ itemId: pin, locationId: ids.main, quantity: '5', rate: '2.00' }]));
  const lowered = await call(`/vouchers/${bought.voucher.id}`, {
    date: '2026-05-01', narration: null, status: 'regular', postDated: false, reference: null, referenceDate: null,
    lines: [{ ledgerId: ids.supplier, side: 'Cr', amount: '1.00' }], itemLedgerId: ids.purchases,
    inventory: [{ itemId: pin, locationId: ids.main, quantity: '1', rate: '1.00' }], revision: bought.voucher.revision });
  assert.equal(lowered.status, 200, JSON.stringify(lowered.body));
  assert.deepEqual(stockOnly(lowered.body.warnings), [[ids.main, '-4']], 'altered from 10 to 1 under sales of 5');
  const cancelled = await call(`/vouchers/${bought.voucher.id}/cancel`, { revision: lowered.body.voucher.revision });
  assert.deepEqual(stockOnly(cancelled.body.warnings), [[ids.main, '-5']], 'cancelled');
  const clip = await item('Clip');
  const fed = await post(voucher('purchase', '2026-05-01', [{ itemId: clip, locationId: ids.yard, quantity: '3', rate: '1.00' }]));
  await post(voucher('sales', '2026-05-02', [{ itemId: clip, locationId: ids.yard, quantity: '2', rate: '2.00' }]));
  const removed = await call(`/vouchers/${fed.voucher.id}/delete`, { revision: fed.voucher.revision });
  assert.deepEqual(stockOnly(removed.body.warnings), [[ids.yard, '-2']], 'deleted');
});

test('viewers read; another company\'s item, and any route of a company the caller cannot reach, answer not found', async () => {
  const seen = await item('Seen', [{ locationId: ids.main, quantity: '1', rate: '1.00' }]);
  assert.equal((await call(`/stock-items/${seen}/stock?date=2026-12-31`, undefined, viewer)).body.stock.quantity, '1');
  assert.equal((await call(`/stock-items/${seen}/last-rate?date=2026-12-31`, undefined, viewer)).status, 200);
  const theirs = (await owner.browser.call(`/api/companies/${other}/stock-items`, { name: 'Theirs', unitId: (await owner.browser.call(`/api/companies/${other}/stock-units`, { symbol: 'Each' })).body.stockUnit.id })).body.stockItem.id;
  for (const path of [`/stock-items/${theirs}/stock?date=2026-12-31`, `/stock-items/${theirs}/last-rate?date=2026-12-31`]) {
    const answer = await call(path);
    assert.deepEqual([answer.status, answer.body.code], [404, 'not_found'], path);
  }
  const stranger = await invite(owner.browser, other, 'viewer');
  for (const path of [`/stock-items/${seen}/stock?date=2026-12-31`, `/stock-items/${seen}/last-rate?date=2026-12-31`]) {
    const answer = await call(path, undefined, stranger);
    assert.deepEqual([answer.status, answer.body.code], [404, 'not_found'], `stranger ${path}`);
  }
  const bad = await call(`/stock-items/${seen}/stock?date=2026-02-30`);
  assert.deepEqual([bad.status, bad.body.code], [400, 'validation']);
  assert.equal((await call(`/stock-items/${seen}/stock?date=2026-12-31&extra=1`)).status, 400, 'an unknown parameter is refused');
  assert.equal((await call(`/stock-items/${seen}/stock?date=2026-12-31`, {})).status, 405);
});

type Counters = { items: number; itemsSequential: number; vouchers: number; vouchersSequential: number };
const counters = async (client: PoolClient): Promise<Counters> => {
  const { rows } = await client.query<{ relname: string; seq_tup_read: string; idx_tup_fetch: string }>(
    "SELECT relname, seq_tup_read, idx_tup_fetch FROM pg_stat_xact_user_tables WHERE relname IN ('inventory_line', 'voucher')");
  const of = (name: string) => rows.find(row => row.relname === name)!;
  return { items: Number(of('inventory_line').idx_tup_fetch), itemsSequential: Number(of('inventory_line').seq_tup_read),
    vouchers: Number(of('voucher').idx_tup_fetch), vouchersSequential: Number(of('voucher').seq_tup_read) };
};

test('the reads and the warning fetch one busy pair\'s rows: 3,000 lines at each of two locations, with no statistics and then analysed', async t => {
  const busy = await item('Busy', [{ locationId: ids.main, quantity: '1', rate: '1.00' }, { locationId: ids.yard, quantity: '1', rate: '1.00' }]);
  // Twelve regular stock journals of 500 lines through the API: six into Main, six into Yard.
  for (const location of [ids.main, ids.yard]) {
    for (let journal = 0; journal < 6; journal++) {
      await post(voucher('stock_journal', '2026-06-01', Array.from({ length: 500 }, () => ({ itemId: busy, locationId: location, quantity: '1', rate: '1.00', direction: 'in' }))));
    }
  }
  const sale = await post(voucher('sales', '2026-06-02', [{ itemId: busy, locationId: ids.yard, quantity: '1', rate: '2.00' }]));
  // Beside it, 20,000 lines of 40 other items (optional stock journals of 500 lines: rows of the table that do not count),
  // so the item is a small part of the table and its index must win.
  await asAdmin(database.adminUrl, async admin => {
    await admin.query('BEGIN');
    await admin.query("SELECT set_config('app.company_ids', $1, true)", [companyId]);
    const type = (await admin.query('SELECT id, numbering_series FROM voucher_type WHERE id = $1', [accounts.type('stock_journal')])).rows[0];
    await admin.query(`INSERT INTO stock_item (company_id, name, unit_id) SELECT $1, 'Other ' || n, $2 FROM generate_series(1, 40) n`, [companyId, ids.nos]);
    await admin.query(`INSERT INTO voucher (company_id, voucher_type_id, series, date, status, idempotency_key, request_hash, created_by)
      SELECT $1, $2, $3, '2026-06-01', 'optional', 'other-key-' || n, $4, $5 FROM generate_series(1, 40) n`, [companyId, type.id, type.numbering_series, 'a'.repeat(64), owner.userId]);
    await admin.query(`INSERT INTO inventory_line (company_id, voucher_id, entry_no, item_id, location_id, direction, quantity, rate, amount)
      SELECT $1, v.id, n, i.id, $2, 'in', 1, 1, 100 FROM voucher v JOIN stock_item i ON i.company_id = v.company_id AND i.name = 'Other ' || substr(v.idempotency_key, 11)
        CROSS JOIN generate_series(1, 500) n WHERE v.company_id = $1 AND v.idempotency_key LIKE 'other-key-%'`, [companyId, ids.yard]);
    await admin.query('COMMIT');
  });
  const lines = 3000;
  for (const tables of ['no statistics', 'analysed'] as const) {
    if (tables === 'analysed') await asAdmin(database.adminUrl, admin => admin.query('ANALYZE inventory_line; ANALYZE voucher; ANALYZE stock_opening'));
    else assert.equal(Number((await asAdmin(database.adminUrl, admin => admin.query("SELECT count(*) FROM pg_stats WHERE tablename IN ('inventory_line', 'voucher')"))).rows[0].count), 0, 'no statistics yet');
    await inCompany(owner.userId, companyId, async context => {
      const after = await readVoucher(context, sale.voucher.id);
      for (const [what, run, pairLines] of [
        ['the warning at Yard', () => stockWarnings(context, null, after), lines + 1],
        ['the stock at Yard', () => readStockQuantity(context, busy, { date: '2026-12-31', locationId: ids.yard }), lines + 1],
        ['the stock in all', () => readStockQuantity(context, busy, { date: '2026-12-31' }), 2 * lines + 1],
        ['the last rate', () => readLastRate(context, busy, { date: '2026-12-31' }), 2 * lines + 1],
      ] as const) {
        const start = await counters(context.client), started = performance.now();
        await run();
        const elapsed = performance.now() - started, end = await counters(context.client);
        const fetched = { items: end.items - start.items, itemsSequential: end.itemsSequential - start.itemsSequential, vouchers: end.vouchers - start.vouchers, vouchersSequential: end.vouchersSequential - start.vouchersSequential };
        t.diagnostic(`${tables}, ${what}: ${fetched.items} item-line fetches, ${fetched.itemsSequential} read sequentially; ${fetched.vouchers} voucher fetches, ${fetched.vouchersSequential} read sequentially; ${elapsed.toFixed(0)} ms`);
        assert.equal(fetched.itemsSequential, 0, `${tables}, ${what}: no sequential read of item lines`);
        if (tables === "analysed") assert.ok(fetched.items <= pairLines + 10, `${tables}, ${what}: ${fetched.items} item-line fetches for ${pairLines} lines of its own`);
        // Each line's voucher by its key: about one fetch a line once analysed (or one pass over the company's vouchers).
        if (tables === 'analysed') assert.ok(fetched.vouchers + fetched.vouchersSequential <= pairLines + 100, `${tables}, ${what}: ${fetched.vouchers} voucher fetches`);
      }
    }, 'write');
  }
});
