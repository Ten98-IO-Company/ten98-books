import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { addLedger, chart, createCompany, post, setupOwner, type Chart, type Line, type Member } from './helpers/ledger.ts';

/**
 * Report periods that start after the books begin (docs/REPORTS.md, "What counts"): income and expense ledgers open at
 * zero and everything they gathered before the period, earlier months of the same year included, stands in the profit
 * and loss ledger's row; balance-sheet ledgers keep their running balances. Each test uses a company of its own.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('reports_period');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

type Books = { id: string; books: Chart; ledger: (name: string, group: string, opening?: { amount: string; side: 'Dr' | 'Cr' }) => Promise<string>; post: (kind: string, date: string, lines: Line[]) => Promise<unknown> };
async function company(name: string, settings: Record<string, unknown> = {}): Promise<Books> {
  const id = await createCompany(owner.browser, { name, ...settings });
  const books = await chart(owner.browser, id);
  return {
    id, books,
    ledger: (ledgerName, group, opening) => addLedger(owner.browser, id, ledgerName, books.group(group), opening),
    post: (kind, date, lines) => post(owner.browser, id, books.type(kind), date, lines),
  };
}
async function read(c: Books, path: string, field = 'report'): Promise<any> {
  const answer = await owner.browser.call(`/api/companies/${c.id}/${path}`);
  assert.equal(answer.status, 200, `${path}: ${JSON.stringify(answer.body)}`);
  return answer.body[field];
}
const trialBalance = (c: Books, from: string, to: string) => read(c, `reports/trial-balance?from=${from}&to=${to}`);
const columns = (node: any) => [node.openingDebit, node.openingCredit, node.debit, node.credit, node.closingDebit, node.closingCredit];
const named = (report: any, name: string) => {
  const node = report.nodes.find((item: any) => item.name === name);
  assert.ok(node, `no row ${name}`);
  return node;
};
const balanced = (report: any) => {
  assert.equal(report.grandTotals.openingDebit, report.grandTotals.openingCredit, 'opening columns agree');
  assert.equal(report.grandTotals.closingDebit, report.grandTotals.closingCredit, 'closing columns agree');
};

test('a February trial balance starts income and expense at zero and carries January\'s result in the profit and loss row', async () => {
  const c = await company('Mid-year Books');
  const bank = await c.ledger('Harbour Bank', 'bank_accounts', { amount: '50000', side: 'Dr' });
  await c.ledger('Owners', 'capital', { amount: '50000', side: 'Cr' });
  const advisory = await c.ledger('Advisory Fees', 'sales');
  const workshops = await c.ledger('Workshop Fees', 'sales');
  const subcontract = await c.ledger('Subcontract Work', 'purchases');
  const rent = await c.ledger('Premises Rent', 'indirect_expenses');
  const pay = await c.ledger('Staff Pay', 'indirect_expenses');
  const fees = await c.ledger('Bank Fees', 'indirect_expenses');
  const profitLedger = (await chart(owner.browser, c.id)).ledger('Profit and Loss');
  // January's result: 8,000 - 2,000 - 2,500 - 5,000 = a loss of 1,500.
  await c.post('receipt', '2026-01-10', [[advisory, 'Cr', '8000'], [bank, 'Dr', '8000']]);
  await c.post('payment', '2026-01-15', [[subcontract, 'Dr', '2000'], [bank, 'Cr', '2000']]);
  await c.post('payment', '2026-01-20', [[rent, 'Dr', '2500'], [bank, 'Cr', '2500']]);
  await c.post('payment', '2026-01-31', [[pay, 'Dr', '5000'], [bank, 'Cr', '5000']]);
  await c.post('receipt', '2026-02-05', [[advisory, 'Cr', '30000'], [bank, 'Dr', '30000']]);
  await c.post('payment', '2026-02-10', [[advisory, 'Dr', '400'], [bank, 'Cr', '400']]);
  await c.post('receipt', '2026-02-12', [[workshops, 'Cr', '3000'], [bank, 'Dr', '3000']]);
  await c.post('payment', '2026-02-14', [[subcontract, 'Dr', '12000'], [bank, 'Cr', '12000']]);
  await c.post('payment', '2026-02-20', [[rent, 'Dr', '2500'], [bank, 'Cr', '2500']]);
  await c.post('payment', '2026-02-27', [[pay, 'Dr', '5200'], [bank, 'Cr', '5200']]);
  await c.post('payment', '2026-02-28', [[fees, 'Dr', '45'], [bank, 'Cr', '45']]);
  await c.post('receipt', '2026-03-03', [[advisory, 'Cr', '1000'], [bank, 'Dr', '1000']]);

  const february = await trialBalance(c, '2026-02-01', '2026-02-28');
  assert.deepEqual(columns(named(february, 'Advisory Fees')), ['0.00', '0.00', '400.00', '30000.00', '0.00', '29600.00'], 'February\'s movement only');
  assert.deepEqual(columns(named(february, 'Sales')), ['0.00', '0.00', '400.00', '33000.00', '0.00', '32600.00']);
  assert.deepEqual(columns(named(february, 'Staff Pay')), ['0.00', '0.00', '5200.00', '0.00', '5200.00', '0.00']);
  assert.deepEqual(columns(named(february, 'Profit and Loss')), ['1500.00', '0.00', '0.00', '0.00', '1500.00', '0.00'], 'January\'s loss as a debit');
  assert.deepEqual(columns(named(february, 'Harbour Bank')), ['48500.00', '0.00', '33000.00', '20145.00', '61355.00', '0.00'], 'a running balance');
  assert.deepEqual([february.grandTotals.openingDebit, february.grandTotals.closingDebit], ['50000.00', '82600.00']);
  balanced(february);

  const both = await trialBalance(c, '2026-01-01', '2026-02-28');
  assert.deepEqual(columns(named(both, 'Profit and Loss')), ['0.00', '0.00', '0.00', '0.00', '0.00', '0.00'], 'no row from the books beginning');
  assert.equal(named(both, 'Advisory Fees').closingCredit, '37600.00');
  assert.equal(named(both, 'Staff Pay').closingDebit, '10200.00');
  balanced(both);

  // The drill-downs follow: the group summary, the monthly summary and the vouchers of an income ledger open at zero.
  const sales = await read(c, `reports/group-summary/${c.books.group('sales')}?from=2026-02-01&to=2026-02-28`);
  assert.deepEqual([sales.totals.opening, sales.totals.closing], ['0.00', '-32600.00']);
  const primary = await read(c, 'reports/group-summary?from=2026-02-01&to=2026-02-28');
  assert.deepEqual([primary.totals.closingDebit, primary.totals.closingCredit], ['82600.00', '82600.00']);
  const monthly = await read(c, `reports/ledger-monthly/${advisory}?from=2026-02-01&to=2026-02-28`);
  assert.equal(monthly.opening, '0.00');
  assert.deepEqual(monthly.months.map((month: any) => [month.month, month.debit, month.credit, month.closing]), [['2026-02', '400.00', '30000.00', '-29600.00']]);
  const vouchers = await read(c, `reports/ledger-vouchers/${advisory}?from=2026-02-01&to=2026-02-28`);
  assert.deepEqual([vouchers.opening, vouchers.rows.map((row: any) => row.balance), vouchers.totals.closing], ['0.00', ['-30000.00', '-29600.00'], '-29600.00']);
  assert.equal((await read(c, `reports/ledger-vouchers/${bank}?from=2026-02-01&to=2026-02-28`)).opening, '48500.00');
  // The profit and loss row opens the profit and loss ledger, whose opening balance is the carried result.
  const carried = await read(c, `reports/ledger-monthly/${profitLedger}?from=2026-02-01&to=2026-02-28`);
  assert.deepEqual([carried.opening, carried.months.at(-1).closing], ['1500.00', '1500.00']);

  // The statements do not change: profit and loss is the period's movement, the balance sheet the year to date.
  assert.equal((await read(c, 'reports/profit-and-loss?from=2026-02-01&to=2026-02-28')).netProfit, '12855.00');
  assert.equal((await read(c, 'reports/profit-and-loss?from=2026-01-01&to=2026-02-28')).netProfit, '11355.00');
  const sheet = await read(c, 'reports/balance-sheet?date=2026-02-28');
  assert.deepEqual([sheet.profitAndLoss, sheet.totals], [{ broughtForward: '0.00', currentPeriod: '11355.00' }, { liabilities: '61355.00', assets: '61355.00' }]);

  // The single-ledger balance read is the trial balance row, so it follows the period too.
  const balance = (ledgerId: string, from: string, to: string) => read(c, `ledgers/${ledgerId}/balance?from=${from}&to=${to}`, 'balance');
  assert.deepEqual(columns(await balance(advisory, '2026-02-01', '2026-02-28')), columns(named(february, 'Advisory Fees')));
  assert.deepEqual(columns(await balance(profitLedger, '2026-02-01', '2026-02-28')), columns(named(february, 'Profit and Loss')));
  assert.equal((await balance(advisory, '2026-01-01', '2026-02-28')).closingCredit, '37600.00');
  // The balance preview while entering a voucher in March reads from the financial year's start: the year to date.
  const preview = await owner.browser.call(`/api/companies/${c.id}/vouchers/balance-preview`, { date: '2026-03-10', lines: [{ ledgerId: advisory, side: 'Cr', amount: '100' }] });
  assert.deepEqual([preview.status, preview.body], [200, { balances: [{ ledgerId: advisory, balance: '-38700.00' }] }]);
  assert.equal((await trialBalance(c, '2026-03-01', '2026-03-10')).nodes.find((node: any) => node.name === 'Advisory Fees').closingCredit, '1000.00',
    'not the March trial balance figure');

  // The export holds the row and the same totals.
  const { handleApi } = await import('../src/server/api.ts');
  const { getConfig } = await import('../src/server/config.ts');
  const headers = new Headers({ cookie: [...owner.browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ') });
  const csv = await (await handleApi(new Request(new URL(`/api/companies/${c.id}/reports/trial-balance/export?from=2026-02-01&to=2026-02-28`, getConfig().appUrl), { headers }))).text();
  assert.match(csv, /"Advisory Fees","ledger","1","0\.00","0\.00","400\.00","30000\.00","0\.00","29600\.00"\r\n/);
  assert.match(csv, /"Profit and Loss","ledger","0","1500\.00","0\.00","0\.00","0\.00","1500\.00","0\.00"\r\n/);
  assert.match(csv, /"Total","total","","50000\.00","50000\.00","53145\.00","53145\.00","82600\.00","82600\.00"\r\n$/);
});

test('in a second year the row holds the earlier years and the earlier months of the year', async () => {
  const c = await company('Second Year Books', { booksBeginning: '2025-01-01' });
  const bank = await c.ledger('Main Bank', 'bank_accounts', { amount: '1000', side: 'Dr' });
  await c.ledger('Owners', 'capital', { amount: '1000', side: 'Cr' });
  const income = await c.ledger('Service Income', 'indirect_income');
  const rent = await c.ledger('Office Rent', 'indirect_expenses');
  await c.post('receipt', '2025-06-01', [[income, 'Cr', '4000'], [bank, 'Dr', '4000']]);
  await c.post('payment', '2025-09-01', [[rent, 'Dr', '1500'], [bank, 'Cr', '1500']]);
  await c.post('receipt', '2026-01-15', [[income, 'Cr', '700'], [bank, 'Dr', '700']]);
  await c.post('payment', '2026-01-20', [[rent, 'Dr', '200'], [bank, 'Cr', '200']]);
  await c.post('receipt', '2026-02-10', [[income, 'Cr', '300'], [bank, 'Dr', '300']]);

  const february = await trialBalance(c, '2026-02-01', '2026-02-28');
  assert.deepEqual(columns(named(february, 'Profit and Loss')), ['0.00', '3000.00', '0.00', '0.00', '0.00', '3000.00'], '2,500 of 2025 and 500 of January');
  assert.deepEqual(columns(named(february, 'Service Income')), ['0.00', '0.00', '0.00', '300.00', '0.00', '300.00']);
  assert.deepEqual(columns(named(february, 'Office Rent')), ['0.00', '0.00', '0.00', '0.00', '0.00', '0.00']);
  balanced(february);
  const yearStart = await trialBalance(c, '2026-01-01', '2026-02-28');
  assert.deepEqual([named(yearStart, 'Profit and Loss').closingCredit, named(yearStart, 'Service Income').closingCredit], ['2500.00', '1000.00'], 'as before at the year start');
  // A period from the middle of 2025: the first half of 2025 is in the row, the rest accumulates across the year end.
  const across = await trialBalance(c, '2025-07-01', '2026-02-28');
  assert.deepEqual([named(across, 'Profit and Loss').openingCredit, named(across, 'Service Income').closingCredit, named(across, 'Office Rent').closingDebit], ['4000.00', '1000.00', '1700.00']);
  balanced(across);
  assert.deepEqual((await read(c, 'reports/balance-sheet?date=2026-02-28')).profitAndLoss, { broughtForward: '2500.00', currentPeriod: '800.00' });
});

test('openings on income ledgers stay on them from the books beginning and close into the row once the period starts later', async () => {
  // Books begin with the financial year.
  const c = await company('Grant Books');
  await c.ledger('Main Bank', 'bank_accounts', { amount: '600', side: 'Dr' });
  await c.ledger('Grant Income', 'indirect_income', { amount: '600', side: 'Cr' });
  const january = await trialBalance(c, '2026-01-01', '2026-01-31');
  assert.deepEqual([named(january, 'Grant Income').openingCredit, named(january, 'Profit and Loss').openingCredit], ['600.00', '0.00']);
  const february = await trialBalance(c, '2026-02-01', '2026-02-28');
  assert.deepEqual([named(february, 'Grant Income').openingCredit, named(february, 'Profit and Loss').openingCredit], ['0.00', '600.00']);
  balanced(february);
  assert.equal((await read(c, 'reports/profit-and-loss?from=2026-02-01&to=2026-02-28')).netProfit, '0.00', 'unchanged');

  // Books begin inside the year: a period starting on or before them is unchanged, a later one closes the opening.
  const late = await company('Late Books', { booksBeginning: '2026-03-01' });
  const bank = await late.ledger('Main Bank', 'bank_accounts', { amount: '300', side: 'Dr' });
  const commission = await late.ledger('Commission', 'indirect_income', { amount: '300', side: 'Cr' });
  await late.post('receipt', '2026-04-10', [[commission, 'Cr', '50'], [bank, 'Dr', '50']]);
  for (const from of ['2026-02-01', '2026-03-01']) {
    const report = await trialBalance(late, from, '2026-03-31');
    assert.deepEqual([named(report, 'Commission').openingCredit, named(report, 'Profit and Loss').openingCredit], ['300.00', '0.00'], from);
  }
  const april = await trialBalance(late, '2026-04-01', '2026-04-30');
  assert.deepEqual(columns(named(april, 'Commission')), ['0.00', '0.00', '0.00', '50.00', '0.00', '50.00']);
  assert.deepEqual(columns(named(april, 'Profit and Loss')), ['0.00', '300.00', '0.00', '0.00', '0.00', '300.00']);
  balanced(april);
  assert.equal((await read(late, 'reports/profit-and-loss?from=2026-04-01&to=2026-04-30')).netProfit, '50.00');
  assert.deepEqual((await read(late, 'reports/balance-sheet?date=2026-04-30')).profitAndLoss, { broughtForward: '0.00', currentPeriod: '350.00' });
});

test('a three-decimal company carries exact fils into the row', async () => {
  const c = await company('Fils Books', { baseCurrency: 'KWD' });
  const bank = await c.ledger('Gulf Bank', 'bank_accounts', { amount: '100.000', side: 'Dr' });
  await c.ledger('Capital Paid In', 'capital', { amount: '100.000', side: 'Cr' });
  const income = await c.ledger('Consulting Income', 'direct_income');
  const charges = await c.ledger('Service Charges', 'indirect_expenses');
  await c.post('receipt', '2026-01-06', [[income, 'Cr', '12.345'], [bank, 'Dr', '12.345']]);
  await c.post('payment', '2026-01-07', [[charges, 'Dr', '0.001'], [bank, 'Cr', '0.001']]);
  await c.post('receipt', '2026-02-02', [[income, 'Cr', '1.111'], [bank, 'Dr', '1.111']]);
  const february = await trialBalance(c, '2026-02-01', '2026-02-28');
  assert.deepEqual(columns(named(february, 'Profit and Loss')), ['0.000', '12.344', '0.000', '0.000', '0.000', '12.344']);
  assert.deepEqual(columns(named(february, 'Consulting Income')), ['0.000', '0.000', '0.000', '1.111', '0.000', '1.111']);
  assert.deepEqual([february.grandTotals.closingDebit, february.grandTotals.closingCredit], ['113.455', '113.455']);
});
