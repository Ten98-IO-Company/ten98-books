import { z } from 'zod';
import { calendarDate } from './ledger.ts';

/**
 * Cost categories and cost centres (M2a slice 2): wire schemas (zod at the API boundary) and the shapes the server
 * returns. Amounts are `bigint` minor units on the server and decimal strings on the wire; a signed amount is positive on
 * the debit side. Reports group allocations by each centre's category as it is today; vouchers keep the category each
 * row was saved with.
 */

const id = z.uuid().transform(value => value.toLowerCase());
const clean = (value: string) => !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value);
const name = z.string().trim().min(1).max(120).refine(clean);
const secondLanguageName = z.string().trim().max(120).refine(clean).nullish().transform(value => value || null);
const revision = z.number().int().positive();

export const costCategoryCreateInput = z.object({
  name, secondLanguageName, allocateRevenue: z.boolean().optional(), allocateNonRevenue: z.boolean().optional(),
}).strict();
export const costCategoryAlterInput = costCategoryCreateInput.extend({ revision }).strict();
/** A centre: its category and, optionally, the centre it sits under (placed there in that centre's category). */
export const costCentreCreateInput = z.object({
  name, secondLanguageName, categoryId: id, parentId: id.nullish().transform(value => value ?? null),
}).strict();
export const costCentreAlterInput = costCentreCreateInput.extend({ revision }).strict();
export const costCentresSettingInput = z.object({ enabled: z.boolean() }).strict();

export type CostCategory = {
  id: string; systemKey: string | null; name: string; secondLanguageName: string | null;
  allocateRevenue: boolean; allocateNonRevenue: boolean; revision: number;
};
export type CostCentre = {
  id: string; categoryId: string; categoryName: string; parentId: string | null; name: string; secondLanguageName: string | null; revision: number;
};
/** As the list and read routes answer them: plus whether a delete would be refused for use. */
export type CostCategoryListItem = CostCategory & { inUse: boolean };
export type CostCentreListItem = CostCentre & { inUse: boolean };
/** The category and centre last used on a ledger (its most recently entered live row), for the entry pop-up's prefill. */
export type CostDefault = { categoryId: string; categoryName: string; costCentreId: string; costCentreName: string } | null;

export const costPeriodQuery = z.object({ from: calendarDate, to: calendarDate, categoryId: id.optional() }).strict()
  .refine(period => period.from <= period.to, { message: 'The period must end on or after its start.', path: ['to'] });
export const costBreakupQuery = z.object({ from: calendarDate, to: calendarDate }).strict()
  .refine(period => period.from <= period.to, { message: 'The period must end on or after its start.', path: ['to'] });

/** Opening, period debit and credit, and closing (signed: debit positive). */
export type CostFigures = { opening: bigint; debit: bigint; credit: bigint; closing: bigint };
export type CostSummaryCentre = CostFigures & { costCentreId: string; name: string };
export type CostSummaryCategory = CostFigures & { categoryId: string; name: string; centres: CostSummaryCentre[] };
/**
 * The cost category summary: per category (as each centre stands today), its top-level centres (no parent) that have
 * figures for the period (observed: centres and categories without figures have no row), with every
 * sub-centre folded in, whatever the sub-centres' own categories (observed); the category's figures are the sum of its
 * centres' (a total of our own: the reference's cost reports show none).
 */
export type CostCategorySummary = { from: string; to: string; categories: CostSummaryCategory[] };
export type CostBreakupRow = CostFigures & { kind: 'centre' | 'ledger'; id: string; name: string };
/** One centre: its direct sub-centres, whatever their categories (each with its own sub-centres), and the ledgers of its own rows. */
export type CostCentreBreakup = {
  from: string; to: string; centre: { id: string; name: string; categoryId: string; categoryName: string };
  rows: CostBreakupRow[]; totals: CostFigures;
};
