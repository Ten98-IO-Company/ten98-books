import { addMoney, formatMoney, subtractMoney } from '@ten98/runtime';
import {
  costCategoryAlterInput, costCategoryCreateInput, costCentreAlterInput, costCentreCreateInput, costCentresSettingInput,
  type CostCategory, type CostCategoryListItem, type CostCentre, type CostCentreListItem, type CostDefault,
} from '../../lib/cost-centres.ts';
import { revisionInput, type BillWarning, type CostAllocationInput, type CostAllocationRow, type Side } from '../../lib/ledger.ts';
import { conflict, ledgerError, parseAmount, parseInput, refusal, type LedgerContext } from './context.ts';
import { missingAs } from './masters.ts';
import { logRevision } from './revisions.ts';

/**
 * Cost categories and cost centres (M2a slice 2). A centre belongs to one category and may sit under another centre;
 * names are unique across the company's centres, and across its categories. A voucher line of a ledger that takes
 * cost centres may split its base amount over centres, per category: each allocation row stores the category it was
 * saved with, so moving a centre to another category later leaves posted vouchers as they were while the reports
 * regroup it (observed). Deletes of used rows are refused by the database's foreign keys.
 */

const notFound = (what: string) => ledgerError(404, `${what} not found.`, 'not_found');
const field = (labels: Record<string, string>, fallback: string) => (path: readonly PropertyKey[]) => labels[String(path[0])] ?? fallback;
const categoryFields = field({ name: 'the category name', secondLanguageName: 'the second-language name', allocateRevenue: 'the revenue setting', allocateNonRevenue: 'the non-revenue setting', revision: 'the revision' }, 'the category details');
const centreFields = field({ name: 'the cost centre name', secondLanguageName: 'the second-language name', categoryId: 'the category', parentId: 'the parent cost centre', revision: 'the revision' }, 'the cost centre details');

const categoryRefusals = {
  cost_category_name_idx: ledgerError(409, 'A cost category with this name already exists.', 'duplicate_name'),
  cost_category_builtin: ledgerError(409, 'The general cost category can be renamed but not deleted.', 'seeded_row'),
};
const categoryInUse = { ...categoryRefusals, '23503': ledgerError(409, 'This cost category holds cost centres or is used in vouchers and cannot be deleted.', 'in_use') };
const centreRefusals = {
  cost_centre_name_idx: ledgerError(409, 'A cost centre with this name already exists (names are shared by all categories).', 'duplicate_name'),
  cost_centre_cycle: ledgerError(400, 'A cost centre cannot be placed under one of its own sub-centres.', 'cycle'),
};
const centreInUse = { ...centreRefusals, '23503': ledgerError(409, 'This cost centre holds sub-centres or is used in vouchers and cannot be deleted.', 'in_use') };

// ---- Categories ----

const categoryColumns = `c.id, c.system_key AS "systemKey", c.name, c.second_language_name AS "secondLanguageName",
  c.allocate_revenue AS "allocateRevenue", c.allocate_non_revenue AS "allocateNonRevenue", c.revision`;
/** What refuses a category delete (P7): centres in it, or allocation rows saved with it. */
const categoryInUseSql = `(EXISTS (SELECT 1 FROM cost_centre x WHERE x.company_id = c.company_id AND x.category_id = c.id)
  OR EXISTS (SELECT 1 FROM cost_allocation x WHERE x.company_id = c.company_id AND x.category_id = c.id))`;

export async function listCostCategories(context: LedgerContext): Promise<CostCategoryListItem[]> {
  const { rows } = await context.client.query<CostCategoryListItem>(
    `SELECT ${categoryColumns}, ${categoryInUseSql} AS "inUse" FROM cost_category c WHERE c.company_id = $1 ORDER BY lower(c.name), c.id`, [context.company.companyId]);
  return rows;
}

export async function getCostCategory(context: LedgerContext, categoryId: string): Promise<CostCategoryListItem> {
  const { rows } = await context.client.query<CostCategoryListItem>(
    `SELECT ${categoryColumns}, ${categoryInUseSql} AS "inUse" FROM cost_category c WHERE c.company_id = $1 AND c.id = $2`, [context.company.companyId, categoryId]);
  if (!rows[0]) throw notFound('Cost category');
  return rows[0];
}

async function readCostCategory(context: LedgerContext, categoryId: string, lock = false): Promise<CostCategory> {
  const { rows } = await context.client.query<CostCategory>(
    `SELECT ${categoryColumns} FROM cost_category c WHERE c.company_id = $1 AND c.id = $2${lock ? ' FOR UPDATE' : ''}`, [context.company.companyId, categoryId]);
  if (!rows[0]) throw notFound('Cost category');
  return rows[0];
}

/** A new category allocates revenue items and not others unless told (stored only: postings do not check them, P2). */
export async function createCostCategory(context: LedgerContext, value: unknown): Promise<CostCategory> {
  const input = parseInput(costCategoryCreateInput, value, categoryFields);
  const { rows } = await context.client.query<{ id: string }>(
    `INSERT INTO cost_category (company_id, name, second_language_name, allocate_revenue, allocate_non_revenue) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [context.company.companyId, input.name, input.secondLanguageName, input.allocateRevenue ?? true, input.allocateNonRevenue ?? false])
    .catch(error => refusal(error, categoryRefusals));
  const category = await readCostCategory(context, rows[0].id);
  await logRevision(context, 'cost_category', category.id, 'create', null, category);
  return category;
}

export async function alterCostCategory(context: LedgerContext, categoryId: string, value: unknown): Promise<CostCategory> {
  const input = parseInput(costCategoryAlterInput, value, categoryFields);
  const before = await readCostCategory(context, categoryId, true);
  if (before.revision !== input.revision) throw conflict('cost category');
  await context.client.query(
    `UPDATE cost_category SET name = $3, second_language_name = $4, allocate_revenue = $5, allocate_non_revenue = $6, revision = revision + 1
     WHERE company_id = $1 AND id = $2`,
    [context.company.companyId, categoryId, input.name, input.secondLanguageName, input.allocateRevenue ?? before.allocateRevenue, input.allocateNonRevenue ?? before.allocateNonRevenue])
    .catch(error => refusal(error, categoryRefusals));
  const after = await readCostCategory(context, categoryId);
  await logRevision(context, 'cost_category', categoryId, 'alter', before, after);
  return after;
}

export async function deleteCostCategory(context: LedgerContext, categoryId: string, value: unknown): Promise<void> {
  const input = parseInput(revisionInput, value, categoryFields);
  const before = await readCostCategory(context, categoryId, true);
  if (before.revision !== input.revision) throw conflict('cost category');
  if (before.systemKey) throw categoryRefusals.cost_category_builtin;
  await context.client.query('DELETE FROM cost_category WHERE company_id = $1 AND id = $2', [context.company.companyId, categoryId]).catch(error => refusal(error, categoryInUse));
  await logRevision(context, 'cost_category', categoryId, 'delete', before, null);
}

// ---- Centres ----

const centreColumns = `cc.id, cc.category_id AS "categoryId", k.name AS "categoryName", cc.parent_id AS "parentId", cc.name,
  cc.second_language_name AS "secondLanguageName", cc.revision`;
const centreFrom = 'cost_centre cc JOIN cost_category k ON k.company_id = cc.company_id AND k.id = cc.category_id';
/** What refuses a centre delete (P7): sub-centres under it, or allocation rows on it. */
const centreInUseSql = `(EXISTS (SELECT 1 FROM cost_centre x WHERE x.company_id = cc.company_id AND x.parent_id = cc.id)
  OR EXISTS (SELECT 1 FROM cost_allocation x WHERE x.company_id = cc.company_id AND x.cost_centre_id = cc.id))`;

export async function listCostCentres(context: LedgerContext): Promise<CostCentreListItem[]> {
  const { rows } = await context.client.query<CostCentreListItem>(
    `SELECT ${centreColumns}, ${centreInUseSql} AS "inUse" FROM ${centreFrom} WHERE cc.company_id = $1 ORDER BY lower(cc.name), cc.id`, [context.company.companyId]);
  return rows;
}

export async function getCostCentre(context: LedgerContext, centreId: string): Promise<CostCentreListItem> {
  const { rows } = await context.client.query<CostCentreListItem>(
    `SELECT ${centreColumns}, ${centreInUseSql} AS "inUse" FROM ${centreFrom} WHERE cc.company_id = $1 AND cc.id = $2`, [context.company.companyId, centreId]);
  if (!rows[0]) throw notFound('Cost centre');
  return rows[0];
}

export async function readCostCentre(context: LedgerContext, centreId: string, lock = false): Promise<CostCentre> {
  if (lock) await context.client.query('SELECT 1 FROM cost_centre WHERE company_id = $1 AND id = $2 FOR UPDATE', [context.company.companyId, centreId]);
  const { rows } = await context.client.query<CostCentre>(`SELECT ${centreColumns} FROM ${centreFrom} WHERE cc.company_id = $1 AND cc.id = $2`, [context.company.companyId, centreId]);
  if (!rows[0]) throw notFound('Cost centre');
  return rows[0];
}

/**
 * One move in the company's centre tree at a time (the database trigger takes the same lock). Taken first, before any
 * row lock, so concurrent moves queue instead of deadlocking.
 */
const lockCentreTree = (context: LedgerContext) => context.client.query('SELECT cost_centre_tree_lock($1)', [context.company.companyId]);

/**
 * A centre placed under a parent (created there, or moved) must be in the parent's category. A centre that changes
 * category and keeps its parent may end up in another category than the parent (observed); the reports still count it
 * in its top-level ancestor's row, in that ancestor's category (observed).
 */
async function assertPlacement(context: LedgerContext, categoryId: string, parentId: string | null): Promise<void> {
  await readCostCategory(context, categoryId).catch(missingAs(ledgerError(400, 'The cost category was not found.', 'not_found')));
  if (!parentId) return;
  const parent = await readCostCentre(context, parentId).catch(missingAs(ledgerError(400, 'The parent cost centre was not found.', 'not_found')));
  if (parent.categoryId !== categoryId) throw ledgerError(400, 'A cost centre placed under another goes in the category of that cost centre.', 'validation');
}

export async function createCostCentre(context: LedgerContext, value: unknown): Promise<CostCentre> {
  const input = parseInput(costCentreCreateInput, value, centreFields);
  if (input.parentId) await lockCentreTree(context);
  await assertPlacement(context, input.categoryId, input.parentId);
  const { rows } = await context.client.query<{ id: string }>(
    'INSERT INTO cost_centre (company_id, category_id, parent_id, name, second_language_name) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [context.company.companyId, input.categoryId, input.parentId, input.name, input.secondLanguageName]).catch(error => refusal(error, centreRefusals));
  const centre = await readCostCentre(context, rows[0].id);
  await logRevision(context, 'cost_centre', centre.id, 'create', null, centre);
  return centre;
}

/**
 * Renames, re-categorises or moves a centre. Allocation rows already posted keep the category they were saved with;
 * sub-centres keep theirs. The centre's row lock waits for postings in flight that key-share it.
 */
export async function alterCostCentre(context: LedgerContext, centreId: string, value: unknown): Promise<CostCentre> {
  const input = parseInput(costCentreAlterInput, value, centreFields);
  await lockCentreTree(context);
  const before = await readCostCentre(context, centreId, true);
  if (before.revision !== input.revision) throw conflict('cost centre');
  if (input.parentId !== before.parentId) await assertPlacement(context, input.categoryId, input.parentId);
  else if (input.categoryId !== before.categoryId) await readCostCategory(context, input.categoryId).catch(missingAs(ledgerError(400, 'The cost category was not found.', 'not_found')));
  await context.client.query(
    'UPDATE cost_centre SET category_id = $3, parent_id = $4, name = $5, second_language_name = $6, revision = revision + 1 WHERE company_id = $1 AND id = $2',
    [context.company.companyId, centreId, input.categoryId, input.parentId, input.name, input.secondLanguageName]).catch(error => refusal(error, centreRefusals));
  const after = await readCostCentre(context, centreId);
  await logRevision(context, 'cost_centre', centreId, 'alter', before, after);
  return after;
}

export async function deleteCostCentre(context: LedgerContext, centreId: string, value: unknown): Promise<void> {
  const input = parseInput(revisionInput, value, centreFields);
  const before = await readCostCentre(context, centreId, true);
  if (before.revision !== input.revision) throw conflict('cost centre');
  await context.client.query('DELETE FROM cost_centre WHERE company_id = $1 AND id = $2', [context.company.companyId, centreId]).catch(error => refusal(error, centreInUse));
  await logRevision(context, 'cost_centre', centreId, 'delete', before, null);
}

// ---- The company setting and the entry prefill ----

export type CostCentresSetting = { enabled: boolean };

export const readCostCentresSetting = async (context: LedgerContext): Promise<CostCentresSetting> => ({ enabled: context.company.costCentresEnabled });

/**
 * Switches the company's cost centres on or off (owners and admins; an editor is told the company is not there, as a
 * viewer is for any write). Switching off keeps every allocation row and every report figure; new rows are dropped.
 */
export async function saveCostCentresSetting(context: LedgerContext, value: unknown): Promise<CostCentresSetting> {
  if (context.role !== 'owner' && context.role !== 'admin') throw ledgerError(404, 'Company not found or unavailable.', 'not_found');
  const input = parseInput(costCentresSettingInput, value, () => 'the cost centres setting');
  await context.client.query('UPDATE company SET cost_centres_enabled = $2 WHERE company_id = $1', [context.company.companyId, input.enabled]);
  context.company.costCentresEnabled = input.enabled;
  return input;
}

/**
 * The category and centre of the ledger's most recently entered live allocation row (rows of regular, undeleted
 * vouchers; ids are time-ordered, and an alter enters its rows again), with the centre's category as it is now, so the
 * prefill is a pair a new line accepts. Null when the ledger has none. "Most recently entered" rather than "latest
 * dated" is decided, awaiting observation.
 */
export async function costDefault(context: LedgerContext, ledgerId: string): Promise<CostDefault> {
  const ledger = await context.client.query('SELECT 1 FROM ledger WHERE company_id = $1 AND id = $2', [context.company.companyId, ledgerId]);
  if (!ledger.rowCount) throw notFound('Ledger');
  const { rows } = await context.client.query<NonNullable<CostDefault>>(
    `SELECT cc.category_id AS "categoryId", k.name AS "categoryName", cc.id AS "costCentreId", cc.name AS "costCentreName"
     FROM cost_allocation a
       JOIN voucher v ON v.company_id = a.company_id AND v.id = a.voucher_id AND v.status = 'regular' AND v.deleted_at IS NULL
       JOIN ${centreFrom} ON cc.company_id = a.company_id AND cc.id = a.cost_centre_id
     WHERE a.company_id = $1 AND a.ledger_id = $2 ORDER BY a.id DESC LIMIT 1`, [context.company.companyId, ledgerId]);
  return rows[0] ?? null;
}

// ---- Posting ----

/** A voucher line as the cost rules need it: whether its ledger takes cost centres and the rows the request sent. */
export type CostLine = { lineNo: number; ledgerId: string; side: Side; amount: bigint; costCentres: boolean; costAllocations?: CostAllocationInput[] };
/** An allocation row as stored (in entry order), for keeping it through an alter and matching stored categories. */
export type StoredCostRow = { lineNo: number; ledgerId: string; categoryId: string; costCentreId: string; side: Side; amount: bigint };
export type CostRow = StoredCostRow;
export type CostPlan = { rows: CostRow[]; warnings: BillWarning[] };

const warning = (code: BillWarning['code'], line: number | null, amount: bigint | null = null): BillWarning =>
  ({ code, line, billId: null, billName: null, amount });
const towards = (row: { side: Side; amount: bigint }, side: Side) => row.side === side ? row.amount : subtractMoney(0n, row.amount);

export async function storedCostRows(context: LedgerContext, voucherId: string): Promise<StoredCostRow[]> {
  const { rows } = await context.client.query<StoredCostRow>(
    `SELECT line_no AS "lineNo", ledger_id AS "ledgerId", category_id AS "categoryId", cost_centre_id AS "costCentreId", side, amount
     FROM cost_allocation WHERE company_id = $1 AND voucher_id = $2 ORDER BY line_no, id`, [context.company.companyId, voucherId]);
  return rows;
}

/**
 * Applies the cost rules to a voucher's lines. A line takes rows when the company keeps cost centres and its ledger
 * takes them; otherwise sent rows are dropped (`cost_ignored`), except on an alter of a line that already had rows (the
 * same line number and ledger, else the first unclaimed stored line of its ledger): rows sent are then accepted
 * (`cost_kept`); with the list left out the earlier rows are kept,
 * the last row of each category taking the difference to a changed line amount (`cost_rebalanced`; its side turns when
 * the difference passes it, and a row reaching zero is dropped); an empty list drops them (`cost_dropped`). Observed:
 * the reference keeps such rows in its reports and drops them silently when the voucher is saved again; keeping them
 * unless told is a declared difference. The company feature switched off is treated alike (awaiting observation).
 *
 * Refusals: an unknown centre; a category other than the centre's own unless the voucher already stores that pair; one
 * centre twice in one category on a line; a category whose rows do not net, towards the line, to the line amount.
 * Categories are optional per line, and a line may carry none. Centres are key-shared in id order after the ledgers.
 */
export async function planCost(context: LedgerContext, lines: CostLine[], stored: StoredCostRow[] = []): Promise<CostPlan> {
  const { exponent, costCentresEnabled } = context.company;
  const rows: CostRow[] = [];
  const warnings: BillWarning[] = [];
  const accepted: { line: CostLine; sent: CostAllocationInput[] }[] = [];
  const takes = (line: CostLine) => costCentresEnabled && line.costCentres;

  // Which stored line each line inherits its earlier rows from: the same line number and ledger first; then a line
  // left without a match takes the first unclaimed stored line of its ledger (lines inserted or removed above it).
  const storedLines = [...new Set(stored.map(row => row.lineNo))];
  const ledgerOf = new Map(stored.map(row => [row.lineNo, row.ledgerId]));
  const claimed = new Set<number>(), source = new Map<CostLine, number>();
  for (const line of lines) if (ledgerOf.get(line.lineNo) === line.ledgerId) { source.set(line, line.lineNo); claimed.add(line.lineNo); }
  for (const line of lines) {
    if (source.has(line) || takes(line)) continue;
    const original = storedLines.find(lineNo => !claimed.has(lineNo) && ledgerOf.get(lineNo) === line.ledgerId);
    if (original !== undefined) { source.set(line, original); claimed.add(original); }
  }

  for (const line of lines) {
    const sent = line.costAllocations ?? [];
    if (takes(line)) { if (sent.length) accepted.push({ line, sent }); continue; }
    const original = source.get(line);
    const earlier = original === undefined ? [] : stored.filter(row => row.lineNo === original);
    if (!earlier.length) { if (sent.length) warnings.push(warning('cost_ignored', line.lineNo)); continue; }
    if (sent.length) { accepted.push({ line, sent }); warnings.push(warning('cost_kept', line.lineNo)); continue; }
    // Declared difference: the reference drops such rows without a word when the voucher is saved again. Here rows
    // are dropped only when the body says so with an empty list.
    if (line.costAllocations) { warnings.push(warning('cost_dropped', line.lineNo)); continue; }
    rows.push(...rebalance(line, earlier, warnings));
  }
  // Stored rows no line carried (their line was removed, or its ledger changed): on a ledger that takes cost centres the
  // body states the rows whole, as for any line; otherwise they are dropped, and the answer says so.
  const unclaimed = storedLines.filter(lineNo => !claimed.has(lineNo));
  if (unclaimed.length) {
    const taking = new Set(lines.filter(takes).map(line => line.ledgerId));
    const elsewhere = [...new Set(unclaimed.map(lineNo => ledgerOf.get(lineNo)!))].filter(id => !lines.some(line => line.ledgerId === id));
    if (costCentresEnabled && elsewhere.length) {
      const { rows: flags } = await context.client.query<{ id: string }>('SELECT id FROM ledger WHERE company_id = $1 AND id = ANY($2::uuid[]) AND cost_centres',
        [context.company.companyId, elsewhere]);
      for (const flag of flags) taking.add(flag.id);
    }
    for (const lineNo of unclaimed) if (!taking.has(ledgerOf.get(lineNo)!)) warnings.push(warning('cost_dropped', null));
  }

  const centreIds = [...new Set([...accepted.flatMap(({ sent }) => sent.map(row => row.costCentreId)), ...rows.map(row => row.costCentreId)])].sort();
  if (!centreIds.length) return { rows, warnings };
  const { rows: centres } = await context.client.query<{ id: string; categoryId: string }>(
    'SELECT id, category_id AS "categoryId" FROM cost_centre WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR KEY SHARE',
    [context.company.companyId, centreIds]);
  const current = new Map(centres.map(centre => [centre.id, centre.categoryId]));
  const storedPairs = new Set(stored.map(row => `${row.costCentreId}:${row.categoryId}`));
  for (const { line, sent } of accepted) {
    const seen = new Set<string>();
    const totals = new Map<string, bigint>();
    sent.forEach((input, index) => {
      const where = `cost row ${index + 1} on line ${line.lineNo}`;
      const amount = parseAmount(input.amount, exponent, `The amount of ${where}`);
      if (amount <= 0n) throw ledgerError(400, `The amount of ${where} must be more than zero.`, 'validation');
      const centreCategory = current.get(input.costCentreId);
      if (!centreCategory) throw ledgerError(400, `The cost centre of ${where} was not found in this company.`, 'not_found');
      const categoryId = input.categoryId ?? centreCategory;
      // A centre moved since the voucher was saved is re-sent with the category its row stored, whatever line it is on now.
      if (categoryId !== centreCategory && !storedPairs.has(`${input.costCentreId}:${categoryId}`)) {
        throw ledgerError(400, `The cost centre of ${where} is not in the category sent, and this voucher never stored it there.`, 'validation');
      }
      const key = `${categoryId}:${input.costCentreId}`;
      if (seen.has(key)) throw ledgerError(400, `The cost centre of ${where} is already on this line in the same category.`, 'validation');
      seen.add(key);
      const row: CostRow = { lineNo: line.lineNo, ledgerId: line.ledgerId, categoryId, costCentreId: input.costCentreId, side: input.side ?? line.side, amount };
      totals.set(categoryId, addMoney(totals.get(categoryId) ?? 0n, towards(row, line.side)));
      rows.push(row);
    });
    for (const total of totals.values()) {
      if (total !== line.amount) {
        throw ledgerError(400, `The cost rows of one category on line ${line.lineNo} add up to ${formatMoney(total, exponent)}, not the line's ${formatMoney(line.amount, exponent)}.`, 'allocation_total');
      }
    }
  }
  rows.sort((a, b) => a.lineNo - b.lineNo);
  return { rows, warnings };
}

/** The earlier rows of a line kept through an alter, each category's last row taking the difference to the new amount. */
function rebalance(line: CostLine, earlier: StoredCostRow[], warnings: BillWarning[]): CostRow[] {
  const kept: (CostRow | null)[] = earlier.map(row => ({ ...row, lineNo: line.lineNo }));
  let moved = false;
  for (const categoryId of new Set(earlier.map(row => row.categoryId))) {
    const indexes = kept.flatMap((row, index) => row?.categoryId === categoryId ? [index] : []);
    const net = indexes.reduce((sum, index) => addMoney(sum, towards(kept[index]!, line.side)), 0n);
    const difference = subtractMoney(line.amount, net);
    if (difference === 0n) continue;
    moved = true;
    const last = indexes[indexes.length - 1];
    const value = addMoney(towards(kept[last]!, line.side), difference);
    kept[last] = value === 0n ? null : { ...kept[last]!, side: value > 0n ? line.side : line.side === 'Dr' ? 'Cr' : 'Dr', amount: value > 0n ? value : subtractMoney(0n, value) };
  }
  warnings.push(warning(moved ? 'cost_rebalanced' : 'cost_kept', line.lineNo));
  return kept.filter((row): row is CostRow => row !== null);
}

/** Writes the planned rows after the voucher's lines; the database checks each line's rows at commit. */
export async function writeCost(context: LedgerContext, voucherId: string, rows: CostRow[]): Promise<void> {
  if (!rows.length) return;
  await context.client.query(
    `INSERT INTO cost_allocation (company_id, voucher_id, line_no, ledger_id, category_id, cost_centre_id, side, amount)
     SELECT $1, $2, t.line_no, t.ledger_id, t.category_id, t.cost_centre_id, t.side, t.amount
     FROM unnest($3::smallint[], $4::uuid[], $5::uuid[], $6::uuid[], $7::text[], $8::bigint[]) WITH ORDINALITY AS t(line_no, ledger_id, category_id, cost_centre_id, side, amount, ord)
     ORDER BY t.ord`,
    [context.company.companyId, voucherId, rows.map(row => row.lineNo), rows.map(row => row.ledgerId), rows.map(row => row.categoryId),
      rows.map(row => row.costCentreId), rows.map(row => row.side), rows.map(row => row.amount)]);
}

/** A voucher's allocation rows by line, with the category each was saved with. */
export async function costRowsByLine(context: LedgerContext, voucherId: string): Promise<Map<number, CostAllocationRow[]>> {
  const { rows } = await context.client.query<CostAllocationRow & { lineNo: number }>(
    `SELECT a.line_no AS "lineNo", a.cost_centre_id AS "costCentreId", cc.name AS "costCentreName", a.category_id AS "categoryId",
       k.name AS "categoryName", a.side, a.amount
     FROM cost_allocation a JOIN cost_centre cc ON cc.company_id = a.company_id AND cc.id = a.cost_centre_id
       JOIN cost_category k ON k.company_id = a.company_id AND k.id = a.category_id
     WHERE a.company_id = $1 AND a.voucher_id = $2 ORDER BY a.line_no, a.id`, [context.company.companyId, voucherId]);
  const byLine = new Map<number, CostAllocationRow[]>();
  for (const { lineNo, ...row } of rows) byLine.set(lineNo, [...byLine.get(lineNo) ?? [], row]);
  return byLine;
}
