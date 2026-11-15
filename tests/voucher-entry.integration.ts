import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { formatMoney, MONEY_MAX, parseMoney, subtractMoney } from '@ten98/runtime';
import { companyNotFound } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { addLedger, asAdmin, browser, chart, createCompany, inCompany, invite, post, setupOwner, type Chart, type Line, type Member } from './helpers/ledger.ts';
import { accountSide, createSaver, nextBillRow, toVoucherBody, type BillDraft, type BodyInput, type EntryLine } from '../src/lib/voucher-entry/index.ts';
import { join } from 'node:path';
import { demoRoot, loadDataset } from '../src/server/demo/dataset.ts';
import { seedDataset } from '../src/server/demo/seed.ts';
import { listLedgers } from '../src/server/ledger/masters.ts';
import { listVouchers, readVoucher } from '../src/server/ledger/vouchers.ts';

/**
 * The voucher entry reads (docs/LEDGER.md, "Voucher entry reads"): the previewed next number, the balance preview and the
 * counter ledger. Each test uses a company of its own.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('voucher_entry');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

type Books = { id: string; books: Chart; base: string; ledger: (name: string, group: string, opening?: { amount: string; side: 'Dr' | 'Cr' }) => Promise<string>; post: (kind: string, date: string, lines: Line[], extra?: Record<string, unknown>) => Promise<any> };
async function company(name: string, settings: Record<string, unknown> = {}): Promise<Books> {
  const id = await createCompany(owner.browser, { name, ...settings });
  const books = await chart(owner.browser, id);
  return {
    id, books, base: `/api/companies/${id}`,
    ledger: (ledgerName, group, opening) => addLedger(owner.browser, id, ledgerName, books.group(group), opening),
    post: (kind, date, lines, extra = {}) => post(owner.browser, id, books.type(kind), date, lines, extra),
  };
}
const ok = async (call: Promise<{ status: number; body: any }>) => {
  const answer = await call;
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
};
const counters = (companyId: string) => asAdmin(database.adminUrl, admin => admin.query<{ period: string; last: number }>(
  `SELECT to_char(period_start, 'YYYY-MM-DD') AS period, last_number AS last FROM voucher_counter WHERE company_id = $1 ORDER BY voucher_type_id, period_start`, [companyId])).then(result => result.rows);

test('the previewed number is the number then issued: back-dated, next year, after a deleted highest number; previews take nothing', async () => {
  const c = await company('Preview Numbers');
  const rent = await c.ledger('Rent', 'indirect_expenses');
  const pay = (date: string, extra: Record<string, unknown> = {}) => c.post('payment', date, [[rent, 'Dr', '10'], [c.books.ledger('Cash'), 'Cr', '10']], extra);
  const preview = (date: string) => ok(owner.browser.call(`${c.base}/voucher-types/${c.books.type('payment')}/next-number?date=${date}`));

  assert.deepEqual(await preview('2026-03-01'), { number: 1, periodStart: '2026-01-01', periodEnd: '2026-12-31' }, 'a period without a counter starts at the rule\'s number');
  await pay('2026-03-01');
  await pay('2026-06-01');
  await pay('2027-01-05');
  // Back-dated into the earlier financial year, entered after the later year began.
  assert.deepEqual(await preview('2026-02-01'), { number: 3, periodStart: '2026-01-01', periodEnd: '2026-12-31' });
  assert.equal((await pay('2026-02-01')).number, 3);
  // The next financial year, which has no counter yet, and the current one.
  assert.deepEqual(await preview('2028-01-10'), { number: 1, periodStart: '2028-01-01', periodEnd: '2028-12-31' });
  assert.equal((await pay('2028-01-10')).number, 1);
  assert.equal((await preview('2027-07-01')).number, 2);
  // Deleting the year's highest number leaves a gap: the preview, like the counter, does not go back.
  const highest = await pay('2026-12-31');
  assert.equal(highest.number, 4);
  assert.equal((await owner.browser.call(`${c.base}/vouchers/${highest.id}/delete`, { revision: highest.revision })).status, 200);
  assert.equal((await preview('2026-05-05')).number, 5);
  // Previews write and lock nothing: two previews, then a post still gives the previewed number; optional takes none.
  const before = await counters(c.id);
  const [first, second] = [await preview('2026-08-08'), await preview('2026-08-08')];
  assert.deepEqual(await counters(c.id), before, 'no counter row written by a preview');
  await pay('2026-08-01', { status: 'optional' });
  assert.equal((await preview('2026-08-08')).number, first.number, 'an optional voucher takes no number');
  assert.equal((await pay('2026-08-08')).number, second.number);
  assert.equal(second.number, 5);

  // A financial year starting in April: the period is that year.
  const april = await company('Preview April Year', { financialYearStart: { month: 4, day: 1 }, booksBeginning: '2026-04-01' });
  assert.deepEqual(await ok(owner.browser.call(`${april.base}/voucher-types/${april.books.type('journal')}/next-number?date=2027-02-01`)),
    { number: 1, periodStart: '2026-04-01', periodEnd: '2027-03-31' });
  // Malformed and unknown parameters are refused.
  for (const query of ['', '?date=2026-02-30', '?date=2026-01-01&date=2026-01-02', '?date=2026-01-01&extra=1']) {
    const answer = await owner.browser.call(`${c.base}/voucher-types/${c.books.type('payment')}/next-number${query}`);
    assert.deepEqual([answer.status, answer.body.code], [400, 'validation'], query);
  }
});

test('balance preview: the books at the date plus the draft, with a stored voucher left out when it counts', async () => {
  const c = await company('Preview Balances');
  const rent = await c.ledger('Rent', 'indirect_expenses');
  const bank = await c.ledger('Harbour Bank', 'bank_accounts', { amount: '1000', side: 'Dr' });
  const january = await c.post('payment', '2026-01-10', [[rent, 'Dr', '100'], [bank, 'Cr', '100']]);
  const february = await c.post('payment', '2026-02-10', [[rent, 'Dr', '50'], [bank, 'Cr', '50']]);
  const optional = await c.post('payment', '2026-01-15', [[rent, 'Dr', '70'], [bank, 'Cr', '70']], { status: 'optional' });
  const toCancel = await c.post('payment', '2026-01-16', [[rent, 'Dr', '80'], [bank, 'Cr', '80']]);
  assert.equal((await owner.browser.call(`${c.base}/vouchers/${toCancel.id}/cancel`, { revision: toCancel.revision })).status, 200);
  const draft = [{ ledgerId: rent, side: 'Dr', amount: '30' }, { ledgerId: bank, side: 'Cr', amount: '30' }, { ledgerId: rent, side: 'Dr', amount: '5' }, { ledgerId: bank, side: 'Cr', amount: '5' }];
  const preview = (body: Record<string, unknown>) => ok(owner.browser.call(`${c.base}/vouchers/balance-preview`, body));

  // A ledger on two lines appears once; the February voucher is after the date and does not count yet.
  assert.deepEqual(await preview({ date: '2026-01-31', lines: draft }), { balances: [{ ledgerId: rent, balance: '135.00' }, { ledgerId: bank, balance: '865.00' }] });
  assert.deepEqual(await preview({ date: '2026-01-31', voucherId: january.id, lines: draft }), { balances: [{ ledgerId: rent, balance: '35.00' }, { ledgerId: bank, balance: '965.00' }] });
  // The same figure the ledger balance read gives, once the draft is taken out.
  const stored = await ok(owner.browser.call(`${c.base}/ledgers/${bank}/balance?from=2026-01-01&to=2026-01-31`));
  assert.deepEqual([stored.balance.closingDebit, stored.balance.closingCredit], ['900.00', '0.00']);
  // Optional, cancelled and later-dated vouchers do not count, so leaving them out changes nothing.
  for (const voucher of [optional, toCancel, february]) {
    assert.deepEqual(await preview({ date: '2026-01-31', voucherId: voucher.id, lines: draft }), { balances: [{ ledgerId: rent, balance: '135.00' }, { ledgerId: bank, balance: '865.00' }] });
  }
  // On a date after February, February counts and can be left out; a credit balance is negative.
  assert.deepEqual(await preview({ date: '2026-03-01', voucherId: february.id, lines: [{ ledgerId: bank, side: 'Cr', amount: '2000' }] }), { balances: [{ ledgerId: bank, balance: '-1100.00' }] });
  // A draft that is unbalanced or breaks a voucher type's rule is still previewed; an empty draft names no ledger.
  assert.deepEqual(await preview({ date: '2026-01-31', lines: [{ ledgerId: rent, side: 'Cr', amount: '1.5' }] }), { balances: [{ ledgerId: rent, balance: '98.50' }] });
  assert.deepEqual(await preview({ date: '2026-01-31', lines: [] }), { balances: [] });

  // Lines are checked as posting checks them.
  const refused = async (body: Record<string, unknown>, status: number, code: string, message?: string) => {
    const answer = await owner.browser.call(`${c.base}/vouchers/balance-preview`, body);
    assert.deepEqual([answer.status, answer.body.code], [status, code], JSON.stringify(body));
    if (message) assert.equal(answer.body.error, message);
  };
  await refused({ date: '2026-01-31', lines: [{ ledgerId: rent, side: 'Dr', amount: '0' }] }, 400, 'validation', 'The amount on line 1 must be more than zero.');
  await refused({ date: '2026-01-31', lines: [{ ledgerId: rent, side: 'Dr', amount: '1.005' }] }, 400, 'validation');
  await refused({ date: '2026-01-31', lines: [{ ledgerId: randomUUID(), side: 'Dr', amount: '1' }] }, 400, 'not_found', 'The ledger on line 1 was not found in this company.');
  await refused({ date: '2026-01-31', voucherId: randomUUID(), lines: [] }, 400, 'not_found', 'The voucher was not found.');
  await refused({ date: '2026-01-31', lines: [{ ledgerId: rent, side: 'Dr', amount: '1', bills: [] }] }, 400, 'validation');
  await refused({ date: '2026-13-01', lines: [] }, 400, 'validation');
  assert.equal((await owner.browser.call(`${c.base}/vouchers/balance-preview`)).status, 405);
});

test('balance preview leaves out an earlier year\'s income and expense from the profit and loss ledger', async () => {
  const c = await company('Preview Earlier Year', { booksBeginning: '2025-01-01' });
  const rent = await c.ledger('Rent', 'indirect_expenses');
  const profitAndLoss = ((await owner.browser.call(`${c.base}/ledgers`)).body.ledgers as { id: string; systemKey: string | null }[]).find(row => row.systemKey === 'profit_and_loss')!.id;
  const earlier = await c.post('payment', '2025-06-01', [[rent, 'Dr', '40'], [c.books.ledger('Cash'), 'Cr', '40']]);
  const lines = [{ ledgerId: rent, side: 'Dr', amount: '1' }, { ledgerId: profitAndLoss, side: 'Cr', amount: '1' }];
  const preview = (voucherId?: string) => ok(owner.browser.call(`${c.base}/vouchers/balance-preview`, { date: '2026-03-01', lines, ...(voucherId ? { voucherId } : {}) }));
  // At a date in 2026 the 2025 rent sits in the profit and loss ledger, not in Rent.
  assert.deepEqual(await preview(), { balances: [{ ledgerId: rent, balance: '1.00' }, { ledgerId: profitAndLoss, balance: '39.00' }] });
  assert.deepEqual(await preview(earlier.id), { balances: [{ ledgerId: rent, balance: '1.00' }, { ledgerId: profitAndLoss, balance: '-1.00' }] });
  // A balance-sheet ledger of the same earlier voucher keeps it in its own balance, so it comes off there.
  const cash = c.books.ledger('Cash');
  const withCash = (voucherId?: string) => ok(owner.browser.call(`${c.base}/vouchers/balance-preview`, { date: '2026-03-01', lines: [{ ledgerId: cash, side: 'Dr', amount: '2' }], ...(voucherId ? { voucherId } : {}) }));
  assert.deepEqual(await withCash(), { balances: [{ ledgerId: cash, balance: '-38.00' }] });
  assert.deepEqual(await withCash(earlier.id), { balances: [{ ledgerId: cash, balance: '2.00' }] });
});

test('balance preview: a post-dated stored voucher counts from its own date; amounts beyond the bigint range are refused', async () => {
  const c = await company('Preview Post-dated');
  const rent = await c.ledger('Rent', 'indirect_expenses');
  const cash = c.books.ledger('Cash');
  const postDated = await c.post('payment', '2026-01-20', [[rent, 'Dr', '25'], [cash, 'Cr', '25']], { postDated: true });
  const preview = (date: string, voucherId?: string) => ok(owner.browser.call(`${c.base}/vouchers/balance-preview`, { date, lines: [{ ledgerId: rent, side: 'Dr', amount: '1' }], ...(voucherId ? { voucherId } : {}) }));
  assert.deepEqual(await preview('2026-01-19'), { balances: [{ ledgerId: rent, balance: '1.00' }] }, 'not yet counted before its date');
  assert.deepEqual(await preview('2026-01-19', postDated.id), { balances: [{ ledgerId: rent, balance: '1.00' }] });
  assert.deepEqual(await preview('2026-01-31'), { balances: [{ ledgerId: rent, balance: '26.00' }] }, 'counted from its own date');
  assert.deepEqual(await preview('2026-01-31', postDated.id), { balances: [{ ledgerId: rent, balance: '1.00' }] });

  const largest = formatMoney(MONEY_MAX, 2);
  const refused = async (lines: unknown[], message: string) => {
    const answer = await owner.browser.call(`${c.base}/vouchers/balance-preview`, { date: '2026-01-31', lines });
    assert.deepEqual([answer.status, answer.body.code, answer.body.error], [400, 'validation', message]);
  };
  await refused(Array.from({ length: 3 }, () => ({ ledgerId: rent, side: 'Dr', amount: largest })), 'The voucher total is too large.');
  // Within range as a draft, but beyond it once added to the stored balance of 25.00 Dr.
  await refused([{ ledgerId: rent, side: 'Dr', amount: largest }], 'The balance of Rent would be too large.');
});

test('balance preview minus its draft equals the ledger balance read, for every kind of ledger, in the previous year and early and late in the year', async () => {
  const c = await company('Preview Agreement', { booksBeginning: '2025-01-01' });
  const rent = await c.ledger('Rent', 'indirect_expenses');
  const fees = await c.ledger('Fees', 'indirect_income', { amount: '300', side: 'Cr' });
  const bank = await c.ledger('Harbour Bank', 'bank_accounts', { amount: '1000', side: 'Dr' });
  const cash = c.books.ledger('Cash');
  const profitAndLoss = ((await owner.browser.call(`${c.base}/ledgers`)).body.ledgers as { id: string; systemKey: string | null }[]).find(row => row.systemKey === 'profit_and_loss')!.id;
  for (const [date, lines] of [
    ['2025-03-10', [[rent, 'Dr', '40'], [bank, 'Cr', '40']]], ['2025-08-01', [[cash, 'Dr', '75'], [fees, 'Cr', '75']]],
    ['2026-01-01', [[rent, 'Dr', '12'], [cash, 'Cr', '12']]], ['2026-05-05', [[bank, 'Dr', '90'], [fees, 'Cr', '90']]],
    ['2026-09-30', [[rent, 'Dr', '7'], [bank, 'Cr', '7']]],
  ] as [string, Line[]][]) await c.post('journal', date, lines);
  const minor = (text: string) => text.startsWith('-') ? subtractMoney(0n, parseMoney(text.slice(1), 2)) : parseMoney(text, 2);
  const signedClosing = (balance: { closingDebit: string; closingCredit: string }) => subtractMoney(minor(balance.closingDebit), minor(balance.closingCredit));
  for (const date of ['2025-06-30', '2026-01-01', '2026-09-30']) {
    const yearStart = `${date.slice(0, 4)}-01-01`;
    for (const ledgerId of [rent, fees, bank, profitAndLoss, cash]) {
      const preview = await ok(owner.browser.call(`${c.base}/vouchers/balance-preview`, { date, lines: [{ ledgerId, side: 'Dr', amount: '1' }] }));
      const read = await ok(owner.browser.call(`${c.base}/ledgers/${ledgerId}/balance?from=${yearStart}&to=${date}`));
      assert.equal(subtractMoney(minor(preview.balances[0].balance), 100n), signedClosing(read.balance), `${date} ${ledgerId}`);
    }
  }
});

test('counter ledger: the most recently entered regular voucher of the type, per side; skips cancelled, optional and deleted', async () => {
  const c = await company('Counter Ledgers');
  const rent = await c.ledger('Rent', 'indirect_expenses');
  const incomes = await Promise.all(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta'].map(name => c.ledger(`${name} Income`, 'indirect_income')));
  const [alpha, beta, gamma, delta, epsilon, zeta, eta] = incomes;
  const journal = (date: string, lines: Line[], extra: Record<string, unknown> = {}) => c.post('journal', date, lines, extra);
  const counter = (ledgerId: string, kind: string, side: string) => ok(owner.browser.call(`${c.base}/ledgers/${ledgerId}/counter-ledger?voucherTypeId=${c.books.type(kind)}&side=${side}`));

  assert.deepEqual(await counter(rent, 'journal', 'Dr'), { counter: null }, 'a never-used ledger proposes nothing');
  await journal('2026-01-10', [[rent, 'Dr', '10'], [alpha, 'Cr', '10']]);
  const latest = await journal('2026-01-12', [[rent, 'Dr', '10'], [beta, 'Cr', '6'], [gamma, 'Cr', '4']]);
  const expected = { counter: { ledgerId: beta, voucherId: latest.id, voucherDate: '2026-01-12' } };
  assert.deepEqual(await counter(rent, 'journal', 'Dr'), expected, 'the first line on the other side');
  assert.deepEqual(await counter(gamma, 'journal', 'Cr'), { counter: { ledgerId: rent, voucherId: latest.id, voucherDate: '2026-01-12' } }, 'the credit side');
  assert.deepEqual(await counter(rent, 'journal', 'Cr'), { counter: null }, 'only lines on the asked side');

  // Cancelled, optional and deleted vouchers entered later are skipped.
  const cancelled = await journal('2026-01-20', [[rent, 'Dr', '1'], [delta, 'Cr', '1']]);
  assert.equal((await owner.browser.call(`${c.base}/vouchers/${cancelled.id}/cancel`, { revision: cancelled.revision })).status, 200);
  await journal('2026-01-21', [[rent, 'Dr', '1'], [epsilon, 'Cr', '1']], { status: 'optional' });
  const deleted = await journal('2026-01-22', [[rent, 'Dr', '1'], [zeta, 'Cr', '1']]);
  assert.equal((await owner.browser.call(`${c.base}/vouchers/${deleted.id}/delete`, { revision: deleted.revision })).status, 200);
  assert.deepEqual(await counter(rent, 'journal', 'Dr'), expected);
  // Another voucher type keeps its own history.
  await c.post('payment', '2026-01-25', [[rent, 'Dr', '1'], [c.books.ledger('Cash'), 'Cr', '1']]);
  assert.deepEqual(await counter(rent, 'journal', 'Dr'), expected);
  assert.equal((await counter(rent, 'payment', 'Dr')).counter.ledgerId, c.books.ledger('Cash'));
  // Most recently entered, not latest dated: a back-dated journal entered now wins.
  const backDated = await journal('2026-01-02', [[rent, 'Dr', '1'], [eta, 'Cr', '1']]);
  assert.deepEqual(await counter(rent, 'journal', 'Dr'), { counter: { ledgerId: eta, voucherId: backDated.id, voucherDate: '2026-01-02' } });

  for (const query of ['', `?voucherTypeId=${c.books.type('journal')}`, `?voucherTypeId=${c.books.type('journal')}&side=Debit`, `?voucherTypeId=x&side=Dr`]) {
    const answer = await owner.browser.call(`${c.base}/ledgers/${rent}/counter-ledger${query}`);
    assert.deepEqual([answer.status, answer.body.code], [400, 'validation'], query);
  }
});

test('viewers read all three; another company\'s company, voucher type, ledger and voucher answer as elsewhere; signed out is refused', async () => {
  const c = await company('Entry Reads Access');
  const rent = await c.ledger('Rent', 'indirect_expenses');
  const voucher = await c.post('payment', '2026-01-05', [[rent, 'Dr', '10'], [c.books.ledger('Cash'), 'Cr', '10']]);
  const paths = (base: string, typeId: string, ledgerId: string): [string, unknown][] => [
    [`${base}/voucher-types/${typeId}/next-number?date=2026-01-31`, undefined],
    [`${base}/ledgers/${ledgerId}/counter-ledger?voucherTypeId=${typeId}&side=Dr`, undefined],
    [`${base}/vouchers/balance-preview`, { date: '2026-01-31', voucherId: voucher.id, lines: [{ ledgerId, side: 'Dr', amount: '1' }] }],
  ];
  const viewer = await invite(owner.browser, c.id, 'viewer');
  for (const [path, body] of paths(c.base, c.books.type('payment'), rent)) assert.equal((await viewer.browser.call(path, body)).status, 200, path);

  // A member of another company only: every route answers like a missing company.
  const other = await company('Entry Reads Elsewhere');
  const otherRent = await other.ledger('Rent', 'indirect_expenses');
  const otherVoucher = await other.post('payment', '2026-01-05', [[otherRent, 'Dr', '10'], [other.books.ledger('Cash'), 'Cr', '10']]);
  const intruder = await invite(owner.browser, other.id, 'admin');
  for (const [path, body] of paths(c.base, c.books.type('payment'), rent)) {
    const foreign = await intruder.browser.call(path, body);
    const missing = await intruder.browser.call(path.replace(c.id, randomUUID()), body);
    assert.deepEqual(foreign, { status: 404, body: { error: companyNotFound, code: 'not_found' } }, path);
    assert.deepEqual(foreign, missing, path);
  }
  // Ids of another company inside one's own company answer as for a missing id: in the path 404, in the input 400.
  const answer = async (path: string, body?: unknown) => { const result = await owner.browser.call(path, body); return [result.status, result.body.code, result.body.error]; };
  assert.deepEqual(await answer(`${c.base}/voucher-types/${other.books.type('payment')}/next-number?date=2026-01-31`), [404, 'not_found', 'Voucher type not found.']);
  assert.deepEqual(await answer(`${c.base}/ledgers/${otherRent}/counter-ledger?voucherTypeId=${c.books.type('payment')}&side=Dr`), [404, 'not_found', 'Ledger not found.']);
  assert.deepEqual(await answer(`${c.base}/ledgers/${rent}/counter-ledger?voucherTypeId=${other.books.type('payment')}&side=Dr`), [400, 'not_found', 'The voucher type was not found.']);
  assert.deepEqual(await answer(`${c.base}/vouchers/balance-preview`, { date: '2026-01-31', lines: [{ ledgerId: otherRent, side: 'Dr', amount: '1' }] }), [400, 'not_found', 'The ledger on line 1 was not found in this company.']);
  assert.deepEqual(await answer(`${c.base}/vouchers/balance-preview`, { date: '2026-01-31', voucherId: otherVoucher.id, lines: [] }), [400, 'not_found', 'The voucher was not found.']);

  const stranger = browser();
  for (const [path, body] of paths(c.base, c.books.type('payment'), rent)) assert.equal((await stranger.call(path, body)).status, 401, path);
});

// ---- What the entry screen sends (src/lib/voucher-entry.ts) and the pending list it shows ----

const entry = (key: string, side: 'Dr' | 'Cr' | '', ledger: string, amount: string): EntryLine => ({ key, side, ledger, amount });

test('the entry screen\'s bodies post as built and read back line for line: single entry with the Account last, the contra Account receiving, bills on their lines', async () => {
  const c = await company('Entry Bodies');
  const bank = await c.ledger('Harbour Bank', 'bank_accounts', { amount: '10000', side: 'Dr' });
  const cash = c.books.ledger('Cash');
  const rent = await c.ledger('Premises Rent', 'indirect_expenses');
  const customer = await c.ledger('Customer North', 'receivables');
  const send = async (input: Omit<BodyInput, 'idempotencyKey' | 'voucherTypeId'>) => {
    const body = toVoucherBody({ ...input, idempotencyKey: `entry-${randomUUID()}`, voucherTypeId: c.books.type(input.kind) }, 2);
    const answer = await owner.browser.call(`${c.base}/vouchers`, body);
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    const read = (await ok(owner.browser.call(`${c.base}/vouchers/${answer.body.voucher.id}`))).voucher;
    return read.lines.map((line: any) => [line.ledgerId, line.side, line.amount, line.bills.map((bill: any) => [bill.kind, bill.billName, bill.amount, bill.side])]);
  };
  const base = { narration: '', bills: {} };
  assert.deepEqual(await send({ ...base, kind: 'payment', layout: 'single', account: bank, date: '2026-01-01', lines: [entry('line-1', 'Dr', rent, '4000.00'), entry('line-2', 'Dr', '', '')] }),
    [[rent, 'Dr', '4000.00', []], [bank, 'Cr', '4000.00', []]], 'particulars, then the Account for the total (the blank line is left out)');
  assert.deepEqual(await send({ ...base, kind: 'contra', layout: 'single', account: bank, date: '2026-01-04', lines: [entry('line-1', 'Cr', cash, '500.00')] }),
    [[cash, 'Cr', '500.00', []], [bank, 'Dr', '500.00', []]], 'the contra Account is debited, as the starter dataset');
  const journal: BillDraft[] = [{ key: 'b1', method: 'new_ref', bill: '', name: 'INV-1', credit: '30', amount: '300.00', side: 'Dr' }];
  assert.deepEqual(await send({ ...base, kind: 'journal', layout: 'double', account: '', date: '2026-01-07', bills: { 'line-1': journal },
    lines: [entry('line-1', 'Dr', customer, '300.00'), entry('line-2', 'Cr', rent, '300.00'), entry('line-3', 'Dr', '', '')] }),
    [[customer, 'Dr', '300.00', [['new_ref', 'INV-1', '300.00', 'Dr']]], [rent, 'Cr', '300.00', []]]);
  const pending = (await ok(owner.browser.call(`${c.base}/ledgers/${customer}/bills?asOf=2026-01-12&scope=pending&sort=name`))).bills;
  const receipt: BillDraft[] = [{ key: 'b1', method: 'against_ref', bill: pending[0].billId, name: '', credit: '', amount: '200.00', side: 'Cr' },
    { key: 'b2', method: 'on_account', bill: '', name: '', credit: '', amount: '50.00', side: 'Cr' }];
  assert.deepEqual(await send({ ...base, kind: 'receipt', layout: 'single', account: bank, date: '2026-01-12', bills: { 'line-1': receipt }, lines: [entry('line-1', 'Cr', customer, '250.00')] }),
    [[customer, 'Cr', '250.00', [['against_ref', 'INV-1', '200.00', 'Cr'], ['on_account', null, '50.00', 'Cr']]], [bank, 'Dr', '250.00', []]]);
  assert.deepEqual(await send({ ...base, kind: 'payment', layout: 'double', account: '', date: '2026-01-15', lines: [entry('line-1', 'Dr', rent, '100.00'), entry('line-2', 'Cr', cash, '100.00')] }),
    [[rent, 'Dr', '100.00', []], [cash, 'Cr', '100.00', []]]);
});

test('the pending list for entry is in the observed name order: case and hyphens ignored, text not numbers', async () => {
  const c = await company('Pending Order');
  const party = await c.ledger('Order Party', 'receivables');
  const income = await c.ledger('Order Income', 'indirect_income');
  // Entered in another order than listed, one voucher each, as the observation's bills were.
  const names = ['B-300', 'a2', '10', 'C-200', 'b3', 'A-100', '9', 'B1', 'A-020', 'B-050'];
  for (const name of names) {
    const answer = await owner.browser.call(`${c.base}/vouchers`, { idempotencyKey: `order-${randomUUID()}`, voucherTypeId: c.books.type('journal'), date: '2026-07-01',
      lines: [{ ledgerId: party, side: 'Dr', amount: '1', bills: [{ kind: 'new_ref', name, amount: '1' }] }, { ledgerId: income, side: 'Cr', amount: '1' }] });
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
  }
  const listed = (await ok(owner.browser.call(`${c.base}/ledgers/${party}/bills?asOf=2026-07-01&scope=pending&sort=name`))).bills.map((bill: any) => bill.name);
  assert.deepEqual(listed, ['10', '9', 'A-020', 'A-100', 'a2', 'B-050', 'B1', 'b3', 'B-300', 'C-200']);
});

test('round 2, item 11: the screen\'s bodies for the twelve starter vouchers store exactly what a full seed stores, row for row', async () => {
  const starter = await loadDataset(join(demoRoot, 'starter-trading'));
  const full = await seedDataset(owner.userId, starter);
  const copy = await seedDataset(owner.userId, starter, true, 'Entry shape copy');
  const ledgers = await inCompany(owner.userId, copy.companyId, listLedgers);
  const types = (await ok(owner.browser.call(`/api/companies/${copy.companyId}/voucher-types`))).voucherTypes as { id: string; kind: string; systemKey: string | null }[];
  const nameOf = new Map(starter.ledgers.map(ledger => [ledger.key, ledger.name]));
  const ledgerId = (key: string) => ledgers.find(ledger => ledger.name === nameOf.get(key))!.id;
  const cashOrBank = (id: string) => ledgers.find(ledger => ledger.id === id)?.cashOrBank === true;
  const slice = starter.vouchers.filter(voucher => ['payment', 'receipt', 'contra', 'journal'].includes(voucher.type));
  assert.equal(slice.length, 12);
  for (const voucher of slice) {
    const kind = voucher.type as 'payment' | 'receipt' | 'contra' | 'journal';
    const lines = voucher.lines.map((line, index) => ({ key: `line-${index + 1}`, side: line.side as 'Dr' | 'Cr', ledger: ledgerId(line.ledger), amount: line.amount }));
    // As the screen keys them (Part B): single entry with the Account on its side; a journal in double entry.
    const account = kind === 'journal' ? undefined : lines.find(line => line.side === accountSide(kind) && cashOrBank(line.ledger));
    const draft = account ? { kind, layout: 'single' as const, account: account.ledger, lines: lines.filter(line => line !== account) } : { kind, layout: 'double' as const, account: '', lines };
    // Each bill-wise line gets the panel's default rows, as accepted with Enter.
    const bills: Record<string, BillDraft[]> = {};
    for (const line of draft.lines) {
      if (!ledgers.find(ledger => ledger.id === line.ledger)?.billWise) continue;
      const pending = ((await ok(owner.browser.call(`/api/companies/${copy.companyId}/ledgers/${line.ledger}/bills?asOf=${voucher.date}&scope=pending&sort=name`))).bills as any[])
        .map(bill => ({ ...bill, pending: parseMoney(bill.pending, 2), finalPending: parseMoney(bill.finalPending, 2) }));
      const side = draft.layout === 'single' ? (accountSide(kind) === 'Dr' ? 'Cr' : 'Dr') : line.side;
      bills[line.key] = [nextBillRow({ kind, lineSide: side, lineAmount: parseMoney(line.amount, 2), rows: [], pending, exponent: 2, key: 'b1' })];
    }
    const typeId = types.find(type => type.kind === kind && type.systemKey !== null)!.id;
    const body = toVoucherBody({ ...draft, idempotencyKey: `shape-${randomUUID()}`, voucherTypeId: typeId, date: voucher.date, narration: voucher.narration ?? '', bills }, 2);
    const answer = await owner.browser.call(`/api/companies/${copy.companyId}/vouchers`, body);
    assert.equal(answer.status, 201, `${voucher.key}: ${JSON.stringify(answer.body)}`);
  }
  const stored = async (companyId: string) => inCompany(owner.userId, companyId, async context => {
    const page = await listVouchers(context, { from: '2026-01-01', to: '2026-12-31', limit: 500 });
    const read = await Promise.all(page.vouchers.filter(voucher => ['payment', 'receipt', 'contra', 'journal'].includes(voucher.kind)).map(voucher => readVoucher(context, voucher.id)));
    return read.map(voucher => ({ kind: voucher.kind, date: voucher.date, number: voucher.number, narration: voucher.narration,
      lines: voucher.lines.map(line => ({ ledger: line.ledgerName, side: line.side, amount: line.amount, bills: line.bills.map(bill => ({ kind: bill.kind, name: bill.billName, side: bill.side, amount: bill.amount })) })) }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  });
  assert.deepEqual(await stored(copy.companyId), await stored(full.companyId));
});

test('round 2, item 12: the balance preview also reports the ledgers named in `ledgers`, signed and with the draft applied, each once; a draft without lines is allowed', async () => {
  const c = await company('Preview Named Ledgers');
  const bank = await c.ledger('Named Bank', 'bank_accounts', { amount: '1000', side: 'Dr' });
  const rent = await c.ledger('Named Rent', 'indirect_expenses');
  const cash = c.books.ledger('Cash');
  await c.post('payment', '2026-01-05', [[rent, 'Dr', '250'], [bank, 'Cr', '250']]);
  const preview = (body: unknown, member: Member = owner) => member.browser.call(`${c.base}/vouchers/balance-preview`, body);
  // The Account before its first line: no lines, the bank named; its balance as the ledger balance read gives it.
  const alone = await preview({ date: '2026-01-31', lines: [], ledgers: [bank] });
  assert.equal(alone.status, 200, JSON.stringify(alone.body));
  assert.deepEqual(alone.body, { balances: [{ ledgerId: bank, balance: '750.00' }] });
  const read = (await ok(owner.browser.call(`${c.base}/ledgers/${bank}/balance?from=2026-01-01&to=2026-01-31`))).balance;
  assert.equal(formatMoney(subtractMoney(parseMoney(read.closingDebit, 2), parseMoney(read.closingCredit, 2)), 2), '750.00', 'the same figure as the balance read');
  // With lines: each ledger once, the lines' first, then the named; the draft applied to a ledger named in both.
  const both = await ok(preview({ date: '2026-01-31', lines: [{ ledgerId: rent, side: 'Dr', amount: '50' }, { ledgerId: bank, side: 'Cr', amount: '50' }], ledgers: [bank, cash, bank] }));
  assert.deepEqual(both.balances, [{ ledgerId: rent, balance: '300.00' }, { ledgerId: bank, balance: '700.00' }, { ledgerId: cash, balance: '0.00' }]);
  // A body without `ledgers` behaves as before.
  assert.deepEqual((await ok(preview({ date: '2026-01-31', lines: [{ ledgerId: rent, side: 'Dr', amount: '50' }] }))).balances, [{ ledgerId: rent, balance: '300.00' }]);
  assert.deepEqual((await ok(preview({ date: '2026-01-31', lines: [] }))).balances, [], 'nothing named: nothing reported');
  // An unknown id, or another company's ledger, inside `ledgers` answers as a line's ledger does: 400 not_found.
  const other = await company('Preview Named Elsewhere');
  const otherRent = await other.ledger('Elsewhere Rent', 'indirect_expenses');
  for (const ledgerId of [randomUUID(), otherRent]) {
    const answer = await preview({ date: '2026-01-31', lines: [], ledgers: [bank, ledgerId] });
    assert.deepEqual([answer.status, answer.body.code, answer.body.error], [400, 'not_found', 'Ledger 2 of the ledgers was not found in this company.']);
  }
  // Bounds: lines and ledgers together at most 500; ids validated.
  const many = Array.from({ length: 450 }, () => ({ ledgerId: rent, side: 'Dr', amount: '1' }));
  assert.equal((await preview({ date: '2026-01-31', lines: many, ledgers: Array.from({ length: 50 }, () => bank) })).status, 200);
  assert.deepEqual([(await preview({ date: '2026-01-31', lines: many, ledgers: Array.from({ length: 51 }, () => bank) })).status, (await preview({ date: '2026-01-31', lines: [], ledgers: ['not-an-id'] })).body.code], [400, 'validation']);
  // A viewer reads it; a member of another company only gets the missing company's answer.
  const viewer = await invite(owner.browser, c.id, 'viewer');
  assert.deepEqual((await preview({ date: '2026-01-31', lines: [], ledgers: [bank] }, viewer)).body, { balances: [{ ledgerId: bank, balance: '750.00' }] });
  const intruder = await invite(owner.browser, other.id, 'admin');
  assert.deepEqual(await preview({ date: '2026-01-31', lines: [], ledgers: [bank] }, intruder), { status: 404, body: { error: companyNotFound, code: 'not_found' } });
});

test('round 3, item 1: a refused body, changed, saved with its answer lost after the commit, then retried, is ONE voucher', async () => {
  const c = await company('Entry Duplicate Guard');
  const rent = await c.ledger('Guard Rent', 'indirect_expenses');
  const cash = c.books.ledger('Cash');
  let made = 0;
  const saver = createSaver<any>(() => `guard-${randomUUID()}-${++made}`, error => (error as { status?: number }).status);
  const body = (date: string) => ({ voucherTypeId: c.books.type('payment'), date, lines: [{ ledgerId: rent, side: 'Dr', amount: '10' }, { ledgerId: cash, side: 'Cr', amount: '10' }] });
  // The real server answers; `lose` throws a gateway error after the server committed, as a lost answer would.
  const send = (date: string, lose = false) => async (key: string) => {
    const answer = await owner.browser.call(`${c.base}/vouchers`, { idempotencyKey: key, ...body(date) });
    if (lose || answer.status >= 300) throw Object.assign(new Error('failed'), { status: lose ? 502 : answer.status });
    return answer.body;
  };
  const refused = await saver.save(JSON.stringify(body('2025-12-31')), send('2025-12-31'));
  assert.deepEqual([refused?.outcome, refused?.outcome !== 'saved' && refused?.status], ['refused', 400], 'before the books begin: a definite refusal');
  const lost = await saver.save(JSON.stringify(body('2026-01-05')), send('2026-01-05', true));
  assert.equal(lost?.outcome, 'unknown');
  const retried = await saver.save(JSON.stringify(body('2026-01-05')), send('2026-01-05'));
  assert.equal(retried?.outcome, 'saved');
  assert.equal(retried?.outcome === 'saved' && retried.answer.replayed, true, 'the server replays the committed voucher');
  const listed = (await ok(owner.browser.call(`${c.base}/vouchers?from=2026-01-01&to=2026-12-31`))).vouchers;
  assert.equal(listed.length, 1, 'one voucher, not two');
});
