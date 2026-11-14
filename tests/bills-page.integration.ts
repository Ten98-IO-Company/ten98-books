import { after, before, test } from 'node:test';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { assertPageReads, billPagesFixture } from './helpers/bill-pages.ts';
import { setupOwner, type Member } from './helpers/ledger.ts';

/**
 * What one page of bills receivable reads (a page of three of a party with 300 bills, beside another company with 1,500
 * bills; tests/helpers/bill-pages.ts), from statistics that start empty. Without statistics on bill a page may read up
 * to the company's bills (once for the parties check, plus the party's bills from the cursor), never another company's
 * or the table; with current statistics it reads about its own bills at any depth. bills-page-stale covers statistics
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
  // The company holds 304 bills, the party 300; the table holds 1,804. Without current statistics on bill a page may read
  // the company's bills once (the parties check) and the party's bills from the cursor (LEDGER.md, "Known limits").
  const company = 304, party = 300, page = 30, unanalysed = company + party + page;
  await assertPageReads(t, owner, database, pageCompany, 'nothing analysed', null, unanalysed);
  await assertPageReads(t, owner, database, pageCompany, 'joined tables analysed, bill and bill_allocation not', 'ANALYZE voucher, voucher_line, ledger, account_group', unanalysed);
  await assertPageReads(t, owner, database, pageCompany, 'bill_allocation analysed, bill not', 'ANALYZE bill_allocation', unanalysed);
  await assertPageReads(t, owner, database, pageCompany, 'everything analysed', 'ANALYZE bill', page);
});
