import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { addMoney, parseMoney, subtractMoney } from '@ten98/runtime';
import { companyNotFound } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { goldenCompany } from './helpers/golden.ts';
import { addLedger, browser, chart, createCompany, invite, post, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * The M1 reports over the real HTTP contract as books_app: the golden fixture's figures and drill-down sums, a
 * three-decimal company, a financial year starting in April across two years, unbalanced openings, the voucher
 * lifecycle, CSV content and the tenancy negatives.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let companyId = '';
let books: Chart;

before(async () => {
  database = await freshDatabase('reports');
  owner = await setupOwner();
  ({ companyId, books } = await goldenCompany(owner.browser, owner.workspaceId));
});
after(async () => { await database?.drop(); });

const period = 'from=2026-01-01&to=2026-02-03';
const aed = (text: string) => parseMoney(text, 2);
async function report(path: string, member = owner.browser, company = companyId): Promise<any> {
  const response = await member.call(`/api/companies/${company}/reports/${path}`);
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.body)}`);
  return response.body.report;
}

test('defaults open statements on the financial-year start through the last voucher date, and the day book on that date', async () => {
  const { body } = await owner.browser.call(`/api/companies/${companyId}/reports/defaults`);
  assert.deepEqual(body.defaults, { lastVoucherDate: '2026-02-03', period: { from: '2026-01-01', to: '2026-02-03' }, dayBookDate: '2026-02-03', booksBeginning: '2026-01-01' });
});

test('the day book lists the 18 golden vouchers in date order with particulars, type, number and amount, and pages by cursor', async () => {
  const book = await report(`day-book?${period}`);
  assert.equal(book.rows.length, 18);
  assert.equal(book.next, null);
  assert.deepEqual(book.rows.slice(0, 3).map((row: any) => [row.date, row.particulars, row.kind, row.number, row.side, row.amount]), [
    ['2026-01-01', 'Premises Rent', 'payment', 1, 'Dr', '4000.00'],
    ['2026-01-02', "Owners' Capital", 'receipt', 1, 'Cr', '20000.00'],
    ['2026-01-04', 'Cash', 'contra', 1, 'Cr', '5000.00'],
  ]);
  assert.equal(book.totals.vouchers, 18);
  assert.equal(addMoney(aed(book.totals.debit), aed(book.totals.credit)), aed('85225.00'), 'every voucher amount counted once');
  const oneDay = await report('day-book?from=2026-02-03&to=2026-02-03');
  assert.deepEqual(oneDay.rows.map((row: any) => [row.particulars, row.amount]), [['Wages', '3000.00']]);

  const seen: string[] = [];
  let after: string | null = null;
  do {
    const page: any = await report(`day-book?${period}&limit=5${after ? `&after=${after}` : ''}`);
    seen.push(...page.rows.map((row: any) => row.voucherId));
    after = page.next;
  } while (after);
  assert.deepEqual(seen, book.rows.map((row: any) => row.voucherId));
});

test('the trial balance by group totals 53,625 per side with opening, debit, credit and closing columns', async () => {
  const tb = await report(`trial-balance?${period}`);
  assert.equal(tb.grandTotals.closingDebit, '53625.00');
  assert.equal(tb.grandTotals.closingCredit, '53625.00');
  assert.equal(tb.grandTotals.openingDebit, '12000.00');
  assert.equal(tb.grandTotals.openingCredit, '12000.00');
  assert.equal(tb.difference, null);
  const primaries = tb.nodes.filter((node: any) => node.depth === 0 && (node.closingDebit !== '0.00' || node.closingCredit !== '0.00'));
  assert.deepEqual(primaries.map((node: any) => [node.name, node.closingDebit, node.closingCredit]), [
    ['Capital', '0.00', '32000.00'], ['Current Liabilities', '375.00', '10625.00'],
    ['Current Assets', '26850.00', '0.00'], ['Fixed Assets', '8000.00', '0.00'],
    ['Sales', '0.00', '11000.00'], ['Indirect Expenses', '10900.00', '0.00'], ['Purchases', '7500.00', '0.00'],
  ]);
  // Pre-order: a group is followed by its sub-groups and ledgers, one level deeper.
  const promotion = tb.nodes.findIndex((node: any) => node.name === 'Promotion Costs');
  assert.deepEqual([tb.nodes[promotion].depth, tb.nodes[promotion + 1].name, tb.nodes[promotion + 1].depth], [1, 'Promotion', 2]);
});

test('profit and loss shows gross profit 3,500 from the trading groups and a net loss of 7,400', async () => {
  const pl = await report(`profit-and-loss?${period}`);
  assert.equal(pl.grossProfit, '3500.00');
  assert.equal(pl.netProfit, '-7400.00');
  const line = (label: string) => pl.lines.find((item: any) => item.label === label);
  assert.deepEqual([line('Sales').amount, line('Purchases').amount, line('Gross profit').amount, line('Indirect Expenses').amount, line('Net loss').amount],
    ['11000.00', '7500.00', '3500.00', '10900.00', '7400.00']);
  assert.equal(line('Promotion').depth, 2);
  const across = await owner.browser.call(`/api/companies/${companyId}/reports/profit-and-loss?from=2026-01-01&to=2027-01-05`);
  assert.equal(across.status, 400);
  assert.match(across.body.error, /one financial year/);
});

test('the balance sheet as at 3 February totals 42,250 per side with the loss carried on the assets side', async () => {
  const bs = await report('balance-sheet?date=2026-02-03');
  assert.deepEqual(bs.totals, { liabilities: '42250.00', assets: '42250.00' });
  assert.deepEqual(bs.profitAndLoss, { broughtForward: '0.00', currentPeriod: '-7400.00' });
  const labels = bs.lines.map((line: any) => line.label);
  const at = (label: string) => bs.lines.find((line: any) => line.label === label);
  assert.equal(at('Current Liabilities').amount, '10250.00', 'tax debits net into the liabilities group');
  assert.equal(at('Profit and loss account (loss)').amount, '7400.00');
  assert.ok(labels.indexOf('Profit and loss account (loss)') > labels.indexOf('Assets'), 'a loss stands with the assets');
  assert.equal(at('Current period').amount, '7400.00');
});

test('every drill-down level sums to its parent: statement, group summary, ledger monthly summary, ledger vouchers', async () => {
  const bs = await report('balance-sheet?date=2026-02-03');
  const tb = await report(`trial-balance?${period}`);
  let ledgersChecked = 0, monthsChecked = 0;

  async function checkLedger(ledgerId: string, closing: bigint, debit: bigint, credit: bigint) {
    const monthly = await report(`ledger-monthly/${ledgerId}?${period}`);
    assert.equal(aed(monthly.totals.closing), closing, `${monthly.ledger.name} monthly closing`);
    assert.deepEqual([aed(monthly.totals.debit), aed(monthly.totals.credit)], [debit, credit], `${monthly.ledger.name} monthly movements`);
    const sums = monthly.months.reduce((total: bigint[], month: any) => [addMoney(total[0], aed(month.debit)), addMoney(total[1], aed(month.credit))], [0n, 0n]);
    assert.deepEqual(sums, [debit, credit], 'the months add up to the period');
    assert.equal(aed(monthly.months.at(-1).closing), closing);
    ledgersChecked++;
    for (const month of monthly.months) {
      const vouchers = await report(`ledger-vouchers/${ledgerId}?from=${month.from}&to=${month.to}`);
      const rowSums = vouchers.rows.reduce((total: bigint[], row: any) => [addMoney(total[0], aed(row.debit)), addMoney(total[1], aed(row.credit))], [0n, 0n]);
      assert.deepEqual(rowSums, [aed(month.debit), aed(month.credit)], `${monthly.ledger.name} ${month.month} vouchers`);
      assert.equal(aed(vouchers.totals.closing), aed(month.closing));
      if (vouchers.rows.length) assert.equal(aed(vouchers.rows.at(-1).balance), aed(month.closing), 'the running balance ends on the month closing');
      monthsChecked++;
    }
  }
  async function checkGroup(groupId: string, closing: bigint): Promise<void> {
    const summary = await report(`group-summary/${groupId}?${period}`);
    assert.equal(aed(summary.totals.closing), closing, `${summary.group.name} total`);
    const rowTotal = summary.rows.reduce((total: bigint, row: any) => addMoney(total, aed(row.closing)), 0n);
    assert.equal(rowTotal, closing, `${summary.group.name} rows add up`);
    for (const row of summary.rows) {
      if (row.kind === 'group') await checkGroup(row.id, aed(row.closing));
      else await checkLedger(row.id, aed(row.closing), aed(row.debit), aed(row.credit));
    }
  }
  // Balance sheet lines: liabilities in credit terms, assets in debit terms.
  const liabilitiesAt = bs.lines.findIndex((line: any) => line.label === 'Assets');
  for (const [index, line] of bs.lines.entries()) {
    if (line.kind !== 'group' || line.depth !== 0) continue;
    await checkGroup(line.target.groupId, index < liabilitiesAt ? subtractMoney(0n, aed(line.amount)) : aed(line.amount));
  }
  // Trial balance lines: the group's closing debits and credits are the gross sums of its ledgers.
  const incomeAndExpense = tb.nodes.filter((node: any) => node.depth === 0 && (node.nature === 'income' || node.nature === 'expense'));
  for (const node of incomeAndExpense) await checkGroup(node.id, subtractMoney(aed(node.closingDebit), aed(node.closingCredit)));
  assert.ok(ledgersChecked >= 12 && monthsChecked >= 24, `${ledgersChecked} ledgers, ${monthsChecked} months`);

  // Profit and loss lines lead to the same group summaries: the period movement is the line amount.
  const pl = await report(`profit-and-loss?${period}`);
  const expenses = pl.lines.find((line: any) => line.label === 'Indirect Expenses');
  const summary = await report(`group-summary/${expenses.target.groupId}?${period}`);
  assert.equal(subtractMoney(aed(summary.totals.debit), aed(summary.totals.credit)), aed(expenses.amount));
  // The primary level adds up to the trial balance.
  const primary = await report(`group-summary?${period}`);
  assert.deepEqual([primary.totals.closingDebit, primary.totals.closingCredit], [tb.grandTotals.closingDebit, tb.grandTotals.closingCredit]);
});

test('ledger vouchers show the contra particulars, the running balance and the totals of the ledger', async () => {
  const customer = await report(`ledger-vouchers/${books.ledger('Customer North')}?${period}`);
  assert.equal(customer.opening, '2000.00');
  assert.deepEqual(customer.rows.map((row: any) => [row.date, row.particulars, row.otherLedgers, row.kind, row.number, row.debit, row.credit, row.balance]), [
    ['2026-01-10', 'Trade Sales', 1, 'sales', 1, '9450.00', '0.00', '11450.00'],
    ['2026-01-12', 'Harbour Bank', 0, 'receipt', 2, '0.00', '2000.00', '9450.00'],
    ['2026-01-20', 'Trade Sales', 1, 'sales', 2, '3150.00', '0.00', '12600.00'],
    ['2026-01-22', 'Trade Sales', 1, 'credit_note', 1, '0.00', '1050.00', '11550.00'],
    ['2026-01-30', 'Harbour Bank', 0, 'receipt', 3, '0.00', '9450.00', '2100.00'],
  ]);
  assert.deepEqual(customer.totals, { debit: '12600.00', credit: '12500.00', closing: '2100.00' });
  // A later page continues the running balance.
  const first = await report(`ledger-vouchers/${books.ledger('Customer North')}?${period}&limit=2`);
  const second = await report(`ledger-vouchers/${books.ledger('Customer North')}?${period}&limit=2&after=${first.next}`);
  assert.deepEqual(second.rows.map((row: any) => row.balance), ['12600.00', '11550.00']);
  const capital = await report(`ledger-monthly/${books.ledger("Owners' Capital")}?${period}`);
  assert.deepEqual([capital.opening, capital.months.map((month: any) => [month.month, month.credit, month.closing])],
    ['-12000.00', [['2026-01', '20000.00', '-32000.00'], ['2026-02', '0.00', '-32000.00']]]);
});

test('CSV exports hold the same figures, quote every cell and neutralise formulas', async () => {
  const response = await rawGet(owner.browser, `/api/companies/${companyId}/reports/trial-balance/export?${period}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="trial-balance-2026-01-01-to-2026-02-03.csv"');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'a UTF-8 byte-order mark first');
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.startsWith('"Particulars","Kind","Level","Opening debit"'), text.slice(0, 80));
  assert.ok(text.endsWith('"Total","total","","12000.00","12000.00","85225.00","85225.00","53625.00","53625.00"\r\n'), text.slice(-120));

  const tricky = await createCompany(owner.browser, owner.workspaceId, { name: 'Escaping Books' });
  const chartOf = await chart(owner.browser, tricky);
  const formula = await addLedger(owner.browser, tricky, '=SUM(A1:A9)', chartOf.group('indirect_expenses'));
  const quoted = await addLedger(owner.browser, tricky, 'Smith, "Junior" & Sons', chartOf.group('capital'));
  await post(owner.browser, tricky, chartOf.type('journal'), '2026-01-03', [[formula, 'Dr', '1.50'], [quoted, 'Cr', '1.50']], { narration: '@cmd line\nsecond' });
  const tb = await (await rawGet(owner.browser, `/api/companies/${tricky}/reports/trial-balance/export?from=2026-01-01&to=2026-01-31`)).text();
  assert.match(tb, /"'=SUM\(A1:A9\)","ledger","1"/);
  assert.match(tb, /"Smith, ""Junior"" & Sons","ledger","1"/);
  const book = await (await rawGet(owner.browser, `/api/companies/${tricky}/reports/day-book/export?from=2026-01-01&to=2026-01-31`)).text();
  assert.match(book, /"'=SUM\(A1:A9\)","Journal","1","regular","no","1.50","","'@cmd line\nsecond"/);
  for (const path of ['profit-and-loss/export?from=2026-01-01&to=2026-01-31', 'balance-sheet/export?date=2026-01-31', 'group-summary/export?from=2026-01-01&to=2026-01-31',
    `ledger-monthly/${formula}/export?from=2026-01-01&to=2026-01-31`, `ledger-vouchers/${formula}/export?from=2026-01-01&to=2026-01-31`]) {
    const exported = await rawGet(owner.browser, `/api/companies/${tricky}/reports/${path}`);
    assert.equal(exported.status, 200, path);
    assert.ok((await exported.text()).includes('1.50'), path);
  }
});

test('a three-decimal company reports exact fils in every statement', async () => {
  const kwd = await createCompany(owner.browser, owner.workspaceId, { name: 'Three Decimals', baseCurrency: 'KWD' });
  const chartOf = await chart(owner.browser, kwd);
  const bank = await addLedger(owner.browser, kwd, 'Gulf Bank', chartOf.group('bank_accounts'), { amount: '1500.125', side: 'Dr' });
  await addLedger(owner.browser, kwd, 'Capital Paid In', chartOf.group('capital'), { amount: '1500.125', side: 'Cr' });
  const fees = await addLedger(owner.browser, kwd, 'Service Fees', chartOf.group('indirect_expenses'));
  const income = await addLedger(owner.browser, kwd, 'Consulting Income', chartOf.group('direct_income'));
  await post(owner.browser, kwd, chartOf.type('payment'), '2026-01-05', [[fees, 'Dr', '12.345'], [bank, 'Cr', '12.345']]);
  await post(owner.browser, kwd, chartOf.type('receipt'), '2026-01-06', [[income, 'Cr', '0.001'], [bank, 'Dr', '0.001']]);
  const tb = await report('trial-balance?from=2026-01-01&to=2026-01-31', owner.browser, kwd);
  assert.deepEqual([tb.grandTotals.closingDebit, tb.grandTotals.closingCredit], ['1500.126', '1500.126']);
  const pl = await report('profit-and-loss?from=2026-01-01&to=2026-01-31', owner.browser, kwd);
  assert.deepEqual([pl.grossProfit, pl.netProfit], ['0.001', '-12.344']);
  const bs = await report('balance-sheet?date=2026-01-31', owner.browser, kwd);
  assert.deepEqual(bs.totals, { liabilities: '1500.125', assets: '1500.125' });
  const vouchers = await report(`ledger-vouchers/${bank}?from=2026-01-01&to=2026-01-31`, owner.browser, kwd);
  assert.deepEqual(vouchers.rows.map((row: any) => row.balance), ['1487.780', '1487.781']);
});

test('a financial year starting in April carries the earlier year into the profit and loss account at exact boundaries', async () => {
  const april = await createCompany(owner.browser, owner.workspaceId, { name: 'April Books', financialYearStart: { month: 4, day: 1 }, booksBeginning: '2025-04-01' });
  const chartOf = await chart(owner.browser, april);
  const bank = await addLedger(owner.browser, april, 'Bay Bank', chartOf.group('bank_accounts'), { amount: '1000', side: 'Dr' });
  await addLedger(owner.browser, april, 'Founders', chartOf.group('capital'), { amount: '1000', side: 'Cr' });
  const sales = await addLedger(owner.browser, april, 'Services', chartOf.group('sales'));
  const rent = await addLedger(owner.browser, april, 'Office Rent', chartOf.group('indirect_expenses'));
  await post(owner.browser, april, chartOf.type('receipt'), '2025-04-01', [[sales, 'Cr', '1000'], [bank, 'Dr', '1000']]);
  await post(owner.browser, april, chartOf.type('payment'), '2026-03-31', [[rent, 'Dr', '300'], [bank, 'Cr', '300']]);
  await post(owner.browser, april, chartOf.type('receipt'), '2026-04-01', [[sales, 'Cr', '500'], [bank, 'Dr', '500']]);

  const defaults = (await owner.browser.call(`/api/companies/${april}/reports/defaults`)).body.defaults;
  assert.deepEqual(defaults.period, { from: '2026-04-01', to: '2026-04-01' });
  const firstYear = await report('profit-and-loss?from=2025-04-01&to=2026-03-31', owner.browser, april);
  assert.equal(firstYear.netProfit, '700.00', 'the last day of the year belongs to it');
  const secondYear = await report('profit-and-loss?from=2026-04-01&to=2026-04-30', owner.browser, april);
  assert.equal(secondYear.netProfit, '500.00', 'the first day of the next year starts afresh');
  assert.equal((await owner.browser.call(`/api/companies/${april}/reports/profit-and-loss?from=2026-03-31&to=2026-04-01`)).status, 400);

  const bs = await report('balance-sheet?date=2026-04-30', owner.browser, april);
  assert.deepEqual(bs.profitAndLoss, { broughtForward: '700.00', currentPeriod: '500.00' });
  assert.deepEqual(bs.totals, { liabilities: '2200.00', assets: '2200.00' });
  assert.equal(bs.lines.find((line: any) => line.label === 'Profit and loss account').amount, '1200.00');
  const yearEnd = await report('balance-sheet?date=2026-03-31', owner.browser, april);
  assert.deepEqual(yearEnd.profitAndLoss, { broughtForward: '0.00', currentPeriod: '700.00' });

  const tb = await report('trial-balance?from=2026-04-01&to=2026-04-30', owner.browser, april);
  const node = (name: string) => tb.nodes.find((item: any) => item.name === name);
  assert.deepEqual([node('Services').openingCredit, node('Office Rent').openingDebit], ['0.00', '0.00'], 'income and expense open at zero in a new year');
  assert.equal(node('Profit and Loss').openingCredit, '700.00');
  assert.deepEqual([tb.grandTotals.closingDebit, tb.grandTotals.closingCredit], ['2200.00', '2200.00']);

  const monthly = await report(`ledger-monthly/${sales}?from=2026-01-01&to=2026-06-30`, owner.browser, april);
  assert.equal(monthly.to, '2026-03-31', 'one financial year at a time');
  assert.deepEqual(monthly.months.map((month: any) => month.month), ['2026-01', '2026-02', '2026-03']);
  assert.equal(monthly.opening, '-1000.00');
});

test('unbalanced opening balances show a difference line so the statements agree', async () => {
  const setup = await createCompany(owner.browser, owner.workspaceId, { name: 'Setting Up' });
  const chartOf = await chart(owner.browser, setup);
  await addLedger(owner.browser, setup, 'Main Bank', chartOf.group('bank_accounts'), { amount: '1000', side: 'Dr' });
  await addLedger(owner.browser, setup, 'Partner', chartOf.group('capital'), { amount: '400', side: 'Cr' });
  const tb = await report('trial-balance?from=2026-01-01&to=2026-01-31', owner.browser, setup);
  assert.deepEqual(tb.openingDifference, { amount: '600.00', side: 'Dr' });
  assert.deepEqual([tb.difference.openingCredit, tb.difference.closingCredit], ['600.00', '600.00']);
  assert.deepEqual([tb.grandTotals.openingDebit, tb.grandTotals.openingCredit, tb.grandTotals.closingDebit, tb.grandTotals.closingCredit], ['1000.00', '1000.00', '1000.00', '1000.00']);
  const bs = await report('balance-sheet?date=2026-01-31', owner.browser, setup);
  assert.deepEqual(bs.totals, { liabilities: '1000.00', assets: '1000.00' });
  assert.equal(bs.lines.find((line: any) => line.kind === 'difference').amount, '600.00');
});

test('cancelled, deleted and optional vouchers never count; a post-dated voucher counts from its own date', async () => {
  const life = await createCompany(owner.browser, owner.workspaceId, { name: 'Lifecycle Books' });
  const chartOf = await chart(owner.browser, life);
  const cash = chartOf.ledger('Cash');
  const income = await addLedger(owner.browser, life, 'Fees Earned', chartOf.group('indirect_income'));
  const receipt = chartOf.type('receipt');
  await post(owner.browser, life, receipt, '2026-03-01', [[income, 'Cr', '100'], [cash, 'Dr', '100']]);
  const cancelled = await post(owner.browser, life, receipt, '2026-03-02', [[income, 'Cr', '200'], [cash, 'Dr', '200']]);
  assert.equal((await owner.browser.call(`/api/companies/${life}/vouchers/${cancelled.id}/cancel`, { revision: cancelled.revision })).status, 200);
  const deleted = await post(owner.browser, life, receipt, '2026-03-03', [[income, 'Cr', '300'], [cash, 'Dr', '300']]);
  assert.equal((await owner.browser.call(`/api/companies/${life}/vouchers/${deleted.id}/delete`, { revision: deleted.revision })).status, 200);
  await post(owner.browser, life, receipt, '2026-03-04', [[income, 'Cr', '400'], [cash, 'Dr', '400']], { status: 'optional' });
  await post(owner.browser, life, receipt, '2026-03-20', [[income, 'Cr', '500'], [cash, 'Dr', '500']], { postDated: true });

  const book = await report('day-book?from=2026-03-01&to=2026-03-31', owner.browser, life);
  assert.deepEqual(book.rows.map((row: any) => [row.date, row.status, row.postDated, row.number]), [
    ['2026-03-01', 'regular', false, 1], ['2026-03-02', 'cancelled', false, 2], ['2026-03-04', 'optional', false, null], ['2026-03-20', 'regular', true, 4],
  ]);
  assert.deepEqual(book.totals, { debit: '0.00', credit: '600.00', vouchers: 2 });
  const before = await report('trial-balance?from=2026-03-01&to=2026-03-19', owner.browser, life);
  const after = await report('trial-balance?from=2026-03-01&to=2026-03-31', owner.browser, life);
  const cashOf = (tb: any) => tb.nodes.find((node: any) => node.id === cash).closingDebit;
  assert.deepEqual([cashOf(before), cashOf(after)], ['100.00', '600.00']);
  const defaults = (await owner.browser.call(`/api/companies/${life}/reports/defaults`)).body.defaults;
  assert.equal(defaults.lastVoucherDate, '2026-03-01', 'optional, cancelled-out and post-dated vouchers do not move the default date');
  const vouchers = await report(`ledger-vouchers/${cash}?from=2026-03-01&to=2026-03-31`, owner.browser, life);
  assert.deepEqual(vouchers.rows.map((row: any) => [row.date, row.debit, row.balance]), [['2026-03-01', '100.00', '100.00'], ['2026-03-20', '500.00', '600.00']]);
});

test('queries are checked at the boundary', async () => {
  for (const query of ['trial-balance?from=2026-02-03&to=2026-01-01', 'trial-balance?from=2026-02-30&to=2026-03-01', 'trial-balance?from=2010-01-01&to=2026-01-01',
    'trial-balance?from=2026-01-01', 'trial-balance?from=2026-01-01&to=2026-01-31&extra=1', 'trial-balance?from=2026-01-01&to=2026-01-31&to=2026-01-30',
    'balance-sheet?date=03-02-2026', 'day-book?from=2026-01-01&to=2026-01-31&limit=0', 'day-book?from=2026-01-01&to=2026-01-31&after=bm90LWEtY3Vyc29y']) {
    const response = await owner.browser.call(`/api/companies/${companyId}/reports/${query}`);
    assert.equal(response.status, 400, query);
  }
  assert.equal((await owner.browser.call(`/api/companies/${companyId}/reports/ledger-monthly/${books.group('capital')}?${period}`)).status, 404, 'a group is not a ledger');
  assert.equal((await owner.browser.call(`/api/companies/${companyId}/reports/group-summary/${books.ledger('Cash')}?${period}`)).status, 404, 'a ledger is not a group');
  assert.equal((await owner.browser.call(`/api/companies/${companyId}/reports/trial-balance`, {})).status, 405);
});

/** Every report route and its export, for one company. */
const everyRoute = (company: string) => {
  const ledger = books.ledger('Cash'), group = books.group('current_assets');
  const routes = ['defaults', `day-book?${period}`, `trial-balance?${period}`, `profit-and-loss?${period}`, 'balance-sheet?date=2026-02-03', `group-summary?${period}`,
    `group-summary/${group}?${period}`, `ledger-monthly/${ledger}?${period}`, `ledger-vouchers/${ledger}?${period}`];
  const exports = routes.slice(1).map(route => route.replace('?', '/export?'));
  return [...routes, ...exports].map(route => `/api/companies/${company}/reports/${route}`);
};

test('another workspace\'s user gets "not found" for every report and export; a stranger is asked to sign in; a viewer reads', async () => {
  const other = (await owner.browser.call('/api/workspaces', { name: 'Elsewhere' })).body.workspace.id;
  const intruder = await invite(owner.browser, other, 'admin');
  const own = await createCompany(intruder.browser, other, { name: 'Intruder Books' });
  assert.equal((await intruder.browser.call(`/api/companies/${own}/reports/defaults`)).status, 200, 'the intruder reads their own company');
  const viewer = await invite(owner.browser, owner.workspaceId, 'viewer');
  const stranger = browser();
  for (const path of everyRoute(companyId)) {
    assert.deepEqual(await intruder.browser.call(path), { status: 404, body: { error: companyNotFound } }, path);
    assert.equal((await stranger.call(path)).status, 401, path);
    assert.equal((await rawGet(viewer.browser, path)).status, 200, path);
  }
});

/** A GET whose response is read raw (CSV), with the member's cookies. */
async function rawGet(member: Member['browser'], path: string): Promise<Response> {
  const { handleApi } = await import('../src/server/api.ts');
  const { getConfig } = await import('../src/server/config.ts');
  const headers = new Headers({ cookie: [...member.cookies].map(([name, value]) => `${name}=${value}`).join('; ') });
  return handleApi(new Request(new URL(path, getConfig().appUrl), { headers }));
}
