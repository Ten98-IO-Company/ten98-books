import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { demoRoot, loadDataset, type Dataset } from '../src/server/demo/dataset.ts';
import { seedDataset } from '../src/server/demo/seed.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { setupOwner, type Member } from './helpers/ledger.ts';

/**
 * Golden: the harbourview demo company (two cost categories, five centres, 71 lines with centres, 11 of them on foreign
 * currency lines at their base amounts) seeded by the demo seeder, which creates the categories and centres and sends each
 * line's rows through the ledger's posting path. The cost category summary and each centre's break-up are then read
 * through the API here, not through the demo comparison, and compared with `expected.json` for 2026 and with
 * `checkpoints.json` at its two dates. Optional and cancelled vouchers do not count.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let dataset: Dataset;
let companyId = '';
let seededRows = 0;
const folder = join(demoRoot, 'harbourview');
type Figures = Record<string, { debit: string; credit: string }>;
const expected = JSON.parse(readFileSync(join(folder, 'expected.json'), 'utf8')) as { costCentres: { from: string; to: string; centres: Figures } };
const checkpoints = JSON.parse(readFileSync(join(folder, 'checkpoints.json'), 'utf8')) as { dates: Record<string, { costCentres: Figures }> };
type CostLine = { centre: string; amount: string };
/** The centre keys of the dataset by the centre's name, and the books' centre ids by the same key. */
const keyOfName: Record<string, string> = {};
const idOfKey: Record<string, string> = {};

const call = (path: string, body?: unknown) => owner.browser.call(`/api/companies/${companyId}${path}`, body);

before(async () => {
  database = await freshDatabase('cost_golden');
  owner = await setupOwner();
  dataset = await loadDataset(folder);
  const report = await seedDataset(owner.userId, dataset);
  companyId = report.companyId;
  seededRows = report.costs.rowsPosted;
  for (const centre of dataset.extraFiles['costCentres.json'] as { key: string; name: string }[]) keyOfName[centre.name] = centre.key;
  const listed = await call('/cost-centres');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  for (const centre of listed.body.costCentres as { id: string; name: string }[]) idOfKey[keyOfName[centre.name]] = centre.id;
});
after(async () => { await database?.drop(); });

/** The summary's centres as the dataset's keys with their period debit and credit. */
async function summary(from: string, to: string): Promise<Figures> {
  const answer = await call(`/reports/cost-category-summary?from=${from}&to=${to}`);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return Object.fromEntries((answer.body.report.categories as { centres: { name: string; debit: string; credit: string }[] }[])
    .flatMap(category => category.centres.map(centre => [keyOfName[centre.name], { debit: centre.debit, credit: centre.credit }])));
}

/** Each expected centre's own break-up for the period: its total debit and credit (no sub-centres here, so its own rows). */
async function breakups(from: string, to: string, centres: Figures): Promise<Figures> {
  const found: Figures = {};
  for (const key of Object.keys(centres)) {
    const answer = await call(`/reports/cost-centre-breakup/${idOfKey[key]}?from=${from}&to=${to}`);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    found[key] = { debit: answer.body.report.totals.debit, credit: answer.body.report.totals.credit };
  }
  return found;
}

test('harbourview: the seeder carries the 71 dataset lines with centres, 11 of them on foreign-currency lines at base amounts, and the optional sales voucher among them', () => {
  const counted = { lines: 0, foreign: 0, optional: 0, cancelled: 0 };
  for (const voucher of dataset.vouchers) {
    const withCentres = voucher.lines.filter(line => (line.extras as { costCentres?: CostLine[] } | undefined)?.costCentres);
    counted.lines += withCentres.length;
    counted.foreign += withCentres.filter(line => (line.extras as { currency?: string }).currency).length;
    if (voucher.status === 'optional') counted.optional += withCentres.length;
    if (voucher.status === 'cancelled') counted.cancelled += withCentres.length;
  }
  assert.deepEqual(counted, { lines: 71, foreign: 11, optional: 1, cancelled: 0 });
  assert.equal(seededRows, 147, 'the rows of those lines, as the seeder sent them');
});

test('harbourview: the cost category summary for 2026 equals expected.json', async () => {
  assert.deepEqual(await summary(expected.costCentres.from, expected.costCentres.to), expected.costCentres.centres);
});

test('harbourview: the summary at each checkpoint equals checkpoints.json', async () => {
  for (const [date, checkpoint] of Object.entries(checkpoints.dates)) assert.deepEqual(await summary('2026-01-01', date), checkpoint.costCentres, date);
});

test('harbourview: each centre\'s break-up totals equal its figures in expected.json and at each checkpoint', async () => {
  assert.deepEqual(await breakups(expected.costCentres.from, expected.costCentres.to, expected.costCentres.centres), expected.costCentres.centres);
  for (const [date, checkpoint] of Object.entries(checkpoints.dates)) assert.deepEqual(await breakups('2026-01-01', date, checkpoint.costCentres), checkpoint.costCentres, date);
});
