import { isCalendarDate } from '../../lib/company.ts';
import { FoundationError } from '../auth.ts';

/**
 * Keyset cursors for the paged registers: (date, voucher id), the order vouchers are listed in (ids are time-ordered,
 * so within a day this is entry order). The same shape as the voucher list's cursor, kept here because that one is
 * private to the posting module.
 */
const shape = /^(\d{4}-\d{2}-\d{2})~([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const encodeCursor = (date: string, id: string) => Buffer.from(`${date}~${id}`).toString('base64url');

export function decodeCursor(cursor: string | undefined): [date: string | null, id: string | null] {
  if (cursor === undefined) return [null, null];
  const match = shape.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match || !isCalendarDate(match[1])) throw new FoundationError(400, 'Check the page cursor and try again.');
  return [match[1], match[2]];
}

/** Exports read a whole period at once, up to this many lines; a longer one asks for a shorter period. */
export const exportLimit = 100_000;
export const exportTooLarge = new FoundationError(400, `An export holds at most ${exportLimit.toLocaleString('en-US')} lines. Choose a shorter period.`);
