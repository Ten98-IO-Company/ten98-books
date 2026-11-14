import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { balancePreviewInput, counterLedgerQuery, nextNumberQuery } from '../src/lib/ledger.ts';

const line = { ledgerId: randomUUID().toUpperCase(), side: 'Dr', amount: '12.50' };

test('voucher entry read inputs are strict: a real date, known sides, preview lines without bill rows, at most 500 lines', () => {
  assert.equal(nextNumberQuery.safeParse({ date: '2026-02-28' }).success, true);
  for (const value of [{}, { date: '2026-02-29' }, { date: '2026-01-01', extra: '1' }, { date: ['2026-01-01', '2026-01-02'] }]) {
    assert.equal(nextNumberQuery.safeParse(value).success, false, JSON.stringify(value));
  }
  const parsed = balancePreviewInput.parse({ date: '2026-01-31', lines: [line] });
  assert.equal(parsed.lines[0]!.ledgerId, line.ledgerId.toLowerCase(), 'ids are compared in lower case, as elsewhere');
  assert.equal(balancePreviewInput.safeParse({ date: '2026-01-31', lines: Array.from({ length: 500 }, () => line) }).success, true);
  for (const value of [
    { date: '2026-01-31', lines: Array.from({ length: 501 }, () => line) },
    { date: '2026-01-31', lines: [{ ...line, bills: [] }] },
    { date: '2026-01-31', lines: [{ ...line, side: 'Debit' }] },
    { date: '2026-01-31', lines: [{ ...line, amount: '1,000' }] },
    { date: '2026-01-31', voucherId: 'not-an-id', lines: [] },
    { lines: [] },
  ]) assert.equal(balancePreviewInput.safeParse(value).success, false, JSON.stringify(value).slice(0, 80));
  assert.equal(counterLedgerQuery.safeParse({ voucherTypeId: randomUUID(), side: 'Cr' }).success, true);
  for (const value of [{ voucherTypeId: randomUUID() }, { voucherTypeId: randomUUID(), side: 'cr' }, { side: 'Dr' }]) {
    assert.equal(counterLedgerQuery.safeParse(value).success, false, JSON.stringify(value));
  }
});
