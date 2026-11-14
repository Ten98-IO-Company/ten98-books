import { addMoney, formatMoney, subtractMoney } from '@ten98/runtime';
import type { BillKind, BillRowInput, BillWarning, CreditPeriod, CreditUnit, OpeningBillInput, Side, VoucherKind } from '../../lib/ledger.ts';
import { ledgerError, parseAmount, type LedgerContext } from './context.ts';

/**
 * Bills (M2a slice 1, base currency). A bill is one party ledger's reference name, compared without regard to case: a
 * row finds its bill by name when it is posted, a new reference on a name the party already has joins that bill, and a
 * bill's pending amount is the signed sum of its live rows (observed behaviour of the reference workflow). The row that
 * dates a bill is derived (`creatorOrderSql`): its earliest-dated live new reference or advance, or, when none is
 * live, its earliest-dated live settlement (observed), so cancelling, deleting or renaming one voucher never rewrites
 * another. Behaviour the reference shows without a refusal is reproduced and reported back as a warning instead
 * (`BillWarning`).
 */

/**
 * Live bill rows matching `filter` (SQL over `a`, a bill_allocation row; $1 is the company): rows of regular,
 * undeleted vouchers, each with its voucher looked up by key, plus opening rows, with their date. The two parts keep
 * each read on the row indexes instead of a scan of every voucher. The voucher part states no `voucher_id IS NOT NULL`
 * (the voucher lookup implies it): as an index condition it let the planner read the line index whole.
 */
export const liveBillRowsSql = (filter: string) => `SELECT a.*, v.date AS row_date, false AS opening
    FROM bill_allocation a CROSS JOIN LATERAL (SELECT x.date FROM voucher x WHERE x.company_id = a.company_id AND x.id = a.voucher_id
      AND x.status = 'regular' AND x.deleted_at IS NULL) v
    WHERE a.company_id = $1 AND ${filter}
  UNION ALL
  SELECT a.*, a.bill_date AS row_date, true AS opening FROM bill_allocation a WHERE a.company_id = $1 AND a.voucher_id IS NULL AND ${filter}`;
/**
 * The order whose first row of a bill dates it (observed): new references and advances before settlements, then the
 * earliest date, then storage order (opening rows, then voucher, line and row; ids are time-ordered).
 */
export const creatorOrderSql = "(kind IN ('new_ref', 'advance')) DESC, row_date, opening DESC, voucher_id, line_no, id";
/** The due date of a bill whose creating row is `r`: its own, or for a settlement turned creator its copied terms from its date. */
export const creatorDueSql = (r: string) => `CASE WHEN ${r}.kind IN ('new_ref', 'advance') THEN ${r}.due_date
  WHEN ${r}.credit_count IS NOT NULL THEN bill_due_date(${r}.row_date, ${r}.credit_count, ${r}.credit_unit)
  ELSE coalesce(${r}.due_date, ${r}.row_date) END`;
/** Signed (debit positive) amount of a bill row aliased `r`. */
export const signedSql = (r: string) => `CASE ${r}.side WHEN 'Dr' THEN ${r}.amount ELSE -${r}.amount END`;

/** A voucher line as the bill rules need it: its ledger's bill-wise settings and the rows the request sent. */
export type BillLine = {
  lineNo: number; ledgerId: string; side: Side; amount: bigint; billWise: boolean; credit: CreditPeriod | null;
  bills?: BillRowInput[];
};
/** A bill row as stored, for keeping it through an alter. */
export type StoredBillRow = {
  lineNo: number; ledgerId: string; kind: BillKind; billId: string | null; side: Side; amount: bigint;
  dueDate: string | null; creditCount: number | null; creditUnit: CreditUnit | null;
};
/** A row ready to write. `name` is set for rows that find or make their bill by name; `auto` waits for the number. */
type PlannedRow = {
  lineNo: number | null; ledgerId: string; kind: BillKind; side: Side; amount: bigint;
  billId: string | null; name: string | null; auto: boolean;
  /** Terms entered (new reference, advance): a period, a fixed due date, or none (due on its own date). */
  period: CreditPeriod | null; kept: StoredBillRow | null;
  /** Opening rows only: the bill date. */
  billDate: string | null;
};
export type BillPlan = { rows: PlannedRow[]; warnings: BillWarning[] };

const warning = (code: BillWarning['code'], line: number | null, rest: Partial<BillWarning> = {}): BillWarning =>
  ({ code, line, billId: null, billName: null, amount: null, ...rest });

/** The rows' net towards `side` must lie between zero and `limit` (observed: the rows' sum is checked, not each row's side). */
export function assertBillRowsFit(rows: { side: Side; amount: bigint }[], side: Side, limit: bigint, exponent: LedgerContext['company']['exponent'], what: string): void {
  let net = 0n;
  for (const row of rows) net = addMoney(net, row.side === side ? row.amount : subtractMoney(0n, row.amount));
  if (net < 0n) throw ledgerError(400, `The bill rows of ${what} add up to its other side. Check their Dr and Cr.`, 'allocation_total');
  if (net > limit) throw ledgerError(400, `The bill rows of ${what} add up to ${formatMoney(net, exponent)}, more than its ${formatMoney(limit, exponent)}.`, 'allocation_total');
}

/** Rows given by bill id must name a bill of the line's own ledger. */
async function billsById(context: LedgerContext, ids: string[]): Promise<Map<string, { ledgerId: string; name: string }>> {
  if (!ids.length) return new Map();
  const { rows } = await context.client.query<{ id: string; ledgerId: string; name: string }>(
    'SELECT id, ledger_id AS "ledgerId", name FROM bill WHERE company_id = $1 AND id = ANY($2::uuid[])', [context.company.companyId, ids]);
  return new Map(rows.map(row => [row.id, row]));
}

/** Existing bills by (ledger, name ignoring case), for settlement rows that name their bill. */
async function billsByName(context: LedgerContext, keys: { ledgerId: string; name: string }[]): Promise<(string | null)[]> {
  if (!keys.length) return [];
  const { rows } = await context.client.query<{ ord: string; id: string | null }>(
    `SELECT t.ord, b.id FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS t(ledger_id, name, ord)
       LEFT JOIN bill b ON b.company_id = $1 AND b.ledger_id = t.ledger_id AND name_match_key(b.name) COLLATE "C" = name_match_key(t.name) COLLATE "C" ORDER BY t.ord`,
    [context.company.companyId, keys.map(key => key.ledgerId), keys.map(key => key.name)]);
  return rows.map(row => row.id);
}

/**
 * Applies the bill rules to a voucher's lines. Rows on a line whose ledger is not bill-wise are dropped (observed),
 * except that an alter keeps the rows such a line already had (`kept`, matched by line number and ledger). A line
 * without rows, and whatever its rows leave, is on account. Refusals: rows netting beyond the line, a settlement naming
 * no bill of the party, a bill of another ledger, and a new reference with no name to default to.
 */
export async function planBills(context: LedgerContext, voucher: { kind: VoucherKind; reference: string | null; optional: boolean },
  lines: BillLine[], kept: StoredBillRow[] = []): Promise<BillPlan> {
  const { exponent } = context.company;
  const rows: PlannedRow[] = [];
  const warnings: BillWarning[] = [];
  // Decided, awaiting observation: on alter, an unnamed new reference or advance stays on the bill its line already
  // created, whatever that bill's name and whatever the voucher's number is now (a date moved into another period gives
  // a new number). Lines match by number and ledger; reordered lines match by ledger when the voucher has exactly one
  // line and one stored creating row for it. A name the client sends, or a changed ledger, decides the bill instead.
  const creating = (kind: BillKind) => kind === 'new_ref' || kind === 'advance';
  const storedCreating = kept.filter(row => creating(row.kind) && row.billId !== null);
  for (const line of lines) {
    const sent = line.bills ?? [];
    if (!line.billWise) {
      const earlier = kept.filter(row => row.lineNo === line.lineNo && row.ledgerId === line.ledgerId);
      if (earlier.length) {
        assertBillRowsFit(earlier, line.side, line.amount, exponent, `line ${line.lineNo} (kept from before: its ledger is no longer bill-wise)`);
        rows.push(...earlier.map(row => ({ lineNo: line.lineNo, ledgerId: line.ledgerId, kind: row.kind, side: row.side, amount: row.amount,
          billId: row.billId, name: null, auto: false, period: null, kept: row, billDate: null })));
        warnings.push(warning('bills_kept', line.lineNo));
      } else if (sent.length) warnings.push(warning('bills_ignored', line.lineNo));
      continue;
    }
    const parsed = sent.map((row, index) => {
      const amount = parseAmount(row.amount, exponent, `The amount of bill row ${index + 1} on line ${line.lineNo}`);
      if (amount <= 0n) throw ledgerError(400, `The amount of bill row ${index + 1} on line ${line.lineNo} must be more than zero.`, 'validation');
      return { ...row, amount, side: row.side ?? line.side };
    });
    assertBillRowsFit(parsed, line.side, line.amount, exponent, `line ${line.lineNo}`);
    const own = storedCreating.filter(stored => stored.lineNo === line.lineNo && stored.ledgerId === line.ledgerId);
    const byLedger = storedCreating.filter(stored => stored.ledgerId === line.ledgerId);
    const reusable = own.length ? own : byLedger.length === 1 && lines.filter(other => other.ledgerId === line.ledgerId).length === 1 ? byLedger : [];
    for (const row of parsed) {
      let name = row.name ?? null;
      let billId = row.billId ?? null;
      let auto = false;
      if (creating(row.kind) && name === null && billId === null && reusable.length) billId = reusable.shift()!.billId;
      if (row.kind === 'new_ref' && name === null && billId === null) {
        // Observed defaults: a purchase's bill takes the supplier's invoice number, a sales bill the voucher number.
        if (voucher.kind === 'purchase' || voucher.kind === 'debit_note') {
          name = voucher.reference;
          if (name === null) throw ledgerError(400, `Enter the supplier's invoice number as the reference, or name the bill on line ${line.lineNo}.`, 'validation');
        } else if (voucher.optional) {
          throw ledgerError(400, `An optional voucher has no number to name its bill by. Name the bill on line ${line.lineNo}.`, 'validation');
        } else auto = true;
      }
      if (row.kind === 'advance' && name === null && billId === null) throw ledgerError(400, `Name the advance on line ${line.lineNo}.`, 'validation');
      const period = row.kind === 'new_ref' || row.kind === 'advance' ? row.creditPeriod ?? line.credit : null;
      rows.push({ lineNo: line.lineNo, ledgerId: line.ledgerId, kind: row.kind, side: row.side, amount: row.amount,
        billId, name, auto, period, kept: null, billDate: null });
    }
  }
  await resolveBills(context, rows);
  return { rows, warnings };
}

/** Checks rows given by bill id and finds the bills settlement rows name; creating rows are resolved when written. */
async function resolveBills(context: LedgerContext, rows: PlannedRow[]): Promise<void> {
  const byId = await billsById(context, [...new Set(rows.flatMap(row => row.billId && !row.kept ? [row.billId] : []))]);
  for (const row of rows) {
    if (!row.billId || row.kept) continue;
    const bill = byId.get(row.billId);
    if (!bill) throw ledgerError(400, `The bill on ${where(row)} was not found.`, 'not_found');
    if (bill.ledgerId !== row.ledgerId) throw ledgerError(400, `The bill on ${where(row)} belongs to another ledger.`, 'posting_rule');
  }
  const settling = rows.filter(row => row.kind === 'against_ref' && row.billId === null);
  const found = await billsByName(context, settling.map(row => ({ ledgerId: row.ledgerId, name: row.name! })));
  settling.forEach((row, index) => {
    if (!found[index]) throw ledgerError(400, `No bill named "${row.name}" is pending for this ledger (${where(row)}).`, 'not_found');
    row.billId = found[index];
  });
  // A settlement names a bill that still has a live row (the entry screen offers pending bills only): one whose
  // vouchers were all deleted or cancelled cannot be settled, so its terms never depend on the order of events.
  const settled = [...new Set(rows.flatMap(row => row.kind === 'against_ref' && !row.kept ? [row.billId!] : []))];
  if (settled.length) {
    const { rows: live } = await context.client.query<{ billId: string }>(
      `SELECT DISTINCT r.bill_id AS "billId" FROM (${liveBillRowsSql('a.bill_id = ANY($2::uuid[])')}) r`, [context.company.companyId, settled]);
    const alive = new Set(live.map(row => row.billId));
    const dead = rows.find(row => row.kind === 'against_ref' && !row.kept && !alive.has(row.billId!));
    if (dead) throw ledgerError(409, `The bill on ${where(dead)} has no entries left: its vouchers were deleted or cancelled. Enter a new reference with its name instead.`, 'bill_inactive');
  }
}
const where = (row: PlannedRow) => row.lineNo === null ? 'the opening balance' : `line ${row.lineNo}`;

/**
 * Plans a ledger's opening bill rows (replacing the ones it had): new bills on the opening side, dated on or before the
 * books begin (default the day before), together at most the opening amount (the rest is on account).
 */
export async function planOpeningBills(context: LedgerContext, ledger: { id: string; billWise: boolean; credit: CreditPeriod | null },
  opening: { amount: bigint; side: Side }, bills: OpeningBillInput[]): Promise<PlannedRow[]> {
  const { exponent, booksBeginning } = context.company;
  if (bills.length && !ledger.billWise) throw ledgerError(400, 'Opening bills need a bill-wise ledger. Turn bill-wise on first.', 'validation');
  // Observed: opening bills are new bills on the opening balance's side; the rest of the balance stays on account.
  const dayBefore = new Date(Date.parse(`${booksBeginning}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const rows = bills.map((row, index): PlannedRow => {
    const amount = parseAmount(row.amount, exponent, `The amount of opening bill ${index + 1}`);
    if (amount <= 0n) throw ledgerError(400, `The amount of opening bill ${index + 1} must be more than zero.`, 'validation');
    const billDate = row.billDate ?? dayBefore;
    if (billDate > booksBeginning) throw ledgerError(400, `Opening bill ${index + 1} is dated after the books begin on ${booksBeginning}.`, 'validation');
    return { lineNo: null, ledgerId: ledger.id, kind: 'new_ref', side: opening.side, amount, billId: null,
      name: row.name, auto: false, period: row.creditPeriod ?? ledger.credit, kept: null, billDate };
  });
  assertBillRowsFit(rows, opening.side, opening.amount, exponent, 'the opening balance');
  await resolveBills(context, rows);
  return rows;
}

/**
 * Writes planned rows: creating rows find their bill by name or make it, settlement rows copy their bill's terms. New
 * bills are inserted in (ledger, name) order with ON CONFLICT DO NOTHING and read back in a new statement, so two
 * postings creating the same name for one party end with one bill (the second waits for the first to commit, then
 * finds its row) and two postings creating two names never wait on each other in a cycle.
 */
export async function writeBills(context: LedgerContext, voucher: { id: string; date: string } | null, rows: PlannedRow[], number: number | null = null): Promise<void> {
  if (!rows.length) return;
  const { client, company } = context;
  for (const row of rows) if (row.auto) row.name = String(number);
  const creating = rows.filter(row => row.billId === null && row.name !== null);
  if (creating.length) {
    const ledgers = creating.map(row => row.ledgerId), names = creating.map(row => row.name!);
    await client.query(
      `INSERT INTO bill (company_id, ledger_id, name, currency)
       SELECT $1, d.ledger_id, d.name, $4 FROM (
         SELECT DISTINCT ON (t.ledger_id, name_match_key(t.name)) t.ledger_id, t.name FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS t(ledger_id, name, ord)
         ORDER BY t.ledger_id, name_match_key(t.name), t.ord) d
       ORDER BY d.ledger_id, name_match_key(d.name) COLLATE "C"
       ON CONFLICT (company_id, ledger_id, (name_match_key(name)) COLLATE "C") DO NOTHING`, [company.companyId, ledgers, names, company.baseCurrency]);
    const found = await billsByName(context, creating.map(row => ({ ledgerId: row.ledgerId, name: row.name! })));
    creating.forEach((row, index) => { row.billId = found[index]; });
  }
  // Settlement rows copy, when posted, the terms of the row that dates their bill (the reference copies them), and keep
  // them: a settlement that later dates the bill, after its invoice is cancelled or renamed, still has a due date.
  const settlingIds = [...new Set(rows.flatMap(row => row.kind === 'against_ref' && !row.kept ? [row.billId!] : []))];
  const terms = new Map<string, { dueDate: string | null; creditCount: number | null; creditUnit: CreditUnit | null }>();
  if (settlingIds.length) {
    const { rows: found } = await client.query<{ billId: string; dueDate: string | null; creditCount: number | null; creditUnit: CreditUnit | null }>(
      `SELECT DISTINCT ON (r.bill_id) r.bill_id AS "billId", r.due_date AS "dueDate", r.credit_count AS "creditCount", r.credit_unit AS "creditUnit"
       FROM (${liveBillRowsSql('a.bill_id = ANY($2::uuid[])')}) r
       ORDER BY r.bill_id, ${creatorOrderSql}`, [company.companyId, settlingIds]);
    for (const row of found) terms.set(row.billId, row);
  }
  const values = rows.map(row => {
    const baseDate = row.billDate ?? voucher!.date;
    if (row.kept) {
      const { creditCount, creditUnit, dueDate } = row.kept;
      return { count: creditCount, unit: creditUnit, due: creditCount !== null && (row.kind === 'new_ref' || row.kind === 'advance') ? null : dueDate, baseDate };
    }
    if (row.kind === 'new_ref' || row.kind === 'advance') {
      const period = row.period;
      if (period && 'count' in period) return { count: period.count, unit: period.unit, due: null, baseDate };
      return { count: null, unit: null, due: period && 'dueDate' in period ? period.dueDate : baseDate, baseDate };
    }
    if (row.kind === 'against_ref') {
      const copied = terms.get(row.billId!);
      return { count: copied?.creditCount ?? null, unit: copied?.creditUnit ?? null, due: copied?.dueDate ?? null, baseDate };
    }
    return { count: null, unit: null, due: null, baseDate };
  });
  await client.query(
    `INSERT INTO bill_allocation (company_id, ledger_id, voucher_id, line_no, kind, bill_id, currency, side, amount, currency_amount, bill_date, due_date, credit_count, credit_unit)
     SELECT $1, t.ledger_id, $2, t.line_no, t.kind, t.bill_id, $3, t.side, t.amount, t.amount, t.bill_date,
       CASE WHEN t.credit_count IS NOT NULL AND t.kind IN ('new_ref', 'advance') THEN bill_due_date(t.base_date, t.credit_count, t.credit_unit) ELSE t.due_date END,
       t.credit_count, t.credit_unit
     FROM unnest($4::uuid[], $5::smallint[], $6::text[], $7::uuid[], $8::text[], $9::bigint[], $10::date[], $11::date[], $12::integer[], $13::text[], $14::date[])
       WITH ORDINALITY AS t(ledger_id, line_no, kind, bill_id, side, amount, bill_date, due_date, credit_count, credit_unit, base_date, ord)
     ORDER BY t.ord`,
    [company.companyId, voucher?.id ?? null, company.baseCurrency, rows.map(row => row.ledgerId), rows.map(row => row.lineNo), rows.map(row => row.kind),
      rows.map(row => row.billId), rows.map(row => row.side), rows.map(row => row.amount), rows.map(row => row.billDate),
      values.map(value => value.due), values.map(value => value.count), values.map(value => value.unit), values.map(value => value.baseDate)]);
}

/** Bills that `voucherId` dates (`creatorOrderSql`) while other vouchers (or the opening) hold live rows too. */
export async function billsCreatedBy(context: LedgerContext, voucherId: string): Promise<Set<string>> {
  const { rows } = await context.client.query<{ billId: string }>(
    `WITH live AS (${liveBillRowsSql('a.bill_id IN (SELECT bill_id FROM bill_allocation WHERE company_id = $1 AND voucher_id = $2 AND bill_id IS NOT NULL)')}),
     ranked AS (SELECT bill_id, voucher_id, row_number() OVER (PARTITION BY bill_id ORDER BY ${creatorOrderSql}) AS rank FROM live)
     SELECT bill_id AS "billId" FROM ranked GROUP BY bill_id
     HAVING bool_or(rank = 1 AND voucher_id = $2) AND bool_or(voucher_id IS DISTINCT FROM $2)`,
    [context.company.companyId, voucherId]);
  return new Set(rows.map(row => row.billId));
}

/**
 * The warnings a posting earns once its rows are written: `bill_split` for bills it created that other vouchers still
 * hold rows on but it no longer does (an alter that renamed or moved its reference, a cancel or a delete), and, for a
 * regular voucher, `bill_attached` (a new reference or advance joining a bill with other live rows) and
 * `bill_over_settled` (its rows take a bill past zero to the other side), plus `bill_both_sides` from the plan. Bills the
 * voucher already held rows on before an alter (`heldBefore`) are not reported as joined.
 */
export async function billWarnings(context: LedgerContext, voucherId: string, plan: PlannedRow[], createdBefore: Set<string> = new Set(), heldBefore: Set<string> = new Set()): Promise<BillWarning[]> {
  const { client, company } = context;
  const warnings: BillWarning[] = [];
  const { rows: live } = await client.query<{ live: boolean }>(`SELECT status = 'regular' AND deleted_at IS NULL AS live FROM voucher WHERE company_id = $1 AND id = $2`, [company.companyId, voucherId]);
  const own = live[0]?.live ? plan.filter(row => row.billId !== null) : [];
  const billIds = [...new Set([...own.map(row => row.billId!), ...createdBefore])];
  if (!billIds.length) return warnings;
  const { rows } = await client.query<{ billId: string; name: string; mine: bigint; others: bigint; othersLive: boolean; mineLive: boolean }>(
    `WITH live AS (${liveBillRowsSql('a.bill_id = ANY($3::uuid[])')})
     SELECT b.id AS "billId", b.name,
       coalesce(sum(${signedSql('l')}) FILTER (WHERE l.voucher_id = $2), 0)::bigint AS mine,
       coalesce(sum(${signedSql('l')}) FILTER (WHERE l.voucher_id IS DISTINCT FROM $2), 0)::bigint AS others,
       coalesce(bool_or(l.voucher_id IS DISTINCT FROM $2), false) AS "othersLive", coalesce(bool_or(l.voucher_id = $2), false) AS "mineLive"
     FROM bill b LEFT JOIN live l ON l.bill_id = b.id WHERE b.company_id = $1 AND b.id = ANY($3::uuid[]) GROUP BY b.id, b.name`,
    [company.companyId, voucherId, billIds]);
  const byId = new Map(rows.map(row => [row.billId, row]));
  for (const billId of createdBefore) {
    const bill = byId.get(billId);
    if (bill && bill.othersLive && !bill.mineLive) warnings.push(warning('bill_split', null, { billId, billName: bill.name }));
  }
  const seen = new Set<string>();
  for (const row of own) {
    const bill = byId.get(row.billId!)!;
    // An alter re-sending the rows of a bill it already held is not joining it.
    if ((row.kind === 'new_ref' || row.kind === 'advance') && bill.othersLive && !heldBefore.has(bill.billId) && !seen.has(`attached:${bill.billId}`)) {
      seen.add(`attached:${bill.billId}`);
      warnings.push(warning('bill_attached', row.lineNo, { billId: bill.billId, billName: bill.name }));
    }
    const { mine, others } = bill;
    // Only settlements over-settle: an invoice and its earlier receipt are opposite by nature.
    if (row.kind === 'against_ref' && others !== 0n && (mine > 0n) !== (others > 0n) && mine !== 0n && (mine < 0n ? -mine : mine) > (others < 0n ? -others : others) && !seen.has(`over:${bill.billId}`)) {
      seen.add(`over:${bill.billId}`);
      const excess = addMoney(mine, others);
      warnings.push(warning('bill_over_settled', row.lineNo, { billId: bill.billId, billName: bill.name, amount: excess < 0n ? subtractMoney(0n, excess) : excess }));
    }
  }
  const sides = new Map<string, Set<Side>>();
  for (const row of plan) {
    if (row.billId === null || row.lineNo === null) continue;
    const key = `${row.lineNo}:${row.billId}`;
    const set = sides.get(key) ?? new Set<Side>();
    set.add(row.side);
    sides.set(key, set);
    if (set.size === 2 && !seen.has(`both:${key}`)) {
      seen.add(`both:${key}`);
      warnings.push(warning('bill_both_sides', row.lineNo, { billId: row.billId, billName: byId.get(row.billId)?.name ?? null }));
    }
  }
  return warnings;
}

/** The rows a voucher holds now, by line, to keep through an alter on lines whose ledger is no longer bill-wise. */
export async function storedBillRows(context: LedgerContext, voucherId: string): Promise<StoredBillRow[]> {
  const { rows } = await context.client.query<StoredBillRow>(
    `SELECT line_no AS "lineNo", ledger_id AS "ledgerId", kind, bill_id AS "billId", side, amount, due_date AS "dueDate",
       credit_count AS "creditCount", credit_unit AS "creditUnit"
     FROM bill_allocation WHERE company_id = $1 AND voucher_id = $2 ORDER BY line_no, id`, [context.company.companyId, voucherId]);
  return rows;
}
