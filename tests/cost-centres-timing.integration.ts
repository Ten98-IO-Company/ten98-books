import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { PoolClient } from 'pg';
import { alterVoucher, createVoucher, readVoucher } from '../src/server/ledger/vouchers.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, inCompany, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * The cost of the per-line check (M2a slice 2): a 500-line voucher with a row in each of two categories on every line
 * (1,000 rows), posted and altered, timed against the same voucher without rows on the same run; and the proof that
 * each deferred check reads only its own line's rows (the backend's own table counters for the transaction).
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let companyId = '';
let books: Chart;
const ids = { rent: '', sales: '', showroom: '', north: '' };

before(async () => {
  database = await freshDatabase('cost_timing');
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, { name: 'Cost Timing' });
  books = await chart(owner.browser, companyId);
  const call = async (path: string, body: unknown, key: string) => {
    const answer = await owner.browser.call(`/api/companies/${companyId}${path}`, body);
    assert.equal(answer.status === 200 || answer.status === 201, true, JSON.stringify(answer.body));
    return answer.body[key].id as string;
  };
  assert.equal((await owner.browser.call(`/api/companies/${companyId}/cost-centres-setting`, { enabled: true })).status, 200);
  ids.rent = await call('/ledgers', { name: 'Rent', groupId: books.group('indirect_expenses') }, 'ledger');
  ids.sales = await call('/ledgers', { name: 'Sales', groupId: books.group('sales') }, 'ledger');
  ids.showroom = await call('/cost-centres', { name: 'Showroom', categoryId: await call('/cost-categories', { name: 'Channel' }, 'costCategory') }, 'costCentre');
  ids.north = await call('/cost-centres', { name: 'P-North', categoryId: await call('/cost-categories', { name: 'Projects' }, 'costCategory') }, 'costCentre');
});
after(async () => { await database?.drop(); });

const lines = (withRows: boolean, amount = '1.00') => Array.from({ length: 500 }, (_, index) => ({
  ledgerId: index % 2 ? ids.sales : ids.rent, side: index % 2 ? 'Cr' : 'Dr', amount,
  ...(withRows ? { costAllocations: [{ costCentreId: ids.showroom, amount }, { costCentreId: ids.north, amount }] } : {}),
}));
const body = (withRows: boolean) => ({ idempotencyKey: `timing-${randomUUID()}`, voucherTypeId: books.type('journal'), date: '2026-03-01', lines: lines(withRows) });
const alterBody = (revision: number, withRows: boolean) => ({ date: '2026-03-02', narration: 'Altered', status: 'regular', postDated: false, reference: null, referenceDate: null,
  revision, lines: lines(withRows, '2.00') });

type Counters = { seq_scan: number; seq_tup_read: number; idx_scan: number; idx_tup_fetch: number };
/** This transaction's own counters for cost_allocation so far. */
const counters = async (client: PoolClient): Promise<Counters> => {
  const { rows } = await client.query<Record<keyof Counters, string>>(
    "SELECT seq_scan, seq_tup_read, idx_scan, idx_tup_fetch FROM pg_stat_xact_user_tables WHERE relname = 'cost_allocation'");
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)])) as Counters;
};
const delta = (after: Counters, before: Counters) => Object.fromEntries(Object.keys(after).map(key => [key, after[key as keyof Counters] - before[key as keyof Counters]])) as Counters;

test('each deferred check reads only its own line\'s rows: 1,000 checks fetch 2,000 rows by index and scan nothing, on post and on alter, with and without table statistics', async t => {
  for (const tables of ['without statistics', 'analysed'] as const) {
  if (tables === 'analysed') await asAdmin(database.adminUrl, admin => admin.query('ANALYZE cost_allocation'));
  await inCompany(owner.userId, companyId, async context => {
    const posted = await createVoucher(context, body(true));
    let start = await counters(context.client);
    let started = performance.now();
    await context.client.query('SET CONSTRAINTS ALL IMMEDIATE');
    t.diagnostic(`${tables}: the deferred checks of the post (500 lines, 1,000 cost rows): ${(performance.now() - started).toFixed(0)} ms`);
    const post = delta(await counters(context.client), start);
    // One check per inserted row, each fetching that line's two rows through cost_allocation_line_idx.
    assert.deepEqual([post.seq_tup_read, post.idx_scan, post.idx_tup_fetch], [0, 1000, 2000], `${tables}: ${JSON.stringify(post)}`);
    await context.client.query('SET CONSTRAINTS ALL DEFERRED');

    await alterVoucher(context, posted.voucher.id, alterBody((await readVoucher(context, posted.voucher.id)).revision, true));
    start = await counters(context.client);
    started = performance.now();
    await context.client.query('SET CONSTRAINTS ALL IMMEDIATE');
    t.diagnostic(`${tables}: the deferred checks of the alter (2,000 cost row changes): ${(performance.now() - started).toFixed(0)} ms`);
    const alter = delta(await counters(context.client), start);
    // 1,000 rows went with the replaced lines and 1,000 came with the new ones: 2,000 checks, still two rows each.
    assert.deepEqual([alter.seq_tup_read, alter.idx_scan, alter.idx_tup_fetch], [0, 2000, 4000], `${tables}: ${JSON.stringify(alter)}`);
  }, 'write');
  }
});

test('a 500-line voucher with 1,000 cost rows posts and alters within the posting budget, measured against the same voucher without rows', async t => {
  const timings: Record<string, number[]> = {};
  for (let round = 0; round < 3; round += 1) {
    for (const withRows of [false, true]) {
      const label = withRows ? '1,000 rows' : 'no rows';
      let started = performance.now();
      const posted = await owner.browser.call(`/api/companies/${companyId}/vouchers`, body(withRows));
      const post = performance.now() - started;
      assert.equal(posted.status, 201, JSON.stringify(posted.body).slice(0, 300));
      started = performance.now();
      const altered = await owner.browser.call(`/api/companies/${companyId}/vouchers/${posted.body.voucher.id}`, alterBody(posted.body.voucher.revision, withRows));
      const alter = performance.now() - started;
      assert.equal(altered.status, 200, JSON.stringify(altered.body).slice(0, 300));
      if (withRows) assert.equal(altered.body.voucher.lines[499].costAllocations.length, 2);
      (timings[`${label} post`] ??= []).push(post);
      (timings[`${label} alter`] ??= []).push(alter);
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[1];
  for (const [label, values] of Object.entries(timings)) t.diagnostic(`${label}: median ${median(values).toFixed(0)} ms (${values.map(value => value.toFixed(0)).join(', ')})`);
  // The posting statement budget is the pool's 10 seconds; stay well inside it.
  assert.ok(median(timings['1,000 rows alter']) < 5000, 'the alter with 1,000 rows stays well inside the 10-second statement budget');
});
