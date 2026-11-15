import pg from 'pg';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { getConfig } from './config.ts';
import { assertSchema, getDatabase, migrationLedger } from './db.ts';
import { handleAccountSecurity } from './account-security.ts';
import { requireWorkspaceFactor } from './teams.ts';
import { assertDatabaseRoles, DatabaseRoleError } from './tenancy.ts';
import { InputError } from './validation.ts';
import { json, limit, signedIn, type ApiArea, type SignedInArea } from './api/http.ts';
import { sessionApi } from './api/session.ts';
import { teamApi } from './api/team.ts';
import { companiesApi } from './api/companies.ts';
import { mastersApi } from './api/masters.ts';
import { vouchersApi } from './api/vouchers.ts';
import { reportsApi } from './api/reports.ts';
import { billsApi } from './api/bills.ts';
import { voucherEntryApi } from './api/voucher-entry.ts';
import { settingsApi } from './api/settings.ts';
import { costCentresApi } from './api/cost-centres.ts';
import { stockMastersApi } from './api/stock-masters.ts';
import { currenciesApi } from './api/currencies.ts';

// Checked once per process (and bundle) after it first passes: the role and its RLS guarantees do not change at runtime.
let rolesChecked: Promise<void> | undefined;
const assertRoles = () => (rolesChecked ??= assertDatabaseRoles(getDatabase().pool).catch(error => { rolesChecked = undefined; throw error; }));

const accountApi: ApiArea = ({ request }) => handleAccountSecurity(request, limit);

/** Bound of each step of the readiness probe: connecting, and each statement. A probe answers within about twice this. */
export const readinessStepMs = 2000;
/**
 * Readiness on its own connection (not the request pool): connected, migrated and served by the application role. Any
 * failure to reach or use the database (refused, reset, timed out, shutting down or starting up, too many connections, the
 * role refused) answers false, never an error, within the bound above.
 */
async function databaseReady(): Promise<boolean> {
  const probe = new pg.Pool({ connectionString: getConfig().databaseUrl, max: 1, connectionTimeoutMillis: readinessStepMs, statement_timeout: readinessStepMs, query_timeout: readinessStepMs });
  probe.on('error', () => undefined);
  try {
    const client = await probe.connect();
    try {
      await migrationLedger.assertCurrent(client);
      await assertDatabaseRoles(client);
      return true;
    } finally { client.release(); }
  } catch { return false; } finally { await probe.end().catch(() => undefined); }
}

// The route table: public areas first, then areas that require a signed-in user. Each area answers only its own paths.
const publicAreas: readonly ApiArea[] = [accountApi, sessionApi];
const signedInAreas: readonly SignedInArea[] = [teamApi, companiesApi, settingsApi, mastersApi, vouchersApi, reportsApi, billsApi, voucherEntryApi, costCentresApi, stockMastersApi, currenciesApi];

export async function handleApi(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    // The health probes are public: a wrong method answers 405 with the one it accepts, before any other check.
    if ((path === '/api/health/live' || path === '/api/health/ready') && request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405, { allow: 'GET' });
    if (path === '/api/health/live') return json({ status: 'alive' });
    if (path === '/api/health/ready') return await databaseReady() ? json({ status: 'ready' }) : json({ error: 'The installation is not ready. Check configuration and database migrations.' }, 503);
    await assertSchema();
    // D-03: never serve as a role that would make row-level security inert.
    await assertRoles();
    // Discover's central request-forgery gate: every state-changing request must come from the application's own origin
    // (a missing Origin is refused too). Discover applies it to POST; here it covers every non-reading method, which
    // includes PUT /api/account/keymap.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.get('origin') !== getConfig().appUrl) {
      throw new FoundationError(403, 'This action must originate from the application.');
    }
    const context = { request, url, path };
    for (const area of publicAreas) {
      const response = await area(context);
      if (response) return response;
    }
    const user = await signedIn(request);
    // Every route below is under /api/(workspaces|companies)/<id> (a company id is its workspace id) except GET /api/me
    // and GET or POST /api/companies, which stay reachable.
    await requireWorkspaceFactor(path, user.id);
    for (const area of signedInAreas) {
      const response = await area({ ...context, user });
      if (response) return response;
    }
    return json({ error: 'Route unavailable.' }, 404);
  } catch (error) {
    if (error instanceof FoundationError && error.code !== undefined) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof FoundationError || error instanceof InputError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return json({ error: 'Check the submitted fields and try again.' }, 400);
    if (error instanceof DatabaseRoleError) { console.error(error.message); return json({ error: 'The installation is not ready. Check the database roles.' }, 503); }
    const code = (error as { code?: string })?.code;
    if (code === '23505') return json({ error: 'This item already exists in the company.' }, 409);
    if (['SCHEMA_MISMATCH', '42P01', '42703', 'ECONNREFUSED', 'ENOTFOUND'].includes(code ?? '')) return json({ error: 'The installation is not ready. Check configuration and database migrations.' }, 503);
    console.error('Application request failed; inspect configuration and database availability.');
    return json({ error: 'The request could not be completed. Try again or contact your operator.' }, 500);
  }
}
