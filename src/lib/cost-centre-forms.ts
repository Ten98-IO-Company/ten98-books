import type { CostCategoryListItem, CostCentreListItem } from './cost-centres.ts';
import type { Choice, RevisionRow } from './masters.ts';

/**
 * Client-side helpers of the cost category and cost centre screens: the list as one ordered tree, lookup choices, form
 * state, request bodies and the plain-language history. Like src/lib/masters.ts none of it decides what is allowed:
 * the server enforces every rule (docs/LEDGER.md, "Cost categories and cost centres") and what it refuses is shown as it
 * says it. The page only shortens the way there (a parent list that leaves out what would be refused).
 */

export type CostCategoryRow = CostCategoryListItem;
export type CostCentreRow = CostCentreListItem;

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const byName = <T extends { name: string; id: string }>(left: T, right: T) => collator.compare(left.name, right.name) || (left.id < right.id ? -1 : 1);

// ---- The list ----

export type CostListRow =
  | { key: string; kind: 'category'; id: string; category: CostCategoryRow; centres: number }
  /** `parent` names the parent centre only when it sits in another category (a centre can be moved away from it). */
  | { key: string; kind: 'centre'; id: string; depth: number; centre: CostCentreRow; subCentres: number; parent: { name: string; categoryName: string } | null };

/**
 * Categories (by name), each followed by its centres as a tree: a centre sits under its parent when both are in the
 * category; a centre whose parent is in another category (observed: allowed after a move) is listed at the top of its
 * own category and says where its parent is. A category with no centres still has its row. One pass over each list.
 */
export function buildCostRows(categories: readonly CostCategoryRow[], centres: readonly CostCentreRow[]): CostListRow[] {
  const byId = new Map(centres.map(centre => [centre.id, centre]));
  const children = new Map<string, CostCentreRow[]>();
  const roots = new Map<string, CostCentreRow[]>();
  const count = new Map<string, number>();
  for (const centre of centres) {
    count.set(centre.categoryId, (count.get(centre.categoryId) ?? 0) + 1);
    const parent = centre.parentId ? byId.get(centre.parentId) : undefined;
    const list = parent && parent.categoryId === centre.categoryId ? children : roots;
    const key = parent && parent.categoryId === centre.categoryId ? parent.id : centre.categoryId;
    list.set(key, [...list.get(key) ?? [], centre]);
  }
  const out: CostListRow[] = [];
  const place = (centre: CostCentreRow, depth: number, seen: Set<string>) => {
    if (seen.has(centre.id)) return;
    seen.add(centre.id);
    const below = children.get(centre.id) ?? [];
    const parent = centre.parentId ? byId.get(centre.parentId) : undefined;
    out.push({ key: `centre:${centre.id}`, kind: 'centre', id: centre.id, depth, centre, subCentres: below.length,
      parent: parent && parent.categoryId !== centre.categoryId ? { name: parent.name, categoryName: parent.categoryName } : null });
    for (const child of [...below].sort(byName)) place(child, depth + 1, seen);
  };
  for (const category of [...categories].sort(byName)) {
    out.push({ key: `category:${category.id}`, kind: 'category', id: category.id, category, centres: count.get(category.id) ?? 0 });
    const seen = new Set<string>();
    for (const centre of [...roots.get(category.id) ?? []].sort(byName)) place(centre, 2, seen);
  }
  return out;
}

/** The names from the top centre down to `centreId`, for telling two centres with similar names apart. */
export function centrePath(centres: readonly CostCentreRow[], centreId: string | null): string[] {
  const byId = new Map(centres.map(centre => [centre.id, centre]));
  const path: string[] = [];
  for (let current = centreId === null ? undefined : byId.get(centreId); current && path.length < 64; current = current.parentId === null ? undefined : byId.get(current.parentId)) path.unshift(current.name);
  return path;
}

/** Ids of the centres below `centreId`, at any depth and in any category: none of them can become its parent. */
export function centreDescendants(centres: readonly CostCentreRow[], centreId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const centre of centres) if (centre.parentId) children.set(centre.parentId, [...children.get(centre.parentId) ?? [], centre.id]);
  const found = new Set<string>();
  const queue = [...children.get(centreId) ?? []];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (found.has(id)) continue;
    found.add(id);
    queue.push(...children.get(id) ?? []);
  }
  return found;
}

// ---- Lookup choices ----

export const topLevelChoice = 'top';

export function categoryChoices(categories: readonly CostCategoryRow[]): Choice[] {
  return [...categories].sort(byName).map(category => ({ value: category.id, label: category.name, description: category.systemKey ? 'Built-in category' : undefined }));
}

/**
 * What a centre can sit under in `categoryId`: the top level, and the centres of that category except itself and its
 * own sub-centres (a centre cannot sit under what sits under it). The centre's present parent stays listed when it is in
 * another category, since the server lets a centre that changes category keep its parent. Each shows where it sits.
 */
export function parentChoices(centres: readonly CostCentreRow[], categoryId: string, existing?: CostCentreRow): Choice[] {
  const below = existing ? centreDescendants(centres, existing.id) : new Set<string>();
  const eligible = centres.filter(centre => centre.id !== existing?.id && !below.has(centre.id) && (centre.categoryId === categoryId || centre.id === existing?.parentId));
  const rows = eligible.map(centre => ({ centre, path: centrePath(centres, centre.id) })).sort((left, right) => collator.compare(left.path.join(' › '), right.path.join(' › ')));
  return [
    { value: topLevelChoice, label: 'Top level', description: 'Not under another centre' },
    ...rows.map(({ centre, path }) => ({ value: centre.id, label: centre.name, description: `${path.length > 1 ? `Under ${path.slice(0, -1).join(' › ')} · ` : ''}${centre.categoryName}` })),
  ];
}

// ---- Cost centre form ----

export type CentreFormValues = { categoryId: string; name: string; secondLanguageName: string; parentId: string };
export type CentreField = 'categoryId' | 'name' | 'secondLanguageName' | 'parentId';
/** The keyboard order of the form: the category first (as the reference asks it), then the name, then where it sits. */
export const centreFieldOrder: readonly CentreField[] = ['categoryId', 'name', 'secondLanguageName', 'parentId'];
export const emptyCentreForm = (categoryId = '', parentId: string = topLevelChoice): CentreFormValues => ({ categoryId, name: '', secondLanguageName: '', parentId });

export type CentreFormAction =
  | { type: 'set'; field: 'name' | 'secondLanguageName'; value: string }
  | { type: 'load'; values: CentreFormValues }
  | { type: 'saved' };

export function centreFormReducer(state: CentreFormValues, action: CentreFormAction): CentreFormValues {
  switch (action.type) {
    case 'load': return action.values;
    // The category and parent stay for the next entry, as the group stays for the next ledger.
    case 'saved': return { ...state, name: '', secondLanguageName: '' };
    case 'set': return { ...state, [action.field]: action.value };
  }
}

/**
 * Chooses a category. A parent in another category is dropped (back to the top level) unless it is the parent the
 * centre already has, which the server lets it keep.
 */
export function chooseCategory(values: CentreFormValues, categoryId: string, centres: readonly CostCentreRow[], existing?: CostCentreRow): CentreFormValues {
  const parent = centres.find(centre => centre.id === values.parentId);
  const keeps = !parent || parent.categoryId === categoryId || parent.id === existing?.parentId;
  return { ...values, categoryId, parentId: keeps ? values.parentId : topLevelChoice };
}

/** Chooses a parent. A centre placed under another goes in that centre's category, so the category follows. */
export function chooseParent(values: CentreFormValues, parentId: string, centres: readonly CostCentreRow[]): CentreFormValues {
  const parent = centres.find(centre => centre.id === parentId);
  return { ...values, parentId, categoryId: parent ? parent.categoryId : values.categoryId };
}

/** What the centre form checks; the category and parent must be among the lookups' options, never free text. */
export function validateCentreForm(values: CentreFormValues, categoryIds: ReadonlySet<string>, parentIds: ReadonlySet<string>): Partial<Record<CentreField, string>> {
  const errors: Partial<Record<CentreField, string>> = {};
  if (!values.categoryId) errors.categoryId = 'Choose the cost category this centre belongs to.';
  else if (!categoryIds.has(values.categoryId)) errors.categoryId = 'Choose one of the listed categories.';
  if (!values.name.trim()) errors.name = 'Enter the cost centre name.';
  else if (values.name.trim().length > 120) errors.name = 'Use at most 120 characters.';
  if (values.secondLanguageName.trim().length > 120) errors.secondLanguageName = 'Use at most 120 characters.';
  if (values.parentId !== topLevelChoice && !parentIds.has(values.parentId)) errors.parentId = 'Choose one of the listed centres, or the top level.';
  return errors;
}

export const centrePayload = (values: CentreFormValues, revision?: number) => ({
  name: values.name.trim(), secondLanguageName: values.secondLanguageName.trim() || null, categoryId: values.categoryId,
  parentId: values.parentId === topLevelChoice ? null : values.parentId,
  ...(revision === undefined ? {} : { revision }),
});

export const centreFormOf = (centre: CostCentreRow): CentreFormValues => ({
  categoryId: centre.categoryId, name: centre.name, secondLanguageName: centre.secondLanguageName ?? '', parentId: centre.parentId ?? topLevelChoice,
});

// ---- Cost category form ----

export type CategoryFormValues = { name: string; secondLanguageName: string; allocateRevenue: boolean; allocateNonRevenue: boolean };
export type CategoryField = 'name' | 'secondLanguageName' | 'allocateRevenue' | 'allocateNonRevenue';
/** The two category settings in our own words: whether its centres may be allocated on income and expense ledgers, and on balance-sheet ledgers. */
export const categoryUseLabels = { allocateRevenue: 'Used on income and expense ledgers', allocateNonRevenue: 'Used on balance-sheet ledgers' } as const;
export function categoryUse(category: { allocateRevenue: boolean; allocateNonRevenue: boolean }): string {
  if (category.allocateRevenue && category.allocateNonRevenue) return 'income, expense and balance-sheet ledgers';
  return category.allocateRevenue ? 'income and expense ledgers' : category.allocateNonRevenue ? 'balance-sheet ledgers' : 'no ledgers';
}

/** A new category is for income and expense ledgers and not for balance-sheet ones, the defaults the server applies too. */
export const emptyCategoryForm = (): CategoryFormValues => ({ name: '', secondLanguageName: '', allocateRevenue: true, allocateNonRevenue: false });

export type CategoryFormAction =
  | { type: 'set'; field: 'name' | 'secondLanguageName'; value: string }
  | { type: 'flag'; field: 'allocateRevenue' | 'allocateNonRevenue'; value: boolean }
  | { type: 'saved' };

export function categoryFormReducer(state: CategoryFormValues, action: CategoryFormAction): CategoryFormValues {
  switch (action.type) {
    case 'saved': return { ...state, name: '', secondLanguageName: '' };
    case 'flag': return { ...state, [action.field]: action.value };
    case 'set': return { ...state, [action.field]: action.value };
  }
}

export function validateCategoryForm(values: CategoryFormValues): Partial<Record<CategoryField, string>> {
  const errors: Partial<Record<CategoryField, string>> = {};
  if (!values.name.trim()) errors.name = 'Enter the cost category name.';
  else if (values.name.trim().length > 120) errors.name = 'Use at most 120 characters.';
  if (values.secondLanguageName.trim().length > 120) errors.secondLanguageName = 'Use at most 120 characters.';
  return errors;
}

export const categoryPayload = (values: CategoryFormValues, revision?: number) => ({
  name: values.name.trim(), secondLanguageName: values.secondLanguageName.trim() || null,
  allocateRevenue: values.allocateRevenue, allocateNonRevenue: values.allocateNonRevenue,
  ...(revision === undefined ? {} : { revision }),
});

export const categoryFormOf = (category: CostCategoryRow): CategoryFormValues => ({
  name: category.name, secondLanguageName: category.secondLanguageName ?? '', allocateRevenue: category.allocateRevenue, allocateNonRevenue: category.allocateNonRevenue,
});

/** Why a category cannot be deleted from what the page knows (the built-in one); a used one is left to the server's refusal. */
export const categoryDeleteReason = (category: CostCategoryRow): string | null =>
  category.systemKey ? 'The built-in category can be renamed but not deleted.' : null;

// ---- The ledger's "takes cost centres" setting ----

/** What the server picks for a ledger that says nothing: income and expense ledgers take cost centres, others do not. */
export const costCentresDefault = (nature: string | null | undefined): boolean => nature === 'income' || nature === 'expense';

/** The ledger form's state with the setting added: null follows the group's default until a choice is made (create only). */
export type WithCostSetting<V> = V & { costCentres: boolean | null };
export type CostSettingAction = { type: 'costCentres'; value: boolean };

/** Extends a form reducer with the setting, which a saved entry resets to following the group. */
export function withCostSetting<V extends object, A extends { type: string }>(inner: (state: V, action: A) => V) {
  return (state: WithCostSetting<V>, action: A | CostSettingAction): WithCostSetting<V> => {
    if (action.type === 'costCentres') return { ...state, costCentres: (action as CostSettingAction).value };
    const next = { ...state, ...inner(state, action as A) };
    return action.type === 'saved' ? { ...next, costCentres: null } : next;
  };
}

/** The setting in force: the one chosen, or the default for the group's nature. */
export const effectiveCostSetting = (chosen: boolean | null, nature: string | null | undefined): boolean => chosen ?? costCentresDefault(nature);

// ---- Search values of the routes ----

/** The `category` and `parent` search values of the create-centre screen: ids carried from the list, nothing else. */
export function costCreateSearch(search: Record<string, unknown>): { category?: string; parent?: string } {
  const id = (value: unknown) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value.toLowerCase() : undefined;
  const category = id(search.category), parent = id(search.parent);
  return { ...category ? { category } : {}, ...parent ? { parent } : {} };
}

/** `move` on the alter-centre screen starts the cursor on the category, which is where a move begins. */
export const costMoveSearch = (search: Record<string, unknown>): { move?: true } => search.move === true || search.move === 'true' || search.move === 1 || search.move === '1' ? { move: true } : {};

// ---- History ----

type Snapshot = Record<string, unknown>;
const snapshot = (value: unknown): Snapshot | null => value !== null && typeof value === 'object' ? value as Snapshot : null;
const text = (value: unknown): string => typeof value === 'string' && value !== '' ? value : 'none';
const yes = (value: unknown): string => value === true ? 'yes' : 'no';

/** What one history entry of a cost category or centre changed, as short sentences; `centreName` resolves a parent id. */
export function describeCostChanges(revision: RevisionRow, centreName: (id: string) => string | null): string[] {
  const before = snapshot(revision.before), after = snapshot(revision.after);
  const parent = (value: unknown) => typeof value === 'string' ? centreName(value) ?? 'a centre that was deleted since' : 'Top level';
  const facts = (side: Snapshot): [string, string][] => revision.entity === 'cost_category'
    ? [['Name', text(side.name)], ['Second-language name', text(side.secondLanguageName)], [categoryUseLabels.allocateRevenue, yes(side.allocateRevenue)], [categoryUseLabels.allocateNonRevenue, yes(side.allocateNonRevenue)]]
    : [['Category', text(side.categoryName)], ['Name', text(side.name)], ['Second-language name', text(side.secondLanguageName)], ['Under', parent(side.parentId)]];
  if (revision.action === 'delete') return ['Deleted'];
  if (!after) return [];
  if (!before) return facts(after).filter(([, value]) => value !== 'none').map(([label, value]) => `${label}: ${value}`);
  const old = new Map(facts(before));
  return facts(after).filter(([label, value]) => old.get(label) !== value).map(([label, value]) => `${label}: ${old.get(label)} → ${value}`);
}

/** The change to a ledger's "takes cost centres" setting in one history entry (the ledger history lists it with its other facts). */
export function describeLedgerCostChange(revision: RevisionRow): string[] {
  const before = snapshot(revision.before), after = snapshot(revision.after);
  if (revision.entity !== 'ledger' || revision.action === 'delete' || !after || typeof after.costCentres !== 'boolean') return [];
  if (!before) return [`Takes cost centres: ${yes(after.costCentres)}`];
  return before.costCentres === after.costCentres ? [] : [`Takes cost centres: ${yes(before.costCentres)} → ${yes(after.costCentres)}`];
}
