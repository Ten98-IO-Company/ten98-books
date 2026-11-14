import {
  groupAlterInput, groupCreateInput, ledgerAlterInput, ledgerCreateInput, revisionInput, voucherTypeAlterInput,
  type AccountGroup, type Ledger, type Nature, type Side, type VoucherType,
} from '../../lib/ledger.ts';
import { FoundationError } from '../auth.ts';
import { conflict, parseAmount, parseInput, refusal, type LedgerContext } from './context.ts';
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

const notFound = (what: string) => new FoundationError(404, `${what} not found.`);
/** Rethrows a not-found refusal as `replacement` (a reference inside the request, not the addressed resource). */
export const missingAs = (replacement: FoundationError) => (error: unknown): never => {
  throw error instanceof FoundationError && error.status === 404 ? replacement : error;
};
const field = (labels: Record<string, string>, fallback: string) => (path: readonly PropertyKey[]) => labels[String(path[0])] ?? fallback;
const groupFields = field({ name: 'the group name', secondLanguageName: 'the second-language name', parentId: 'the parent group', nature: 'the nature', grossProfit: 'the gross profit setting', revision: 'the revision' }, 'the group details');
const ledgerFields = field({ name: 'the ledger name', secondLanguageName: 'the second-language name', groupId: 'the group', opening: 'the opening balance', revision: 'the revision' }, 'the ledger details');
const typeFields = field({ name: 'the voucher type name', secondLanguageName: 'the second-language name', revision: 'the revision' }, 'the voucher type details');

const groupRefusals = {
  account_group_name_idx: new FoundationError(409, 'A group with this name already exists.'),
  account_group_cycle: new FoundationError(400, 'A group cannot be placed under one of its own sub-groups.'),
  account_group_builtin: new FoundationError(400, 'A built-in group keeps its nature. Choose a parent group of the same nature.'),
};
const groupInUse = { ...groupRefusals, '23503': new FoundationError(409, 'This group still holds sub-groups or ledgers. Move or delete them first.') };
const ledgerRefusals = {
  ledger_name_idx: new FoundationError(409, 'A ledger with this name already exists.'),
  ledger_builtin: new FoundationError(400, 'A built-in ledger keeps its nature. Choose a group of the same nature.'),
};
const ledgerInUse = { ...ledgerRefusals, '23503': new FoundationError(409, 'This ledger is used in vouchers and cannot be deleted.') };
const typeRefusals = { voucher_type_name_idx: new FoundationError(409, 'A voucher type with this name already exists.') };

// ---- Groups ----

const groupColumns = `id, parent_id AS "parentId", nature, gross_profit AS "grossProfit", system_key AS "systemKey", name,
  second_language_name AS "secondLanguageName", revision`;

export async function listGroups(context: LedgerContext): Promise<AccountGroup[]> {
  const { rows } = await context.client.query<AccountGroup>(`SELECT ${groupColumns} FROM account_group WHERE company_id = $1 ORDER BY lower(name), id`, [context.company.companyId]);
  return rows;
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
    const parent = await readGroup(context, input.parentId).catch(missingAs(new FoundationError(400, 'The parent group was not found.')));
    if (input.nature && input.nature !== parent.nature) throw new FoundationError(400, 'A sub-group takes the nature of its parent group.');
    return { parentId: parent.id, nature: parent.nature, grossProfit: parent.grossProfit };
  }
  const nature = input.nature ?? current?.nature;
  if (!nature) throw new FoundationError(400, 'Choose the nature of a primary group: asset, liability, income or expense.');
  const grossProfit = input.grossProfit ?? (current?.nature === nature ? current.grossProfit : false);
  if (grossProfit && nature !== 'income' && nature !== 'expense') throw new FoundationError(400, 'Only income and expense groups can count towards gross profit.');
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

export async function alterGroup(context: LedgerContext, groupId: string, value: unknown): Promise<AccountGroup> {
  const input = parseInput(groupAlterInput, value, groupFields);
  const before = await readGroup(context, groupId, true);
  if (before.revision !== input.revision) throw conflict('group');
  const place = await placeGroup(context, input, before);
  if (before.systemKey && place.nature !== before.nature) throw groupRefusals.account_group_builtin;
  await context.client.query(
    `UPDATE account_group SET parent_id = $3, nature = $4, gross_profit = $5, name = $6, second_language_name = $7, revision = revision + 1
     WHERE company_id = $1 AND id = $2`,
    [context.company.companyId, groupId, place.parentId, place.nature, place.grossProfit, input.name, input.secondLanguageName]).catch(error => refusal(error, groupRefusals));
  const after = await readGroup(context, groupId);
  await logRevision(context, 'group', groupId, 'alter', before, after);
  return after;
}

export async function deleteGroup(context: LedgerContext, groupId: string, value: unknown): Promise<void> {
  const input = parseInput(revisionInput, value, groupFields);
  const before = await readGroup(context, groupId, true);
  if (before.revision !== input.revision) throw conflict('group');
  if (before.systemKey) throw new FoundationError(409, 'Built-in groups can be renamed but not deleted.');
  const { rows } = await context.client.query<{ used: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM account_group WHERE company_id = $1 AND parent_id = $2) OR EXISTS (SELECT 1 FROM ledger WHERE company_id = $1 AND group_id = $2) AS used`,
    [context.company.companyId, groupId]);
  if (rows[0].used) throw groupInUse['23503'];
  await context.client.query('DELETE FROM account_group WHERE company_id = $1 AND id = $2', [context.company.companyId, groupId]).catch(error => refusal(error, groupInUse));
  await logRevision(context, 'group', groupId, 'delete', before, null);
}

// ---- Ledgers ----

type LedgerRow = Omit<Ledger, 'opening'> & { openingAmount: bigint; openingSide: Side };
const ledgerSelect = `WITH RECURSIVE ${groupTreeSql}
  SELECT l.id, l.group_id AS "groupId", g.name AS "groupName", g.nature, l.system_key AS "systemKey", l.name,
    l.second_language_name AS "secondLanguageName", coalesce(t.cash_bank, false) AS "cashOrBank",
    l.opening_amount AS "openingAmount", l.opening_side AS "openingSide", l.revision
  FROM ledger l LEFT JOIN account_group g ON g.company_id = l.company_id AND g.id = l.group_id LEFT JOIN tree t ON t.id = l.group_id
  WHERE l.company_id = $1`;
const toLedger = ({ openingAmount, openingSide, ...row }: LedgerRow): Ledger => ({ ...row, opening: { amount: openingAmount, side: openingSide } });

export async function listLedgers(context: LedgerContext): Promise<Ledger[]> {
  const { rows } = await context.client.query<LedgerRow>(`${ledgerSelect} ORDER BY lower(l.name), l.id`, [context.company.companyId]);
  return rows.map(toLedger);
}

export async function readLedger(context: LedgerContext, ledgerId: string, lock = false): Promise<Ledger> {
  if (lock) await context.client.query('SELECT 1 FROM ledger WHERE company_id = $1 AND id = $2 FOR UPDATE', [context.company.companyId, ledgerId]);
  const { rows } = await context.client.query<LedgerRow>(`${ledgerSelect} AND l.id = $2`, [context.company.companyId, ledgerId]);
  if (!rows[0]) throw notFound('Ledger');
  return toLedger(rows[0]);
}

/** Opening balances are as of books beginning, so a lock through that date freezes them too (D-09). */
function assertOpeningOpen(context: LedgerContext): void {
  const { lockedThrough, booksBeginning } = context.company;
  if (lockedThrough !== null && lockedThrough >= booksBeginning) throw new FoundationError(409, `Opening balances are locked: the books are locked through ${lockedThrough}.`);
}

function parseOpening(context: LedgerContext, opening: { amount: string; side: Side } | undefined): { amount: bigint; side: Side } {
  if (!opening) return { amount: 0n, side: 'Dr' };
  const amount = parseAmount(opening.amount, context.company.exponent, 'The opening balance');
  if (amount < 0n) throw new FoundationError(400, 'Enter the opening balance as a positive amount and choose Dr or Cr.');
  return { amount, side: opening.side };
}

async function ledgerGroup(context: LedgerContext, groupId: string | null): Promise<AccountGroup> {
  if (!groupId) throw new FoundationError(400, 'Choose the group this ledger belongs to.');
  return readGroup(context, groupId).catch(missingAs(new FoundationError(400, 'The group was not found.')));
}

export async function createLedger(context: LedgerContext, value: unknown): Promise<Ledger> {
  const input = parseInput(ledgerCreateInput, value, ledgerFields);
  const group = await ledgerGroup(context, input.groupId);
  const opening = parseOpening(context, input.opening);
  if (opening.amount !== 0n) assertOpeningOpen(context);
  const { rows } = await context.client.query<{ id: string }>(
    `INSERT INTO ledger (company_id, group_id, name, second_language_name, opening_amount, opening_side) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [context.company.companyId, group.id, input.name, input.secondLanguageName, opening.amount, opening.side]).catch(error => refusal(error, ledgerRefusals));
  const ledger = await readLedger(context, rows[0].id);
  await logRevision(context, 'ledger', ledger.id, 'create', null, ledger);
  return ledger;
}

export async function alterLedger(context: LedgerContext, ledgerId: string, value: unknown): Promise<Ledger> {
  const input = parseInput(ledgerAlterInput, value, ledgerFields);
  const before = await readLedger(context, ledgerId, true);
  if (before.revision !== input.revision) throw conflict('ledger');
  let groupId: string | null = null;
  if (before.systemKey === 'profit_and_loss') {
    if (input.groupId) throw new FoundationError(400, 'The profit and loss ledger stays outside every group.');
  } else {
    const group = await ledgerGroup(context, input.groupId);
    if (before.systemKey && group.nature !== before.nature) throw ledgerRefusals.ledger_builtin;
    groupId = group.id;
  }
  const opening = input.opening ? parseOpening(context, input.opening) : before.opening;
  if (opening.amount !== before.opening.amount || (opening.amount !== 0n && opening.side !== before.opening.side)) assertOpeningOpen(context);
  await context.client.query(
    `UPDATE ledger SET group_id = $3, name = $4, second_language_name = $5, opening_amount = $6, opening_side = $7, revision = revision + 1
     WHERE company_id = $1 AND id = $2`,
    [context.company.companyId, ledgerId, groupId, input.name, input.secondLanguageName, opening.amount, opening.side]).catch(error => refusal(error, ledgerRefusals));
  const after = await readLedger(context, ledgerId);
  await logRevision(context, 'ledger', ledgerId, 'alter', before, after);
  return after;
}

export async function deleteLedger(context: LedgerContext, ledgerId: string, value: unknown): Promise<void> {
  const input = parseInput(revisionInput, value, ledgerFields);
  const before = await readLedger(context, ledgerId, true);
  if (before.revision !== input.revision) throw conflict('ledger');
  if (before.systemKey) throw new FoundationError(409, 'Built-in ledgers can be renamed but not deleted.');
  // Soft-deleted and cancelled vouchers still reference the ledger: their history must stay readable.
  const used = await context.client.query('SELECT 1 FROM voucher_line WHERE company_id = $1 AND ledger_id = $2 LIMIT 1', [context.company.companyId, ledgerId]);
  if (used.rowCount) throw ledgerInUse['23503'];
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
