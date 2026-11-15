import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { PoolClient } from 'pg';
import { alterVoucher, createVoucher, readVoucher } from '../src/server/ledger/vouchers.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { chart, createCompany, inCompany, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

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

type Counters = { seq_tup_read: number; idx_tup_fetch: number };
const counters = async (client: PoolClient): Promise<Counters> => {
  const { rows } = await client.query<Record<keyof Counters, string>>("SELECT seq_tup_read, idx_tup_fetch FROM pg_stat_xact_user_tables WHERE relname = 'inventory_line'");
  return { seq_tup_read: Number(rows[0].seq_tup_read), idx_tup_fetch: Number(rows[0].idx_tup_fetch) };
};

test('the item rows the checks fetch for 500 items on one line: about n x n at post and at alter, and never a sequential read', async t => {
  // The per-row check reads its own line's n rows (n x n); the per-voucher check counts the voucher's rows on each of its
  // firings, and re-reads them on the voucher's updates; the voucher read returns them once.
  const bound = (factor: number) => factor * items * items + 12 * items;
  for (const step of ['post', 'alter'] as const) {
    await inCompany(owner.userId, companyId, async context => {
      let voucherId = '', revision = 0;
      if (step === 'alter') {
        const created = await createVoucher(context, body(true, 1));
        await context.client.query('SET CONSTRAINTS ALL IMMEDIATE');
        await context.client.query('SET CONSTRAINTS ALL DEFERRED');
        voucherId = created.voucher.id; revision = created.voucher.revision;
      }
      const start = await counters(context.client);
      if (step === 'post') voucherId = (await createVoucher(context, body(true, 1))).voucher.id;
      else await alterVoucher(context, voucherId, alterBody(revision, true, 2));
      await context.client.query('SET CONSTRAINTS ALL IMMEDIATE');
      const end = await counters(context.client);
      const fetched = end.idx_tup_fetch - start.idx_tup_fetch;
      t.diagnostic(`${step}: ${fetched} item-row fetches (${(fetched / (items * items)).toFixed(2)} x n x n), ${end.seq_tup_read - start.seq_tup_read} read sequentially`);
      assert.equal(end.seq_tup_read - start.seq_tup_read, 0, `${step}: no sequential read`);
      assert.ok(fetched <= bound(step === 'post' ? 1 : 2), `${step}: ${fetched} fetches, bound ${bound(step === 'post' ? 1 : 2)}`);
      assert.equal((await readVoucher(context, voucherId)).inventory.length, items);
    }, 'write');
  }
});

test('an alter that replaces a stock journal of 500 rows: each deleted row\'s check locks the voucher again, which the alter already holds', async t => {
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
    // Measured: 27,063 voucher-row fetches with the lock taken for every deleted row (2,507 without it): locking again a
    // row this transaction already holds costs about 49 fetches a row, about 130 ms for 500 rows. Inside the budget, so
    // the lock is taken unconditionally.
    assert.ok(fetched.vouchers <= 60 * items, `voucher fetches ${fetched.vouchers}`);
    assert.ok(elapsed < 5000, `${elapsed} ms`);
  }, 'write');
});
