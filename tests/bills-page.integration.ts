import { after, before, test } from 'node:test';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { assertPageReads, billPagesFixture } from './helpers/bill-pages.ts';
import { setupOwner, type Member } from './helpers/ledger.ts';

/**
 * What one page of bills receivable reads (a page of three of a party with 300 bills, beside another company with 1,500
 * bills; tests/helpers/bill-pages.ts), from statistics that start empty. While bill has no statistics the planner reads
 * the party's bills whole (through bill_ledger_order_idx), sums their pending and sorts them: the bound is the party,
 * never the table or another company. With statistics a page reads a few dozen. bills-page-stale covers statistics
 * taken while the table held only the other company's bills.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let pageCompany = '';

before(async () => {
  database = await freshDatabase('bills_page');
  owner = await setupOwner();
  pageCompany = await billPagesFixture(owner, database);
});
after(async () => { await database?.drop(); });

test('a page of three reads at most its party\'s bills while bill has no statistics and a few dozen once it has, never the table or another company', async t => {
  // The party holds 300 bills of one row each; the table holds 1,804 bills and 1,804 bill rows.
  const party = 300, page = 30;
  await assertPageReads(t, owner, database, pageCompany, 'nothing analysed', null, party + page);
  await assertPageReads(t, owner, database, pageCompany, 'joined tables analysed, bill and bill_allocation not', 'ANALYZE voucher, voucher_line, ledger, account_group', party + page);
  await assertPageReads(t, owner, database, pageCompany, 'bill_allocation analysed, bill not', 'ANALYZE bill_allocation', party + page);
  await assertPageReads(t, owner, database, pageCompany, 'everything analysed', 'ANALYZE bill', page);
});
