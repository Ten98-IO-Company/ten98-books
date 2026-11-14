import assert from 'node:assert/strict';
import { test } from 'node:test';
import { voucherCreateInput } from '../src/lib/ledger.ts';
import { moneyText, moneyToWire } from '../src/lib/money.ts';

test('money on the wire is a plain decimal string; numbers, grouping and exponents are refused', () => {
  for (const text of ['0', '12', '12.5', '-3.250', '1250.50']) assert.equal(moneyText.safeParse(text).success, true, text);
  for (const value of [12.5, '1,000', '1e5', ' 12', '12.', '.5', '+1', '']) assert.equal(moneyText.safeParse(value).success, false, String(value));
});

test('moneyToWire formats every bigint for the currency exponent and leaves other values alone', () => {
  const wire = moneyToWire({ total: 125050n, number: 7, lines: [{ amount: -5n, side: 'Cr' }], nothing: null, flag: true }, 3);
  assert.deepEqual(wire, { total: '125.050', number: 7, lines: [{ amount: '-0.005', side: 'Cr' }], nothing: null, flag: true });
  assert.equal(moneyToWire(400000n, 2), '4000.00');
});

test('a voucher body is strict: unknown fields and a missing idempotency key are refused', () => {
  const body = { idempotencyKey: 'key-12345678', voucherTypeId: '0190b5a8-8b1e-7c3e-9b3c-2f1f3c4d5e6f', date: '2026-02-01', lines: [] };
  assert.equal(voucherCreateInput.safeParse(body).success, true);
  assert.equal(voucherCreateInput.safeParse({ ...body, number: 4 }).success, false, 'the number is never chosen by the client');
  assert.equal(voucherCreateInput.safeParse({ ...body, idempotencyKey: undefined }).success, false);
  assert.equal(voucherCreateInput.safeParse({ ...body, date: '2026-02-30' }).success, false);
});
