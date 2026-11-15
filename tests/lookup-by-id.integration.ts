import { after, before, test } from 'node:test';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { buildLayout, proveLookups, proveVoucherRead, type Layout } from './helpers/lookup-layout.ts';

/**
 * Migration 0014 measured: every lookup of the posting path and of the guards (0004 to 0013) by id or by voucher costs
 * one row (or the voucher's own rows), with and without statistics and with custom and generic plans, beside two
 * companies of 100,000 vouchers each whose other tables are filled to match (tests/helpers/lookup-layout.ts). On dev's
 * indexes the ledger, item, unit and voucher type lookups read the company's rows without statistics. This layout has
 * optional filler vouchers and 40 other items with lines; tests/lookup-by-id-busy.integration.ts has the other one.
 */
let database: TestDatabase;
let layout: Layout;
before(async () => {
  database = await freshDatabase('lookup_by_id');
  layout = await buildLayout(database, false);
});
after(async () => { await database?.drop(); });

test('every lookup by id or by voucher costs its own rows in all four planner states: optional fillers beside other items', async t => {
  await proveLookups(t, database, layout);
});

test("reading a voucher's item lines fetches its own rows only, in all four planner states", async t => {
  await proveVoucherRead(t, database, layout);
});
