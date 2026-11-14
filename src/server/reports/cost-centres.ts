import { addMoney, subtractMoney } from '@ten98/runtime';
import {
  costBreakupQuery, costPeriodQuery,
  type CostBreakupRow, type CostCategorySummary, type CostCentreBreakup, type CostFigures, type CostSummaryCategory,
} from '../../lib/cost-centres.ts';
import { ledgerError, parseInput, type LedgerContext } from '../ledger/context.ts';
import { countsSql, reportBudget } from '../ledger/reports.ts';

/**
 * The two observed cost centre reports (M2a slice 2): the cost category summary and one centre's break-up. Allocation
 * rows count when their voucher does (regular, undeleted; a post-dated voucher from its own date). Reports group rows
 * by each centre's category as it is today, not the category a row was saved with (observed). A centre's figures
 * are its own rows plus those of its sub-centres at any depth, whatever their categories: the summary rolls every
 * centre into its top-most ancestor's row, in that ancestor's category (observed after a parent moved to another
 * category), so every row counts once. Opening (observed default): rows dated before the period on
 * balance-sheet ledgers carry forward; rows on income and expense ledgers show the period movement only. No figure
 * for line amounts left without centres. The summary gets the statements' 30-second budget, one centre 20 seconds.
 */

const queryFields = (path: readonly PropertyKey[]) => ({ from: 'the start date', to: 'the end date', categoryId: 'the cost category' } as Record<string, string>)[String(path[0])] ?? 'the period';
type Centre = { id: string; name: string; categoryId: string; categoryName: string; parentId: string | null };
type Own = { centreId: string; ledgerId: string; ledgerName: string; opening: bigint; debit: bigint; credit: bigint };

const zero = (): CostFigures => ({ opening: 0n, debit: 0n, credit: 0n, closing: 0n });
function add(total: CostFigures, part: { opening: bigint; debit: bigint; credit: bigint }): void {
  total.opening = addMoney(total.opening, part.opening);
  total.debit = addMoney(total.debit, part.debit);
  total.credit = addMoney(total.credit, part.credit);
  total.closing = subtractMoney(addMoney(total.opening, total.debit), total.credit);
}
const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);

async function centres(context: LedgerContext): Promise<Centre[]> {
  const { rows } = await context.client.query<Centre>(
    `SELECT cc.id, cc.name, cc.category_id AS "categoryId", k.name AS "categoryName", cc.parent_id AS "parentId"
     FROM cost_centre cc JOIN cost_category k ON k.company_id = cc.company_id AND k.id = cc.category_id WHERE cc.company_id = $1`,
    [context.company.companyId]);
  return rows;
}

/** Each centre's root: its top-most ancestor (itself when it has no parent). */
function rootsOf(list: Centre[]): Map<string, string> {
  const byId = new Map(list.map(centre => [centre.id, centre]));
  const roots = new Map<string, string>();
  const rootOf = (centre: Centre): string => {
    const known = roots.get(centre.id);
    if (known) return known;
    const parent = centre.parentId ? byId.get(centre.parentId) : undefined;
    const root = parent ? rootOf(parent) : centre.id;
    roots.set(centre.id, root);
    return root;
  };
  for (const centre of list) rootOf(centre);
  return roots;
}

/** Live allocation figures per centre and ledger for the period, optionally for some centres only. */
async function ownFigures(context: LedgerContext, from: string, to: string, centreIds?: string[]): Promise<Own[]> {
  const { rows } = await context.client.query<Own>(
    `SELECT a.cost_centre_id AS "centreId", a.ledger_id AS "ledgerId", min(l.name) AS "ledgerName",
       coalesce(sum(CASE a.side WHEN 'Dr' THEN a.amount ELSE -a.amount END) FILTER (WHERE v.date < $2), 0)::bigint AS opening,
       coalesce(sum(a.amount) FILTER (WHERE a.side = 'Dr' AND v.date >= $2), 0)::bigint AS debit,
       coalesce(sum(a.amount) FILTER (WHERE a.side = 'Cr' AND v.date >= $2), 0)::bigint AS credit
     FROM cost_allocation a
       JOIN voucher v ON v.company_id = a.company_id AND v.id = a.voucher_id
       JOIN ledger l ON l.company_id = a.company_id AND l.id = a.ledger_id
       JOIN account_group g ON g.company_id = l.company_id AND g.id = l.group_id
     WHERE a.company_id = $1 AND ${countsSql} AND v.date <= $3 AND (v.date >= $2 OR g.nature IN ('asset', 'liability'))
       AND ($4::uuid[] IS NULL OR a.cost_centre_id = ANY($4::uuid[]))
     GROUP BY a.cost_centre_id, a.ledger_id`, [context.company.companyId, from, to, centreIds ?? null]);
  return rows;
}

export async function costCategorySummary(context: LedgerContext, value: unknown): Promise<CostCategorySummary> {
  const query = parseInput(costPeriodQuery, value, queryFields);
  await reportBudget(context, 30);
  const { rows: categories } = await context.client.query<{ id: string; name: string }>(
    'SELECT id, name FROM cost_category WHERE company_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY lower(name), id',
    [context.company.companyId, query.categoryId ?? null]);
  if (query.categoryId && !categories.length) throw ledgerError(404, 'Cost category not found.', 'not_found');
  const list = await centres(context);
  const roots = rootsOf(list);
  const figures = new Map(list.filter(centre => roots.get(centre.id) === centre.id).map(centre => [centre.id, zero()]));
  for (const own of await ownFigures(context, query.from, query.to)) add(figures.get(roots.get(own.centreId)!)!, own);
  return {
    from: query.from, to: query.to,
    categories: categories.map((category): CostSummaryCategory => {
      const total = zero();
      const centresOf = list.filter(centre => centre.categoryId === category.id && figures.has(centre.id)).sort(byName).map(centre => {
        const own = figures.get(centre.id)!;
        add(total, own);
        return { costCentreId: centre.id, name: centre.name, ...own };
      });
      return { categoryId: category.id, name: category.name, ...total, centres: centresOf };
    }),
  };
}

/**
 * One centre: its direct sub-centres, whatever their categories (each with its own sub-centres; observed), and the
 * ledgers of its own rows. The total equals the centre's figures in the summary (its row there when it is a root).
 */
export async function costCentreBreakup(context: LedgerContext, centreId: string, value: unknown): Promise<CostCentreBreakup> {
  const query = parseInput(costBreakupQuery, value, queryFields);
  await reportBudget(context, 20);
  const list = await centres(context);
  const centre = list.find(item => item.id === centreId);
  if (!centre) throw ledgerError(404, 'Cost centre not found.', 'not_found');
  const children = list.filter(item => item.parentId === centre.id).sort(byName);
  // Which direct sub-centre each descendant rolls up into.
  const branch = new Map<string, string>();
  const walk = (parentId: string, top: string) => {
    for (const item of list) if (item.parentId === parentId && !branch.has(item.id)) { branch.set(item.id, top); walk(item.id, top); }
  };
  for (const child of children) { branch.set(child.id, child.id); walk(child.id, child.id); }
  const own = await ownFigures(context, query.from, query.to, [centre.id, ...branch.keys()]);
  const childFigures = new Map(children.map(child => [child.id, zero()]));
  const ledgers = new Map<string, CostBreakupRow>();
  const totals = zero();
  for (const row of own) {
    add(totals, row);
    if (row.centreId !== centre.id) { add(childFigures.get(branch.get(row.centreId)!)!, row); continue; }
    const ledger = ledgers.get(row.ledgerId) ?? { kind: 'ledger', id: row.ledgerId, name: row.ledgerName, ...zero() };
    add(ledger, row);
    ledgers.set(row.ledgerId, ledger);
  }
  return {
    from: query.from, to: query.to,
    centre: { id: centre.id, name: centre.name, categoryId: centre.categoryId, categoryName: centre.categoryName },
    rows: [
      ...children.map((child): CostBreakupRow => ({ kind: 'centre', id: child.id, name: child.name, ...childFigures.get(child.id)! })),
      ...[...ledgers.values()].sort(byName),
    ],
    totals,
  };
}
