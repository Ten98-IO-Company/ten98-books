import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCostRows, categoryChoices, categoryDeleteReason, categoryFormReducer, categoryPayload, centreDescendants, centreFormOf, centrePath, centrePayload, chooseCategory, chooseParent,
  costCentresDefault, costCreateSearch, costMoveSearch, describeCostChanges, describeLedgerCostChange, effectiveCostSetting, emptyCategoryForm, emptyCentreForm, parentChoices,
  topLevelChoice, validateCategoryForm, validateCentreForm, withCostSetting, type CostCategoryRow, type CostCentreRow,
} from '../src/lib/cost-centre-forms.ts';
import { ledgerFormReducer, emptyLedgerForm, type RevisionRow } from '../src/lib/masters.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const category = (n: number, name: string, extra: Partial<CostCategoryRow> = {}): CostCategoryRow =>
  ({ id: id(n), systemKey: null, name, secondLanguageName: null, allocateRevenue: true, allocateNonRevenue: false, revision: 1, inUse: false, ...extra });
const centre = (n: number, name: string, cat: CostCategoryRow, parent: CostCentreRow | null = null, extra: Partial<CostCentreRow> = {}): CostCentreRow =>
  ({ id: id(n), categoryId: cat.id, categoryName: cat.name, parentId: parent?.id ?? null, name, secondLanguageName: null, revision: 1, inUse: false, ...extra });

const general = category(1, 'General', { systemKey: 'primary' });
const projects = category(2, 'Projects');
const channels = category(3, 'Channels');
const north = centre(10, 'North', projects);
const harbour = centre(11, 'Harbour', projects, north);
const south = centre(12, 'South', projects);
const online = centre(13, 'Online', channels);
const all = [general, projects, channels];
const centres = [north, harbour, south, online];

test('the list is one tree: categories by name, each with its centres nested under their parents, empty categories kept', () => {
  const rows = buildCostRows(all, centres);
  assert.deepEqual(rows.map(row => `${row.kind === 'centre' ? row.depth : 1}:${row.kind === 'centre' ? row.centre.name : row.category.name}`),
    ['1:Channels', '2:Online', '1:General', '1:Projects', '2:North', '3:Harbour', '2:South']);
  const projectsRow = rows.find(row => row.kind === 'category' && row.id === projects.id);
  assert.equal(projectsRow?.kind === 'category' && projectsRow.centres, 3);
  const northRow = rows.find(row => row.kind === 'centre' && row.id === north.id);
  assert.equal(northRow?.kind === 'centre' && northRow.subCentres, 1);
  assert.equal(rows.find(row => row.kind === 'category' && row.id === general.id)?.kind === 'category' && (rows.find(row => row.kind === 'category' && row.id === general.id) as { centres: number }).centres, 0);
});

test('a centre moved to another category keeps its parent: it is listed in its own category with a note, never twice', () => {
  const moved = { ...harbour, categoryId: channels.id, categoryName: channels.name };
  const rows = buildCostRows(all, [north, moved, south, online]);
  const where = rows.filter(row => row.kind === 'centre' && row.id === moved.id);
  assert.equal(where.length, 1);
  const row = where[0];
  assert.ok(row.kind === 'centre' && row.parent?.name === 'North' && row.parent.categoryName === 'Projects');
  // It sits at the top of the Channels centres (depth 2), not under North, and North has no sub-centre in its own category now.
  assert.equal(row.kind === 'centre' && row.depth, 2);
  const northRow = rows.find(item => item.kind === 'centre' && item.id === north.id);
  assert.equal(northRow?.kind === 'centre' && northRow.subCentres, 0);
});

test('paths and descendants follow the parent chain across categories', () => {
  assert.deepEqual(centrePath(centres, harbour.id), ['North', 'Harbour']);
  assert.deepEqual(centrePath(centres, null), []);
  const deep = centre(14, 'Pier', channels, harbour);
  assert.deepEqual([...centreDescendants([...centres, deep], north.id)].sort(), [harbour.id, deep.id].sort());
  assert.equal(centreDescendants(centres, south.id).size, 0);
});

test('the parent lookup offers the top level and the category\'s centres, never the centre itself or what sits under it', () => {
  const offered = (existing?: CostCentreRow, categoryId = projects.id) => parentChoices(centres, categoryId, existing).map(choice => choice.label);
  assert.deepEqual(offered(), ['Top level', 'North', 'Harbour', 'South']);
  assert.deepEqual(offered(north), ['Top level', 'South'], 'North may not go under itself or its own sub-centre');
  assert.deepEqual(offered(south), ['Top level', 'North', 'Harbour']);
  assert.deepEqual(offered(undefined, channels.id), ['Top level', 'Online']);
  // Each choice says where it sits.
  assert.equal(parentChoices(centres, projects.id).find(choice => choice.label === 'Harbour')?.description, 'Under North · Projects');
  // A parent left in another category by an earlier move stays offered for the centre that has it, and for no other.
  const moved = { ...harbour, categoryId: channels.id, categoryName: channels.name };
  const list = [north, moved, south, online];
  assert.ok(parentChoices(list, channels.id, moved).some(choice => choice.value === north.id));
  assert.ok(!parentChoices(list, channels.id).some(choice => choice.value === north.id));
  assert.deepEqual(categoryChoices(all).map(choice => choice.label), ['Channels', 'General', 'Projects']);
});

test('choosing a category drops a parent that is not in it, except the parent the centre already has; choosing a parent follows its category', () => {
  const form = centreFormOf(harbour);
  assert.equal(chooseCategory(form, projects.id, centres, harbour).parentId, north.id);
  assert.equal(chooseCategory(form, channels.id, centres, harbour).parentId, north.id, 'the server lets a centre that changes category keep its parent');
  assert.equal(chooseCategory(form, channels.id, centres).parentId, topLevelChoice, 'a parent the centre does not already have must be in the category');
  const fresh = emptyCentreForm(projects.id, south.id);
  assert.equal(chooseCategory(fresh, channels.id, centres).parentId, topLevelChoice);
  assert.equal(chooseCategory({ ...fresh, parentId: topLevelChoice }, channels.id, centres).categoryId, channels.id);
  const placed = chooseParent(emptyCentreForm(channels.id), north.id, centres);
  assert.deepEqual([placed.categoryId, placed.parentId], [projects.id, north.id]);
  assert.equal(chooseParent(placed, topLevelChoice, centres).categoryId, projects.id, 'back to the top level keeps the category');
});

test('the centre form checks what the page can see, and the body carries null for the top level and a trimmed second-language name', () => {
  const ids = new Set(all.map(item => item.id)), parents = new Set([topLevelChoice, north.id]);
  assert.deepEqual(validateCentreForm(emptyCentreForm(projects.id), ids, parents), { name: 'Enter the cost centre name.' });
  assert.deepEqual(Object.keys(validateCentreForm(emptyCentreForm(''), ids, parents)).sort(), ['categoryId', 'name']);
  assert.ok(validateCentreForm({ ...emptyCentreForm(projects.id), name: 'x'.repeat(121) }, ids, parents).name);
  assert.ok(validateCentreForm({ ...emptyCentreForm(projects.id), name: 'A', parentId: south.id }, ids, parents).parentId);
  assert.deepEqual(validateCentreForm({ ...emptyCentreForm(projects.id), name: 'A', parentId: north.id }, ids, parents), {});
  assert.deepEqual(centrePayload({ categoryId: projects.id, name: ' West ', secondLanguageName: '  ', parentId: topLevelChoice }), { name: 'West', secondLanguageName: null, categoryId: projects.id, parentId: null });
  assert.deepEqual(centrePayload({ categoryId: projects.id, name: 'West', secondLanguageName: 'غرب', parentId: north.id }, 4), { name: 'West', secondLanguageName: 'غرب', categoryId: projects.id, parentId: north.id, revision: 4 });
});

test('the category form starts with the server defaults, keeps its settings between entries, and its body names both flags', () => {
  const fresh = emptyCategoryForm();
  assert.deepEqual([fresh.allocateRevenue, fresh.allocateNonRevenue], [true, false]);
  const typed = categoryFormReducer(categoryFormReducer(fresh, { type: 'set', field: 'name', value: 'Branches' }), { type: 'flag', field: 'allocateNonRevenue', value: true });
  assert.deepEqual(categoryFormReducer(typed, { type: 'saved' }), { name: '', secondLanguageName: '', allocateRevenue: true, allocateNonRevenue: true });
  assert.deepEqual(categoryPayload(typed), { name: 'Branches', secondLanguageName: null, allocateRevenue: true, allocateNonRevenue: true });
  assert.equal(categoryPayload(typed, 3).revision, 3);
  assert.deepEqual(validateCategoryForm(fresh), { name: 'Enter the cost category name.' });
  assert.equal(categoryDeleteReason(general), 'The built-in category can be renamed but not deleted.');
  assert.equal(categoryDeleteReason({ ...projects, inUse: true }), null, 'a category in use is left to the server\'s refusal, which is shown as it is said');
});

test('the ledger setting follows the group until chosen and resets with a saved entry', () => {
  assert.deepEqual(['income', 'expense', 'asset', 'liability', null, undefined].map(costCentresDefault), [true, true, false, false, false, false]);
  assert.equal(effectiveCostSetting(null, 'expense'), true);
  assert.equal(effectiveCostSetting(false, 'expense'), false);
  assert.equal(effectiveCostSetting(true, 'asset'), true);
  const reduce = withCostSetting(ledgerFormReducer);
  const start = { ...emptyLedgerForm('g'), costCentres: null };
  const named = reduce(start, { type: 'set', field: 'name', value: 'Fuel' });
  assert.equal(named.name, 'Fuel');
  const chosen = reduce(named, { type: 'costCentres', value: false });
  assert.deepEqual([chosen.name, chosen.costCentres], ['Fuel', false]);
  assert.equal(reduce(chosen, { type: 'set', field: 'groupId', value: 'h' }).costCentres, false, 'a chosen value stays when the group changes');
  assert.deepEqual([reduce(chosen, { type: 'saved' }).costCentres, reduce(chosen, { type: 'saved' }).name, reduce(chosen, { type: 'saved' }).groupId], [null, '', 'g']);
});

test('route search values are ids and flags only', () => {
  assert.deepEqual(costCreateSearch({ category: id(2).toUpperCase(), parent: id(10), other: 'x' }), { category: id(2), parent: id(10) });
  assert.deepEqual(costCreateSearch({ category: 'not an id', parent: 7 }), {});
  assert.deepEqual([costMoveSearch({ move: true }), costMoveSearch({ move: 'true' }), costMoveSearch({ move: '1' }), costMoveSearch({ move: 'no' }), costMoveSearch({})], [{ move: true }, { move: true }, { move: true }, {}, {}]);
});

const revision = (entity: RevisionRow['entity'], action: RevisionRow['action'], before: unknown, after: unknown): RevisionRow =>
  ({ id: 'r', entity, entityId: 'e', action, actorId: 'u', actorName: 'U', at: '2026-01-01T00:00:00Z', before, after });

test('history says what changed on a category, a centre (resolving the parent by name) and a ledger\'s setting', () => {
  const nameOf = (value: string) => value === north.id ? 'North' : null;
  assert.deepEqual(describeCostChanges(revision('cost_category', 'create', null, { name: 'Branches', secondLanguageName: null, allocateRevenue: true, allocateNonRevenue: false }), nameOf),
    ['Name: Branches', 'Allocates revenue items: yes', 'Allocates non-revenue items: no']);
  assert.deepEqual(describeCostChanges(revision('cost_category', 'alter', { name: 'Branches', allocateRevenue: true, allocateNonRevenue: false }, { name: 'Branches', allocateRevenue: true, allocateNonRevenue: true }), nameOf),
    ['Allocates non-revenue items: no → yes']);
  assert.deepEqual(describeCostChanges(revision('cost_centre', 'alter', { categoryName: 'Projects', name: 'Harbour', parentId: north.id }, { categoryName: 'Channels', name: 'Harbour', parentId: null }), nameOf),
    ['Category: Projects → Channels', 'Under: North → Top level']);
  assert.deepEqual(describeCostChanges(revision('cost_centre', 'alter', { categoryName: 'A', name: 'X', parentId: id(99) }, { categoryName: 'A', name: 'X', parentId: north.id }), nameOf),
    ['Under: a centre that was deleted since → North']);
  assert.deepEqual(describeCostChanges(revision('cost_centre', 'delete', { name: 'X' }, null), nameOf), ['Deleted']);
  assert.deepEqual(describeLedgerCostChange(revision('ledger', 'alter', { costCentres: false }, { costCentres: true })), ['Takes cost centres: no → yes']);
  assert.deepEqual(describeLedgerCostChange(revision('ledger', 'alter', { costCentres: true }, { costCentres: true })), []);
  assert.deepEqual(describeLedgerCostChange(revision('ledger', 'create', null, { costCentres: true })), ['Takes cost centres: yes']);
  assert.deepEqual(describeLedgerCostChange(revision('group', 'create', null, { costCentres: true })), []);
});
