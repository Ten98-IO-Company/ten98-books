import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { PoolClient } from 'pg';
import { createLedger } from '../src/server/ledger/masters.ts';
import { alterVoucher, createVoucher, readVoucher } from '../src/server/ledger/vouchers.ts';
import { billsOutstandingReport } from '../src/server/reports/bills.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, inCompany, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * The cost of the bill checks at commit (migration 0009): a 500-line voucher with 250 new bills, posted and altered,
 * timed against the same voucher without bills on the same run; and the proof, from the transaction's own table
 * counters, that each deferred bill check reads only its own line's rows or its own bill's rows, on a fresh table and
 * an analysed one.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let companyId = '';
let books: Chart;
let sales = '';
const parties: string[] = [];
let second = { companyId: '', books: undefined as unknown as Chart, sales: '', parties: [] as string[] };

before(async () => {
  database = await freshDatabase('bills_timing');
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, { name: 'Bill Timing' });
  books = await chart(owner.browser, companyId);
  await inCompany(owner.userId, companyId, async context => {
    sales = (await createLedger(context, { name: 'Sales', groupId: books.group('sales') })).id;
    for (let index = 0; index < 250; index += 1) parties.push((await createLedger(context, { name: `Party ${index}`, groupId: books.group('receivables') })).id);
  }, 'write');
  const otherId = await createCompany(owner.browser, { name: 'Bill Timing Neighbour' });
  const otherBooks = await chart(owner.browser, otherId);
  second = { companyId: otherId, books: otherBooks, sales: '', parties: [] };
  await inCompany(owner.userId, otherId, async context => {
    second.sales = (await createLedger(context, { name: 'Sales', groupId: otherBooks.group('sales') })).id;
    for (let index = 0; index < 50; index += 1) second.parties.push((await createLedger(context, { name: `Party ${index}`, groupId: otherBooks.group('receivables') })).id);
  }, 'write');
});
after(async () => { await database?.drop(); });

const lines = (withBills: boolean, tag: string, amount = '1.00') => parties.flatMap((party, index) => [
  { ledgerId: party, side: 'Dr', amount, ...(withBills ? { bills: [{ kind: 'new_ref', name: `${tag}-${index}`, amount }] } : {}) },
  { ledgerId: sales, side: 'Cr', amount }]);
const body = (withBills: boolean, tag: string) => ({ idempotencyKey: `timing-${randomUUID()}`, voucherTypeId: books.type('journal'), date: '2026-03-01', lines: lines(withBills, tag) });
const alterBody = (revision: number, withBills: boolean, tag: string) => ({ date: '2026-03-02', narration: 'Altered', status: 'regular', postDated: false, reference: null,
  referenceDate: null, revision, lines: lines(withBills, tag, '2.00') });

type Counters = { seq_tup_read: number; idx_scan: number; idx_tup_fetch: number };
const counters = async (client: PoolClient, table = 'bill_allocation'): Promise<Counters> => {
  const { rows } = await client.query<Record<keyof Counters, string>>(
    'SELECT seq_tup_read, idx_scan, idx_tup_fetch FROM pg_stat_xact_user_tables WHERE relname = $1', [table]);
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)])) as Counters;
};
const delta = (after: Counters, before: Counters) => Object.fromEntries(Object.keys(after).map(key => [key, after[key as keyof Counters] - before[key as keyof Counters]])) as Counters;

test('each deferred bill check reads only its own line\'s or bill\'s rows, with and without table statistics', async t => {
  for (const tables of ['without statistics', 'analysed'] as const) {
    if (tables === 'analysed') await asAdmin(database.adminUrl, admin => admin.query('ANALYZE bill_allocation'));
    await inCompany(owner.userId, companyId, async context => {
      const posted = await createVoucher(context, body(true, `${tables}-P`));
      let start = await counters(context.client);
      let started = performance.now();
      await context.client.query('SET CONSTRAINTS ALL IMMEDIATE');
      t.diagnostic(`${tables}: the deferred bill checks of the post (250 bills): ${(performance.now() - started).toFixed(0)} ms`);
      const post = delta(await counters(context.client), start);
      // 250 line checks and 250 used-bill checks, each reading one row through an index led by the line or the bill.
      assert.equal(post.seq_tup_read, 0, `${tables}: ${JSON.stringify(post)}`);
      assert.equal(post.idx_scan, 500, `${tables}: ${JSON.stringify(post)}`);
      assert.ok(post.idx_tup_fetch <= 500, `${tables}: ${JSON.stringify(post)}`);
      await context.client.query('SET CONSTRAINTS ALL DEFERRED');

      await alterVoucher(context, posted.voucher.id, alterBody((await readVoucher(context, posted.voucher.id)).revision, true, `${tables}-P`));
      start = await counters(context.client);
      started = performance.now();
      await context.client.query('SET CONSTRAINTS ALL IMMEDIATE');
      t.diagnostic(`${tables}: the deferred bill checks of the alter (500 bill row changes): ${(performance.now() - started).toFixed(0)} ms`);
      const alter = delta(await counters(context.client), start);
      // 250 rows went with the replaced lines and 250 came with the new ones, on the same bills: 500 line checks.
      assert.equal(alter.seq_tup_read, 0, `${tables}: ${JSON.stringify(alter)}`);
      assert.equal(alter.idx_scan, 500, `${tables}: ${JSON.stringify(alter)}`);
      assert.ok(alter.idx_tup_fetch <= 500, `${tables}: ${JSON.stringify(alter)}`);
    }, 'write');
    // A second company posting into the same table, which already holds the first company's rows: its checks read its own.
    await inCompany(owner.userId, second.companyId, async context => {
      await createVoucher(context, { idempotencyKey: `timing-${randomUUID()}`, voucherTypeId: second.books.type('journal'), date: '2026-03-01',
        lines: second.parties.flatMap((party, index) => [{ ledgerId: party, side: 'Dr', amount: '1.00', bills: [{ kind: 'new_ref', name: `${tables}-N-${index}`, amount: '1.00' }] },
          { ledgerId: second.sales, side: 'Cr', amount: '1.00' }]) });
      const start = await counters(context.client);
      await context.client.query('SET CONSTRAINTS ALL IMMEDIATE');
      const post = delta(await counters(context.client), start);
      assert.deepEqual([post.seq_tup_read, post.idx_scan], [0, 100], `second company, ${tables}: ${JSON.stringify(post)}`);
      assert.ok(post.idx_tup_fetch <= 100, `second company, ${tables}: ${JSON.stringify(post)}`);
    }, 'write');
  }
});

test('a 500-line voucher with 250 bills posts and alters within the posting budget, measured against the same voucher without bills', async t => {
  const timings: Record<string, number[]> = {};
  for (let round = 0; round < 3; round += 1) {
    for (const withBills of [false, true]) {
      const label = withBills ? '250 bills' : 'no bills', tag = `R${round}`;
      let started = performance.now();
      const posted = await owner.browser.call(`/api/companies/${companyId}/vouchers`, body(withBills, tag));
      const post = performance.now() - started;
      assert.equal(posted.status, 201, JSON.stringify(posted.body).slice(0, 300));
      started = performance.now();
      const altered = await owner.browser.call(`/api/companies/${companyId}/vouchers/${posted.body.voucher.id}`, alterBody(posted.body.voucher.revision, withBills, tag));
      const alter = performance.now() - started;
      assert.equal(altered.status, 200, JSON.stringify(altered.body).slice(0, 300));
      (timings[`${label} post`] ??= []).push(post);
      (timings[`${label} alter`] ??= []).push(alter);
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[1];
  for (const [label, values] of Object.entries(timings)) t.diagnostic(`${label}: median ${median(values).toFixed(0)} ms (${values.map(value => value.toFixed(0)).join(', ')})`);
  assert.ok(median(timings['250 bills alter']) < 5000, 'the alter with 250 bills stays well inside the 10-second statement budget');
});

test('one page of a party with 300 bills reads its own bills through the identity index, not the party\'s 300', async () => {
  const pageCompany = await createCompany(owner.browser, { name: 'Bill Pages' });
  const pageBooks = await chart(owner.browser, pageCompany);
  const [party, pageSales] = await inCompany(owner.userId, pageCompany, async context => [
    await createLedger(context, { name: 'Many Bills', groupId: pageBooks.group('receivables') }), await createLedger(context, { name: 'Sales', groupId: pageBooks.group('sales') })], 'write');
  // Three lines of 100 bills each (a line takes at most 100 rows).
  const body = { idempotencyKey: `many-${randomUUID()}`, voucherTypeId: pageBooks.type('journal'), date: '2026-01-15', lines: [0, 1, 2].flatMap(block => [
    { ledgerId: party.id, side: 'Dr', amount: '100.00', bills: Array.from({ length: 100 }, (_, index) => ({ kind: 'new_ref', name: `M-${String(block * 100 + index).padStart(3, '0')}`, amount: '1.00' })) },
    { ledgerId: pageSales.id, side: 'Cr', amount: '100.00' }]) };
  await inCompany(owner.userId, pageCompany, context => createVoucher(context, body), 'write');
  // A party with hundreds of bills lives in analysed tables (autovacuum analyses after such inserts); without statistics
  // the pending sums may still pick another index (LEDGER.md, "Known limits").
  await asAdmin(database.adminUrl, admin => admin.query('ANALYZE bill, bill_allocation, voucher'));
  await inCompany(owner.userId, pageCompany, async context => {
    const first = await billsOutstandingReport(context, { side: 'receivable', asOf: '2026-01-31', limit: '3' });
    assert.deepEqual(first.bills.map(bill => bill.name), ['M-000', 'M-001', 'M-002']);
    // At 300 bills a sequential scan is the cheaper plan; with it off, as for a party whose bills outgrow it, the page is
    // served in key order from the identity index (before 0009 its collation made that impossible: the order needed a
    // sort of every bill of the party).
    await context.client.query('SET LOCAL enable_seqscan = off');
    const start = await counters(context.client, 'bill'), rowsStart = await counters(context.client);
    const page = await billsOutstandingReport(context, { side: 'receivable', asOf: '2026-01-31', limit: '3', after: first.next! });
    const read = delta(await counters(context.client, 'bill'), start), rows = delta(await counters(context.client), rowsStart);
    assert.deepEqual(page.bills.map(bill => bill.name), ['M-003', 'M-004', 'M-005']);
    // The page and its look-ahead row in key order, the list's party probe and the three bills' details by id: a few dozen, never 300.
    assert.equal(read.seq_tup_read, 0, JSON.stringify(read));
    assert.ok(read.idx_tup_fetch <= 30, JSON.stringify(read));
    assert.equal(rows.seq_tup_read, 0, JSON.stringify(rows));
    assert.ok(rows.idx_tup_fetch <= 30, `bill rows: ${JSON.stringify(rows)}`);
  });
});
