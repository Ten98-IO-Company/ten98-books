import { after, before, test } from 'node:test';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { assertPageReads, billPagesFixture } from './helpers/bill-pages.ts';
import { setupOwner, type Member } from './helpers/ledger.ts';

/**
 * What one page of bills receivable reads when bill and bill_allocation were analysed while they held only another
 * company's bills (autovacuum running before a new company's bills arrive): the statistics say the page's company has
 * almost no bills, which made a lookup per ledger go through the primary key and read the company's bills for every
 * ledger without bills (921 for a page of three, before the party probe became a semi-join). With statistics older than
 * the company's bills a page may read up to the company's bills, never another company's or the table.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let pageCompany = '';

before(async () => {
  database = await freshDatabase('bills_page_stale');
  owner = await setupOwner();
  pageCompany = await billPagesFixture(owner, database, 'ANALYZE bill, bill_allocation');
});
after(async () => { await database?.drop(); });

test('with statistics taken before the company\'s bills arrived, a page of three still reads at most its party\'s bills', async t => {
  // The company holds 304 bills, the party 300; the table holds 1,804. Without current statistics on bill a page may read
  // the company's bills once (the parties check) and the party's bills from the cursor (LEDGER.md, "Known limits").
  const company = 304, party = 300, page = 30, unanalysed = company + party + page;
  await assertPageReads(t, owner, database, pageCompany, 'stale statistics', null, unanalysed);
  await assertPageReads(t, owner, database, pageCompany, 'stale statistics, joined tables analysed', 'ANALYZE voucher, voucher_line, ledger, account_group', unanalysed);
  await assertPageReads(t, owner, database, pageCompany, 'statistics refreshed', 'ANALYZE bill, bill_allocation', page);
});
