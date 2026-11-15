import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/server/api.ts';
import { authCookiePrefix } from '../src/server/auth.ts';
import { getConfig } from '../src/server/config.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, browser, invite, password, setupOwner, type Member } from './helpers/ledger.ts';
import { challenged as challengedIn, enableFactor, step, totp, verifyWith } from './helpers/two-factor.ts';

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
  for (const member of [owner, second]) {
    const factor = await enableFactor(member);
    secrets.set(member.userId, factor.secret);
    backupCodes.set(member.userId, factor.backupCodes);
  }
});
after(async () => { await database?.drop(); });




const challenged = (member: Member) => challengedIn(database.adminUrl, member);

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
  const keys = await asAdmin(database.adminUrl, async admin => (await admin.query("SELECT DISTINCT key FROM request_limit WHERE key LIKE 'two-factor:%' AND key NOT LIKE '%:unresolved'")).rows.map(row => row.key as string));
  assert.ok(keys.length >= 2, keys.join(', '));
  assert.ok(!keys.includes(`two-factor:${createHash('sha256').update('').digest('hex')}`), 'no challenge is keyed by an empty cookie');
});

// ---- The cookie the handler checks is the cookie the library verifies ----

const challengeName = () => `${authCookiePrefix()}.two_factor`;
/** The challenge cookie value of a client at the second step. */
const challengeOf = (client: Member) => client.browser.cookies.get(challengeName())!;
const identifierOf = (value: string) => decodeURIComponent(value).split('.')[0];
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

test('a planted variant of our name is ignored: a used code is refused, a fresh one signs in with the record under the right user', async () => {
  for (const variant of [`__Secure-${challengeName()}`, `${authCookiePrefix()}-two_factor`, `__Secure-${authCookiePrefix()}-two_factor`]) {
    const { code, challenge } = await usedCodeAndChallenge();
    const planted = (value: string) => `${variant}=2fa-attempts-${identifierOf(value)}.x; ${challengeName()}=${value}`;
    const used = await verifyWith(planted(challenge), code);
    assert.deepEqual([used.status, used.signedIn], [409, false], `${variant}: a used code`);
    await asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
    const fresh = await verifyWith(planted(challengeOf(await challenged(owner))), code);
    assert.deepEqual([fresh.status, fresh.signedIn], [200, true], `${variant}: a fresh code`);
    const record = await asAdmin(database.adminUrl, async admin => Number((await admin.query("SELECT count(*) FROM verification WHERE identifier LIKE 'totp-used:' || $1 || ':%'", [owner.userId])).rows[0].count));
    assert.equal(record, 1, `${variant}: the reuse record is the owner's`);
  }
});

test('our exact name twice is refused once and cleared; the next sign-in from the same cookie jar works; a used code stays refused', async () => {
  const { code, challenge } = await usedCodeAndChallenge();
  const used = await verifyWith(`${challengeName()}=2fa-attempts-${identifierOf(challenge)}.x; ${challengeName()}=${challenge}`, code);
  assert.deepEqual([used.status, used.signedIn], [401, false], 'a used code with a duplicate');
  await asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
  const jar = await challenged(owner);
  const real = challengeOf(jar);
  const response = await handleApi(new Request(new URL('/api/auth/two-factor/verify-totp', getConfig().appUrl), { method: 'POST',
    headers: { cookie: `${challengeName()}=planted.x; ${challengeName()}=${real}`, origin: getConfig().appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ code }) }));
  assert.deepEqual([response.status, await response.json()], [401, refusal]);
  const cleared = response.headers.getSetCookie().find(line => line.startsWith(`${challengeName()}=;`));
  assert.ok(cleared && /Max-Age=0/i.test(cleared) && /Path=\//.test(cleared) && /HttpOnly/i.test(cleared), String(cleared));
  // The jar drops the cleared name, signs in again and completes the second step.
  jar.browser.cookies.delete(challengeName());
  const email = await asAdmin(database.adminUrl, async admin => (await admin.query('SELECT email FROM "user" WHERE id = $1', [owner.userId])).rows[0].email as string);
  assert.deepEqual((await jar.browser.call('/api/auth/sign-in/email', { email, password })).body, { twoFactorRedirect: true });
  assert.equal((await jar.browser.call('/api/auth/two-factor/verify-totp', { code })).status, 200);
  assert.equal((await jar.browser.call('/api/me')).status, 200);
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
  const buckets = await asAdmin(database.adminUrl, async admin => (await admin.query("SELECT count(DISTINCT key)::int AS n FROM request_limit WHERE key LIKE 'two-factor:%' AND key NOT LIKE '%:unresolved'")).rows[0].n);
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

test('new recovery codes need the second factor as well as the password; the code used as proof is spent', async () => {
  await asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
  const [, oldCode] = backupCodes.get(second.userId)!;
  // The password alone is refused, and the recovery codes in hand still work.
  const alone = await second.browser.call('/api/account/two-factor/recovery-codes', { password });
  assert.deepEqual([alone.status, alone.body], [400, { error: 'Enter a code from your authenticator app, or a recovery code, to get new recovery codes.', code: 'second_factor_required' }]);
  const signIn = await challenged(second);
  assert.equal((await signIn.browser.call('/api/auth/two-factor/verify-backup-code', { code: oldCode })).status, 200, 'an old recovery code still signs in');
  // With an authenticator code it works once; the code is then spent, also for signing in.
  const code = totp(secrets.get(second.userId)!, step());
  const replaced = await second.browser.call('/api/account/two-factor/recovery-codes', { password, code });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.deepEqual([(await second.browser.call('/api/account/two-factor/recovery-codes', { password, code })).status], [409]);
  const reused = await (await challenged(second)).browser.call('/api/auth/two-factor/verify-totp', { code });
  assert.deepEqual([reused.status, reused.body.error], [409, 'Wait for the next authenticator code, then try again.'], 'the proof code cannot sign in');
  // A recovery code used as the proof is spent.
  const [proof] = replaced.body.backupCodes as string[];
  const latest = await second.browser.call('/api/account/two-factor/recovery-codes', { password, backupCode: proof });
  assert.equal(latest.status, 200);
  backupCodes.set(second.userId, latest.body.backupCodes);
  assert.equal((await second.browser.call('/api/account/two-factor/recovery-codes', { password, backupCode: proof })).status, 400, 'the same recovery code again');
});

test('a challenge cookie of another app on the same host is ignored', async () => {
  await asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
  const theirs = `ten98-${'0'.repeat(16)}.two_factor=2fa-${'a'.repeat(20)}.signature`;
  const fine = await challenged(owner);
  const accepted = await verifyWith(`${theirs}; ${challengeName()}=${challengeOf(fine)}`, totp(secrets.get(owner.userId)!, step()));
  assert.deepEqual([accepted.status, accepted.signedIn], [200, true]);
});

test('one challenge sent with different percent-escaping spends one limiter bucket', async () => {
  const challenge = challengeOf(await challenged(owner));
  await asAdmin(database.adminUrl, admin => admin.query('DELETE FROM request_limit'));
  const escaped = challenge.replace('2fa-', '2fa%2D');
  const digits = challenge.replace(/^2/, '%32');
  for (const value of [challenge, escaped, digits]) await verifyWith(`${challengeName()}=${value}`, '000000');
  const buckets = await asAdmin(database.adminUrl, async admin => (await admin.query("SELECT count(DISTINCT key)::int AS n FROM request_limit WHERE key LIKE 'two-factor:%' AND key NOT LIKE '%:unresolved'")).rows[0].n);
  assert.equal(buckets, 1);
});

test('new recovery codes: two requests racing with one code, a sign-in code as proof, a wrong password, a refused request', async () => {
  await asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
  const regenerate = (body: Record<string, string>) => second.browser.call('/api/account/two-factor/recovery-codes', { password, ...body });
  // A wrong password with the right code is refused in the one sentence, and the code is not spent: the password is
  // checked first, so a refused password never consumes a code.
  const code = totp(secrets.get(second.userId)!, step());
  assert.deepEqual([(await regenerate({ password: 'wrong horse battery staple', code })).body], [{ error: 'The password or the code was not accepted.' }]);
  // A refused request leaves the other sessions signed in and the old codes valid.
  const other = await challenged(second);
  const [, , oldCode] = backupCodes.get(second.userId)!;
  assert.equal((await other.browser.call('/api/auth/two-factor/verify-backup-code', { code: backupCodes.get(second.userId)![3] })).status, 200);
  assert.equal((await regenerate({})).status, 400);
  assert.equal((await other.browser.call('/api/me')).status, 200, 'the other session stays signed in');
  // Two requests racing with that (unspent) code: exactly one replaces the codes, the other is refused as a used code.
  const raced = await Promise.all([regenerate({ code }), regenerate({ code })]);
  assert.deepEqual(raced.map(answer => answer.status).sort(), [200, 409]);
  assert.equal((await other.browser.call('/api/me')).status, 401, 'replacing the codes signs the other sessions out');
  const replaced = raced.find(answer => answer.status === 200)!.body.backupCodes as string[];
  backupCodes.set(second.userId, replaced);
  assert.equal((await regenerate({ backupCode: oldCode })).status, 400, 'the old codes are dead after the replacement');
  // A code that signed a client in is refused as the proof.
  await asAdmin(database.adminUrl, admin => admin.query('DELETE FROM request_limit'));
  const next = totp(secrets.get(second.userId)!, step() + 1);
  const signed = await challenged(second);
  assert.equal((await signed.browser.call('/api/auth/two-factor/verify-totp', { code: next })).status, 200);
  assert.deepEqual([(await regenerate({ code: next })).status], [409]);
});

test('a challenge value with no dot (an identifier plus one character) is refused before the limiter', async () => {
  const challenge = challengeOf(await challenged(owner));
  await asAdmin(database.adminUrl, admin => admin.query('DELETE FROM request_limit'));
  const answer = await verifyWith(`${challengeName()}=${identifierOf(challenge)}x`, totp(secrets.get(owner.userId)!, step()));
  assert.deepEqual([answer.status, answer.body, answer.signedIn], [401, refusal, false]);
  const buckets = await asAdmin(database.adminUrl, async admin => (await admin.query("SELECT count(*)::int AS n FROM request_limit WHERE key LIKE 'two-factor:%' AND key NOT LIKE '%:unresolved'")).rows[0].n);
  assert.equal(buckets, 0, 'the real challenge\'s bucket is not spent');
});

test('without a code the answer does not depend on the password; a wrong password never spends the code', async () => {
  await asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
  const wrong = 'wrong horse battery staple';
  for (const [path, noCode] of [
    ['/api/account/two-factor/recovery-codes', { error: 'Enter a code from your authenticator app, or a recovery code, to get new recovery codes.', code: 'second_factor_required' }],
    ['/api/account/two-factor/disable', { error: 'Enter an authenticator code or a recovery code to verify this action.' }],
  ] as const) {
    const right = await second.browser.call(path, { password }), bad = await second.browser.call(path, { password: wrong });
    assert.deepEqual([right.status, right.body], [400, noCode], `${path}: no code, right password`);
    assert.deepEqual([bad.status, bad.body], [right.status, right.body], `${path}: no code, wrong password answers the same`);
    const code = totp(secrets.get(second.userId)!, step());
    assert.deepEqual((await second.browser.call(path, { password: wrong, code })).body, { error: 'The password or the code was not accepted.' }, `${path}: a code, wrong password`);
    if (path === '/api/account/two-factor/recovery-codes') {
      const done = await second.browser.call(path, { password, code });
      assert.equal(done.status, 200, `${path}: the same code with the right password (it was not spent)`);
      backupCodes.set(second.userId, done.body.backupCodes);
    }
  }
});

/** Every session row of a user. */
const sessions = (userId: string) => asAdmin(database.adminUrl, async admin => Number((await admin.query('SELECT count(*) FROM session WHERE "userId" = $1', [userId])).rows[0].count));
/** A verify with the given header lines (two Cookie headers become one joined value, as Headers does). */
async function verifyHeaders(lines: string[], code: string) {
  const headers = new Headers({ origin: getConfig().appUrl, 'content-type': 'application/json' });
  for (const line of lines) headers.append('cookie', line);
  const response = await handleApi(new Request(new URL('/api/auth/two-factor/verify-totp', getConfig().appUrl), { method: 'POST', headers, body: JSON.stringify({ code }) }));
  return { status: response.status, signedIn: response.headers.getSetCookie().some(line => line.replace(/^__Secure-/, '').startsWith(`${authCookiePrefix()}.session_token=`)) };
}

test('odd Cookie header shapes: a used code never signs anyone in; a fresh code signs in at most once', async t => {
  const name = challengeName(), prefix = authCookiePrefix();
  const fullyEncoded = (value: string) => [...decodeURIComponent(value)].map(character => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  const rows: [string, (real: string, other: string) => string[]][] = [
    ['our name in upper case', real => [`${name.toUpperCase()}=${real}`]],
    ['spaces around the name and =', real => [`  ${name}  =  ${real}  `]],
    ['tabs around the name and =', real => [`\t${name}\t=\t${real}\t`]],
    ['our name percent-encoded', real => [`${name.replace(/\./g, '%2E')}=${real}`]],
    ['our value percent-encoded', real => [`${name}=${fullyEncoded(real)}`]],
    ['a quoted value', real => [`${name}="${real}"`]],
    ['an empty-named pair beside ours', real => [`=junk; ${name}=${real}`]],
    ['a pair with no = beside ours', real => [`junk; ${name}=${real}`]],
    [', instead of ; between pairs', real => [`${name}=${real}, theme=dark`]],
    ['two Cookie headers', real => [`${name}=${real}`, 'theme=dark']],
    ['a neighbour value with an encoded = and ;', real => [`note=a%3Db%3Bc; ${name}=${real}`]],
    ['our value with an encoded = and ; appended', real => [`${name}=${real}%3D%3B`]],
    ['an 8 KB header', real => [`pad=${'a'.repeat(8 * 1024)}; ${name}=${real}`]],
    ['a 64 KB header', real => [`pad=${'a'.repeat(64 * 1024)}; ${name}=${real}`]],
    ['a null byte', real => [`${name}=${real}\0`]],
    ['non-ASCII (Latin-1) in a neighbour', real => [`pad=é; ${name}=${real}`]],
    ['non-ASCII beyond Latin-1 in a neighbour', real => [`pad=€; ${name}=${real}`]],
    ['another app\'s prefix carrying another user\'s challenge', (real, other) => [`ten98-${'1'.repeat(16)}.two_factor=${other}; ${name}=${real}`]],
    ['better-auth.two_factor carrying another user\'s challenge', (real, other) => [`better-auth.two_factor=${other}; ${name}=${real}`]],
    ['__Secure-better-auth.two_factor carrying another user\'s challenge', (real, other) => [`__Secure-better-auth.two_factor=${other}; ${name}=${real}`]],
    ['__Host- of our prefix carrying another user\'s challenge', (real, other) => [`__Host-${prefix}.two_factor=${other}; ${name}=${real}`]],
  ];
  const outcomes: string[] = [];
  for (const [label, build] of rows) {
    const reset = () => asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
    // A used code: the owner signs in with it first.
    await reset();
    const code = totp(secrets.get(owner.userId)!, step());
    assert.equal((await (await challenged(owner)).browser.call('/api/auth/two-factor/verify-totp', { code })).status, 200);
    const real = challengeOf(await challenged(owner)), other = challengeOf(await challenged(second));
    let lines: string[];
    try { lines = build(real, other); new Headers(lines.map(line => ['cookie', line])); } catch { outcomes.push(`${label}: not sendable (Headers refuses it)`); continue; }
    const before = [await sessions(owner.userId), await sessions(second.userId)];
    const used = await verifyHeaders(lines, code);
    assert.equal(used.signedIn, false, `${label}: used code`);
    assert.deepEqual([await sessions(owner.userId), await sessions(second.userId)], before, `${label}: no session row`);
    // A fresh code (the used-code ledger cleared) on a new real challenge: at most one success, and the plain cookie
    // still works when this shape is refused.
    await reset();
    const realAgain = challengeOf(await challenged(owner)), otherAgain = challengeOf(await challenged(second));
    const fresh = await verifyHeaders(build(realAgain, otherAgain), code);
    const again = await verifyHeaders(build(realAgain, otherAgain), code);
    assert.equal([fresh, again].filter(answer => answer.signedIn).length <= 1, true, `${label}: at most one success`);
    let outcome = fresh.signedIn ? 'fresh code: signed in once' : `fresh code: refused (${fresh.status})`;
    if (!fresh.signedIn) {
      const plain = await verifyHeaders([`${name}=${realAgain}`], code);
      assert.equal(plain.signedIn, true, `${label}: the plain cookie still works`);
      outcome += '; the plain cookie then signs in';
    }
    outcomes.push(`${label}: used code refused (${used.status}), no session; ${outcome}`);
  }
  for (const line of outcomes) t.diagnostic(line);
});

test('the session the library creates must be the user the handler checked: a newer row naming another user rolls back', async () => {
  await asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
  const challenge = challengeOf(await challenged(owner));
  // The library reads the newest row of an identifier; the handler's lookup reads the first. A newer row naming the second
  // user makes the library verify the second user's code and sign them in, while the handler checked the owner.
  await asAdmin(database.adminUrl, admin => admin.query(`INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, now() + interval '10 minutes', now() + interval '1 minute', now())`, [randomUUID(), identifierOf(challenge), second.userId]));
  const before = await sessions(second.userId);
  const answer = await verifyWith(`${challengeName()}=${challenge}`, totp(secrets.get(second.userId)!, step()));
  assert.deepEqual([answer.status, answer.signedIn], [401, false]);
  assert.equal(await sessions(second.userId), before, 'the library\'s session was rolled back');
});

test('a client already signed in is told the sign-in is complete, and no second session is made', async () => {
  await asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
  const pending = challengeOf(await challenged(owner));
  const sessionCookie = [...owner.browser.cookies].map(([cookieName, value]) => `${cookieName}=${value}`).join('; ');
  const before = await sessions(owner.userId);
  const answer = await verifyWith(`${sessionCookie}; ${challengeName()}=${pending}`, totp(secrets.get(owner.userId)!, step()));
  assert.deepEqual([answer.status, answer.body.error], [409, 'This sign-in is already complete.']);
  assert.equal(await sessions(owner.userId), before);
});

test('a code that confirmed enrolment is refused at the next sign-in', async () => {
  await asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
  const third = await invite(owner.browser, owner.workspaceId, 'viewer');
  const factor = await enableFactor(third);
  // enableFactor confirms with the code of the previous step: that code is now spent.
  const confirmed = totp(factor.secret, step() - 1);
  const answer = await (await challenged(third)).browser.call('/api/auth/two-factor/verify-totp', { code: confirmed });
  assert.deepEqual([answer.status, answer.body.error], [409, 'Wait for the next authenticator code, then try again.']);
});
