import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { assertSchema, getDatabase } from './db.ts';
import { handleAccountSecurity } from './account-security.ts';
import { requireWorkspaceFactor } from './teams.ts';
import { assertDatabaseRoles, DatabaseRoleError } from './tenancy.ts';
import { InputError } from './validation.ts';
import { json, limit, signedIn, type ApiArea, type SignedInArea } from './api/http.ts';
import { sessionApi } from './api/session.ts';
import { teamApi } from './api/team.ts';
import { companiesApi } from './api/companies.ts';

// Checked once per process (and bundle) after it first passes: the role and its RLS guarantees do not change at runtime.
let rolesChecked: Promise<void> | undefined;
const assertRoles = () => (rolesChecked ??= assertDatabaseRoles(getDatabase().pool).catch(error => { rolesChecked = undefined; throw error; }));

const accountApi: ApiArea = ({ request }) => handleAccountSecurity(request, limit);

// The route table: public areas first, then areas that require a signed-in user. Each area answers only its own paths.
const publicAreas: readonly ApiArea[] = [accountApi, sessionApi];
const signedInAreas: readonly SignedInArea[] = [teamApi, companiesApi];

export async function handleApi(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    if (path === '/api/health/live' && request.method === 'GET') return json({ status: 'alive' });
    await assertSchema();
    // D-03: never serve as a role that would make row-level security inert.
    await assertRoles();
    if (path === '/api/health/ready' && request.method === 'GET') return json({ status: 'ready' });
    const context = { request, url, path };
    for (const area of publicAreas) {
      const response = await area(context);
      if (response) return response;
    }
    const user = await signedIn(request);
    // Every route below is under /api/(workspaces|companies)/<id> except GET /api/me and POST /api/workspaces, which stay reachable.
    await requireWorkspaceFactor(path, user.id);
    for (const area of signedInAreas) {
      const response = await area({ ...context, user });
      if (response) return response;
    }
    return json({ error: 'Route unavailable.' }, 404);
  } catch (error) {
    if (error instanceof FoundationError || error instanceof InputError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return json({ error: 'Check the submitted fields and try again.' }, 400);
    if (error instanceof DatabaseRoleError) { console.error(error.message); return json({ error: 'The installation is not ready. Check the database roles.' }, 503); }
    const code = (error as { code?: string })?.code;
    if (code === '23505') return json({ error: 'This item already exists in the workspace.' }, 409);
    if (['SCHEMA_MISMATCH', '42P01', '42703', 'ECONNREFUSED', 'ENOTFOUND'].includes(code ?? '')) return json({ error: 'The installation is not ready. Check configuration and database migrations.' }, 503);
    console.error('Application request failed; inspect configuration and database availability.');
    return json({ error: 'The request could not be completed. Try again or contact your operator.' }, 500);
  }
}
