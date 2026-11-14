/**
 * Reading the bill keys a dataset keeps under `extras`, so the seeder can post them and the validation can check them.
 * The datasets are written by two generators that spell the same things slightly differently, and the files are not
 * renamed here (the reference side writes them), so both spellings are read:
 *
 * - a voucher line's `extras.bills` rows: `kind` or `type` (new, against, advance, on_account), `name` or `ref`,
 *   `amount` and an optional `creditDays` (a new reference or an advance only);
 * - a ledger's `extras.billWise` (true or false), its default credit period `creditDays` or `creditPeriodDays` (days),
 *   and its opening bills, `extras.opening.bills` or `extras.openingBills`: `name` or `ref`, `billDate` or `date`,
 *   `amount`, optional `creditDays` and `side`, and `kind` when present must be `new`.
 *
 * Nothing here knows the ledger module; the amounts stay decimal strings. Every reader returns what it found plus
 * plain-language problems, so a malformed key is named instead of being posted wrongly or skipped silently.
 */
import { isCalendarDate } from '../../lib/company.ts';

export type BillMethod = 'new_ref' | 'advance' | 'against_ref' | 'on_account';
export type DatasetBillRow = { method: BillMethod; name?: string; creditDays?: number; amount: string };
export type DatasetOpeningBill = { name: string; billDate?: string; creditDays?: number; amount: string; side?: 'Dr' | 'Cr' };
export type DatasetLedgerBills = { billWise?: boolean; creditDays?: number; openingBills: DatasetOpeningBill[] };

/** The dataset's spelling of a bill row's kind, and the method the ledger module calls it. */
const methods: Record<string, BillMethod> = { new: 'new_ref', against: 'against_ref', advance: 'advance', on_account: 'on_account' };
const plainAmount = /^\d+(?:\.\d+)?$/;

type Found<T> = { found: T; problems: string[] };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const firstOf = (record: Record<string, unknown>, ...keys: string[]) => keys.map(key => record[key]).find(value => value !== undefined);

function creditDaysOf(record: Record<string, unknown>, at: string, problems: string[], ...keys: string[]): number | undefined {
  const value = firstOf(record, ...keys);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3650) { problems.push(`${at}${keys[0]} must be a whole number of days from 0 to 3650`); return undefined; }
  return value;
}

/** A voucher line's bill rows (`extras.bills`). */
export function readLineBills(extras: unknown): Found<DatasetBillRow[]> {
  const problems: string[] = [];
  const found: DatasetBillRow[] = [];
  const value = isRecord(extras) ? extras.bills : undefined;
  if (value === undefined) return { found, problems };
  if (!Array.isArray(value)) return { found, problems: ['extras.bills must be a list of bill rows'] };
  value.forEach((raw, index) => {
    const at = `extras.bills[${index}]: `;
    if (!isRecord(raw)) { problems.push(`${at}must be an object`); return; }
    const kind = firstOf(raw, 'kind', 'type');
    const method = typeof kind === 'string' ? methods[kind] : undefined;
    if (!method) { problems.push(`${at}kind (or type) must be one of ${Object.keys(methods).join(', ')}`); return; }
    const name = firstOf(raw, 'name', 'ref');
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) { problems.push(`${at}name (or ref) must be a non-empty string`); return; }
    if (method === 'on_account' && name !== undefined) { problems.push(`${at}an on_account row names no bill`); return; }
    if (method === 'against_ref' && name === undefined) { problems.push(`${at}an against row must name the bill it settles`); return; }
    if (typeof raw.amount !== 'string' || !plainAmount.test(raw.amount)) { problems.push(`${at}amount must be a plain decimal string`); return; }
    const before = problems.length;
    const creditDays = creditDaysOf(raw, at, problems, 'creditDays');
    if (problems.length > before) return;
    if (creditDays !== undefined && method !== 'new_ref' && method !== 'advance') { problems.push(`${at}creditDays applies to a new reference or an advance only`); return; }
    found.push({ method, ...name !== undefined ? { name: (name as string).trim() } : {}, ...creditDays !== undefined ? { creditDays } : {}, amount: raw.amount });
  });
  return { found, problems };
}

/** A ledger's bill settings: bill-wise flag, default credit days and opening bills. */
export function readLedgerBills(extras: unknown): Found<DatasetLedgerBills> {
  const problems: string[] = [];
  const found: DatasetLedgerBills = { openingBills: [] };
  if (!isRecord(extras)) return { found, problems };
  if (extras.billWise !== undefined) {
    if (typeof extras.billWise === 'boolean') found.billWise = extras.billWise; else problems.push('extras.billWise must be true or false');
  }
  const days = creditDaysOf(extras, 'extras.', problems, 'creditDays', 'creditPeriodDays');
  if (days !== undefined) found.creditDays = days;
  const list = isRecord(extras.opening) && extras.opening.bills !== undefined ? extras.opening.bills : extras.openingBills;
  if (list === undefined) return { found, problems };
  if (!Array.isArray(list)) return { found, problems: [...problems, 'the opening bills must be a list'] };
  list.forEach((raw, index) => {
    const at = `opening bill ${index + 1}: `;
    if (!isRecord(raw)) { problems.push(`${at}must be an object`); return; }
    if (raw.kind !== undefined && raw.kind !== 'new') { problems.push(`${at}an opening bill is a new reference (kind "new")`); return; }
    const name = firstOf(raw, 'name', 'ref');
    if (typeof name !== 'string' || !name.trim()) { problems.push(`${at}name (or ref) is required`); return; }
    const billDate = firstOf(raw, 'billDate', 'date');
    if (billDate !== undefined && (typeof billDate !== 'string' || !isCalendarDate(billDate))) { problems.push(`${at}billDate (or date) must be a real date written YYYY-MM-DD`); return; }
    if (typeof raw.amount !== 'string' || !plainAmount.test(raw.amount)) { problems.push(`${at}amount must be a plain decimal string`); return; }
    if (raw.side !== undefined && raw.side !== 'Dr' && raw.side !== 'Cr') { problems.push(`${at}side must be Dr or Cr`); return; }
    const before = problems.length;
    const creditDays = creditDaysOf(raw, at, problems, 'creditDays');
    if (problems.length > before) return;
    found.openingBills.push({ name: name.trim(), ...billDate !== undefined ? { billDate: billDate as string } : {}, ...creditDays !== undefined ? { creditDays } : {},
      amount: raw.amount, ...raw.side !== undefined ? { side: raw.side } : {} });
  });
  return { found, problems };
}

const monthNumbers: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

/** A due date as expected.json writes it ("21-Oct-26", two-digit year in this century) as YYYY-MM-DD; undefined when it is not a real day. */
export function parseDueDate(text: string): string | undefined {
  const parts = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(text);
  const month = parts ? monthNumbers[parts[2][0].toUpperCase() + parts[2].slice(1).toLowerCase()] : undefined;
  if (!parts || !month) return undefined;
  const iso = `20${parts[3]}-${month}-${parts[1].padStart(2, '0')}`;
  return isCalendarDate(iso) ? iso : undefined;
}

/** A line in a foreign currency: ten98-books posts bills in the base currency only, so such a line keeps its bill rows out. */
export const isForeignLine = (extras: unknown): boolean => isRecord(extras) && typeof extras.currency === 'string';
