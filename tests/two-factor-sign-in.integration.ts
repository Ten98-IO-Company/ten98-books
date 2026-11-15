import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/server/api.ts';
import { authCookiePrefix } from '../src/server/auth.ts';
import { getConfig } from '../src/server/config.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, browser, invite, password, setupOwner, type Member } from './helpers/ledger.ts';

/**
 * The second step of sign-in, through the real handler and the real auth preset (its own cookie prefix, as in
 * production): an authenticator code is accepted once, across challenges and on the account page; each challenge has its
 * own limiter key; a request without a challenge is refused before the library runs.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let second: Member;
const secrets = new Map<string, string>();
const backupCodes = new Map<string, string[]>();

before(async () => {
  database = await freshDatabase('two_factor_sign_in');
  owner = await setupOwner();
  second = await invite(owner.browser, owner.workspaceId, 'editor');
  for (const member of [owner, second]) secrets.set(member.userId, await enableFactor(member));
});
after(async () => { await database?.drop(); });

/** RFC 6238 code of `secret` (base32) for the 30-second step `step`. */
function totp(secret: string, step: number): string {
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
const step = () => Math.floor(Date.now() / 30_000);
const emailOf = (userId: string) => asAdmin(database.adminUrl, async admin => (await admin.query('SELECT email FROM "user" WHERE id = $1', [userId])).rows[0].email as string);

/** Turns the factor on for a signed-in member, confirming it with the code of the previous step; returns the secret. */
async function enableFactor(member: Member): Promise<string> {
  const enabled = await member.browser.call('/api/account/two-factor/enable', { password });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const secret = new URL(enabled.body.totpURI).searchParams.get('secret')!;
  backupCodes.set(member.userId, enabled.body.backupCodes);
  const confirmed = await member.browser.call('/api/account/two-factor/verify', { code: totp(secret, step() - 1) });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return secret;
}

/** A new client signed in with the password, at the second step. */
async function challenged(member: Member): Promise<Member> {
  const client = { browser: browser(), userId: member.userId };
  const signIn = await client.browser.call('/api/auth/sign-in/email', { email: await emailOf(member.userId), password });
  assert.deepEqual([signIn.status, signIn.body], [200, { twoFactorRedirect: true }]);
  return client;
}

test('the challenge cookie carries the prefix the server reads it under', async () => {
  const client = await challenged(owner);
  const names = [...client.browser.cookies.keys()];
  assert.ok(names.some(name => name === `${authCookiePrefix()}.two_factor` || name === `__Secure-${authCookiePrefix()}.two_factor`), names.join(', '));
});

test('a code that signed one client in is refused at a second challenge and on the account page', async () => {
  const code = totp(secrets.get(owner.userId)!, step());
  const first = await challenged(owner);
  const accepted = await first.browser.call('/api/auth/two-factor/verify-totp', { code });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal((await first.browser.call('/api/me')).status, 200);
  const used = await asAdmin(database.adminUrl, async admin => Number((await admin.query("SELECT count(*) FROM verification WHERE identifier LIKE 'totp-used:' || $1 || ':%'", [owner.userId])).rows[0].count));
  assert.ok(used >= 1, 'the accepted code is remembered');

  const again = await challenged(owner);
  const replay = await again.browser.call('/api/auth/two-factor/verify-totp', { code });
  assert.deepEqual([replay.status, replay.body.error], [409, 'Wait for the next authenticator code, then try again.']);
  assert.equal((await again.browser.call('/api/me')).status, 401, 'the second client is not signed in');

  // The account action that takes a code (turning the factor off) refuses it too, and the factor stays on.
  const disable = await first.browser.call('/api/account/two-factor/disable', { password, code });
  assert.deepEqual([disable.status, disable.body.error], [409, 'Wait for the next authenticator code, then try again.']);
  assert.equal((await first.browser.call('/api/account/security')).body.user.twoFactorEnabled, true);
});

test('a verify without a challenge, or with one that is not pending, is refused before the library, in the same words', async () => {
  const code = totp(secrets.get(second.userId)!, step());
  const none = await browser().call('/api/auth/two-factor/verify-totp', { code });
  const forged = browser();
  forged.cookies.set(`${authCookiePrefix()}.two_factor`, 'no-such-challenge.signature');
  const unknown = await forged.call('/api/auth/two-factor/verify-totp', { code });
  assert.deepEqual([none.status, none.body], [401, { error: 'The code was not accepted. Try another code or sign in again.' }]);
  assert.deepEqual([unknown.status, unknown.body], [none.status, none.body], 'a missing and an unknown challenge answer alike');
  assert.equal((await forged.call('/api/me')).status, 401);
  // The old handler sent these on to the library (which also refused) and counted them under one shared key, sha256('').
  const shared = await asAdmin(database.adminUrl, async admin => (await admin.query('SELECT count(*)::int AS n FROM request_limit WHERE key = $1', [`two-factor:${createHash('sha256').update('').digest('hex')}`])).rows[0].n);
  assert.equal(shared, 0, 'no request is counted under the empty key');
});

test('each challenge has its own limiter key: exhausting one user\'s does not limit another user\'s', async () => {
  const exhausted = await challenged(owner);
  // The library ends the challenge after its own failed-attempt lockout and clears the cookie; a client that keeps sending
  // the cookie anyway still spends that challenge's count.
  const kept = [...exhausted.browser.cookies];
  const attempt = async () => { for (const [name, value] of kept) exhausted.browser.cookies.set(name, value); return (await exhausted.browser.call('/api/auth/two-factor/verify-totp', { code: '000000' })).status; };
  for (let count = 0; count < 10; count += 1) assert.notEqual(await attempt(), 429, `attempt ${count + 1}`);
  assert.equal(await attempt(), 429, 'the eleventh attempt on one challenge');
  // Only the per-client ceilings are shared by these test requests (no client address: `<scope>:unresolved`): clear them,
  // keep the per-challenge counts.
  await asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit WHERE key LIKE '%:unresolved' OR key NOT LIKE 'two-factor:%'"));
  const other = await challenged(second);
  const accepted = await other.browser.call('/api/auth/two-factor/verify-totp', { code: totp(secrets.get(second.userId)!, step()) });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const keys = await asAdmin(database.adminUrl, async admin => (await admin.query("SELECT DISTINCT key FROM request_limit WHERE key LIKE 'two-factor:%' AND key <> 'two-factor:unresolved'")).rows.map(row => row.key as string));
  assert.ok(keys.length >= 2, keys.join(', '));
  assert.ok(!keys.includes(`two-factor:${createHash('sha256').update('').digest('hex')}`), 'no challenge is keyed by an empty cookie');
});

// ---- The cookie the handler checks is the cookie the library verifies ----

const challengeName = () => `${authCookiePrefix()}.two_factor`;
/** The challenge cookie value of a client at the second step. */
const challengeOf = (client: Member) => client.browser.cookies.get(challengeName())!;
const identifierOf = (value: string) => decodeURIComponent(value).split('.')[0];
/** A verify with a Cookie header written by hand. */
async function verifyWith(cookie: string, code: string, path = '/api/auth/two-factor/verify-totp') {
  const response = await handleApi(new Request(new URL(path, getConfig().appUrl), { method: 'POST',
    headers: { cookie, origin: getConfig().appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ code }) }));
  return { status: response.status, body: await response.json() as { error?: string }, signedIn: response.headers.getSetCookie().some(line => line.startsWith(`${authCookiePrefix()}.session_token=`)) };
}
const refusal = { error: 'The code was not accepted. Try another code or sign in again.' };
/** A code the owner has just used to sign in, and a fresh challenge of the owner's. */
async function usedCodeAndChallenge(): Promise<{ code: string; challenge: string }> {
  await asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
  const code = totp(secrets.get(owner.userId)!, step());
  const first = await challenged(owner);
  assert.equal((await first.browser.call('/api/auth/two-factor/verify-totp', { code })).status, 200);
  return { code, challenge: challengeOf(await challenged(owner)) };
}

test('a second challenge cookie of the same name is refused in either order: the used code signs nobody in', async () => {
  const { code, challenge } = await usedCodeAndChallenge();
  const decoy = `2fa-attempts-${identifierOf(challenge)}.anything`;
  for (const cookie of [`${challengeName()}=${challenge}; ${challengeName()}=${decoy}`, `${challengeName()}=${decoy}; ${challengeName()}=${challenge}`]) {
    const answer = await verifyWith(cookie, code);
    assert.deepEqual([answer.status, answer.body, answer.signedIn], [401, refusal, false], cookie.slice(0, 40));
  }
});

test('a __Secure- challenge cookie beside the plain one on http is refused', async () => {
  const { code, challenge } = await usedCodeAndChallenge();
  const answer = await verifyWith(`__Secure-${challengeName()}=2fa-attempts-${identifierOf(challenge)}.x; ${challengeName()}=${challenge}`, code);
  assert.deepEqual([answer.status, answer.body, answer.signedIn], [401, refusal, false]);
});

test('another user\'s pending challenge beside the real one is refused', async () => {
  const { code, challenge } = await usedCodeAndChallenge();
  const theirs = challengeOf(await challenged(second));
  const answer = await verifyWith(`${challengeName()}=${challenge}; ${challengeName()}=${theirs}`, code);
  assert.deepEqual([answer.status, answer.body, answer.signedIn], [401, refusal, false]);
});

test('thirty races of two challenges with one code, one of them carrying a decoy: exactly one signs in each time', async () => {
  for (let run = 0; run < 30; run += 1) {
    await asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
    const code = totp(secrets.get(owner.userId)!, step());
    const [plain, decoyed] = [challengeOf(await challenged(owner)), challengeOf(await challenged(owner))];
    const answers = await Promise.all([verifyWith(`${challengeName()}=${plain}`, code),
      verifyWith(`${challengeName()}=${decoyed}; ${challengeName()}=2fa-attempts-${identifierOf(decoyed)}.x`, code)]);
    assert.equal(answers.filter(answer => answer.status === 200).length, 1, `run ${run + 1}: ${answers.map(answer => answer.status)}`);
  }
});

test('two challenges racing with one code (no decoy): the user row lock lets exactly one sign in, ten times', async () => {
  for (let run = 0; run < 10; run += 1) {
    await asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
    const code = totp(secrets.get(owner.userId)!, step());
    const [one, two] = [challengeOf(await challenged(owner)), challengeOf(await challenged(owner))];
    const answers = await Promise.all([verifyWith(`${challengeName()}=${one}`, code), verifyWith(`${challengeName()}=${two}`, code)]);
    assert.deepEqual(answers.map(answer => answer.status).sort(), [200, 409], `run ${run + 1}`);
  }
});

test('the limiter key cannot be chosen: fifteen decoy suffixes on one challenge make no bucket of their own', async () => {
  const { code, challenge } = await usedCodeAndChallenge();
  await asAdmin(database.adminUrl, admin => admin.query('DELETE FROM request_limit'));
  for (let index = 0; index < 15; index += 1) await verifyWith(`${challengeName()}=${challenge}; ${challengeName()}=2fa-attempts-${identifierOf(challenge)}.s${index}`, code);
  const buckets = await asAdmin(database.adminUrl, async admin => (await admin.query("SELECT count(DISTINCT key)::int AS n FROM request_limit WHERE key LIKE 'two-factor:%' AND key <> 'two-factor:unresolved'")).rows[0].n);
  assert.ok(buckets <= 1, `${buckets} per-challenge buckets`);
});

test('a recovery code signs in once, under the cookie the server reads', async () => {
  await asAdmin(database.adminUrl, admin => admin.query('DELETE FROM request_limit'));
  const [code] = backupCodes.get(second.userId)!;
  const first = await challenged(second);
  const accepted = await first.browser.call('/api/auth/two-factor/verify-backup-code', { code });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal((await first.browser.call('/api/me')).status, 200);
  const again = await challenged(second);
  assert.deepEqual([(await again.browser.call('/api/auth/two-factor/verify-backup-code', { code })).status, (await again.browser.call('/api/me')).status], [401, 401]);
});
