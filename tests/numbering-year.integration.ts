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

test('observed: entry order, back-dating, a date moved across the year, and deleting a year\'s highest number', async () => {
  const books = await company('Observed Sequence');
  const alter = async (voucher: any, date: string) => {
    const read = (await owner.browser.call(`/api/companies/${books.id}/vouchers/${voucher.id}`)).body.voucher;
    const altered = await owner.browser.call(`/api/companies/${books.id}/vouchers/${voucher.id}`, alterBody(read, { date }));
    assert.equal(altered.status, 200, JSON.stringify(altered.body));
    return altered.body.voucher;
  };
  // Entry order E1..E7; E5 and E7 are back-dated after the second year began.
  const entered: any[] = [];
  for (const date of ['2026-03-01', '2026-06-01', '2027-01-05', '2027-02-01', '2026-12-20', '2027-03-01', '2026-12-28']) entered.push(await books.pay(date));
  assert.deepEqual(entered.map(voucher => voucher.number), [1, 2, 1, 2, 3, 3, 4]);
  // Across the boundary a voucher takes the next free number of the new year and leaves a gap; inside its year it stays.
  const e3 = await alter(entered[2], '2026-12-30');
  assert.deepEqual([e3.number, e3.date], [5, '2026-12-30'], 'year 2 number 1 becomes year 1 number 5');
  const e2 = await alter(entered[1], '2027-01-15');
  assert.deepEqual([e2.number, e2.date], [4, '2027-01-15'], 'year 1 number 2 becomes year 2 number 4');
  const e5 = await alter(entered[4], '2026-01-02');
  assert.deepEqual([e5.number, e5.date], [3, '2026-01-02'], 'inside its year the number stays');
  const live = async (period: string) => (await stored(books.id)).filter(row => row.period === period && !row.deleted).map(row => row.number).sort((a, b) => a! - b!);
  assert.deepEqual([await live('2026-01-01'), await live('2027-01-01')], [[1, 3, 4, 5], [2, 3, 4]], 'gaps at 2026 #2 and 2027 #1, no duplicate');
  // The highest number of year 1 is deleted: the counter never goes back.
  assert.equal((await owner.browser.call(`/api/companies/${books.id}/vouchers/${e3.id}/delete`, { revision: e3.revision })).status, 200);
  assert.equal((await books.pay('2026-12-31')).number, 6);
  assert.equal((await books.pay('2026-02-01')).number, 7, 'an earlier date still takes the next number');
  assert.equal((await books.pay('2027-04-01')).number, 5);
  // The database refuses a date moved across the boundary without the new year's number.
  await assert.rejects(asApp(books.id, client => client.query(`UPDATE voucher SET date = '2027-06-01' WHERE company_id = $1 AND id = $2`, [books.id, entered[0].id])),
    code('23514', 'voucher_number_period'));
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

test('observed: a financial year from 1 April restarts on 1 April, not 1 January', async () => {
  const books = await company('April Trading', { financialYearStart: { month: 4, day: 1 }, booksBeginning: '2026-04-01' });
  const numbers = [];
  for (const date of ['2026-05-01', '2026-12-31', '2027-01-02', '2027-03-31', '2027-02-01', '2027-04-01', '2027-04-20', '2028-03-31', '2028-04-01']) numbers.push((await books.pay(date)).number);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 1, 2, 3, 1]);
  assert.deepEqual(await counters(books.id), [{ period: '2026-04-01', last: 5 }, { period: '2027-04-01', last: 3 }, { period: '2028-04-01', last: 1 }]);
});

test('every voucher type starts with one stored restart rule: its financial year start, 1, yearly; other rules are refused for now', async () => {
  const books = await company('Rule Trading', { financialYearStart: { month: 4, day: 1 }, booksBeginning: '2026-10-15' });
  const rules = await asAdmin(database.adminUrl, admin => admin.query(`SELECT to_char(applicable_from, 'YYYY-MM-DD') AS "from", starting_number AS start, periodicity, count(*) OVER () AS rows
    FROM voucher_numbering_restart WHERE company_id = $1 AND voucher_type_id = $2`, [books.id, books.books.type('payment')]));
  assert.deepEqual(rules.rows, [{ from: '2026-04-01', start: 1, periodicity: 'yearly', rows: '1' }], 'the start of the financial year in which the books begin');
  assert.equal(Number((await asAdmin(database.adminUrl, admin => admin.query('SELECT count(*) FROM voucher_numbering_restart WHERE company_id = $1', [books.id]))).rows[0].count), 8, 'one per voucher type');
  const add = (periodicity: string, from: string) => asApp(books.id, client => client.query(
    `INSERT INTO voucher_numbering_restart (company_id, voucher_type_id, series, applicable_from, starting_number, periodicity) VALUES ($1, $2, 'main', $3, 1, $4)`,
    [books.id, books.books.type('payment'), from, periodicity]));
  for (const periodicity of ['daily', 'weekly', 'monthly', 'never']) {
    await assert.rejects(add(periodicity, '2026-06-01'), (error: unknown) => code('23514', 'voucher_numbering_restart_periodicity')(error) && /only yearly/.test(String((error as Error).message)), periodicity);
  }
  await assert.rejects(add('yearly', '2026-06-01'), code('23514', 'voucher_numbering_restart_fixed'));
  await assert.rejects(asApp(books.id, client => client.query('DELETE FROM voucher_numbering_restart WHERE company_id = $1', [books.id])), code('42501'));
  // Observed with books beginning 15 October of an April year: the periods are financial years.
  const numbers = [];
  for (const date of ['2026-10-20', '2027-03-31', '2027-04-01', '2027-10-16']) numbers.push((await books.pay(date)).number);
  assert.deepEqual(numbers, [1, 2, 1, 2]);
  assert.deepEqual((await counters(books.id)).map(row => row.period), ['2026-04-01', '2027-04-01']);
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
    numberRefusal, 'a number keeps its period while its date stays');
  await assert.rejects(asApp(books.id, client => client.query(`UPDATE voucher SET date = '2027-03-01', number = 9, number_period = '2027-01-01' WHERE company_id = $1 AND id = $2`, [books.id, numbered.id])),
    numberRefusal, 'a date moved across the year with a number its new counter did not issue');
  await assert.rejects(asApp(books.id, client => client.query(`UPDATE voucher SET number = NULL, number_period = NULL WHERE company_id = $1 AND id = $2`, [books.id, numbered.id])),
    code('23514', 'voucher_lifecycle'), 'a number is never removed');
  for (const [period, first] of [['2029-01-01', 2], ['2029-02-01', 1]] as const) {
    await assert.rejects(asApp(books.id, client => client.query(`INSERT INTO voucher_counter (company_id, voucher_type_id, series, period_start, last_number) VALUES ($1, $2, 'main', $3, $4)`, [books.id, type, period, first])),
      code('23514', 'voucher_counter_sequence'), `a counter must start at its period's first day and starting number (${period}, ${first})`);
  }
  await assert.rejects(asApp(books.id, client => client.query(`UPDATE voucher_counter SET period_start = '2027-01-01' WHERE company_id = $1 AND voucher_type_id = $2`, [books.id, type])),
    code('23514', 'voucher_counter_sequence'), 'a counter keeps its period');
  await assert.rejects(asApp(books.id, client => client.query(`UPDATE voucher SET number_period = '2026-01-01' WHERE company_id = $1 AND id = $2`, [books.id, optional2026.id])),
    code('23514', 'voucher_number_period_set'), 'a period without a number');
  await assert.rejects(asApp(books.id, client => client.query(`INSERT INTO voucher_counter (company_id, voucher_type_id, series, period_start, last_number) VALUES ($1, $2, 'main', '2028-01-01', 1)`, [books.id, type])),
    code('23514', 'voucher_counter_sequence'), 'a counter that issues a number without a voucher');
  // The financial year start shapes every period, so it is fixed once numbering depends on it; the settings that shape
  // the books are not writable by the application role at all.
  await assert.rejects(asAdmin(database.adminUrl, admin => admin.query('UPDATE company SET fy_start_month = 4, fy_start_day = 1 WHERE company_id = $1', [books.id])),
    code('23514', 'company_financial_year_fixed'), 'the financial year start, even for a role that may write it');
  for (const column of ['fy_start_month = 4, fy_start_day = 1', "base_currency = 'SAR'", 'currency_minor_units = 3', "books_beginning = '2026-02-01'"]) {
    await assert.rejects(asApp(books.id, client => client.query(`UPDATE company SET ${column} WHERE company_id = $1`, [books.id])), code('42501'), column);
  }
  await asApp(books.id, client => client.query("UPDATE company SET time_zone = 'Asia/Riyadh', second_language_name = NULL WHERE company_id = $1", [books.id]));
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

test('an invoice with a credit-period bill moved into the next year takes that year\'s number and its due date follows the new date', async () => {
  const books = await company('Moved Invoice');
  const call = (path: string, body?: unknown) => owner.browser.call(`/api/companies/${books.id}${path}`, body);
  const party = await addLedger(owner.browser, books.id, 'Moving Customer', books.books.group('receivables'));
  const sales = await addLedger(owner.browser, books.id, 'Sales', books.books.group('sales'));
  const lines = (name: string) => [{ ledgerId: party, side: 'Dr', amount: '100', bills: [{ kind: 'new_ref', name, amount: '100', creditPeriod: { count: 30, unit: 'day' } }] }, { ledgerId: sales, side: 'Cr', amount: '100' }];
  const invoice = (date: string, name: string) => call('/vouchers', { ...voucherBody(books.books.type('sales'), date, []), lines: lines(name) });
  const december = (await invoice('2026-12-10', 'INV-A')).body.voucher;
  assert.equal((await invoice('2027-01-05', 'INV-B')).body.voucher.number, 1);
  const moved = await call(`/vouchers/${december.id}`, { date: '2027-01-20', narration: null, status: 'regular', postDated: false, reference: null, referenceDate: null, revision: december.revision, lines: lines('INV-A') });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.voucher.number, moved.body.voucher.date, moved.body.voucher.lines[0].bills[0].dueDate], [2, '2027-01-20', '2027-02-19']);
  assert.deepEqual(await counters(books.id), [{ period: '2026-01-01', last: 1 }, { period: '2027-01-01', last: 2 }], 'number 1 of 2026 is left as a gap');
});

test('an unnamed new reference stays on the bill its line created, through later alters and further period moves', async () => {
  const books = await company('Bill Keeps Name');
  const call = (path: string, body?: unknown) => owner.browser.call(`/api/companies/${books.id}${path}`, body);
  const party = await addLedger(owner.browser, books.id, 'Named Customer', books.books.group('receivables'));
  const other = await addLedger(owner.browser, books.id, 'Other Customer', books.books.group('receivables'));
  const sales = await addLedger(owner.browser, books.id, 'Sales', books.books.group('sales'));
  const partyLine = (ledgerId: string, bills: unknown[] = [{ kind: 'new_ref', amount: '100' }]) => ({ ledgerId, side: 'Dr', amount: '100', bills });
  const salesLine = { ledgerId: sales, side: 'Cr', amount: '100' };
  const post = (date: string, ledgerId: string) => call('/vouchers', { ...voucherBody(books.books.type('sales'), date, []), lines: [partyLine(ledgerId), salesLine] }).then(response => response.body.voucher);
  const alter = async (voucher: any, changes: Record<string, unknown>) => {
    const response = await call(`/vouchers/${voucher.id}`, { date: voucher.date, narration: voucher.narration, status: 'regular', postDated: false, reference: null, referenceDate: null,
      revision: voucher.revision, lines: [partyLine(voucher.lines.find((line: any) => line.side === 'Dr').ledgerId), salesLine], ...changes });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return { voucher: response.body.voucher, warnings: response.body.warnings.map((item: any) => item.code) };
  };
  const bill = (voucher: any) => { const row = voucher.lines.find((line: any) => line.side === 'Dr').bills[0]; return [voucher.number, row?.billName, row?.billId]; };
  const december = await post('2026-12-10', party);
  const billId = december.lines[0].bills[0].billId;
  assert.deepEqual(bill(december), [1, '1', billId]);
  assert.equal((await post('2027-01-05', other)).number, 1);
  assert.equal((await post('2028-01-05', other)).number, 1);

  const moved = await alter(december, { date: '2027-01-20' });
  assert.deepEqual([bill(moved.voucher), moved.warnings], [[2, '1', billId], []], 'the move gives number 2 and keeps bill "1"');
  const narrated = await alter(moved.voucher, { narration: 'Checked' });
  assert.deepEqual([bill(narrated.voucher), narrated.warnings], [[2, '1', billId], []], 'a later alter inside the year keeps bill "1"');
  const again = await alter(narrated.voucher, { date: '2028-02-01' });
  assert.deepEqual([bill(again.voucher), again.warnings], [[2, '1', billId], []], 'a second move into 2028 keeps bill "1"');
  const reordered = await alter(again.voucher, { lines: [salesLine, partyLine(party)] });
  assert.deepEqual([bill(reordered.voucher), reordered.warnings], [[2, '1', billId], []], 'reordered lines match the bill by ledger');
  const typed = await alter(reordered.voucher, { lines: [partyLine(party, [{ kind: 'new_ref', name: 'X-9', amount: '100' }]), salesLine] });
  assert.deepEqual([bill(typed.voucher).slice(0, 2), typed.voucher.lines[0].bills[0].billId === billId], [[2, 'X-9'], false], 'a name the client sends wins');

  // A changed party falls back to the number, and so does a line that never had a bill.
  const plain = await post('2028-03-01', other);
  const switched = await alter(plain, { lines: [partyLine(party), salesLine] });
  assert.deepEqual(bill(switched.voucher).slice(0, 2), [3, '3'], 'another ledger names its bill by the number');
  const onAccount = (await call('/vouchers', { ...voucherBody(books.books.type('sales'), '2028-03-02', []), lines: [partyLine(other, []), salesLine] })).body.voucher;
  assert.equal(onAccount.lines[0].bills.length, 0);
  const firstBill = await alter(onAccount, {});
  assert.deepEqual(bill(firstBill.voucher).slice(0, 2), [4, '4'], 'a line without a bill before names it by the number');
});
