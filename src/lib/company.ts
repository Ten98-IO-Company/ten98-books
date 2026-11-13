import { z } from 'zod';
import { canonicalAccountTimeZone } from './account-preferences.ts';

/**
 * Base currencies a company can keep its books in, with their ISO 4217 minor units. The exponent is fixed per
 * currency (D-04): changing a company's minor units needs a migration, so the list grows only by review.
 */
export const baseCurrencies = {
  AED: { name: 'UAE dirham', minorUnits: 2 },
  BHD: { name: 'Bahraini dinar', minorUnits: 3 },
  KWD: { name: 'Kuwaiti dinar', minorUnits: 3 },
  OMR: { name: 'Omani rial', minorUnits: 3 },
  QAR: { name: 'Qatari riyal', minorUnits: 2 },
  SAR: { name: 'Saudi riyal', minorUnits: 2 },
  USD: { name: 'US dollar', minorUnits: 2 },
  EUR: { name: 'Euro', minorUnits: 2 },
  GBP: { name: 'Pound sterling', minorUnits: 2 },
  INR: { name: 'Indian rupee', minorUnits: 2 },
} as const;
export type BaseCurrency = keyof typeof baseCurrencies;
const currencyCodes = Object.keys(baseCurrencies) as [BaseCurrency, ...BaseCurrency[]];

/** A real calendar date written YYYY-MM-DD, between 1900 and 2199. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && year <= 2199 && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Days in a month of a common year: a financial year never starts on 29 February. */
export const daysInMonth = (month: number) => new Date(Date.UTC(2001, month, 0)).getUTCDate();

const clean = (value: string) => !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value);

/** The create-company boundary: shared by the form (field messages) and the server (authoritative check). */
export const companyCreateInput = z.object({
  name: z.string().trim().min(1, 'Enter the company name.').max(120).refine(clean),
  baseCurrency: z.enum(currencyCodes, { message: 'Choose a supported base currency.' }),
  financialYearStart: z.object({
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  }).strict().refine(start => start.day <= daysInMonth(start.month), { message: 'Choose a day that exists in that month.' }),
  booksBeginning: z.string().refine(isCalendarDate, { message: 'Enter a real date as YYYY-MM-DD.' }),
  timeZone: z.string().max(80).transform((value, context) => {
    const zone = canonicalAccountTimeZone(value);
    if (zone !== null) return zone;
    context.addIssue({ code: 'custom', message: 'Choose a recognised named time zone.' });
    return z.NEVER;
  }),
  secondLanguageName: z.string().trim().max(120).refine(clean).optional().transform(value => value || null),
}).strict();
export type CompanyCreateInput = z.input<typeof companyCreateInput>;

/** The company as the API returns it. Dates are calendar dates in the company's own time zone (D-09). */
export type Company = {
  id: string;
  workspaceId: string;
  name: string;
  secondLanguageName: string | null;
  baseCurrency: BaseCurrency;
  currencyMinorUnits: number;
  financialYearStart: { month: number; day: number };
  booksBeginning: string;
  timeZone: string;
  lockedThrough: string | null;
};

/** The financial year containing `date` (YYYY-MM-DD), as inclusive first and last calendar dates. */
export function financialYearOf(start: { month: number; day: number }, date: string): { from: string; to: string } {
  const [year, month, day] = date.split('-').map(Number);
  const startYear = month > start.month || (month === start.month && day >= start.day) ? year : year - 1;
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  const from = new Date(Date.UTC(startYear, start.month - 1, start.day));
  const to = new Date(Date.UTC(startYear + 1, start.month - 1, start.day - 1));
  return { from: iso(from), to: iso(to) };
}
