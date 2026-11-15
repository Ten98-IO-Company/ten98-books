import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { demoRoot, listDatasetFolders, loadDataset } from '../src/server/demo/dataset.ts';
import { seedDataset } from '../src/server/demo/seed.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { addLedger, chart, createCompany, post, setupOwner, type Member } from './helpers/ledger.ts';

/**
 * The trial balance balances through the API by itself, with nothing added by the caller. The verification read
 * (`GET .../trial-balance`, whose totals the ledger form shows) counts the opening stock in its totals, so they equal the
 * statement's (`GET .../reports/trial-balance`) column for column; its rows stay ledgers, and the rows plus the opening
 * stock are the totals. Totals balance exactly when there is no opening difference; otherwise they differ by it, on its
 * side. Checked on every demo company (three hold opening stock) and on two companies whose openings do not balance.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('trial_balance_totals');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

const columns = ['openingDebit', 'openingCredit', 'debit', 'credit', 'closingDebit', 'closingCredit'] as const;
type Columns = Record<(typeof columns)[number], string>;
const pick = (amounts: Columns) => Object.fromEntries(columns.map(key => [key, amounts[key]]));
/** A wire amount in minor units: the company's amounts all carry its exponent's decimals, so the point can go. */
const minor = (amount: string) => BigInt(amount.replace('.', ''));

/** Both reads of one period, and the checks that hold for every company and period. */
async function bothReads(companyId: string, from: string, to: string, what: string) {
  const query = `from=${from}&to=${to}`;
  const statement = await owner.browser.call(`/api/companies/${companyId}/reports/trial-balance?${query}`);
  assert.equal(statement.status, 200, JSON.stringify(statement.body));
  const read = await owner.browser.call(`/api/companies/${companyId}/trial-balance?${query}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const report = statement.body.report, trial = read.body.trialBalance;
  // The rows are ledgers only, and they plus the opening stock (opening and closing debit) are the totals.
  const summed = Object.fromEntries(columns.map(key => [key, trial.rows.reduce((sum: bigint, row: Columns) => sum + minor(row[key]), 0n)]));
  if (trial.openingStock !== null) { summed.openingDebit += minor(trial.openingStock); summed.closingDebit += minor(trial.openingStock); }
  assert.deepEqual(summed, Object.fromEntries(columns.map(key => [key, minor(trial.totals[key])])), `${what}: the rows plus the opening stock are the totals`);
  // The statement's totals before its difference line are the verification read's, column for column.
  assert.deepEqual(pick(trial.totals), pick(report.totals), `${what}: the two reads' totals agree`);
  // Both carry the same stock value: the opening rows' value, in the opening and closing debit, in every period.
  const stockRows = report.nodes.filter((node: { kind: string }) => node.kind === 'stock');
  if (trial.openingStock === null) assert.equal(stockRows.length, 0, `${what}: no stock row`);
  else assert.deepEqual(stockRows.map((node: Columns & { name: string }) => [node.name, node.openingDebit, node.closingDebit]), [['Opening stock', trial.openingStock, trial.openingStock]], `${what}: one opening stock row, the same value`);
  return { trial, report };
}

const slugs = await listDatasetFolders();

for (const slug of slugs) {
  test(`${slug}: both trial balance routes balance by themselves and agree, at books beginning, over the expected period and in a later period`, async () => {
    const dataset = await loadDataset(join(demoRoot, slug));
    const { companyId } = await seedDataset(owner.userId, dataset);
    const beginning = dataset.company.booksBeginning;
    const period = dataset.expected.period;
    // A period that starts a month after the books begin and ends where the expected period does.
    const start = new Date(`${beginning}T00:00:00Z`);
    start.setUTCMonth(start.getUTCMonth() + 1, 1);
    const later = start.toISOString().slice(0, 10);
    assert.ok(beginning < later && later <= period.to, `${slug}: ${later} lies after the books begin, inside the expected period`);
    for (const [label, from, to] of [['books beginning', beginning, beginning], ['the expected period', period.from, period.to], ['a later period', later, period.to]] as const) {
      const what = `${slug} ${label}`;
      const { trial, report } = await bothReads(companyId, from, to, what);
      const grand = report.grandTotals;
      assert.deepEqual([grand.openingDebit, grand.closingDebit], [grand.openingCredit, grand.closingCredit], `${what}: the statement's totals balance`);
      assert.equal(trial.openingDifference.side, null, `${what}: no opening difference`);
      assert.deepEqual([trial.totals.openingDebit, trial.totals.closingDebit], [trial.totals.openingCredit, trial.totals.closingCredit],
        `${what}: the verification read's totals balance (opening stock ${trial.openingStock})`);
      assert.deepEqual(pick(trial.totals), pick(grand), `${what}: with no difference, the read's totals are the statement's grand totals`);
    }
  });
}

test('openings that do not balance: the totals differ by exactly the opening difference on its side, opening stock counted, in both periods', async () => {
  const cases = [
    // Capital 5,000.00 Cr against cash 1,000.00 Dr and 370.00 of stock: short 3,630.00 on the debit side, so the difference is Cr.
    { name: 'Short Debits', openings: [['Capital In', 'capital', '5000.00', 'Cr'], ['Till', 'cash_in_hand', '1000.00', 'Dr']], difference: { amount: '3630.00', side: 'Cr' } },
    // Cash 1,000.00 Dr and 370.00 of stock with nothing against them: the difference is 1,370.00 Dr.
    { name: 'Short Credits', openings: [['Till', 'cash_in_hand', '1000.00', 'Dr']], difference: { amount: '1370.00', side: 'Dr' } },
  ] as const;
  for (const item of cases) {
    const companyId = await createCompany(owner.browser, { name: item.name });
    const books = await chart(owner.browser, companyId);
    const ledgers: Record<string, string> = {};
    for (const [name, group, amount, side] of item.openings) ledgers[name] = await addLedger(owner.browser, companyId, name, books.group(group), { amount, side });
    const rent = await addLedger(owner.browser, companyId, 'Shop Rent', books.group('indirect_expenses'));
    const unit = (await owner.browser.call(`/api/companies/${companyId}/stock-units`, { symbol: 'Pcs' })).body.stockUnit;
    const main = ((await owner.browser.call(`/api/companies/${companyId}/stock-locations`)).body.stockLocations as { id: string; systemKey: string | null }[]).find(row => row.systemKey === 'main')!;
    assert.equal((await owner.browser.call(`/api/companies/${companyId}/stock-items`, { name: 'Lamps', unitId: unit.id, openings: [{ locationId: main.id, quantity: '4', value: '370.00' }] })).status, 201);
    await post(owner.browser, companyId, books.type('payment'), '2026-02-10', [[rent, 'Dr', '40'], [ledgers.Till, 'Cr', '40']]);
    for (const [label, from, to] of [['books beginning', '2026-01-01', '2026-01-01'], ['a later period', '2026-02-01', '2026-02-28']] as const) {
      const what = `${item.name} ${label}`;
      const { trial, report } = await bothReads(companyId, from, to, what);
      assert.equal(trial.openingStock, '370.00');
      assert.deepEqual(trial.openingDifference, item.difference, what);
      const [debit, credit] = item.difference.side === 'Dr' ? ['Debit', 'Credit'] : ['Credit', 'Debit'];
      for (const column of ['opening', 'closing'] as const) {
        const gap = minor(trial.totals[`${column}${debit}`]) - minor(trial.totals[`${column}${credit}`]);
        assert.equal(gap, minor(item.difference.amount), `${what}: the ${column} totals differ by the difference, on its side`);
      }
      // The statement adds the difference line on the short side, so only its grand totals balance.
      const grand = report.grandTotals;
      assert.deepEqual([grand.openingDebit, grand.closingDebit], [grand.openingCredit, grand.closingCredit], `${what}: the statement's grand totals balance`);
      assert.notEqual(report.difference, null);
    }
  }
});
