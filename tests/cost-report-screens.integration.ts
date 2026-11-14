import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { costBreakupKey, costSummaryLines } from '../src/lib/reports.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { chart, createCompany, invite, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * What the cost category summary and cost centre break-up screens read and rely on, over the real HTTP contract: the
 * summary turned into table lines, the break-up rows and their keys, the drill targets (a centre's break-up, a ledger's
 * vouchers, which are not filtered by centre), the centre chooser's list, the switched-off company and the viewer.
 * The figures themselves are covered by tests/cost-centres.integration.ts.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let viewer: Member;
let company = '';
let books: Chart;
const ids: Record<string, string> = {};

const call = (path: string, body?: unknown, member: Member = owner) => member.browser.call(`/api/companies/${company}${path}`, body);
async function ok(path: string, body?: unknown, member: Member = owner, status = body === undefined ? 200 : 201): Promise<any> {
  const answer = await call(path, body, member);
  assert.equal(answer.status, status, `${path}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}
const period = 'from=2026-01-01&to=2026-01-31';

before(async () => {
  database = await freshDatabase('cost_report_screens');
  owner = await setupOwner();
  company = await createCompany(owner.browser, { name: 'Cost Report Screens' });
  viewer = await invite(owner.browser, company, 'viewer');
  books = await chart(owner.browser, company);
  await ok('/cost-centres-setting', { enabled: true }, owner, 200);
  ids.area = (await ok('/cost-categories', { name: 'Area' })).costCategory.id;
  ids.north = (await ok('/cost-centres', { name: 'North', categoryId: ids.area, parentId: null })).costCentre.id;
  ids.harbour = (await ok('/cost-centres', { name: 'Harbour', categoryId: ids.area, parentId: ids.north })).costCentre.id;
  ids.south = (await ok('/cost-centres', { name: 'South', categoryId: ids.area, parentId: null })).costCentre.id;
  ids.rent = (await ok('/ledgers', { name: 'Site Rent', groupId: books.group('indirect_expenses') })).ledger.id;
  ids.cash = books.ledger('Cash');
  const pay = (date: string, amount: string, rows: [string, string][]) => ok('/vouchers', {
    idempotencyKey: `screens-${randomUUID()}`, voucherTypeId: books.type('payment'), date,
    lines: [{ ledgerId: ids.rent, side: 'Dr', amount, ...rows.length ? { costAllocations: rows.map(([costCentreId, value]) => ({ costCentreId, amount: value })) } : {} }, { ledgerId: ids.cash, side: 'Cr', amount }],
  });
  // Two vouchers with allocations, one of them on a sub-centre, and a third left without a centre.
  await pay('2026-01-05', '100', [[ids.north, '60'], [ids.south, '40']]);
  await pay('2026-01-10', '30', [[ids.harbour, '30']]);
  await pay('2026-01-20', '25', []);
});
after(async () => { await database?.drop(); });

test('the summary becomes one category line and its top-level centres, a sub-centre folded into its parent', async () => {
  const summary = (await ok(`/reports/cost-category-summary?${period}`)).report;
  const lines = costSummaryLines(summary);
  assert.deepEqual(lines.map(line => [line.key, line.depth, line.name, line.closing]), [
    [`k:${ids.area}`, 0, 'Area', '130.00'], [`c:${ids.north}`, 1, 'North', '90.00'], [`c:${ids.south}`, 1, 'South', '40.00'],
  ]);
  // The empty general category has no line, as observed.
  assert.ok(!lines.some(line => line.name === 'General'));
});

test('the break-up lists a sub-centre and the ledgers, each with its own key, and both drill targets answer', async () => {
  const breakup = (await ok(`/reports/cost-centre-breakup/${ids.north}?${period}`)).report;
  assert.deepEqual(breakup.centre, { id: ids.north, name: 'North', categoryId: ids.area, categoryName: 'Area' });
  assert.deepEqual(breakup.rows.map((row: any) => [costBreakupKey(row), row.name, row.closing]), [[`c:${ids.harbour}`, 'Harbour', '30.00'], [`l:${ids.rent}`, 'Site Rent', '60.00']]);
  assert.equal(breakup.totals.closing, '90.00', 'the total equals the centre in the summary');
  // Enter on the sub-centre: its own break-up. Enter on the ledger: its vouchers for the period, every centre's.
  assert.equal((await ok(`/reports/cost-centre-breakup/${ids.harbour}?${period}`)).report.totals.closing, '30.00');
  const vouchers = (await ok(`/reports/ledger-vouchers/${ids.rent}?${period}`)).report;
  assert.equal(vouchers.totals.closing, '155.00', 'the ledger vouchers are not filtered by centre (a gap, documented)');
  // The chooser lists every centre with its category.
  const centres = (await ok('/cost-centres')).costCentres as any[];
  assert.deepEqual(centres.map(row => [row.name, row.categoryName]).sort(), [['Harbour', 'Area'], ['North', 'Area'], ['South', 'Area']]);
});

test('a viewer reads both reports and their exports; switched off, the saved amounts still count', async () => {
  assert.equal((await ok(`/reports/cost-category-summary?${period}`, undefined, viewer)).report.categories.length, 1);
  assert.equal((await ok(`/reports/cost-centre-breakup/${ids.north}?${period}`, undefined, viewer)).report.totals.closing, '90.00');
  assert.equal((await ok('/cost-centres-setting', undefined, viewer)).costCentres.enabled, true);
  const { handleApi } = await import('../src/server/api.ts');
  const { getConfig } = await import('../src/server/config.ts');
  const headers = new Headers({ cookie: [...viewer.browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ') });
  for (const path of [`reports/cost-category-summary/export?${period}`, `reports/cost-centre-breakup/${ids.north}/export?${period}`]) {
    const response = await handleApi(new Request(new URL(`/api/companies/${company}/${path}`, getConfig().appUrl), { headers }));
    assert.deepEqual([response.status, response.headers.get('content-type')], [200, 'text/csv; charset=utf-8'], path);
  }
  await ok('/cost-centres-setting', { enabled: false }, owner, 200);
  assert.equal((await ok('/cost-centres-setting', undefined, viewer)).costCentres.enabled, false, 'the screens show the switched-off notice');
  assert.equal((await ok(`/reports/cost-category-summary?${period}`, undefined, viewer)).report.categories[0].closing, '130.00');
  await ok('/cost-centres-setting', { enabled: true }, owner, 200);
});

test('the paths the screens call refuse a bad period (400) and an unknown or foreign subject (404), exports alike', async () => {
  const other = await createCompany(owner.browser, { name: 'Other Cost Screens' });
  const foreignCentre = (await owner.browser.call(`/api/companies/${other}/cost-centres`, { name: 'Elsewhere', categoryId: ((await owner.browser.call(`/api/companies/${other}/cost-categories`)).body.costCategories as any[])[0].id, parentId: null })).body.costCentre.id;
  const cases: [string, number][] = [
    ['/reports/cost-category-summary?from=2026-02-01&to=2026-01-01', 400],
    ['/reports/cost-category-summary?from=2026-02-30&to=2026-03-01', 400],
    ['/reports/cost-category-summary?from=2026-01-01', 400],
    [`/reports/cost-category-summary?${period}&categoryId=${randomUUID()}`, 404],
    [`/reports/cost-centre-breakup/${ids.north}?from=2026-02-01&to=2026-01-01`, 400],
    [`/reports/cost-centre-breakup/${ids.north}?${period}&extra=1`, 400],
    [`/reports/cost-centre-breakup/${randomUUID()}?${period}`, 404],
    [`/reports/cost-centre-breakup/${foreignCentre}?${period}`, 404],
    [`/reports/cost-centre-breakup/${randomUUID()}/export?${period}`, 404],
    [`/reports/ledger-vouchers/${randomUUID()}?${period}`, 404],
  ];
  for (const [path, status] of cases) {
    const answer = await call(path, undefined, viewer);
    assert.equal(answer.status, status, `${path}: ${JSON.stringify(answer.body)}`);
    assert.ok(typeof answer.body?.error === 'string' && answer.body.error.length > 0, `${path} says why`);
  }
  // Signed out, the screens are asked to sign in.
  const stranger = (await import('./helpers/ledger.ts')).browser();
  assert.equal((await stranger.call(`/api/companies/${company}/reports/cost-category-summary?${period}`)).status, 401);
});
