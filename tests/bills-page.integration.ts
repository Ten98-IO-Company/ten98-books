import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { PoolClient } from 'pg';
import { createLedger } from '../src/server/ledger/masters.ts';
import { createVoucher } from '../src/server/ledger/vouchers.ts';
import { billsOutstandingReport } from '../src/server/reports/bills.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, inCompany, setupOwner, type Member } from './helpers/ledger.ts';

/**
 * What one page of bills receivable reads: a page of three of a party with 300 bills, in a company with two more parties
 * holding bills and beside another company with 1,500 bills, measured with the transaction's own table counters in four
 * states: nothing analysed; the joined tables analysed but not bill and bill_allocation (the state CI met); bill
 * analysed only; everything analysed. No planner setting is changed. While bill has no statistics the planner reads the
 * party's bills whole (through bill_ledger_order_idx), sums their pending and sorts them: the bound is the party, never
 * the table or another company. With statistics a page reads a few dozen.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let pageCompany = '';

/** A journal of `parties` lines each carrying `perLine` new bills (a line takes at most 100), against a sales ledger. */
async function billsVoucher(companyId: string, type: string, sales: string, parties: { id: string; prefix: string }[], perLine: number) {
  const lines = parties.flatMap(party => [
    { ledgerId: party.id, side: 'Dr', amount: String(perLine), bills: Array.from({ length: perLine }, (_, index) => ({ kind: 'new_ref', name: `${party.prefix}-${String(index).padStart(3, '0')}`, amount: '1.00' })) },
    { ledgerId: sales, side: 'Cr', amount: String(perLine) }]);
  await inCompany(owner.userId, companyId, context => createVoucher(context, { idempotencyKey: `page-${randomUUID()}`, voucherTypeId: type, date: '2026-01-15', lines }), 'write');
}

before(async () => {
  database = await freshDatabase('bills_page');
  owner = await setupOwner();
  // Another company with 1,500 bills in the same tables.
  const other = await createCompany(owner.browser, { name: 'Bill Page Neighbour' });
  const otherBooks = await chart(owner.browser, other);
  const otherLedgers = await inCompany(owner.userId, other, async context => ({
    sales: (await createLedger(context, { name: 'Sales', groupId: otherBooks.group('sales') })).id,
    parties: await Promise.all(Array.from({ length: 15 }, async (_, index) => ({ id: (await createLedger(context, { name: `Other ${index}`, groupId: otherBooks.group('receivables') })).id, prefix: `X${index}` }))),
  }), 'write');
  for (let block = 0; block < 3; block += 1) await billsVoucher(other, otherBooks.type('journal'), otherLedgers.sales, otherLedgers.parties.slice(block * 5, block * 5 + 5), 100);
  // The page company: one party with 300 bills between two parties with two each.
  pageCompany = await createCompany(owner.browser, { name: 'Bill Pages' });
  const books = await chart(owner.browser, pageCompany);
  const ledgers = await inCompany(owner.userId, pageCompany, async context => ({
    sales: (await createLedger(context, { name: 'Sales', groupId: books.group('sales') })).id,
    first: (await createLedger(context, { name: 'A Party', groupId: books.group('receivables') })).id,
    many: (await createLedger(context, { name: 'M Many Bills', groupId: books.group('receivables') })).id,
    last: (await createLedger(context, { name: 'Z Party', groupId: books.group('receivables') })).id,
  }), 'write');
  await billsVoucher(pageCompany, books.type('journal'), ledgers.sales, [{ id: ledgers.first, prefix: 'A' }, { id: ledgers.last, prefix: 'Z' }], 2);
  await billsVoucher(pageCompany, books.type('journal'), ledgers.sales, [0, 1, 2].map(block => ({ id: ledgers.many, prefix: `M${block}` })), 100);
});
after(async () => { await database?.drop(); });

type Counters = { seq_tup_read: number; idx_tup_fetch: number };
const counters = async (client: PoolClient, table: string): Promise<Counters> => {
  const { rows } = await client.query<Record<keyof Counters, string>>('SELECT seq_tup_read, idx_tup_fetch FROM pg_stat_xact_user_tables WHERE relname = $1', [table]);
  return { seq_tup_read: Number(rows[0].seq_tup_read), idx_tup_fetch: Number(rows[0].idx_tup_fetch) };
};
const read = (after: Counters, before: Counters) => after.seq_tup_read - before.seq_tup_read + after.idx_tup_fetch - before.idx_tup_fetch;

test('a page of three reads at most its party\'s bills while bill has no statistics and a few dozen once it has, never the table or another company', async t => {
  // The party holds 300 bills of one row each; the table holds 1,804 bills and 1,804 bill rows.
  const party = 300, page = 30;
  const states: [string, string | null, number][] = [
    ['nothing analysed', null, party + page],
    ['joined tables analysed, bill and bill_allocation not', 'ANALYZE voucher, voucher_line, ledger, account_group', party + page],
    ['bill analysed, bill_allocation not', 'ANALYZE bill', page],
    ['everything analysed', 'ANALYZE bill_allocation', page],
  ];
  for (const [state, analyse, bound] of states) {
    if (analyse) await asAdmin(database.adminUrl, admin => admin.query(analyse));
    await inCompany(owner.userId, pageCompany, async context => {
      const first = await billsOutstandingReport(context, { side: 'receivable', asOf: '2026-01-31', limit: '5' });
      assert.deepEqual(first.bills.map(bill => bill.name), ['A-000', 'A-001', 'M0-000', 'M0-001', 'M0-002']);
      const bills = await counters(context.client, 'bill'), rows = await counters(context.client, 'bill_allocation');
      const page = await billsOutstandingReport(context, { side: 'receivable', asOf: '2026-01-31', limit: '3', after: first.next! });
      const billsRead = read(await counters(context.client, 'bill'), bills), rowsRead = read(await counters(context.client, 'bill_allocation'), rows);
      assert.deepEqual(page.bills.map(bill => bill.name), ['M0-003', 'M0-004', 'M0-005']);
      t.diagnostic(`${state}: ${billsRead} bills and ${rowsRead} bill rows read for one page of three`);
      assert.ok(billsRead <= bound, `${state}: ${billsRead} bills read, bound ${bound}`);
      assert.ok(rowsRead <= bound, `${state}: ${rowsRead} bill rows read, bound ${bound}`);
    });
  }
});
