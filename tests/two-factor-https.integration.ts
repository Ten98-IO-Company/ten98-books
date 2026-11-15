import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

/**
 * The second step of sign-in with an https app URL, in process: the library then names the challenge cookie
 * `__Secure-<prefix>.two_factor`, and the handler must read exactly that name. A real sign-in works; a plain-named decoy
 * beside it, in either order, is refused. The app URL is set before any module reads the configuration; its host has a
 * parent domain (books.test), so a copy planted with a parent Domain can be tried.
 */
process.env.APP_URL = 'https://app.books.test';
const { authCookiePrefix } = await import('../src/server/auth.ts');
const { freshDatabase } = await import('./helpers/database.ts');
const { asAdmin, setupOwner } = await import('./helpers/ledger.ts');
const { handleApi } = await import('../src/server/api.ts');
const { getConfig } = await import('../src/server/config.ts');
const { challenged, challengeSetCookie, cookieScope, duplicateRefusal, enableFactor, plantedThenSignIn, step, totp, verifyWith } = await import('./helpers/two-factor.ts');

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

test('on https a copy planted on a path of this host is cleared and the next sign-in completes; one planted with a parent Domain is not', async () => {
  const fresh = () => asAdmin(database.adminUrl, admin => admin.query("DELETE FROM request_limit; DELETE FROM verification WHERE identifier LIKE 'totp-used:%'"));
  for (const path of ['/api', '/api/auth', '/api/auth/two-factor']) {
    await fresh();
    const result = await plantedThenSignIn(database.adminUrl, owner, totp(secret, step()), secureName(), { domain: 'app.books.test', hostOnly: true, path });
    assert.deepEqual([result.first, result.second, result.signedIn], [401, 200, true], `planted at ${path}; between: ${result.between.join(', ')}`);
  }
  // Known limit: a copy set with Domain=books.test (from a sibling host) is a different cookie from the host's own, and no
  // Set-Cookie from this host without that Domain can expire it; only a host-only cookie name (`__Host-`) would keep it out.
  // The sign-in stays refused while the copy lives.
  await fresh();
  const parent = await plantedThenSignIn(database.adminUrl, owner, totp(secret, step()), secureName(), { domain: 'books.test', hostOnly: false, path: '/' });
  assert.deepEqual([parent.first, parent.second, parent.signedIn], [401, 401, false], `parent Domain; between: ${parent.between.join(', ')}`);
});

test('on https every clearing cookie is the __Secure- name, Secure and HttpOnly, one per path', async () => {
  await asAdmin(database.adminUrl, admin => admin.query('DELETE FROM request_limit'));
  const { value } = await challengeSetCookie(database.adminUrl, owner, secureName());
  const response = await handleApi(new Request(new URL('/api/auth/two-factor/verify-totp', getConfig().appUrl), { method: 'POST',
    headers: { cookie: `${secureName()}=planted.x; ${secureName()}=${value}`, origin: getConfig().appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ code: '000000' }) }));
  const lines = response.headers.getSetCookie();
  assert.deepEqual(lines.map(line => cookieScope(line)).map(scope => [scope.name, scope.path, scope.domain, scope.httpOnly, scope.sameSite, scope.secure]),
    ['/', '/api', '/api/auth', '/api/auth/two-factor'].map(path => [secureName(), path, undefined, true, 'lax', true]), lines.join(' | '));
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
