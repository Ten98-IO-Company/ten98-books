import assert from 'node:assert/strict';
import { test } from 'node:test';
import { typedOutcome, typedOutcomeMoves, yesNo } from '../src/lib/lookup-entry.ts';
import { isChoice, primaryChoice, type Choice } from '../src/lib/masters.ts';

const blank = 'Choose one.';
const sides: Choice[] = [{ value: 'Dr', label: 'Dr · Debit' }, { value: 'Cr', label: 'Cr · Credit' }];
const parents: Choice[] = [{ value: primaryChoice, label: 'Primary' }, { value: 'g1', label: 'Fixed Assets' }, { value: 'g2', label: 'Fixed Deposits', disabled: true, disabledReason: 'Not under itself.' }];

test('typed text picks the one choice it names, keeps the value it already names, or is an error on the field', () => {
  assert.deepEqual(typedOutcome(yesNo, 'no', 'yes', blank), { kind: 'pick', value: 'no' });
  assert.deepEqual(typedOutcome(yesNo, 'n', 'yes', blank), { kind: 'pick', value: 'no' });
  assert.deepEqual(typedOutcome(yesNo, 'Yes', 'yes', blank), { kind: 'keep' });
  assert.deepEqual(typedOutcome(yesNo, 'y', 'yes', blank), { kind: 'keep' }, 'text that names the value already held changes nothing');
  assert.deepEqual(typedOutcome(sides, 'cre', 'Dr', blank), { kind: 'pick', value: 'Cr' });
  assert.deepEqual(typedOutcome(sides, '', 'Dr', blank), { kind: 'error', message: blank });
  assert.equal(typedOutcome(sides, 'x', 'Dr', blank).kind, 'error');
  assert.deepEqual(typedOutcome(parents, 'fixed d', 'g1', blank), { kind: 'error', message: 'Not under itself.' }, 'a disabled choice says why');
  // A value that is also a plausible typed word still resolves by its label.
  assert.deepEqual(typedOutcome(parents, 'primary', 'g1', blank), { kind: 'pick', value: primaryChoice });
  // Text equal to the held label keeps the value even when it is also the start of another option's label.
  const fixed: Choice[] = [{ value: 'a', label: 'Fixed' }, { value: 'b', label: 'Fixed Deposits' }];
  assert.deepEqual(typedOutcome(fixed, 'fixed', 'a', blank), { kind: 'keep' });
  assert.deepEqual(typedOutcome(fixed, 'Fixed', 'b', blank), { kind: 'pick', value: 'a' }, 'the exact label wins over the longer one it starts');
  assert.equal(typedOutcome(fixed, 'fix', 'a', blank).kind, 'error', 'a prefix of both is ambiguous');
});

test('Enter moves on after a pick and after text that names the held value (never needs pressing twice), not after an error, and the accept chord never moves', () => {
  const pick = typedOutcome(yesNo, 'no', 'yes', blank), keep = typedOutcome(yesNo, 'no', 'no', blank), error = typedOutcome(yesNo, 'x', 'yes', blank);
  assert.deepEqual([pick, keep, error].map(outcome => typedOutcomeMoves(outcome, true)), [true, true, false]);
  assert.deepEqual([pick, keep, error].map(outcome => typedOutcomeMoves(outcome, false)), [false, false, false]);
});

test('a lookup takes a value whenever it is an enabled option\'s, also when it equals the text typed for it (type "no", ArrowDown, Enter picks No)', () => {
  for (const value of ['yes', 'no']) assert.equal(isChoice(yesNo, value), true, value);
  assert.equal(isChoice(sides, 'Dr'), true);
  assert.equal(isChoice(parents, primaryChoice), true);
  assert.equal(isChoice(parents, 'g2'), false, 'a disabled option is never taken');
  assert.equal(isChoice(yesNo, 'ye'), false, 'partial text is not a value');
});
