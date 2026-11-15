import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { addLedger, chart, createCompany, post, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * Statements with opening stock and no valuation yet (M2b slice a; docs/REPORTS.md, "Stock"): the trial balance's
 * "Opening stock" row inside current assets, the opening difference that counts it, the profit and loss's opening and
 * closing stock (equal, so profit is unchanged), and the balance sheet's closing stock, in the first year, the second
 * year, and periods starting in February of each, which close earlier income and expense into the profit and loss row.
 * The sunrise figures of the demo seeder are checked by the demo seed tests.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let companyId = '';
let books: Chart;
const ids = { cash: '', capital: '', sales: '', purchases: '', rent: '', currentAssets: '' };

const read = async (path: string): Promise<any> => {
  const answer = await owner.browser.call(`/api/companies/${companyId}/${path}`);
  assert.equal(answer.status, 200, `${path}: ${JSON.stringify(answer.body)}`);
  return answer.body;
};
const trialBalance = async (from: string, to: string) => (await read(`reports/trial-balance?from=${from}&to=${to}`)).report;
const columns = (node: any) => [node.openingDebit, node.openingCredit, node.debit, node.credit, node.closingDebit, node.closingCredit];
const named = (report: any, name: string) => {
  const node = report.nodes.find((item: any) => item.name === name);
  assert.ok(node, `no row ${name}`);
  return node;
};
const balanced = (report: any, what: string) => {
  assert.equal(report.grandTotals.openingDebit, report.grandTotals.openingCredit, `${what}: opening columns agree`);
  assert.equal(report.grandTotals.closingDebit, report.grandTotals.closingCredit, `${what}: closing columns agree`);
};

before(async () => {
  database = await freshDatabase('stock_statements');
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, { name: 'Stocked Books' });
  books = await chart(owner.browser, companyId);
  ids.cash = books.ledger('Cash');
  ids.currentAssets = books.group('current_assets');
  // Ledger openings: cash 500.00 Dr and capital 870.00 Cr, so 370.00 Cr short until the opening stock is entered.
  const cash = await owner.browser.call(`/api/companies/${companyId}/ledgers/${ids.cash}`);
  const altered = await owner.browser.call(`/api/companies/${companyId}/ledgers/${ids.cash}`,
    { name: 'Cash', groupId: cash.body.ledger.groupId, opening: { amount: '500', side: 'Dr' }, revision: cash.body.ledger.revision });
  assert.equal(altered.status, 200, JSON.stringify(altered.body));
  ids.capital = await addLedger(owner.browser, companyId, 'Owners Capital', books.group('capital'), { amount: '870', side: 'Cr' });
  ids.sales = await addLedger(owner.browser, companyId, 'Counter Sales', books.group('sales'));
  ids.purchases = await addLedger(owner.browser, companyId, 'Goods Bought', books.group('purchases'));
  ids.rent = await addLedger(owner.browser, companyId, 'Shop Rent', books.group('indirect_expenses'));
  // Year one: sales 200.00 in January and 300.00 in March, purchases 80.00 in February, rent 40.00 in February.
  await post(owner.browser, companyId, books.type('receipt'), '2026-01-15', [[ids.sales, 'Cr', '200'], [ids.cash, 'Dr', '200']]);
  await post(owner.browser, companyId, books.type('payment'), '2026-02-10', [[ids.purchases, 'Dr', '80'], [ids.cash, 'Cr', '80']]);
  await post(owner.browser, companyId, books.type('payment'), '2026-02-20', [[ids.rent, 'Dr', '40'], [ids.cash, 'Cr', '40']]);
  await post(owner.browser, companyId, books.type('receipt'), '2026-03-05', [[ids.sales, 'Cr', '300'], [ids.cash, 'Dr', '300']]);
  // Year two: sales 50.00 in January, rent 30.00 in February.
  await post(owner.browser, companyId, books.type('receipt'), '2027-01-10', [[ids.sales, 'Cr', '50'], [ids.cash, 'Dr', '50']]);
  await post(owner.browser, companyId, books.type('payment'), '2027-02-10', [[ids.rent, 'Dr', '30'], [ids.cash, 'Cr', '30']]);
});
after(async () => { await database?.drop(); });

test('without opening stock the openings are short by its value and no stock line appears anywhere', async () => {
  const report = await trialBalance('2026-01-01', '2026-12-31');
  assert.deepEqual(report.openingDifference, { amount: '370.00', side: 'Cr' });
  assert.equal(report.nodes.some((node: any) => node.kind === 'stock'), false);
  assert.equal((await read('reports/profit-and-loss?from=2026-01-01&to=2026-12-31')).report.stock, null);
  assert.equal((await read('reports/balance-sheet?date=2026-12-31')).report.closingStock, null);
  assert.equal((await read('trial-balance?from=2026-01-01&to=2026-12-31')).trialBalance.openingStock, null);
});

test('opening stock is a debit row in current assets that closes the opening difference, in every period of both years', async () => {
  const kg = (await owner.browser.call(`/api/companies/${companyId}/stock-units`, { symbol: 'Kg', decimals: 1 })).body.stockUnit;
  const pcs = (await owner.browser.call(`/api/companies/${companyId}/stock-units`, { symbol: 'Pcs' })).body.stockUnit;
  const main = ((await read('stock-locations')).stockLocations as any[]).find(row => row.systemKey === 'main');
  const yard = (await owner.browser.call(`/api/companies/${companyId}/stock-locations`, { name: 'Yard' })).body.stockLocation;
  for (const body of [
    { name: 'Rice', unitId: kg.id, openings: [{ locationId: main.id, quantity: '100', rate: '2.50' }] },
    { name: 'Lamps', unitId: pcs.id, openings: [{ locationId: main.id, quantity: '3', value: '100.00' }, { locationId: yard.id, quantity: '1', value: '20.00' }] },
  ]) assert.equal((await owner.browser.call(`/api/companies/${companyId}/stock-items`, body)).status, 201);

  // Full years, the first February, the second year and its February: the row stays at the opening rows' value (no
  // valuation yet), the difference is zero, and both columns agree.
  // The current assets group opens with cash plus the 370.00 of stock.
  for (const [from, to, profitRow, currentAssets] of [
    ['2026-01-01', '2026-12-31', ['0.00', '0.00'], '870.00'],
    ['2026-02-01', '2026-02-28', ['0.00', '200.00'], '1070.00'], // January's sales closed into the profit and loss row
    ['2027-01-01', '2027-12-31', ['0.00', '380.00'], '1250.00'], // year one's result: 500 - 80 - 40
    ['2027-02-01', '2027-02-28', ['0.00', '430.00'], '1300.00'], // and January 2027's sales of 50
  ] as const) {
    const report = await trialBalance(from, to);
    const stock = named(report, 'Opening stock');
    assert.deepEqual([stock.kind, stock.parentKey, stock.depth], ['stock', `g:${ids.currentAssets}`, 1], `${from}: inside current assets`);
    assert.deepEqual(columns(stock), ['370.00', '0.00', '0.00', '0.00', '370.00', '0.00'], `${from}: the opening rows' value`);
    assert.deepEqual(report.openingDifference, { amount: '0.00', side: null }, `${from}: no difference`);
    assert.equal(report.difference, null);
    assert.deepEqual([named(report, 'Profit and Loss').openingDebit, named(report, 'Profit and Loss').openingCredit], profitRow, `${from}: the profit and loss row`);
    balanced(report, from);
    assert.equal(named(report, 'Current Assets').openingDebit, currentAssets, `${from}: the group counts the stock row`);
  }
  const summary = (await read(`reports/group-summary/${ids.currentAssets}?from=2026-01-01&to=2026-12-31`)).report;
  assert.deepEqual(summary.rows.map((row: any) => [row.kind, row.name]).slice(0, 1), [['stock', 'Opening stock']], 'the group summary lists it first');
  const verification = (await read('trial-balance?from=2026-01-01&to=2026-12-31')).trialBalance;
  assert.deepEqual([verification.openingStock, verification.openingDifference], ['370.00', { amount: '0.00', side: null }]);
});

test('profit and loss holds opening and closing stock in the cost of sales, equal, so gross and net profit are unchanged', async () => {
  for (const [from, to, gross, net] of [
    ['2026-01-01', '2026-12-31', '420.00', '380.00'],
    ['2026-02-01', '2026-12-31', '220.00', '180.00'],
    ['2027-01-01', '2027-12-31', '50.00', '20.00'],
  ] as const) {
    const report = (await read(`reports/profit-and-loss?from=${from}&to=${to}`)).report;
    assert.deepEqual(report.stock, { opening: '370.00', closing: '370.00' }, from);
    assert.deepEqual([report.grossProfit, report.netProfit], [gross, net], from);
    const costs = report.lines.slice(report.lines.findIndex((line: any) => line.key === 'h:trading-costs'), report.lines.findIndex((line: any) => line.key === 't:trading-costs') + 1);
    assert.deepEqual([costs[1].key, costs[1].amount, costs.at(-2).key, costs.at(-2).amount, costs.at(-1).amount],
      ['s:opening', '370.00', 's:closing', '-370.00', report.lines.find((line: any) => line.key === 'l:' + ids.purchases)?.amount ?? '0.00'], `${from}: stock nets out of the cost of sales`);
  }
});

test('the balance sheet shows closing stock in current assets and balances in both years', async () => {
  for (const [date, liabilities] of [['2026-02-28', '950.00'], ['2026-12-31', '1250.00'], ['2027-02-28', '1270.00']] as const) {
    const report = (await read(`reports/balance-sheet?date=${date}`)).report;
    const stock = report.lines.find((line: any) => line.kind === 'stock');
    assert.deepEqual([stock?.label, stock?.amount, stock?.target], ['Closing stock', '370.00', null], date);
    assert.equal(report.closingStock, '370.00');
    assert.deepEqual([report.totals.liabilities, report.totals.assets], [liabilities, liabilities], `${date}: both sides agree`);
    assert.equal(report.lines.some((line: any) => line.kind === 'difference'), false, `${date}: no opening difference line`);
  }
});
