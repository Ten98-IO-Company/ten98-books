import { normalizeDecimal } from '@ten98/ui';
import { formatMoney, MONEY_MAX, multiplyMoney, parseMoney, type MoneyExponent } from '@ten98/runtime/browser';
import { financialYearOf, isCalendarDate } from '../company.ts';
import { formatAmount, formatBalance, longDate } from '../reports.ts';

/** Amounts and dates as the voucher screen takes them (docs/VOUCHERS.md, "Amounts, dates and numbers"). */

export type ParseResult = { value: string } | { error: string };

const amountExample = 'Enter an amount such as 1,250.50.';
const tooLarge = 'This amount is too large.';
/** The most whole digits an amount can have in any currency before it leaves the stored range. */
const wholeDigits = String(MONEY_MAX).length;

/**
 * Typed amount text as the company stores it: Arabic-Indic digits and grouping are accepted (the grid's
 * `normalizeDecimal`), then the value is rounded half up to the currency's places (observed: entry rounds). Empty text,
 * and a value that rounds to zero, is an empty cell, so no line exists. A sign or a value beyond the stored range is an
 * error. It never throws, whatever the length of the text.
 */
export function parseEntryAmount(text: string, exponent: MoneyExponent): ParseResult {
  if (text.trim() === '') return { value: '' };
  let normal: ReturnType<typeof normalizeDecimal>;
  try { normal = normalizeDecimal(text, Infinity, false); } catch { return { error: amountExample }; }
  if ('error' in normal) return { error: amountExample };
  const [whole, fraction = ''] = normal.value.split('.');
  if (whole.replace(/^0+/, '').length > wholeDigits) return { error: tooLarge };
  // Half up depends only on the first digit cut off: keep the currency's places and one more.
  const kept = fraction.slice(0, exponent + 1);
  let rounded: bigint;
  try { rounded = multiplyMoney(10n ** BigInt(exponent), kept ? `${whole}.${kept}` : whole, 'half-up'); } catch { return { error: tooLarge }; }
  if (rounded > MONEY_MAX) return { error: tooLarge };
  return { value: rounded === 0n ? '' : formatMoney(rounded, exponent) };
}

/** Minor units of a stored cell value; an empty cell is zero. */
export const minorOf = (value: string, exponent: MoneyExponent): bigint => value === '' ? 0n : parseMoney(value, exponent);
/** Minor units for reading, `1,250.50`, through the reports' formatter. */
export const amountText = (amount: bigint, exponent: MoneyExponent): string => formatAmount(formatMoney(amount, exponent), exponent);
/** A signed balance (positive on the debit side) for reading, `4,950.00 Dr`, through the reports' formatter. */
export const balanceText = (balance: bigint, exponent: MoneyExponent): string => formatBalance(formatMoney(balance, exponent), exponent);

const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (value: number) => String(value).padStart(2, '0');
/** Arabic-Indic and Persian digit runs as ASCII, through the grid's own digit map. */
const asciiDigits = (text: string) => text.replace(/[٠-٩۰-۹]+/g, run => { const normal = normalizeDecimal(run, 0, false); return 'value' in normal ? normal.value.padStart(run.length, '0') : run; });

export const dateExample = 'Enter a date such as 9, 10-8, 12 sep or 15-10-2026.';
// Only the observed forms: the day, then optionally a month (number or name) and a year, one separator throughout.
const dayFirst = /^(\d{1,2})(?:([-/. ])(\d{1,2}|[a-z]{3,9})(?:\2(\d{2}|\d{4}))?)?$/;

/**
 * Typed date text as a calendar date (observed forms): the day first, then an optional month (a number or a month
 * name of at least three letters) and an optional year (two digits are 20yy); missing parts come from `current`, the
 * voucher's date. One separator, `-`, `/`, `.` or a space, used throughout. Refused: digits without separators
 * (`130526`), a month before the day (`sep 16`), a day the month does not have (`35`, `31-2`) and forms not observed
 * (`-9`, `9--7`, `9-7-`). Ours also takes `2026-01-31`, the form a date copied from elsewhere in the application takes.
 */
export function parseEntryDate(text: string, current: string): ParseResult {
  const typed = asciiDigits(text).trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^\d{4}-\d{2}-\d{2}$/.test(typed)) return isCalendarDate(typed) ? { value: typed } : { error: dateExample };
  const parts = dayFirst.exec(typed);
  if (!parts) return { error: dateExample };
  const [currentYear, currentMonth] = current.split('-').map(Number);
  const [, day, , monthText, yearText] = parts;
  let month = currentMonth;
  if (monthText !== undefined) {
    if (/^\d+$/.test(monthText)) month = Number(monthText);
    else {
      const index = monthNames.findIndex(name => name.startsWith(monthText));
      if (index < 0) return { error: dateExample };
      month = index + 1;
    }
  }
  const year = yearText === undefined ? currentYear : yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
  const value = `${year}-${pad(month)}-${pad(Number(day))}`;
  return isCalendarDate(value) ? { value } : { error: dateExample };
}

/** The date with its weekday, as the header shows it: `Thursday, 1 January 2026`. */
export const entryDateLabel = (date: string): string => `${weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()]}, ${longDate(date)}`;

const nextDay = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export type DateRules = { booksBeginning: string; lockedThrough: string | null; financialYearStart: { month: number; day: number } };

/**
 * Why a voucher date cannot be taken, or undefined. Both ends are inclusive. The lower bounds are the posting rules'
 * (the books beginning and the locked period); the upper bound is the end of the financial year that holds the tab's
 * working date (observed: the reference refuses a date past its current period; ours derives that period from the
 * working date).
 */
export function entryDateProblem(date: string, rules: DateRules, workingDate: string): string | undefined {
  if (date < rules.booksBeginning) return `Date cannot be before the books begin, ${longDate(rules.booksBeginning)}.`;
  if (rules.lockedThrough !== null && date <= rules.lockedThrough) return `Date is in the locked period, which ends ${longDate(rules.lockedThrough)}; the first open date is ${longDate(nextDay(rules.lockedThrough))}.`;
  const end = financialYearOf(rules.financialYearStart, workingDate).to;
  if (date > end) return `Date cannot be after the end of the current financial year, ${longDate(end)}.`;
  return undefined;
}
