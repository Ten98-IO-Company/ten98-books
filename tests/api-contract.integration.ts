import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { appMarkerHeader, appMarkerValue } from '../src/lib/app-marker.ts';
import { handleApi } from '../src/server/api.ts';
import { bucketsBodyBytes } from '../src/server/api/bills.ts';
import { currencyBodyBytes } from '../src/server/api/currencies.ts';
import { masterBodyBytes } from '../src/server/api/masters.ts';
import { stockBodyBytes } from '../src/server/api/stock-masters.ts';
import { getConfig } from '../src/server/config.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, browser, chart, createCompany, invite, setupOwner, type Member } from './helpers/ledger.ts';

/**
 * The HTTP contract around the ledger areas (acceptance run 1): body limits derived from each schema's own list bound,
 * ids in any letter case on the team routes, 405 with Allow for a known path and a wrong method, and history reads that
 * answer 404 for an id the company never had.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('api_contract');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

/** One raw request as `member` (or signed out): any method, a body sent as given. */
async function send(member: Member | null, method: string, path: string, body?: string): Promise<{ status: number; allow: string | null; marker: string | null; text: string }> {
  const headers = new Headers({ origin: getConfig().appUrl });
  if (member?.browser.cookies.size) headers.set('cookie', [...member.browser.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await handleApi(new Request(new URL(path, getConfig().appUrl), { method, headers, ...(body === undefined ? {} : { body }) }));
  return { status: response.status, allow: response.headers.get('allow'), marker: response.headers.get(appMarkerHeader), text: await response.text() };
}
const code = (answer: { status: number; text: string }) => [answer.status, answer.text ? JSON.parse(answer.text).code ?? null : null];
/** A body over `limit` bytes that would otherwise be valid JSON. */
const oversized = (limit: number) => JSON.stringify({ name: 'Padded' }) + ' '.repeat(limit);
/**
 * The widest text a name field takes: `length` characters of one that is 3 bytes in UTF-8 and one UTF-16 unit (the schema
 * counts units), after `lead`. The limits assume UTF-8 sent unescaped, as JSON.stringify writes it.
 */
const widest = (length: number, lead = '') => (lead + '€'.repeat(length)).slice(0, length);
/** The longest amount a 2-decimal currency takes: 20 digits before the point (leading zeros allowed) and 2 after. */
const longestAmount = (value: number) => `${value}.00`.padStart(23, '0');

/**
 * Each route: the largest valid body (every row at its schema's list bound) is accepted and fits the limit; one row more is
 * refused by the schema (400 validation), not by size; a body over the limit answers 413.
 */
test('ledger bodies: 500 opening bills are accepted, 501 refused by the schema, more than the limit by size', async () => {
  const companyId = await createCompany(owner.browser, { name: 'Body Ledgers' });
  const writer = await invite(owner.browser, companyId, 'editor');
  const books = await chart(owner.browser, companyId);
  const longestPeriod = { count: 3650, unit: 'month' };
  const body = (rows: number, name: string) => JSON.stringify({
    name: widest(120, `${name} `), secondLanguageName: widest(120), groupId: books.group('receivables'),
    opening: { amount: longestAmount(rows), side: 'Dr', bills: Array.from({ length: rows }, (_, index) => ({
      kind: 'new_ref', name: widest(100, String(index).padStart(4, '0')), billDate: '2000-01-01', creditPeriod: longestPeriod, amount: longestAmount(1) })) },
    billWise: true, creditPeriod: longestPeriod, creditDaysCheck: true, costCentres: false,
  });
  const largest = body(500, 'Largest');
  assert.ok(Buffer.byteLength(largest) <= masterBodyBytes, `${Buffer.byteLength(largest)} bytes, limit ${masterBodyBytes}`);
  const accepted = await send(writer, 'POST', `/api/companies/${companyId}/ledgers`, largest);
  assert.equal(accepted.status, 201, accepted.text.slice(0, 300));
  assert.equal(JSON.parse(accepted.text).ledger.openingBills.length, 500);
  assert.deepEqual(code(await send(writer, 'POST', `/api/companies/${companyId}/ledgers`, body(501, 'One More'))), [400, 'validation']);
  assert.equal((await send(writer, 'POST', `/api/companies/${companyId}/ledgers`, oversized(masterBodyBytes))).status, 413);
});

test('stock item bodies: 500 opening rows are accepted, 501 refused by the schema, more than the limit by size', async () => {
  const companyId = await createCompany(owner.browser, { name: 'Body Stock' });
  const writer = await invite(owner.browser, companyId, 'editor');
  const call = (path: string, value: unknown) => writer.browser.call(`/api/companies/${companyId}${path}`, value);
  const unit = (await call('/stock-units', { symbol: 'Nos', decimals: 4 })).body.stockUnit.id;
  const locations: string[] = await asAdmin(database.adminUrl, async admin => {
    await admin.query('BEGIN');
    await admin.query("SELECT set_config('app.company_ids', $1, true)", [companyId]);
    const rows = (await admin.query("INSERT INTO stock_location (company_id, name) SELECT $1, 'Bin ' || n FROM generate_series(1, 501) n RETURNING id", [companyId])).rows;
    await admin.query('COMMIT');
    return rows.map(row => row.id as string);
  });
  const group = (await call('/stock-groups', { name: 'Body Group' })).body.stockGroup.id;
  const category = (await call('/stock-categories', { name: 'Body Category' })).body.stockCategory.id;
  // Each row at its widest: the longest quantity (16 digits, 4 decimals) with the longest value (a 23-character amount).
  const body = (rows: number, name: string) => JSON.stringify({
    name: widest(120, `${name} `), secondLanguageName: widest(120), groupId: group, categoryId: category, unitId: unit, standardSellingRate: '99999999999999.999999',
    openings: locations.slice(0, rows).map(locationId => ({ locationId, quantity: '0000000000000001.0000', value: longestAmount(1) })),
  });
  const largest = body(500, 'Largest Item');
  assert.ok(Buffer.byteLength(largest) <= stockBodyBytes, `${Buffer.byteLength(largest)} bytes, limit ${stockBodyBytes}`);
  const accepted = await send(writer, 'POST', `/api/companies/${companyId}/stock-items`, largest);
  assert.equal(accepted.status, 201, accepted.text.slice(0, 300));
  assert.deepEqual(code(await send(writer, 'POST', `/api/companies/${companyId}/stock-items`, body(501, 'One More Item'))), [400, 'validation']);
  assert.equal((await send(writer, 'POST', `/api/companies/${companyId}/stock-items`, oversized(stockBodyBytes))).status, 413);
});

test('rate bodies: 200 currencies are accepted, 201 refused by the schema, more than the limit by size', async () => {
  const companyId = await createCompany(owner.browser, { name: 'Body Rates' });
  const writer = await invite(owner.browser, companyId, 'editor');
  const codes = Array.from({ length: 201 }, (_, index) => `Q${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`);
  await asAdmin(database.adminUrl, async admin => {
    await admin.query('BEGIN');
    await admin.query("SELECT set_config('app.company_ids', $1, true)", [companyId]);
    await admin.query("INSERT INTO currency (company_id, code, symbol, formal_name, decimals) SELECT $1, code, lower(code) || '$', 'Filler ' || code, 2 FROM unnest($2::text[]) code", [companyId, codes]);
    await admin.query('COMMIT');
  });
  const body = (rows: number) => JSON.stringify({ date: '2026-03-01', rates: codes.slice(0, rows).map(currency => ({
    currency, standard: '1234567890.1234', selling: '1234567890.1234', buying: '1234567890.1234' })) });
  const largest = body(200);
  assert.ok(Buffer.byteLength(largest) <= currencyBodyBytes, `${Buffer.byteLength(largest)} bytes, limit ${currencyBodyBytes}`);
  const accepted = await send(writer, 'POST', `/api/companies/${companyId}/exchange-rates`, largest);
  assert.equal(accepted.status, 200, accepted.text.slice(0, 300));
  assert.deepEqual(code(await send(writer, 'POST', `/api/companies/${companyId}/exchange-rates`, body(201))), [400, 'validation']);
  assert.equal((await send(writer, 'POST', `/api/companies/${companyId}/exchange-rates`, oversized(currencyBodyBytes))).status, 413);
});

test('ageing column bodies: 20 columns are accepted, 21 refused by the schema, more than the limit by size', async () => {
  const companyId = await createCompany(owner.browser, { name: 'Body Buckets' });
  const writer = await invite(owner.browser, companyId, 'editor');
  const body = (rows: number) => JSON.stringify({ buckets: Array.from({ length: rows }, (_, index) => ({
    fromDays: index === 0 ? 0 : 36400 + index, toDays: index === rows - 1 ? null : 36401 + index })) });
  const largest = body(20);
  assert.ok(Buffer.byteLength(largest) <= bucketsBodyBytes, `${Buffer.byteLength(largest)} bytes, limit ${bucketsBodyBytes}`);
  const accepted = await send(writer, 'POST', `/api/companies/${companyId}/ageing-buckets`, largest);
  assert.equal(accepted.status, 200, accepted.text.slice(0, 300));
  assert.deepEqual(code(await send(writer, 'POST', `/api/companies/${companyId}/ageing-buckets`, body(21))), [400, 'validation']);
  assert.equal((await send(writer, 'POST', `/api/companies/${companyId}/ageing-buckets`, oversized(bucketsBodyBytes))).status, 413);
});

test('team routes: an id in capitals is the same id for the owner, and an outsider learns nothing more than for an id that does not exist', async () => {
  const companyId = await createCompany(owner.browser, { name: 'Upper Team' });
  const member = await invite(owner.browser, companyId, 'viewer');
  const upper = companyId.toUpperCase(), base = (id: string) => `/api/workspaces/${id}`;
  const lower = await send(owner, 'GET', `${base(companyId)}/team`);
  assert.equal(lower.status, 200);
  assert.deepEqual(await send(owner, 'GET', `${base(upper)}/team`), lower, 'the read');
  assert.equal((await send(owner, 'POST', `${base(upper)}/rename`, JSON.stringify({ name: 'Upper Team Renamed' }))).status, 200, 'a workspace write');
  const invited = await send(owner, 'POST', `${base(upper)}/invitations`, JSON.stringify({ email: `upper-${randomUUID()}@books.test`, role: 'viewer' }));
  assert.equal(invited.status, 201, invited.text);
  const invitationId = JSON.parse(invited.text).invitation.id as string;
  assert.equal((await send(owner, 'POST', `${base(upper)}/invitations/${invitationId.toUpperCase()}/revoke`, '{}')).status, 200, 'an invitation write');
  assert.equal((await send(owner, 'POST', `${base(upper)}/members/${member.userId.toUpperCase()}/role`, JSON.stringify({ role: 'editor' }))).status, 200, 'a member write');
  const outsider = { browser: browser(), userId: '' } as Member;
  await setupOutsider(outsider);
  const missing = randomUUID();
  for (const [method, suffix, body] of [['GET', '/team', undefined], ['POST', '/rename', JSON.stringify({ name: 'Taken Over' })]] as const) {
    assert.deepEqual(await send(outsider, method, `${base(upper)}${suffix}`, body), await send(outsider, method, `${base(missing)}${suffix}`, body), `outsider ${method} ${suffix}`);
  }
});

/** Every write route of a company or workspace `id`, with `someone` as the id of a member, invitation or master. */
const writeRoutes = (id: string, someone: string) => [
  `/api/companies/${id}/setup`,
  ...['rename', 'invitations', 'transfer-ownership', 'two-factor'].map(action => `/api/workspaces/${id}/${action}`),
  ...['role', 'remove'].map(action => `/api/workspaces/${id}/members/${someone}/${action}`),
  ...['revoke', 'resend', 'new-link'].map(action => `/api/workspaces/${id}/invitations/${someone}/${action}`),
  ...['groups', 'ledgers', 'voucher-types', 'vouchers', 'cost-categories', 'cost-centres', 'stock-units', 'stock-groups', 'stock-categories', 'stock-locations', 'stock-items']
    .flatMap(kind => [`/api/companies/${id}/${kind}`, `/api/companies/${id}/${kind}/${someone}`, `/api/companies/${id}/${kind}/${someone}/delete`]),
  `/api/companies/${id}/vouchers/${someone}/cancel`, `/api/companies/${id}/vouchers/balance-preview`,
  `/api/companies/${id}/currencies`, `/api/companies/${id}/currencies/xyz`, `/api/companies/${id}/currencies/xyz/delete`, `/api/companies/${id}/exchange-rates`,
  `/api/companies/${id}/ageing-buckets`, `/api/companies/${id}/cost-centres-setting`, `/api/companies/${id}/inventory-setting`,
];

test('every write route: an outsider with a body the route refuses gets the answer for a company that does not exist', async () => {
  const companyId = await createCompany(owner.browser, { name: 'Outsider Writes' });
  const outsider = { browser: browser(), userId: '' } as Member;
  await setupOutsider(outsider);
  const someone = randomUUID();
  const writes = (id: string) => writeRoutes(id, someone);
  const missing = writes(randomUUID());
  for (const [index, path] of writes(companyId).entries()) {
    // A body no route accepts (an unknown field), and one that is not JSON at all.
    for (const body of [JSON.stringify({ unknownField: true }), '{not json']) {
      const theirs = await send(outsider, 'POST', path, body), nowhere = await send(outsider, 'POST', missing[index], body);
      assert.deepEqual(theirs, nowhere, `${path} ${body}`);
      if (body.startsWith('{"')) assert.notEqual(theirs.status, 400, `${path}: ${theirs.text}`);
    }
  }
});

test('every answer of the API carries the application marker: signed out, outsider, wrong method, invalid body, over a limit, success', async () => {
  const companyId = await createCompany(owner.browser, { name: 'Marked Books' });
  const books = await chart(owner.browser, companyId);
  const outsider = { browser: browser(), userId: '' } as Member;
  await setupOutsider(outsider);
  const answers: { what: string; status: number; marker: string | null }[] = [];
  const record = (what: string, answer: { status: number; marker: string | null }) => { answers.push({ what, status: answer.status, marker: answer.marker }); };
  const raw = async (what: string, path: string, init: RequestInit) => {
    const response = await handleApi(new Request(new URL(path, getConfig().appUrl), init));
    record(what, { status: response.status, marker: response.headers.get(appMarkerHeader) });
  };
  for (const path of writeRoutes(companyId, randomUUID())) {
    record(`signed out ${path}`, await send(null, 'POST', path, '{}'));
    record(`outsider ${path}`, await send(outsider, 'POST', path, JSON.stringify({ unknownField: true })));
    record(`invalid body ${path}`, await send(owner, 'POST', path, JSON.stringify({ unknownField: true })));
    record(`wrong method ${path}`, await send(owner, 'DELETE', path, '{}'));
  }
  const ledger = JSON.stringify({ name: 'Marked Ledger', groupId: books.group('capital') });
  record('created', await send(owner, 'POST', `/api/companies/${companyId}/ledgers`, ledger));
  record('the same name again', await send(owner, 'POST', `/api/companies/${companyId}/ledgers`, ledger));
  record('a list', await send(owner, 'GET', `/api/companies/${companyId}/ledgers`));
  record('over the size limit', await send(owner, 'POST', `/api/companies/${companyId}/ledgers`, oversized(masterBodyBytes)));
  record('no route', await send(owner, 'GET', '/api/no-such-route'));
  for (const path of ['/api/health/live', '/api/health/ready']) {
    record(`GET ${path}`, await send(null, 'GET', path));
    await raw(`HEAD ${path}`, path, { method: 'HEAD' });
  }
  record('session, signed out', await send(null, 'GET', '/api/session'));
  record('sign-in refused (the identity library)', await send(null, 'POST', '/api/auth/sign-in/email', JSON.stringify({ email: 'nobody@books.test', password: 'wrong horse battery staple' })));
  await raw('another origin', `/api/companies/${companyId}/ledgers`, { method: 'POST', headers: { origin: 'https://elsewhere.test', 'content-type': 'application/json' }, body: ledger });
  await raw('not JSON', `/api/companies/${companyId}/ledgers`, { method: 'POST', headers: { origin: getConfig().appUrl, 'content-type': 'text/plain', cookie: [...owner.browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ') }, body: ledger });
  await asAdmin(database.adminUrl, admin => admin.query(`INSERT INTO request_limit (key, minute, count) VALUES ($1, floor(extract(epoch FROM now()) / 60), 20)
    ON CONFLICT (key, minute) DO UPDATE SET count = 20`, [`companies:${owner.userId}`]));
  record('over a rate limit', await send(owner, 'POST', '/api/companies', JSON.stringify({ name: 'One Too Many' })));
  await asAdmin(database.adminUrl, admin => admin.query('DELETE FROM request_limit WHERE key = $1', [`companies:${owner.userId}`]));
  record('sign-out (the identity library)', await send(outsider, 'POST', '/api/auth/sign-out', '{}'));
  assert.deepEqual(answers.filter(answer => answer.marker !== appMarkerValue), [], 'every answer is marked');
  const statuses = new Set(answers.map(answer => answer.status));
  for (const status of [200, 201, 400, 401, 403, 404, 405, 409, 413, 415, 429]) assert.ok(statuses.has(status), `a ${status} was checked (${[...statuses].sort().join(', ')})`);
});

/** Signs a second person up through an invitation to a company of their own, so they are a member elsewhere only. */
async function setupOutsider(person: Member): Promise<void> {
  const theirs = await createCompany(owner.browser, { name: 'Outsider Books' });
  const member = await invite(owner.browser, theirs, 'admin');
  person.browser.cookies.clear();
  for (const [name, value] of member.browser.cookies) person.browser.cookies.set(name, value);
  person.userId = member.userId;
}

test('a known path with a wrong method answers 405 with Allow, signed in; public paths do so signed out; other paths answer 401 signed out', async () => {
  const companyId = await createCompany(owner.browser, { name: 'Methods' });
  const books = await chart(owner.browser, companyId);
  const ledger = (await owner.browser.call(`/api/companies/${companyId}/ledgers`, { name: 'Methods Ledger', groupId: books.group('capital') })).body.ledger.id;
  const company = `/api/companies/${companyId}`, workspace = `/api/workspaces/${companyId}`;
  const signedIn: [string, string, string][] = [
    ['POST', '/api/health/live', 'GET, HEAD'], ['POST', '/api/health/ready', 'GET, HEAD'], ['POST', '/api/status', 'GET'], ['POST', '/api/session', 'GET'],
    ['DELETE', '/api/me', 'GET'], ['PUT', '/api/account/security', 'GET'], ['GET', '/api/auth/sign-out', 'POST'], ['GET', '/api/invitations/inspect', 'POST'],
    ['DELETE', '/api/companies', 'GET, POST'], ['PUT', `${workspace}/team`, 'GET'], ['GET', `${workspace}/rename`, 'POST'], ['GET', `${workspace}/members/${owner.userId}/role`, 'POST'],
    ['DELETE', `${company}/ledgers`, 'GET, POST'], ['PUT', `${company}/ledgers/${ledger}`, 'GET, POST'], ['GET', `${company}/ledgers/${ledger}/delete`, 'POST'],
    ['POST', `${company}/ledgers/${ledger}/revisions`, 'GET'], ['DELETE', `${company}/vouchers`, 'GET, POST'], ['PUT', `${company}/cost-categories`, 'GET, POST'],
    ['DELETE', `${company}/stock-units`, 'GET, POST'], ['PUT', `${company}/currencies`, 'GET, POST'], ['DELETE', `${company}/exchange-rates`, 'GET, POST'],
    ['PUT', `${company}/ageing-buckets`, 'GET, POST'], ['DELETE', '/api/account/keymap', 'GET, PUT'], ['DELETE', '/api/account/preferences', 'GET, POST'],
    ['GET', '/api/account/password', 'POST'], ['GET', '/api/account/two-factor/disable', 'POST'],
  ];
  for (const [method, path, allow] of signedIn) {
    const answer = await send(owner, method, path, method === 'GET' ? undefined : '{}');
    assert.deepEqual([answer.status, answer.allow], [405, allow], `${method} ${path}: ${answer.text.slice(0, 120)}`);
  }
  for (const [method, path, allow] of signedIn.filter(([, path]) => ['/api/health/live', '/api/health/ready', '/api/status', '/api/session', '/api/auth/sign-out', '/api/invitations/inspect'].includes(path))) {
    const answer = await send(null, method, path, method === 'GET' ? undefined : '{}');
    assert.deepEqual([answer.status, answer.allow], [405, allow], `signed out ${method} ${path}`);
  }
  // Account status and changes check the session before the method: signed out, a wrong method is 401 there too.
  for (const [method, path] of signedIn.filter(([, path]) => path.startsWith(company) || path.startsWith(workspace) || path.startsWith('/api/account/') || path === '/api/me')) {
    assert.equal((await send(null, method, path, method === 'GET' ? undefined : '{}')).status, 401, `signed out ${method} ${path} shows no route map`);
  }
});

test('the health probes answer HEAD as GET without a body, and a cross-origin write is refused there as on every path', async () => {
  for (const path of ['/api/health/live', '/api/health/ready']) {
    const get = await handleApi(new Request(new URL(path, getConfig().appUrl)));
    const head = await handleApi(new Request(new URL(path, getConfig().appUrl), { method: 'HEAD' }));
    assert.equal(get.status, 200, path);
    assert.deepEqual([head.status, head.headers.get('content-type'), await head.text()], [200, get.headers.get('content-type'), ''], `HEAD ${path}`);
    const foreign = await handleApi(new Request(new URL(path, getConfig().appUrl), { method: 'POST', headers: { origin: 'https://elsewhere.test' } }));
    assert.equal(foreign.status, 403, `cross-origin POST ${path}`);
  }
});

test('history reads: an id the company never had (or another company\'s) answers 404, a deleted master\'s history stays readable', async () => {
  const companyId = await createCompany(owner.browser, { name: 'Histories' });
  const otherId = await createCompany(owner.browser, { name: 'Other Histories' });
  const writer = await invite(owner.browser, companyId, 'editor');
  const books = await chart(owner.browser, companyId);
  const call = (path: string, body?: unknown, company = companyId) => writer.browser.call(`/api/companies/${company}${path}`, body);
  const theirs = (path: string, body?: unknown) => owner.browser.call(`/api/companies/${otherId}${path}`, body);
  const otherBooks = await chart(owner.browser, otherId);
  const made: [string, string, string][] = [
    ['/groups', (await theirs('/groups', { name: 'Their Group', nature: 'asset' })).body.group.id, (await call('/groups', { name: 'Gone Group', nature: 'asset' })).body.group.id],
    ['/ledgers', (await theirs('/ledgers', { name: 'Their Ledger', groupId: otherBooks.group('capital') })).body.ledger.id, (await call('/ledgers', { name: 'Gone Ledger', groupId: books.group('capital') })).body.ledger.id],
    ['/cost-categories', (await theirs('/cost-categories', { name: 'Their Category' })).body.costCategory.id, (await call('/cost-categories', { name: 'Gone Category' })).body.costCategory.id],
    ['/stock-units', (await theirs('/stock-units', { symbol: 'Thr' })).body.stockUnit.id, (await call('/stock-units', { symbol: 'Gon' })).body.stockUnit.id],
  ];
  for (const [path, otherCompanys, gone] of made) {
    assert.deepEqual([(await call(`${path}/${randomUUID()}/revisions`)).status, (await call(`${path}/${randomUUID()}/revisions`)).body.code], [404, 'not_found'], `${path}: never existed`);
    assert.equal((await call(`${path}/${otherCompanys}/revisions`)).status, 404, `${path}: another company's`);
    // The history's 404 is byte for byte the read route's, for an id that never existed and for another company's.
    for (const id of [randomUUID(), otherCompanys]) {
      assert.deepEqual(await send(writer, 'GET', `/api/companies/${companyId}${path}/${id}/revisions`), await send(writer, 'GET', `/api/companies/${companyId}${path}/${id}`), `${path}: the same 404 as the read`);
    }
    assert.equal((await call(`${path}/${gone}/delete`, { revision: 1 })).status, 200, `${path}: deleted`);
    const history = await call(`${path}/${gone}/revisions`);
    assert.deepEqual([history.status, history.body.revisions.map((row: { action: string }) => row.action)], [200, ['create', 'delete']], `${path}: a deleted master's history`);
  }
  // A seeded master nobody has changed exists and has no revision: its history is an empty list, not 404.
  const seeded = await call(`/groups/${books.group('indirect_expenses')}/revisions`);
  assert.deepEqual([seeded.status, seeded.body.revisions], [200, []], 'an unchanged seeded group');
  assert.equal((await call('/currencies', { code: 'USD', symbol: '$', formalName: 'US Dollar', decimals: 2 })).status, 201);
  assert.equal((await theirs('/currencies', { code: 'EUR', symbol: 'E', formalName: 'Euro', decimals: 2 })).status, 201);
  assert.deepEqual((await call('/currencies/JPY/revisions')).status, 404, 'a code the company never had');
  assert.deepEqual((await call('/currencies/EUR/revisions')).status, 404, 'another company\'s currency');
  for (const currency of ['JPY', 'EUR']) {
    assert.deepEqual(await send(writer, 'GET', `/api/companies/${companyId}/currencies/${currency}/revisions`), await send(writer, 'GET', `/api/companies/${companyId}/currencies/${currency}`), `${currency}: the same 404 as the read`);
  }
  assert.equal((await call('/currencies/USD/delete', { revision: 1 })).status, 200);
  const usd = await call('/currencies/USD/revisions');
  assert.deepEqual([usd.status, usd.body.revisions.map((row: { action: string }) => row.action)], [200, ['create', 'delete']], 'a deleted currency\'s history');
  // The code taken again and deleted again: its history is the last currency the company had under it.
  assert.equal((await call('/currencies', { code: 'USD', symbol: 'U$', formalName: 'US Dollar Again', decimals: 2 })).status, 201);
  assert.equal((await call('/currencies/USD/delete', { revision: 1 })).status, 200);
  const again = await call('/currencies/USD/revisions');
  assert.deepEqual([again.status, again.body.revisions.map((row: { action: string; before?: { symbol?: string }; after?: { symbol?: string } }) => [row.action, (row.after ?? row.before)?.symbol])],
    [200, [['create', 'U$'], ['delete', 'U$']]], 'the history of the currency deleted last');
});
