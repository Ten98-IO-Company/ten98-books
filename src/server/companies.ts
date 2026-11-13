import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { baseCurrencies, companyCreateInput, type BaseCurrency, type Company } from '../lib/company.ts';
import { FoundationError } from './auth.ts';
import { getDatabase } from './db.ts';
import { withCompany } from './tenancy.ts';

const workspaceNotFound = 'Workspace not found or unavailable.';
const companyColumns = `c.company_id AS id, p.workspace_id AS "workspaceId", p.name, c.second_language_name AS "secondLanguageName",
  c.base_currency AS "baseCurrency", c.currency_minor_units AS "currencyMinorUnits",
  json_build_object('month', c.fy_start_month, 'day', c.fy_start_day) AS "financialYearStart",
  c.books_beginning AS "booksBeginning", c.time_zone AS "timeZone", c.locked_through AS "lockedThrough"`;

async function readCompany(client: PoolClient, companyId: string): Promise<Company> {
  const { rows } = await client.query<Company>(`SELECT ${companyColumns} FROM company c JOIN project p ON p.id = c.company_id WHERE c.company_id = $1`, [companyId]);
  if (!rows[0]) throw new FoundationError(404, 'Company not found or unavailable.');
  return rows[0];
}

/** Companies (the workspace's projects) the member can open; names only, so no company data leaves its scope. */
export async function listCompanies(userId: string, workspaceId: string): Promise<{ id: string; name: string }[]> {
  const { rows } = await getDatabase().pool.query<{ id: string; name: string }>(
    `SELECT p.id, p.name FROM project p JOIN membership m ON m.workspace_id = p.workspace_id AND m.user_id = $2
     WHERE p.workspace_id = $1 ORDER BY p.created_at, p.id`, [workspaceId, userId]);
  if (!rows.length && !(await getDatabase().pool.query('SELECT 1 FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId])).rowCount) {
    throw new FoundationError(404, workspaceNotFound);
  }
  return rows;
}

export function getCompany(userId: string, companyId: string): Promise<Company> {
  // The scope and the read use the canonical id withCompany authorized, never the raw route text.
  return withCompany(userId, companyId, 'read', (client, access) => readCompany(client, access.companyId));
}

/** Discover's project-create flow plus the company's books settings, in one transaction. */
const fieldLabels: Record<string, string> = { name: 'the company name', baseCurrency: 'the base currency', financialYearStart: 'the financial year start',
  booksBeginning: 'the books beginning date', timeZone: 'the time zone', secondLanguageName: 'the second-language name' };

export async function createCompany(userId: string, workspaceId: string, value: unknown): Promise<Company> {
  const parsed = companyCreateInput.safeParse(value);
  if (!parsed.success) throw new FoundationError(400, `Check ${fieldLabels[String(parsed.error.issues[0]?.path[0])] ?? 'the company details'} and try again.`);
  const input = parsed.data;
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [workspaceId]);
    const access = await client.query<{ role: string }>('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
    if (!['owner', 'admin', 'editor'].includes(access.rows[0]?.role)) throw new FoundationError(404, workspaceNotFound);
    const id = randomUUID();
    await client.query('INSERT INTO project(id, workspace_id, name) VALUES ($1, $2, $3)', [id, workspaceId, input.name]);
    const company = await withCompany(userId, id, 'write', async scoped => {
      const currency: BaseCurrency = input.baseCurrency;
      await scoped.query(
        `INSERT INTO company(company_id, second_language_name, base_currency, currency_minor_units, fy_start_month, fy_start_day, books_beginning, time_zone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, input.secondLanguageName, currency, baseCurrencies[currency].minorUnits, input.financialYearStart.month, input.financialYearStart.day, input.booksBeginning, input.timeZone]);
      return readCompany(scoped, id);
    }, client);
    await client.query('COMMIT');
    return company;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
