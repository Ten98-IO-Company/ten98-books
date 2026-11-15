import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export type EarlierLine = { ledgerId: string; side: 'Dr' | 'Cr'; amount: number; cost?: { categoryId: string; costCentreId: string } };

/**
 * A regular, numbered voucher in the base currency (AED), written as the posting code stores one: the voucher, its
 * lines and cost rows, and the next number of its type's counter in its date's period. For migration tests on a schema
 * older than the one the current code reads (the posting code's own read of the voucher needs every later table).
 * Runs in one transaction of `client` (an admin connection) scoped to `company`; returns the voucher id.
 */
export async function earlierVoucher(client: pg.Client, company: string, user: string, kind: string, date: string, lines: EarlierLine[]): Promise<string> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.company_ids', $1, true)", [company]);
    const type = (await client.query('SELECT id, numbering_series FROM voucher_type WHERE company_id = $1 AND kind = $2', [company, kind])).rows[0];
    const voucher: string = (await client.query(`INSERT INTO voucher (company_id, voucher_type_id, series, date, status, idempotency_key, request_hash, created_by)
      VALUES ($1, $2, $3, $4, 'regular', $5, $6, $7) RETURNING id`, [company, type.id, type.numbering_series, date, `earlier-${randomUUID()}`, 'a'.repeat(64), user])).rows[0].id;
    for (const [index, line] of lines.entries()) {
      await client.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
        VALUES ($1, $2, $3, $4, $5, $6, 'AED', $6, 1)`, [company, voucher, index + 1, line.ledgerId, line.side, line.amount]);
      if (line.cost) await client.query(`INSERT INTO cost_allocation (company_id, voucher_id, line_no, ledger_id, category_id, cost_centre_id, side, amount)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [company, voucher, index + 1, line.ledgerId, line.cost.categoryId, line.cost.costCentreId, line.side, line.amount]);
    }
    // As the posting code numbers it: the counter row first, then the number and its period on the voucher.
    const counter = (await client.query(`INSERT INTO voucher_counter (company_id, voucher_type_id, series, period_start, last_number)
      SELECT $1, $2, $3, r.period_start, r.starting_number FROM ledger_numbering_rule($1, $2, $4::date) r
      ON CONFLICT (company_id, voucher_type_id, series, period_start) DO UPDATE SET last_number = voucher_counter.last_number + 1
      RETURNING last_number, period_start`, [company, type.id, type.numbering_series, date])).rows[0];
    await client.query('UPDATE voucher SET number = $3, number_period = $4 WHERE company_id = $1 AND id = $2', [company, voucher, counter.last_number, counter.period_start]);
    await client.query('COMMIT');
    return voucher;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
}
