import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import pg from 'pg';
import type { TestDatabase } from './database.ts';
import { asAdmin, chart, createCompany, setupOwner } from './ledger.ts';

/**
 * The measured layout of migration 0014: two companies of 100,000 vouchers each beside each other, with every table the
 * posting path and the guards look rows up in filled to a size where reading a company's rows instead of one shows
 * (2,000 ledgers, 200,000 voucher lines, 20,000 bills with their rows, 20,000 cost rows, 2,000 items, 50 units, 50
 * locations and 50 more voucher types per company), and a busy item with 3,000 lines at each of two locations in twelve
 * regular stock journals posted through the API. `busy`: the filler vouchers are regular and no other item has lines (the
 * busy item is half of inventory_line); otherwise they are optional and 40 other items have 20,000 lines.
 * The filler rows are written by admin SQL with the guards off (session_replication_role): they are rows to look past,
 * not postings. Autovacuum is off on every table, so statistics come only from the measurement itself.
 */
export type Layout = { companyA: string; companyB: string };

const filled = ['voucher', 'voucher_line', 'inventory_line', 'bill', 'bill_allocation', 'cost_allocation', 'cost_category', 'cost_centre',
  'ledger', 'stock_item', 'stock_unit', 'stock_location', 'stock_opening', 'voucher_type', 'account_group'];

export async function buildLayout(database: TestDatabase, busy: boolean): Promise<Layout> {
  await asAdmin(database.adminUrl, admin => admin.query(filled.map(table => `ALTER TABLE ${table} SET (autovacuum_enabled = false)`).join('; ')));
  const owner = await setupOwner();
  const companies: string[] = [];
  for (const label of ['A', 'B']) {
    const company = await createCompany(owner.browser, { name: `Layout ${label}` });
    companies.push(company);
    const accounts = await chart(owner.browser, company);
    const call = async (path: string, body?: unknown) => {
      const answer = await owner.browser.call(`/api/companies/${company}${path}`, body);
      assert.ok(answer.status < 300, `${path}: ${answer.status} ${JSON.stringify(answer.body)}`);
      return answer.body;
    };
    const nos = (await call('/stock-units', { symbol: 'Nos' })).stockUnit.id;
    const main = ((await call('/stock-locations')).stockLocations as { id: string; systemKey: string | null }[]).find(row => row.systemKey === 'main')!.id;
    const yard = (await call('/stock-locations', { name: 'Yard' })).stockLocation.id;
    const item = (await call('/stock-items', { name: 'Busy', unitId: nos, openings: [{ locationId: main, quantity: '1', rate: '1.00' }, { locationId: yard, quantity: '1', rate: '1.00' }] })).stockItem.id;
    for (const location of [main, yard]) for (let n = 0; n < 6; n++) {
      await call('/vouchers', { idempotencyKey: `layout-${label}-${location}-${n}`, voucherTypeId: accounts.type('stock_journal'), date: '2026-06-01', lines: [],
        inventory: Array.from({ length: 500 }, () => ({ itemId: item, locationId: location, quantity: '1', rate: '1.00', direction: 'in' })) });
    }
    await asAdmin(database.adminUrl, async admin => {
      await admin.query('BEGIN');
      await admin.query("SELECT set_config('app.company_ids', $1, true)", [company]);
      await admin.query('SET LOCAL session_replication_role = replica');
      const type = (kind: string) => admin.query('SELECT id, numbering_series FROM voucher_type WHERE id = $1', [accounts.type(kind)]).then(result => result.rows[0]);
      const [journal, stockJournal] = [await type('journal'), await type('stock_journal')];
      await admin.query(`INSERT INTO voucher (company_id, voucher_type_id, series, date, status, number, number_period, idempotency_key, request_hash, created_by)
        SELECT $1, CASE WHEN n <= 40 THEN $2::uuid ELSE $3::uuid END, CASE WHEN n <= 40 THEN $4::text ELSE $5::text END, date '2026-01-01' + (n % 365),
          CASE WHEN n > 40 AND $6 THEN 'regular' ELSE 'optional' END, CASE WHEN n > 40 AND $6 THEN n END, CASE WHEN n > 40 AND $6 THEN date '2026-01-01' END,
          'filler-' || n, $7, $8 FROM generate_series(1, 100000) n`,
        [company, stockJournal.id, journal.id, stockJournal.numbering_series, journal.numbering_series, busy, 'a'.repeat(64), owner.userId]);
      if (!busy) {
        await admin.query(`INSERT INTO stock_item (company_id, name, unit_id) SELECT $1, 'Other ' || n, $2 FROM generate_series(1, 40) n`, [company, nos]);
        await admin.query(`INSERT INTO inventory_line (company_id, voucher_id, entry_no, item_id, location_id, direction, quantity, rate, amount)
          SELECT $1, v.id, n, i.id, $2, 'in', 1, 1, 100 FROM voucher v JOIN stock_item i ON i.company_id = v.company_id AND i.name = 'Other ' || substr(v.idempotency_key, 8)
            CROSS JOIN generate_series(1, 500) n WHERE v.company_id = $1 AND v.idempotency_key = ANY(ARRAY(SELECT 'filler-' || g FROM generate_series(1, 40) g))`, [company, yard]);
      }
      const group = (await admin.query("SELECT id FROM account_group WHERE company_id = $1 AND system_key = 'indirect_expenses'", [company])).rows[0].id;
      const currency = (await admin.query('SELECT base_currency FROM company WHERE company_id = $1', [company])).rows[0].base_currency;
      await admin.query(`INSERT INTO ledger (company_id, group_id, name, currency) SELECT $1, $2, 'Fill ledger ' || n, $3 FROM generate_series(1, 2000) n`, [company, group, currency]);
      await admin.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
        SELECT f.company_id, f.id, s.line_no, l.id, s.side, 100, $2, 100, 1
        FROM (SELECT company_id, id, substr(idempotency_key, 8)::int AS n FROM voucher WHERE company_id = $1 AND idempotency_key LIKE 'filler-%') f
        CROSS JOIN (VALUES (1::smallint, 'Dr'), (2::smallint, 'Cr')) s(line_no, side)
        JOIN (SELECT id, row_number() OVER (ORDER BY id) AS n FROM ledger WHERE company_id = $1 AND name LIKE 'Fill ledger %') l ON l.n = 1 + (f.n + s.line_no) % 2000`, [company, currency]);
      await admin.query(`INSERT INTO bill (company_id, ledger_id, name, currency) SELECT company_id, id, 'Bill ' || g, $2 FROM ledger CROSS JOIN generate_series(1, 10) g
        WHERE company_id = $1 AND name LIKE 'Fill ledger %'`, [company, currency]);
      await admin.query(`INSERT INTO bill_allocation (company_id, ledger_id, voucher_id, line_no, kind, bill_id, currency, side, amount, currency_amount, due_date)
        SELECT b.company_id, b.ledger_id, v.id, 1, 'new_ref', b.id, b.currency, 'Dr', 100, 100, date '2026-02-01'
        FROM (SELECT *, row_number() OVER (ORDER BY id) AS n FROM bill WHERE company_id = $1) b JOIN voucher v ON v.company_id = b.company_id AND v.idempotency_key = 'filler-' || (40 + b.n)`, [company]);
      const category = (await admin.query("INSERT INTO cost_category (company_id, name) VALUES ($1, 'Fill category') RETURNING id", [company])).rows[0].id;
      await admin.query(`INSERT INTO cost_centre (company_id, category_id, name) SELECT $1, $2, 'Fill centre ' || n FROM generate_series(1, 200) n`, [company, category]);
      await admin.query(`INSERT INTO cost_allocation (company_id, voucher_id, line_no, ledger_id, category_id, cost_centre_id, side, amount)
        SELECT l.company_id, l.voucher_id, 1, l.ledger_id, c.category_id, c.id, 'Dr', 100
        FROM (SELECT v.company_id, v.id, substr(v.idempotency_key, 8)::int AS n FROM voucher v WHERE v.company_id = $1 AND v.idempotency_key LIKE 'filler-%') f
        JOIN voucher_line l ON l.company_id = f.company_id AND l.voucher_id = f.id AND l.line_no = 1
        JOIN (SELECT *, row_number() OVER (ORDER BY id) AS n FROM cost_centre WHERE company_id = $1 AND name LIKE 'Fill centre %') c ON c.n = 1 + f.n % 200
        WHERE f.n BETWEEN 20041 AND 40040`, [company]);
      await admin.query(`INSERT INTO stock_unit (company_id, symbol) SELECT $1, 'U' || n FROM generate_series(1, 50) n`, [company]);
      await admin.query(`INSERT INTO stock_location (company_id, name) SELECT $1, 'Place ' || n FROM generate_series(1, 50) n`, [company]);
      // Company B holds twice company A's items, so a cost that grew with the company's items would show.
      await admin.query(`INSERT INTO stock_item (company_id, unit_id, name) SELECT $1, (SELECT id FROM stock_unit WHERE company_id = $1 AND symbol = 'U1'), 'Thing ' || n FROM generate_series(1, $2::int) n`,
        [company, label === 'A' ? 2000 : 4000]);
      await admin.query(`INSERT INTO voucher_type (company_id, kind, name, numbering_series) SELECT $1, 'journal', 'Journal ' || n, 'j' || n FROM generate_series(1, 50) n`, [company]);
      await admin.query('COMMIT');
    });
  }
  return { companyA: companies[0], companyB: companies[1] };
}

/** The planner states measured: without statistics and analysed, each with custom and with generic plans. */
export const plannerStates = [
  { label: 'no statistics', analysed: false, generic: false }, { label: 'no statistics, generic plan', analysed: false, generic: true },
  { label: 'analysed', analysed: true, generic: false }, { label: 'analysed, generic plan', analysed: true, generic: true },
] as const;

/**
 * Clears every public table's statistics (PG18), or vacuums and analyses them all. The vacuum sets the visibility map,
 * so the planner's own index-endpoint probes, which it makes while costing a join once statistics exist, no longer visit
 * heap rows and are not counted as the statement's fetches (proveLookups measures them separately, unvacuumed).
 */
export async function setStatistics(database: TestDatabase, analysed: boolean): Promise<void> {
  await asAdmin(database.adminUrl, async admin => {
    if (analysed) { await admin.query('VACUUM ANALYZE'); return; }
    await admin.query(`SELECT count(pg_clear_relation_stats('public', c.relname)) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`);
    await admin.query(`SELECT count(pg_clear_attribute_stats('public', c.relname, a.attname, false)) FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`);
    const left = await admin.query(`SELECT count(*)::int AS sized FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND reltuples >= 0`);
    assert.equal(left.rows[0].sized, 0, 'no table keeps statistics');
  });
}

export type Fetched = Record<string, { fetched: number; sequential: number }>;
/** One statement's reads per table, as the application role in company `company`'s scope, by the transaction's counters. */
export async function measure(company: string, generic: boolean, sql: string, params: unknown[]): Promise<Fetched> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.company_ids', $1, true)", [company]);
    if (generic) await client.query('SET LOCAL plan_cache_mode = force_generic_plan');
    const counters = async () => new Map((await client.query<{ relname: string; seq: string; fetch: string }>(
      'SELECT relname, seq_tup_read AS seq, coalesce(idx_tup_fetch, 0) AS fetch FROM pg_stat_xact_user_tables')).rows.map(row => [row.relname, row]));
    const before = await counters();
    await client.query(sql, params);
    const after = await counters();
    const result: Fetched = {};
    for (const [table, row] of after) {
      const was = before.get(table);
      const fetched = Number(row.fetch) - Number(was?.fetch ?? 0), sequential = Number(row.seq) - Number(was?.seq ?? 0);
      if (fetched || sequential) result[table] = { fetched, sequential };
    }
    await client.query('ROLLBACK');
    return result;
  } finally { await client.end(); }
}

export const describe = (fetched: Fetched) => Object.entries(fetched).map(([table, row]) => `${table} ${row.fetched}${row.sequential ? `+${row.sequential} sequential` : ''}`).join(', ') || 'nothing';
export const note = (t: TestContext, state: string, name: string, fetched: Fetched) => t.diagnostic(`${state} | ${name} | ${describe(fetched)}`);

/**
 * A lookup of the posting path or of a guard (0004 to 0013), and the most rows it may fetch from each table. `customOnly`:
 * the bound is asserted with custom plans only (what runs today: the application's statements are unnamed); under a
 * generic plan it is an open item (docs/LEDGER.md), recorded, not asserted.
 */
type Case = { name: string; sql: string; params: unknown[]; bound: Record<string, number>; customOnly?: boolean };

/** The cases on company `company` of the layout, with rows of its own to look up. */
export async function lookupCases(database: TestDatabase, company: string): Promise<{ cases: Case[]; open: Omit<Case, 'bound'>[] }> {
  const rows = await asAdmin(database.adminUrl, async admin => {
    await admin.query('BEGIN');
    await admin.query("SELECT set_config('app.company_ids', $1, true)", [company]);
    const one = async (sql: string) => (await admin.query(sql)).rows[0];
    const found = {
      billed: await one("SELECT v.id, a.bill_id, a.ledger_id FROM voucher v JOIN bill_allocation a ON a.company_id = v.company_id AND a.voucher_id = v.id WHERE v.idempotency_key = 'filler-41'"),
      costed: await one("SELECT v.id, c.cost_centre_id FROM voucher v JOIN cost_allocation c ON c.company_id = v.company_id AND c.voucher_id = v.id WHERE v.idempotency_key = 'filler-20041'"),
      item: await one("SELECT id, unit_id FROM stock_item WHERE name = 'Thing 1'"),
      place: await one("SELECT id FROM stock_location WHERE name = 'Place 1'"),
      type: await one("SELECT id FROM voucher_type WHERE name = 'Journal 1'"),
    };
    await admin.query('ROLLBACK');
    return found;
  });
  const v = rows.billed.id, ledger = rows.billed.ledger_id, A = company;
  const cases: Case[] = [
    { name: 'voucher by company and id', sql: 'SELECT date FROM voucher WHERE company_id = $1 AND id = $2', params: [A, v], bound: { voucher: 1 } },
    { name: 'voucher by company and id with a date', sql: 'SELECT date FROM voucher WHERE company_id = $1 AND id = $2 AND date <= $3', params: [A, v, '2026-12-31'], bound: { voucher: 1 } },
    { name: 'voucher FOR UPDATE (alter, cancel, delete)', sql: 'SELECT revision FROM voucher WHERE company_id = $1 AND id = $2 FOR UPDATE', params: [A, v], bound: { voucher: 1 } },
    { name: 'voucher frozen check (line, bill, cost and item-row guards)', sql: "SELECT EXISTS (SELECT 1 FROM voucher v WHERE v.company_id = $1 AND v.id = $2 AND (v.status = 'cancelled' OR v.deleted_at IS NOT NULL))", params: [A, v], bound: { voucher: 1 } },
    { name: 'voucher and its kind FOR NO KEY UPDATE (0013)', sql: 'SELECT t.kind FROM voucher v JOIN voucher_type t ON t.company_id = v.company_id AND t.id = v.voucher_type_id WHERE v.company_id = $1 AND v.id = $2 FOR NO KEY UPDATE OF v', params: [A, v], bound: { voucher: 1, voucher_type: 5 } },
    { name: 'voucher by idempotency key (replay)', sql: 'SELECT id FROM voucher WHERE company_id = $1 AND idempotency_key = $2', params: [A, 'filler-41'], bound: { voucher: 1 } },
    { name: 'voucher_line by voucher (balance check, read)', sql: 'SELECT sum(amount) FROM voucher_line WHERE company_id = $1 AND voucher_id = $2', params: [A, v], bound: { voucher_line: 2 } },
    { name: 'voucher_line by voucher and line (bill, cost and item-row guards)', sql: 'SELECT ledger_id FROM voucher_line WHERE company_id = $1 AND voucher_id = $2 AND line_no = $3', params: [A, v, 1], bound: { voucher_line: 1 } },
    { name: 'voucher_line with its ledger (voucher read)', sql: 'SELECT count(*) FROM voucher_line l JOIN ledger led ON led.company_id = l.company_id AND led.id = l.ledger_id WHERE l.company_id = $1 AND l.voucher_id = $2', params: [A, v], bound: { voucher_line: 2, ledger: 4 } },
    { name: 'bill rows by company, voucher and line (0006)', sql: 'SELECT count(*) FROM bill_allocation WHERE company_id = $1 AND voucher_id = $2 AND line_no = $3', params: [A, v, 1], bound: { bill_allocation: 1 } },
    { name: 'bill rows by voucher and line (0009)', sql: 'SELECT count(*) FROM bill_allocation WHERE voucher_id = $1 AND line_no = $2', params: [v, 1], bound: { bill_allocation: 1 } },
    { name: 'bill rows by bill (0009)', sql: 'SELECT count(*) FROM bill_allocation WHERE bill_id = $1', params: [rows.billed.bill_id], bound: { bill_allocation: 1 } },
    { name: 'cost rows by voucher (read)', sql: 'SELECT count(*) FROM cost_allocation WHERE company_id = $1 AND voucher_id = $2', params: [A, rows.costed.id], bound: { cost_allocation: 1 } },
    { name: 'cost rows by voucher and line (0008)', sql: 'SELECT count(*) FROM cost_allocation WHERE company_id = $1 AND voucher_id = $2 AND line_no = $3', params: [A, rows.costed.id, 1], bound: { cost_allocation: 1 } },
    { name: 'ledger by company and id (bill and cost guards, per row)', sql: 'SELECT bill_wise FROM ledger WHERE company_id = $1 AND id = $2', params: [A, ledger], bound: { ledger: 1 } },
    { name: 'stock_item by company and id FOR SHARE (item-row guard, per row)', sql: 'SELECT unit_id FROM stock_item WHERE company_id = $1 AND id = $2 FOR SHARE', params: [A, rows.item.id], bound: { stock_item: 1 } },
    { name: 'stock_unit by company and id FOR SHARE (item-row guard, per row)', sql: 'SELECT decimals FROM stock_unit WHERE company_id = $1 AND id = $2 FOR SHARE', params: [A, rows.item.unit_id], bound: { stock_unit: 1 } },
    { name: 'stock_item with its unit (stock read)', sql: 'SELECT u.decimals FROM stock_item i JOIN stock_unit u ON u.company_id = i.company_id AND u.id = i.unit_id WHERE i.company_id = $1 AND i.id = $2', params: [A, rows.item.id], bound: { stock_item: 1, stock_unit: 4 } },
    { name: 'stock_location by company and id (stock read)', sql: 'SELECT EXISTS (SELECT 1 FROM stock_location sl WHERE sl.company_id = $1 AND sl.id = $2)', params: [A, rows.place.id], bound: { stock_location: 2 } },
    { name: 'voucher_type by company and id (kind, numbering)', sql: 'SELECT kind FROM voucher_type WHERE company_id = $1 AND id = $2', params: [A, rows.type.id], bound: { voucher_type: 1 } },
    { name: 'stock_location by ids FOR KEY SHARE (posting)', sql: 'SELECT id FROM stock_location WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR KEY SHARE', params: [A, [rows.place.id]], bound: { stock_location: 1 } },
    { name: 'ledger by ids FOR KEY SHARE (posting)', sql: 'SELECT id FROM ledger WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR KEY SHARE', params: [A, [ledger]], bound: { ledger: 1 }, customOnly: true },
    { name: 'stock_item by ids FOR SHARE (posting)', sql: 'SELECT id FROM stock_item WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR SHARE', params: [A, [rows.item.id]], bound: { stock_item: 1 }, customOnly: true },
    { name: 'bill by company and ids (bill rows)', sql: 'SELECT name FROM bill WHERE company_id = $1 AND id = ANY($2::uuid[])', params: [A, [rows.billed.bill_id]], bound: { bill: 1 }, customOnly: true },
  ];
  // Open items (docs/LEDGER.md): they read the company's rows without statistics, once per voucher, not per row.
  const open = [
    { name: 'bill rows by company and voucher (bills.ts read)', sql: 'SELECT count(*) FROM bill_allocation WHERE company_id = $1 AND voucher_id = $2', params: [A, v] },
    { name: 'cost_centre by ids FOR KEY SHARE (posting)', sql: 'SELECT id FROM cost_centre WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR KEY SHARE', params: [A, [rows.costed.cost_centre_id]] },
  ];
  return { cases, open };
}

/** A table a lookup may read whole once analysed: small enough that the planner rightly prefers it to an index. */
const small = 1000;

/** Every case in every planner state: within its bound, and never a sequential read of a table of `small` rows or more. */
export async function proveLookups(t: TestContext, database: TestDatabase, layout: Layout): Promise<void> {
  const { cases, open } = await lookupCases(database, layout.companyA);
  const sizes = new Map((await asAdmin(database.adminUrl, admin => admin.query<{ relname: string; live: string }>(
    'SELECT relname, n_live_tup AS live FROM pg_stat_user_tables'))).rows.map(row => [row.relname, Number(row.live)]));
  const failures: string[] = [];
  // Analysed but never vacuumed (a bulk load, then ANALYZE): the planner's endpoint probes while costing the item's join
  // to its unit visit heap rows on pages not marked all-visible and count as fetches (4 measured: execution reads 1).
  // They are a constant: the same in company A and in company B, which holds twice A's items.
  await asAdmin(database.adminUrl, admin => admin.query('ANALYZE'));
  const unvacuumed = [];
  for (const company of [layout.companyA, layout.companyB]) {
    const item = (await lookupCases(database, company)).cases.find(lookup => lookup.name.startsWith('stock_item with its unit'))!;
    const fetched = await measure(company, false, item.sql, item.params);
    note(t, `analysed, not vacuumed, company ${company === layout.companyA ? 'A' : 'B'}`, item.name, fetched);
    unvacuumed.push(fetched.stock_item?.fetched ?? 0);
  }
  assert.equal(unvacuumed[0], unvacuumed[1], 'the planning-time fetches do not grow with the company\'s items');
  assert.ok(unvacuumed[0] <= 10, `a few planning-time probes, not the company's items: ${unvacuumed[0]}`);
  for (const state of plannerStates) {
    await setStatistics(database, state.analysed);
    for (const lookup of cases) {
      const fetched = await measure(layout.companyA, state.generic, lookup.sql, lookup.params);
      note(t, state.label, lookup.name, fetched);
      if (lookup.customOnly && state.generic) continue;
      for (const [table, row] of Object.entries(fetched)) {
        if (row.fetched > (lookup.bound[table] ?? 0)) failures.push(`${state.label}, ${lookup.name}: ${table} ${row.fetched} fetched, bound ${lookup.bound[table] ?? 0}`);
        if (row.sequential && !(state.analysed && (sizes.get(table) ?? 0) < small)) failures.push(`${state.label}, ${lookup.name}: ${table} read sequentially (${row.sequential} rows)`);
      }
    }
    for (const lookup of open) note(t, `${state.label} (open item)`, lookup.name, await measure(layout.companyA, state.generic, lookup.sql, lookup.params));
  }
  assert.deepEqual(failures, []);
}
