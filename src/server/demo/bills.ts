import { nameMatchKey } from '../../lib/names.ts';
import { dispositionOf, type Dataset } from './dataset.ts';
import { isForeignLine, readLedgerBills, readLineBills, type BillMethod } from './bill-rows.ts';

/**
 * Which of a dataset's bill rows are posted and which are left out, decided once for the seeder and the comparison so
 * the figures compared are exactly the figures the seeder could produce. Rows are replayed in entry order, the way the
 * ledger module will see them:
 *
 * - a row on a line in a foreign currency is left out (ten98-books keeps bills in the base currency only);
 * - an against row naming a bill that no live row has created yet is left out (the ledger module refuses a settlement
 *   of a bill with no live entry); the bill may be created by a foreign-currency line, or by a voucher the dataset
 *   carries without lines, which ten98-books cannot post;
 * - everything else is sent as the ledger module's own bill row.
 *
 * A bill is live once a regular voucher's new reference or advance, or the ledger's opening bills, created it; the rows
 * of a cancelled or optional voucher are sent as they are but make no bill live for later settlements.
 */

export type SentBillRow = { kind: BillMethod; name?: string; creditPeriod?: { count: number; unit: 'day' }; amount: string };
export type SkippedBillRow = { voucher: string; ledger: string; kind: BillMethod; name: string | null; amount: string; reason: 'foreign' | 'unknown' };
export type BillPlan = {
  /** Per voucher key, the rows to send on each line (`undefined`: nothing to send on that line). */
  lines: Map<string, (SentBillRow[] | undefined)[]>;
  sent: number;
  skipped: SkippedBillRow[];
  /** Bills (by ledger key, then lower-case name) a left-out row names, with why: their figures cannot be reproduced. */
  affected: Map<string, Map<string, 'foreign' | 'unknown'>>;
  /** Bills a row of a posted voucher (or the ledger's opening bills) creates, by ledger key and lower-case name. */
  created: Map<string, Set<string>>;
  /** Ledgers with a line in a foreign currency. */
  foreignLedgers: Set<string>;
};

const creating = (method: BillMethod) => method === 'new_ref' || method === 'advance';

export function planBills(dataset: Dataset): BillPlan {
  const plan: BillPlan = { lines: new Map(), sent: 0, skipped: [], affected: new Map(), created: new Map(), foreignLedgers: new Set() };
  const live = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, ledger: string, name: string) => (map.get(ledger) ?? map.set(ledger, new Set()).get(ledger)!).add(nameMatchKey(name));
  const mark = (ledger: string, name: string, reason: 'foreign' | 'unknown') => {
    const names = plan.affected.get(ledger) ?? plan.affected.set(ledger, new Map()).get(ledger)!;
    if (names.get(nameMatchKey(name)) !== 'foreign') names.set(nameMatchKey(name), reason);
  };
  for (const entry of dataset.ledgers) for (const bill of readLedgerBills(entry.extras).found.openingBills) { add(live, entry.key, bill.name); add(plan.created, entry.key, bill.name); }
  for (const voucher of dataset.vouchers) {
    if (dispositionOf(voucher) !== 'post') continue;
    const perLine = voucher.lines.map(line => {
      const rows = readLineBills(line.extras).found;
      if (!rows.length) return undefined;
      const foreign = isForeignLine(line.extras);
      if (foreign) plan.foreignLedgers.add(line.ledger);
      const sent: SentBillRow[] = [];
      for (const row of rows) {
        const skip = (reason: 'foreign' | 'unknown') => {
          plan.skipped.push({ voucher: voucher.key, ledger: line.ledger, kind: row.method, name: row.name ?? null, amount: row.amount, reason });
          if (row.name !== undefined) mark(line.ledger, row.name, reason);
        };
        if (foreign) { skip('foreign'); continue; }
        if (row.method === 'against_ref' && !live.get(line.ledger)?.has(nameMatchKey(row.name!))) { skip('unknown'); continue; }
        sent.push({ kind: row.method, ...row.name !== undefined ? { name: row.name } : {}, ...row.creditDays !== undefined ? { creditPeriod: { count: row.creditDays, unit: 'day' } } : {}, amount: row.amount });
        if (creating(row.method) && row.name !== undefined) {
          add(plan.created, line.ledger, row.name);
          if (voucher.status === 'regular') add(live, line.ledger, row.name);
        }
      }
      plan.sent += sent.length;
      return sent.length ? sent : undefined;
    });
    // A foreign-currency line elsewhere in the voucher also marks its ledger, even when it carries no bill rows.
    for (const line of voucher.lines) if (isForeignLine(line.extras)) plan.foreignLedgers.add(line.ledger);
    plan.lines.set(voucher.key, perLine);
  }
  return plan;
}
