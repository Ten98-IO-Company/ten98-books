import { addMoney, assertMoneyInRange, subtractMoney } from '@ten98/runtime';
import { financialYearOf } from '../../lib/company.ts';
import {
  balancePreviewInput, counterLedgerQuery, nextNumberQuery,
  type BalancePreview, type CounterLedger, type NextNumber, type Side,
} from '../../lib/ledger.ts';
import { ledgerError, parseAmount, parseInput, type LedgerContext } from './context.ts';
import { countsSql, ledgerRows, reportBudget } from './reports.ts';

/**
 * Reads for the voucher entry screen. Each runs inside the caller's withCompany transaction (viewers may read), writes
 * nothing and takes no lock beyond what a plain read takes, under a 5-second statement budget (D-09). Balances come from
 * the shared read model in reports.ts, so a preview always agrees with the trial balance and the ledger reports.
 */

const budgetSeconds = 5;
const signed = (side: Side, amount: bigint) => side === 'Dr' ? amount : subtractMoney(0n, amount);

/**
 * The number the next regular voucher of the type would take on `date` under its restart rule: the period's counter plus
 * one, or the rule's starting number while the period has none. A preview only: another voucher saved first takes it.
 */
export async function nextNumber(context: LedgerContext, voucherTypeId: string, query: unknown): Promise<NextNumber> {
  const { date } = parseInput(nextNumberQuery, query, () => 'the date');
  const { client, company } = context;
  await reportBudget(context, budgetSeconds);
  const { rows } = await client.query<{ periodStart: string | null; startingNumber: number | null; lastNumber: number | null }>(
    `SELECT r.period_start AS "periodStart", r.starting_number AS "startingNumber",
       (SELECT c.last_number FROM voucher_counter c
        WHERE c.company_id = t.company_id AND c.voucher_type_id = t.id AND c.series = t.numbering_series AND c.period_start = r.period_start) AS "lastNumber"
     FROM voucher_type t CROSS JOIN LATERAL ledger_numbering_rule(t.company_id, t.id, $3::date) r
     WHERE t.company_id = $1 AND t.id = $2`,
    [company.companyId, voucherTypeId, date]);
  const row = rows[0];
  if (!row) throw ledgerError(404, 'Voucher type not found.', 'not_found');
  // Every voucher type gets its restart rule from the database when it is created, so a missing rule is a broken invariant.
  if (row.periodStart === null || row.startingNumber === null) throw new Error(`Voucher type ${voucherTypeId} has no numbering rule.`);
  // Only yearly restart exists (LEDGER.md, "Numbering"), so a period ends with the financial year containing the date.
  return { number: row.lastNumber === null ? row.startingNumber : row.lastNumber + 1, periodStart: row.periodStart, periodEnd: financialYearOf(company.financialYearStart, date).to };
}

/**
 * Each ledger named in the draft lines, with its balance at `date` as the books stand (from the start of that date's
 * financial year, the trial balance's closing), minus the stored lines of `voucherId` when that voucher counts at the
 * date, plus the draft lines. Lines are checked as posting checks them (amounts, ledgers of the company); the draft may be
 * unbalanced or break a voucher type's rule, because it is not posted.
 */
export async function balancePreview(context: LedgerContext, value: unknown): Promise<BalancePreview> {
  const input = parseInput(balancePreviewInput, value, path => path[0] === 'date' ? 'the date' : path[0] === 'voucherId' ? 'the voucher' : path[0] === 'lines' ? `line ${Number(path[1] ?? 0) + 1}`
    : path[0] === 'ledgers' ? (path[1] === undefined ? 'the ledgers' : `ledger ${Number(path[1]) + 1} of the ledgers`) : 'the preview');
  const { client, company } = context;
  const lines = input.lines.map((line, index) => {
    const amount = parseAmount(line.amount, company.exponent, `The amount on line ${index + 1}`);
    if (amount <= 0n) throw ledgerError(400, `The amount on line ${index + 1} must be more than zero.`, 'validation');
    return { ...line, amount, lineNo: index + 1 };
  });
  // The draft's totals stay inside the bigint range, as a posted voucher's must.
  let debit = 0n, credit = 0n;
  for (const line of lines) if (line.side === 'Dr') debit = addMoney(debit, line.amount); else credit = addMoney(credit, line.amount);
  try { assertMoneyInRange(debit); assertMoneyInRange(credit); }
  catch { throw ledgerError(400, 'The voucher total is too large.', 'validation'); }
  await reportBudget(context, budgetSeconds);
  // The draft's ledgers are checked before the company-wide aggregate runs.
  // Each ledger once, in order of first appearance: the lines', then those `ledgers` adds (the Account before its first line).
  const extra = input.ledgers ?? [];
  const named = [...new Set([...lines.map(line => line.ledgerId), ...extra])];
  if (named.length) {
    const { rows: found } = await client.query<{ id: string }>('SELECT id FROM ledger WHERE company_id = $1 AND id = ANY($2::uuid[])', [company.companyId, named]);
    const known = new Set(found.map(row => row.id));
    const missing = lines.find(line => !known.has(line.ledgerId));
    if (missing) throw ledgerError(400, `The ledger on line ${missing.lineNo} was not found in this company.`, 'not_found');
    const unknown = extra.findIndex(ledgerId => !known.has(ledgerId));
    if (unknown >= 0) throw ledgerError(400, `Ledger ${unknown + 1} of the ledgers was not found in this company.`, 'not_found');
  }
  const yearStart = financialYearOf(company.financialYearStart, input.date).from;
  const { rows } = await ledgerRows(context, yearStart, input.date);
  const ledgers = new Map(rows.map(row => [row.ledgerId, row]));
  const balances = new Map(rows.map(row => [row.ledgerId, subtractMoney(row.closingDebit, row.closingCredit)]));

  if (input.voucherId) {
    const { rows: stored } = await client.query<{ counts: boolean; earlierYear: boolean; ledgerId: string | null; side: Side | null; amount: bigint | null }>(
      `SELECT ${countsSql} AND v.date <= $3::date AS counts, v.date < $4::date AS "earlierYear", l.ledger_id AS "ledgerId", l.side, l.amount
       FROM voucher v LEFT JOIN voucher_line l ON l.company_id = v.company_id AND l.voucher_id = v.id
       WHERE v.company_id = $1 AND v.id = $2`,
      [company.companyId, input.voucherId, input.date, yearStart]);
    if (!stored[0]) throw ledgerError(400, 'The voucher was not found.', 'not_found');
    // Income and expense of an earlier financial year sit in the profit and loss ledger at this date, not in their own.
    const profitAndLoss = rows.find(row => row.systemKey === 'profit_and_loss')?.ledgerId;
    for (const line of stored) {
      if (!line.counts || !line.ledgerId || !line.side || line.amount === null) continue;
      const nature = ledgers.get(line.ledgerId)?.nature;
      const target = line.earlierYear && (nature === 'income' || nature === 'expense') && profitAndLoss ? profitAndLoss : line.ledgerId;
      balances.set(target, subtractMoney(balances.get(target) ?? 0n, signed(line.side, line.amount)));
    }
  }
  for (const line of lines) balances.set(line.ledgerId, addMoney(balances.get(line.ledgerId)!, signed(line.side, line.amount)));
  return {
    balances: named.map(ledgerId => {
      const balance = balances.get(ledgerId)!;
      try { assertMoneyInRange(balance); }
      catch { throw ledgerError(400, `The balance of ${ledgers.get(ledgerId)!.name} would be too large.`, 'validation'); }
      return { ledgerId, balance };
    }),
  };
}

/**
 * The counter ledger a new double-entry line proposes after `ledgerId` on `side`: from the most recently entered regular,
 * undeleted voucher of the type with a line on that ledger and side, its first line on the other side. Observed: the
 * most recent counter is proposed, not the most frequent, and single entry proposes nothing. Entry order and date order
 * coincided in the observation; entry order is used.
 */
export async function counterLedger(context: LedgerContext, ledgerId: string, query: unknown): Promise<CounterLedger> {
  const input = parseInput(counterLedgerQuery, query, path => path[0] === 'side' ? 'the side' : 'the voucher type');
  const { client, company } = context;
  await reportBudget(context, budgetSeconds);
  const { rows: [found] } = await client.query<{ ledger: boolean; type: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ledger WHERE company_id = $1 AND id = $2) AS ledger,
       EXISTS (SELECT 1 FROM voucher_type WHERE company_id = $1 AND id = $3) AS type`,
    [company.companyId, ledgerId, input.voucherTypeId]);
  if (!found?.ledger) throw ledgerError(404, 'Ledger not found.', 'not_found');
  if (!found.type) throw ledgerError(400, 'The voucher type was not found.', 'not_found');
  const { rows } = await client.query<{ ledgerId: string; voucherId: string; voucherDate: string }>(
    `WITH last AS (
       SELECT v.id, v.date FROM voucher_line l JOIN voucher v ON v.company_id = l.company_id AND v.id = l.voucher_id
       WHERE l.company_id = $1 AND l.ledger_id = $2 AND l.side = $3 AND v.voucher_type_id = $4 AND ${countsSql}
       ORDER BY v.created_at DESC, v.id DESC LIMIT 1)
     SELECT o.ledger_id AS "ledgerId", last.id AS "voucherId", last.date AS "voucherDate"
     FROM last CROSS JOIN LATERAL (
       SELECT x.ledger_id FROM voucher_line x WHERE x.company_id = $1 AND x.voucher_id = last.id AND x.side <> $3 ORDER BY x.line_no LIMIT 1) o`,
    [company.companyId, ledgerId, input.side, input.voucherTypeId]);
  return { counter: rows[0] ?? null };
}
