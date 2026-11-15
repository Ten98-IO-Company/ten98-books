import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { PoolClient } from 'pg';
import { alterVoucher, createVoucher, readVoucher } from '../src/server/ledger/vouchers.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, inCompany, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * The cost of the item-line checks at commit (migration 0013): a sales invoice of 500 item lines on one ledger line,
 * posted and altered through HTTP, timed against the same invoice without items; and the item rows those checks fetch,
 * from the transaction's own table counters. The per-row check reads its line's rows, so one line of n items costs
 * about n x n fetches; the deduplication of the design is built only if the time budget fails.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let companyId = '';
let books: Chart;
const ids = { sales: '', customer: '', item: '', main: '' };
const items = 500;

before(async () => {
  database = await freshDatabase('item_timing');
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, { name: 'Item Timing' });
  books = await chart(owner.browser, companyId);
  const ok = async (path: string, body: unknown) => {
    const answer = await owner.browser.call(`/api/companies/${companyId}${path}`, body);
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    return answer.body;
  };
  ids.sales = (await ok('/ledgers', { name: 'Sales', groupId: books.group('sales') })).ledger.id;
  ids.customer = (await ok('/ledgers', { name: 'Customer', groupId: books.group('receivables') })).ledger.id;
  ids.item = (await ok('/stock-items', { name: 'Widget', unitId: (await ok('/stock-units', { symbol: 'Nos' })).stockUnit.id })).stockItem.id;
  ids.main = ((await owner.browser.call(`/api/companies/${companyId}/stock-locations`)).body.stockLocations as any[]).find(row => row.systemKey === 'main').id;
});
after(async () => { await database?.drop(); });

const total = (rate: number) => (items * rate).toFixed(2);
const inventory = (rate: number) => Array.from({ length: items }, () => ({ itemId: ids.item, locationId: ids.main, quantity: '1', rate: rate.toFixed(2) }));
const body = (withItems: boolean, rate: number) => ({
  idempotencyKey: `timing-${randomUUID()}`, voucherTypeId: books.type('sales'), date: '2026-02-10',
  ...withItems
    ? { lines: [{ ledgerId: ids.customer, side: 'Dr', amount: total(rate) }], itemLedgerId: ids.sales, inventory: inventory(rate) }
    : { lines: [{ ledgerId: ids.customer, side: 'Dr', amount: total(rate) }, { ledgerId: ids.sales, side: 'Cr', amount: total(rate) }] },
});
const alterBody = (revision: number, withItems: boolean, rate: number) => {
  const { idempotencyKey: _key, voucherTypeId: _type, ...rest } = body(withItems, rate);
  return { ...rest, narration: null, status: 'regular', postDated: false, reference: null, referenceDate: null, ...withItems ? {} : { inventory: [] }, revision };
};

test('a sales invoice of 500 item lines on one ledger line posts and alters through HTTP within the posting budget, measured against the same invoice without items', async t => {
  const size = Buffer.byteLength(JSON.stringify(body(true, 1)));
  t.diagnostic(`request body: ${(size / 1024).toFixed(0)} KB of the 256 KB limit`);
  assert.ok(size < 256 * 1024);
  const timings: Record<string, number[]> = {};
  for (let round = 0; round < 3; round += 1) {
    for (const withItems of [false, true]) {
      const label = withItems ? '500 items' : 'no items';
      let started = performance.now();
      const posted = await owner.browser.call(`/api/companies/${companyId}/vouchers`, body(withItems, 1));
      const post = performance.now() - started;
      assert.equal(posted.status, 201, JSON.stringify(posted.body).slice(0, 300));
      started = performance.now();
      const altered = await owner.browser.call(`/api/companies/${companyId}/vouchers/${posted.body.voucher.id}`, alterBody(posted.body.voucher.revision, withItems, 2));
      const alter = performance.now() - started;
      assert.equal(altered.status, 200, JSON.stringify(altered.body).slice(0, 300));
      if (withItems) assert.equal(altered.body.voucher.inventory.length, items);
      (timings[`${label} post`] ??= []).push(post);
      (timings[`${label} alter`] ??= []).push(alter);
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[1];
  for (const [label, values] of Object.entries(timings)) t.diagnostic(`${label}: median ${median(values).toFixed(0)} ms (${values.map(value => value.toFixed(0)).join(', ')})`);
  assert.ok(median(timings['500 items post']) < 5000, 'the post stays well inside the 10-second statement budget');
  assert.ok(median(timings['500 items alter']) < 5000, 'the alter stays well inside the 10-second statement budget');
});

type Counters = { items: number; itemsSequential: number; vouchers: number };
const counters = async (client: PoolClient): Promise<Counters> => {
  const { rows } = await client.query<{ relname: string; seq_tup_read: string; idx_tup_fetch: string }>(
    "SELECT relname, seq_tup_read, idx_tup_fetch FROM pg_stat_xact_user_tables WHERE relname IN ('inventory_line', 'voucher')");
  const of = (name: string) => rows.find(row => row.relname === name)!;
  return { items: Number(of('inventory_line').idx_tup_fetch), itemsSequential: Number(of('inventory_line').seq_tup_read), vouchers: Number(of('voucher').idx_tup_fetch) };
};

test('the rows the checks fetch for 500 items on one line, beside 5,000 vouchers with 20,000 item rows, with no statistics and then analysed: about n x n item rows, a few voucher rows a row, never a sequential read', async t => {
  // Statistics come only from the ANALYZE below: autovacuum is off for the two tables, so the plans cannot flip
  // mid-test. The tables are large enough that an index must win: on a one-page voucher table the planner may take any
  // index led by company_id and read the whole page for each lookup.
  await asAdmin(database.adminUrl, async admin => {
    await admin.query('ALTER TABLE inventory_line SET (autovacuum_enabled = false)');
    await admin.query('ALTER TABLE voucher SET (autovacuum_enabled = false)');
    await admin.query('BEGIN');
    await admin.query("SELECT set_config('app.company_ids', $1, true)", [companyId]);
    const journal = books.type('stock_journal');
    const series = (await admin.query('SELECT numbering_series FROM voucher_type WHERE id = $1', [journal])).rows[0].numbering_series;
    await admin.query(`INSERT INTO voucher (company_id, voucher_type_id, series, date, status, idempotency_key, request_hash, created_by)
      SELECT $1, $2, $3, '2026-03-01', 'optional', 'bulk-key-' || n, $4, $5 FROM generate_series(1, 5000) n`, [companyId, journal, series, 'a'.repeat(64), owner.userId]);
    await admin.query(`INSERT INTO inventory_line (company_id, voucher_id, entry_no, item_id, location_id, direction, quantity, rate, amount)
      SELECT $1, v.id, n, $2, $3, 'in', 1, 1, 100 FROM voucher v CROSS JOIN generate_series(1, 4) n WHERE v.company_id = $1 AND v.idempotency_key LIKE 'bulk-key-%'`, [companyId, ids.item, ids.main]);
    await admin.query('COMMIT');
  });
  // The per-row check reads its own line's n rows (n x n); the per-voucher check counts the voucher's rows on each of
  // its firings and re-reads them on the voucher's updates; the voucher read returns them once.
  const bound = (factor: number) => factor * items * items + 12 * items;
  for (const tables of ['no statistics', 'analysed'] as const) {
    if (tables === 'analysed') await asAdmin(database.adminUrl, admin => admin.query('ANALYZE inventory_line; ANALYZE voucher; ANALYZE voucher_line'));
    else assert.equal(Number((await asAdmin(database.adminUrl, admin => admin.query("SELECT count(*) FROM pg_stats WHERE tablename IN ('inventory_line', 'voucher')"))).rows[0].count), 0, 'no statistics yet');
    for (const step of ['post', 'alter'] as const) {
      await inCompany(owner.userId, companyId, async context => {
        let voucherId = '', revision = 0;
        if (step === 'alter') {
          const created = await createVoucher(context, body(true, 1));
          await context.client.query('SET CONSTRAINTS ALL IMMEDIATE');
          await context.client.query('SET CONSTRAINTS ALL DEFERRED');
          voucherId = created.voucher.id; revision = created.voucher.revision;
        }
        const start = await counters(context.client), started = performance.now();
        if (step === 'post') voucherId = (await createVoucher(context, body(true, 1))).voucher.id;
        else await alterVoucher(context, voucherId, alterBody(revision, true, 2));
        await context.client.query('SET CONSTRAINTS ALL IMMEDIATE');
        const end = await counters(context.client), elapsed = performance.now() - started;
        const fetched = { items: end.items - start.items, sequential: end.itemsSequential - start.itemsSequential, vouchers: end.vouchers - start.vouchers };
        t.diagnostic(`${tables}, ${step}: ${fetched.items} item-row fetches (${(fetched.items / (items * items)).toFixed(2)} x n x n), ${fetched.sequential} read sequentially, ${fetched.vouchers} voucher-row fetches, ${elapsed.toFixed(0)} ms`);
        assert.equal(fetched.sequential, 0, `${tables}, ${step}: no sequential read`);
        assert.ok(fetched.items <= bound(step === 'post' ? 1 : 2), `${tables}, ${step}: ${fetched.items} fetches, bound ${bound(step === 'post' ? 1 : 2)}`);
        // Per row: its status (the guard), its foreign key and its kind with the check's lock: one primary-key fetch
        // each once the table has statistics. Without them, under the forced policy, a lookup by (company_id, id) takes
        // voucher_number_key on company_id alone and reads every voucher of the company (5,000 here): a planner artefact
        // of every voucher lookup (0004's line guard too) until autoanalyze, recorded, not asserted.
        if (tables === 'analysed') assert.ok(fetched.vouchers <= 6 * items, `${tables}, ${step}: ${fetched.vouchers} voucher fetches`);
        assert.equal((await readVoucher(context, voucherId)).inventory.length, items);
      }, 'write');
    }
  }
});

test('an alter that replaces a stock journal of 500 rows: the delete check locks the voucher row, one primary-key fetch a row', async t => {
  const rows = (rate: number) => Array.from({ length: items }, (_, index) => ({ itemId: ids.item, locationId: ids.main, quantity: '1', rate: rate.toFixed(2), direction: index % 2 ? 'in' : 'out' }));
  await inCompany(owner.userId, companyId, async context => {
    const created = await createVoucher(context, { idempotencyKey: `journal-${randomUUID()}`, voucherTypeId: books.type('stock_journal'), date: '2026-02-10', lines: [], inventory: rows(1) });
    await context.client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await context.client.query('SET CONSTRAINTS ALL DEFERRED');
    const read = async (table: string) => (await context.client.query<{ idx_tup_fetch: string; seq_tup_read: string }>(
      'SELECT idx_tup_fetch, seq_tup_read FROM pg_stat_xact_user_tables WHERE relname = $1', [table])).rows[0];
    const [lines, vouchers] = [await read('inventory_line'), await read('voucher')];
    const started = performance.now();
    await alterVoucher(context, created.voucher.id, { date: '2026-02-10', narration: null, status: 'regular', postDated: false, reference: null, referenceDate: null, lines: [], inventory: rows(2), revision: created.voucher.revision });
    await context.client.query('SET CONSTRAINTS ALL IMMEDIATE');
    const elapsed = performance.now() - started;
    const [linesAfter, vouchersAfter] = [await read('inventory_line'), await read('voucher')];
    const fetched = { items: Number(linesAfter.idx_tup_fetch) - Number(lines.idx_tup_fetch), vouchers: Number(vouchersAfter.idx_tup_fetch) - Number(vouchers.idx_tup_fetch) };
    t.diagnostic(`stock journal alter of ${items} rows: ${fetched.items} item-row and ${fetched.vouchers} voucher-row fetches, ${elapsed.toFixed(0)} ms`);
    assert.equal(Number(linesAfter.seq_tup_read) - Number(lines.seq_tup_read), 0);
    // Per deleted row: its status and its kind with the check's lock; per inserted row: its status, its key and its kind;
    // one primary-key fetch each, beside 5,000 other vouchers whose statistics the test before this one took.
    assert.ok(fetched.vouchers <= 8 * items, `voucher fetches ${fetched.vouchers}`);
    assert.ok(elapsed < 5000, `${elapsed} ms`);
  }, 'write');
});
