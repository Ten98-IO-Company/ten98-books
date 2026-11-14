import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { getDatabase } from '../src/server/db.ts';
import { demoRoot, loadDataset, toMinor, type Dataset } from '../src/server/demo/dataset.ts';
import { seedDataset, voucherKeyPrefix } from '../src/server/demo/seed.ts';
import { setCompanyScope } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, setupOwner, type Member } from './helpers/ledger.ts';

/**
 * Golden: the harbourview demo company (two cost categories, five centres, 71 lines with centres, 11 of them on foreign
 * currency lines at their base amounts) loaded inside the test, its categories, centres and allocation rows added as the
 * application role (the demo seeder does not model them yet), then the cost category summary compared with
 * `expected.json` for 2026 and with `checkpoints.json` at its two dates. Optional and cancelled vouchers do not count.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let dataset: Dataset;
let companyId = '';
const folder = join(demoRoot, 'harbourview');
const expected = JSON.parse(readFileSync(join(folder, 'expected.json'), 'utf8')) as { costCentres: { from: string; to: string; centres: Record<string, { debit: string; credit: string }> } };
const checkpoints = JSON.parse(readFileSync(join(folder, 'checkpoints.json'), 'utf8')) as { dates: Record<string, { costCentres: Record<string, { debit: string; credit: string }> }> };
type CostLine = { centre: string; amount: string };
const centreKeys: Record<string, string> = {};
const counted = { lines: 0, foreign: 0, optional: 0, cancelled: 0 };

const call = (path: string, body?: unknown) => owner.browser.call(`/api/companies/${companyId}${path}`, body);

before(async () => {
  database = await freshDatabase('cost_golden');
  owner = await setupOwner();
  dataset = await loadDataset(folder);
  companyId = (await seedDataset(owner.userId, dataset)).companyId;
  assert.equal((await call('/cost-centres-setting', { enabled: true })).status, 200);
  const categories: Record<string, string> = {};
  for (const category of dataset.extraFiles['costCategories.json'] as { key: string; name: string; allocateRevenue: boolean; allocateNonRevenue: boolean }[]) {
    const made = await call('/cost-categories', { name: category.name, allocateRevenue: category.allocateRevenue, allocateNonRevenue: category.allocateNonRevenue });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    categories[category.key] = made.body.costCategory.id;
  }
  const centres: Record<string, { id: string; category: string }> = {};
  for (const centre of dataset.extraFiles['costCentres.json'] as { key: string; name: string; category: string }[]) {
    const made = await call('/cost-centres', { name: centre.name, categoryId: categories[centre.category], parentId: null });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    centres[centre.key] = { id: made.body.costCentre.id, category: categories[centre.category] };
    centreKeys[centre.name] = centre.key;
  }

  // The posted vouchers by dataset key; a line's number is its position in the dataset.
  const prefix = voucherKeyPrefix(dataset.slug);
  const posted = new Map((await asAdmin(database.adminUrl, admin => admin.query<{ key: string; id: string; status: string }>(
    'SELECT idempotency_key AS key, id, status FROM voucher WHERE company_id = $1 AND starts_with(idempotency_key, $2)', [companyId, prefix]))).rows
    .map(row => [row.key.slice(prefix.length), row]));
  const ledgerIds = new Map((await call('/ledgers')).body.ledgers.map((ledger: { id: string; name: string; costCentres: boolean }) => [ledger.name, ledger]));
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await setCompanyScope(client, [companyId]);
    for (const voucher of dataset.vouchers) {
      const stored = posted.get(voucher.key);
      for (const [index, line] of voucher.lines.entries()) {
        const extras = line.extras as { costCentres?: CostLine[]; currency?: string } | undefined;
        if (!extras?.costCentres) continue;
        counted.lines++;
        if (!stored) continue;
        // Rows of a cancelled voucher are frozen: it was cancelled by the seeder, so it keeps none (it counts nowhere anyway).
        if (stored.status === 'cancelled') { counted.cancelled++; continue; }
        if (extras.currency && extras.currency !== dataset.company.baseCurrency) counted.foreign++;
        if (stored.status === 'optional') counted.optional++;
        const ledgerName = dataset.ledgers.find(entry => entry.key === line.ledger)!.name;
        assert.equal((ledgerIds.get(ledgerName) as { costCentres: boolean }).costCentres, true, `${ledgerName} takes cost centres`);
        for (const row of extras.costCentres) {
          await client.query(`INSERT INTO cost_allocation (company_id, voucher_id, line_no, ledger_id, category_id, cost_centre_id, side, amount)
            SELECT $1, $2, $3, l.ledger_id, $4, $5, l.side, $6 FROM voucher_line l WHERE l.company_id = $1 AND l.voucher_id = $2 AND l.line_no = $3`,
          [companyId, stored.id, index + 1, centres[row.centre].category, centres[row.centre].id, toMinor(row.amount, dataset.company.minorUnits as 2)]);
        }
      }
    }
    // The database's per-line check accepts every line: each category adds up to the line's base amount.
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
after(async () => { await database?.drop(); });

/** The summary's centres as the dataset's keys with their period debit and credit. */
async function summary(from: string, to: string): Promise<Record<string, { debit: string; credit: string }>> {
  const answer = await call(`/reports/cost-category-summary?from=${from}&to=${to}`);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return Object.fromEntries((answer.body.report.categories as { centres: { name: string; debit: string; credit: string }[] }[])
    .flatMap(category => category.centres.map(centre => [centreKeys[centre.name], { debit: centre.debit, credit: centre.credit }])));
}

test('harbourview: the allocation rows load with 11 foreign-currency lines at base amounts and the optional sales voucher among them', () => {
  assert.deepEqual(counted, { lines: 71, foreign: 11, optional: 1, cancelled: 0 });
});

test('harbourview: the cost category summary for 2026 equals expected.json', async () => {
  assert.deepEqual(await summary(expected.costCentres.from, expected.costCentres.to), expected.costCentres.centres);
});

test('harbourview: the summary at each checkpoint equals checkpoints.json', async () => {
  for (const [date, checkpoint] of Object.entries(checkpoints.dates)) assert.deepEqual(await summary('2026-01-01', date), checkpoint.costCentres, date);
});
