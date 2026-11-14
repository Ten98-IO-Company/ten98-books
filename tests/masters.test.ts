import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  amountProblem, buildChartRows, cashFamilyIds, defaultSide, describeChanges, describeFailure, displayAmount, effectiveSide, emptyGroupForm, emptyLedgerForm,
  groupChoices, groupDeleteReason, groupFields, groupFormReducer, groupPayload, ledgerDeleteReason, ledgerFormReducer, ledgerGroupReason, ledgerPayload,
  natureLockReason, nextFieldAfter, openingLocked, parentReason, primaryChoice, validateGroupForm, validateLedgerForm,
  type GroupRow, type LedgerRow, type RevisionRow,
} from '../src/lib/masters.ts';

const group = (id: string, name: string, parentId: string | null, nature: GroupRow['nature'], systemKey: string | null = null): GroupRow =>
  ({ id, name, parentId, nature, grossProfit: false, systemKey, secondLanguageName: null, revision: 1 });
const ledger = (id: string, name: string, groupId: string | null, nature: LedgerRow['nature'], extra: Partial<LedgerRow> = {}): LedgerRow =>
  ({ id, name, groupId, groupName: null, nature, systemKey: null, secondLanguageName: null, cashOrBank: false, opening: { amount: '0.00', side: 'Dr' }, revision: 1, ...extra });

const groups = [
  group('assets', 'Current Assets', null, 'asset', 'current_assets'), group('cash', 'Cash on Hand', 'assets', 'asset', 'cash_in_hand'), group('bank', 'Bank Accounts', 'assets', 'asset', 'bank_accounts'),
  group('capital', 'Capital', null, 'liability', 'capital'), group('mine', 'Mine', 'bank', 'asset'), group('misc', 'Misc', null, 'expense'),
];
const ledgers = [
  ledger('l-cash', 'Cash', 'cash', 'asset', { systemKey: 'cash' }), ledger('l-pl', 'Profit and Loss', null, null, { systemKey: 'profit_and_loss' }),
  ledger('l-a', 'alpha', 'mine', 'asset', { opening: { amount: '10.50', side: 'Dr' } }), ledger('l-b', 'Beta', 'capital', 'liability'),
];

test('the chart is ordered by nature, then groups before ledgers, each by name, with sub-tree counts', () => {
  const rows = buildChartRows(groups, ledgers);
  assert.deepEqual(rows.map(row => row.kind === 'heading' ? `# ${row.label} ${row.groups}/${row.ledgers}` : `${' '.repeat(row.depth)}${row.kind === 'group' ? row.group.name : row.ledger.name}`), [
    '# Assets 4/2',
    ' Current Assets', '  Bank Accounts', '   Mine', '    alpha', '  Cash on Hand', '   Cash',
    '# Liabilities 1/1', ' Capital', '  Beta',
    '# Expenses 1/0', ' Misc',
    '# Outside every group 0/1', ' Profit and Loss',
  ]);
  const current = rows.find(row => row.kind === 'group' && row.id === 'assets');
  assert.ok(current?.kind === 'group');
  assert.deepEqual([current.groups, current.ledgers], [3, 2]);
});

test('a chart of a thousand ledgers builds in one ordered pass', () => {
  const many = Array.from({ length: 1000 }, (_, index) => ledger(`x${index}`, `Ledger ${index}`, 'mine', 'asset'));
  const started = performance.now();
  const rows = buildChartRows(groups, many);
  assert.equal(rows.filter(row => row.kind === 'ledger').length, 1000);
  assert.ok(performance.now() - started < 250);
});

test('the default side follows the nature: debit for assets and expenses, credit for liabilities and income', () => {
  assert.deepEqual((['asset', 'expense', 'liability', 'income'] as const).map(defaultSide), ['Dr', 'Dr', 'Cr', 'Cr']);
  assert.equal(effectiveSide({ ...emptyLedgerForm('capital') }, groups), 'Cr');
  assert.equal(effectiveSide({ ...emptyLedgerForm('capital'), side: 'Dr' }, groups), 'Dr');
});

test('group choices show where each group sits and disable the ones a rule refuses', () => {
  const choices = groupChoices(groups, { primary: true, reason: candidate => candidate.id === 'misc' ? 'No.' : null });
  assert.equal(choices[0].value, primaryChoice);
  const mine = choices.find(choice => choice.value === 'mine');
  assert.equal(mine?.description, 'In Current Assets › Bank Accounts · Asset');
  assert.deepEqual(choices.find(choice => choice.value === 'misc'), { value: 'misc', label: 'Misc', description: 'Primary group · Expense', disabled: true, disabledReason: 'No.' });
});

test('the cash family is the seeded cash and bank groups and everything below them', () => {
  assert.deepEqual([...cashFamilyIds(groups)].sort(), ['bank', 'cash', 'mine']);
});

test('rules the page can explain: nature locks, parents, ledger groups, deletes and the opening lock', () => {
  assert.match(natureLockReason(groups[0], groups, ledgers) ?? '', /built-in group keeps/);
  assert.match(natureLockReason(group('p', 'P', null, 'asset'), [...groups, group('p', 'P', null, 'asset')], [...ledgers, ledger('l-p', 'LP', 'p', 'asset', { opening: { amount: '5.00', side: 'Dr' } })]) ?? '', /opening balance/);
  assert.equal(natureLockReason(group('q', 'Q', null, 'asset'), [...groups, group('q', 'Q', null, 'asset')], ledgers), null);
  const capital = groups[3];
  assert.match(parentReason(capital, capital, groups, ledgers) ?? '', /under itself/);
  assert.match(parentReason(groups[1], groups[3], groups, ledgers) ?? '', /keeps its nature/);
  assert.equal(parentReason(group('free', 'Free', 'misc', 'expense'), groups[3], groups, ledgers), null);
  assert.match(parentReason(group('holder', 'Holder', 'assets', 'asset'), group('fixed', 'Fixed', null, 'asset'), groups, [...ledgers, ledger('l-cash2', 'Cash', 'holder', 'asset', { systemKey: 'cash' })]) ?? '', /cash ledger must stay/);
  const cash = ledgers[0];
  assert.match(ledgerGroupReason(cash, groups[3], groups) ?? '', /keeps its nature/);
  assert.match(ledgerGroupReason(cash, group('fixed', 'Fixed', null, 'asset'), groups) ?? '', /cash ledger must stay/);
  assert.equal(ledgerGroupReason(cash, groups[2], groups), null);
  assert.equal(ledgerGroupReason(ledgers[2], groups[3], groups), null);
  // Where it already is, a group or ledger can always stay.
  assert.equal(parentReason(groups[1], groups[0], groups, ledgers), null);
  assert.equal(ledgerGroupReason(cash, groups[1], groups), null);
  assert.match(groupDeleteReason(groups[0], groups, ledgers) ?? '', /Built-in groups/);
  assert.match(groupDeleteReason(groups[4], groups, ledgers) ?? '', /still holds/);
  assert.equal(groupDeleteReason(groups[5], groups, ledgers), null);
  assert.match(ledgerDeleteReason(ledgers[0]) ?? '', /Built-in ledgers/);
  assert.equal(ledgerDeleteReason(ledgers[2]), null);
  assert.equal(openingLocked({ booksBeginning: '2026-01-01', lockedThrough: '2026-01-01' }), true);
  assert.equal(openingLocked({ booksBeginning: '2026-01-01', lockedThrough: '2025-12-31' }), false);
  assert.equal(openingLocked({ booksBeginning: '2026-01-01', lockedThrough: null }), false);
});

test('the group form shows nature only under Primary and the gross-profit flag only for income and expense', () => {
  let form = emptyGroupForm('assets');
  assert.deepEqual(groupFields(form), ['name', 'secondLanguageName', 'parentId']);
  form = groupFormReducer(form, { type: 'set', field: 'parentId', value: primaryChoice });
  assert.deepEqual(groupFields(form), ['name', 'secondLanguageName', 'parentId', 'nature']);
  form = groupFormReducer(form, { type: 'set', field: 'nature', value: 'income' });
  assert.deepEqual(groupFields(form).slice(-2), ['nature', 'grossProfit']);
  form = groupFormReducer(form, { type: 'set', field: 'grossProfit', value: true });
  form = groupFormReducer(form, { type: 'set', field: 'nature', value: 'asset' });
  assert.equal(form.grossProfit, false);
  form = groupFormReducer(groupFormReducer(form, { type: 'set', field: 'nature', value: 'expense' }), { type: 'set', field: 'grossProfit', value: true });
  form = groupFormReducer(form, { type: 'set', field: 'parentId', value: 'assets' });
  assert.deepEqual([form.nature, form.grossProfit], ['', false]);
});

test('saving resets the form for the next entry and keeps the parent group', () => {
  const saved = groupFormReducer({ name: 'A', secondLanguageName: 'ب', parentId: 'assets', nature: '', grossProfit: false }, { type: 'saved' });
  assert.deepEqual(saved, { name: '', secondLanguageName: '', parentId: 'assets', nature: '', grossProfit: false });
  const next = ledgerFormReducer({ name: 'A', secondLanguageName: '', groupId: 'capital', amount: '5', side: 'Dr' }, { type: 'saved' });
  assert.deepEqual(next, { name: '', secondLanguageName: '', groupId: 'capital', amount: '', side: null });
});

test('the group form validates what the page can know and builds the request body', () => {
  assert.deepEqual(validateGroupForm(emptyGroupForm()), { name: 'Enter the group name.', parentId: 'Choose the group this one sits under, or Primary.' });
  assert.equal(validateGroupForm({ ...emptyGroupForm(primaryChoice), name: 'X' }).nature, 'Choose the nature of a primary group.');
  assert.deepEqual(groupPayload({ name: ' Fees ', secondLanguageName: '', parentId: 'assets', nature: '', grossProfit: false }), { name: 'Fees', secondLanguageName: null, parentId: 'assets' });
  assert.deepEqual(groupPayload({ name: 'Top', secondLanguageName: 'أعلى', parentId: primaryChoice, nature: 'income', grossProfit: true }, 3), { name: 'Top', secondLanguageName: 'أعلى', parentId: null, nature: 'income', grossProfit: true, revision: 3 });
});

test('amounts are checked against the currency exponent and stay strings', () => {
  assert.equal(amountProblem('', 3), null);
  assert.equal(amountProblem('1250.500', 3), null);
  assert.match(amountProblem('1.2345', 3) ?? '', /3 decimal places at most/);
  assert.match(amountProblem('1.5', 0) ?? '', /no decimal places/);
  assert.match(amountProblem('-5', 2) ?? '', /positive/);
  assert.match(amountProblem('1,250.50', 2) ?? '', /digits and a decimal point/);
  assert.match(amountProblem('99999999999999999999', 2) ?? '', /too large/);
  assert.deepEqual(validateLedgerForm({ ...emptyLedgerForm('capital'), name: 'N', amount: '1.234' }, 2), { amount: 'This currency has 2 decimal places at most.' });
  assert.equal(displayAmount('1234567.5', 3), '1,234,567.500');
  assert.equal(displayAmount('-1234.50', 2), '-1,234.50');
  assert.equal(displayAmount('12', 0), '12');
});

test('the ledger body states the opening in the currency exponent, defaults the side and always states it when altering', () => {
  const form = { name: ' Rent ', secondLanguageName: '', groupId: 'capital', amount: '12.5', side: null } as const;
  assert.deepEqual(ledgerPayload(form, groups, 3), { name: 'Rent', secondLanguageName: null, groupId: 'capital', opening: { amount: '12.500', side: 'Cr' } });
  assert.deepEqual(ledgerPayload({ ...emptyLedgerForm('mine'), name: 'Plain' }, groups, 2), { name: 'Plain', secondLanguageName: null, groupId: 'mine' });
  assert.deepEqual(ledgerPayload({ ...emptyLedgerForm('mine'), name: 'Plain' }, groups, 2, 4), { name: 'Plain', secondLanguageName: null, groupId: 'mine', opening: { amount: '0.00', side: 'Dr' }, revision: 4 });
});

test('Enter moves through the fields in order and asks to save after the last', () => {
  const fields = groupFields(emptyGroupForm(primaryChoice));
  assert.equal(nextFieldAfter(fields, 'name'), 'secondLanguageName');
  assert.equal(nextFieldAfter(fields, 'nature'), 'confirm');
});

test('failures: a stale revision offers a reload, a missing item names the likely causes, and the server sentence otherwise passes through', () => {
  assert.equal(describeFailure(409, 'This ledger was changed by someone else. Reload it and try again.').stale, true);
  assert.equal(describeFailure(409, 'A group with this name already exists.').stale, false);
  assert.equal(describeFailure(409, 'A group with this name already exists.').message, 'A group with this name already exists.');
  assert.match(describeFailure(404, 'Company not found or unavailable.').message, /no longer exists/);
});

test('history lists what changed in words, resolving group ids and formatting minor units with the exponent', () => {
  const revision = (action: RevisionRow['action'], before: unknown, after: unknown, entity: RevisionRow['entity'] = 'ledger'): RevisionRow => ({ id: '1', entity, entityId: 'x', action, actorId: 'u', at: '2026-01-01T00:00:00Z', before, after });
  const snapshot = (name: string, minor: string, side: string, groupName = 'Capital') => ({ name, secondLanguageName: null, groupName, opening: { amount: minor, side } });
  assert.deepEqual(describeChanges(revision('create', null, snapshot('Rent', '0', 'Dr')), 3, () => null), ['Name: Rent', 'Group: Capital']);
  assert.deepEqual(describeChanges(revision('alter', snapshot('Rent', '0', 'Dr'), snapshot('Rent', '1250500', 'Cr', 'Fixed')), 3, () => null), ['Group: Capital → Fixed', 'Opening balance: none → 1,250.500 Cr']);
  assert.deepEqual(describeChanges(revision('delete', snapshot('Rent', '0', 'Dr'), null), 3, () => null), ['Deleted']);
  const moved = describeChanges(revision('alter', { name: 'G', parentId: 'a', nature: 'asset', grossProfit: false }, { name: 'G', parentId: 'gone', nature: 'asset', grossProfit: false }, 'group'), 2, id => id === 'a' ? 'Assets' : null);
  assert.deepEqual(moved, ['Under: Assets → a group that was deleted since']);
});
