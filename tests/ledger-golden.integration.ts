import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { addMoney, formatMoney, subtractMoney } from '@ten98/runtime';
import { getDatabase } from '../src/server/db.ts';
import { trialBalance } from '../src/server/ledger/reports.ts';
import { companyNotFound } from '../src/server/tenancy.ts';
import type { TrialBalanceRow } from '../src/lib/ledger.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { goldenMasters, goldenVouchers, postGoldenVouchers } from './helpers/golden.ts';
import { addLedger, chart, createCompany, inCompany, invite, post, rowCount, setupOwner, voucherBody, type Chart, type Member } from './helpers/ledger.ts';

/** The ledger's own checks of the golden fixture (tests/helpers/golden.ts) and of the read model's tenancy. */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let companyId = '';
let books: Chart;
const ledgerTables = ['account_group', 'ledger', 'voucher_type', 'voucher_counter', 'voucher', 'voucher_line', 'revision_log'];

before(async () => {
  database = await freshDatabase('ledger_golden');
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, { name: 'Golden Trading' });
  books = await goldenMasters(owner.browser, companyId);
});
after(async () => { await database?.drop(); });

const L = (name: string) => books.ledger(name);

/** AED amounts of this fixture are whole, so they read without the decimal places. */
const money = (amount: bigint) => formatMoney(amount, 2).replace(/.00$/, '');
const sum = (rows: TrialBalanceRow[], pick: (row: TrialBalanceRow) => bigint) => rows.reduce((total, row) => addMoney(total, pick(row)), 0n);

test('the golden fixture posts 18 vouchers numbered per type in entry order', async () => {
  const numbers: string[] = [];
  const posted = await postGoldenVouchers(owner.browser, companyId, books);
  posted.forEach((voucher, index) => numbers.push(`${goldenVouchers[index][0]} ${voucher.number}`));
  assert.deepEqual(numbers, ['payment 1', 'receipt 1', 'contra 1', 'payment 2', 'journal 1', 'purchase 1', 'sales 1', 'receipt 2', 'payment 3',
    'purchase 2', 'sales 2', 'credit_note 1', 'debit_note 1', 'contra 2', 'journal 2', 'receipt 3', 'payment 4', 'payment 5']);
});

test('the trial balance, gross profit, net loss and balance sheet match the expected outcome', async () => {
  const report = await inCompany(owner.userId, companyId, context => trialBalance(context, '2026-01-01', '2026-02-03'));
  const closing = Object.fromEntries(report.rows.filter(row => row.closingDebit || row.closingCredit)
    .map(row => [row.name, row.closingDebit ? `${money(row.closingDebit)} Dr` : `${money(row.closingCredit)} Cr`]));
  assert.deepEqual(closing, {
    Promotion: '900 Dr', 'Customer North': '2100 Dr', Cash: '9600 Dr', 'Harbour Bank': '15150 Dr', Equipment: '8000 Dr', 'Premises Rent': '4000 Dr',
    'Trade Purchases': '7500 Dr', Wages: '6000 Dr', 'Input Tax': '375 Dr',
    'Supplier South': '10075 Cr', 'Trade Sales': '11000 Cr', "Owners' Capital": '32000 Cr', 'Output Tax': '550 Cr',
  });
  assert.equal(money(report.totals.closingDebit), '53625');
  assert.equal(money(report.totals.closingCredit), '53625');
  assert.deepEqual(report.openingDifference, { amount: 0n, side: null }, 'the opening balances agree');
  assert.equal(money(report.totals.openingDebit), '12000');

  // Group-wise: closing debits and credits of each primary group's ledgers, both columns kept.
  const byGroup = new Map<string, { debit: bigint; credit: bigint }>();
  for (const row of report.rows) {
    if (!row.primaryGroupName || !(row.closingDebit || row.closingCredit)) continue;
    const group = byGroup.get(row.primaryGroupName) ?? { debit: 0n, credit: 0n };
    byGroup.set(row.primaryGroupName, { debit: addMoney(group.debit, row.closingDebit), credit: addMoney(group.credit, row.closingCredit) });
  }
  assert.deepEqual(Object.fromEntries([...byGroup].map(([name, { debit, credit }]) => [name, [money(debit), money(credit)]])), {
    Capital: ['0', '32000'], 'Current Liabilities': ['375', '10625'], 'Fixed Assets': ['8000', '0'], 'Current Assets': ['26850', '0'],
    Sales: ['0', '11000'], Purchases: ['7500', '0'], 'Indirect Expenses': ['10900', '0'],
  });

  // Profit and loss from the rows: trading lines give gross profit, everything of income or expense nature the net result.
  const net = (rows: TrialBalanceRow[]) => subtractMoney(sum(rows, row => row.closingCredit), sum(rows, row => row.closingDebit));
  const incomeAndExpense = report.rows.filter(row => row.nature === 'income' || row.nature === 'expense');
  const grossProfit = net(incomeAndExpense.filter(row => row.grossProfit));
  const netResult = net(incomeAndExpense);
  assert.equal(money(grossProfit), '3500');
  assert.equal(money(netResult), '-7400', 'a net loss of 7,400');

  // Balance sheet: liabilities against assets, with the profit and loss ledger plus this period's result on the side it falls.
  const profitAndLoss = report.rows.find(row => row.systemKey === 'profit_and_loss')!;
  const retained = addMoney(subtractMoney(profitAndLoss.closingCredit, profitAndLoss.closingDebit), netResult);
  const liabilities = addMoney(net(report.rows.filter(row => row.nature === 'liability')), retained > 0n ? retained : 0n);
  const assets = addMoney(subtractMoney(0n, net(report.rows.filter(row => row.nature === 'asset'))), retained < 0n ? subtractMoney(0n, retained) : 0n);
  assert.equal(money(liabilities), '42250');
  assert.equal(money(assets), '42250');
});

test('the API returns the trial balance and a ledger balance with amounts as decimal strings', async () => {
  const response = await owner.browser.call(`/api/companies/${companyId}/trial-balance?from=2026-01-01&to=2026-02-03`);
  assert.equal(response.status, 200);
  assert.equal(response.body.trialBalance.totals.closingDebit, '53625.00');
  assert.equal(response.body.trialBalance.totals.closingCredit, '53625.00');
  const customer = await owner.browser.call(`/api/companies/${companyId}/ledgers/${L('Customer North')}/balance?from=2026-01-01&to=2026-02-03`);
  assert.deepEqual([customer.body.balance.openingDebit, customer.body.balance.debit, customer.body.balance.credit, customer.body.balance.closingDebit],
    ['2000.00', '12600.00', '12500.00', '2100.00']);
  // A later period opens with the earlier movements.
  const february = await owner.browser.call(`/api/companies/${companyId}/ledgers/${L('Cash')}/balance?from=2026-02-01&to=2026-02-28`);
  assert.deepEqual([february.body.balance.openingDebit, february.body.balance.credit, february.body.balance.closingDebit], ['12600.00', '3000.00', '9600.00']);
  assert.equal((await owner.browser.call(`/api/companies/${companyId}/trial-balance?from=2026-02-03&to=2026-01-01`)).status, 400);
});

test('a three-decimal company keeps exact amounts and refuses a fourth decimal place', async () => {
  const kwd = await createCompany(owner.browser, { name: 'Three Decimals', baseCurrency: 'KWD' });
  const chartOf = await chart(owner.browser, kwd);
  const bank = await addLedger(owner.browser, kwd, 'Gulf Bank', chartOf.group('bank_accounts'), { amount: '1500.125', side: 'Dr' });
  await addLedger(owner.browser, kwd, 'Capital Paid In', chartOf.group('capital'), { amount: '1500.125', side: 'Cr' });
  const fees = await addLedger(owner.browser, kwd, 'Service Fees', chartOf.group('indirect_expenses'));
  const income = await addLedger(owner.browser, kwd, 'Consulting Income', chartOf.group('direct_income'));
  await post(owner.browser, kwd, chartOf.type('payment'), '2026-01-05', [[fees, 'Dr', '12.345'], [bank, 'Cr', '12.345']]);
  await post(owner.browser, kwd, chartOf.type('receipt'), '2026-01-06', [[income, 'Cr', '0.001'], [bank, 'Dr', '0.001']]);
  const refused = await owner.browser.call(`/api/companies/${kwd}/vouchers`, voucherBody(chartOf.type('payment'), '2026-01-07', [[fees, 'Dr', '1.0005'], [bank, 'Cr', '1.0005']]));
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /at most 3 decimal places/);
  const report = (await owner.browser.call(`/api/companies/${kwd}/trial-balance?from=2026-01-01&to=2026-01-31`)).body.trialBalance;
  const bankRow = report.rows.find((row: { ledgerId: string }) => row.ledgerId === bank);
  assert.equal(bankRow.closingDebit, '1487.781');
  assert.equal(report.totals.closingDebit, '1500.126');
  assert.equal(report.totals.closingCredit, '1500.126');
});

test('another workspace\'s user gets "not found" from every handler module and writes nothing', async () => {
  // The intruder is an admin of a second workspace only, with a company of their own.
  const other = await createCompany(owner.browser, { name: 'Elsewhere' });
  const intruder = await invite(owner.browser, other, 'admin');
  const own = await createCompany(intruder.browser, { name: 'Intruder Books' });
  assert.equal((await intruder.browser.call(`/api/companies/${own}/groups`)).status, 200, 'the intruder reads their own company');
  const before = await Promise.all(ledgerTables.map(table => rowCount(database.adminUrl, table, companyId)));
  const sales = L('Trade Sales'), cash = L('Cash'), voucherId = (await owner.browser.call(`/api/companies/${companyId}/vouchers?from=2026-01-01&to=2026-12-31`)).body.vouchers[0].id;
  const attempts: [string, unknown?][] = [
    [`/api/companies/${companyId}/groups`], [`/api/companies/${companyId}/groups`, { name: 'Intrusion', parentId: books.group('capital') }],
    [`/api/companies/${companyId}/ledgers/${sales}`], [`/api/companies/${companyId}/ledgers/${sales}`, { name: 'Renamed', groupId: books.group('sales'), revision: 1 }],
    [`/api/companies/${companyId}/ledgers/${L('Wages')}/delete`, { revision: 1 }], [`/api/companies/${companyId}/voucher-types`],
    [`/api/companies/${companyId}/vouchers?from=2026-01-01&to=2026-12-31`], [`/api/companies/${companyId}/vouchers/${voucherId}`],
    [`/api/companies/${companyId}/vouchers`, voucherBody(books.type('receipt'), '2026-02-05', [[sales, 'Cr', '1'], [cash, 'Dr', '1']])],
    [`/api/companies/${companyId}/vouchers/${voucherId}/cancel`, { revision: 1 }], [`/api/companies/${companyId}/vouchers/${voucherId}/delete`, { revision: 1 }],
    [`/api/companies/${companyId}/trial-balance?from=2026-01-01&to=2026-02-03`], [`/api/companies/${companyId}/ledgers/${cash}/balance?from=2026-01-01&to=2026-02-03`],
  ];
  for (const [path, body] of attempts) {
    const response = await intruder.browser.call(path, body);
    assert.equal(response.status, 404, path);
    assert.deepEqual(response.body, { error: companyNotFound, code: 'not_found' }, path);
  }
  assert.deepEqual(await Promise.all(ledgerTables.map(table => rowCount(database.adminUrl, table, companyId))), before, 'nothing was written');
});

test('a viewer reads the books but cannot write; a cross-origin post is refused before any work', async () => {
  const viewer = await invite(owner.browser, companyId, 'viewer');
  assert.equal((await viewer.browser.call(`/api/companies/${companyId}/ledgers`)).status, 200);
  assert.equal((await viewer.browser.call(`/api/companies/${companyId}/trial-balance?from=2026-01-01&to=2026-02-03`)).status, 200);
  const before = await Promise.all(ledgerTables.map(table => rowCount(database.adminUrl, table, companyId)));
  const body = voucherBody(books.type('receipt'), '2026-02-05', [[L('Trade Sales'), 'Cr', '1'], [L('Cash'), 'Dr', '1']]);
  for (const [path, payload] of [[`/api/companies/${companyId}/vouchers`, body], [`/api/companies/${companyId}/ledgers`, { name: 'Viewer Ledger', groupId: books.group('capital') }],
    [`/api/companies/${companyId}/groups/${books.group('capital')}`, { name: 'Viewer Capital', revision: 1 }]] as const) {
    assert.deepEqual(await viewer.browser.call(path, payload), { status: 404, body: { error: companyNotFound, code: 'not_found' } }, path);
  }
  for (const origin of ['https://elsewhere.example', null]) {
    const forged = await owner.browser.call(`/api/companies/${companyId}/vouchers`, { ...body, idempotencyKey: `forged-${randomUUID()}` }, origin);
    assert.equal(forged.status, 403);
  }
  assert.deepEqual(await Promise.all(ledgerTables.map(table => rowCount(database.adminUrl, table, companyId))), before, 'nothing was written');
});

test('hand-written SQL as the application role without company context sees and writes nothing', async () => {
  const { pool } = getDatabase();
  for (const table of ledgerTables) {
    assert.ok(await rowCount(database.adminUrl, table, companyId) > 0 || table === 'voucher_counter', `${table} has rows`);
    assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0, `${table} is invisible without context`);
  }
  assert.equal((await pool.query(`UPDATE ledger SET name = 'Taken' WHERE company_id = $1`, [companyId])).rowCount, 0);
  assert.equal((await pool.query('DELETE FROM voucher_line WHERE company_id = $1', [companyId])).rowCount, 0);
  await assert.rejects(pool.query(`INSERT INTO account_group (company_id, nature, name) VALUES ($1, 'asset', 'Smuggled')`, [companyId]), (error: unknown) => (error as { code?: string }).code === '42501');
  await assert.rejects(pool.query('SELECT ledger_seed_company($1)', [companyId]), (error: unknown) => (error as { code?: string }).code === '42501', 'seeding outside the scope is refused by the policy');
});
