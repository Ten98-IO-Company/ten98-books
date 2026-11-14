import type { PoolClient } from 'pg';
import { baseCurrencies, companyCreateInput, type BaseCurrency, type Company, type CompanySummary } from '../lib/company.ts';
import { FoundationError } from './auth.ts';
import { getDatabase } from './db.ts';
import { seedCompanyLedger } from './ledger/seed.ts';
import { withCompanies, withCompany } from './tenancy.ts';
import { team, transaction } from './workspace-team.ts';

/**
 * Companies (D-03 as amended 2026-11-14): a company is a workspace. Its name is the workspace name, its team the
 * workspace members, and its books settings the `company` row keyed by the workspace id. A workspace without that row
 * (first-user setup creates one) is a company that is not set up yet.
 */
const companyColumns = `c.company_id AS id, w.name, c.second_language_name AS "secondLanguageName",
  c.base_currency AS "baseCurrency", c.currency_minor_units AS "currencyMinorUnits",
  json_build_object('month', c.fy_start_month, 'day', c.fy_start_day) AS "financialYearStart",
  c.books_beginning AS "booksBeginning", c.time_zone AS "timeZone", c.locked_through AS "lockedThrough"`;

export const notSetUp = 'This company is not set up yet. An owner or admin enters its books settings first.';

async function readCompany(client: PoolClient, companyId: string): Promise<Company | undefined> {
  const { rows } = await client.query<Company>(`SELECT ${companyColumns} FROM company c JOIN workspace w ON w.id = c.company_id WHERE c.company_id = $1`, [companyId]);
  return rows[0];
}

/**
 * Every company the user belongs to, oldest first, with the role and the books settings (`company` is null while the
 * company is not set up). A company whose two-factor requirement the user does not meet is listed by name only, as on
 * GET /api/me, and its settings stay out of the scope.
 */
export async function listCompanies(userId: string): Promise<CompanySummary[]> {
  const { rows } = await getDatabase().pool.query<{ id: string; locked: boolean }>(
    `SELECT m.workspace_id AS id, EXISTS (SELECT 1 FROM workspace_two_factor_requirement r JOIN "user" u ON u.id = m.user_id
       WHERE r.workspace_id = m.workspace_id AND NOT u."twoFactorEnabled") AS locked
     FROM membership m WHERE m.user_id = $1`, [userId]);
  const locked = new Set(rows.filter(row => row.locked).map(row => row.id));
  return withCompanies(userId, rows.map(row => row.id).filter(id => !locked.has(id)), async client => {
    const { rows: list } = await client.query<CompanySummary>(
      `SELECT w.id, w.name, m.role, false AS "twoFactorLocked", CASE WHEN c.company_id IS NULL THEN NULL ELSE json_build_object(
         'id', c.company_id, 'name', w.name, 'secondLanguageName', c.second_language_name, 'baseCurrency', c.base_currency,
         'currencyMinorUnits', c.currency_minor_units, 'financialYearStart', json_build_object('month', c.fy_start_month, 'day', c.fy_start_day),
         'booksBeginning', c.books_beginning, 'timeZone', c.time_zone, 'lockedThrough', c.locked_through) END AS company
       FROM membership m JOIN workspace w ON w.id = m.workspace_id LEFT JOIN company c ON c.company_id = w.id
       WHERE m.user_id = $1 ORDER BY w.created_at, w.id`, [userId]);
    return list.map(item => locked.has(item.id) ? { ...item, twoFactorLocked: true, company: null } : item);
  });
}

/** The company's settings for any member; a company that is not set up answers 409 `not_set_up`. */
export function getCompany(userId: string, companyId: string): Promise<Company> {
  // The scope and the read use the canonical id withCompany authorized, never the raw route text.
  return withCompany(userId, companyId, 'read', async (client, access) => {
    const company = await readCompany(client, access.companyId);
    if (!company) throw new FoundationError(409, notSetUp, 'not_set_up');
    return company;
  });
}

const fieldLabels: Record<string, string> = { name: 'the company name', baseCurrency: 'the base currency', financialYearStart: 'the financial year start',
  booksBeginning: 'the books beginning date', timeZone: 'the time zone', secondLanguageName: 'the second-language name' };

function parseCompany(value: unknown): ReturnType<typeof companyCreateInput.parse> {
  const parsed = companyCreateInput.safeParse(value);
  if (!parsed.success) throw new FoundationError(400, `Check ${fieldLabels[String(parsed.error.issues[0]?.path[0])] ?? 'the company details'} and try again.`);
  return parsed.data;
}

/** Inserts the books settings and seeds the default chart (D-10), inside the company's scope. */
async function insertSettings(client: PoolClient, companyId: string, input: ReturnType<typeof parseCompany>): Promise<Company> {
  const currency: BaseCurrency = input.baseCurrency;
  await client.query(
    `INSERT INTO company(company_id, second_language_name, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [companyId, input.secondLanguageName, currency, baseCurrencies[currency].minorUnits, input.financialYearStart.month, input.financialYearStart.day, input.booksBeginning, input.timeZone]);
  await seedCompanyLedger(client, companyId);
  return (await readCompany(client, companyId))!;
}

/**
 * Any signed-in user may create a company and becomes its owner, as any signed-in user may create a workspace (no
 * instance-level restriction exists for either). The workspace, the owner membership, the books settings and the seeded
 * chart commit together or not at all.
 */
export function createCompany(userId: string, value: unknown): Promise<Company> {
  const input = parseCompany(value);
  return transaction(async client => {
    const { workspace } = await team.createWorkspace(client, userId, { name: input.name });
    return withCompany(userId, workspace.id, 'write', scoped => insertSettings(scoped, workspace.id, input), client);
  });
}

/**
 * Finishes a company that is not set up yet: an owner or admin enters its books settings, and the name entered there
 * becomes the company (workspace) name. Settings that exist already are not replaced (409).
 */
export function setUpCompany(userId: string, companyId: string, value: unknown): Promise<Company> {
  const input = parseCompany(value);
  return transaction(async client => {
    // The team controller's lock order: the workspace row first, then memberships (withCompany share-locks the caller's).
    if (/^[0-9a-f-]{36}$/i.test(companyId)) await client.query('SELECT 1 FROM workspace WHERE id = $1 FOR UPDATE', [companyId.toLowerCase()]);
    return withCompany(userId, companyId, 'write', async (scoped, access) => {
      if (access.role !== 'owner' && access.role !== 'admin') throw new FoundationError(403, 'Only an owner or admin can set up the company.');
      if (await readCompany(scoped, access.companyId)) throw new FoundationError(409, 'This company is already set up.', 'already_set_up');
      await scoped.query('UPDATE workspace SET name = $1 WHERE id = $2', [input.name, access.companyId]);
      return insertSettings(scoped, access.companyId, input);
    }, client);
  });
}
