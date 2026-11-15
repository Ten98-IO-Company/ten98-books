import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currencyAlterInput, currencyCreateInput, exchangeRatesInput, rateText, ratesQuery } from '../src/lib/currencies.ts';
import { ledgerAlterInput, ledgerCreateInput } from '../src/lib/ledger.ts';

const ok = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;

test('a rate is digits, more than zero, at most 10 before the point and 4 after it', () => {
  for (const rate of ['3.6725', '3.70', '1', '0.0001', '1234567890.1234', '12.0503']) assert.equal(ok(rateText, rate), true, rate);
  for (const rate of ['0', '0.0000', '-3.67', '3.67255', '12345678901', '3.', '.5', '3,67', ' 3.67', '1e3', '']) assert.equal(ok(rateText, rate), false, rate);
});

test('a currency: a three-letter code in capitals, 0, 2 or 3 decimals, a symbol and a formal name', () => {
  const usd = { code: 'USD', symbol: '$', formalName: 'US Dollar', decimals: 2 };
  assert.deepEqual(currencyCreateInput.parse(usd), { ...usd, isoCode: null });
  assert.equal(currencyCreateInput.parse({ ...usd, symbol: ' $ ' }).symbol, '$', 'symbols are trimmed');
  for (const decimals of [0, 2, 3]) assert.equal(ok(currencyCreateInput, { ...usd, decimals }), true, String(decimals));
  for (const [change, what] of [[{ code: 'usd' }, 'small letters'], [{ code: 'US' }, 'two letters'], [{ code: 'US1' }, 'a digit'], [{ decimals: 1 }, 'one decimal'],
    [{ decimals: 4 }, 'four decimals'], [{ decimals: 2.5 }, 'a fraction'], [{ symbol: '  ' }, 'a blank symbol'], [{ formalName: '' }, 'no formal name'],
    [{ isoCode: 'us' }, 'an ISO code in small letters'], [{ extra: true }, 'an unknown field']] as const) {
    assert.equal(ok(currencyCreateInput, { ...usd, ...change }), false, what);
  }
  assert.equal(ok(currencyAlterInput, { symbol: '$', formalName: 'US Dollar', decimals: 2, revision: 1 }), true);
  assert.equal(ok(currencyAlterInput, { code: 'USD', symbol: '$', formalName: 'US Dollar', decimals: 2, revision: 1 }), false, 'the code is not altered');
  assert.equal(currencyAlterInput.parse({ symbol: '$', formalName: 'US Dollar', decimals: 2, revision: 1 }).isoCode, undefined, 'an omitted ISO code is kept');
  assert.equal(currencyAlterInput.parse({ symbol: '$', formalName: 'US Dollar', decimals: 2, isoCode: null, revision: 1 }).isoCode, null, 'null clears it');
});

test('a rates write names each currency once; a kind takes a rate, null or nothing', () => {
  const body = { date: '2026-03-01', rates: [{ currency: 'USD', standard: '3.70', selling: null }] };
  assert.deepEqual(exchangeRatesInput.parse(body), body);
  assert.equal(ok(exchangeRatesInput, { ...body, rates: [] }), false, 'at least one currency');
  assert.equal(ok(exchangeRatesInput, { ...body, rates: [{ currency: 'USD' }, { currency: 'USD', buying: '3.69' }] }), false, 'a currency twice');
  assert.equal(ok(exchangeRatesInput, { ...body, rates: [{ currency: 'USD', average: '3.70' }] }), false, 'an unknown kind');
  assert.equal(ok(exchangeRatesInput, { ...body, date: '2026-02-30' }), false, 'not a real date');
  assert.equal(ok(ratesQuery, { date: '2026-02-15' }), true);
  assert.equal(ok(ratesQuery, { date: '2026-02-15', kind: 'standard' }), false);
});

test('a ledger body takes an optional currency code', () => {
  const ledger = { name: 'USD Bank', groupId: '0190a4a6-0000-7000-8000-000000000001' };
  assert.equal(ledgerCreateInput.parse({ ...ledger, currency: 'USD' }).currency, 'USD');
  assert.equal(ledgerCreateInput.parse(ledger).currency, undefined, 'the base when left out');
  assert.equal(ok(ledgerCreateInput, { ...ledger, currency: 'usd' }), false);
  assert.equal(ok(ledgerAlterInput, { ...ledger, currency: 'EUR', revision: 2 }), true);
});
