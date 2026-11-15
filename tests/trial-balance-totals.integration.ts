import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { demoRoot, listDatasetFolders, loadDataset } from '../src/server/demo/dataset.ts';
import { seedDataset } from '../src/server/demo/seed.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { setupOwner, type Member } from './helpers/ledger.ts';

/**
 * Every demo company's trial balance balances through the API by itself, with nothing added by the caller: the
 * verification read (`GET .../trial-balance`, whose totals the ledger form shows) and the statement
 * (`GET .../reports/trial-balance`), at books beginning and over the dataset's expected period. The demo companies have
 * no opening difference, so balanced totals are the whole check; a company with opening stock is the case at stake.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('trial_balance_totals');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

const slugs = await listDatasetFolders();

for (const slug of slugs) {
  test(`${slug}: both trial balance routes balance by themselves at books beginning and over the expected period`, async () => {
    const dataset = await loadDataset(join(demoRoot, slug));
    const { companyId } = await seedDataset(owner.userId, dataset);
    const beginning = dataset.company.booksBeginning;
    const period = dataset.expected.period;
    for (const [label, from, to] of [['books beginning', beginning, beginning], ['the expected period', period.from, period.to]] as const) {
      const query = `from=${from}&to=${to}`;
      const statement = await owner.browser.call(`/api/companies/${companyId}/reports/trial-balance?${query}`);
      assert.equal(statement.status, 200, JSON.stringify(statement.body));
      const grand = statement.body.report.grandTotals;
      assert.deepEqual([grand.openingDebit, grand.closingDebit], [grand.openingCredit, grand.closingCredit], `${slug} ${label}: the statement's totals balance`);
      const read = await owner.browser.call(`/api/companies/${companyId}/trial-balance?${query}`);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      const { totals, openingDifference, openingStock } = read.body.trialBalance;
      assert.equal(openingDifference.side, null, `${slug} ${label}: no opening difference`);
      assert.deepEqual([totals.openingDebit, totals.closingDebit], [totals.openingCredit, totals.closingCredit],
        `${slug} ${label}: the verification read's totals balance (opening stock ${openingStock})`);
    }
  });
}
