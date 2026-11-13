import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { readAuthFragment } from '../src/lib/auth-messages.ts';
import { companyCreateInput, financialYearOf, isCalendarDate } from '../src/lib/company.ts';
import { json, toJson } from '../src/server/api/http.ts';
import { pgTypes } from '../src/server/db.ts';
import { startWhenDatabaseReady } from '../src/server/startup-migrate.ts';

const valid = { name: 'Acme Trading LLC', baseCurrency: 'OMR', financialYearStart: { month: 4, day: 1 }, booksBeginning: '2026-04-01', timeZone: 'Asia/Muscat' };

test('company input accepts a complete company and fixes nothing silently', () => {
  assert.deepEqual(companyCreateInput.parse({ ...valid, secondLanguageName: '  ' }), { ...valid, secondLanguageName: null });
  assert.equal(companyCreateInput.parse({ ...valid, timeZone: 'UTC' }).timeZone, 'UTC');
});

test('company input rejects unknown currencies, time zones, impossible dates and extra fields', () => {
  for (const change of [
    { baseCurrency: 'XYZ' }, { baseCurrency: 'omr' }, { baseCurrency: 'OMR ' },
    { timeZone: 'Mars/Olympus_Mons' }, { timeZone: 'GMT+4' }, { timeZone: '' },
    { booksBeginning: '2026-02-29' }, { booksBeginning: '2026-13-01' }, { booksBeginning: '1899-12-31' }, { booksBeginning: '2026-4-1' },
    { financialYearStart: { month: 2, day: 29 } }, { financialYearStart: { month: 4, day: 31 } }, { financialYearStart: { month: 13, day: 1 } },
    { name: '   ' }, { owner: 'someone' },
  ]) assert.equal(companyCreateInput.safeParse({ ...valid, ...change }).success, false, JSON.stringify(change));
  assert.equal(isCalendarDate('2028-02-29'), true, 'leap days are real dates');
});

test('the financial year containing a date runs from its start day to the day before the next start', () => {
  assert.deepEqual(financialYearOf({ month: 4, day: 1 }, '2026-03-31'), { from: '2025-04-01', to: '2026-03-31' });
  assert.deepEqual(financialYearOf({ month: 4, day: 1 }, '2026-04-01'), { from: '2026-04-01', to: '2027-03-31' });
  assert.deepEqual(financialYearOf({ month: 1, day: 1 }, '2026-12-31'), { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(financialYearOf({ month: 3, day: 1 }, '2028-02-29'), { from: '2027-03-01', to: '2028-02-29' });
});

test('int8 reads as bigint and DATE stays a calendar date in the application pools (D-07, D-09)', () => {
  const int8 = pgTypes.getTypeParser(pg.types.builtins.INT8, 'text') as (value: string) => unknown;
  assert.equal(int8('9007199254740993'), 9007199254740993n, 'beyond Number precision');
  const date = pgTypes.getTypeParser(pg.types.builtins.DATE, 'text') as (value: string) => unknown;
  assert.equal(date('2026-04-01'), '2026-04-01');
  const int4 = pgTypes.getTypeParser(pg.types.builtins.INT4, 'text') as (value: string) => unknown;
  assert.equal(int4('42'), 42);
});

test('API JSON writes bigint as a decimal string in one place', async () => {
  assert.equal(toJson({ amount: -123456789012345678901n, nested: [1n] }), '{"amount":"-123456789012345678901","nested":["1"]}');
  const response = json({ total: 10n }, 201, { 'set-cookie': 'a=1' });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), { total: '10' });
  assert.deepEqual(response.headers.getSetCookie(), ['a=1']);
});

test('fragment capabilities are read only in their exact shapes', () => {
  const invite = 'a'.repeat(43), reset = 'A1'.repeat(12);
  assert.deepEqual(readAuthFragment(`#invite=${invite}`), { kind: 'invite', token: invite });
  assert.deepEqual(readAuthFragment(`#password-reset=${reset}`), { kind: 'reset', token: reset });
  assert.deepEqual(readAuthFragment('#password-reset=short'), { kind: 'reset', token: null });
  for (const hash of ['', '#invite=short', `#invite=${invite}&invite=${invite}`, `#other=${invite}`]) assert.equal(readAuthFragment(hash), null, hash);
});

test('startup refuses to start when the application role check fails, after migrating', async () => {
  const steps: string[] = [];
  await assert.rejects(startWhenDatabaseReady('web', async () => { steps.push('start') }, {
    env: {}, log: () => undefined,
    migrate: async () => { steps.push('migrate'); return [] },
    assertRole: async () => { steps.push('role'); throw new Error('unsafe role') },
  }), /unsafe role/);
  assert.deepEqual(steps, ['migrate', 'role'], 'the server never starts');
});
