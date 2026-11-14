import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { PoolClient } from 'pg';
import { getDatabase } from '../src/server/db.ts';
import { setCompanyScope } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, invite, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * Voucher changes of migration 0009 through the HTTP contract and as raw SQL: vouchers created cancelled without lines
 * (voids), and vouchers altered into another voucher type.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('voucher_changes');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

type Line = { ledgerId: string; side: 'Dr' | 'Cr'; amount: string; bills?: unknown[] };
const line = (ledgerId: string, side: 'Dr' | 'Cr', amount: string, bills?: unknown[]): Line => ({ ledgerId, side, amount, ...(bills ? { bills } : {}) });

async function books(name: string) {
  const companyId = await createCompany(owner.browser, { name });
  const accounts: Chart = await chart(owner.browser, companyId);
  const call = (path: string, body?: unknown, member: Member = owner) => member.browser.call(`/api/companies/${companyId}${path}`, body);
  const ledger = async (ledgerName: string, groupKey: string) => {
    const made = await call('/ledgers', { name: ledgerName, groupId: accounts.group(groupKey) });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return made.body.ledger.id as string;
  };
  const post = async (kind: string, date: string, lines: Line[], extra: Record<string, unknown> = {}, status = 201) => {
    const posted = await call('/vouchers', { idempotencyKey: `changes-${randomUUID()}`, voucherTypeId: accounts.type(kind), date, lines, ...extra });
    assert.equal(posted.status, status, JSON.stringify(posted.body));
    return posted.body;
  };
  return { companyId, accounts, call, ledger, post };
}

const code = (expected: string, constraint?: string) => (error: unknown) => {
  const { code: actual, constraint: name } = error as { code?: string; constraint?: string };
  return actual === expected && (constraint === undefined || name === constraint);
};
async function asApp(companyId: string, run: (client: PoolClient) => Promise<unknown>): Promise<void> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await setCompanyScope(client, [companyId]);
    await run(client);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}

test('a voucher created cancelled without lines takes the next number, has no effect, is logged and replays by its key', async () => {
  const b = await books('Voids');
  const cash = b.accounts.ledger('Cash'), rent = await b.ledger('Rent', 'indirect_expenses');
  const first = (await b.post('payment', '2026-03-01', [line(rent, 'Dr', '100'), line(cash, 'Cr', '100')])).voucher;
  const key = `void-${randomUUID()}`;
  const voidBody = { idempotencyKey: key, voucherTypeId: b.accounts.type('payment'), date: '2026-03-02', status: 'cancelled', narration: 'Spoilt cheque', lines: [] };
  const created = await b.call('/vouchers', voidBody);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const voided = created.body.voucher;
  assert.deepEqual([voided.status, voided.number, voided.lines, voided.total, created.body.warnings], ['cancelled', first.number + 1, [], '0.00', []]);
  const next = (await b.post('payment', '2026-03-03', [line(rent, 'Dr', '50'), line(cash, 'Cr', '50')])).voucher;
  assert.equal(next.number, first.number + 2, 'the void used its number');

  const replay = await b.call('/vouchers', voidBody);
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.voucher.id], [200, true, voided.id]);
  assert.equal((await b.call('/vouchers', { ...voidBody, narration: 'Other' })).body.code, 'idempotency_mismatch');

  const trial = (await b.call('/trial-balance?from=2026-03-01&to=2026-03-31')).body.trialBalance;
  assert.equal(trial.rows.find((row: any) => row.ledgerId === rent).debit, '150.00', 'no accounting effect');
  assert.deepEqual(((await b.call(`/vouchers/${voided.id}/revisions`)).body.revisions as any[]).map(row => [row.action, row.after.status, row.after.number]), [['create', 'cancelled', voided.number]]);
  assert.ok(((await b.call('/vouchers?from=2026-03-01&to=2026-03-31')).body.vouchers as any[]).some(row => row.id === voided.id && row.status === 'cancelled'), 'listed as cancelled');

  // Like any cancelled voucher: never altered or made regular; it may be deleted, leaving its number as a gap.
  const altered = await b.call(`/vouchers/${voided.id}`, { date: '2026-03-02', narration: null, status: 'regular', postDated: false, reference: null, referenceDate: null,
    lines: [line(rent, 'Dr', '10'), line(cash, 'Cr', '10')], revision: voided.revision });
  assert.deepEqual([altered.status, altered.body.code], [409, 'voucher_state']);
  assert.equal((await b.call(`/vouchers/${voided.id}/delete`, { revision: voided.revision })).status, 200);
});

test('only a void is exempt from the two balanced lines; lines sent with it, or a cancelled voucher losing its lines, are refused', async () => {
  const b = await books('Void Rules');
  const cash = b.accounts.ledger('Cash'), rent = await b.ledger('Rent', 'indirect_expenses');
  const withLines = await b.call('/vouchers', { idempotencyKey: `void-${randomUUID()}`, voucherTypeId: b.accounts.type('payment'), date: '2026-03-02', status: 'cancelled',
    lines: [line(rent, 'Dr', '10'), line(cash, 'Cr', '10')] });
  assert.deepEqual([withLines.status, withLines.body.code], [400, 'validation']);
  const regularEmpty = await b.call('/vouchers', { idempotencyKey: `void-${randomUUID()}`, voucherTypeId: b.accounts.type('payment'), date: '2026-03-02', lines: [] });
  assert.deepEqual([regularEmpty.status, regularEmpty.body.code], [400, 'unbalanced']);
  const posted = (await b.post('payment', '2026-03-03', [line(rent, 'Dr', '20'), line(cash, 'Cr', '20')])).voucher;
  const voided = (await b.post('payment', '2026-03-04', [], { status: 'cancelled' })).voucher;
  // Raw SQL as the application role: a posted voucher cannot shed its lines and pass as a void, a void gains no lines,
  // and nobody sets the flag that marks a void.
  const cases: [string, (client: PoolClient) => Promise<unknown>, (error: unknown) => boolean][] = [
    ['a posted voucher emptied, then cancelled', async client => {
      await client.query('DELETE FROM voucher_line WHERE company_id = $1 AND voucher_id = $2', [b.companyId, posted.id]);
      await client.query(`UPDATE voucher SET status = 'cancelled' WHERE company_id = $1 AND id = $2`, [b.companyId, posted.id]);
    }, code('23514', 'voucher_balanced')],
    ['a line added to a void', client => client.query(`INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
      VALUES ($1, $2, 1, $3, 'Dr', 1000, 'AED', 1000, 1)`, [b.companyId, voided.id, rent]), code('23514', 'voucher_lines_frozen')],
    ['marking a voucher as a void', client => client.query('UPDATE voucher SET created_cancelled = true WHERE company_id = $1 AND id = $2', [b.companyId, posted.id]), code('42501')],
    ['a void made regular', client => client.query(`UPDATE voucher SET status = 'regular' WHERE company_id = $1 AND id = $2`, [b.companyId, voided.id]), code('23514', 'voucher_lifecycle')],
    ['an optional voucher inserted without lines', async client => {
      const type = b.accounts.type('payment');
      await client.query(`INSERT INTO voucher (company_id, voucher_type_id, series, date, status, idempotency_key, request_hash, created_by)
        SELECT $1, $2, numbering_series, '2026-03-05', 'optional', $3, $4, $5 FROM voucher_type WHERE company_id = $1 AND id = $2`,
      [b.companyId, type, `raw-${randomUUID()}`, 'a'.repeat(64), owner.userId]);
    }, code('23514', 'voucher_balanced')],
  ];
  for (const [name, run, expected] of cases) await assert.rejects(asApp(b.companyId, run), expected, name);
  const lines = await asAdmin(database.adminUrl, admin => admin.query('SELECT count(*)::int AS n FROM voucher_line WHERE voucher_id = $1', [posted.id]));
  assert.equal(lines.rows[0].n, 2);
});

test('voids answer not found for a viewer and another company, and refuse another company\'s voucher type', async () => {
  const mine = await books('Void Mine'), theirs = await books('Void Theirs');
  const viewer = await invite(owner.browser, mine.companyId, 'viewer');
  const body = (typeId: string) => ({ idempotencyKey: `void-${randomUUID()}`, voucherTypeId: typeId, date: '2026-03-02', status: 'cancelled', lines: [] });
  const asViewer = await mine.call('/vouchers', body(mine.accounts.type('payment')), viewer);
  assert.deepEqual([asViewer.status, asViewer.body.code], [404, 'not_found']);
  const outsider = await invite(owner.browser, theirs.companyId, 'editor');
  const asOutsider = await mine.call('/vouchers', body(mine.accounts.type('payment')), outsider);
  assert.deepEqual([asOutsider.status, asOutsider.body.code], [404, 'not_found']);
  const theirType = await mine.call('/vouchers', body(theirs.accounts.type('payment')));
  assert.deepEqual([theirType.status, theirType.body.code], [400, 'not_found']);
});
