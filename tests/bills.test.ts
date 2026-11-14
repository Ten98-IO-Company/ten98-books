import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ageingBucketsInput } from '../src/lib/bills.ts';
import { billRowInput, openingBillInput } from '../src/lib/ledger.ts';
import { bucketIndex } from '../src/server/reports/bills.ts';

const columns = [{ fromDays: 0, toDays: 30 }, { fromDays: 30, toDays: 60 }, { fromDays: 60, toDays: 90 }, { fromDays: 90, toDays: null }];

test('a bill on a column boundary sits in the earlier column; day 0 is in the first; the last column is open', () => {
  assert.deepEqual([0, 1, 30, 31, 60, 61, 90, 91, 5000].map(days => bucketIndex(columns, days)), [0, 0, 0, 1, 1, 2, 2, 3, 3]);
  assert.equal(bucketIndex([{ fromDays: 0, toDays: 30 }], 31), -1, 'beyond a closed last column is in no column');
  assert.equal(bucketIndex([], 10), -1);
});

test('ageing columns start at 0, follow on from each other and only the last is open-ended', () => {
  assert.equal(ageingBucketsInput.safeParse({ buckets: columns }).success, true);
  assert.equal(ageingBucketsInput.safeParse({ buckets: [] }).success, true);
  for (const buckets of [[{ fromDays: 1, toDays: 30 }], [{ fromDays: 0, toDays: 30 }, { fromDays: 31, toDays: 60 }],
    [{ fromDays: 0, toDays: null }, { fromDays: 30, toDays: null }], [{ fromDays: 0, toDays: 0 }]]) {
    assert.equal(ageingBucketsInput.safeParse({ buckets }).success, false, JSON.stringify(buckets));
  }
});

test('bill rows name their bill as their method requires', () => {
  const ok = (row: unknown) => billRowInput.safeParse(row).success;
  assert.equal(ok({ kind: 'new_ref', amount: '10' }), true, 'an unnamed new reference takes the default name');
  assert.equal(ok({ kind: 'new_ref', name: ' S-1 ', amount: '10', creditPeriod: { count: 2, unit: 'week' } }), true);
  assert.equal(ok({ kind: 'new_ref', name: 'S-1', amount: '10', creditPeriod: { dueDate: '2026-02-30' } }), false, 'a real date');
  assert.equal(ok({ kind: 'against_ref', amount: '10' }), false, 'a settlement names its bill');
  assert.equal(ok({ kind: 'against_ref', name: 'S-1', amount: '10', creditPeriod: { count: 1, unit: 'day' } }), false, 'terms are copied, not entered');
  assert.equal(ok({ kind: 'on_account', name: 'S-1', amount: '10' }), false);
  assert.equal(ok({ kind: 'new_ref', name: 'S-1', billId: '01a1da22-31f4-79ac-98f0-c2b0c153b9d2', amount: '10' }), false);
  assert.equal(billRowInput.parse({ kind: 'new_ref', name: '  S-1 ', amount: '10' }).name, 'S-1', 'names are trimmed');
  assert.equal(openingBillInput.safeParse({ kind: 'new_ref', amount: '10' }).success, false, 'an opening bill is named');
  assert.equal(openingBillInput.safeParse({ kind: 'on_account', amount: '10', billDate: '2025-12-31' }).success, true);
});
