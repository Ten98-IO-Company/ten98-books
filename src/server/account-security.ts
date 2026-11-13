import { createHash, randomUUID } from 'node:crypto';
import { getSessionCookie, parseCookies } from 'better-auth/cookies';
import { verifyPassword } from 'better-auth/crypto';
import { ten98AuthPolicy } from '@ten98/runtime/auth';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError, getAuth } from './auth.ts';
import { getConfig } from './config.ts';
import { clientRateKey, clientRateLimit, emailLimitKey } from './client-rate-limit.ts';
import { getDatabase } from './db.ts';
import { getEmailStatus, sendTransactionalEmail } from './email.ts';
import { readJson } from './validation.ts';
import { toJson } from './api/http.ts';
import { accountPreferencesDefaults, accountPreferencesDtoSchema, accountPreferencesInputSchema, accountPreferencesMaxRevision, type AccountPreferencesDto } from '../lib/account-preferences.ts';

// Per-minute counts shared with the other Ten98 apps; `limit` counts in one-minute windows (windowSeconds).
const limits = ten98AuthPolicy.rateLimits;

type Auth = ReturnType<typeof getAuth>;
const currentPassword = z.string().min(1).max(128);
const passwordInput = z.object({ password: currentPassword }).strict();
const codeInput = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const backupInput = z.object({ code: z.string().regex(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{15}$/) }).strict();
const signInInput = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: currentPassword }).strict();
const recoveryEmailInput = signInInput.pick({ email: true }).strict();
const disableInput = z.object({ password: currentPassword, code: codeInput.shape.code.optional(), backupCode: backupInput.shape.code.optional() }).strict();
const resetPasswordInput = z.object({ token: z.string().length(24).regex(/^[A-Za-z0-9]{24}$/), newPassword: z.string().min(12).max(128) }).strict();
const invalidReset = 'This reset link is invalid, expired or already used. Request a new link and use a password between 12 and 128 characters.';
const accountInputs = {
  '/api/account/password': z.object({ currentPassword, newPassword: z.string().min(12).max(128) }).strict(),
  '/api/account/sessions/revoke': z.object({ sessionId: z.string().min(1).max(128) }).strict(),
  '/api/account/sessions/revoke-others': z.object({}).strict(),
  '/api/account/two-factor/enable': passwordInput,
  '/api/account/two-factor/verify': codeInput,
  '/api/account/two-factor/disable': disableInput,
  '/api/account/two-factor/recovery-codes': passwordInput,
} as const;

function parsed<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new FoundationError(400, 'Check the submitted fields and try again.');
  return result.data;
}

/** Copies only the identity library's cookies from `source`; the body goes through the app's one JSON writer. */
function json(body: unknown, status = 200, source?: Response): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  for (const cookie of source?.headers.getSetCookie() ?? []) headers.append('set-cookie', cookie);
  return new Response(toJson(body), { status, headers });
}

type Limit = (key: string, maximum: number) => Promise<void>;

async function transaction(run: (client: PoolClient, auth: Auth) => Promise<Response>): Promise<Response> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const response = await run(client, getAuth(client));
    // Failed factor responses deliberately commit their attempt/lockout counters.
    // Unexpected failures roll back all account changes and no cookies escape.
    if (response.status >= 500) throw new FoundationError(503, 'Account security is temporarily unavailable. Try again.');
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw new FoundationError(503, 'Account security could not be saved. Try again.');
    return response;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function invoke(auth: Auth, request: Request, path: string, body: unknown): Promise<Response> {
  // Only these browser headers are needed; never accept forwarding headers as identity.
  const headers = new Headers({ 'content-type': 'application/json', origin: getConfig().appUrl });
  for (const name of ['cookie', 'user-agent']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return auth.handler(new Request(`${getConfig().appUrl}/api/auth${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
}

function rejected(response: Response, message: string, status = response.status): Response {
  return json({ error: response.status === 429 ? 'Too many attempts. Wait before trying again.' : message }, status, response);
}

function responseHeaders(request: Request, response: Response): Headers {
  const cookies = parseCookies(request.headers.get('cookie') ?? '');
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.slice(0, cookie.indexOf(';') < 0 ? undefined : cookie.indexOf(';'));
    for (const [name, value] of parseCookies(pair)) cookies.set(name, value);
  }
  return new Headers({ cookie: [...cookies].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ') });
}

async function revokeOtherSessions(client: PoolClient, userId: string, sessionId: string) {
  await client.query('DELETE FROM session WHERE "userId"=$1 AND id<>$2', [userId, sessionId]);
  await invalidateChallenges(client, userId);
}

/** `alreadyRemoved` names challenges deleted earlier in this transaction, whose attempt records remain. */
async function invalidateChallenges(client: PoolClient, userId: string, alreadyRemoved: readonly string[] = []) {
  await client.query(
    `WITH removed AS (DELETE FROM verification WHERE value=$1
       AND (identifier LIKE '2fa-%' OR identifier LIKE 'trust-device-%' OR identifier LIKE 'reset-password:%') RETURNING identifier),
     challenges AS (SELECT identifier FROM removed UNION SELECT unnest($2::text[]))
     DELETE FROM verification WHERE identifier IN (SELECT '2fa-attempts-' || identifier FROM challenges)`, [userId, alreadyRemoved],
  );
}

async function keepResponseSession(client: PoolClient, auth: Auth, request: Request, response: Response, userId: string) {
  const current = await auth.api.getSession({ headers: responseHeaders(request, response), query: { disableRefresh: true } });
  if (!current || current.user.id !== userId) throw new FoundationError(503, 'Sign-in could not be updated. Try again.');
  await revokeOtherSessions(client, userId, current.session.id);
}

async function isRepeatedCode(client: PoolClient, userId: string, code: string): Promise<boolean> {
  const key = `totp-used:${userId}:${createHash('sha256').update(code).digest('hex')}`;
  const found = await client.query('SELECT 1 FROM verification WHERE identifier=$1 AND "expiresAt">clock_timestamp()', [key]);
  return !!found.rowCount;
}

async function rememberCode(client: PoolClient, userId: string, code: string) {
  // The library validates TOTP. This ledger only prevents reusing an accepted
  // code across separate challenges in its adjacent 30-second time windows.
  await client.query("DELETE FROM verification WHERE identifier LIKE 'totp-used:%' AND \"expiresAt\"<=clock_timestamp()");
  await client.query('INSERT INTO verification(id,identifier,value,"expiresAt") VALUES($1,$2,\'used\',clock_timestamp()+interval \'90 seconds\')',
    [randomUUID(), `totp-used:${userId}:${createHash('sha256').update(code).digest('hex')}`]);
}

async function requireFactorProof(client: PoolClient, request: Request, userId: string, details: { code?: string; backupCode?: string }) {
  if ((!details.code && !details.backupCode) || (details.code && details.backupCode)) throw new FoundationError(400, 'Enter an authenticator code or a recovery code to verify this action.');
  if (details.code && await isRepeatedCode(client, userId, details.code)) throw new FoundationError(409, 'Wait for the next authenticator code, then try again.');
  const response = await invoke(getAuth(client), request, details.code ? '/two-factor/verify-totp' : '/two-factor/verify-backup-code', { code: details.code ?? details.backupCode });
  if (!response.ok) throw new FoundationError(400, 'The verification code was not accepted.');
  if (details.code) await rememberCode(client, userId, details.code);
}

export async function handleAccountSecurity(request: Request, limit: Limit): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, '');
  // Exact public routes only; the upstream callback/token and proof APIs stay private.
  if (['/api/auth/password-reset-status', '/api/auth/request-password-reset', '/api/auth/reset-password'].includes(url.pathname)) {
    const status = url.pathname === '/api/auth/password-reset-status', asking = url.pathname === '/api/auth/request-password-reset';
    if (request.method !== (status ? 'GET' : 'POST')) return json({ error: 'Method not allowed.' }, 405);
    if (url.search || url.hash) throw new FoundationError(400, 'Password recovery does not accept URL parameters.');
    if (status) {
      if (request.body !== null || request.headers.has('transfer-encoding') || request.headers.has('content-length') && request.headers.get('content-length')?.trim() !== '0') throw new FoundationError(400, 'Read recovery availability without a request body.');
      return json({ configured: getEmailStatus().configured });
    }
    await limit(clientRateKey(request, `password-recovery:${asking ? 'request' : 'reset'}`), asking ? limits.resetRequestPerClient : limits.resetPerClient);
    const input = await readJson(request);
    if (asking) {
      const details = parsed(recoveryEmailInput, input);
      await limit(emailLimitKey('password-recovery:email', details.email), limits.resetRequestPerEmail);
      if (!getEmailStatus().configured) throw new FoundationError(503, 'Email recovery is not configured. Contact the installation operator.');
      const captured: { message?: { to: string; token: string } } = {};
      try {
        await transaction(async client => {
          const user = (await client.query<{ id: string; email: string }>('SELECT id,email FROM "user" WHERE lower(email)=$1 FOR UPDATE', [details.email])).rows[0];
          const credential = await client.query('SELECT id FROM account WHERE "userId"=$1 AND "providerId"=\'credential\' AND password IS NOT NULL FOR UPDATE', [user?.id ?? '']);
          if (!user || !credential.rowCount) return json({ ok: true });
          const auth = getAuth(client, message => {
            if (message.userId !== user.id || message.email !== user.email || message.token.length !== 24 || !/^[A-Za-z0-9]{24}$/.test(message.token)) throw new FoundationError(503, 'Password recovery is temporarily unavailable.');
            captured.message = { to: message.email, token: message.token };
          });
          const response = await invoke(auth, request, '/request-password-reset', details);
          if (!response.ok || !captured.message) throw new FoundationError(503, 'Password recovery is temporarily unavailable.');
          return json({ ok: true });
        });
      } catch {
        // Issuance and delivery failures must not disclose whether an address has a local account.
        return json({ ok: true });
      }
      if (captured.message) {
        const message = captured.message, link = new URL(`/#password-reset=${message.token}`, getConfig().appUrl).href;
        // No PoolClient/auth instance survives into delivery, and no automatic retry is scheduled.
        setImmediate(() => { void sendTransactionalEmail({ to: message.to, subject: 'Reset your Books password', text: `A password reset was requested for your Books account.\n\nOpen this link within one hour:\n${link}\n\nThe link works once. Your existing two-factor settings and recovery codes stay unchanged. If you did not request this, ignore this email.` }).catch(() => undefined); });
      }
      return json({ ok: true });
    }
    const rawToken = input !== null && typeof input === 'object' && 'token' in input && typeof input.token === 'string' ? input.token : '';
    await limit(`password-recovery:token:${createHash('sha256').update(rawToken).digest('hex')}`, limits.resetPerToken);
    const details = resetPasswordInput.safeParse(input);
    if (!details.success) throw new FoundationError(400, invalidReset);
    return transaction(async (client, auth) => {
      const identifier = `reset-password:${details.data.token}`;
      // The untrusted token lookup is only a lock hint. Recheck after user -> credential locks.
      const hint = (await client.query<{ value: string }>('SELECT value FROM verification WHERE identifier=$1', [identifier])).rows[0];
      if (!hint) throw new FoundationError(400, invalidReset);
      const user = await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [hint.value]);
      const credential = await client.query('SELECT id FROM account WHERE "userId"=$1 AND "providerId"=\'credential\' AND password IS NOT NULL FOR UPDATE', [hint.value]);
      const verification = await client.query('SELECT id FROM verification WHERE identifier=$1 AND value=$2 AND "expiresAt">clock_timestamp() FOR UPDATE', [identifier, hint.value]);
      if (!user.rowCount || !credential.rowCount || verification.rowCount !== 1) throw new FoundationError(400, invalidReset);
      // The auth reset deletes the account's pending challenges itself; name them first so their records go too.
      const challenges = (await client.query<{ identifier: string }>("SELECT identifier FROM verification WHERE value=$1 AND identifier LIKE '2fa-%' FOR UPDATE", [hint.value])).rows.map(row => row.identifier);
      const response = await invoke(auth, request, '/reset-password', details.data);
      if (!response.ok) throw new FoundationError(response.status >= 500 ? 503 : 400, response.status >= 500 ? 'Password recovery is temporarily unavailable. Try again.' : invalidReset);
      await invalidateChallenges(client, hint.value, challenges);
      return json({ ok: true });
    });
  }
  if (path === '/api/account/preferences') return handleAccountPreferences(request, limit);
  const signIn = path === '/api/auth/sign-in/email';
  const challenge = path === '/api/auth/two-factor/verify-totp' || path === '/api/auth/two-factor/verify-backup-code';
  const status = path === '/api/account/security';
  const mutation = Object.hasOwn(accountInputs, path);
  if (!signIn && !challenge && !status && !mutation) return null;
  if (request.method !== (status ? 'GET' : 'POST')) return json({ error: 'Method not allowed.' }, 405);
  const input = status ? undefined : await readJson(request);

  if (signIn) {
    const details = parsed(signInInput, input);
    const perClient = clientRateLimit(request, 'signin');
    await limit(perClient.key, perClient.maximum);
    await limit(emailLimitKey('signin', details.email), limits.signInPerEmail);
    return transaction(async (client, auth) => {
      await client.query('SELECT id FROM "user" WHERE lower(email)=$1 FOR UPDATE', [details.email]);
      const response = await invoke(auth, request, '/sign-in/email', details);
      if (!response.ok) return rejected(response, 'Email or password is incorrect.');
      const data = await response.json();
      return json(data.twoFactorRedirect === true ? { twoFactorRedirect: true } : { ok: true }, 200, response);
    });
  }

  if (challenge) {
    const totp = path.endsWith('/verify-totp');
    const details = parsed(totp ? codeInput : backupInput, input);
    const perClient = clientRateLimit(request, 'two-factor');
    await limit(perClient.key, perClient.maximum);
    const cookie = getSessionCookie(request, { cookieName: 'two_factor' }) ?? '';
    await limit(`two-factor:${createHash('sha256').update(cookie).digest('hex')}`, limits.twoFactorPerChallenge);
    return transaction(async (client, auth) => {
      if (await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } })) {
        return json({ error: 'This sign-in is already complete.' }, 409);
      }
      // An untrusted cookie prefix is only a lock hint, never authentication.
      // Better Auth validates the signed cookie and consumes the challenge below.
      const identifier = cookie.split('.')[0];
      const pending = await client.query<{ value: string }>('SELECT value FROM verification WHERE identifier=$1 AND "expiresAt">clock_timestamp()', [identifier]);
      const userId = pending.rows[0]?.value;
      if (userId) await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId]);
      if (totp && userId && await isRepeatedCode(client, userId, details.code)) return json({ error: 'Wait for the next authenticator code, then try again.' }, 409);
      const response = await invoke(auth, request, totp ? '/two-factor/verify-totp' : '/two-factor/verify-backup-code', details);
      if (!response.ok) return rejected(response, 'The code was not accepted. Try another code or sign in again.');
      if (totp && userId) await rememberCode(client, userId, details.code);
      return json({ ok: true }, 200, response);
    });
  }

  if (mutation) parsed(accountInputs[path as keyof typeof accountInputs], input);
  const identity = await getAuth().api.getSession({ headers: request.headers, query: { disableRefresh: true } });
  if (!identity) throw new FoundationError(401, 'Sign in to continue.');
  await limit(`account-security:${status ? 'read' : 'write'}:${identity.user.id}`, status ? limits.accountSecurityReadsPerUser : limits.accountSecurityWritesPerUser);
  return transaction(async (client, auth) => {
    await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [identity.user.id]);
    const current = await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } });
    if (!current || current.user.id !== identity.user.id) throw new FoundationError(401, 'Sign in to continue.');
    const userId = current.user.id;
    if (status) {
      const sessions = await client.query('SELECT id,"createdAt","expiresAt","userAgent" FROM session WHERE "userId"=$1 AND "expiresAt">clock_timestamp() ORDER BY "createdAt" DESC,id LIMIT 100', [userId]);
      const credential = await client.query("SELECT 1 FROM account WHERE \"userId\"=$1 AND \"providerId\"='credential' AND password IS NOT NULL", [userId]);
      return json({
        user: { id: userId, name: current.user.name, email: current.user.email, twoFactorEnabled: current.user.twoFactorEnabled === true },
        hasPassword: !!credential.rowCount,
        sessions: sessions.rows.map((session) => ({ ...session, current: session.id === current.session.id })),
      });
    }
    if (path === '/api/account/sessions/revoke') {
      const { sessionId } = parsed(accountInputs[path], input);
      const removed = await client.query('DELETE FROM session WHERE id=$1 AND "userId"=$2 RETURNING id', [sessionId, userId]);
      if (!removed.rowCount) throw new FoundationError(404, 'Session not found or unavailable.');
      await invalidateChallenges(client, userId);
      const signedOut = sessionId === current.session.id;
      const response = signedOut ? await invoke(auth, request, '/sign-out', {}) : undefined;
      return json({ ok: true, signedOut }, 200, response);
    }
    if (path === '/api/account/sessions/revoke-others') {
      await revokeOtherSessions(client, userId, current.session.id);
      return json({ ok: true });
    }
    if (path === '/api/account/password') {
      const response = await invoke(auth, request, '/change-password', { ...parsed(accountInputs[path], input), revokeOtherSessions: true });
      if (!response.ok) return rejected(response, 'The current password was not accepted.');
      await keepResponseSession(client, auth, request, response, userId);
      return json({ ok: true }, 200, response);
    }
    if (path === '/api/account/two-factor/enable') {
      const response = await invoke(auth, request, '/two-factor/enable', { ...parsed(passwordInput, input), method: 'totp' });
      if (!response.ok) return rejected(response, current.user.twoFactorEnabled ? 'Two-factor authentication is already enabled.' : 'The current password was not accepted.');
      const data = await response.json();
      return json({ totpURI: data.totpURI, backupCodes: data.backupCodes }, 200, response);
    }
    if (path === '/api/account/two-factor/verify') {
      const factor = await client.query('SELECT verified FROM "twoFactor" WHERE "userId"=$1', [userId]);
      if (!factor.rowCount || factor.rows[0].verified) throw new FoundationError(409, 'Start authenticator setup before confirming a code.');
      const details = parsed(codeInput, input);
      if (await isRepeatedCode(client, userId, details.code)) return json({ error: 'Wait for the next authenticator code, then try again.' }, 409);
      const response = await invoke(auth, request, '/two-factor/verify-totp', details);
      if (!response.ok) return rejected(response, 'The authenticator code was not accepted.', response.status === 401 ? 400 : response.status);
      await rememberCode(client, userId, details.code);
      await keepResponseSession(client, auth, request, response, userId);
      return json({ ok: true, twoFactorEnabled: true }, 200, response);
    }
    if (path === '/api/account/two-factor/disable') {
      const details = parsed(accountInputs[path], input);
      const credential = await client.query<{ password: string }>("SELECT password FROM account WHERE \"userId\"=$1 AND \"providerId\"='credential' AND password IS NOT NULL", [userId]);
      // The password is checked before the factor so a refused password never consumes a recovery code or authenticator window.
      if (!credential.rowCount || !await verifyPassword({ hash: credential.rows[0].password, password: details.password })) throw new FoundationError(400, 'The current password was not accepted.');
      // Turning off two-factor needs the second factor as well as the password.
      if (current.user.twoFactorEnabled) await requireFactorProof(client, request, userId, details);
      const response = await invoke(auth, request, '/two-factor/disable', { password: details.password });
      if (!response.ok) return rejected(response, 'The current password was not accepted.');
      await keepResponseSession(client, auth, request, response, userId);
      return json({ ok: true, twoFactorEnabled: false }, 200, response);
    }
    const response = await invoke(auth, request, '/two-factor/generate-backup-codes', parsed(passwordInput, input));
    if (!response.ok) return rejected(response, 'Check your password and enable two-factor authentication before replacing recovery codes.');
    const data = await response.json();
    await revokeOtherSessions(client, userId, current.session.id);
    return json({ backupCodes: data.backupCodes }, 200, response);
  });
}

async function preferencesDto(client: PoolClient, userId: string): Promise<AccountPreferencesDto> {
  const row = (await client.query(`SELECT u.id,u.name,u.email,p.time_zone,p.locale,p.theme,p.revision,p.updated_at
    FROM "user" u LEFT JOIN user_preference p ON p.user_id=u.id WHERE u.id=$1`, [userId])).rows[0];
  if (!row) throw new FoundationError(401, 'Sign in to continue.');
  const result = accountPreferencesDtoSchema.safeParse({ version: 'account-preferences-v1', user: { id: row.id, name: row.name, email: row.email }, preferences: row.revision === null
    ? { ...accountPreferencesDefaults, revision: 0, updatedAt: null }
    : { revision: row.revision, timeZone: row.time_zone, locale: row.locale, theme: row.theme, updatedAt: row.updated_at.toISOString() } });
  if (!result.success) throw new FoundationError(503, 'Saved account preferences are unavailable. Try again.');
  return result.data;
}

async function handleAccountPreferences(request: Request, limit: Limit): Promise<Response> {
  if (!['GET', 'POST'].includes(request.method)) { const response = json({ error: 'Method not allowed.' }, 405); response.headers.set('allow', 'GET, POST'); return response; }
  if (new URL(request.url).search) throw new FoundationError(400, 'Account preferences do not accept query parameters.');
  const writing = request.method === 'POST';
  if (!writing && (request.body !== null || request.headers.has('transfer-encoding') || request.headers.has('content-length') && request.headers.get('content-length')?.trim() !== '0')) throw new FoundationError(400, 'Read account preferences without a request body.');
  const input = writing ? parsed(accountPreferencesInputSchema, await readJson(request)) : null;
  const identity = await getAuth().api.getSession({ headers: request.headers, query: { disableRefresh: true } });
  if (!identity) throw new FoundationError(401, 'Sign in to continue.');
  await limit(`account-preferences:${writing ? 'write' : 'read'}:${identity.user.id}`, writing ? 30 : 120);
  return transaction(async (client, auth) => {
    await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [identity.user.id]);
    // Same user -> session order as revocation; keep sign-out from racing the save.
    const locked = (await client.query('SELECT 1 FROM session WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR UPDATE', [identity.session.id, identity.user.id])).rowCount;
    if (!locked) throw new FoundationError(401, 'Sign in to continue.');
    const current = await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } });
    if (!current || current.user.id !== identity.user.id || current.session.id !== identity.session.id) throw new FoundationError(401, 'Sign in to continue.');
    const before = await preferencesDto(client, current.user.id);
    if (input === null) return json(before);
    const previous = before.preferences;
    if (input.expectedRevision !== previous.revision) throw new FoundationError(409, 'Your preferences changed elsewhere. Reload them before saving again.');
    if (previous.revision > 0 && input.name === before.user.name && input.timeZone === previous.timeZone && input.locale === previous.locale && input.theme === previous.theme) return json(before);
    if (previous.revision === accountPreferencesMaxRevision) throw new FoundationError(409, 'The preference revision limit was reached. Contact the installation operator.');
    const updated = input.name === before.user.name ? undefined : await invoke(auth, request, '/update-user', { name: input.name });
    if (updated && !updated.ok) throw new FoundationError(503, 'Your profile could not be saved. Try again.');
    await client.query(`INSERT INTO user_preference(user_id,time_zone,locale,theme,revision,updated_at) VALUES($1,$2,$3,$4,1,clock_timestamp())
      ON CONFLICT(user_id) DO UPDATE SET time_zone=EXCLUDED.time_zone,locale=EXCLUDED.locale,theme=EXCLUDED.theme,revision=user_preference.revision+1,updated_at=clock_timestamp()`, [current.user.id, input.timeZone, input.locale, input.theme]);
    return json(await preferencesDto(client, current.user.id), 200, updated);
  });
}
