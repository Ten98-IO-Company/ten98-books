import { after, before, test } from 'node:test';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { buildLayout, proveLookups, type Layout } from './helpers/lookup-layout.ts';

/**
 * Migration 0014 measured: every lookup of the posting path and of the guards (0004 to 0013) by id or by voucher costs
 * one row (or the voucher's own rows), with and without statistics and with custom and generic plans, beside two
 * companies of 100,000 vouchers each whose other tables are filled to match (tests/helpers/lookup-layout.ts). On dev's
 * indexes the ledger, item, unit and voucher type lookups read the company's rows without statistics. This layout has
 * regular filler vouchers and no other item with lines (the busy item is half of inventory_line);
 * tests/lookup-by-id.integration.ts has the other one.
 */
let database: TestDatabase;
let layout: Layout;
before(async () => {
  database = await freshDatabase('lookup_by_id_busy');
  layout = await buildLayout(database, true);
});
after(async () => { await database?.drop(); });

test('every lookup by id or by voucher costs its own rows in all four planner states: regular fillers, the busy item half of the item lines', async t => {
  await proveLookups(t, database, layout);
});
