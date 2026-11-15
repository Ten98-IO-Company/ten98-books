import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { PoolClient } from 'pg';
import { getDatabase } from '../src/server/db.ts';
import { setCompanyScope } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, setupOwner, type Member } from './helpers/ledger.ts';

/**
 * Why the currency guard plans its lookups with their values (EXECUTE) instead of static PL/pgSQL. On a fixed data
 * distribution (almost every ledger in the base currency, two in USD, statistics taken), the same "a ledger names this
 * currency" lookup written as static PL/pgSQL switches, after a few runs in a session, to a cached generic plan that reads
 * the table's ledgers; the guard's lookup, run as a decimals change of a currency no ledger names, reads none. Counted
 * with the transaction's own table counters; no planner setting changed. A data distribution of its own, in its own
 * database, so other tests' rows do not move the statistics.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let companyId = '';

before(async () => {
  database = await freshDatabase('currency_plans');
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, { name: 'Planned Currencies' });
  const other = await createCompany(owner.browser, { name: 'Neighbour Plans' });
  const books = await chart(owner.browser, companyId);
  const call = (path: string, body: unknown) => owner.browser.call(`/api/companies/${companyId}${path}`, body);
  assert.equal((await call('/currencies', { code: 'USD', symbol: '$', formalName: 'US Dollar', decimals: 2 })).status, 201);
  for (const [name, group] of [['USD Bank', 'bank_accounts'], ['USD Debtor', 'receivables']]) {
    assert.equal((await call('/ledgers', { name, groupId: books.group(group), currency: 'USD' })).status, 201);
  }
  await asAdmin(database.adminUrl, async admin => {
    for (const [company, count] of [[other, 400], [companyId, 100]] as const) {
      await admin.query('BEGIN');
      await admin.query("SELECT set_config('app.company_ids', $1, true)", [company]);
      const group = (await admin.query("SELECT id FROM account_group WHERE company_id = $1 AND system_key = 'current_assets'", [company])).rows[0].id;
      await admin.query(`INSERT INTO ledger (company_id, group_id, name) SELECT $1, $2, 'Filler ' || n FROM generate_series(1, $3) n`, [company, group, count]);
      await admin.query(`INSERT INTO currency (company_id, code, symbol, formal_name, decimals) SELECT $1, code, lower(code) || '$', 'Filler ' || code, 2
        FROM unnest(ARRAY['MBA', 'MBB', 'MBC', 'MBD', 'MBE', 'MBF', 'MBG']) code WHERE $1 = $2`, [company, companyId]);
      await admin.query('COMMIT');
    }
    await admin.query('ANALYZE currency, ledger');
    await admin.query(`CREATE FUNCTION probe_static_ledger_lookup(p_code text, p_company text) RETURNS boolean
      LANGUAGE plpgsql SET search_path = public, pg_temp AS $f$ BEGIN RETURN EXISTS (SELECT 1 FROM ledger WHERE currency = p_code AND company_id = p_company); END $f$;
      GRANT EXECUTE ON FUNCTION probe_static_ledger_lookup(text, text) TO books_app`);
  });
});
after(async () => { await database?.drop(); });

const ledgerReads = async (client: PoolClient, run: () => Promise<unknown>) => {
  const read = async () => Number((await client.query("SELECT seq_tup_read + idx_tup_fetch AS n FROM pg_stat_xact_user_tables WHERE relname = 'ledger'")).rows[0].n);
  const start = await read();
  await run();
  return await read() - start;
};

test('static PL/pgSQL switches to a generic plan that reads the ledgers; the guard, planned with its values, reads none', async t => {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await setCompanyScope(client, [companyId]);
    const staticReads: number[] = [], guardReads: number[] = [];
    for (const code of ['MBA', 'MBB', 'MBC', 'MBD', 'MBE', 'MBF', 'MBG']) {
      staticReads.push(await ledgerReads(client, () => client.query('SELECT probe_static_ledger_lookup($1, $2)', [code, companyId])));
      guardReads.push(await ledgerReads(client, () => client.query('UPDATE currency SET decimals = 3 WHERE company_id = $1 AND code = $2', [companyId, code])));
    }
    await client.query('ROLLBACK');
    t.diagnostic(`ledger rows read per run: static ${staticReads.join(', ')}; guard ${guardReads.join(', ')}`);
    assert.ok(Math.max(...staticReads) > 100, `the static lookup's generic plan reads the ledgers: ${staticReads.join(', ')}`);
    assert.ok(Math.max(...guardReads) <= 1, `the guard reads at most one ledger: ${guardReads.join(', ')}`);
  } finally { client.release(); }
});
