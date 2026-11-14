import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/server/api.ts';
import { getConfig } from '../src/server/config.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, invite, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * Cost categories and cost centres (M2a slice 2) through the HTTP contract as the application role. Each case
 * reproduces a behaviour observed on the reference workflow (`observed/30`, private notes: P1 to P7, Q7, Q8, Q19) or a
 * decision of the slice-2 design, which the case names.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('cost_centres');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

type Cost = [centreId: string, amount: string, extra?: { categoryId?: string; side?: 'Dr' | 'Cr' }];
type Line = { ledgerId: string; side: 'Dr' | 'Cr'; amount: string; costAllocations?: unknown[]; bills?: unknown[] };
const line = (ledgerId: string, side: 'Dr' | 'Cr', amount: string, cost?: Cost[], bills?: unknown[]): Line => ({
  ledgerId, side, amount,
  ...(cost ? { costAllocations: cost.map(([costCentreId, value, extra]) => ({ costCentreId, amount: value, ...extra })) } : {}),
  ...(bills ? { bills } : {}),
});
const codes = (body: { warnings: { code: string; line: number | null }[] }) => body.warnings.map(item => `${item.code}@${item.line}`);
/** A stored line's rows as `centre name:category name:side:amount`. */
const rowsOf = (voucherLine: any) => voucherLine.costAllocations.map((row: any) => `${row.costCentreName}:${row.categoryName}:${row.side}:${row.amount}`);

/** One company's API with the helpers the cases need. */
async function books(name: string, member: Member = owner) {
  const companyId = await createCompany(member.browser, { name });
  const accounts: Chart = await chart(member.browser, companyId);
  const call = (path: string, body?: unknown) => member.browser.call(`/api/companies/${companyId}${path}`, body);
  const ok = async (path: string, body?: unknown, status = body === undefined ? 200 : 201) => {
    const answer = await call(path, body);
    assert.equal(answer.status, status, `${path}: ${JSON.stringify(answer.body)}`);
    return answer.body;
  };
  const ledger = async (ledgerName: string, groupKey: string, extra: Record<string, unknown> = {}) =>
    (await ok('/ledgers', { name: ledgerName, groupId: accounts.group(groupKey), ...extra })).ledger.id as string;
  const category = async (categoryName: string, extra: Record<string, unknown> = {}) => (await ok('/cost-categories', { name: categoryName, ...extra })).costCategory.id as string;
  const centre = async (centreName: string, categoryId: string, parentId: string | null = null) =>
    (await ok('/cost-centres', { name: centreName, categoryId, parentId })).costCentre.id as string;
  const general = async () => ((await ok('/cost-categories')).costCategories as any[]).find(row => row.systemKey === 'primary').id as string;
  const enable = async (enabled = true) => ok('/cost-centres-setting', { enabled }, 200);
  const voucher = async (kind: string, date: string, lines: Line[], extra: Record<string, unknown> = {}, status = 201) => {
    const posted = await call('/vouchers', { idempotencyKey: `cost-${randomUUID()}`, voucherTypeId: accounts.type(kind), date, lines, ...extra });
    assert.equal(posted.status, status, JSON.stringify(posted.body));
    return posted.body;
  };
  /** Re-sends a voucher as read (bill rows and cost rows included unless `lines` replaces them). */
  const alter = async (voucher: any, changes: Record<string, unknown> = {}, status = 200) => {
    const body = {
      date: voucher.date, narration: voucher.narration, status: voucher.status, postDated: voucher.postDated, reference: voucher.reference,
      referenceDate: voucher.referenceDate, revision: voucher.revision,
      lines: voucher.lines.map((item: any) => ({ ledgerId: item.ledgerId, side: item.side, amount: item.amount,
        bills: item.bills.map((row: any) => ({ kind: row.kind, amount: row.amount, side: row.side, ...(row.kind === 'on_account' ? {} : { name: row.billName }) })),
        costAllocations: item.costAllocations.map((row: any) => ({ costCentreId: row.costCentreId, categoryId: row.categoryId, amount: row.amount, side: row.side })) })),
      ...changes,
    };
    const altered = await call(`/vouchers/${voucher.id}`, body);
    assert.equal(altered.status, status, JSON.stringify(altered.body));
    return altered.body;
  };
  const alterLedger = async (ledgerId: string, changes: Record<string, unknown>) => {
    const current = (await ok(`/ledgers/${ledgerId}`)).ledger;
    return (await ok(`/ledgers/${ledgerId}`, { name: current.name, groupId: current.groupId, revision: current.revision, ...changes }, 200)).ledger;
  };
  const moveCentre = async (centreId: string, changes: Record<string, unknown>) => {
    const current = (await ok(`/cost-centres/${centreId}`)).costCentre;
    return (await ok(`/cost-centres/${centreId}`, { name: current.name, categoryId: current.categoryId, parentId: current.parentId, revision: current.revision, ...changes }, 200)).costCentre;
  };
  const summary = async (from: string, to: string) => (await ok(`/reports/cost-category-summary?from=${from}&to=${to}`)).report;
  /** The summary as `category: centre debit/credit/closing ...`, sorted, for compact comparison. */
  const figures = async (from: string, to: string) => (await summary(from, to)).categories.map((item: any) =>
    `${item.name} ${item.debit}/${item.credit}: ${item.centres.map((row: any) => `${row.name} ${row.opening}+${row.debit}-${row.credit}=${row.closing}`).join(', ')}`);
  return { companyId, accounts, call, ok, ledger, category, centre, general, enable, voucher, alter, alterLedger, moveCentre, summary, figures };
}

test('the general category is seeded and kept; names are unique across centres; a parent of another category, a cycle and used rows are refused (P4, P7, Q19)', async () => {
  const b = await books('Cost Masters');
  const [seeded] = (await b.ok('/cost-categories')).costCategories;
  assert.deepEqual([seeded.systemKey, seeded.name, seeded.allocateRevenue, seeded.allocateNonRevenue, seeded.inUse], ['primary', 'General', true, true, false]);
  const channel = await b.category('Channel');
  const created = (await b.ok(`/cost-categories/${channel}`)).costCategory;
  assert.deepEqual([created.allocateRevenue, created.allocateNonRevenue], [true, false], 'a new category allocates revenue items only unless told');
  assert.deepEqual([(await b.call('/cost-categories', { name: ' channel ' })).body.code], ['duplicate_name']);

  const showroom = await b.centre('Showroom', channel);
  const refused = await b.call('/cost-centres', { name: 'SHOWROOM', categoryId: seeded.id, parentId: null });
  assert.deepEqual([refused.status, refused.body.code], [409, 'duplicate_name'], 'one name space for the centres of every category');
  const wrongParent = await b.call('/cost-centres', { name: 'Floor', categoryId: seeded.id, parentId: showroom });
  assert.deepEqual([wrongParent.status, wrongParent.body.code], [400, 'validation'], 'a centre placed under another goes in its category');
  const floor = await b.centre('Floor', channel, showroom);
  const cycle = await b.call(`/cost-centres/${showroom}`, { name: 'Showroom', categoryId: channel, parentId: floor, revision: 1 });
  assert.deepEqual([cycle.status, cycle.body.code], [400, 'cycle']);
  assert.deepEqual(((await b.ok('/cost-centres')).costCentres as any[]).map(row => [row.name, row.categoryName, row.inUse]), [['Floor', 'Channel', false], ['Showroom', 'Channel', true]]);

  const general = await b.call(`/cost-categories/${seeded.id}/delete`, { revision: seeded.revision });
  assert.deepEqual([general.status, general.body.code], [409, 'seeded_row']);
  const renamed = (await b.ok(`/cost-categories/${seeded.id}`, { name: 'Main', revision: seeded.revision }, 200)).costCategory;
  assert.deepEqual([renamed.name, renamed.systemKey, renamed.allocateNonRevenue], ['Main', 'primary', true], 'the seeded category is renamed freely and keeps its settings');
  assert.deepEqual([(await b.call(`/cost-categories/${channel}/delete`, { revision: 1 })).body.code], ['in_use'], 'a category holding centres');
  assert.deepEqual([(await b.call(`/cost-centres/${showroom}/delete`, { revision: 1 })).body.code], ['in_use'], 'a centre holding sub-centres');

  await b.centre('Channel', seeded.id);
  assert.equal((await b.ok('/cost-categories')).costCategories.length, 2, 'a category and a centre may share a name (separate name spaces)');
  const spare = await b.centre('Spare', channel);
  assert.equal((await b.ok(`/cost-centres/${spare}/delete`, { revision: 1 }, 200)).deleted, true, 'an unused centre is deleted (P7)');
  assert.deepEqual(((await b.ok(`/cost-centres/${spare}/revisions`)).revisions as any[]).map(row => row.action), ['create', 'delete']);
  assert.equal((await b.call(`/cost-centres/${spare}`)).status, 404);
});

test('the company feature is off by default; owners and admins switch it, editors and viewers are told the company is not there', async () => {
  const b = await books('Cost Setting');
  assert.deepEqual((await b.ok('/cost-centres-setting')).costCentres, { enabled: false });
  for (const role of ['editor', 'viewer'] as const) {
    const member = await invite(owner.browser, b.companyId, role);
    const answer = await member.browser.call(`/api/companies/${b.companyId}/cost-centres-setting`, { enabled: true });
    assert.deepEqual([answer.status, answer.body.code], [404, 'not_found'], role);
    assert.deepEqual((await member.browser.call(`/api/companies/${b.companyId}/cost-centres-setting`)).body.costCentres, { enabled: false }, `${role} reads it`);
  }
  const admin = await invite(owner.browser, b.companyId, 'admin');
  assert.deepEqual((await admin.browser.call(`/api/companies/${b.companyId}/cost-centres-setting`, { enabled: true })).body.costCentres, { enabled: true });
  assert.deepEqual((await b.ok('/cost-centres-setting')).costCentres, { enabled: true });
});

test('new income and expense ledgers take cost centres, others do not unless set; the profit and loss ledger never does', async () => {
  const b = await books('Cost Ledgers');
  const read = async (id: string) => (await b.ok(`/ledgers/${id}`)).ledger.costCentres;
  assert.deepEqual([await read(await b.ledger('Sales', 'sales')), await read(await b.ledger('Rent', 'indirect_expenses')),
    await read(await b.ledger('Bank', 'bank_accounts')), await read(await b.ledger('Equipment', 'fixed_assets', { costCentres: true }))], [true, true, false, true]);
  const profitAndLoss = ((await b.ok('/ledgers')).ledgers as any[]).find(row => row.systemKey === 'profit_and_loss');
  const refused = await b.call(`/ledgers/${profitAndLoss.id}`, { name: profitAndLoss.name, groupId: null, revision: profitAndLoss.revision, costCentres: true });
  assert.deepEqual([refused.status, refused.body.code], [400, 'family_rule']);
});

test('posting: each category nets to the line, the last row may be negative, categories are optional; mismatches, duplicates and unknown centres are refused (P1a, P2, P4, Q7, Q8)', async () => {
  const b = await books('Cost Posting');
  const sales = await b.ledger('Sales', 'sales'), bank = await b.ledger('Bank', 'bank_accounts'), party = await b.ledger('Party', 'receivables');
  const equipment = await b.ledger('Equipment', 'fixed_assets', { costCentres: true });
  const channel = await b.category('Channel'), projects = await b.category('Projects', { allocateNonRevenue: true });
  const showroom = await b.centre('Showroom', channel), online = await b.centre('Online', channel);
  const north = await b.centre('P-North', projects), south = await b.centre('P-South', projects);
  await b.centre('P-South-A', projects, south);

  const off = await b.voucher('sales', '2026-02-01', [line(party, 'Dr', '100'), line(sales, 'Cr', '100', [[showroom, '100']])]);
  assert.deepEqual([codes(off), off.voucher.lines[1].costAllocations], [['cost_ignored@2'], []], 'rows are dropped while the company feature is off');
  await b.enable();

  const sale = await b.voucher('sales', '2026-02-02', [line(party, 'Dr', '1000'), line(sales, 'Cr', '1000', [[showroom, '600'], [online, '400'], [north, '1000']])]);
  assert.deepEqual([codes(sale), rowsOf(sale.voucher.lines[1])], [[], ['Showroom:Channel:Cr:600.00', 'Online:Channel:Cr:400.00', 'P-North:Projects:Cr:1000.00']]);
  const negative = await b.voucher('sales', '2026-02-03', [line(party, 'Dr', '1000'), line(sales, 'Cr', '1000', [[showroom, '1200'], [online, '200', { side: 'Dr' }]])]);
  assert.deepEqual(rowsOf(negative.voucher.lines[1]), ['Showroom:Channel:Cr:1200.00', 'Online:Channel:Dr:200.00'], 'the last row may go to the other side (Q7)');
  const none = await b.voucher('sales', '2026-02-04', [line(party, 'Dr', '175'), line(sales, 'Cr', '175')]);
  assert.deepEqual(none.voucher.lines[1].costAllocations, [], 'a line may carry no rows (P1a)');
  const parent = await b.voucher('sales', '2026-02-05', [line(party, 'Dr', '50'), line(sales, 'Cr', '50', [[south, '50']])]);
  assert.deepEqual(rowsOf(parent.voucher.lines[1]), ['P-South:Projects:Cr:50.00'], 'a centre with sub-centres takes rows (Q19)');
  const asset = await b.voucher('payment', '2026-02-06', [line(equipment, 'Dr', '300', [[showroom, '300']]), line(bank, 'Cr', '300', [[north, '300']])]);
  assert.deepEqual([codes(asset), rowsOf(asset.voucher.lines[0]), asset.voucher.lines[1].costAllocations], [['cost_ignored@2'], ['Showroom:Channel:Dr:300.00'], []],
    'a non-revenue line takes rows in a category that does not allocate non-revenue items (P2); the bank ledger takes none');

  const count = async () => Number((await asAdmin(database.adminUrl, admin => admin.query('SELECT count(*) FROM voucher WHERE company_id = $1', [b.companyId]))).rows[0].count);
  const before = await count();
  const refusals: [string, Cost[], number, string][] = [
    ['under the line (P4: 40 of 50)', [[showroom, '40']], 400, 'allocation_total'],
    ['over the line (P4: 40 of 30)', [[showroom, '40'], [online, '20']], 400, 'allocation_total'],
    ['to the other side', [[showroom, '50', { side: 'Dr' }]], 400, 'allocation_total'],
    ['one category short while another adds up', [[showroom, '50'], [north, '30']], 400, 'allocation_total'],
    ['the same centre twice in one category (P4)', [[showroom, '25'], [showroom, '25']], 400, 'validation'],
    ['an unknown centre', [[randomUUID(), '50']], 400, 'not_found'],
    ['a category the voucher never stored for the centre', [[showroom, '50', { categoryId: projects }]], 400, 'validation'],
    ['a zero row', [[showroom, '0'], [online, '50']], 400, 'validation'],
  ];
  for (const [name, cost, status, code] of refusals) {
    const answer = await b.call('/vouchers', { idempotencyKey: `cost-${randomUUID()}`, voucherTypeId: b.accounts.type('sales'), date: '2026-02-07',
      lines: [line(party, 'Dr', '50'), line(sales, 'Cr', '50', cost)] });
    assert.deepEqual([answer.status, answer.body.code], [status, code], name);
  }
  assert.equal(await count(), before, 'nothing was created by a refused voucher');
  assert.deepEqual([(await b.call(`/cost-centres/${north}/delete`, { revision: 1 })).body.code], ['in_use'], 'a used centre (P7)');

  // A category no longer holding centres but used by rows is refused as well (P7).
  const temporary = await b.category('Temporary'), loose = await b.centre('Loose', temporary);
  await b.voucher('sales', '2026-02-08', [line(party, 'Dr', '10'), line(sales, 'Cr', '10', [[loose, '10']])]);
  await b.moveCentre(loose, { categoryId: channel });
  const used = (await b.ok(`/cost-categories/${temporary}`)).costCategory;
  assert.deepEqual([used.inUse, (await b.call(`/cost-categories/${temporary}/delete`, { revision: used.revision })).body.code], [true, 'in_use']);
});

test('a centre moved to another category: vouchers keep the stored category, the summary regroups it; re-sent with a line inserted above, the stored pair is accepted (P3, Q19)', async () => {
  const b = await books('Cost Moves');
  await b.enable();
  const sales = await b.ledger('Sales', 'sales'), other = await b.ledger('Other Income', 'indirect_income'), party = await b.ledger('Party', 'receivables');
  const channel = await b.category('Channel'), projects = await b.category('Projects');
  const east = await b.centre('P-East', projects);
  const posted = (await b.voucher('sales', '2026-03-01', [line(party, 'Dr', '1000'), line(sales, 'Cr', '1000', [[east, '1000']])])).voucher;
  await b.moveCentre(east, { categoryId: channel });

  const read = (await b.ok(`/vouchers/${posted.id}`)).voucher;
  assert.deepEqual([read.lines[1].costAllocations[0].categoryId, rowsOf(read.lines[1])], [projects, ['P-East:Projects:Cr:1000.00']], 'the voucher keeps the category it was saved with');
  assert.deepEqual(await b.figures('2026-01-01', '2026-12-31'), ['Channel 0.00/1000.00: P-East 0.00+0.00-1000.00=-1000.00', 'General 0.00/0.00: ', 'Projects 0.00/0.00: '],
    'the summary groups by the category the centre is in now');

  const moved = await b.alter(read, { lines: [line(party, 'Dr', '1100'), line(other, 'Cr', '100'),
    line(sales, 'Cr', '1000', [[east, '1000', { categoryId: projects }]])] });
  assert.deepEqual([moved.voucher.lines.length, rowsOf(moved.voucher.lines[2])], [3, ['P-East:Projects:Cr:1000.00']], 'the stored pair moved to line 3 with its category');
  const fresh = await b.call('/vouchers', { idempotencyKey: `cost-${randomUUID()}`, voucherTypeId: b.accounts.type('sales'), date: '2026-03-02',
    lines: [line(party, 'Dr', '10'), line(sales, 'Cr', '10', [[east, '10', { categoryId: projects }]])] });
  assert.deepEqual([fresh.status, fresh.body.code], [400, 'validation'], 'another voucher cannot use the old category');
});

test('after the ledger stops taking cost centres, an alter keeps rows sent (cost_kept) or rebalances the kept rows on each category\'s last row (cost_rebalanced)', async () => {
  const b = await books('Cost Flag Off');
  await b.enable();
  const consulting = await b.ledger('Consulting', 'sales'), party = await b.ledger('Party', 'receivables');
  const channel = await b.category('Channel'), projects = await b.category('Projects');
  const showroom = await b.centre('Showroom', channel), online = await b.centre('Online', channel), north = await b.centre('P-North', projects);
  let voucher = (await b.voucher('sales', '2026-04-01', [line(party, 'Dr', '1000'), line(consulting, 'Cr', '1000', [[showroom, '600'], [online, '400'], [north, '1000']])])).voucher;
  await b.alterLedger(consulting, { costCentres: false });
  const step = async (amount: string, cost: Cost[] | null, expected: string[], warnings: string[]) => {
    const answer = await b.alter(voucher, { lines: [line(party, 'Dr', amount), line(consulting, 'Cr', amount, cost ?? undefined)] });
    assert.deepEqual([codes(answer), rowsOf(answer.voucher.lines[1])], [warnings, expected], `${amount} with ${cost ? 'rows' : 'no rows'}`);
    voucher = answer.voucher;
  };
  await step('900', [[showroom, '500'], [online, '400'], [north, '900']], ['Showroom:Channel:Cr:500.00', 'Online:Channel:Cr:400.00', 'P-North:Projects:Cr:900.00'], ['cost_kept@2']);
  await step('1200', null, ['Showroom:Channel:Cr:500.00', 'Online:Channel:Cr:700.00', 'P-North:Projects:Cr:1200.00'], ['cost_rebalanced@2']);
  await step('300', null, ['Showroom:Channel:Cr:500.00', 'Online:Channel:Dr:200.00', 'P-North:Projects:Cr:300.00'], ['cost_rebalanced@2']);
  await step('500', null, ['Showroom:Channel:Cr:500.00', 'P-North:Projects:Cr:500.00'], ['cost_rebalanced@2']);
  await step('500', null, ['Showroom:Channel:Cr:500.00', 'P-North:Projects:Cr:500.00'], ['cost_kept@2']);
  const omitted = await b.alter(voucher, { narration: 'rows as read' });
  assert.deepEqual(codes(omitted), ['cost_kept@2'], 'rows re-sent as read are kept');
  voucher = omitted.voucher;
  const mismatch = await b.call(`/vouchers/${voucher.id}`, { date: voucher.date, narration: null, status: 'regular', postDated: false, reference: null, referenceDate: null,
    revision: voucher.revision, lines: [line(party, 'Dr', '500'), line(consulting, 'Cr', '500', [[showroom, '400']])] });
  assert.deepEqual([mismatch.status, mismatch.body.code], [400, 'allocation_total'], 'rows sent while off still add up to the line');
  const fresh = await b.voucher('sales', '2026-04-02', [line(party, 'Dr', '50'), line(consulting, 'Cr', '50', [[showroom, '50']])]);
  assert.deepEqual(codes(fresh), ['cost_ignored@2'], 'a line that had no rows takes none');

  // The company feature switched off behaves the same; the rows already posted still count in the reports.
  await b.alterLedger(consulting, { costCentres: true });
  await b.enable(false);
  const kept = await b.alter(voucher, { narration: 'feature off' });
  assert.deepEqual([codes(kept), rowsOf(kept.voucher.lines[1])], [['cost_kept@2'], ['Showroom:Channel:Cr:500.00', 'P-North:Projects:Cr:500.00']]);
  assert.deepEqual(await b.figures('2026-01-01', '2026-12-31'), ['Channel 0.00/500.00: Online 0.00+0.00-0.00=0.00, Showroom 0.00+0.00-500.00=-500.00', 'General 0.00/0.00: ', 'Projects 0.00/500.00: P-North 0.00+0.00-500.00=-500.00']);
  // Declared difference: the reference drops such rows silently when the voucher is saved again; here only an empty list
  // drops them, and the answer says so.
  const dropped = await b.alter(kept.voucher, { lines: [line(party, 'Dr', '500'), line(consulting, 'Cr', '500', [])] });
  assert.deepEqual([codes(dropped), dropped.voucher.lines[1].costAllocations], [['cost_dropped@2'], []]);
});

test('bill rows and cost rows on one line stay through an alter and a date moved into the next financial year', async () => {
  const b = await books('Cost And Bills');
  await b.enable();
  const sales = await b.ledger('Sales', 'sales'), projects = await b.category('Projects'), north = await b.centre('P-North', projects);
  const party = await b.ledger('Project Debtor', 'receivables', { costCentres: true });
  const posted = (await b.voucher('sales', '2026-12-20', [line(party, 'Dr', '1050', [[north, '1050']], [{ kind: 'new_ref', name: 'INV-9', amount: '1050' }]), line(sales, 'Cr', '1050', [[north, '1050']])])).voucher;
  const billId = posted.lines[0].bills[0].billId;
  const altered = (await b.alter(posted, { narration: 'checked' })).voucher;
  assert.deepEqual([altered.lines[0].bills[0].billId, rowsOf(altered.lines[0]), rowsOf(altered.lines[1])], [billId, ['P-North:Projects:Dr:1050.00'], ['P-North:Projects:Cr:1050.00']]);
  const moved = (await b.alter(altered, { date: '2027-01-10' })).voucher;
  assert.deepEqual([moved.number === 1 && moved.date === '2027-01-10', moved.lines[0].bills[0].billId, rowsOf(moved.lines[0])], [true, billId, ['P-North:Projects:Dr:1050.00']],
    'the voucher takes the new year\'s number and keeps its bill and its cost rows');
  assert.deepEqual(await b.figures('2026-01-01', '2026-12-31'), ['General 0.00/0.00: ', 'Projects 0.00/0.00: P-North 0.00+0.00-0.00=0.00']);
  assert.deepEqual(await b.figures('2027-01-01', '2027-12-31'), ['General 0.00/0.00: ', 'Projects 1050.00/1050.00: P-North 0.00+1050.00-1050.00=0.00']);
});

/** The summary's categories each equal the sum of their rows. */
function assertCategoryTotals(summary: any) {
  for (const category of summary.categories) {
    for (const key of ['opening', 'debit', 'credit', 'closing']) {
      const sum = category.centres.reduce((total: bigint, row: any) => total + BigInt(row[key].replace('.', '')), 0n);
      assert.equal(BigInt(category[key].replace('.', '')), sum, `${category.name} ${key}`);
    }
  }
}

test('a parent moved to another category carries its child: counted once, in the parent\'s row and its new category; the break-up of the parent includes the child', async () => {
  const b = await books('Cost Parent Moves');
  await b.enable();
  const sales = await b.ledger('Sales', 'sales'), party = await b.ledger('Party', 'receivables');
  const old = await b.category('Old'), fresh = await b.category('New');
  const parent = await b.centre('Parent', old), child = await b.centre('Child', old, parent);
  await b.voucher('sales', '2026-02-01', [line(party, 'Dr', '100'), line(sales, 'Cr', '100', [[parent, '100']])]);
  await b.voucher('sales', '2026-02-02', [line(party, 'Dr', '40'), line(sales, 'Cr', '40', [[child, '40']])]);
  await b.moveCentre(parent, { categoryId: fresh });
  assert.deepEqual(await b.figures('2026-01-01', '2026-12-31'), ['General 0.00/0.00: ', 'New 0.00/140.00: Parent 0.00+0.00-140.00=-140.00', 'Old 0.00/0.00: ']);
  assertCategoryTotals(await b.summary('2026-01-01', '2026-12-31'));
  const breakup = (await b.ok(`/reports/cost-centre-breakup/${parent}?from=2026-01-01&to=2026-12-31`)).report;
  assert.deepEqual([breakup.rows.map((row: any) => `${row.kind} ${row.name} ${row.credit}`), breakup.totals.credit], [['centre Child 40.00', 'ledger Sales 100.00'], '140.00']);
});

test('the summary folds sub-centres into their top-level centre, carries only balance-sheet rows forward (P5, P6), and leaves out optional, cancelled and deleted vouchers', async () => {
  const b = await books('Cost Reports');
  await b.enable();
  const sales = await b.ledger('Sales', 'sales'), equipment = await b.ledger('Equipment', 'fixed_assets', { costCentres: true }), party = await b.ledger('Party', 'receivables');
  const a = await b.category('Area'), other = await b.category('Other');
  const root = await b.centre('Root', a), kid = await b.centre('Kid', a, root), away = await b.centre('Away', a, root), grand = await b.centre('Grand', a, away);
  const sale = async (date: string, centre: string, amount: string, extra: Record<string, unknown> = {}) =>
    (await b.voucher('sales', date, [line(party, 'Dr', amount), line(sales, 'Cr', amount, [[centre, amount]])], extra)).voucher;
  await sale('2026-01-10', root, '40');
  await b.voucher('journal', '2026-01-11', [line(equipment, 'Dr', '70', [[root, '70']]), line(party, 'Cr', '70')]);
  await sale('2026-02-01', root, '100');
  await sale('2026-02-02', kid, '50');
  await sale('2026-02-03', away, '30');
  await sale('2026-02-04', grand, '20');
  await sale('2026-02-05', root, '9', { postDated: true });
  await sale('2026-03-05', root, '8', { postDated: true });
  await sale('2026-02-06', root, '1000', { status: 'optional' });
  const cancelled = await sale('2026-02-07', root, '2000');
  assert.equal((await b.call(`/vouchers/${cancelled.id}/cancel`, { revision: cancelled.revision })).status, 200);
  const deleted = await sale('2026-02-08', root, '3000');
  assert.equal((await b.call(`/vouchers/${deleted.id}/delete`, { revision: deleted.revision })).status, 200);
  await b.moveCentre(away, { categoryId: other });

  assert.deepEqual(await b.figures('2026-02-01', '2026-02-28'), [
    'Area 0.00/209.00: Root 70.00+0.00-209.00=-139.00',
    'General 0.00/0.00: ',
    'Other 0.00/0.00: ',
  ], 'Root holds Kid, Away (now in Other) and Grand under it; the January sale does not open, the equipment row does');
  assertCategoryTotals(await b.summary('2026-02-01', '2026-02-28'));
  const breakup = (await b.ok(`/reports/cost-centre-breakup/${root}?from=2026-02-01&to=2026-02-28`)).report;
  assert.deepEqual([breakup.centre.categoryName, breakup.rows.map((row: any) => `${row.kind} ${row.name} ${row.opening}+${row.debit}-${row.credit}`), breakup.totals.closing],
    ['Area', ['centre Away 0.00+0.00-50.00', 'centre Kid 0.00+0.00-50.00', 'ledger Equipment 70.00+0.00-0.00', 'ledger Sales 0.00+0.00-109.00'], '-139.00'], 'the break-up totals the summary row');
  const filtered = (await b.ok(`/reports/cost-category-summary?from=2026-02-01&to=2026-02-28&categoryId=${other}`)).report;
  assert.deepEqual(filtered.categories.map((row: any) => [row.name, row.centres.length]), [['Other', 0]]);
  assert.deepEqual([(await b.call('/reports/cost-category-summary?from=2026-03-01&to=2026-02-01')).body.code, (await b.call(`/reports/cost-category-summary?from=2026-02-01&to=2026-02-28&categoryId=${randomUUID()}`)).body.code,
    (await b.call('/reports/cost-category-summary?from=2026-02-01&to=2026-02-28&extra=1')).body.code], ['validation', 'not_found', 'validation']);

  const csv = await raw(`/api/companies/${b.companyId}/reports/cost-category-summary/export?from=2026-02-01&to=2026-02-28`);
  assert.deepEqual([csv.status, csv.headers.get('content-type')], [200, 'text/csv; charset=utf-8']);
  const text = await csv.text();
  assert.match(text, /"Category","Cost centre","Kind","Opening balance","Opening side","Debit","Credit","Closing balance","Closing side"/);
  assert.match(text, /"Area","","category","70\.00","Dr","0\.00","209\.00","139\.00","Cr"\r\n"Area","Root","centre","70\.00","Dr","0\.00","209\.00","139\.00","Cr"/);
  assert.match(await (await raw(`/api/companies/${b.companyId}/reports/cost-centre-breakup/${root}/export?from=2026-02-01&to=2026-02-28`)).text(), /"Total","total","70\.00","Dr","0\.00","209\.00","139\.00","Cr"/);

  // Reconciliation (not a report column): per cost-centre ledger and stored category, allocated plus unallocated line
  // amounts equal the ledger's trial balance movement for the period.
  const trial = (await b.ok('/trial-balance?from=2026-02-01&to=2026-02-28')).trialBalance.rows as any[];
  const { rows } = await asAdmin(database.adminUrl, admin => admin.query(
    `SELECT l.ledger_id, k.id AS category_id,
       coalesce(sum(CASE l.side WHEN 'Dr' THEN l.amount ELSE -l.amount END) FILTER (WHERE NOT EXISTS (SELECT 1 FROM cost_allocation x WHERE x.company_id = l.company_id
         AND x.voucher_id = l.voucher_id AND x.line_no = l.line_no AND x.category_id = k.id)), 0)::bigint AS unallocated,
       coalesce((SELECT sum(CASE x.side WHEN 'Dr' THEN x.amount ELSE -x.amount END) FROM cost_allocation x JOIN voucher y ON y.company_id = x.company_id AND y.id = x.voucher_id
         WHERE x.company_id = l.company_id AND x.ledger_id = l.ledger_id AND x.category_id = k.id AND y.status = 'regular' AND y.deleted_at IS NULL
           AND y.date BETWEEN '2026-02-01' AND '2026-02-28'), 0)::bigint AS allocated
     FROM voucher_line l JOIN voucher v ON v.company_id = l.company_id AND v.id = l.voucher_id JOIN ledger led ON led.company_id = l.company_id AND led.id = l.ledger_id
       CROSS JOIN cost_category k
     WHERE l.company_id = $1 AND k.company_id = $1 AND led.cost_centres AND v.status = 'regular' AND v.deleted_at IS NULL AND v.date BETWEEN '2026-02-01' AND '2026-02-28'
     GROUP BY l.company_id, l.ledger_id, k.id`, [b.companyId]));
  assert.equal(rows.length, 3, 'the sales ledger in each of the three categories (the equipment ledger has no February lines)');
  for (const row of rows) {
    const balance = trial.find(item => item.ledgerId === row.ledger_id);
    const movement = BigInt(Math.round(Number(balance.debit) * 100)) - BigInt(Math.round(Number(balance.credit) * 100));
    assert.equal(BigInt(row.allocated) + BigInt(row.unallocated), movement, `ledger ${balance.name}, category ${row.category_id}`);
  }
});

test('the entry prefill is the category and centre of the ledger\'s most recently entered live row, as the centre stands now (Q7)', async () => {
  const b = await books('Cost Prefill');
  await b.enable();
  const sales = await b.ledger('Sales', 'sales'), rent = await b.ledger('Rent', 'indirect_expenses'), party = await b.ledger('Party', 'receivables');
  const channel = await b.category('Channel'), projects = await b.category('Projects');
  const showroom = await b.centre('Showroom', channel), online = await b.centre('Online', channel);
  const prefill = async (ledgerId: string) => (await b.ok(`/ledgers/${ledgerId}/cost-default`)).costDefault;
  assert.equal(await prefill(sales), null);
  await b.voucher('sales', '2026-05-02', [line(party, 'Dr', '10'), line(sales, 'Cr', '10', [[showroom, '10']])]);
  const later = (await b.voucher('sales', '2026-05-01', [line(party, 'Dr', '10'), line(sales, 'Cr', '10', [[online, '10']])])).voucher;
  assert.deepEqual(await prefill(sales), { categoryId: channel, categoryName: 'Channel', costCentreId: online, costCentreName: 'Online' }, 'entered last, though dated earlier');
  await b.voucher('sales', '2026-05-03', [line(party, 'Dr', '10'), line(sales, 'Cr', '10', [[showroom, '10']])], { status: 'optional' });
  assert.equal((await prefill(sales)).costCentreName, 'Online', 'an optional voucher is skipped');
  assert.equal((await b.call(`/vouchers/${later.id}/cancel`, { revision: later.revision })).status, 200);
  assert.equal((await prefill(sales)).costCentreName, 'Showroom', 'a cancelled voucher is skipped');
  await b.moveCentre(showroom, { categoryId: projects });
  assert.deepEqual([(await prefill(sales)).categoryName, await prefill(rent)], ['Projects', null]);
  assert.equal((await b.call(`/ledgers/${randomUUID()}/cost-default`)).status, 404);
});

test('every cost centre route answers not found for a company the user cannot reach and for another company\'s ids', async () => {
  const mine = await books('Cost Mine'), theirs = await books('Cost Theirs');
  const category = await theirs.category('Theirs'), centre = await theirs.centre('Their Centre', category);
  const ledger = await theirs.ledger('Their Sales', 'sales');
  const outsider = await invite(owner.browser, theirs.companyId, 'viewer');
  const reads = ['/cost-categories', `/cost-categories/${category}`, `/cost-categories/${category}/revisions`, '/cost-centres', `/cost-centres/${centre}`,
    `/cost-centres/${centre}/revisions`, `/ledgers/${ledger}/cost-default`, '/cost-centres-setting', '/reports/cost-category-summary?from=2026-01-01&to=2026-12-31',
    '/reports/cost-category-summary/export?from=2026-01-01&to=2026-12-31', `/reports/cost-centre-breakup/${centre}?from=2026-01-01&to=2026-12-31`,
    `/reports/cost-centre-breakup/${centre}/export?from=2026-01-01&to=2026-12-31`];
  const writes: [string, unknown][] = [['/cost-categories', { name: 'X' }], [`/cost-categories/${category}`, { name: 'X', revision: 1 }], [`/cost-categories/${category}/delete`, { revision: 1 }],
    ['/cost-centres', { name: 'X', categoryId: category, parentId: null }], [`/cost-centres/${centre}`, { name: 'X', categoryId: category, parentId: null, revision: 1 }],
    [`/cost-centres/${centre}/delete`, { revision: 1 }], ['/cost-centres-setting', { enabled: true }]];
  for (const path of reads) {
    const answer = await outsider.browser.call(`/api/companies/${mine.companyId}${path}`);
    assert.deepEqual([answer.status, answer.body.code], [404, 'not_found'], `outsider ${path}`);
  }
  for (const [path, body] of writes) {
    const answer = await outsider.browser.call(`/api/companies/${mine.companyId}${path}`, body);
    assert.deepEqual([answer.status, answer.body.code], [404, 'not_found'], `outsider ${path}`);
  }
  // Their ids inside my company: not found as well, and nothing of theirs changes.
  for (const path of reads.filter(item => item.includes(category) || item.includes(centre) || item.includes(ledger))) {
    if (path.includes('/revisions')) continue; // a history read by id returns an empty list for an id of no row here
    const answer = await mine.call(path);
    assert.deepEqual([answer.status, answer.body.code], [404, 'not_found'], `wrong company ${path}`);
  }
  for (const [path, body] of writes.filter(([item]) => item.includes(category) || item.includes(centre))) {
    const answer = await mine.call(path, body);
    // Creating a centre names their category inside the body: a reference not found (400); the others address the row (404).
    assert.deepEqual([answer.status, answer.body.code], [path === '/cost-centres' ? 400 : 404, 'not_found'], `wrong company ${path}`);
  }
  assert.deepEqual((await mine.call(`/cost-centres/${centre}/revisions`)).body.revisions, []);
  assert.equal((await theirs.ok(`/cost-centres/${centre}`)).costCentre.name, 'Their Centre');
});

/** A raw request as the owner, for answers that are not JSON (CSV exports). */
function raw(path: string): Promise<Response> {
  const cookie = [...owner.browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  return handleApi(new Request(new URL(path, getConfig().appUrl), { headers: { cookie } }));
}
