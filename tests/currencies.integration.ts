import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { companyNotFound } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, invite, post, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * Currencies and dated rates over the API (M2a currencies, slice a): the master, symbol and code clashes, the base row,
 * the rate lists and the rate in force on a date, the locked period, a currency on ledgers, tenancy and the revision log.
 * The database's own refusals are in currencies-guards.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('currencies');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

/** A company and a member who writes in it (each member has its own write allowance). */
async function books(name: string, member?: Member) {
  const companyId = await createCompany(owner.browser, { name });
  const writer = member ?? await invite(owner.browser, companyId, 'editor');
  const accounts: Chart = await chart(owner.browser, companyId);
  const call = (path: string, body?: unknown) => writer.browser.call(`/api/companies/${companyId}${path}`, body);
  return { companyId, accounts, call, writer };
}
const code = (answer: { status: number; body: any }) => [answer.status, answer.body.code ?? null];
const usd = { code: 'USD', symbol: '$', formalName: 'US Dollar', decimals: 2 };
const kwd = { code: 'KWD', symbol: 'KD', formalName: 'Kuwaiti Dinar', decimals: 3 };
const revisions = (companyId: string, entity: string) => asAdmin(database.adminUrl, async admin =>
  (await admin.query('SELECT action, before, after FROM revision_log WHERE company_id = $1 AND entity = $2 ORDER BY id', [companyId, entity])).rows);

test('currencies are created, altered with their revision and logged; malformed ones are refused', async () => {
  const b = await books('Currency Masters', owner);
  const created = await b.call('/currencies', usd);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.currency, { code: 'USD', systemKey: null, symbol: '$', formalName: 'US Dollar', isoCode: null, decimals: 2,
    inMillions: false, symbolAfter: false, spaceBetween: false, decimalWord: null, wordsDecimals: 2, revision: 1 });
  assert.equal((await b.call('/currencies', kwd)).body.currency.decimals, 3);
  const list = (await b.call('/currencies')).body.currencies as any[];
  assert.deepEqual(list.map(row => [row.code, row.isBase, row.inUse]), [['AED', true, true], ['KWD', false, false], ['USD', false, false]]);
  const altered = await b.call('/currencies/usd', { symbol: 'US$', formalName: 'United States Dollar', isoCode: 'USD', decimals: 2, decimalWord: 'cents', revision: 1 });
  assert.equal(altered.status, 200, JSON.stringify(altered.body));
  assert.deepEqual([altered.body.currency.symbol, altered.body.currency.isoCode, altered.body.currency.decimalWord, altered.body.currency.revision], ['US$', 'USD', 'cents', 2]);
  assert.deepEqual(code(await b.call('/currencies/USD', { symbol: 'X$', formalName: 'Stale', decimals: 2, revision: 1 })), [409, 'stale_revision']);
  for (const [body, what] of [
    [{ ...usd, code: 'usd' }, 'a code in small letters'], [{ ...usd, code: 'US' }, 'a two-letter code'], [{ ...usd, code: 'USDX' }, 'a four-letter code'],
    [{ ...usd, code: 'XAA', decimals: 1 }, 'one decimal'], [{ ...usd, code: 'XAA', decimals: 4 }, 'four decimals'], [{ ...usd, code: 'XAA', decimals: 5 }, 'five decimals'],
    [{ code: 'XAA', symbol: 'xa', decimals: 2 }, 'no formal name'], [{ ...usd, code: 'XAA', symbol: '   ' }, 'a blank symbol'],
  ] as const) assert.deepEqual(code(await b.call('/currencies', body)), [400, 'validation'], what);
  const history = (await b.call('/currencies/USD/revisions')).body.revisions as any[];
  assert.deepEqual(history.map(row => [row.action, row.after.symbol]), [['create', '$'], ['alter', 'US$']]);
  assert.deepEqual(code(await b.call('/currencies/JPY')), [404, 'not_found']);
});

test('a symbol is unique under the key across every symbol and code: each clash is duplicate_name', async () => {
  const b = await books('Currency Names');
  assert.equal((await b.call('/currencies', usd)).status, 201);
  assert.equal((await b.call('/currencies', { code: 'XEU', symbol: 'EUR', formalName: 'Placeholder Euro', decimals: 2 })).status, 201);
  for (const [body, what] of [
    [{ code: 'XUS', symbol: 'usd ', formalName: 'Another', decimals: 2 }, 'a symbol equal to the code USD'],
    [{ code: 'EUR', symbol: '€', formalName: 'Euro', decimals: 2 }, 'a code equal to the symbol of XEU'],
    [{ code: 'XUD', symbol: '($)', formalName: 'Dollar Again', decimals: 2 }, 'a symbol equal to the symbol $ under the key'],
    [{ code: 'XAE', symbol: 'A.E.D', formalName: 'Dirham Again', decimals: 2 }, 'a symbol equal to the base code'],
    [usd, 'the same code again'],
  ] as const) assert.deepEqual(code(await b.call('/currencies', body)), [409, 'duplicate_name'], what);
  // Its own code as its symbol is fine, as for the seeded base row.
  assert.equal((await b.call('/currencies', { code: 'GBP', symbol: 'GBP', formalName: 'Pound Sterling', decimals: 2 })).status, 201);
  const gbp = (await b.call('/currencies/GBP')).body.currency;
  assert.deepEqual(code(await b.call('/currencies/GBP', { symbol: 'xeu', formalName: gbp.formalName, decimals: 2, revision: gbp.revision })), [409, 'duplicate_name'], 'a rename onto another code');
});

test('the base row: its symbol and formal name change, its decimals and the row itself stay, and it has no rates', async () => {
  const b = await books('Base Currency');
  const base = (await b.call('/currencies/AED')).body.currency;
  assert.deepEqual([base.systemKey, base.isBase, base.symbol, base.formalName, base.decimals], ['base', true, 'AED', 'AED', 2]);
  const renamed = await b.call('/currencies/AED', { symbol: 'Dh', formalName: 'UAE Dirham', decimals: 2, revision: base.revision });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.deepEqual(code(await b.call('/currencies/AED', { symbol: 'Dh', formalName: 'UAE Dirham', decimals: 3, revision: renamed.body.currency.revision })), [409, 'seeded_row']);
  assert.deepEqual(code(await b.call('/currencies/AED/delete', { revision: renamed.body.currency.revision })), [409, 'seeded_row']);
  assert.deepEqual(code(await b.call('/exchange-rates', { date: '2026-01-01', rates: [{ currency: 'AED', standard: '1' }] })), [400, 'validation']);
  assert.deepEqual((await b.call('/currencies/AED/rates')).body.rates, []);
});

test('rates by kind and date: the rate in force is the latest row on or before the date, each kind on its own', async () => {
  const b = await books('Rates');
  assert.equal((await b.call('/currencies', usd)).status, 201);
  const save = (date: string, rates: Record<string, unknown>) => b.call('/exchange-rates', { date, rates: [{ currency: 'USD', ...rates }] });
  const first = await save('2026-01-01', { standard: '3.6725', selling: '3.68', buying: '3.66' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal((await save('2026-03-01', { standard: '3.70' })).status, 200);
  const on = async (date: string) => ((await b.call(`/exchange-rates?date=${date}`)).body.rates.currencies as any[]).find(row => row.currency === 'USD');
  assert.deepEqual((await on('2026-02-15')).standard, { rate: '3.6725', effectiveDate: '2026-01-01', onDate: false });
  assert.deepEqual((await on('2026-03-01')).standard, { rate: '3.70', effectiveDate: '2026-03-01', onDate: true });
  assert.deepEqual(await on('2025-12-31'), { currency: 'USD', standard: null, selling: null, buying: null });
  const march = await on('2026-03-15');
  assert.deepEqual([march.standard.rate, march.selling, march.buying.rate], ['3.70', { rate: '3.68', effectiveDate: '2026-01-01', onDate: false }, '3.66'], 'kinds are independent');
  const removed = await save('2026-03-01', { standard: null });
  assert.equal(removed.status, 200);
  assert.equal((await on('2026-03-15')).standard.rate, '3.6725', 'removing the 1-Mar row brings the 1-Jan rate back');
  for (const rate of ['0', '0.0000', '-3.67', '3.67255', '12345678901', '3.', 'abc']) {
    assert.deepEqual(code(await save('2026-04-01', { standard: rate })), [400, 'validation'], rate);
  }
  assert.deepEqual((await b.call('/currencies/USD/rates')).body.rates, [
    { kind: 'standard', effectiveDate: '2026-01-01', rate: '3.6725' }, { kind: 'selling', effectiveDate: '2026-01-01', rate: '3.68' },
    { kind: 'buying', effectiveDate: '2026-01-01', rate: '3.66' }]);
  assert.deepEqual(code(await b.call('/exchange-rates', { date: '2026-04-01', rates: [{ currency: 'JPY', standard: '0.025' }] })), [400, 'not_found']);
  assert.deepEqual(code(await b.call('/exchange-rates?date=2026-02-30')), [400, 'validation']);
  // One entry per call that changed something, with that date's rows before and after.
  const logged = await revisions(b.companyId, 'exchange_rate');
  assert.deepEqual(logged.map(row => row.action), ['create', 'create', 'delete']);
  assert.deepEqual(logged[0].after, { date: '2026-01-01', rates: [
    { currency: 'USD', kind: 'standard', rate: '3.6725' }, { currency: 'USD', kind: 'selling', rate: '3.68' }, { currency: 'USD', kind: 'buying', rate: '3.66' }] });
  assert.deepEqual([logged[2].before, logged[2].after], [{ date: '2026-03-01', rates: [{ currency: 'USD', kind: 'standard', rate: '3.70' }] }, null]);
  assert.equal((await save('2026-01-01', { standard: '3.6725' })).status, 200);
  assert.equal((await revisions(b.companyId, 'exchange_rate')).length, 3, 'a call that changes nothing writes no entry');
  const changed = await save('2026-01-01', { standard: '3.6730' });
  assert.equal(changed.status, 200);
  const last = (await revisions(b.companyId, 'exchange_rate')).at(-1);
  assert.deepEqual([last.action, last.before.rates[0].rate, last.after.rates[0].rate], ['alter', '3.6725', '3.6730']);
});

test('rate rows dated in the locked period are refused; reports move with rates dated on or before the last voucher', async () => {
  const b = await books('Locked Rates');
  assert.equal((await b.call('/currencies', usd)).status, 201);
  const save = (date: string, standard: string | null) => b.call('/exchange-rates', { date, rates: [{ currency: 'USD', standard }] });
  assert.equal((await save('2026-01-31', '3.67')).status, 200);
  await asAdmin(database.adminUrl, admin => admin.query("UPDATE company SET locked_through = '2026-01-31' WHERE company_id = $1", [b.companyId]));
  assert.deepEqual(code(await save('2026-01-31', '3.68')), [409, 'locked_period'], 'changing a row in the lock');
  assert.deepEqual(code(await save('2026-01-31', null)), [409, 'locked_period'], 'removing a row in the lock');
  assert.deepEqual(code(await save('2026-01-15', '3.68')), [409, 'locked_period'], 'writing a row in the lock');
  const open = await save('2026-02-01', '3.68');
  assert.deepEqual([open.status, open.body.rates.warnings], [200, []], 'no voucher is dated on or after 1-Feb');
  const usdRow = (await b.call('/currencies/USD')).body.currency;
  assert.deepEqual(code(await b.call('/currencies/USD/delete', { revision: usdRow.revision })), [409, 'locked_period'], 'its 31-Jan row is in the lock');
  const bank = (await b.call('/ledgers', { name: 'Bank', groupId: b.accounts.group('bank_accounts') })).body.ledger.id;
  const capital = (await b.call('/ledgers', { name: 'Capital Account', groupId: b.accounts.group('capital') })).body.ledger.id;
  await post(b.writer.browser, b.companyId, b.accounts.type('journal'), '2026-03-10', [[bank, 'Dr', '100'], [capital, 'Cr', '100']]);
  assert.deepEqual((await save('2026-03-01', '3.69')).body.rates.warnings, ['rates_move_reports']);
  assert.deepEqual((await save('2026-03-10', '3.69')).body.rates.warnings, ['rates_move_reports'], 'the last voucher date itself');
  assert.deepEqual((await save('2026-03-11', '3.69')).body.rates.warnings, []);
});

test('a ledger in a foreign currency: settings and groups it cannot have, the base-only lines, and when its currency is fixed', async () => {
  const b = await books('Ledger Currency');
  assert.equal((await b.call('/currencies', usd)).status, 201);
  const bankGroup = b.accounts.group('bank_accounts');
  const bank = await b.call('/ledgers', { name: 'USD Bank', groupId: bankGroup, currency: 'USD' });
  assert.equal(bank.status, 201, JSON.stringify(bank.body));
  assert.deepEqual([bank.body.ledger.currency, bank.body.ledger.billWise, bank.body.ledger.costCentres], ['USD', false, false]);
  const debtor = await b.call('/ledgers', { name: 'USD Customer', groupId: b.accounts.group('receivables'), currency: 'USD' });
  assert.deepEqual([debtor.status, debtor.body.ledger.billWise], [201, false], 'a foreign debtor is not bill-wise by default');
  for (const [extra, what] of [[{ billWise: true }, 'bill-wise'], [{ creditPeriod: { count: 30, unit: 'day' } }, 'a credit period'],
    [{ creditDaysCheck: true }, 'the credit-days check'], [{ costCentres: true }, 'cost centres']] as const) {
    assert.deepEqual(code(await b.call('/ledgers', { name: `USD ${what}`, groupId: b.accounts.group('receivables'), currency: 'USD', ...extra })), [400, 'validation'], what);
  }
  assert.deepEqual(code(await b.call('/ledgers', { name: 'USD Sales', groupId: b.accounts.group('sales'), currency: 'USD' })), [400, 'validation'], 'under an income group');
  assert.deepEqual(code(await b.call('/ledgers', { name: 'USD Rent', groupId: b.accounts.group('indirect_expenses'), currency: 'USD', costCentres: false })), [400, 'validation'], 'under an expense group');
  const ledgers = (await b.call('/ledgers')).body.ledgers as any[];
  const pl = ledgers.find(row => row.systemKey === 'profit_and_loss');
  assert.equal(pl.currency, 'AED');
  assert.deepEqual(code(await b.call(`/ledgers/${pl.id}`, { name: pl.name, groupId: null, currency: 'USD', revision: pl.revision })), [400, 'validation'], 'the profit and loss ledger');
  assert.deepEqual(code(await b.call('/ledgers', { name: 'Yen Bank', groupId: bankGroup, currency: 'JPY' })), [400, 'not_found']);

  // A base-currency line on the USD ledger posts; a line carrying anything foreign is refused by the existing rules.
  const capital = (await b.call('/ledgers', { name: 'Owner Capital', groupId: b.accounts.group('capital') })).body.ledger.id;
  const posted = await post(b.writer.browser, b.companyId, b.accounts.type('journal'), '2026-02-01', [[bank.body.ledger.id, 'Dr', '100'], [capital, 'Cr', '100']]);
  assert.deepEqual([posted.lines[0].currency, posted.lines[0].currencyAmount, posted.lines[0].fxRate], ['AED', '100.00', '1.0000000000']);
  const foreignLine = await b.call('/vouchers', { idempotencyKey: 'foreign-line-1', voucherTypeId: b.accounts.type('journal'), date: '2026-02-01',
    lines: [{ ledgerId: bank.body.ledger.id, side: 'Dr', amount: '100', currency: 'USD', currencyAmount: '27.25' }, { ledgerId: capital, side: 'Cr', amount: '100' }] });
  assert.deepEqual(code(foreignLine), [400, 'validation']);

  const alter = async (ledgerId: string, change: Record<string, unknown>) => {
    const row = (await b.call(`/ledgers/${ledgerId}`)).body.ledger;
    return b.call(`/ledgers/${ledgerId}`, { name: row.name, groupId: row.groupId, revision: row.revision, ...change });
  };
  assert.deepEqual(code(await alter(bank.body.ledger.id, { currency: 'AED' })), [409, 'in_use'], 'a ledger with a posted line');
  const opened = (await b.call('/ledgers', { name: 'Opened Bank', groupId: bankGroup, opening: { amount: '50', side: 'Dr' } })).body.ledger.id;
  assert.deepEqual(code(await alter(opened, { currency: 'USD' })), [409, 'in_use'], 'a ledger with an opening amount');
  const billed = (await b.call('/ledgers', { name: 'Billed Party', groupId: b.accounts.group('receivables'),
    opening: { amount: '20', side: 'Dr', bills: [{ name: 'OB-1', amount: '20' }] } })).body.ledger.id;
  assert.deepEqual(code(await alter(billed, { currency: 'USD', billWise: false })), [409, 'in_use'], 'a party with opening bills');
  const fresh = (await b.call('/ledgers', { name: 'Fresh Account', groupId: b.accounts.group('current_assets') })).body.ledger.id;
  const moved = await alter(fresh, { currency: 'USD' });
  assert.deepEqual([moved.status, moved.body.ledger?.currency], [200, 'USD'], 'a ledger with nothing posted changes currency');
  const back = await alter(fresh, { currency: 'AED' });
  assert.deepEqual([back.status, back.body.ledger?.currency], [200, 'AED']);

  // While a ledger is in USD, USD keeps its decimals and stays.
  const usdRow = (await b.call('/currencies/USD')).body.currency;
  assert.equal(((await b.call('/currencies')).body.currencies as any[]).find(row => row.code === 'USD').inUse, true);
  assert.deepEqual(code(await b.call('/currencies/USD', { symbol: '$', formalName: 'US Dollar', decimals: 3, revision: usdRow.revision })), [409, 'in_use']);
  assert.deepEqual(code(await b.call('/currencies/USD/delete', { revision: usdRow.revision })), [409, 'in_use']);
  // A currency no ledger names changes its decimals and is deleted, with its rates.
  assert.equal((await b.call('/currencies', kwd)).status, 201);
  assert.equal((await b.call('/exchange-rates', { date: '2026-01-01', rates: [{ currency: 'KWD', standard: '12.0503' }] })).status, 200);
  const kd = await b.call('/currencies/KWD', { symbol: 'KD', formalName: 'Kuwaiti Dinar', decimals: 2, revision: 1 });
  assert.deepEqual([kd.status, kd.body.currency?.decimals], [200, 2]);
  assert.deepEqual((await b.call('/currencies/KWD/delete', { revision: 2 })).body, { deleted: true });
  assert.equal(await asAdmin(database.adminUrl, async admin => Number((await admin.query("SELECT count(*) FROM exchange_rate WHERE company_id = $1 AND currency = 'KWD'", [b.companyId])).rows[0].count)), 0);
  assert.deepEqual((await revisions(b.companyId, 'currency')).map(row => row.action), ['create', 'create', 'alter', 'delete']);
});

test('a cost row fixes a ledger\'s currency too', async () => {
  const b = await books('Currency Cost Rows');
  assert.equal((await b.call('/currencies', usd)).status, 201);
  assert.equal((await owner.browser.call(`/api/companies/${b.companyId}/cost-centres-setting`, { enabled: true })).status, 200);
  const category = (await b.call('/cost-categories', { name: 'Area' })).body.costCategory.id;
  const centre = (await b.call('/cost-centres', { name: 'North', categoryId: category })).body.costCentre.id;
  const asset = (await b.call('/ledgers', { name: 'Tracked Asset', groupId: b.accounts.group('current_assets'), costCentres: true })).body.ledger;
  const capital = (await b.call('/ledgers', { name: 'Capital Money', groupId: b.accounts.group('capital') })).body.ledger.id;
  const posted = await b.call('/vouchers', { idempotencyKey: 'cost-row-currency', voucherTypeId: b.accounts.type('journal'), date: '2026-02-01',
    lines: [{ ledgerId: asset.id, side: 'Dr', amount: '10', costAllocations: [{ costCentreId: centre, amount: '10' }] }, { ledgerId: capital, side: 'Cr', amount: '10' }] });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  const row = (await b.call(`/ledgers/${asset.id}`)).body.ledger;
  assert.deepEqual(code(await b.call(`/ledgers/${asset.id}`, { name: row.name, groupId: row.groupId, revision: row.revision, currency: 'USD', costCentres: false })), [409, 'in_use']);
});

test('every new route answers not_found for a company the user cannot reach; a viewer reads but cannot write', async () => {
  const b = await books('Currency Tenancy', owner);
  assert.equal((await b.call('/currencies', usd)).status, 201);
  const other = await setupOutsider();
  const base = `/api/companies/${b.companyId}`;
  const routes: [string, unknown?][] = [
    ['/currencies'], ['/currencies', kwd], ['/currencies/USD'], ['/currencies/USD', { ...usd, revision: 1 }], ['/currencies/USD/delete', { revision: 1 }],
    ['/currencies/USD/revisions'], ['/currencies/USD/rates'], ['/exchange-rates?date=2026-01-01'], ['/exchange-rates', { date: '2026-01-01', rates: [{ currency: 'USD', standard: '3.67' }] }],
  ];
  for (const [path, body] of routes) assert.deepEqual(await other.browser.call(`${base}${path}`, body), { status: 404, body: { error: companyNotFound, code: 'not_found' } }, `outsider ${path}`);
  const viewer = await invite(owner.browser, b.companyId, 'viewer');
  for (const [path, body] of routes) {
    const answer = await viewer.browser.call(`${base}${path}`, body);
    if (body === undefined) assert.equal(answer.status, 200, `viewer reads ${path}`);
    else assert.deepEqual(answer, { status: 404, body: { error: companyNotFound, code: 'not_found' } }, `viewer writes ${path}`);
  }
});

/** A member of another company only. */
async function setupOutsider(): Promise<Member> {
  const theirs = await createCompany(owner.browser, { name: 'Elsewhere Books' });
  return invite(owner.browser, theirs, 'admin');
}

test('review fixes over the API: a group holding a foreign ledger stays out of income and expense, a foreign ledger takes no opening, a symbol needs a key, equal rates write nothing', async () => {
  const b = await books('Currency Review');
  assert.equal((await b.call('/currencies', usd)).status, 201);
  // A group holding a USD ledger, moved under an expense group or given an expense nature, is refused (it answered 500).
  const group = (await b.call('/groups', { name: 'Overseas Banks', nature: 'asset' })).body.group;
  assert.equal((await b.call('/ledgers', { name: 'USD Account', groupId: group.id, currency: 'USD' })).status, 201);
  assert.deepEqual(code(await b.call(`/groups/${group.id}`, { name: group.name, parentId: b.accounts.group('indirect_expenses'), revision: group.revision })), [400, 'validation'], 'moved under an expense group');
  assert.deepEqual(code(await b.call(`/groups/${group.id}`, { name: group.name, parentId: null, nature: 'expense', revision: group.revision })), [400, 'validation'], 'given the expense nature');
  // No opening balance or opening bills on a foreign ledger until foreign openings are built.
  const receivables = b.accounts.group('receivables');
  assert.deepEqual(code(await b.call('/ledgers', { name: 'USD Opened', groupId: b.accounts.group('bank_accounts'), currency: 'USD', opening: { amount: '10', side: 'Dr' } })), [400, 'validation'], 'an opening on create');
  assert.deepEqual(code(await b.call('/ledgers', { name: 'USD Billed', groupId: receivables, currency: 'USD', opening: { amount: '10', side: 'Dr', bills: [{ name: 'OB', amount: '10' }] } })), [400, 'validation'], 'opening bills on create');
  const plain = (await b.call('/ledgers', { name: 'USD Plain', groupId: b.accounts.group('bank_accounts'), currency: 'USD' })).body.ledger;
  assert.deepEqual(code(await b.call(`/ledgers/${plain.id}`, { name: plain.name, groupId: plain.groupId, revision: plain.revision, opening: { amount: '10', side: 'Dr' } })), [400, 'validation'], 'an opening on alter');
  // A symbol of ignored characters only has an empty key.
  for (const symbol of ['...', '-', '( )']) assert.deepEqual(code(await b.call('/currencies', { code: 'XPP', symbol, formalName: 'Punctuation', decimals: 2 })), [400, 'validation'], symbol);
  // Rates compare as numbers: the same value written another way changes nothing and logs nothing.
  assert.equal((await b.call('/exchange-rates', { date: '2026-05-01', rates: [{ currency: 'USD', standard: '3.70' }] })).status, 200);
  const logged = (await revisions(b.companyId, 'exchange_rate')).length;
  for (const rate of ['3.7', '3.7000']) assert.equal((await b.call('/exchange-rates', { date: '2026-05-01', rates: [{ currency: 'USD', standard: rate }] })).status, 200, rate);
  assert.equal((await revisions(b.companyId, 'exchange_rate')).length, logged, 'no entry for an equal rate');
  assert.deepEqual((await b.call('/currencies/USD/rates')).body.rates, [{ kind: 'standard', effectiveDate: '2026-05-01', rate: '3.70' }], 'the stored text stays');
});
