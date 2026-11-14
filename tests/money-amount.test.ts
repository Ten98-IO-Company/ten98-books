import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMoney } from '@ten98/runtime/browser';
import { normalizeAmountInput } from '../src/lib/money.ts';

test('thousands separators are accepted only between exact groups of three digits and are removed', () => {
  assert.equal(normalizeAmountInput('1,250.5'), '1250.5');
  assert.equal(normalizeAmountInput('1,250,000'), '1250000');
  assert.equal(normalizeAmountInput('999'), '999');
  assert.equal(normalizeAmountInput('  12.50 '), '12.50');
  assert.equal(normalizeAmountInput('0.005'), '0.005');
});

test('anything else is refused rather than guessed', () => {
  for (const text of ['12,50', '1,25', ',250', '1,2345', '1250,000', '1,250,00', '1.234,5', '1,250.', '.5', '-5', '1e3', 'abc', '', '1 250', '١٢٣']) {
    assert.equal(normalizeAmountInput(text), null, JSON.stringify(text));
  }
});

test('a normalised amount goes through parseMoney with the company exponent and never rounds', () => {
  assert.equal(parseMoney(normalizeAmountInput('1,250.500') as string, 3), 1250500n);
  assert.throws(() => parseMoney(normalizeAmountInput('1,250.5005') as string, 3));
});
