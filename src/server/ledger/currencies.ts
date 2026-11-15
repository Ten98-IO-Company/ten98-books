import {
  currencyAlterInput, currencyCreateInput, exchangeRatesInput, rateKinds, ratesQuery,
  type Currency, type CurrencyListItem, type CurrencyRates, type ExchangeRateRow, type RateKind, type RatesOn, type RatesSaved, type RateWarningCode,
} from '../../lib/currencies.ts';
import { revisionInput, type Revision } from '../../lib/ledger.ts';
import { conflict, ledgerError, parseInput, refusal, type LedgerContext } from './context.ts';
import { listRevisions, logRevision } from './revisions.ts';

/**
 * Currencies and dated rates (M2a currencies, slice a). The base row is seeded with the company (D-10) and keeps its code
 * and decimals; foreign currencies are created, altered and deleted here. Rates are rows per currency, kind and date; the
 * rate in force on a date is the latest row of its kind on or before it. The database guards (migration 0012) refuse the
 * same things for any code path: these functions refuse first, in plain language, and take the same locks first.
 */

const field = (labels: Record<string, string>, fallback: string) => (path: readonly PropertyKey[]) => labels[String(path[0])] ?? fallback;
const currencyFields = field({
  code: 'the currency code', symbol: 'the symbol', formalName: 'the formal name', isoCode: 'the ISO code', decimals: 'the decimal places',
  inMillions: 'the millions setting', symbolAfter: 'the symbol position', spaceBetween: 'the space setting', decimalWord: 'the word for the decimal part',
  wordsDecimals: 'the decimal places in words', revision: 'the revision',
}, 'the currency details');
const rateFields = field({ date: 'the rate date', rates: 'the rates' }, 'the rates');

const notFound = ledgerError(404, 'Currency not found.', 'not_found');
const symbolTaken = ledgerError(409, 'Another currency has this symbol or code. Symbols and codes are compared without case, spaces or punctuation, and each must be unique.', 'duplicate_name');
const inUse = ledgerError(409, 'A ledger is in this currency, so its decimal places are fixed and it cannot be deleted.', 'in_use');
const ratesLocked = (through: string) => ledgerError(409, `Rates dated on or before ${through} are locked with the books.`, 'locked_period');
const refusals = {
  currency_pkey: ledgerError(409, 'A currency with this code already exists.', 'duplicate_name'),
  currency_symbol_idx: symbolTaken,
  currency_symbol_key: ledgerError(400, 'A symbol needs a letter, a digit or a sign, not only spaces and punctuation.', 'validation'),
  currency_builtin: ledgerError(409, 'The base currency keeps its code and decimal places and cannot be deleted. Its symbol, names and presentation can be changed.', 'seeded_row'),
  currency_in_use: inUse,
  '23503': inUse,
  exchange_rate_base: ledgerError(400, 'The base currency has no rates.', 'validation'),
  exchange_rate_bounds: ledgerError(400, 'A rate is more than zero, with at most 10 digits before the point and 4 after it.', 'validation'),
};

const columns = `c.code, c.system_key AS "systemKey", c.symbol, c.formal_name AS "formalName", c.iso_code AS "isoCode", c.decimals,
  c.in_millions AS "inMillions", c.symbol_after AS "symbolAfter", c.space_between AS "spaceBetween", c.decimal_word AS "decimalWord",
  c.words_decimals AS "wordsDecimals", c.revision`;
/** Whether a ledger names the currency (through ledger_currency_idx). */
const inUseSql = 'EXISTS (SELECT 1 FROM ledger x WHERE x.company_id = c.company_id AND x.currency = c.code)';

export async function listCurrencies(context: LedgerContext): Promise<CurrencyListItem[]> {
  const { rows } = await context.client.query<CurrencyListItem>(
    `SELECT ${columns}, c.system_key IS NOT NULL AS "isBase", ${inUseSql} AS "inUse" FROM currency c WHERE c.company_id = $1
     ORDER BY c.system_key IS NULL, c.code`, [context.company.companyId]);
  return rows;
}

export async function getCurrency(context: LedgerContext, code: string): Promise<CurrencyListItem> {
  const { rows } = await context.client.query<CurrencyListItem>(
    `SELECT ${columns}, c.system_key IS NOT NULL AS "isBase", ${inUseSql} AS "inUse" FROM currency c WHERE c.company_id = $1 AND c.code = $2`,
    [context.company.companyId, code]);
  if (!rows[0]) throw notFound;
  return rows[0];
}

/**
 * One currency with its revision-log id. `lock` takes its row first: `share` (FOR NO KEY UPDATE) serialises changes to
 * it without waiting for postings that key-share it; `update` (FOR UPDATE, the lock a delete takes) also waits for
 * ledgers still being written in it, so the delete's use check that follows sees them.
 */
async function readCurrency(context: LedgerContext, code: string, lock?: 'share' | 'update'): Promise<Currency & { id: string }> {
  if (lock) await context.client.query(`SELECT 1 FROM currency WHERE company_id = $1 AND code = $2 ${lock === 'update' ? 'FOR UPDATE' : 'FOR NO KEY UPDATE'}`, [context.company.companyId, code]);
  const { rows } = await context.client.query<Currency & { id: string }>(`SELECT c.id, ${columns} FROM currency c WHERE c.company_id = $1 AND c.code = $2`, [context.company.companyId, code]);
  if (!rows[0]) throw notFound;
  return rows[0];
}
const snapshot = ({ id: _id, ...currency }: Currency & { id: string }): Currency => currency;

async function namedByLedger(context: LedgerContext, code: string): Promise<boolean> {
  const { rows } = await context.client.query<{ used: boolean }>('SELECT EXISTS (SELECT 1 FROM ledger WHERE company_id = $1 AND currency = $2) AS used', [context.company.companyId, code]);
  return rows[0].used;
}

export async function createCurrency(context: LedgerContext, value: unknown): Promise<Currency> {
  const input = parseInput(currencyCreateInput, value, currencyFields);
  const { rows } = await context.client.query<{ code: string }>(
    `INSERT INTO currency (company_id, code, symbol, formal_name, iso_code, decimals, in_millions, symbol_after, space_between, decimal_word, words_decimals)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING code`,
    [context.company.companyId, input.code, input.symbol, input.formalName, input.isoCode, input.decimals, input.inMillions ?? false,
      input.symbolAfter ?? false, input.spaceBetween ?? false, input.decimalWord ?? null, input.wordsDecimals ?? 2]).catch(error => refusal(error, refusals));
  const after = await readCurrency(context, rows[0].code);
  await logRevision(context, 'currency', after.id, 'create', null, snapshot(after));
  return snapshot(after);
}

export async function alterCurrency(context: LedgerContext, code: string, value: unknown): Promise<Currency> {
  const input = parseInput(currencyAlterInput, value, currencyFields);
  const before = await readCurrency(context, code, 'share');
  if (before.revision !== input.revision) throw conflict('currency');
  if (input.decimals !== before.decimals) {
    if (before.systemKey) throw refusals.currency_builtin;
    // A ledger still being written in this currency is not seen here; the UPDATE below waits for it and the guard then refuses.
    if (await namedByLedger(context, code)) throw inUse;
  }
  await context.client.query(
    `UPDATE currency SET symbol = $3, formal_name = $4, iso_code = $5, decimals = $6, in_millions = $7, symbol_after = $8, space_between = $9,
       decimal_word = $10, words_decimals = $11, revision = revision + 1 WHERE company_id = $1 AND code = $2`,
    [context.company.companyId, code, input.symbol, input.formalName, input.isoCode === undefined ? before.isoCode : input.isoCode, input.decimals,
      input.inMillions ?? before.inMillions, input.symbolAfter ?? before.symbolAfter, input.spaceBetween ?? before.spaceBetween,
      input.decimalWord === undefined ? before.decimalWord : input.decimalWord, input.wordsDecimals ?? before.wordsDecimals]).catch(error => refusal(error, refusals));
  const after = await readCurrency(context, code);
  await logRevision(context, 'currency', after.id, 'alter', snapshot(before), snapshot(after));
  return snapshot(after);
}

export async function deleteCurrency(context: LedgerContext, code: string, value: unknown): Promise<void> {
  const input = parseInput(revisionInput, value, currencyFields);
  const before = await readCurrency(context, code, 'update');
  if (before.revision !== input.revision) throw conflict('currency');
  if (before.systemKey) throw refusals.currency_builtin;
  if (await namedByLedger(context, code)) throw inUse;
  const { lockedThrough } = context.company;
  if (lockedThrough !== null) {
    const { rows } = await context.client.query<{ locked: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM exchange_rate WHERE company_id = $1 AND currency = $2 AND effective_date <= $3) AS locked', [context.company.companyId, code, lockedThrough]);
    if (rows[0].locked) throw ratesLocked(lockedThrough);
  }
  // Its rate rows go with it (ON DELETE CASCADE).
  await context.client.query('DELETE FROM currency WHERE company_id = $1 AND code = $2', [context.company.companyId, code])
    .catch(error => refusal(error, { ...refusals, exchange_rate_locked: ratesLocked(lockedThrough ?? '') }));
  await logRevision(context, 'currency', before.id, 'delete', snapshot(before), null);
}

/**
 * A currency's history by its code: the current currency's, or, once it is deleted, that of the last currency the company
 * had under the code, so a deleted currency's history stays readable; 404 when the company never had the code.
 */
export async function currencyRevisions(context: LedgerContext, code: string): Promise<Revision[]> {
  const current = await readCurrency(context, code).catch(error => { if (error === notFound) return null; throw error; });
  const id = current?.id ?? (await context.client.query<{ id: string }>(
    `SELECT entity_id AS id FROM revision_log WHERE company_id = $1 AND entity = 'currency' AND coalesce(before, after)->>'code' = $2 ORDER BY id DESC LIMIT 1`,
    [context.company.companyId, code])).rows[0]?.id;
  if (!id) throw notFound;
  return listRevisions(context, 'currency', id);
}

/** Every rate row of one currency, by kind and date. */
export async function currencyRates(context: LedgerContext, code: string): Promise<ExchangeRateRow[]> {
  await readCurrency(context, code);
  const { rows } = await context.client.query<ExchangeRateRow>(
    `SELECT kind, to_char(effective_date, 'YYYY-MM-DD') AS "effectiveDate", rate::text AS rate FROM exchange_rate
     WHERE company_id = $1 AND currency = $2 ORDER BY array_position($3::text[], kind), effective_date`, [context.company.companyId, code, rateKinds]);
  return rows;
}

/**
 * Each foreign currency's rate of each kind in force on `date`: its latest row on or before the date (a backward scan of
 * the primary key per currency and kind; every comparison is leakproof, so under the row-level policy it is an index
 * condition), or null before its first row.
 */
async function ratesInForce(context: LedgerContext, date: string): Promise<RatesOn> {
  const { rows } = await context.client.query<{ currency: string; kind: RateKind; rate: string | null; effectiveDate: string | null }>(
    `SELECT c.code AS currency, k.kind, r.rate::text AS rate, to_char(r.effective_date, 'YYYY-MM-DD') AS "effectiveDate"
     FROM currency c CROSS JOIN unnest($3::text[]) AS k(kind)
     LEFT JOIN LATERAL (SELECT e.rate, e.effective_date FROM exchange_rate e
       WHERE e.company_id = c.company_id AND e.currency = c.code AND e.kind = k.kind AND e.effective_date <= $2::date
       ORDER BY e.effective_date DESC LIMIT 1) r ON true
     WHERE c.company_id = $1 AND c.system_key IS NULL ORDER BY c.code`, [context.company.companyId, date, rateKinds]);
  const byCurrency = new Map<string, CurrencyRates>();
  for (const row of rows) {
    const entry = byCurrency.get(row.currency) ?? { currency: row.currency, standard: null, selling: null, buying: null };
    entry[row.kind] = row.rate === null ? null : { rate: row.rate, effectiveDate: row.effectiveDate!, onDate: row.effectiveDate === date };
    byCurrency.set(row.currency, entry);
  }
  return { date, currencies: [...byCurrency.values()] };
}

export async function ratesOn(context: LedgerContext, query: unknown): Promise<RatesOn> {
  const { date } = parseInput(ratesQuery, query, rateFields);
  return ratesInForce(context, date);
}

type DateRates = { date: string; rates: { currency: string; kind: RateKind; rate: string }[] };
async function ratesDatedOn(context: LedgerContext, date: string): Promise<DateRates> {
  const { rows } = await context.client.query<{ currency: string; kind: RateKind; rate: string }>(
    `SELECT currency, kind, rate::text AS rate FROM exchange_rate WHERE company_id = $1 AND effective_date = $2::date
     ORDER BY currency, array_position($3::text[], kind)`, [context.company.companyId, date, rateKinds]);
  return { date, rates: rows };
}

/**
 * Writes one date's rates: a value writes the row of that kind, null removes it, an omitted kind is left alone. One
 * revision-log entry (entity `exchange_rate`, one id per date) holds that date's rows before and after; a call that
 * changes nothing writes none. Rates compare as numbers: 3.7 sent for a stored 3.70 writes nothing and keeps the text. Writes for one date queue on a transaction lock, so the before and after are exact. The
 * answer is the rates in force on the date, with `rates_move_reports` when vouchers are dated on or after it.
 */
export async function saveRates(context: LedgerContext, value: unknown): Promise<RatesSaved> {
  const input = parseInput(exchangeRatesInput, value, rateFields);
  const { companyId, baseCurrency, lockedThrough } = context.company;
  if (lockedThrough !== null && input.date <= lockedThrough) throw ratesLocked(lockedThrough);
  const codes = input.rates.map(row => row.currency);
  if (codes.includes(baseCurrency)) throw refusals.exchange_rate_base;
  // Key-share the currencies, so a delete waits; each must exist.
  const { rows: found } = await context.client.query<{ code: string }>(
    'SELECT code FROM currency WHERE company_id = $1 AND code = ANY($2::text[]) ORDER BY code FOR KEY SHARE', [companyId, codes]);
  const missing = codes.filter(code => !found.some(row => row.code === code));
  if (missing.length) throw ledgerError(400, `Currency ${missing.join(', ')} was not found.`, 'not_found');
  await context.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`exchange_rate:${companyId}:${input.date}`]);
  const before = await ratesDatedOn(context, input.date);
  for (const row of input.rates) {
    for (const kind of rateKinds) {
      const rate = row[kind];
      if (rate === undefined) continue;
      const write = rate === null
        ? context.client.query('DELETE FROM exchange_rate WHERE company_id = $1 AND currency = $2 AND kind = $3 AND effective_date = $4::date', [companyId, row.currency, kind, input.date])
        : context.client.query(
          `INSERT INTO exchange_rate (company_id, currency, kind, effective_date, rate) VALUES ($1, $2, $3, $4::date, $5::numeric)
           ON CONFLICT (company_id, currency, kind, effective_date) DO UPDATE SET rate = EXCLUDED.rate WHERE exchange_rate.rate <> EXCLUDED.rate`,
          [companyId, row.currency, kind, input.date, rate]);
      await write.catch(error => refusal(error, { ...refusals, exchange_rate_locked: ratesLocked(lockedThrough ?? '') }));
    }
  }
  const after = await ratesDatedOn(context, input.date);
  if (JSON.stringify(before.rates) !== JSON.stringify(after.rates)) {
    const action = before.rates.length === 0 ? 'create' : after.rates.length === 0 ? 'delete' : 'alter';
    const { rows: [entity] } = await context.client.query<{ id: string }>('SELECT md5($1)::uuid AS id', [`exchange_rate:${input.date}`]);
    await logRevision(context, 'exchange_rate', entity.id, action, action === 'create' ? null : before, action === 'delete' ? null : after);
  }
  const { rows: [last] } = await context.client.query<{ moves: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM voucher WHERE company_id = $1 AND date >= $2::date AND deleted_at IS NULL) AS moves', [companyId, input.date]);
  const warnings: RateWarningCode[] = last.moves ? ['rates_move_reports'] : [];
  return { ...await ratesInForce(context, input.date), warnings };
}
