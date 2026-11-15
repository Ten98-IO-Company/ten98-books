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
const { setupOwner } = await import('./helpers/ledger.ts');
const { challenged, enableFactor, step, totp, verifyWith } = await import('./helpers/two-factor.ts');

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

test('on https a plain-named decoy beside the __Secure- challenge is refused in either order', async () => {
  for (const order of ['decoy last', 'decoy first'] as const) {
    const client = await challenged(database.adminUrl, owner);
    const real = `${secureName()}=${client.browser.cookies.get(secureName())}`, decoy = `${plainName()}=2fa-${'z'.repeat(20)}.x`;
    const answer = await verifyWith(order === 'decoy last' ? `${real}; ${decoy}` : `${decoy}; ${real}`, totp(secret, step() + 1));
    assert.deepEqual([answer.status, answer.body, answer.signedIn], [401, { error: 'The code was not accepted. Try another code or sign in again.' }, false], order);
  }
});
