import { assertMoneyInRange, parseMoney, type MoneyExponent } from '@ten98/runtime';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { LedgerErrorCode } from '../../lib/ledger.ts';
import { moneyToWire, type Wire } from '../../lib/money.ts';
import { FoundationError } from '../auth.ts';
import { companyNotSetUp, withCompany, type CompanyMode } from '../tenancy.ts';
import { InputError, readJson } from '../validation.ts';

/** The company settings every posting rule needs, read inside the company transaction. */
export type LedgerCompany = {
  companyId: string; baseCurrency: string; exponent: MoneyExponent; booksBeginning: string; lockedThrough: string | null;
  financialYearStart: { month: number; day: number };
};
/** A company-scoped transaction (opened by withCompany) plus who acts and the company's settings. */
export type LedgerContext = { client: PoolClient; userId: string; company: LedgerCompany };

/**
 * Loads the company settings. Writers share-lock the company row, so advancing the locked-through date waits for
 * postings already in flight and cannot slip between a posting's date check and its commit.
 */
export async function ledgerContext(client: PoolClient, companyId: string, userId: string, mode: CompanyMode): Promise<LedgerContext> {
  const { rows } = await client.query<{ base_currency: string; currency_minor_units: number; books_beginning: string; locked_through: string | null; fy_start_month: number; fy_start_day: number }>(
    `SELECT base_currency, currency_minor_units, books_beginning, locked_through, fy_start_month, fy_start_day FROM company WHERE company_id = $1${mode === 'write' ? ' FOR SHARE' : ''}`,
    [companyId]);
  const row = rows[0];
  // withCompany already admitted a member, so a missing row is a company (workspace) without books settings yet.
  if (!row) throw new FoundationError(409, companyNotSetUp, 'not_set_up');
  return {
    client, userId,
    company: {
      companyId, baseCurrency: row.base_currency, exponent: row.currency_minor_units as MoneyExponent,
      booksBeginning: row.books_beginning, lockedThrough: row.locked_through,
      financialYearStart: { month: row.fy_start_month, day: row.fy_start_day },
    },
  };
}

/**
 * The API's one way into the ledger: authorizes through withCompany (viewers read, editors write), loads the context,
 * runs `run` in that single transaction and returns the result with amounts formatted for the company's currency.
 */
export async function runLedger<T>(userId: string, companyId: string, mode: CompanyMode, run: (context: LedgerContext) => Promise<T>): Promise<Wire<T>> {
  try {
    return await withCompany(userId, companyId, mode, async (client, access) => {
      const context = await ledgerContext(client, access.companyId, userId, mode);
      return moneyToWire(await run(context), context.company.exponent);
    });
  } catch (error) {
    // Deadlock or serialization failure: another change to the same rows won; nothing was committed.
    if (['40P01', '40001'].includes((error as { code?: string })?.code ?? '')) throw ledgerError(409, 'This change collided with another one made at the same moment. Nothing was saved; try again.', 'retry');
    // withCompany's refusal (a missing or unreachable company: one answer for both) is shared with non-ledger areas, so
    // it carries no code there; ledger answers add `not_found` and keep the status and message.
    if (error instanceof FoundationError && error.status === 404 && error.code === undefined) throw ledgerError(404, error.message, 'not_found');
    throw error;
  }
}

/** A refusal from the ledger API: plain-language message plus a stable code from the shared list. */
export const ledgerError = (status: number, message: string, code: LedgerErrorCode) => new FoundationError(status, message, code);

/** Transport refusals of the request body (content type, size, JSON) answer with the ledger's `validation` code. */
export async function readLedgerBody(request: Request, maxBytes?: number): Promise<unknown> {
  try { return await readJson(request, maxBytes); }
  catch (error) { throw error instanceof InputError ? ledgerError(error.status, error.message, 'validation') : error; }
}

/** Parses `value` with `schema`, refusing with a plain-language message that names the first field at fault. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown, describe: (path: readonly PropertyKey[]) => string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw ledgerError(400, `Check ${describe(parsed.error.issues[0]?.path ?? [])} and try again.`, 'validation');
}

/** Maps a PostgreSQL refusal named by constraint (or by SQLSTATE) to a plain-language error; rethrows anything else. */
export function refusal(error: unknown, messages: Record<string, FoundationError>): never {
  const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
  const mapped = (constraint && messages[constraint]) || (code && messages[code]);
  throw mapped || error;
}

export const conflict = (what: string) => ledgerError(409, `This ${what} was changed by someone else. Reload it and try again.`, 'stale_revision');

/**
 * Minor units from a wire amount for the company's currency. `parseMoney` refuses extra decimal places and amounts beyond
 * the `bigint` range rather than rounding; both become plain-language refusals naming `what`.
 */
export function parseAmount(text: string, exponent: MoneyExponent, what: string): bigint {
  if ((text.split('.')[1] ?? '').length > exponent) throw ledgerError(400, `Enter ${what.toLowerCase()} with at most ${exponent} decimal places.`, 'validation');
  let amount: bigint;
  try { amount = parseMoney(text, exponent); }
  catch (error) { throw error instanceof RangeError ? ledgerError(400, `${what} is too large.`, 'validation') : ledgerError(400, `Check ${what.toLowerCase()} and try again.`, 'validation'); }
  assertMoneyInRange(amount);
  return amount;
}
