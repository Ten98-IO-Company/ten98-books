import {
  groupAlterInput, groupCreateInput, ledgerAlterInput, ledgerCreateInput, revisionInput, voucherTypeAlterInput,
  type AccountGroup, type CreditPeriod, type CreditUnit, type GroupListItem, type Ledger, type LedgerListItem, type Nature,
  type OpeningBill, type Side, type VoucherType,
} from '../../lib/ledger.ts';
import { FoundationError } from '../auth.ts';
import { assertBillRowsFit, planOpeningBills, writeBills } from './bills.ts';
import { conflict, ledgerError, parseAmount, parseInput, refusal, type LedgerContext } from './context.ts';
import { logRevision } from './revisions.ts';

/**
 * Masters (D-10): account groups, ledgers and voucher types. Behaviour hangs on `system_key`, never on names, so users
 * rename and translate freely; built-in rows cannot be deleted and keep their nature. Every change writes the revision
 * log in the same transaction.
 */

/** Groups whose ledgers are cash or bank accounts, wherever they sit below them. */
export const cashBankGroupKeys = ['cash_in_hand', 'bank_accounts', 'bank_overdraft'] as const;

/**
 * Recursive CTE `tree(id, primary_id, primary_name, cash_bank)` over the company's groups ($1 is the company id): each
 * group's primary (top-level) group and whether it is, or sits below, a cash or bank group. Groups cannot form cycles.
 */
export const groupTreeSql = `tree AS (
  SELECT g.id, g.id AS primary_id, g.name AS primary_name, coalesce(g.system_key = ANY('{${cashBankGroupKeys.join(',')}}'::text[]), false) AS cash_bank
  FROM account_group g WHERE g.company_id = $1 AND g.parent_id IS NULL
  UNION ALL
  SELECT g.id, t.primary_id, t.primary_name, t.cash_bank OR coalesce(g.system_key = ANY('{${cashBankGroupKeys.join(',')}}'::text[]), false)
  FROM account_group g JOIN tree t ON g.parent_id = t.id WHERE g.company_id = $1)`;

const notFound = (what: string) => ledgerError(404, `${what} not found.`, 'not_found');
/** Rethrows a not-found refusal as `replacement` (a reference inside the request, not the addressed resource). */
export const missingAs = (replacement: FoundationError) => (error: unknown): never => {
  throw error instanceof FoundationError && error.status === 404 ? replacement : error;
};
const field = (labels: Record<string, string>, fallback: string) => (path: readonly PropertyKey[]) => labels[String(path[0])] ?? fallback;
const groupFields = field({ name: 'the group name', secondLanguageName: 'the second-language name', parentId: 'the parent group', nature: 'the nature', grossProfit: 'the gross profit setting', revision: 'the revision' }, 'the group details');
const ledgerFields = field({ name: 'the ledger name', secondLanguageName: 'the second-language name', groupId: 'the group', opening: 'the opening balance', costCentres: 'the cost centres setting', revision: 'the revision' }, 'the ledger details');
const typeFields = field({ name: 'the voucher type name', secondLanguageName: 'the second-language name', revision: 'the revision' }, 'the voucher type details');

const groupRefusals = {
  account_group_name_idx: ledgerError(409, 'A group with this name already exists.', 'duplicate_name'),
  account_group_cycle: ledgerError(400, 'A group cannot be placed under one of its own sub-groups.', 'cycle'),
  account_group_builtin: ledgerError(400, 'A built-in group keeps its nature. Choose a parent group of the same nature.', 'nature_fixed'),
  ledger_cash_family: ledgerError(400, 'The cash ledger must stay under a cash or bank group, so this group cannot move there.', 'family_rule'),
  ledger_bill_wise_family: ledgerError(400, 'This group holds bill-wise ledgers or ledgers with bills, so it cannot move under the cash and bank groups.', 'family_rule'),
};
const groupInUse = { ...groupRefusals, '23503': ledgerError(409, 'This group still holds sub-groups or ledgers. Move or delete them first.', 'in_use') };
const ledgerRefusals = {
  ledger_name_idx: ledgerError(409, 'A ledger with this name already exists.', 'duplicate_name'),
  ledger_builtin: ledgerError(400, 'A built-in ledger keeps its nature. Choose a group of the same nature.', 'nature_fixed'),
  ledger_cash_family: ledgerError(400, 'The cash ledger must stay under a cash or bank group.', 'family_rule'),
  ledger_bill_wise_family: ledgerError(400, 'Cash, bank and the profit and loss ledger keep no bills: they cannot be bill-wise, and a ledger with bills cannot move under the cash and bank groups.', 'family_rule'),
  bill_allocation_opening_locked: ledgerError(409, 'Opening bills are locked with the opening balances.', 'locked_period'),
  ledger_cost_centres_group: ledgerError(400, 'The profit and loss ledger takes no cost centres.', 'family_rule'),
};
const ledgerInUse = { ...ledgerRefusals, '23503': ledgerError(409, 'This ledger is used in vouchers and cannot be deleted.', 'in_use') };
const typeRefusals = { voucher_type_name_idx: ledgerError(409, 'A voucher type with this name already exists.', 'duplicate_name') };

// ---- Groups ----

const groupColumns = `id, parent_id AS "parentId", nature, gross_profit AS "grossProfit", system_key AS "systemKey", name,
  second_language_name AS "secondLanguageName", revision`;

/**
 * The "in use" tests that refuse a delete, as SQL over a row aliased `g` (group) or `l` (ledger). deleteGroup and
 * deleteLedger use them, and list and read rows report them as `inUse`, so a screen knows in advance what a delete
 * will refuse. A ledger is in use when any voucher line names it, including lines of cancelled and deleted vouchers.
 * Built-in rows are refused on another ground (`systemKey`), not counted here.
 */
const groupInUseSql = `(EXISTS (SELECT 1 FROM account_group c WHERE c.company_id = g.company_id AND c.parent_id = g.id)
  OR EXISTS (SELECT 1 FROM ledger x WHERE x.company_id = g.company_id AND x.group_id = g.id))`;
const ledgerInUseSql = `(EXISTS (SELECT 1 FROM voucher_line x WHERE x.company_id = l.company_id AND x.ledger_id = l.id)
  OR EXISTS (SELECT 1 FROM bill_allocation x WHERE x.company_id = l.company_id AND x.ledger_id = l.id))`;

/** Groups as the list and read routes answer them: the group plus whether a delete would be refused for use. */
export async function listGroups(context: LedgerContext): Promise<GroupListItem[]> {
  const { rows } = await context.client.query<GroupListItem>(
    `SELECT ${groupColumns}, ${groupInUseSql} AS "inUse" FROM account_group g WHERE g.company_id = $1 ORDER BY lower(g.name), g.id`, [context.company.companyId]);
  return rows;
}

export async function getGroup(context: LedgerContext, groupId: string): Promise<GroupListItem> {
  const { rows } = await context.client.query<GroupListItem>(
    `SELECT ${groupColumns}, ${groupInUseSql} AS "inUse" FROM account_group g WHERE g.company_id = $1 AND g.id = $2`, [context.company.companyId, groupId]);
  if (!rows[0]) throw notFound('Group');
  return rows[0];
}

/** Reads one group; `lock` takes its row for the rest of the transaction before reading. */
export async function readGroup(context: LedgerContext, groupId: string, lock = false): Promise<AccountGroup> {
  const { rows } = await context.client.query<AccountGroup>(`SELECT ${groupColumns} FROM account_group WHERE company_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [context.company.companyId, groupId]);
  if (!rows[0]) throw notFound('Group');
  return rows[0];
}

type Placement = { parentId: string | null; nature: Nature; grossProfit: boolean };

/** A sub-group takes its parent's nature and gross-profit flag; a primary group states its own. */
async function placeGroup(context: LedgerContext, input: { parentId: string | null; nature?: Nature; grossProfit?: boolean }, current?: AccountGroup): Promise<Placement> {
  if (input.parentId) {
    const parent = await readGroup(context, input.parentId).catch(missingAs(ledgerError(400, 'The parent group was not found.', 'not_found')));
    if (input.nature && input.nature !== parent.nature) throw ledgerError(400, 'A sub-group takes the nature of its parent group.', 'validation');
    return { parentId: parent.id, nature: parent.nature, grossProfit: parent.grossProfit };
  }
  const nature = input.nature ?? current?.nature;
  if (!nature) throw ledgerError(400, 'Choose the nature of a primary group: asset, liability, income or expense.', 'validation');
  const grossProfit = input.grossProfit ?? (current?.nature === nature ? current.grossProfit : false);
  if (grossProfit && nature !== 'income' && nature !== 'expense') throw ledgerError(400, 'Only income and expense groups can count towards gross profit.', 'validation');
  return { parentId: null, nature, grossProfit };
}

export async function createGroup(context: LedgerContext, value: unknown): Promise<AccountGroup> {
  const input = parseInput(groupCreateInput, value, groupFields);
  const place = await placeGroup(context, input);
  const { rows } = await context.client.query<{ id: string }>(
    `INSERT INTO account_group (company_id, parent_id, nature, gross_profit, name, second_language_name) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [context.company.companyId, place.parentId, place.nature, place.grossProfit, input.name, input.secondLanguageName]).catch(error => refusal(error, groupRefusals));
  const group = await readGroup(context, rows[0].id);
  await logRevision(context, 'group', group.id, 'create', null, group);
  return group;
}

/** The groups below `groupId`, at any depth. */
async function subGroups(context: LedgerContext, groupId: string): Promise<AccountGroup[]> {
  const { rows } = await context.client.query<AccountGroup>(
    `WITH RECURSIVE below(id) AS (
       SELECT id FROM account_group WHERE company_id = $1 AND parent_id = $2
       UNION ALL SELECT g.id FROM account_group g JOIN below b ON g.company_id = $1 AND g.parent_id = b.id)
     SELECT ${groupColumns} FROM account_group WHERE company_id = $1 AND id IN (SELECT id FROM below) ORDER BY id`, [context.company.companyId, groupId]);
  return rows;
}

/**
 * One change to the company's group tree, or to which group a ledger is in, at a time (the database trigger takes the
 * same lock). Taken first in a transaction, before any row lock, so concurrent changes queue instead of deadlocking.
 */
const lockGroupTree = (context: LedgerContext) => context.client.query('SELECT ledger_group_tree_lock($1)', [context.company.companyId]);

/**
 * D-10: a group's nature cannot change while its sub-tree holds a built-in group or ledger, or a ledger with posted
 * lines or an opening balance; reclassify by moving those ledgers to another group instead. The sub-tree's ledger rows
 * are locked first, in id order (the order postings take them in): a posting still in flight holds a key-share lock
 * on its ledgers, so this waits for it and the check below then sees its lines.
 */
async function assertNatureChangeable(context: LedgerContext, groupId: string): Promise<void> {
  await context.client.query(
    `WITH RECURSIVE tree(id) AS (
       SELECT $2::uuid UNION ALL SELECT g.id FROM account_group g JOIN tree t ON g.company_id = $1 AND g.parent_id = t.id)
     SELECT 1 FROM ledger l WHERE l.company_id = $1 AND l.group_id IN (SELECT id FROM tree) ORDER BY l.id FOR UPDATE OF l`, [context.company.companyId, groupId]);
  const { rows } = await context.client.query<{ held: boolean }>(
    `WITH RECURSIVE tree(id) AS (
       SELECT $2::uuid UNION ALL SELECT g.id FROM account_group g JOIN tree t ON g.company_id = $1 AND g.parent_id = t.id)
     SELECT EXISTS (SELECT 1 FROM account_group g JOIN tree t ON t.id = g.id WHERE g.company_id = $1 AND g.system_key IS NOT NULL)
       OR EXISTS (SELECT 1 FROM ledger l JOIN tree t ON t.id = l.group_id WHERE l.company_id = $1 AND (l.system_key IS NOT NULL OR l.opening_amount <> 0
         OR EXISTS (SELECT 1 FROM voucher_line x WHERE x.company_id = $1 AND x.ledger_id = l.id))) AS held`, [context.company.companyId, groupId]);
  if (rows[0].held) throw ledgerError(409, 'This group cannot change its nature while it holds built-in groups or ledgers, or ledgers with postings or opening balances. Move those ledgers to another group first.', 'nature_fixed');
}

export async function alterGroup(context: LedgerContext, groupId: string, value: unknown): Promise<AccountGroup> {
  const input = parseInput(groupAlterInput, value, groupFields);
  await lockGroupTree(context);
  const before = await readGroup(context, groupId, true);
  if (before.revision !== input.revision) throw conflict('group');
  const place = await placeGroup(context, input, before);
  if (before.systemKey && place.nature !== before.nature) throw groupRefusals.account_group_builtin;
  if (place.nature !== before.nature) await assertNatureChangeable(context, groupId);
  const cascades = place.nature !== before.nature || place.grossProfit !== before.grossProfit;
  const belowBefore = cascades ? await subGroups(context, groupId) : [];
  await context.client.query(
    `UPDATE account_group SET parent_id = $3, nature = $4, gross_profit = $5, name = $6, second_language_name = $7, revision = revision + 1
     WHERE company_id = $1 AND id = $2`,
    [context.company.companyId, groupId, place.parentId, place.nature, place.grossProfit, input.name, input.secondLanguageName]).catch(error => refusal(error, groupRefusals));
  const after = await readGroup(context, groupId);
  await logRevision(context, 'group', groupId, 'alter', before, after);
  // Sub-groups take the new nature and flag through the database cascade, which also bumps their revisions; log each.
  if (cascades) {
    const previous = new Map(belowBefore.map(group => [group.id, group]));
    for (const group of await subGroups(context, groupId)) {
      const old = previous.get(group.id);
      if (old && old.revision !== group.revision) await logRevision(context, 'group', group.id, 'alter', old, group);
    }
  }
  return after;
}

export async function deleteGroup(context: LedgerContext, groupId: string, value: unknown): Promise<void> {
  const input = parseInput(revisionInput, value, groupFields);
  const before = await readGroup(context, groupId, true);
  if (before.revision !== input.revision) throw conflict('group');
  if (before.systemKey) throw ledgerError(409, 'Built-in groups can be renamed but not deleted.', 'seeded_row');
  const { rows } = await context.client.query<{ used: boolean }>(`SELECT ${groupInUseSql} AS used FROM account_group g WHERE g.company_id = $1 AND g.id = $2`, [context.company.companyId, groupId]);
  if (rows[0].used) throw groupInUse['23503'];
  await context.client.query('DELETE FROM account_group WHERE company_id = $1 AND id = $2', [context.company.companyId, groupId]).catch(error => refusal(error, groupInUse));
  await logRevision(context, 'group', groupId, 'delete', before, null);
}

// ---- Ledgers ----

type OpeningBillRow = Omit<OpeningBill, 'amount' | 'creditPeriod'> & { amount: string; creditCount: number | null; creditUnit: CreditUnit | null };
type LedgerRow<T extends object = object> = Omit<Ledger, 'opening' | 'creditPeriod' | 'openingBills'> & {
  openingAmount: bigint; openingSide: Side; creditCount: number | null; creditUnit: CreditUnit | null; creditDueDate: string | null;
  openingBills: OpeningBillRow[];
} & T;
/** The ledger columns; `inUse` adds the delete test for the list and read routes (snapshots and write answers omit it). */
const ledgerSelect = (inUse: boolean) => `WITH RECURSIVE ${groupTreeSql}
  SELECT l.id, l.group_id AS "groupId", g.name AS "groupName", g.nature, l.system_key AS "systemKey", l.name,
    l.second_language_name AS "secondLanguageName", coalesce(t.cash_bank, false) AS "cashOrBank",
    l.opening_amount AS "openingAmount", l.opening_side AS "openingSide", l.revision, l.bill_wise AS "billWise",
    l.credit_count AS "creditCount", l.credit_unit AS "creditUnit", to_char(l.credit_due_date, 'YYYY-MM-DD') AS "creditDueDate",
    l.credit_days_check AS "creditDaysCheck", l.cost_centres AS "costCentres",
    coalesce((SELECT json_agg(json_build_object('kind', a.kind, 'billId', a.bill_id, 'billName', b.name, 'billDate', a.bill_date,
        'dueDate', a.due_date, 'creditCount', a.credit_count, 'creditUnit', a.credit_unit, 'amount', a.amount::text, 'side', a.side) ORDER BY a.id)
      FROM bill_allocation a LEFT JOIN bill b ON b.company_id = a.company_id AND b.id = a.bill_id
      WHERE a.company_id = l.company_id AND a.ledger_id = l.id AND a.voucher_id IS NULL), '[]'::json) AS "openingBills"${inUse ? `, ${ledgerInUseSql} AS "inUse"` : ''}
  FROM ledger l LEFT JOIN account_group g ON g.company_id = l.company_id AND g.id = l.group_id LEFT JOIN tree t ON t.id = l.group_id
  WHERE l.company_id = $1`;
const period = (count: number | null, unit: CreditUnit | null, dueDate: string | null): CreditPeriod | null =>
  count !== null && unit !== null ? { count, unit } : dueDate !== null ? { dueDate } : null;
const toLedger = <T extends object>({ openingAmount, openingSide, creditCount, creditUnit, creditDueDate, openingBills, ...row }: LedgerRow<T>) => ({
  ...row, opening: { amount: openingAmount, side: openingSide }, creditPeriod: period(creditCount, creditUnit, creditDueDate),
  openingBills: openingBills.map(({ amount, creditCount: count, creditUnit: unit, ...bill }): OpeningBill =>
    ({ ...bill, amount: BigInt(amount), creditPeriod: count !== null && unit !== null ? { count, unit } : null })),
});

export async function listLedgers(context: LedgerContext): Promise<LedgerListItem[]> {
  const { rows } = await context.client.query<LedgerRow<{ inUse: boolean }>>(`${ledgerSelect(true)} ORDER BY lower(l.name), l.id`, [context.company.companyId]);
  return rows.map(toLedger);
}

export async function getLedger(context: LedgerContext, ledgerId: string): Promise<LedgerListItem> {
  const { rows } = await context.client.query<LedgerRow<{ inUse: boolean }>>(`${ledgerSelect(true)} AND l.id = $2`, [context.company.companyId, ledgerId]);
  if (!rows[0]) throw notFound('Ledger');
  return toLedger(rows[0]);
}

export async function readLedger(context: LedgerContext, ledgerId: string, lock = false): Promise<Ledger> {
  if (lock) await context.client.query('SELECT 1 FROM ledger WHERE company_id = $1 AND id = $2 FOR UPDATE', [context.company.companyId, ledgerId]);
  const { rows } = await context.client.query<LedgerRow>(`${ledgerSelect(false)} AND l.id = $2`, [context.company.companyId, ledgerId]);
  if (!rows[0]) throw notFound('Ledger');
  return toLedger(rows[0]);
}

/** Opening balances are as of books beginning, so a lock through that date freezes them too (D-09). */
function assertOpeningOpen(context: LedgerContext): void {
  const { lockedThrough, booksBeginning } = context.company;
  if (lockedThrough !== null && lockedThrough >= booksBeginning) throw ledgerError(409, `Opening balances are locked: the books are locked through ${lockedThrough}.`, 'locked_period');
}

function parseOpening(context: LedgerContext, opening: { amount: string; side: Side } | undefined): { amount: bigint; side: Side } {
  if (!opening) return { amount: 0n, side: 'Dr' };
  const amount = parseAmount(opening.amount, context.company.exponent, 'The opening balance');
  if (amount < 0n) throw ledgerError(400, 'Enter the opening balance as a positive amount and choose Dr or Cr.', 'validation');
  return { amount, side: opening.side };
}

async function ledgerGroup(context: LedgerContext, groupId: string | null): Promise<AccountGroup> {
  if (!groupId) throw ledgerError(400, 'Choose the group this ledger belongs to.', 'validation');
  return readGroup(context, groupId).catch(missingAs(ledgerError(400, 'The group was not found.', 'not_found')));
}

export async function createLedger(context: LedgerContext, value: unknown): Promise<Ledger> {
  const input = parseInput(ledgerCreateInput, value, ledgerFields);
  await lockGroupTree(context);
  const group = await ledgerGroup(context, input.groupId);
  const opening = parseOpening(context, input.opening);
  if (opening.amount !== 0n || input.opening?.bills?.length) assertOpeningOpen(context);
  // New ledgers under trade receivables or payables keep bills by default (observed), as in the reference.
  const billWise = input.billWise ?? await inPartyGroups(context, group.id);
  const credit = creditColumns(input.creditPeriod ?? null);
  // New income and expense ledgers take cost centres by default (M2a slice 2), as existing ones were set by migration 0008.
  const costCentres = input.costCentres ?? (group.nature === 'income' || group.nature === 'expense');
  const { rows } = await context.client.query<{ id: string }>(
    `INSERT INTO ledger (company_id, group_id, name, second_language_name, opening_amount, opening_side, bill_wise, credit_count, credit_unit, credit_due_date, credit_days_check, cost_centres)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [context.company.companyId, group.id, input.name, input.secondLanguageName, opening.amount, opening.side, billWise, credit.count, credit.unit, credit.dueDate,
      input.creditDaysCheck ?? false, costCentres]).catch(error => refusal(error, ledgerRefusals));
  if (input.opening?.bills?.length) {
    const plan = await planOpeningBills(context, { id: rows[0].id, billWise, credit: input.creditPeriod ?? null }, opening, input.opening.bills);
    await writeBills(context, null, plan).catch(error => refusal(error, ledgerRefusals));
  }
  const ledger = await readLedger(context, rows[0].id);
  await logRevision(context, 'ledger', ledger.id, 'create', null, ledger);
  return ledger;
}

export async function alterLedger(context: LedgerContext, ledgerId: string, value: unknown): Promise<Ledger> {
  const input = parseInput(ledgerAlterInput, value, ledgerFields);
  await lockGroupTree(context);
  const before = await readLedger(context, ledgerId, true);
  if (before.revision !== input.revision) throw conflict('ledger');
  let groupId: string | null = null;
  if (before.systemKey === 'profit_and_loss') {
    if (input.groupId) throw ledgerError(400, 'The profit and loss ledger stays outside every group.', 'family_rule');
  } else {
    const group = await ledgerGroup(context, input.groupId);
    if (before.systemKey && group.nature !== before.nature) throw ledgerRefusals.ledger_builtin;
    // D-10: a built-in ledger moves only within its behaviour family; the cash ledger stays under the cash and bank groups.
    if (before.systemKey === 'cash' && group.id !== before.groupId) {
      const { rows } = await context.client.query<{ family: boolean }>('SELECT ledger_in_cash_family($1, $2) AS family', [context.company.companyId, group.id]);
      if (!rows[0].family) throw ledgerRefusals.ledger_cash_family;
    }
    groupId = group.id;
  }
  const opening = input.opening ? parseOpening(context, input.opening) : before.opening;
  const openingBills = input.opening?.bills;
  if (opening.amount !== before.opening.amount || (opening.amount !== 0n && opening.side !== before.opening.side)
    || (openingBills !== undefined && (openingBills.length || before.openingBills.length))) assertOpeningOpen(context);
  const billWise = input.billWise ?? before.billWise;
  const creditPeriod = input.creditPeriod === undefined ? before.creditPeriod : input.creditPeriod;
  const credit = creditColumns(creditPeriod);
  // Turning bill-wise off keeps the ledger's bills (observed); new rows on it are dropped from then on. Turning cost
  // centres off likewise keeps the allocation rows posted (vouchers.ts keeps them through an alter).
  await context.client.query(
    `UPDATE ledger SET group_id = $3, name = $4, second_language_name = $5, opening_amount = $6, opening_side = $7, bill_wise = $8,
       credit_count = $9, credit_unit = $10, credit_due_date = $11, credit_days_check = $12, cost_centres = $13, revision = revision + 1
     WHERE company_id = $1 AND id = $2`,
    [context.company.companyId, ledgerId, groupId, input.name, input.secondLanguageName, opening.amount, opening.side, billWise,
      credit.count, credit.unit, credit.dueDate, input.creditDaysCheck ?? before.creditDaysCheck, input.costCentres ?? before.costCentres]).catch(error => refusal(error, ledgerRefusals));
  // Opening rows kept as they are must still fit a changed opening balance.
  if (openingBills === undefined && before.openingBills.length) assertBillRowsFit(before.openingBills, opening.side, opening.amount, context.company.exponent, 'the opening balance');
  if (openingBills !== undefined) {
    // The opening rows are stated whole: the list replaces the rows the ledger had.
    await context.client.query('DELETE FROM bill_allocation WHERE company_id = $1 AND ledger_id = $2 AND voucher_id IS NULL', [context.company.companyId, ledgerId])
      .catch(error => refusal(error, ledgerRefusals));
    const plan = await planOpeningBills(context, { id: ledgerId, billWise, credit: creditPeriod }, opening, openingBills);
    await writeBills(context, null, plan).catch(error => refusal(error, ledgerRefusals));
  }
  const after = await readLedger(context, ledgerId);
  await logRevision(context, 'ledger', ledgerId, 'alter', before, after);
  return after;
}

/** A ledger's credit period as its three columns. */
function creditColumns(credit: CreditPeriod | null): { count: number | null; unit: CreditUnit | null; dueDate: string | null } {
  if (!credit) return { count: null, unit: null, dueDate: null };
  return 'count' in credit ? { count: credit.count, unit: credit.unit, dueDate: null } : { count: null, unit: null, dueDate: credit.dueDate };
}

/** Whether a group is, or sits below, the trade receivables or payables group (by system key, D-10). */
async function inPartyGroups(context: LedgerContext, groupId: string): Promise<boolean> {
  const { rows } = await context.client.query<{ party: boolean }>(
    `WITH RECURSIVE up(id, key, parent) AS (
       SELECT id, system_key, parent_id FROM account_group WHERE company_id = $1 AND id = $2
       UNION ALL SELECT g.id, g.system_key, g.parent_id FROM account_group g JOIN up ON g.company_id = $1 AND g.id = up.parent)
     SELECT coalesce(bool_or(key IN ('receivables', 'payables')), false) AND NOT ledger_in_cash_family($1, $2) AS party FROM up`,
    [context.company.companyId, groupId]);
  return rows[0].party;
}

export async function deleteLedger(context: LedgerContext, ledgerId: string, value: unknown): Promise<void> {
  const input = parseInput(revisionInput, value, ledgerFields);
  const before = await readLedger(context, ledgerId, true);
  if (before.revision !== input.revision) throw conflict('ledger');
  if (before.systemKey) throw ledgerError(409, 'Built-in ledgers can be renamed but not deleted.', 'seeded_row');
  // Soft-deleted and cancelled vouchers still reference the ledger: their history must stay readable.
  const { rows: [use] } = await context.client.query<{ used: boolean }>(`SELECT ${ledgerInUseSql} AS used FROM ledger l WHERE l.company_id = $1 AND l.id = $2`, [context.company.companyId, ledgerId]);
  if (use.used) throw ledgerInUse['23503'];
  // Bills left without rows (their vouchers' lines moved elsewhere) go with the ledger.
  await context.client.query('DELETE FROM bill WHERE company_id = $1 AND ledger_id = $2', [context.company.companyId, ledgerId]).catch(error => refusal(error, ledgerInUse));
  await context.client.query('DELETE FROM ledger WHERE company_id = $1 AND id = $2', [context.company.companyId, ledgerId]).catch(error => refusal(error, ledgerInUse));
  await logRevision(context, 'ledger', ledgerId, 'delete', before, null);
}

// ---- Voucher types ----

const typeColumns = `id, kind, system_key AS "systemKey", name, second_language_name AS "secondLanguageName", numbering_series AS "numberingSeries", revision`;

export async function listVoucherTypes(context: LedgerContext): Promise<VoucherType[]> {
  const { rows } = await context.client.query<VoucherType>(`SELECT ${typeColumns} FROM voucher_type WHERE company_id = $1 ORDER BY lower(name), id`, [context.company.companyId]);
  return rows;
}

export async function readVoucherType(context: LedgerContext, typeId: string, lock = false): Promise<VoucherType> {
  const { rows } = await context.client.query<VoucherType>(`SELECT ${typeColumns} FROM voucher_type WHERE company_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [context.company.companyId, typeId]);
  if (!rows[0]) throw notFound('Voucher type');
  return rows[0];
}

/** M1 voucher types are the eight seeded ones; they can be renamed and given a second-language name. */
export async function alterVoucherType(context: LedgerContext, typeId: string, value: unknown): Promise<VoucherType> {
  const input = parseInput(voucherTypeAlterInput, value, typeFields);
  const before = await readVoucherType(context, typeId, true);
  if (before.revision !== input.revision) throw conflict('voucher type');
  await context.client.query('UPDATE voucher_type SET name = $3, second_language_name = $4, revision = revision + 1 WHERE company_id = $1 AND id = $2',
    [context.company.companyId, typeId, input.name, input.secondLanguageName]).catch(error => refusal(error, typeRefusals));
  const after = await readVoucherType(context, typeId);
  await logRevision(context, 'voucher_type', typeId, 'alter', before, after);
  return after;
}
