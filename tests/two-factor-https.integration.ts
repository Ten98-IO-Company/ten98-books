import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

/**
 * The second step of sign-in with an https app URL, in process: the library then names the challenge cookie
 * `__Secure-<prefix>.two_factor`, and the handler must read exactly that name. A real sign-in works; a plain-named decoy
 * beside it, in either order, is refused. The app URL is set before any module reads the configuration.
 */
process.env.APP_URL = 'https://books.test';
const { authCookiePrefix } = await import('../src/server/auth.ts');
const { freshDatabase } = await import('./helpers/database.ts');
const { asAdmin, setupOwner } = await import('./helpers/ledger.ts');
const { challenged, challengeSetCookie, cookieScope, duplicateRefusal, enableFactor, step, totp, verifyWith } = await import('./helpers/two-factor.ts');

let database: Awaited<ReturnType<typeof freshDatabase>>;
let owner: Awaited<ReturnType<typeof setupOwner>>;
let secret = '';
before(async () => {
  database = await freshDatabase('two_factor_https');
  owner = await setupOwner();
  secret = (await enableFactor(owner)).secret;
});
after(async () => { await database?.drop(); });

const secureName = () => `__Secure-${authCookiePrefix()}.two_factor`, plainName = () => `${authCookiePrefix()}.two_factor`;

test('on https the challenge cookie is the __Secure- name, and a real sign-in through it works', async () => {
  const client = await challenged(database.adminUrl, owner);
  assert.ok(client.browser.cookies.has(secureName()), [...client.browser.cookies.keys()].join(', '));
  const accepted = await verifyWith(`${secureName()}=${client.browser.cookies.get(secureName())}`, totp(secret, step()));
  assert.deepEqual([accepted.status, accepted.signedIn], [200, true], JSON.stringify(accepted.body));
});

test('on https the duplicate case clears the __Secure- challenge cookie with the scope the library set it with', async () => {
  await asAdmin(database.adminUrl, admin => admin.query('DELETE FROM request_limit'));
  const { line, value } = await challengeSetCookie(database.adminUrl, owner, secureName());
  const { status, cleared } = await duplicateRefusal(secureName(), value);
  assert.equal(status, 401);
  assert.ok(cleared && /;\s*Max-Age=0(;|$)/i.test(cleared), String(cleared));
  assert.deepEqual(cookieScope(cleared), cookieScope(line), `cleared ${cleared}, set ${line}`);
  assert.deepEqual([cookieScope(line).domain, cookieScope(line).secure], [undefined, true], 'https: no Domain, Secure');
});

test('on https a planted plain-named variant beside the __Secure- challenge is ignored in either order', async () => {
  for (const order of ['planted last', 'planted first'] as const) {
    await asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
    const code = totp(secret, step());
    const client = await challenged(database.adminUrl, owner);
    const real = `${secureName()}=${client.browser.cookies.get(secureName())}`, planted = `${plainName()}=2fa-${'z'.repeat(20)}.x`;
    const header = order === 'planted last' ? `${real}; ${planted}` : `${planted}; ${real}`;
    const fresh = await verifyWith(header, code);
    assert.deepEqual([fresh.status, fresh.signedIn], [200, true], `${order}: a fresh code`);
    const again = await verifyWith(`${secureName()}=${(await challenged(database.adminUrl, owner)).browser.cookies.get(secureName())}; ${planted}`, code);
    assert.deepEqual([again.status, again.signedIn], [409, false], `${order}: the used code`);
  }
});
