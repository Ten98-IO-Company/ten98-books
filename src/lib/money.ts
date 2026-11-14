import { z } from 'zod';
import { formatMoney, type MoneyExponent } from '@ten98/runtime/browser';

/**
 * D-07 wire form of an amount: a plain decimal string (an optional minus, digits, an optional fraction), never a number.
 * The shape is checked here; the value is parsed with the company's currency exponent by `parseMoney` on the server,
 * which refuses extra fraction digits and amounts outside the `bigint` range, so nothing is silently rounded.
 */
export const moneyText = z.string().max(40).regex(/^-?\d{1,20}(\.\d{1,20})?$/, 'Enter an amount such as 1250.50.');

/** A response shape with every `bigint` (money in minor units) replaced by its decimal string. */
export type Wire<T> = T extends bigint ? string
  : T extends readonly (infer U)[] ? Wire<U>[]
  : T extends object ? { [K in keyof T]: Wire<T[K]> }
  : T;

/**
 * Formats every `bigint` in `value` as money for the currency `exponent`. In ledger responses every `bigint` is an amount
 * (counts, numbers and revisions are plain numbers), so this is the one place amounts become wire strings.
 */
export function moneyToWire<T>(value: T, exponent: MoneyExponent): Wire<T> {
  const convert = (item: unknown): unknown => {
    if (typeof item === 'bigint') return formatMoney(item, exponent);
    if (Array.isArray(item)) return item.map(convert);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, convert(entry)]));
    return item;
  };
  return convert(value) as Wire<T>;
}

/**
 * Amount text typed by a person, as the plain decimal string the wire takes. Thousands separators are accepted only as
 * a comma between exact groups of three digits (`1,250.5`, never `12,50` or `1,25`) and removed; anything else that is
 * not digits with an optional decimal point is refused (null). The exponent is not checked here: `parseMoney` refuses
 * extra decimal places, so nothing is ever rounded.
 */
export function normalizeAmountInput(text: string): string | null {
  const value = text.trim();
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(value)) return value.replaceAll(',', '');
  return /^\d+(\.\d+)?$/.test(value) ? value : null;
}
