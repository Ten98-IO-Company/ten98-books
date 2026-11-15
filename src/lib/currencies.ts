import { z } from 'zod';
import { calendarDate, currencyCode } from './ledger.ts';
import { nameMatchKey } from './names.ts';

/**
 * Currencies and dated rates (M2a currencies, slice a): wire schemas (zod at the API boundary) and the shapes the server
 * returns. A rate is the number of base units per foreign unit, a decimal string of at most ten digits before the point
 * and four after it, more than zero. The rate in force on a date is the latest row of its kind on or before that date.
 */

const clean = (value: string) => !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value);
/** A symbol needs a character the name match key keeps: one of ignored characters only ("...") would block every such symbol. */
const symbol = z.string().trim().min(1).max(20).refine(clean).refine(value => nameMatchKey(value) !== '', { message: 'A symbol needs a letter, a digit or a sign, not only spaces and punctuation.' });
const formalName = z.string().trim().min(1).max(120).refine(clean);
const isoCode = z.string().regex(/^[A-Z]{3}$/, { message: 'An ISO code is three capital letters.' });
const decimalWord = z.string().trim().max(40).refine(clean).nullable().transform(value => value || null);
const revision = z.number().int().positive();

/** Decimal places a currency may have: the runtime money module supports 0, 2 and 3 (1 and 4 are a declared gap). */
export const currencyDecimals = [0, 2, 3] as const;
export type CurrencyDecimals = (typeof currencyDecimals)[number];
const decimals = z.union(currencyDecimals.map(value => z.literal(value)) as [z.ZodLiteral<0>, z.ZodLiteral<2>, z.ZodLiteral<3>], {
  message: 'A currency has 0, 2 or 3 decimal places.',
});

/** Creating a currency: an omitted presentation field takes its default (no, no, no, none, 2). */
export const currencyCreateInput = z.object({
  code: currencyCode, symbol, formalName, isoCode: isoCode.nullish().transform(value => value ?? null), decimals,
  inMillions: z.boolean().optional(), symbolAfter: z.boolean().optional(), spaceBetween: z.boolean().optional(),
  decimalWord: decimalWord.optional(), wordsDecimals: z.number().int().min(0).max(4).optional(),
}).strict();
/** Altering a currency (not its code): an omitted optional field keeps its value; null clears the ISO code or the decimal word. */
export const currencyAlterInput = z.object({
  symbol, formalName, isoCode: isoCode.nullable().optional(), decimals,
  inMillions: z.boolean().optional(), symbolAfter: z.boolean().optional(), spaceBetween: z.boolean().optional(),
  decimalWord: decimalWord.optional(), wordsDecimals: z.number().int().min(0).max(4).optional(), revision,
}).strict();

export const rateKinds = ['standard', 'selling', 'buying'] as const;
export type RateKind = (typeof rateKinds)[number];
/** A rate as typed: digits, at most ten before the point and four after it, and more than zero. */
export const rateText = z.string()
  .regex(/^\d{1,10}(\.\d{1,4})?$/, { message: 'Enter a rate with at most 10 digits before the point and 4 after it.' })
  .refine(value => /[1-9]/.test(value), { message: 'A rate is more than zero.' });
const rateChange = rateText.nullable().optional();

/**
 * One date's rates for some currencies: a value writes that date's row of the kind, null removes it, an omitted kind is
 * left alone.
 */
export const exchangeRatesInput = z.object({
  date: calendarDate,
  rates: z.array(z.object({ currency: currencyCode, standard: rateChange, selling: rateChange, buying: rateChange }).strict()).min(1).max(200)
    .refine(rows => new Set(rows.map(row => row.currency)).size === rows.length, { message: 'Name each currency once.' }),
}).strict();
export type ExchangeRatesInput = z.input<typeof exchangeRatesInput>;
export const ratesQuery = z.object({ date: calendarDate }).strict();

export type Currency = {
  code: string; systemKey: string | null; symbol: string; formalName: string; isoCode: string | null; decimals: CurrencyDecimals;
  inMillions: boolean; symbolAfter: boolean; spaceBetween: boolean; decimalWord: string | null; wordsDecimals: number; revision: number;
};
/**
 * As the list and read routes answer them: plus whether it is the base currency and whether a ledger names it (a delete
 * or a decimals change is then refused). A delete is also refused while a rate row lies in the locked period.
 */
export type CurrencyListItem = Currency & { isBase: boolean; inUse: boolean };

/** The rate of a kind in force on a date, with the date of its row; null before the first row of that kind. */
export type RateInForce = { rate: string; effectiveDate: string; onDate: boolean } | null;
export type CurrencyRates = { currency: string; standard: RateInForce; selling: RateInForce; buying: RateInForce };
/** Every foreign currency's rates in force on `date`; `onDate` says the row is dated that very day. */
export type RatesOn = { date: string; currencies: CurrencyRates[] };
/** Warnings of a rates write: the date is on or before the last voucher date, so reports from it on move with the rates. */
export const rateWarningCodes = ['rates_move_reports'] as const;
export type RateWarningCode = (typeof rateWarningCodes)[number];
export type RatesSaved = RatesOn & { warnings: RateWarningCode[] };
/** One stored rate row of a currency. */
export type ExchangeRateRow = { kind: RateKind; effectiveDate: string; rate: string };
