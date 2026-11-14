import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { PoolClient } from 'pg';
import { createLedger } from '../../src/server/ledger/masters.ts';
import { createVoucher } from '../../src/server/ledger/vouchers.ts';
import { billsOutstandingReport } from '../../src/server/reports/bills.ts';
import type { TestDatabase } from './database.ts';
import { asAdmin, chart, createCompany, inCompany, type Member } from './ledger.ts';

/**
 * The bill-page fixture: another company with 1,500 bills (15 parties of 100), then a company whose party "M Many Bills"
 * holds 300 bills between two parties with two each. Autovacuum is off on bill and bill_allocation in this database, so
 * the statistics are exactly the ones a test sets (`afterNeighbour` runs once the other company's bills are posted).
 */
export async function billPagesFixture(owner: Member, database: TestDatabase, afterNeighbour?: string): Promise<string> {
  await asAdmin(database.adminUrl, admin => admin.query('ALTER TABLE bill SET (autovacuum_enabled = false); ALTER TABLE bill_allocation SET (autovacuum_enabled = false)'));
  const post = async (companyId: string, type: string, sales: string, parties: { id: string; prefix: string }[], perLine: number) => {
    const lines = parties.flatMap(party => [
      { ledgerId: party.id, side: 'Dr', amount: String(perLine), bills: Array.from({ length: perLine }, (_, index) => ({ kind: 'new_ref', name: `${party.prefix}-${String(index).padStart(3, '0')}`, amount: '1.00' })) },
      { ledgerId: sales, side: 'Cr', amount: String(perLine) }]);
    await inCompany(owner.userId, companyId, context => createVoucher(context, { idempotencyKey: `page-${randomUUID()}`, voucherTypeId: type, date: '2026-01-15', lines }), 'write');
  };
  const other = await createCompany(owner.browser, { name: 'Bill Page Neighbour' });
  const otherBooks = await chart(owner.browser, other);
  const otherLedgers = await inCompany(owner.userId, other, async context => ({
    sales: (await createLedger(context, { name: 'Sales', groupId: otherBooks.group('sales') })).id,
    parties: await Promise.all(Array.from({ length: 15 }, async (_, index) => ({ id: (await createLedger(context, { name: `Other ${index}`, groupId: otherBooks.group('receivables') })).id, prefix: `X${index}` }))),
  }), 'write');
  for (let block = 0; block < 3; block += 1) await post(other, otherBooks.type('journal'), otherLedgers.sales, otherLedgers.parties.slice(block * 5, block * 5 + 5), 100);
  if (afterNeighbour) await asAdmin(database.adminUrl, admin => admin.query(afterNeighbour));
  const pageCompany = await createCompany(owner.browser, { name: 'Bill Pages' });
  const books = await chart(owner.browser, pageCompany);
  const ledgers = await inCompany(owner.userId, pageCompany, async context => ({
    sales: (await createLedger(context, { name: 'Sales', groupId: books.group('sales') })).id,
    first: (await createLedger(context, { name: 'A Party', groupId: books.group('receivables') })).id,
    many: (await createLedger(context, { name: 'M Many Bills', groupId: books.group('receivables') })).id,
    last: (await createLedger(context, { name: 'Z Party', groupId: books.group('receivables') })).id,
  }), 'write');
  await post(pageCompany, books.type('journal'), ledgers.sales, [{ id: ledgers.first, prefix: 'A' }, { id: ledgers.last, prefix: 'Z' }], 2);
  await post(pageCompany, books.type('journal'), ledgers.sales, [0, 1, 2].map(block => ({ id: ledgers.many, prefix: `M${block}` })), 100);
  return pageCompany;
}

type Counters = { seq_tup_read: number; idx_tup_fetch: number };
const counters = async (client: PoolClient, table: string): Promise<Counters> => {
  const { rows } = await client.query<Record<keyof Counters, string>>('SELECT seq_tup_read, idx_tup_fetch FROM pg_stat_xact_user_tables WHERE relname = $1', [table]);
  return { seq_tup_read: Number(rows[0].seq_tup_read), idx_tup_fetch: Number(rows[0].idx_tup_fetch) };
};
const read = (after: Counters, before: Counters) => after.seq_tup_read - before.seq_tup_read + after.idx_tup_fetch - before.idx_tup_fetch;

/**
 * Reads the second page (three bills) of bills receivable and asserts the bills and bill rows read stay within `bound`,
 * from the transaction's own table counters. No planner setting is changed.
 */
export async function assertPageReads(t: TestContext, owner: Member, database: TestDatabase, pageCompany: string, state: string, analyse: string | null, bound: number): Promise<void> {
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
