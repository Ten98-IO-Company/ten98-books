import { isCalendarDate } from './company.ts';

/**
 * The tab's working date (docs/VOUCHERS.md, "Working date"): the date a new voucher opens on. It is kept per tab, in
 * session storage under `workingDate:<companyId>`, and starts as the last voucher date (the books beginning while there
 * is none). It follows the company menu's date key, the day book's day, a voucher's date key and every saved voucher's
 * date, as observed. Storage that is blocked or empty falls back to the starting date; nothing here ever throws.
 */

/** The storage calls this module makes. A getter, because reading `window.sessionStorage` itself can throw. */
export type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;
export type StoreSource = () => KeyStore | null | undefined;

export const workingDateKey = (companyId: string): string => `workingDate:${companyId}`;

/** The date a tab starts from: the last voucher date, else the books beginning. */
export const startingWorkingDate = (defaults: { lastVoucherDate: string | null; booksBeginning: string }): string =>
  defaults.lastVoucherDate ?? defaults.booksBeginning;

/** Reads a stored value, or null when the store is blocked, empty or holds something else. */
export function readStored(source: StoreSource, key: string): string | null {
  try { return source()?.getItem(key) ?? null; } catch { return null; }
}

/** Writes a value; a blocked or full store is ignored (the screen then keeps the value for this page only). */
export function writeStored(source: StoreSource, key: string, value: string): void {
  try { source()?.setItem(key, value); } catch { /* blocked storage: nothing to keep */ }
}

/** The tab's working date for the company, or null when none is kept (or the kept text is not a date). */
export function readWorkingDate(source: StoreSource, companyId: string): string | null {
  const stored = readStored(source, workingDateKey(companyId));
  return stored !== null && isCalendarDate(stored) ? stored : null;
}

export function writeWorkingDate(source: StoreSource, companyId: string, date: string): void {
  if (isCalendarDate(date)) writeStored(source, workingDateKey(companyId), date);
}

/** The tab's session storage, or null where the browser blocks it. */
export const sessionStore: StoreSource = () => (typeof window === 'undefined' ? null : window.sessionStorage);
/** The browser's local storage, or null where it is blocked. */
export const localStore: StoreSource = () => (typeof window === 'undefined' ? null : window.localStorage);
