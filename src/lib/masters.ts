import { formatMoney, parseMoney, type MoneyExponent } from '@ten98/runtime/browser';
import { natures, sides, type AccountGroup, type Ledger, type LedgerErrorCode, type Nature, type Revision, type Side } from './ledger.ts';
import { normalizeAmountInput, type Wire } from './money.ts';

/**
 * Client-side helpers of the masters screens: the chart tree, lookup choices, the rules the page already has the data
 * to explain, form state and the plain-language history. None of it decides what is allowed: the server enforces every
 * rule (docs/LEDGER.md), and what it refuses is shown as it says it. Amounts are strings here and become minor units
 * only through `parseMoney` with the company's exponent, never a JavaScript number.
 */

/** `inUse` comes with the list and read routes (a delete would be refused); the answers to create and alter omit it. */
export type GroupRow = Wire<AccountGroup> & { inUse?: boolean };
export type LedgerRow = Wire<Ledger> & { inUse?: boolean };
export type RevisionRow = Wire<Revision>;

export const natureOrder: readonly Nature[] = natures;
export const natureTitles: Record<Nature, string> = { asset: 'Assets', liability: 'Liabilities', income: 'Income', expense: 'Expenses' };
export const natureSingular: Record<Nature, string> = { asset: 'Asset', liability: 'Liability', income: 'Income', expense: 'Expense' };
export const sideTitles: Record<Side, string> = { Dr: 'Debit', Cr: 'Credit' };

/** The side an opening balance usually sits on: liabilities and income are credit balances, assets and expenses debit. */
export const defaultSide = (nature: Nature | null | undefined): Side => nature === 'liability' || nature === 'income' ? 'Cr' : 'Dr';

/** Wraps user text in bidi isolates so a name in one script cannot reorder the words around it (the screens hold in RTL). */
export const isolate = (text: string): string => `⁨${text}⁩`;

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const byName = <T extends { name: string; id: string }>(left: T, right: T) => collator.compare(left.name, right.name) || (left.id < right.id ? -1 : 1);

/** `1250.5` becomes `1,250.500` for a three-decimal company; display only, the wire form has no grouping. */
export function displayAmount(amount: string, exponent: MoneyExponent): string {
  const plain = formatMoney(parseMoney(amount, exponent), exponent);
  const [whole, fraction] = plain.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const grouped = whole.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

// ---- The chart tree ----

export type ChartRow =
  | { key: string; kind: 'heading'; nature: Nature | null; label: string; groups: number; ledgers: number }
  | { key: string; kind: 'group'; id: string; depth: number; group: GroupRow; groups: number; ledgers: number }
  | { key: string; kind: 'ledger'; id: string; depth: number; ledger: LedgerRow };

/**
 * The chart as one ordered list: a heading per nature, each primary group below it, its sub-groups and ledgers nested
 * (sub-groups first, then ledgers, each by name), and the ledger without a group last. A group's counts cover its whole
 * sub-tree. One pass over each list, so hundreds of rows cost nothing.
 */
export function buildChartRows(groups: readonly GroupRow[], ledgers: readonly LedgerRow[]): ChartRow[] {
  const childGroups = new Map<string | null, GroupRow[]>();
  for (const group of groups) {
    const list = childGroups.get(group.parentId) ?? [];
    list.push(group);
    childGroups.set(group.parentId, list);
  }
  const groupLedgers = new Map<string | null, LedgerRow[]>();
  for (const ledger of ledgers) {
    const list = groupLedgers.get(ledger.groupId) ?? [];
    list.push(ledger);
    groupLedgers.set(ledger.groupId, list);
  }
  for (const list of childGroups.values()) list.sort(byName);
  for (const list of groupLedgers.values()) list.sort(byName);

  const visited = new Set<string>();
  const walk = (group: GroupRow, depth: number, out: ChartRow[]): { groups: number; ledgers: number } => {
    visited.add(group.id);
    const row: ChartRow = { key: `group:${group.id}`, kind: 'group', id: group.id, depth, group, groups: 0, ledgers: 0 };
    out.push(row);
    let nestedGroups = 0, nestedLedgers = 0;
    for (const child of childGroups.get(group.id) ?? []) {
      if (visited.has(child.id)) continue;
      const counts = walk(child, depth + 1, out);
      nestedGroups += 1 + counts.groups;
      nestedLedgers += counts.ledgers;
    }
    for (const ledger of groupLedgers.get(group.id) ?? []) {
      out.push({ key: `ledger:${ledger.id}`, kind: 'ledger', id: ledger.id, depth: depth + 1, ledger });
      nestedLedgers += 1;
    }
    row.groups = nestedGroups; row.ledgers = nestedLedgers;
    return { groups: nestedGroups, ledgers: nestedLedgers };
  };

  const rows: ChartRow[] = [];
  for (const nature of natureOrder) {
    const body: ChartRow[] = [];
    let groupCount = 0, ledgerCount = 0;
    for (const primary of (childGroups.get(null) ?? []).filter(group => group.nature === nature)) {
      const counts = walk(primary, 1, body);
      groupCount += 1 + counts.groups; ledgerCount += counts.ledgers;
    }
    if (body.length) rows.push({ key: `nature:${nature}`, kind: 'heading', nature, label: natureTitles[nature], groups: groupCount, ledgers: ledgerCount }, ...body);
  }
  const loose = groupLedgers.get(null) ?? [];
  if (loose.length) {
    rows.push({ key: 'nature:none', kind: 'heading', nature: null, label: 'Outside every group', groups: 0, ledgers: loose.length });
    for (const ledger of loose) rows.push({ key: `ledger:${ledger.id}`, kind: 'ledger', id: ledger.id, depth: 1, ledger });
  }
  return rows;
}

/** Rows a cursor can rest on (headings only label a section). */
export const isCursorRow = (row: ChartRow): row is Exclude<ChartRow, { kind: 'heading' }> => row.kind !== 'heading';

// ---- Groups as lookup choices and the rules the page can explain ----

export const primaryChoice = 'primary';

/** Ids of the groups below `groupId`, at any depth. */
export function descendantIds(groups: readonly GroupRow[], groupId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const group of groups) if (group.parentId) children.set(group.parentId, [...children.get(group.parentId) ?? [], group.id]);
  const found = new Set<string>();
  const queue = [...children.get(groupId) ?? []];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (found.has(id)) continue;
    found.add(id);
    queue.push(...children.get(id) ?? []);
  }
  return found;
}

/** Names from the primary group down to the group itself. */
export function groupPath(groups: readonly GroupRow[], groupId: string | null): string[] {
  const byId = new Map(groups.map(group => [group.id, group]));
  const path: string[] = [];
  for (let current = groupId === null ? undefined : byId.get(groupId); current && path.length < 64; current = current.parentId === null ? undefined : byId.get(current.parentId)) path.unshift(current.name);
  return path;
}

const cashBankKeys = new Set(['cash_in_hand', 'bank_accounts', 'bank_overdraft']);

/** Groups that are, or sit below, a seeded cash or bank group (D-10): where cash behaviour comes from. */
export function cashFamilyIds(groups: readonly GroupRow[]): Set<string> {
  const family = new Set<string>();
  for (const group of groups) if (group.systemKey && cashBankKeys.has(group.systemKey)) { family.add(group.id); for (const id of descendantIds(groups, group.id)) family.add(id); }
  return family;
}

export type Choice = { value: string; label: string; description?: string; disabled?: boolean; disabledReason?: string };

/**
 * Lookup choices for a group field, in tree order so a sub-group follows its parent. Each shows where the group sits, so
 * two groups with one name can be told apart. `reason` names why a group cannot be chosen; it is then listed but disabled.
 */
export function groupChoices(groups: readonly GroupRow[], options: { primary?: boolean; reason?: (group: GroupRow) => string | null } = {}): Choice[] {
  const rows = buildChartRows(groups, []).filter(row => row.kind === 'group');
  const choices = rows.map(row => {
    const group = row.group;
    const parent = groupPath(groups, group.parentId).join(' › ');
    const reason = options.reason?.(group) ?? null;
    return {
      value: group.id, label: group.name,
      description: group.parentId === null ? `Primary group · ${natureSingular[group.nature]}` : `In ${parent} · ${natureSingular[group.nature]}`,
      ...(reason ? { disabled: true, disabledReason: reason } : {}),
    };
  });
  return options.primary ? [{ value: primaryChoice, label: 'Primary', description: 'A top-level group with its own nature' }, ...choices] : choices;
}

/** Whether the group's sub-tree holds anything the nature must not change under (D-10), as far as the page's data shows. */
export function natureLockReason(group: GroupRow, groups: readonly GroupRow[], ledgers: readonly LedgerRow[]): string | null {
  if (group.systemKey) return 'A built-in group keeps its nature.';
  const tree = descendantIds(groups, group.id);
  tree.add(group.id);
  if (groups.some(other => tree.has(other.id) && other.systemKey)) return 'The nature is fixed while this group holds built-in groups.';
  const held = ledgers.find(ledger => ledger.groupId !== null && tree.has(ledger.groupId) && (ledger.systemKey || ledger.opening.amount.replace(/[0.]/g, '') !== ''));
  if (held) return held.systemKey ? 'The nature is fixed while this group holds a built-in ledger.' : 'The nature is fixed while a ledger below holds an opening balance. Move that ledger to another group first.';
  return null;
}

/** Why `candidate` cannot be the parent of `group`, or null. Mirrors what the server refuses; the server still decides. */
export function parentReason(group: GroupRow, candidate: GroupRow, groups: readonly GroupRow[], ledgers: readonly LedgerRow[]): string | null {
  if (candidate.id === group.id || descendantIds(groups, group.id).has(candidate.id)) return 'A group cannot sit under itself or its own sub-groups.';
  // Staying where it is changes nothing, so no rule applies to it.
  if (candidate.id === group.parentId) return null;
  if (candidate.nature !== group.nature && natureLockReason(group, groups, ledgers)) return `This group keeps its nature (${natureSingular[group.nature]}).`;
  if (!cashFamilyIds(groups).has(candidate.id)) {
    const tree = descendantIds(groups, group.id);
    tree.add(group.id);
    if (ledgers.some(ledger => ledger.systemKey === 'cash' && ledger.groupId !== null && tree.has(ledger.groupId))) return 'The cash ledger must stay under a cash or bank group.';
  }
  return null;
}

/** Why the ledger cannot be placed in `candidate`, or null (built-in ledgers stay in their family). */
export function ledgerGroupReason(ledger: LedgerRow | null, candidate: GroupRow, groups: readonly GroupRow[]): string | null {
  if (!ledger?.systemKey || candidate.id === ledger.groupId) return null;
  if (ledger.nature !== null && candidate.nature !== ledger.nature) return `A built-in ledger keeps its nature (${natureSingular[ledger.nature]}).`;
  if (ledger.systemKey === 'cash' && !cashFamilyIds(groups).has(candidate.id)) return 'The cash ledger must stay under a cash or bank group.';
  return null;
}

export function groupDeleteReason(group: GroupRow, groups: readonly GroupRow[], ledgers: readonly LedgerRow[]): string | null {
  if (group.systemKey) return 'Built-in groups can be renamed but not deleted.';
  // The server says whether a delete would be refused (`inUse`); the page's own lists answer only while that is missing.
  const held = group.inUse ?? (groups.some(other => other.parentId === group.id) || ledgers.some(ledger => ledger.groupId === group.id));
  return held ? 'This group still holds sub-groups or ledgers. Move or delete them first.' : null;
}

/** A ledger is in use once a voucher line names it, which the server reports as `inUse`; built-in ledgers are refused on another ground. */
export const ledgerDeleteReason = (ledger: LedgerRow): string | null =>
  ledger.systemKey ? 'Built-in ledgers can be renamed but not deleted.' : ledger.inUse ? 'This ledger is used in vouchers and cannot be deleted.' : null;

/** Opening balances are as of books beginning, so a lock through that date freezes them (D-09). */
export const openingLocked = (company: { booksBeginning: string; lockedThrough: string | null }): boolean => company.lockedThrough !== null && company.lockedThrough >= company.booksBeginning;

// ---- Group form ----

export type GroupFormValues = { name: string; secondLanguageName: string; parentId: string; nature: Nature | ''; grossProfit: boolean };
export type GroupField = 'name' | 'secondLanguageName' | 'parentId' | 'nature' | 'grossProfit';
export const emptyGroupForm = (parentId = ''): GroupFormValues => ({ name: '', secondLanguageName: '', parentId, nature: '', grossProfit: false });

/** Fields shown, in keyboard order. Nature appears only for a primary group, the gross-profit flag only for income and expense. */
export function groupFields(values: GroupFormValues): GroupField[] {
  const fields: GroupField[] = ['name', 'secondLanguageName', 'parentId'];
  if (values.parentId === primaryChoice) {
    fields.push('nature');
    if (values.nature === 'income' || values.nature === 'expense') fields.push('grossProfit');
  }
  return fields;
}

export type GroupFormAction =
  | { type: 'set'; field: 'name' | 'secondLanguageName' | 'parentId'; value: string }
  | { type: 'set'; field: 'nature'; value: Nature | '' }
  | { type: 'set'; field: 'grossProfit'; value: boolean }
  | { type: 'load'; values: GroupFormValues }
  | { type: 'saved' };

export function groupFormReducer(state: GroupFormValues, action: GroupFormAction): GroupFormValues {
  switch (action.type) {
    case 'load': return action.values;
    // Ready for the next entry: the parent (and a primary group's nature) stay, the names go.
    case 'saved': return { ...state, name: '', secondLanguageName: '' };
    case 'set': {
      const next = { ...state, [action.field]: action.value } as GroupFormValues;
      if (action.field === 'parentId' && action.value !== primaryChoice) { next.nature = ''; next.grossProfit = false; }
      if (action.field === 'nature' && action.value !== 'income' && action.value !== 'expense') next.grossProfit = false;
      return next;
    }
  }
}

/** What the group form checks. The parent must be one of the lookup's options (`parentIds`) or Primary, never free text. */
export function validateGroupForm(values: GroupFormValues, parentIds: ReadonlySet<string>): Partial<Record<GroupField, string>> {
  const errors: Partial<Record<GroupField, string>> = {};
  if (!values.name.trim()) errors.name = 'Enter the group name.';
  else if (values.name.trim().length > 120) errors.name = 'Use at most 120 characters.';
  if (values.secondLanguageName.trim().length > 120) errors.secondLanguageName = 'Use at most 120 characters.';
  if (!values.parentId) errors.parentId = 'Choose the group this one sits under, or Primary.';
  else if (values.parentId !== primaryChoice && !parentIds.has(values.parentId)) errors.parentId = 'Choose one of the listed groups, or Primary.';
  else if (values.parentId === primaryChoice) {
    if (!values.nature) errors.nature = 'Choose the nature of a primary group.';
    else if (!natures.includes(values.nature)) errors.nature = 'Choose one of the four natures.';
  }
  return errors;
}

/** The request body for creating a group, or altering it when `revision` is given. */
export function groupPayload(values: GroupFormValues, revision?: number) {
  const primary = values.parentId === primaryChoice;
  return {
    name: values.name.trim(), secondLanguageName: values.secondLanguageName.trim() || null,
    parentId: primary ? null : values.parentId,
    ...(primary ? { nature: values.nature as Nature, grossProfit: values.grossProfit } : {}),
    ...(revision === undefined ? {} : { revision }),
  };
}

export function groupFormOf(group: GroupRow): GroupFormValues {
  return { name: group.name, secondLanguageName: group.secondLanguageName ?? '', parentId: group.parentId ?? primaryChoice, nature: group.parentId === null ? group.nature : '', grossProfit: group.parentId === null && group.grossProfit };
}

// ---- Ledger form ----

export type LedgerFormValues = { name: string; secondLanguageName: string; groupId: string; amount: string; side: Side | null };
export type LedgerField = 'name' | 'secondLanguageName' | 'groupId' | 'amount' | 'side';
export const ledgerFieldOrder: readonly LedgerField[] = ['name', 'secondLanguageName', 'groupId', 'amount', 'side'];
export const emptyLedgerForm = (groupId = ''): LedgerFormValues => ({ name: '', secondLanguageName: '', groupId, amount: '', side: null });

export type LedgerFormAction =
  | { type: 'set'; field: 'name' | 'secondLanguageName' | 'groupId' | 'amount'; value: string }
  | { type: 'side'; value: Side }
  | { type: 'load'; values: LedgerFormValues }
  | { type: 'saved' };

export function ledgerFormReducer(state: LedgerFormValues, action: LedgerFormAction): LedgerFormValues {
  switch (action.type) {
    case 'load': return action.values;
    case 'side': return { ...state, side: action.value };
    // The group stays for the next entry; the side follows that group's nature again until it is chosen.
    case 'saved': return { ...state, name: '', secondLanguageName: '', amount: '', side: null };
    case 'set': return { ...state, [action.field]: action.value };
  }
}

/** The side in force: the one chosen, or the default for the group's nature. */
export function effectiveSide(values: LedgerFormValues, groups: readonly GroupRow[]): Side {
  return values.side ?? defaultSide(groups.find(group => group.id === values.groupId)?.nature);
}

/** An example amount in the company's currency format, for helper text: `1,250.50`, `1,250.500` or `1,250`. */
export const amountExample = (exponent: MoneyExponent): string => exponent === 0 ? '1,250' : `1,250.${'5'.padEnd(exponent, '0')}`;

/** An amount field's problem in plain words, or null. Blank means no opening balance. */
export function amountProblem(text: string, exponent: MoneyExponent): string | null {
  const value = text.trim();
  if (value === '') return null;
  if (/^-/.test(value)) return 'Enter the opening balance as a positive amount and choose Dr or Cr.';
  const plain = normalizeAmountInput(value);
  if (plain === null) return `Enter an amount such as ${amountExample(exponent)}: digits, a decimal point, and commas only between groups of three digits.`;
  if ((plain.split('.')[1] ?? '').length > exponent) return exponent === 0 ? 'This currency has no decimal places.' : `This currency has ${exponent} decimal places at most.`;
  try { parseMoney(plain, exponent); } catch { return 'This amount is too large.'; }
  return null;
}

/** The amount as the plain decimal string `parseMoney` takes, or '' when blank or malformed (validation reports the latter). */
export const plainAmount = (text: string): string => normalizeAmountInput(text) ?? '';

/**
 * What the ledger form checks. The group must be one of the lookup's options (`groupIds`), never free text; `groupOptional`
 * is for the profit and loss ledger, which has no group. The side is Dr or Cr or not chosen yet (it then follows the group).
 */
export function validateLedgerForm(values: LedgerFormValues, exponent: MoneyExponent, groupIds: ReadonlySet<string>, groupOptional = false): Partial<Record<LedgerField, string>> {
  const errors: Partial<Record<LedgerField, string>> = {};
  if (!values.name.trim()) errors.name = 'Enter the ledger name.';
  else if (values.name.trim().length > 120) errors.name = 'Use at most 120 characters.';
  if (values.secondLanguageName.trim().length > 120) errors.secondLanguageName = 'Use at most 120 characters.';
  if (!values.groupId) { if (!groupOptional) errors.groupId = 'Choose the group this ledger belongs to.'; }
  else if (!groupIds.has(values.groupId)) errors.groupId = 'Choose one of the listed groups.';
  if (values.side !== null && !sides.includes(values.side)) errors.side = 'Choose Dr or Cr.';
  const amount = amountProblem(values.amount, exponent);
  if (amount) errors.amount = amount;
  return errors;
}

/** The request body for creating a ledger, or altering it when `revision` is given (an altered ledger always states its opening). */
export function ledgerPayload(values: LedgerFormValues, groups: readonly GroupRow[], exponent: MoneyExponent, revision?: number) {
  const amount = plainAmount(values.amount);
  const opening = amount === '' ? undefined : { amount: formatMoney(parseMoney(amount, exponent), exponent), side: effectiveSide(values, groups) };
  return {
    name: values.name.trim(), secondLanguageName: values.secondLanguageName.trim() || null, groupId: values.groupId || null,
    ...(revision === undefined ? (opening ? { opening } : {}) : { opening: opening ?? { amount: formatMoney(0n, exponent), side: effectiveSide(values, groups) }, revision }),
  };
}

export function ledgerFormOf(ledger: LedgerRow): LedgerFormValues {
  const zero = ledger.opening.amount.replace(/[0.]/g, '') === '';
  return { name: ledger.name, secondLanguageName: ledger.secondLanguageName ?? '', groupId: ledger.groupId ?? '', amount: zero ? '' : ledger.opening.amount, side: zero ? null : ledger.opening.side };
}

// ---- Lookups ----

const words = (text: string) => text.toLocaleLowerCase().split(/[\s·›/-]+/).filter(Boolean);

/**
 * What a lookup field's typed text means. The field's value is always one of its options, never the text: blank text
 * clears it, text equal to the chosen label keeps it, and text that names exactly one choice (the whole label, or the
 * start of the label or of one of its words, such as "cre" for "Cr · Credit") picks it. Anything else, including text
 * that fits several choices or only a choice a rule disables, is an error in plain words and nothing is chosen.
 */
export function resolveLookup(options: readonly Choice[], text: string, current: string): { value: string } | { error: string } {
  const typed = text.trim().toLocaleLowerCase();
  if (typed === '') return { value: '' };
  const chosen = options.find(option => option.value === current && !option.disabled);
  if (chosen && chosen.label.toLocaleLowerCase() === typed) return { value: current };
  const fits = (option: Choice) => option.label.toLocaleLowerCase().startsWith(typed) || words(option.label).some(word => word.startsWith(typed));
  const exact = options.filter(option => !option.disabled && option.label.toLocaleLowerCase() === typed);
  const found = exact.length ? exact : options.filter(option => !option.disabled && fits(option));
  if (found.length === 1) return { value: found[0].value };
  if (found.length > 1) return { error: `“${text.trim()}” could mean more than one choice. Type more of the name, or pick from the list.` };
  const blocked = options.filter(option => option.disabled && fits(option));
  if (blocked.length === 1 && blocked[0].disabledReason) return { error: blocked[0].disabledReason };
  return { error: `“${text.trim()}” is not one of the choices. Pick one from the list.` };
}

/** Whether `value` is the value of an enabled option: the only values a lookup may hold. */
export const isChoice = (options: readonly Choice[], value: string): boolean => options.some(option => option.value === value && !option.disabled);

/**
 * Runs one request at a time: a second call while one is running is ignored (resolves undefined) instead of sending
 * the same request twice, which is what two accept keys in one tick would otherwise do.
 */
export function singleFlight(): <T>(task: () => Promise<T>) => Promise<T | undefined> {
  let running = false;
  return async task => {
    if (running) return undefined;
    running = true;
    try { return await task(); } finally { running = false; }
  };
}

/** What a lookup does with a key, decided from the chord, the list state and the keymap's accept chords. */
export type LookupKeyAction = 'ignore' | 'cancel' | 'accept-row' | 'accept-text' | 'pick-text';

/**
 * `chord` is the canonical chord of the key (undefined for a lone modifier or composition). The stock combobox keeps
 * Escape (with its list closed too) and Enter, and a chord it ignores never reaches the form while its list is open, so
 * the lookup decides: Escape with the list closed leaves the screen (`cancel`), with it open only the combobox closes the
 * list (`ignore`); a chord bound to accept (any, from the active keymap) with the list open picks the highlighted row
 * first (`accept-row`) or, with none, settles the typed text first (`accept-text`); plain Enter on typed text with no row
 * highlighted settles it and moves on (`pick-text`).
 */
export function lookupKeyAction(input: { chord: string | undefined; open: boolean; highlighted: boolean; acceptKeys: readonly string[] }): LookupKeyAction {
  const { chord, open, highlighted, acceptKeys } = input;
  if (chord === undefined) return 'ignore';
  if (chord === 'Escape') return open ? 'ignore' : 'cancel';
  if (open && acceptKeys.includes(chord)) return highlighted ? 'accept-row' : 'accept-text';
  if (chord === 'Enter' && open && !highlighted) return 'pick-text';
  return 'ignore';
}

// ---- Fixed keyboard order ----

/** The field after `current`, or 'confirm' after the last one (Enter on the last field asks to save). */
export function nextFieldAfter<F extends string>(fields: readonly F[], current: F): F | 'confirm' {
  const index = fields.indexOf(current);
  return index < 0 || index >= fields.length - 1 ? 'confirm' : fields[index + 1];
}

// ---- Failures in plain language ----

export type Failure = { message: string; stale: boolean; code?: LedgerErrorCode | string };

/**
 * Classifies an API failure by the server's stable `code`, never by its sentence. The server's sentences are already
 * plain and are shown as they are; a missing item and a rate limit (which has no code) are worded here.
 */
export function describeFailure(status: number | undefined, message: string, code?: string): Failure {
  if (code === 'not_found' || (code === undefined && status === 404)) return { stale: false, code, message: 'This item no longer exists, or your role in the workspace cannot change it. Reload the list to check.' };
  if (status === 429) return { stale: false, code, message: 'Too many changes in a short time. Wait a moment, then try again.' };
  return { stale: code === 'stale_revision', code, message };
}

// ---- History ----

/** Who made a change: the signed-in user as "You", every other member by the name the server gives, and a gone member as such. */
export function actorLabel(actorId: string, actorName: string | null, me: { id: string; name: string }): string {
  if (actorId === me.id) return `You (${actorName ?? me.name})`;
  return actorName ?? 'A member who has since left';
}

export const actionTitles: Record<RevisionRow['action'], string> = { create: 'Created', alter: 'Changed', cancel: 'Cancelled', delete: 'Deleted' };

type Snapshot = Record<string, unknown>;
const snapshot = (value: unknown): Snapshot | null => value !== null && typeof value === 'object' ? value as Snapshot : null;
const text = (value: unknown): string => typeof value === 'string' && value !== '' ? value : 'none';

/** An opening balance snapshot holds exact minor units as a string. */
function openingText(value: unknown, exponent: MoneyExponent): string {
  const opening = snapshot(value);
  const minor = typeof opening?.amount === 'string' && /^-?\d+$/.test(opening.amount) ? BigInt(opening.amount) : null;
  if (minor === null) return 'none';
  return minor === 0n ? 'none' : `${displayAmount(formatMoney(minor, exponent), exponent)} ${String(opening?.side)}`;
}

/** What one history entry changed, as short sentences; `groupName` resolves a group id that a snapshot only holds as an id. */
export function describeChanges(revision: RevisionRow, exponent: MoneyExponent, groupName: (id: string) => string | null): string[] {
  const before = snapshot(revision.before), after = snapshot(revision.after);
  const group = (value: unknown) => typeof value === 'string' ? groupName(value) ?? 'a group that was deleted since' : 'Primary';
  const facts = (side: Snapshot): [string, string][] => revision.entity === 'ledger'
    ? [['Name', text(side.name)], ['Second-language name', text(side.secondLanguageName)], ['Group', text(side.groupName)], ['Opening balance', openingText(side.opening, exponent)]]
    : [['Name', text(side.name)], ['Second-language name', text(side.secondLanguageName)], ['Under', group(side.parentId)], ['Nature', typeof side.nature === 'string' ? natureSingular[side.nature as Nature] ?? text(side.nature) : 'none'], ['Counts towards gross profit', side.grossProfit === true ? 'yes' : 'no']];
  if (revision.action === 'delete') return ['Deleted'];
  if (!after) return [];
  if (!before) return facts(after).filter(([, value]) => value !== 'none').map(([label, value]) => `${label}: ${value}`);
  const old = new Map(facts(before));
  return facts(after).filter(([label, value]) => old.get(label) !== value).map(([label, value]) => `${label}: ${old.get(label)} → ${value}`);
}

// ---- Routes ----

/** The `under` search value of the create screens: the group a new master starts under, carried from the chart. */
export const underSearch = (search: Record<string, unknown>): { under?: string } =>
  typeof search.under === 'string' && /^[0-9a-f-]{36}$/i.test(search.under) ? { under: search.under.toLowerCase() } : {}
