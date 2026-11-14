import { assertMoneyInRange, parseMoney, type MoneyExponent } from '@ten98/runtime';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { moneyToWire, type Wire } from '../../lib/money.ts';
import { FoundationError } from '../auth.ts';
import { withCompany, type CompanyMode } from '../tenancy.ts';

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
  if (!row) throw new FoundationError(404, 'Company not found or unavailable.');
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
    if (['40P01', '40001'].includes((error as { code?: string })?.code ?? '')) throw new FoundationError(409, 'This change collided with another one made at the same moment. Nothing was saved; try again.');
    throw error;
  }
}

/** Parses `value` with `schema`, refusing with a plain-language message that names the first field at fault. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown, describe: (path: readonly PropertyKey[]) => string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new FoundationError(400, `Check ${describe(parsed.error.issues[0]?.path ?? [])} and try again.`);
}

/** Maps a PostgreSQL refusal named by constraint (or by SQLSTATE) to a plain-language error; rethrows anything else. */
export function refusal(error: unknown, messages: Record<string, FoundationError>): never {
  const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
  const mapped = (constraint && messages[constraint]) || (code && messages[code]);
  throw mapped || error;
}

export const conflict = (what: string) => new FoundationError(409, `This ${what} was changed by someone else. Reload it and try again.`);

/**
 * Minor units from a wire amount for the company's currency. `parseMoney` refuses extra decimal places and amounts beyond
 * the `bigint` range rather than rounding; both become plain-language refusals naming `what`.
 */
export function parseAmount(text: string, exponent: MoneyExponent, what: string): bigint {
  if ((text.split('.')[1] ?? '').length > exponent) throw new FoundationError(400, `Enter ${what.toLowerCase()} with at most ${exponent} decimal places.`);
  let amount: bigint;
  try { amount = parseMoney(text, exponent); }
  catch (error) { throw error instanceof RangeError ? new FoundationError(400, `${what} is too large.`) : new FoundationError(400, `Check ${what.toLowerCase()} and try again.`); }
  assertMoneyInRange(amount);
  return amount;
}
