import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { handleApi } from '../../src/server/api.ts';
import { getConfig } from '../../src/server/config.ts';
import { ledgerContext, type LedgerContext } from '../../src/server/ledger/context.ts';
import { withCompany } from '../../src/server/tenancy.ts';
import { Browser } from './database.ts';

/** Ledger test fixtures over the real HTTP contract (handleApi in process) and the real application role. */
export const password = 'correct horse battery staple';
export const browser = () => new Browser(handleApi, getConfig().appUrl);
export const books = { baseCurrency: 'AED', financialYearStart: { month: 1, day: 1 }, booksBeginning: '2026-01-01', timeZone: 'Asia/Dubai' };

export type Member = { browser: Browser; userId: string };

/** First-user setup: the owner of the installation's first company, which is not set up yet. Only once per database. */
export async function setupOwner(workspaceName = 'Ledger tests'): Promise<Member & { workspaceId: string }> {
  const owner = browser();
  const setup = await owner.call('/api/auth/setup', { name: 'Owner', email: `owner-${randomUUID()}@books.test`, password, workspaceName });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const me = (await owner.call('/api/me')).body;
  return { browser: owner, userId: me.user.id, workspaceId: me.workspaces[0].id };
}

/** Invites a new user to company `companyId` (its workspace, D-03) with `role` and signs them in. */
export async function invite(owner: Browser, companyId: string, role: 'admin' | 'editor' | 'viewer'): Promise<Member> {
  const invited = await owner.call(`/api/workspaces/${companyId}/invitations`, { email: `${role}-${randomUUID()}@books.test`, role });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const token = new URL(invited.body.inviteUrl).hash.replace('#invite=', '');
  const member = browser();
  assert.equal((await member.call('/api/invitations/accept', { token, name: role, password })).body.signedIn, true);
  return { browser: member, userId: (await member.call('/api/me')).body.user.id };
}

/** Creates a company (a workspace of its own, owned by `owner`) with books settings and the default chart. */
export async function createCompany(owner: Browser, settings: Partial<typeof books> & { name?: string } = {}): Promise<string> {
  const created = await owner.call('/api/companies', { name: `Company ${randomUUID().slice(0, 8)}`, ...books, ...settings });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.company.id;
}

/** The company's chart and voucher types, keyed by system key (built-in rows) and by name (every row). */
export type Chart = { group: (key: string) => string; ledger: (name: string) => string; type: (kind: string) => string };
export async function chart(member: Browser, companyId: string): Promise<Chart> {
  const groups = (await member.call(`/api/companies/${companyId}/groups`)).body.groups as { id: string; systemKey: string | null; name: string }[];
  const ledgers = (await member.call(`/api/companies/${companyId}/ledgers`)).body.ledgers as { id: string; name: string }[];
  const types = (await member.call(`/api/companies/${companyId}/voucher-types`)).body.voucherTypes as { id: string; kind: string }[];
  const find = <T>(rows: T[], match: (row: T) => boolean, what: string) => { const row = rows.find(match); assert.ok(row, `missing ${what}`); return row; };
  return {
    group: key => find(groups, row => row.systemKey === key || row.name === key, `group ${key}`).id,
    ledger: name => find(ledgers, row => row.name === name, `ledger ${name}`).id,
    type: kind => find(types, row => row.kind === kind, `voucher type ${kind}`).id,
  };
}

export async function addLedger(member: Browser, companyId: string, name: string, groupId: string, opening?: { amount: string; side: 'Dr' | 'Cr' }): Promise<string> {
  const created = await member.call(`/api/companies/${companyId}/ledgers`, { name, groupId, ...(opening ? { opening } : {}) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.ledger.id;
}

export type Line = [ledgerId: string, side: 'Dr' | 'Cr', amount: string];
export const voucherBody = (voucherTypeId: string, date: string, lines: Line[], extra: Record<string, unknown> = {}) => ({
  idempotencyKey: `test-${randomUUID()}`, voucherTypeId, date, lines: lines.map(([ledgerId, side, amount]) => ({ ledgerId, side, amount })), ...extra,
});

/** Posts through the API and asserts it was created; returns the voucher as the API answered. */
export async function post(member: Browser, companyId: string, voucherTypeId: string, date: string, lines: Line[], extra: Record<string, unknown> = {}): Promise<any> {
  const created = await member.call(`/api/companies/${companyId}/vouchers`, voucherBody(voucherTypeId, date, lines, extra));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.voucher;
}

/** Runs `run` in a company transaction as `userId`, with the ledger context the API would build. */
export function inCompany<T>(userId: string, companyId: string, run: (context: LedgerContext) => Promise<T>, mode: 'read' | 'write' = 'read'): Promise<T> {
  return withCompany(userId, companyId, mode, async (client, access) => run(await ledgerContext(client, access.companyId, userId, mode)));
}

/** A superuser connection to the test database, for fixtures and checks the application role must not be able to make. */
export async function asAdmin<T>(adminUrl: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}

export const rowCount = async (adminUrl: string, table: string, companyId: string) =>
  Number((await asAdmin(adminUrl, admin => admin.query(`SELECT count(*) FROM ${table} WHERE company_id = $1`, [companyId]))).rows[0].count);
