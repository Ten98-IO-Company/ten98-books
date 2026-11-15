import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterChoices, resolveTyped, typedOutcome, typedOutcomeMoves, yesNo } from '../src/lib/lookup-entry.ts';
import { parentChoices, topLevelChoice, type CostCentreRow } from '../src/lib/cost-centre-forms.ts';
import { groupChoices, isChoice, primaryChoice, type Choice, type GroupRow } from '../src/lib/masters.ts';

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

const names: Choice[] = [{ value: 'id-1', label: 'Z-NM 1' }, { value: 'id-2', label: 'ZNM 12' }, { value: 'id-3', label: 'Cash in hand' }, { value: 'id-4', label: 'Z_NM 1' }];

test('a lookup lists and picks names under the name match key: case, spaces and the ignored punctuation do not matter, an underscore does', () => {
  const listed = (text: string) => filterChoices(names, text).map(option => option.value);
  assert.deepEqual(listed('znm1'), ['id-1', 'id-2'], 'listed in their own order, the key held anywhere');
  assert.deepEqual(listed('z nm.1'), ['id-1', 'id-2']);
  assert.deepEqual(listed('Z-NM 1'), ['id-1', 'id-2']);
  assert.deepEqual(listed('z_nm'), ['id-4'], 'an underscore is significant: it finds only the name that has one');
  assert.deepEqual(listed('hand'), ['id-3'], 'held anywhere, not only at the start');
  assert.deepEqual(listed('znm13'), []);
  // The pick is the option's own value, never the text.
  assert.deepEqual(resolveTyped(names, 'znm1', ''), { value: 'id-1' }, 'the whole name under the key wins over the longer name it starts');
  assert.deepEqual(resolveTyped(names, 'znm', ''), { error: '“znm” could mean more than one choice. Type more of the name, or pick from the list.' });
  assert.deepEqual(resolveTyped(names, 'z nm.1', 'id-1'), { value: 'id-1' }, 'the name already held');
  assert.deepEqual(resolveTyped(names, 'Z NM 12', ''), { value: 'id-2' });
  assert.deepEqual(resolveTyped(names, 'cash', ''), { value: 'id-3' });
  assert.deepEqual(typedOutcome(names, 'z nm 12', 'id-1', blank), { kind: 'pick', value: 'id-2' });
  assert.equal(typedOutcome(names, 'z_nm', 'id-1', blank).kind, 'pick', 'z_nm names Z_NM 1 only');
  assert.deepEqual(resolveTyped(names, 'z_nm', ''), { value: 'id-4' });
  const nothing = resolveTyped([{ value: 'a', label: 'ZNM 1' }], 'z_nm', '');
  assert.ok('error' in nothing, 'z_nm does not find ZNM 1');
  assert.deepEqual(filterChoices([{ value: 'a', label: 'ZNM 1' }], 'z_nm'), []);
});

test('text made only of ignored characters is empty text', () => {
  assert.deepEqual(filterChoices(names, '-'), names);
  assert.deepEqual(filterChoices(names, ' . / '), names);
  assert.deepEqual(resolveTyped(names, '-', 'id-1'), { value: '' });
  assert.deepEqual(typedOutcome(names, '-', 'id-1', blank), { kind: 'error', message: blank }, 'what an emptied field says');
  assert.deepEqual(typedOutcome(names, '', 'id-1', blank), typedOutcome(names, '-', 'id-1', blank));
});

test('Enter takes the one choice the list shows: exact key, then a start of the label or a word (split at ignored characters too), then a key held anywhere', () => {
  const list: Choice[] = [{ value: 'a', label: 'Cash at Bank' }, { value: 'b', label: 'Misc.Income' }, { value: 'c', label: 'Sales' }];
  assert.deepEqual(resolveTyped(list, 'at bank', ''), { value: 'a' }, 'the list shows one choice, so Enter takes it');
  assert.deepEqual(resolveTyped(list, 'income', ''), { value: 'b' }, 'a word that starts after an ignored character');
  assert.deepEqual(resolveTyped(list, 'isc.inc', ''), { value: 'b' }, 'held anywhere, as the list shows');
  assert.deepEqual(filterChoices(list, 'at bank').map(option => option.value), ['a']);
  const several = resolveTyped([...list, { value: 'd', label: 'Bank Account' }], 'ba', '');
  assert.ok('error' in several && /more than one choice/.test(several.error));
  const none = resolveTyped(list, 'zzz', '');
  assert.deepEqual(none, { error: '“zzz” is not one of the choices. Pick one from the list.' });
});

test('a choice a rule disables is never taken: its exact name answers with its reason instead of picking a longer name', () => {
  const list: Choice[] = [{ value: 'a', label: 'Cash', disabled: true, disabledReason: 'Not under itself.' }, { value: 'b', label: 'Cash at Bank' }];
  assert.deepEqual(resolveTyped(list, 'cash', ''), { error: 'Not under itself.' });
  assert.deepEqual(typedOutcome(list, 'Cash', 'b', blank), { kind: 'error', message: 'Not under itself.' });
  assert.deepEqual(resolveTyped(list, 'cash a', ''), { value: 'b' }, 'a longer name that is not the disabled one is still taken');
});

test('a built-in choice wins over a name of a user with the same key', () => {
  const list: Choice[] = [{ value: 'u1', label: 'Primary' }, { value: primaryChoice, label: 'Primary', builtIn: true }];
  assert.deepEqual(resolveTyped(list, 'primary', ''), { value: primaryChoice });
  assert.deepEqual(resolveTyped(list, 'prim.ary', 'u1'), { value: 'u1' }, 'the held value is kept as before');
  const top: Choice[] = [{ value: 'c1', label: 'Top-level' }, { value: 'top', label: 'Top level', builtIn: true }];
  assert.deepEqual(resolveTyped(top, 'TOP LEVEL', ''), { value: 'top' });
});

test('the choice already held is kept when its key equals the text, even where another choice has the same key', () => {
  const list: Choice[] = [{ value: 'a', label: 'Main Cash' }, { value: 'b', label: 'Main-Cash' }];
  assert.deepEqual(resolveTyped(list, 'main cash', 'b'), { value: 'b' });
  const ambiguous = resolveTyped(list, 'main cash', '');
  assert.ok('error' in ambiguous && /more than one choice/.test(ambiguous.error), 'with nothing held the two are ambiguous');
});

test('text of only a non-breaking space gives a message without an empty quotation', () => {
  const result = resolveTyped(names, ' ', '');
  assert.ok('error' in result);
  assert.doesNotMatch(result.error, /“”/);
  assert.match(result.error, /not one of the choices/);
});

test('an exact name that exists only as disabled options is never passed over: the first reason, or "not one of the choices" without one', () => {
  const withReason: Choice[] = [{ value: 'a', label: 'Cash', disabled: true, disabledReason: 'First reason.' }, { value: 'b', label: 'Cash', disabled: true, disabledReason: 'Second reason.' }, { value: 'c', label: 'Cash at Bank' }];
  assert.deepEqual(resolveTyped(withReason, 'cash', ''), { error: 'First reason.' }, 'two disabled exact names');
  const noReason: Choice[] = [{ value: 'a', label: 'Cash', disabled: true }, { value: 'c', label: 'Cash at Bank' }];
  assert.deepEqual(resolveTyped(noReason, 'cash', ''), { error: '“cash” is not one of the choices. Pick one from the list.' }, 'no reason to give');
  assert.deepEqual(resolveTyped(noReason, 'cash at', ''), { value: 'c' });
});

test('words split at the ignored characters on their own: "income" names Misc.Income, not the other name that merely holds it', () => {
  const list: Choice[] = [{ value: 'a', label: 'Misc.Income' }, { value: 'b', label: 'Reincome' }];
  assert.deepEqual(filterChoices(list, 'income').map(option => option.value), ['a', 'b'], 'the list shows both');
  assert.deepEqual(resolveTyped(list, 'income', ''), { value: 'a' }, 'the start of a word picks before "holds it anywhere" is tried');
});

test('the production choice builders mark Primary and Top level as built in, and a typed name equal to one resolves to it over the name of a user', () => {
  const group = (id: string, name: string): GroupRow => ({ id, name, parentId: null, nature: 'asset', grossProfit: false, systemKey: null, secondLanguageName: null, revision: 1 });
  const groups = groupChoices([group('g1', 'Primary'), group('g2', 'Stock')], { primary: true });
  assert.equal(groups.find(choice => choice.value === primaryChoice)?.builtIn, true);
  assert.deepEqual(resolveTyped(groups, 'primary', ''), { value: primaryChoice });
  const centre: CostCentreRow = { id: 'c1', categoryId: 'k1', categoryName: 'Projects', parentId: null, name: 'Top level', secondLanguageName: null, revision: 1, inUse: false };
  const parents = parentChoices([centre], 'k1');
  assert.equal(parents.find(choice => choice.value === topLevelChoice)?.builtIn, true);
  assert.deepEqual(resolveTyped(parents, 'top-level', ''), { value: topLevelChoice });
});
