import pg from 'pg';
import { z } from 'zod';
import { appMarkerHeader, appMarkerValue } from '../lib/app-marker.ts';
import { FoundationError } from './auth.ts';
import { getConfig } from './config.ts';
import { assertSchema, getDatabase, migrationLedger } from './db.ts';
import { handleAccountSecurity } from './account-security.ts';
import { requireWorkspaceFactor } from './teams.ts';
import { assertDatabaseRoles, DatabaseRoleError } from './tenancy.ts';
import { InputError } from './validation.ts';
import { json, limit, methodNotAllowed, signedIn, type ApiArea, type SignedInArea } from './api/http.ts';
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
/** How long one readiness result is shared by the probes that follow it. */
const readinessShareMs = 1000;
let lastCheck: { url: string; at: number; pending: boolean; result: Promise<boolean> } | undefined;
/** The probe's one connection, kept between checks while it works; never more than one for the whole process. */
let probeClient: { url: string; client: pg.Client } | undefined;

/**
 * Drops the probe's connection, closing its socket at once. pg's Client has no public way to do that: `end()` sends
 * Terminate and waits for the server to close, which a database that never answers never does, so the socket of its
 * private `connection.stream` is destroyed directly.
 */
function dropProbeClient(): void {
  const stream = (probeClient?.client as unknown as { connection?: { stream?: { destroy(): void } } } | undefined)?.connection?.stream;
  stream?.destroy();
  probeClient = undefined;
}

/**
 * One check, on the probe's own connection (apart from the request pool, so nothing a signed-out caller does to the probe
 * can take a connection the application needs): connected, migrated and served by the application role. Any failure to
 * reach or use the database (refused, reset, timed out, shutting down or starting up, too many connections, the role
 * refused) answers false, never an error, and destroys that connection.
 */
async function checkDatabase(url: string): Promise<boolean> {
  try {
    if (probeClient?.url !== url) {
      dropProbeClient();
      const client = new pg.Client({ connectionString: url, application_name: 'books-readiness', connectionTimeoutMillis: readinessStepMs, statement_timeout: readinessStepMs, query_timeout: readinessStepMs });
      client.on('error', () => undefined);
      probeClient = { url, client };
      await client.connect();
    }
    const client = probeClient!.client;
    await migrationLedger.assertCurrent(client);
    // The role check reads through `query` only; a single client stands in for the pool client it is typed for.
    await assertDatabaseRoles(client as unknown as pg.PoolClient);
    return true;
  } catch {
    dropProbeClient();
    return false;
  }
}

/** Readiness: concurrent probes share one check in flight, and its result for `readinessShareMs` after it ends. */
function databaseReady(): Promise<boolean> {
  const url = getConfig().databaseUrl;
  if (lastCheck?.url === url && (lastCheck.pending || Date.now() - lastCheck.at < readinessShareMs)) return lastCheck.result;
  const check = { url, at: Date.now(), pending: true, result: checkDatabase(url) };
  void check.result.then(() => { check.pending = false; check.at = Date.now(); });
  lastCheck = check;
  return check.result;
}

// The route table: public areas first, then areas that require a signed-in user. Each area answers only its own paths.
const publicAreas: readonly ApiArea[] = [accountApi, sessionApi];
const signedInAreas: readonly SignedInArea[] = [teamApi, companiesApi, settingsApi, mastersApi, vouchersApi, reportsApi, billsApi, voucherEntryApi, costCentresApi, stockMastersApi, currenciesApi];

/**
 * The one entry of the API (`src/routes/api/$.ts` hands it every request under /api): every answer, from any area, any
 * refusal or the identity library, leaves through here with the application marker. The response is rebuilt because a
 * library's headers may be read-only.
 */
export async function handleApi(request: Request): Promise<Response> {
  const response = await answerApi(request);
  const headers = new Headers(response.headers);
  headers.set(appMarkerHeader, appMarkerValue);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function answerApi(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    // Discover's central request-forgery gate: every state-changing request must come from the application's own origin
    // (a missing Origin is refused too). Discover applies it to POST; here it covers every non-reading method, which
    // includes PUT /api/account/keymap. It runs first on every path, the health probes included.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.get('origin') !== getConfig().appUrl) {
      throw new FoundationError(403, 'This action must originate from the application.');
    }
    // The health probes then check the method as the other public paths do, but answer before the schema and role checks
    // below: liveness must not depend on the database, and readiness is that check itself (503, never an error). HEAD
    // answers as GET does, without the body.
    if (path === '/api/health/live' || path === '/api/health/ready') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
      const answer = path === '/api/health/live' ? json({ status: 'alive' })
        : await databaseReady() ? json({ status: 'ready' }) : json({ error: 'The installation is not ready. Check configuration and database migrations.' }, 503);
      return request.method === 'HEAD' ? new Response(null, { status: answer.status, headers: answer.headers }) : answer;
    }
    await assertSchema();
    // D-03: never serve as a role that would make row-level security inert.
    await assertRoles();
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
