import { z } from 'zod';
import { moneyText } from './money.ts';

/**
 * Stock masters (M2b slice a): wire schemas (zod at the API boundary) and the shapes the server returns. Quantities and
 * rates are decimal strings on the wire and `numeric` in the database, never floats; values are `bigint` minor units on
 * the server and decimal strings on the wire (D-04, D-07). Names are unique within each kind under the name match key.
 */

const id = z.uuid().transform(value => value.toLowerCase());
const nullableId = id.nullish().transform(value => value ?? null);
const clean = (value: string) => !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value);
const name = z.string().trim().min(1).max(120).refine(clean);
const secondLanguageName = z.string().trim().max(120).refine(clean).nullish().transform(value => value || null);
const revision = z.number().int().positive();

/** The most places a unit's quantities may carry (observed). */
export const maxUnitDecimals = 4;
/** A quantity as entered: digits with at most four places; the unit's own decimals are checked on the server. */
export const quantityText = z.string().max(40).regex(/^\d{1,16}(\.\d{1,4})?$/, 'Enter a quantity such as 12.5.');
/** A rate as entered: digits with at most six places; an entered rate carries at most the currency's places. */
export const rateText = z.string().max(40).regex(/^\d{1,14}(\.\d{1,6})?$/, 'Enter a rate such as 4.20.');

export const stockUnitCreateInput = z.object({
  symbol: z.string().trim().min(1).max(40).refine(clean),
  formalName: secondLanguageName,
  decimals: z.number().int().min(0).max(maxUnitDecimals).optional(),
}).strict();
export const stockUnitAlterInput = stockUnitCreateInput.extend({ revision }).strict();

/** Groups, categories and locations are trees: each may sit under another of its own kind. */
const treeShape = { name, secondLanguageName, parentId: nullableId };
export const stockGroupCreateInput = z.object({ ...treeShape, addQuantities: z.boolean().optional() }).strict();
export const stockGroupAlterInput = stockGroupCreateInput.extend({ revision }).strict();
export const stockCategoryCreateInput = z.object(treeShape).strict();
export const stockCategoryAlterInput = stockCategoryCreateInput.extend({ revision }).strict();
export const stockLocationCreateInput = z.object(treeShape).strict();
export const stockLocationAlterInput = stockLocationCreateInput.extend({ revision }).strict();

/**
 * One opening row: a location, a quantity, and either a rate (the value is quantity × rate, rounded half-up to the
 * currency) or a value (the stored truth; the rate is derived to six places).
 */
export const stockOpeningInput = z.object({ locationId: id, quantity: quantityText, rate: rateText.optional(), value: moneyText.optional() }).strict()
  .refine(row => (row.rate === undefined) !== (row.value === undefined), { message: 'Give either the rate or the value of each opening row.', path: ['rate'] });
/** An item. `openings` states the item's opening rows whole; left out on an alter, the rows stay as they are. */
export const stockItemCreateInput = z.object({
  name, secondLanguageName, groupId: nullableId, categoryId: nullableId, unitId: id,
  standardSellingRate: rateText.nullish().transform(value => value ?? null),
  openings: z.array(stockOpeningInput).max(500).optional(),
}).strict();
export const stockItemAlterInput = stockItemCreateInput.extend({ revision }).strict();
export const inventorySettingInput = z.object({ enabled: z.boolean() }).strict();

export type StockUnit = { id: string; symbol: string; formalName: string | null; decimals: number; revision: number };
export type StockGroup = { id: string; parentId: string | null; name: string; secondLanguageName: string | null; addQuantities: boolean; revision: number };
export type StockCategory = { id: string; parentId: string | null; name: string; secondLanguageName: string | null; revision: number };
export type StockLocation = { id: string; systemKey: string | null; parentId: string | null; name: string; secondLanguageName: string | null; revision: number };
/** An opening row as stored: the quantity in its unit's places, the rate as entered or derived, the value. */
export type StockOpening = { locationId: string; locationName: string; quantity: string; rate: string; value: bigint };
export type StockItem = {
  id: string; name: string; secondLanguageName: string | null; groupId: string | null; groupName: string | null;
  categoryId: string | null; categoryName: string | null; unitId: string; unitSymbol: string; standardSellingRate: string | null;
  openings: StockOpening[]; openingValue: bigint; revision: number;
};
/** As the list and read routes answer them: plus whether a delete would be refused for use. */
export type StockUnitListItem = StockUnit & { inUse: boolean };
export type StockGroupListItem = StockGroup & { inUse: boolean };
export type StockCategoryListItem = StockCategory & { inUse: boolean };
export type StockLocationListItem = StockLocation & { inUse: boolean };
export type InventorySetting = { enabled: boolean };
