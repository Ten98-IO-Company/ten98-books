import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { PoolClient } from 'pg';
import { getDatabase } from '../src/server/db.ts';
import { setCompanyScope } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { addLedger, asAdmin, books as defaults, chart, createCompany, invite, post, setupOwner, voucherBody, type Chart, type Member } from './helpers/ledger.ts';

/**
 * D-04 as amended: numbers restart in each financial year of the voucher's date, per voucher type and series. Every
 * test uses a company of its own so its numbers start at 1.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('numbering_year');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

type Books = { id: string; books: Chart; rent: string; pay: (date: string, extra?: Record<string, unknown>) => Promise<any> };
async function company(name: string, settings: Partial<typeof defaults> = {}): Promise<Books> {
  const id = await createCompany(owner.browser, { name, ...settings });
  const books = await chart(owner.browser, id);
  const rent = await addLedger(owner.browser, id, 'Rent', books.group('indirect_expenses'));
  return { id, books, rent, pay: (date, extra = {}) => post(owner.browser, id, books.type('payment'), date, [[rent, 'Dr', '10'], [books.ledger('Cash'), 'Cr', '10']], extra) };
}
const alterBody = (voucher: any, changes: Record<string, unknown>) => ({
  date: voucher.date, narration: voucher.narration, status: voucher.status, postDated: voucher.postDated, reference: null, referenceDate: null, revision: voucher.revision,
  lines: voucher.lines.map((line: { ledgerId: string; side: string; amount: string }) => ({ ledgerId: line.ledgerId, side: line.side, amount: line.amount })), ...changes,
});
const code = (expected: string, constraint?: string) => (error: unknown) => {
  const { code: actual, constraint: name } = error as { code?: string; constraint?: string };
  return actual === expected && (constraint === undefined || name === constraint);
};
async function asApp(scope: string, run: (client: PoolClient) => Promise<unknown>): Promise<void> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await setCompanyScope(client, [scope]);
    await run(client);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}
const stored = (companyId: string) => asAdmin(database.adminUrl, admin => admin.query<{ number: number | null; period: string | null; date: string; deleted: boolean }>(
  `SELECT number, to_char(number_period, 'YYYY-MM-DD') AS period, to_char(date, 'YYYY-MM-DD') AS date, deleted_at IS NOT NULL AS deleted
   FROM voucher WHERE company_id = $1 ORDER BY id`, [companyId])).then(result => result.rows);
const counters = (companyId: string) => asAdmin(database.adminUrl, admin => admin.query<{ period: string; last: number }>(
  `SELECT to_char(period_start, 'YYYY-MM-DD') AS period, last_number AS last FROM voucher_counter WHERE company_id = $1 ORDER BY period_start`, [companyId])).then(result => result.rows);

test('numbers restart at 1 in the next financial year and a back-dated entry continues its own year', async () => {
  const books = await company('Restart Trading');
  const numbers = [];
  for (const date of ['2026-12-30', '2026-12-31', '2027-01-02', '2027-01-03', '2026-12-15', '2027-01-01']) numbers.push((await books.pay(date)).number);
  assert.deepEqual(numbers, [1, 2, 1, 2, 3, 3]);
  assert.deepEqual(await counters(books.id), [{ period: '2026-01-01', last: 3 }, { period: '2027-01-01', last: 3 }]);
  // Each voucher type keeps its own counters.
  const receipt = await post(owner.browser, books.id, books.books.type('receipt'), '2027-01-04', [[books.books.ledger('Cash'), 'Dr', '5'], [books.rent, 'Cr', '5']]);
  assert.equal(receipt.number, 1);
});

test('50 concurrent posts across two years number each year from 1 without gaps or duplicates', async () => {
  const books = await company('Concurrent Trading');
  const dates = Array.from({ length: 50 }, (_, index) => index % 2 ? `2027-01-${String(index % 28 + 1).padStart(2, '0')}` : `2026-12-${String(index % 28 + 1).padStart(2, '0')}`);
  const posted = await Promise.all(dates.map(date => owner.browser.call(`/api/companies/${books.id}/vouchers`,
    voucherBody(books.books.type('payment'), date, [[books.rent, 'Dr', '3'], [books.books.ledger('Cash'), 'Cr', '3']]))));
  assert.ok(posted.every(response => response.status === 201), JSON.stringify(posted.find(response => response.status !== 201)?.body));
  for (const year of ['2026', '2027']) {
    const numbers = posted.filter(response => response.body.voucher.date.startsWith(year)).map(response => response.body.voucher.number as number).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: 25 }, (_, index) => index + 1), `${year}: one to twenty-five`);
  }
  assert.deepEqual(await counters(books.id), [{ period: '2026-01-01', last: 25 }, { period: '2027-01-01', last: 25 }]);
});

test('an altered voucher keeps its number within its year; a date in another year is refused, by the API and the database', async () => {
  const books = await company('Alter Trading');
  await books.pay('2026-12-01');
  const voucher = await books.pay('2026-12-02');
  const moved = await owner.browser.call(`/api/companies/${books.id}/vouchers/${voucher.id}`, alterBody(voucher, { date: '2026-06-30' }));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.voucher.number, moved.body.voucher.date], [2, '2026-06-30']);
  const across = await owner.browser.call(`/api/companies/${books.id}/vouchers/${voucher.id}`, alterBody(moved.body.voucher, { date: '2027-01-05' }));
  assert.deepEqual([across.status, across.body.code], [409, 'voucher_state'], JSON.stringify(across.body));
  await assert.rejects(asApp(books.id, client => client.query(`UPDATE voucher SET date = '2027-01-05' WHERE company_id = $1 AND id = $2`, [books.id, voucher.id])),
    code('23514', 'voucher_number_period'));
  const read = (await owner.browser.call(`/api/companies/${books.id}/vouchers/${voucher.id}`)).body.voucher;
  assert.deepEqual([read.number, read.date, read.revision], [2, '2026-06-30', moved.body.voucher.revision], 'nothing changed');
  assert.equal((await books.pay('2027-01-05')).number, 1, 'the next year is untouched');
});

test('a deleted number is never reissued: the next voucher of that year takes the number after it', async () => {
  const books = await company('Delete Trading');
  await books.pay('2026-11-01');
  const last = await books.pay('2026-11-02');
  await books.pay('2027-01-10');
  assert.equal((await owner.browser.call(`/api/companies/${books.id}/vouchers/${last.id}/delete`, { revision: last.revision })).status, 200);
  assert.equal((await books.pay('2026-11-03')).number, 3, 'number 2 stays a gap in 2026');
  assert.equal((await books.pay('2027-01-11')).number, 2, '2027 is not affected');
  assert.deepEqual((await stored(books.id)).filter(row => row.period === '2026-01-01').map(row => [row.number, row.deleted]), [[1, false], [2, true], [3, false]]);
});

test('optional takes no number, made regular takes the next of its date\'s year; post-dated and cancelled behave per year', async () => {
  const books = await company('Status Trading');
  await books.pay('2027-01-02');
  const optional = await books.pay('2026-12-20', { status: 'optional' });
  assert.equal(optional.number, null);
  const regular = await owner.browser.call(`/api/companies/${books.id}/vouchers/${optional.id}`, alterBody(optional, { status: 'regular', date: '2027-01-10' }));
  assert.equal(regular.status, 200, JSON.stringify(regular.body));
  assert.deepEqual([regular.body.voucher.number, regular.body.voucher.date], [2, '2027-01-10'], 'numbered in the year of its new date');
  const postDated = await books.pay('2027-02-01', { postDated: true });
  assert.deepEqual([postDated.number, postDated.postDated], [3, true], 'a post-dated voucher takes its number at entry, in the year of its date');
  const cancelled = (await owner.browser.call(`/api/companies/${books.id}/vouchers/${postDated.id}/cancel`, { revision: postDated.revision })).body.voucher;
  assert.deepEqual([cancelled.status, cancelled.number], ['cancelled', 3], 'a cancelled voucher keeps its number');
  assert.equal((await books.pay('2027-02-02')).number, 4);
  assert.equal((await books.pay('2026-12-21')).number, 1, '2026 has had no number yet');
  assert.deepEqual(await counters(books.id), [{ period: '2026-01-01', last: 1 }, { period: '2027-01-01', last: 4 }]);
});

test('a company whose financial year starts in April restarts on 1 April', async () => {
  const books = await company('April Trading', { financialYearStart: { month: 4, day: 1 }, booksBeginning: '2026-04-01' });
  const numbers = [];
  for (const date of ['2027-03-30', '2027-03-31', '2027-04-01', '2026-04-01', '2028-03-31']) numbers.push((await books.pay(date)).number);
  assert.deepEqual(numbers, [1, 2, 1, 3, 2]);
  assert.deepEqual((await stored(books.id)).map(row => [row.date, row.period]), [
    ['2027-03-30', '2026-04-01'], ['2027-03-31', '2026-04-01'], ['2027-04-01', '2027-04-01'], ['2026-04-01', '2026-04-01'], ['2028-03-31', '2027-04-01']]);
});

test('numbers, periods and counters cannot be forged across years by direct SQL', async () => {
  const books = await company('Guarded Years');
  const numbered = await books.pay('2026-06-01');
  const optional2026 = await books.pay('2026-06-02', { status: 'optional' });
  const optional2027 = await books.pay('2027-02-02', { status: 'optional' });
  const type = books.books.type('payment');
  const numberRefusal = code('23514', 'voucher_numbered');
  await assert.rejects(asApp(books.id, async client => {
    await client.query(`INSERT INTO voucher_counter (company_id, voucher_type_id, series, period_start, last_number) VALUES ($1, $2, 'main', '2027-01-01', 1)`, [books.id, type]);
    await client.query(`UPDATE voucher SET status = 'regular', number = 1, number_period = '2027-01-01' WHERE company_id = $1 AND id = $2`, [books.id, optional2026.id]);
  }), numberRefusal, 'a 2026 voucher numbered from the 2027 counter');
  await assert.rejects(asApp(books.id, async client => {
    await client.query(`UPDATE voucher_counter SET last_number = last_number + 1 WHERE company_id = $1 AND voucher_type_id = $2 AND period_start = '2026-01-01'`, [books.id, type]);
    await client.query(`UPDATE voucher SET status = 'regular', number = 2, number_period = '2026-01-01' WHERE company_id = $1 AND id = $2`, [books.id, optional2027.id]);
  }), numberRefusal, 'a 2027 voucher numbered from the 2026 counter');
  await assert.rejects(asApp(books.id, client => client.query(`UPDATE voucher SET number_period = '2027-01-01' WHERE company_id = $1 AND id = $2`, [books.id, numbered.id])),
    code('23514', 'voucher_lifecycle'), 'a number keeps its period');
  await assert.rejects(asApp(books.id, client => client.query(`UPDATE voucher_counter SET period_start = '2027-01-01' WHERE company_id = $1 AND voucher_type_id = $2`, [books.id, type])),
    code('23514', 'voucher_counter_sequence'), 'a counter keeps its period');
  await assert.rejects(asApp(books.id, client => client.query(`UPDATE voucher SET number_period = '2026-01-01' WHERE company_id = $1 AND id = $2`, [books.id, optional2026.id])),
    code('23514', 'voucher_number_period_set'), 'a period without a number');
  await assert.rejects(asApp(books.id, client => client.query(`INSERT INTO voucher_counter (company_id, voucher_type_id, series, period_start, last_number) VALUES ($1, $2, 'main', '2028-01-01', 1)`, [books.id, type])),
    code('23514', 'voucher_counter_sequence'), 'a counter that issues a number without a voucher');
  assert.deepEqual(await counters(books.id), [{ period: '2026-01-01', last: 1 }]);
  assert.equal((await books.pay('2026-06-03')).number, 2, 'the API continues where it left off');
  assert.equal((await books.pay('2027-01-01')).number, 1);
});

test('another company\'s numbering is neither readable nor writable, and its own counters are separate', async () => {
  const first = await company('First Books');
  const second = await company('Second Books');
  assert.equal((await first.pay('2026-03-01')).number, 1);
  assert.equal((await second.pay('2026-03-01')).number, 1, 'each company numbers from 1');
  const outsider = await invite(owner.browser, second.id, 'editor');
  const refused = await outsider.browser.call(`/api/companies/${first.id}/vouchers`, voucherBody(first.books.type('payment'), '2026-03-02', [[first.rent, 'Dr', '1'], [first.books.ledger('Cash'), 'Cr', '1']]));
  assert.equal(refused.status, 404);
  await asApp(second.id, async client => {
    const { rows } = await client.query('SELECT ledger_numbering_period($1, $2, $3::date) AS period', [first.id, first.books.type('payment'), '2026-03-02']);
    assert.equal(rows[0].period, null, 'the other company\'s year is not visible');
  });
  await assert.rejects(asApp(second.id, client => client.query(
    `INSERT INTO voucher_counter (company_id, voucher_type_id, series, period_start, last_number) VALUES ($1, $2, 'main', '2027-01-01', 1)`, [first.id, first.books.type('payment')])),
  code('42501'));
  assert.deepEqual(await counters(first.id), [{ period: '2026-01-01', last: 1 }]);
  assert.equal((await first.pay('2026-03-02')).number, 2);
});

test('a sales bill named by the bare number joins last year\'s bill of the same name for the same party, with a warning', async () => {
  const books = await company('Bill Years');
  const call = (path: string, body?: unknown) => owner.browser.call(`/api/companies/${books.id}${path}`, body);
  const party = await addLedger(owner.browser, books.id, 'Yearly Customer', books.books.group('receivables'));
  const sales = await addLedger(owner.browser, books.id, 'Sales', books.books.group('sales'));
  const invoice = (date: string, amount: string) => call('/vouchers', { ...voucherBody(books.books.type('sales'), date, [[sales, 'Cr', amount]]),
    lines: [{ ledgerId: party, side: 'Dr', amount, bills: [{ kind: 'new_ref', amount, creditPeriod: { count: 30, unit: 'day' } }] }, { ledgerId: sales, side: 'Cr', amount }] });
  const december = await invoice('2026-12-10', '100');
  assert.equal(december.status, 201, JSON.stringify(december.body));
  const january = await invoice('2027-01-05', '40');
  assert.equal(january.status, 201, JSON.stringify(january.body));
  assert.deepEqual([december.body.voucher.number, january.body.voucher.number], [1, 1]);
  assert.deepEqual(january.body.warnings.map((item: any) => [item.code, item.billName]), [['bill_attached', '1']]);
  const bills = (await call(`/reports/party-bills/${party}?asOf=2027-01-31`)).body.report.bills;
  assert.deepEqual(bills.map((bill: any) => [bill.name, bill.pending, bill.billDate, bill.dueDate]), [['1', '140.00', '2026-12-10', '2027-01-09']],
    'one bill holding both invoices, dated and due as the first');
});
