import { createHash } from 'node:crypto';
import { z } from 'zod';
import { claimInstallation, getAuth } from '../auth.ts';
import { getConfig } from '../config.ts';
import { clientRateKey, clientRateLimit } from '../client-rate-limit.ts';
import { getDatabase } from '../db.ts';
import { acceptInvitation, inspectInvitation } from '../teams.ts';
import { readJson } from '../validation.ts';
import { json, limit, limitWindow, type ApiArea } from './http.ts';

function authRequest(request: Request, body?: string) {
  const headers = new Headers(request.headers);
  // Never let forwarding headers reach the identity library as client identity.
  for (const header of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'true-client-ip']) headers.delete(header);
  return new Request(request.url, { method: request.method, headers, ...(body === undefined ? {} : { body }) });
}

/** Session state, first-user setup, sign-out and the public invitation routes; reachable signed out. */
export const sessionApi: ApiArea = async ({ request, path }) => {
  const config = getConfig();
  // Neither route reveals a user when signed out; /api/status is the configured-only probe.
  if ((path === '/api/session' || path === '/api/status') && request.method === 'GET') {
    const { rows } = await getDatabase().pool.query("SELECT claimed FROM installation WHERE id='instance'");
    const configured = rows[0]?.claimed === true;
    if (path === '/api/status') return json({ configured });
    const session = configured ? await getAuth().api.getSession({ headers: request.headers }) : null;
    return json({ setupRequired: !configured, user: session ? { id: session.user.id, name: session.user.name, email: session.user.email } : null });
  }
  // While unclaimed, the first sign-up becomes instance operator and workspace owner, then is signed in.
  if (path === '/api/auth/setup' && request.method === 'POST') {
    const perClient = clientRateLimit(request, 'setup');
    await limitWindow(perClient.key, perClient.maximum, 15);
    const body = await readJson(request) as Parameters<typeof claimInstallation>[0];
    await claimInstallation(body);
    const signIn = await getAuth().handler(new Request(`${config.appUrl}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: config.appUrl },
      body: JSON.stringify({ email: body.email.trim().toLowerCase(), password: body.password }),
    }));
    if (!signIn.ok) return json({ error: 'Your owner account was created. Sign in to continue.' }, 409);
    const headers = new Headers();
    for (const cookie of signIn.headers.getSetCookie()) headers.append('set-cookie', cookie);
    return json({ ok: true }, 200, headers);
  }
  if (request.method === 'POST' && path === '/api/auth/sign-out') {
    const body = z.object({}).strict().parse(await readJson(request));
    return getAuth().handler(authRequest(request, JSON.stringify(body)));
  }
  // Every other identity-library route stays private.
  if (path.startsWith('/api/auth/')) return json({ error: 'Authentication route unavailable.' }, 404);
  if (request.method === 'POST' && (path === '/api/invitations/inspect' || path === '/api/invitations/accept')) {
    await limit(clientRateKey(request, 'invitations:public'), 60);
    const input = await readJson(request);
    const token = (input as { token?: unknown } | null)?.token;
    if (typeof token === 'string') await limit(`invitation:${createHash('sha256').update(token).digest('hex')}`, 10);
    if (path.endsWith('/inspect')) {
      const invitation = await inspectInvitation(input);
      return json({ workspaceName: invitation.workspace.name, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt, accountExists: invitation.accountExists });
    }
    const session = await getAuth().api.getSession({ headers: request.headers });
    const { workspaceId, created, email } = await acceptInvitation(input, session ? { id: session.user.id, email: session.user.email } : undefined);
    const accepted = { workspaceId, created, email };
    if (!accepted.created) return json({ ...accepted, signedIn: true });
    try {
      const signIn = await getAuth().handler(new Request(`${config.appUrl}/api/auth/sign-in/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: config.appUrl },
        body: JSON.stringify({ email: accepted.email, password: (input as { password: string }).password }),
      }));
      const headers = new Headers();
      for (const cookie of signIn.headers.getSetCookie()) headers.append('set-cookie', cookie);
      return json({ ...accepted, signedIn: signIn.ok }, 200, headers);
    } catch {
      // Membership remains committed if starting a session fails; the person can sign in normally.
      return json({ ...accepted, signedIn: false });
    }
  }
  return null;
};
