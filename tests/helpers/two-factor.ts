import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleApi } from '../../src/server/api.ts';
import { authCookiePrefix } from '../../src/server/auth.ts';
import { getConfig } from '../../src/server/config.ts';
import { asAdmin, browser, password, type Member } from './ledger.ts';

/** RFC 6238 code of `secret` (base32) for the 30-second step `step`. */
export function totp(secret: string, step: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0xf;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export const step = () => Math.floor(Date.now() / 30_000);

/** Turns the factor on for a signed-in member, confirming it with the code of the previous step. */
export async function enableFactor(member: Member): Promise<{ secret: string; backupCodes: string[] }> {
  const enabled = await member.browser.call('/api/account/two-factor/enable', { password });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const secret = new URL(enabled.body.totpURI).searchParams.get('secret')!;
  const confirmed = await member.browser.call('/api/account/two-factor/verify', { code: totp(secret, step() - 1) });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return { secret, backupCodes: enabled.body.backupCodes };
}

/** A new client of `member` signed in with the password, at the second step. */
export async function challenged(adminUrl: string, member: Member): Promise<Member> {
  const email = await asAdmin(adminUrl, async admin => (await admin.query('SELECT email FROM "user" WHERE id = $1', [member.userId])).rows[0].email as string);
  const client = { browser: browser(), userId: member.userId };
  const signIn = await client.browser.call('/api/auth/sign-in/email', { email, password });
  assert.deepEqual([signIn.status, signIn.body], [200, { twoFactorRedirect: true }]);
  return client;
}

/** Where a Set-Cookie line sends its cookie: the name, Path, Domain, HttpOnly, SameSite and Secure. */
export function cookieScope(line: string) {
  const [pair, ...attributes] = line.split(';').map(part => part.trim());
  const named = new Map(attributes.map(attribute => { const [key, ...value] = attribute.split('='); return [key.toLowerCase(), value.join('=')] as const; }));
  return { name: pair.slice(0, pair.indexOf('=')), path: named.get('path'), domain: named.get('domain'), httpOnly: named.has('httponly'), sameSite: named.get('samesite')?.toLowerCase(), secure: named.has('secure') };
}

/** The library's Set-Cookie line for the challenge cookie `name` when `member` signs in with the password, and the value. */
export async function challengeSetCookie(adminUrl: string, member: Member, name: string): Promise<{ line: string; value: string }> {
  const email = await asAdmin(adminUrl, async admin => (await admin.query('SELECT email FROM "user" WHERE id = $1', [member.userId])).rows[0].email as string);
  const response = await handleApi(new Request(new URL('/api/auth/sign-in/email', getConfig().appUrl), { method: 'POST',
    headers: { origin: getConfig().appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }));
  const line = response.headers.getSetCookie().find(candidate => candidate.startsWith(`${name}=`));
  assert.ok(line, response.headers.getSetCookie().join(' | '));
  return { line, value: line.slice(name.length + 1).split(';')[0] };
}

/** The refusal of a verify that sends the challenge cookie `name` twice (a planted copy first), and its clearing line. */
export async function duplicateRefusal(name: string, value: string) {
  const response = await handleApi(new Request(new URL('/api/auth/two-factor/verify-totp', getConfig().appUrl), { method: 'POST',
    headers: { cookie: `${name}=planted.x; ${name}=${value}`, origin: getConfig().appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ code: '000000' }) }));
  return { status: response.status, cleared: response.headers.getSetCookie().find(line => line.startsWith(`${name}=;`)) };
}

type StoredCookie = { name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean };

/**
 * A browser's cookie store, as strict as Chrome and Firefox where a challenge cookie meets it, over handleApi:
 * - a cookie is identified by name, domain, host-only or not, and path: a host-only cookie and one set with
 *   Domain=<its host> live side by side (the browsers store "host" and ".host"), and an expiry reaches only its own;
 * - a cookie is deleted only by Max-Age at zero or below or by an Expires in the past; an empty value is a value;
 * - a Set-Cookie whose Domain the host does not match is refused;
 * - a `__Secure-` name is stored only with `Secure`, and a `Secure` cookie is set and sent over https only;
 * - requests carry the cookies whose domain and path match, longer paths first.
 */
export class CookieJar {
  readonly stored: StoredCookie[] = [];
  private readonly url: URL;
  constructor(appUrl = getConfig().appUrl) { this.url = new URL(appUrl); }

  /** Puts a cookie in the store directly, as another page or subdomain could. */
  plant(cookie: Omit<StoredCookie, 'secure' | 'hostOnly'> & { hostOnly?: boolean }): void {
    this.stored.push({ hostOnly: true, ...cookie, secure: this.url.protocol === 'https:' });
  }

  /** POST with a JSON body (GET without one) from the application's own origin. */
  async call(path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const target = new URL(path, this.url);
    const headers = new Headers({ origin: getConfig().appUrl });
    const cookies = this.matching(target);
    if (cookies.length) headers.set('cookie', cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '));
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await handleApi(new Request(target, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    for (const line of response.headers.getSetCookie()) this.receive(line, target.pathname);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  names(): string[] { return this.stored.map(cookie => `${cookie.name} ${cookie.hostOnly ? '' : '.'}${cookie.domain}${cookie.path}`); }

  /** Stores, replaces or deletes as a browser does for a Set-Cookie line received in answer to `requestPath`. */
  receive(line: string, requestPath: string): void {
    const target = new URL(requestPath, this.url);
    const [pair, ...parts] = line.split(';').map(part => part.trim());
    const attributes = new Map(parts.map(part => { const [key, ...value] = part.split('='); return [key.toLowerCase(), value.join('=')] as const; }));
    const name = pair.slice(0, pair.indexOf('=')), value = pair.slice(pair.indexOf('=') + 1);
    const secure = attributes.has('secure');
    if ((name.startsWith('__Secure-') || secure) && (!secure || target.protocol !== 'https:')) return;
    const domainAttribute = attributes.get('domain')?.replace(/^\./, '').toLowerCase();
    if (domainAttribute !== undefined && target.hostname !== domainAttribute && !target.hostname.endsWith(`.${domainAttribute}`)) return;
    const hostOnly = domainAttribute === undefined, domain = domainAttribute ?? target.hostname;
    const path = attributes.get('path')?.startsWith('/') ? attributes.get('path')! : (target.pathname.slice(0, target.pathname.lastIndexOf('/')) || '/');
    const maxAge = attributes.get('max-age'), expires = attributes.get('expires');
    const expired = maxAge !== undefined ? Number(maxAge) <= 0 : expires !== undefined && Date.parse(expires) <= Date.now();
    const index = this.stored.findIndex(cookie => cookie.name === name && cookie.domain === domain && cookie.hostOnly === hostOnly && cookie.path === path);
    if (index >= 0) this.stored.splice(index, 1);
    if (!expired) this.stored.push({ name, value, domain, hostOnly, path, secure });
  }

  private matching(target: URL): StoredCookie[] {
    const host = target.hostname;
    return this.stored
      .filter(cookie => (cookie.hostOnly ? host === cookie.domain : host === cookie.domain || host.endsWith(`.${cookie.domain}`))
        && (target.pathname === cookie.path || target.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`))
        && (!cookie.secure || target.protocol === 'https:'))
      .sort((a, b) => b.path.length - a.path.length);
  }
}

/**
 * The copies of the challenge cookie this host can plant that a verify request carries beside the real one: host-only on
 * every path the verify route matches except the real cookie's own (`/`), and with Domain=<host> on the root and on the
 * route's directory.
 */
export const plantings = (host: string) => [
  ...['/api', '/api/', '/api/auth', '/api/auth/', '/api/auth/two-factor', '/api/auth/two-factor/', '/api/auth/two-factor/verify-totp'].map(path => ({ domain: host, hostOnly: true, path })),
  ...['/', '/api/auth/two-factor'].map(path => ({ domain: host, hostOnly: false, path })),
];

/**
 * Plants a second challenge cookie of the name the server reads (as `plant` places it), signs `member` in, and verifies
 * with `code` twice: the first verify meets the duplicate (401, with the server's clearing cookies), the second follows a
 * new sign-in in the same store. Returns both answers and the store's cookies in between.
 */
export async function plantedThenSignIn(adminUrl: string, member: Member, code: string, name: string, plant: { domain: string; hostOnly: boolean; path: string }) {
  const email = await asAdmin(adminUrl, async admin => (await admin.query('SELECT email FROM "user" WHERE id = $1', [member.userId])).rows[0].email as string);
  const jar = new CookieJar();
  jar.plant({ name, value: `2fa-${'p'.repeat(20)}.planted`, ...plant });
  assert.deepEqual((await jar.call('/api/auth/sign-in/email', { email, password })).body, { twoFactorRedirect: true });
  const first = await jar.call('/api/auth/two-factor/verify-totp', { code });
  const between = jar.names();
  assert.deepEqual((await jar.call('/api/auth/sign-in/email', { email, password })).body, { twoFactorRedirect: true });
  const second = await jar.call('/api/auth/two-factor/verify-totp', { code });
  const me = await jar.call('/api/me');
  return { first: first.status, second: second.status, signedIn: me.status === 200, between };
}

/** A verify with a Cookie header written by hand. */
export async function verifyWith(cookie: string, code: string, path = '/api/auth/two-factor/verify-totp') {
  const response = await handleApi(new Request(new URL(path, getConfig().appUrl), { method: 'POST',
    headers: { cookie, origin: getConfig().appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ code }) }));
  return { status: response.status, body: await response.json() as { error?: string }, signedIn: response.headers.getSetCookie().some(line => line.replace(/^__Secure-/, "").startsWith(`${authCookiePrefix()}.session_token=`)) };
}
