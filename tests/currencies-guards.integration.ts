import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { PoolClient } from 'pg';
import { getDatabase } from '../src/server/db.ts';
import { alterCurrency } from '../src/server/ledger/currencies.ts';
import { accountingTables, assertDatabaseRoles, setCompanyScope } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, inCompany, post, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * Currency and rate guards in the database (M2a currencies, slice a): hand-written SQL as the application role (the path
 * an application bug would take), the two lock races, the tenancy shape of the two tables, and what the guards and the
 * rate lookup read, from the transaction's own table counters.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let companyId = '', other = '';
let books: Chart;
const ids = { usdBank: '', usdDebtor: '', capital: '', plain: '' };

const call = (path: string, body?: unknown, company = companyId) => owner.browser.call(`/api/companies/${company}${path}`, body);
const made = async (path: string, body: unknown, key: string, company = companyId) => {
  const answer = await call(path, body, company);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  return answer.body[key];
};

before(async () => {
  database = await freshDatabase('currency_guards');
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, { name: 'Guarded Currencies' });
  other = await createCompany(owner.browser, { name: 'Neighbour Currencies' });
  books = await chart(owner.browser, companyId);
  await made('/currencies', { code: 'USD', symbol: '$', formalName: 'US Dollar', decimals: 2 }, 'currency');
  await made('/currencies', { code: 'XEU', symbol: 'EUR', formalName: 'Placeholder Euro', decimals: 2 }, 'currency');
  await made('/currencies', { code: 'XOT', symbol: 'XOT', formalName: 'Their Currency', decimals: 2 }, 'currency', other);
  ids.usdBank = (await made('/ledgers', { name: 'USD Bank', groupId: books.group('bank_accounts'), currency: 'USD' }, 'ledger')).id;
  ids.usdDebtor = (await made('/ledgers', { name: 'USD Debtor', groupId: books.group('receivables'), currency: 'USD' }, 'ledger')).id;
  ids.capital = (await made('/ledgers', { name: 'Capital', groupId: books.group('capital') }, 'ledger')).id;
  ids.plain = (await made('/ledgers', { name: 'Plain Account', groupId: books.group('current_assets') }, 'ledger')).id;
  await post(owner.browser, companyId, books.type('journal'), '2026-02-01', [[ids.usdBank, 'Dr', '100'], [ids.capital, 'Cr', '100']]);
});
after(async () => { await database?.drop(); });

const code = (expected: string, constraint?: string) => (error: unknown) => {
  const { code: actual, constraint: name } = error as { code?: string; constraint?: string };
  return actual === expected && (constraint === undefined || name === constraint);
};
/** One raw transaction as the application role, scoped to `scope`; rolled back on any error, or always with `rollback`. */
async function asApp(run: (client: PoolClient) => Promise<unknown>, scope: string[] = [companyId], rollback = false): Promise<void> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await setCompanyScope(client, scope);
    await run(client);
    await client.query(rollback ? 'ROLLBACK' : 'COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}
/** A transaction as the application role left open until `finish` commits it. */
async function openApp(run: (client: PoolClient) => Promise<unknown>, scope: string[] = [companyId]) {
  const client = await getDatabase().pool.connect();
  await client.query('BEGIN');
  await setCompanyScope(client, scope);
  await run(client);
  return { finish: async () => { try { await client.query('COMMIT'); } finally { client.release(); } } };
}
const insertCurrency = (client: PoolClient, row: { code: string; symbol: string; decimals?: number }, company = companyId) => client.query(
  'INSERT INTO currency (company_id, code, symbol, formal_name, decimals) VALUES ($1, $2, $3, $4, $5)', [company, row.code, row.symbol, `Currency ${row.code}`, row.decimals ?? 2]);
const state = (promise: Promise<unknown>) => Promise.race([promise.then(() => 'settled', () => 'settled'), new Promise(resolve => setTimeout(() => resolve('waiting'), 400))]);
const lock = (through: string | null) => asAdmin(database.adminUrl, admin => admin.query('UPDATE company SET locked_through = $2 WHERE company_id = $1', [companyId, through]));

test('direct SQL: decimals, symbols and codes are refused as the API refuses them', async () => {
  for (const decimals of [1, 4, 5]) await assert.rejects(asApp(client => insertCurrency(client, { code: 'XDE', symbol: 'xde', decimals })), code('23514', 'currency_decimals_check'), `${decimals} decimals`);
  const cases: [string, { code: string; symbol: string }][] = [
    ['a symbol equal to the code USD under the key', { code: 'XUS', symbol: 'U.S.D' }],
    ['a code equal to the symbol of XEU', { code: 'EUR', symbol: '€' }],
    ['a symbol equal to the symbol $ under the key', { code: 'XUD', symbol: '($)' }],
  ];
  for (const [what, row] of cases) await assert.rejects(asApp(client => insertCurrency(client, row)), code('23505', 'currency_symbol_idx'), what);
  await assert.rejects(asApp(client => client.query("UPDATE currency SET symbol = 'xeu' WHERE company_id = $1 AND code = 'USD'", [companyId])), code('23505', 'currency_symbol_idx'), 'a rename onto another code');
  await asApp(client => insertCurrency(client, { code: 'XAA', symbol: 'XAA' }), [companyId], true);
});

test('two currency creates that clash serialise on the base row: the second waits, then is refused', async () => {
  const first = await openApp(client => insertCurrency(client, { code: 'XRA', symbol: 'GBX' }));
  const second = asApp(client => insertCurrency(client, { code: 'GBX', symbol: 'Pence' }));
  assert.equal(await state(second), 'waiting', 'the second create waits on the base row');
  await first.finish();
  await assert.rejects(second, code('23505', 'currency_symbol_idx'));
});

test('the base row keeps its code and decimals and stays; it has no rates', async () => {
  await assert.rejects(asApp(client => client.query("UPDATE currency SET decimals = 3 WHERE company_id = $1 AND code = 'AED'", [companyId])), code('23514', 'currency_builtin'));
  await assert.rejects(asApp(client => client.query("DELETE FROM currency WHERE company_id = $1 AND code = 'AED'", [companyId])), code('23514', 'currency_builtin'));
  await assert.rejects(asApp(client => client.query("UPDATE currency SET code = 'AEX' WHERE company_id = $1 AND code = 'AED'", [companyId])), code('42501'), 'the code is not writable');
  // The migrator owns the table: the trigger still refuses a code change.
  await assert.rejects(asAdmin(database.adminUrl, async admin => {
    await admin.query('BEGIN');
    await admin.query("SELECT set_config('app.company_ids', $1, true)", [companyId]);
    await admin.query("UPDATE currency SET code = 'AEX' WHERE company_id = $1 AND code = 'AED'", [companyId]);
  }).finally(() => undefined), code('23514', 'currency_builtin'));
  await assert.rejects(asApp(client => client.query("INSERT INTO currency (company_id, code, system_key, symbol, formal_name, decimals) VALUES ($1, 'BHD', 'base', 'BD', 'Second Base', 3)", [companyId])),
    (error: { code?: string }) => ['23505', '23514'].includes(error.code ?? ''), 'a second base row');
  await assert.rejects(asApp(client => client.query("INSERT INTO exchange_rate (company_id, currency, kind, effective_date, rate) VALUES ($1, 'AED', 'standard', '2026-03-01', 1)", [companyId])),
    code('23514', 'exchange_rate_base'));
});

test('direct SQL: rate bounds, and rate rows dated in the locked period are refused', async () => {
  const rate = (client: PoolClient, date: string, value: string) => client.query(
    "INSERT INTO exchange_rate (company_id, currency, kind, effective_date, rate) VALUES ($1, 'USD', 'standard', $2, $3::numeric)", [companyId, date, value]);
  for (const value of ['0', '-1', '3.67255', '10000000000']) await assert.rejects(asApp(client => rate(client, '2026-05-01', value)), code('23514', 'exchange_rate_bounds'), value);
  await asApp(client => rate(client, '2026-01-31', '3.67'));
  await asApp(client => rate(client, '2026-02-01', '3.68'));
  await lock('2026-01-31');
  try {
    await assert.rejects(asApp(client => rate(client, '2026-01-15', '3.66')), code('23514', 'exchange_rate_locked'), 'insert in the lock');
    await assert.rejects(asApp(client => client.query("UPDATE exchange_rate SET rate = 3.69 WHERE company_id = $1 AND currency = 'USD' AND effective_date = '2026-01-31'", [companyId])), code('23514', 'exchange_rate_locked'), 'change in the lock');
    await assert.rejects(asApp(client => client.query("DELETE FROM exchange_rate WHERE company_id = $1 AND currency = 'USD' AND effective_date = '2026-01-31'", [companyId])), code('23514', 'exchange_rate_locked'), 'removal in the lock');
    await asApp(client => client.query("UPDATE exchange_rate SET rate = 3.685 WHERE company_id = $1 AND currency = 'USD' AND effective_date = '2026-02-01'", [companyId]));
    await asApp(client => insertCurrency(client, { code: 'XLK', symbol: 'xlk' }));
    await asApp(client => client.query("INSERT INTO exchange_rate (company_id, currency, kind, effective_date, rate) VALUES ($1, 'XLK', 'buying', '2026-02-01', 2)", [companyId]));
    await lock('2026-02-01');
    await assert.rejects(asApp(client => client.query("DELETE FROM currency WHERE company_id = $1 AND code = 'XLK'", [companyId])), code('23514', 'exchange_rate_locked'), 'a currency with a rate in the lock');
  } finally { await lock(null); }
  await asApp(client => client.query("DELETE FROM currency WHERE company_id = $1 AND code = 'XLK'", [companyId]));
});

test('direct SQL: a ledger in a foreign currency keeps the foreign rules, and its currency is fixed once posted', async () => {
  const update = (set: string, ledger = ids.usdBank) => asApp(client => client.query(`UPDATE ledger SET ${set} WHERE company_id = $1 AND id = $2`, [companyId, ledger]));
  for (const set of ['bill_wise = true', 'credit_count = 30, credit_unit = \'day\'', 'credit_days_check = true', 'cost_centres = true']) {
    await assert.rejects(update(set, ids.usdDebtor), code('23514', 'ledger_currency_settings'), set);
  }
  await assert.rejects(update(`group_id = '${books.group('sales')}'`, ids.usdDebtor), code('23514', 'ledger_currency_family'), 'under an income group');
  const pl = await asAdmin(database.adminUrl, async admin => (await admin.query("SELECT id FROM ledger WHERE company_id = $1 AND system_key = 'profit_and_loss'", [companyId])).rows[0].id);
  await assert.rejects(update("currency = 'USD'", pl), code('23514', 'ledger_currency_family'), 'the profit and loss ledger');
  await assert.rejects(update("currency = 'AED'"), code('23514', 'ledger_currency_in_use'), 'a ledger with a posted line');
  await assert.rejects(update("currency = 'USD', opening_amount = 100", ids.plain), code('23514', 'ledger_currency_in_use'), 'an opening amount');
  await update(`currency = 'USD'`, ids.plain);
  await update(`currency = 'AED'`, ids.plain);
  // A group holding a foreign ledger does not become an income or expense group.
  const group = (await made('/groups', { name: 'Overseas Banks', nature: 'asset' }, 'group')).id;
  const inGroup = (await made('/ledgers', { name: 'EUR Bank', groupId: group, currency: 'USD' }, 'ledger')).id;
  await assert.rejects(asApp(client => client.query("UPDATE account_group SET nature = 'expense' WHERE company_id = $1 AND id = $2", [companyId, group])), code('23514', 'ledger_currency_family'));
  // The existing base-only check still refuses a foreign amount on a line.
  const voucher = await asAdmin(database.adminUrl, async admin => (await admin.query('SELECT voucher_id FROM voucher_line WHERE company_id = $1 AND ledger_id = $2', [companyId, ids.usdBank])).rows[0].voucher_id);
  await assert.rejects(asApp(client => client.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
    VALUES ($1, $2, 9, $3, 'Dr', 10000, 'USD', 2725, 3.67)`, [companyId, voucher, inGroup])), code('23514', 'voucher_line_base_currency_only'));
});

for (const path of ['direct SQL', 'the API'] as const) {
  test(`a decimals change waits for a ledger being created in the currency, then is refused (${path})`, async () => {
    const currency = path === 'direct SQL' ? 'XRD' : 'XRE';
    await asApp(client => insertCurrency(client, { code: currency, symbol: currency.toLowerCase() }));
    const ledger = await openApp(client => client.query('INSERT INTO ledger (company_id, group_id, name, currency) VALUES ($1, $2, $3, $4)',
      [companyId, books.group('bank_accounts'), `Bank ${currency}`, currency]));
    const change = path === 'direct SQL'
      ? asApp(client => client.query('UPDATE currency SET decimals = 3 WHERE company_id = $1 AND code = $2', [companyId, currency]))
      : inCompany(owner.userId, companyId, context => alterCurrency(context, currency, { symbol: currency.toLowerCase(), formalName: `Currency ${currency}`, decimals: 3, revision: 1 }), 'write');
    assert.equal(await state(change), 'waiting', 'the change waits for the ledger insert');
    await ledger.finish();
    await assert.rejects(change, path === 'direct SQL' ? code('23503', 'currency_in_use') : (error: { code?: string }) => error.code === 'in_use');
  });
}

for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE'] as const) {
  test(`direct SQL: a decimals change in ${isolation} is refused, so it cannot commit past a ledger it waited for`, async () => {
    const currency = isolation === 'SERIALIZABLE' ? 'XSZ' : 'XRR';
    await asApp(client => insertCurrency(client, { code: currency, symbol: currency.toLowerCase() }));
    const ledger = await openApp(client => client.query('INSERT INTO ledger (company_id, group_id, name, currency) VALUES ($1, $2, $3, $4)',
      [companyId, books.group('bank_accounts'), `Bank ${currency}`, currency]));
    // Its snapshot is taken before the ledger commits: without the rule the change waits, then its use check reads that
    // older snapshot, finds no ledger and commits.
    const client = await getDatabase().pool.connect();
    const change = (async () => {
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await setCompanyScope(client, [companyId]);
        await client.query('UPDATE currency SET decimals = 3 WHERE company_id = $1 AND code = $2', [companyId, currency]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
    })();
    await state(change);
    await ledger.finish();
    await assert.rejects(change, code('25001', 'currency_in_use'));
    const decimals = await asAdmin(database.adminUrl, async admin => (await admin.query('SELECT decimals FROM currency WHERE company_id = $1 AND code = $2', [companyId, currency])).rows[0].decimals);
    assert.equal(decimals, 2);
  });
}

test('tenancy: composite keys, the company scope and the boot assertion cover both tables', async () => {
  for (const table of ['currency', 'exchange_rate']) assert.ok(accountingTables.includes(table as never), table);
  await assert.rejects(asApp(client => client.query('INSERT INTO ledger (company_id, group_id, name, currency) VALUES ($1, $2, $3, $4)',
    [companyId, books.group('bank_accounts'), 'Their Currency Bank', 'XOT'])), code('23503', 'ledger_currency_fkey'), 'another company\'s currency');
  await asApp(async client => {
    assert.equal((await client.query('SELECT * FROM currency WHERE company_id = $1', [companyId])).rowCount, 0, 'outside the scope a company\'s currencies are hidden');
    assert.equal((await client.query('SELECT * FROM exchange_rate WHERE company_id = $1', [companyId])).rowCount, 0);
  }, [other]);
  await assert.rejects(asApp(client => insertCurrency(client, { code: 'XSC', symbol: 'xsc' }), [other]), code('42501'), 'writing into another company');
  await assert.rejects(asApp(client => client.query("INSERT INTO exchange_rate (company_id, currency, kind, effective_date, rate) VALUES ($1, 'USD', 'standard', '2026-06-01', 3)", [companyId]), [other]), code('42501'));
  const shape = await asAdmin(database.adminUrl, async admin => ({
    keys: (await admin.query(`SELECT conrelid::regclass::text AS "table", conname, pg_get_constraintdef(oid) AS definition, convalidated FROM pg_constraint
      WHERE contype IN ('f', 'p', 'u') AND (conrelid::regclass::text = ANY($1) OR conname = ANY($2)) ORDER BY 1, 2`,
      [['currency', 'exchange_rate'], ['ledger_currency_fkey', 'voucher_line_currency_fkey', 'bill_currency_fkey', 'bill_allocation_currency_fkey']])).rows,
    columns: (await admin.query(`SELECT table_name || '.' || column_name AS col FROM information_schema.column_privileges
      WHERE grantee = 'books_app' AND privilege_type = 'UPDATE' AND table_name IN ('currency', 'exchange_rate') ORDER BY 1`)).rows.map(row => row.col),
    ledgerCurrency: (await admin.query(`SELECT has_column_privilege('books_app', 'ledger', 'currency', 'UPDATE') AS granted`)).rows[0].granted,
  }));
  for (const key of shape.keys) {
    assert.match(key.definition, /^(PRIMARY KEY|UNIQUE|FOREIGN KEY) \(company_id[,)]/, `${key.table}.${key.conname}: ${key.definition}`);
    assert.equal(key.convalidated, true, `${key.table}.${key.conname} is validated`);
  }
  assert.deepEqual(shape.keys.filter(key => /^(ledger|voucher_line|bill|bill_allocation)_currency_fkey$/.test(key.conname)).map(key => key.table).sort(), ['bill', 'bill_allocation', 'ledger', 'voucher_line']);
  assert.deepEqual(shape.columns, ['currency.decimal_word', 'currency.decimals', 'currency.formal_name', 'currency.in_millions', 'currency.iso_code', 'currency.revision',
    'currency.space_between', 'currency.symbol', 'currency.symbol_after', 'currency.words_decimals', 'exchange_rate.rate']);
  assert.equal(shape.ledgerCurrency, true);
  const { pool } = getDatabase();
  await assertDatabaseRoles(pool);
  for (const table of ['currency', 'exchange_rate']) {
    await asAdmin(database.adminUrl, admin => admin.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`));
    await assert.rejects(assertDatabaseRoles(pool), new RegExp(table), `${table} without forced row-level security`);
    await asAdmin(database.adminUrl, admin => admin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
    const policy = await asAdmin(database.adminUrl, async admin => (await admin.query('SELECT qual FROM pg_policies WHERE tablename = $1', [table])).rows[0].qual as string);
    await asAdmin(database.adminUrl, admin => admin.query(`DROP POLICY ${table}_company_scope ON ${table}`));
    await assert.rejects(assertDatabaseRoles(pool), new RegExp(table), `${table} without its policy`);
    await asAdmin(database.adminUrl, admin => admin.query(`CREATE POLICY ${table}_company_scope ON ${table} USING (${policy}) WITH CHECK (${policy})`));
  }
  await assertDatabaseRoles(pool);
});

type Counters = { seq_tup_read: number; idx_tup_fetch: number };
const counters = async (client: PoolClient, table: string): Promise<Counters> => {
  const { rows } = await client.query<Record<keyof Counters, string>>('SELECT seq_tup_read, idx_tup_fetch FROM pg_stat_xact_user_tables WHERE relname = $1', [table]);
  return { seq_tup_read: Number(rows[0]?.seq_tup_read ?? 0), idx_tup_fetch: Number(rows[0]?.idx_tup_fetch ?? 0) };
};
/** Rows `run` reads from each table, by sequential scan and by index, inside the caller's transaction. */
async function reads(client: PoolClient, tables: string[], run: () => Promise<unknown>): Promise<Record<string, Counters>> {
  const start = Object.fromEntries(await Promise.all(tables.map(async table => [table, await counters(client, table)] as const)));
  await run();
  const result: Record<string, Counters> = {};
  for (const table of tables) {
    const end = await counters(client, table);
    result[table] = { seq_tup_read: end.seq_tup_read - start[table].seq_tup_read, idx_tup_fetch: end.idx_tup_fetch - start[table].idx_tup_fetch };
  }
  return result;
}

test('the name check, the decimals and delete checks and the rate lookup read by index, with and without statistics', async t => {
  // Another company with 400 currencies, 400 ledgers and 2,400 rate rows; this one with 60 currencies and 100 more ledgers.
  const codes = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`);
  await asAdmin(database.adminUrl, async admin => {
    await admin.query('ALTER TABLE currency SET (autovacuum_enabled = false); ALTER TABLE ledger SET (autovacuum_enabled = false); ALTER TABLE exchange_rate SET (autovacuum_enabled = false)');
    for (const [company, prefix, count, ledgers] of [[other, 'Q', 400, 400], [companyId, 'M', 60, 100]] as const) {
      await admin.query('BEGIN');
      await admin.query("SELECT set_config('app.company_ids', $1, true)", [company]);
      await admin.query(`INSERT INTO currency (company_id, code, symbol, formal_name, decimals) SELECT $1, code, lower(code) || '$', 'Filler ' || code, 2 FROM unnest($2::text[]) code`, [company, codes(prefix, count)]);
      const group = (await admin.query("SELECT id FROM account_group WHERE company_id = $1 AND system_key = 'current_assets'", [company])).rows[0].id;
      await admin.query(`INSERT INTO ledger (company_id, group_id, name) SELECT $1, $2, 'Filler ' || n FROM generate_series(1, $3) n`, [company, group, ledgers]);
      await admin.query(`INSERT INTO exchange_rate (company_id, currency, kind, effective_date, rate)
        SELECT $1, c, k, date '2025-01-01' + d, 3 + d / 1000.0 FROM unnest($2::text[]) c, unnest('{standard,selling,buying}'::text[]) k, generate_series(0, 199) d`,
      [company, codes(prefix, count).slice(0, 4)]);
      await admin.query('COMMIT');
    }
  });
  for (const [phase, analyse] of [['no statistics', null], ['statistics', 'ANALYZE currency, ledger, exchange_rate']] as const) {
    if (analyse) await asAdmin(database.adminUrl, admin => admin.query(analyse));
    const client = await getDatabase().pool.connect();
    try {
      await client.query('BEGIN');
      await setCompanyScope(client, [companyId]);
      // Seven rounds in one session: PL/pgSQL and the foreign-key checks plan the first runs with their values and may
      // then switch to a cached generic plan; every round must stay within the bound.
      const rounds: Record<string, Record<string, Counters>>[] = [];
      for (let round = 0; round < 7; round += 1) {
        const letter = String.fromCharCode(65 + round); // each phase rolls back, so both use the same rows
        rounds.push({
          name: await reads(client, ['currency'], () => insertCurrency(client, { code: `XN${letter}`, symbol: `n${letter}$` })),
          decimals: await reads(client, ['currency', 'ledger'], () => client.query("UPDATE currency SET decimals = 3 WHERE company_id = $1 AND code = $2", [companyId, `MB${letter}`])),
          removal: await reads(client, ['currency', 'ledger', 'voucher_line', 'bill', 'bill_allocation'], () => client.query('DELETE FROM currency WHERE company_id = $1 AND code = $2', [companyId, `MC${letter}`])),
          lookup: await reads(client, ['exchange_rate'], () => client.query(`SELECT k.kind, r.rate FROM currency c CROSS JOIN unnest('{standard,selling,buying}'::text[]) AS k(kind)
            LEFT JOIN LATERAL (SELECT e.rate FROM exchange_rate e WHERE e.company_id = c.company_id AND e.currency = c.code AND e.kind = k.kind AND e.effective_date <= '2025-05-01'
              ORDER BY e.effective_date DESC LIMIT 1) r ON true WHERE c.company_id = $1 AND c.system_key IS NULL`, [companyId])),
        });
      }
      await client.query('ROLLBACK');
      const total = (counter: Counters) => counter.seq_tup_read + counter.idx_tup_fetch;
      const most = (what: string, table: string) => Math.max(...rounds.map(round => total(round[what][table])));
      const seen = Object.fromEntries(['name:currency', 'decimals:currency', 'decimals:ledger', 'removal:currency', 'removal:ledger', 'removal:voucher_line', 'removal:bill', 'removal:bill_allocation', 'lookup:exchange_rate']
        .map(key => [key, most(...key.split(':') as [string, string])]));
      t.diagnostic(`${phase}, most rows read in any of 7 rounds: ${JSON.stringify(seen)}`);
      // Without statistics the planner prices the primary key (company first) like the symbol index (key first), and may
      // take it with the company as its only condition: each of the two symbol lookups then reads the company's own
      // currencies, never another company's (LEDGER.md, "Known limits"). With statistics each lookup reads at most one row.
      const own = await asAdmin(database.adminUrl, async admin => Number((await admin.query('SELECT count(*) FROM currency WHERE company_id = $1', [companyId])).rows[0].count));
      const nameBound = phase === 'no statistics' ? 2 * own + 2 : 2;
      assert.ok(seen['name:currency'] <= nameBound && Math.max(...rounds.map(round => round.name.currency.seq_tup_read)) === 0,
        `${phase}: the name check read ${seen['name:currency']} currencies (bound ${nameBound}, the company holds ${own}, the other company 400)`);
      assert.ok(seen['decimals:ledger'] <= 1 && seen['decimals:currency'] <= 3, `${phase}: the decimals check read ${JSON.stringify(seen)}`);
      assert.ok(seen['removal:ledger'] <= 1 && seen['removal:currency'] <= 1, `${phase}: the delete read ${JSON.stringify(seen)}`);
      // Three kinds of the company's four currencies with rates (the others have none): one row each, never the 3,200 rows.
      assert.ok(seen['lookup:exchange_rate'] <= 12, `${phase}: the lookup read ${seen['lookup:exchange_rate']} rate rows`);
    } finally { client.release(); }
  }
});

test('direct SQL: a voucher line in another currency code, a foreign ledger opening and a symbol with an empty key are refused', async () => {
  // Rate 1 and equal amounts pass the line's own base-only check; the per-voucher check at commit refuses the code.
  const type = await asAdmin(database.adminUrl, async admin => (await admin.query("SELECT id, numbering_series FROM voucher_type WHERE company_id = $1 AND kind = 'journal'", [companyId])).rows[0]);
  await assert.rejects(asApp(async client => {
    const voucher = (await client.query(`INSERT INTO voucher (company_id, voucher_type_id, series, date, status, idempotency_key, request_hash, created_by)
      VALUES ($1, $2, $3, '2026-03-01', 'optional', $4, $5, $6) RETURNING id`, [companyId, type.id, type.numbering_series, 'foreign-code-line', 'b'.repeat(64), owner.userId])).rows[0].id;
    await client.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
      VALUES ($1, $2, 1, $3, 'Dr', 100, 'USD', 100, 1), ($1, $2, 2, $4, 'Cr', 100, 'USD', 100, 1)`, [companyId, voucher, ids.usdBank, ids.capital]);
  }), code('23514', 'voucher_line_base_currency_only'));
  await assert.rejects(asApp(client => client.query('UPDATE ledger SET opening_amount = 100 WHERE company_id = $1 AND id = $2', [companyId, ids.usdBank])),
    code('23514', 'ledger_currency_settings'), 'an opening balance on a foreign ledger');
  for (const symbol of ['...', '-']) await assert.rejects(asApp(client => insertCurrency(client, { code: 'XPP', symbol })), code('23514', 'currency_symbol_key'), symbol);
});
