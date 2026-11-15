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

/** A verify with a Cookie header written by hand. */
export async function verifyWith(cookie: string, code: string, path = '/api/auth/two-factor/verify-totp') {
  const response = await handleApi(new Request(new URL(path, getConfig().appUrl), { method: 'POST',
    headers: { cookie, origin: getConfig().appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ code }) }));
  return { status: response.status, body: await response.json() as { error?: string }, signedIn: response.headers.getSetCookie().some(line => line.replace(/^__Secure-/, "").startsWith(`${authCookiePrefix()}.session_token=`)) };
}
