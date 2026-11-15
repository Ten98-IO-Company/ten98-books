import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { formatMoney } from '@ten98/runtime';
import { baseCurrencies, companyCreateInput } from '../../lib/company.ts';
import { nameMatchKey } from '../../lib/names.ts';
import { FoundationError } from '../auth.ts';
import { createCompany, listCompanies } from '../companies.ts';
import { getDatabase } from '../db.ts';
import { ledgerContext, runLedger, type LedgerContext } from '../ledger/context.ts';
import { createCostCategory, createCostCentre, listCostCategories, listCostCentres, saveCostCentresSetting } from '../ledger/cost-centres.ts';
import { alterLedger, createGroup, createLedger, listGroups, listLedgers, listVoucherTypes } from '../ledger/masters.ts';
import { createItem, createTree, createUnit, listItems, listTree, listUnits, readInventorySetting, saveInventorySetting } from '../ledger/stock-masters.ts';
import { cancelVoucher, createVoucher } from '../ledger/vouchers.ts';
import { withCompany } from '../tenancy.ts';
import { readLedgerBills } from './bill-rows.ts';
import { planBills, type SentBillRow } from './bills.ts';
import { readLedgerCostSetting, readLineCosts } from './cost-rows.ts';
import { checkNumbers, DemoError, demoRoot, describeNumberDifference, dispositionOf, listDatasetFolders, loadDataset, numbersKind, openingStockValue, toMinor, type Dataset, type ItemsFile } from './dataset.ts';

/**
 * The demo seeder. For an existing user it creates each dataset's company through the app's own `createCompany` (the
 * user becomes its owner), then the dataset's groups, ledgers with openings and vouchers through the ledger module in
 * `withCompany` as that user: no SQL writes of its own, so every posting rule, numbering and the revision log apply.
 *
 * Idempotency and the company marker. A company has no slug column, so the seeder recognises its company by two facts:
 * the company is one of the user's, named exactly as company.json names it, and its books carry the dataset's
 * voucher-key namespace: every voucher is posted with the idempotency key `demo:<slug>:<voucher key>`. A same-named
 * company with vouchers outside that namespace, or with ledgers or groups the dataset does not define, is somebody's
 * own books and is never written to. A run that stopped after the company was created but before any voucher posted
 * (no vouchers, nothing foreign in the chart) is resumed. Groups, ledgers and stock masters are matched by name key,
 * vouchers by key.
 */

/** Feature names (company.json `features`) ten98-books models; anything else is listed as skipped. */
export const supportedFeatures: ReadonlySet<string> = new Set(['accounting', 'billWise', 'costCentres']);

export const voucherKeyPrefix = (slug: string) => `demo:${slug}:`;
/** The idempotency key the company is created under: one company per dataset and owner, however it is renamed later. */
export const creationKey = (slug: string, userId: string) => `demo:${slug}:${userId}`;
/**
 * The key of a named masters-only copy (`--as`): the dataset, the owner and a digest of the name, so a rerun with the same
 * name finds the same company, and no name can reach the unnamed company's key (the name travels as a digest because
 * a key allows letters, digits and a few signs only).
 */
export const namedCreationKey = (slug: string, userId: string, name: string) => `${creationKey(slug, userId)}:as:${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;

/** The name of a named copy, checked as company creation checks a name; it may not be the dataset's own name (that company is the unnamed one). */
export function validateCopyName(dataset: Dataset, value: string): string {
  const parsed = companyCreateInput.shape.name.safeParse(value);
  if (!parsed.success) throw new DemoError(`--as: ${parsed.error.issues[0]?.message ?? 'check the company name.'} (1 to 120 characters, no control characters)`);
  if (nameMatchKey(parsed.data) === nameMatchKey(dataset.company.name)) throw new DemoError(`--as: "${parsed.data}" is the name of the dataset's own company; run the seed without --as for that one, or choose another name.`);
  return parsed.data;
}

export type Counts = { created: number; present: number };
export type SeedReport = {
  slug: string; companyId: string; companyName: string; companyCreated: boolean;
  groups: Counts; ledgers: Counts & { openingsSet: number }; vouchers: Counts & { cancelled: number };
  /** Vouchers cancelled without lines (voids) posted in this run; they are counted in `vouchers.created` too. */
  voided: number;
  /** Vouchers not posted because their type is not one ten98-books has, by type (not yet supported). */
  unsupportedTypes: Record<string, number>;
  /** Vouchers of a supported type not posted because they have no lines (cancelled or no accounting effect), by type. */
  noEntries: Record<string, number>;
  /**
   * Vouchers the ledger module's posting rules refuse (for example a payment that credits no cash or bank ledger): not posted and listed with
   * the ledger's reason, because the rules are ten98-books' own and a difference from the reference system. Any other
   * refusal still stops the seed.
   */
  refused: string[];
  /** expectedNumber checks of posted vouchers: how many were compared, how many matched, and optional ones that take no number. */
  numbers: { checked: number; matched: number; unnumbered: number; kind: string };
  /** Voucher numbers ten98-books assigned that differ from the dataset's `expectedNumber` (reported, never forced). */
  numberDifferences: string[];
  /** Standard ledgers the dataset names differently from ten98-books; the seeded name is kept, so the difference is listed. */
  nameDifferences: string[];
  /** Opening balances already on a standard ledger that differ from the dataset (reported, never overwritten). */
  openingDifferences: string[];
  skipped: string[];
  /** True when only the company, groups and ledgers were seeded (`--masters-only`): no vouchers were posted. */
  mastersOnly: boolean;
  /**
   * Bill rows. `openingBills` were set with the ledgers created in this run; `rowsPosted` were sent with vouchers posted in
   * this run; `skipped` are the dataset's rows ten98-books leaves out, each with its reason (every run lists them);
   * `warnings` are the ledger module's own answers to the postings of this run, by code, each naming the voucher; `keptWithoutBills` are vouchers an earlier seed posted without bill rows, kept as they were.
   */
  bills: { openingBills: number; rowsPosted: number; skipped: string[]; warnings: Record<string, string[]>; keptWithoutBills: string[] };
  /**
   * Cost centres. `masters` is true when the dataset has categories or centres; `switchedOn` that this run switched the company feature on.
   * `rowsPosted` were sent with vouchers posted in this run; `leftOutRows` are rows the ledger module dropped because their line's
   * ledger takes no cost centres (`leftOut` names those lines); `warnings` are its answers by code, each naming the voucher and line;
   * `keptWithoutCostRows` are vouchers an earlier seed posted without cost rows, kept as they were.
   */
  costs: { masters: boolean; switchedOn: boolean; categories: Counts; centres: Counts; rowsPosted: number; leftOutRows: number; leftOut: string[]; warnings: Record<string, string[]>; keptWithoutCostRows: string[] };
  /**
   * Stock masters from items.json. `masters` is true when the dataset has the file; `switchedOn` that this run switched
   * inventory on; `openingValue` is the opening stock of the items created in this run, formatted in the company's currency ('' when none).
   */
  stock: { masters: boolean; switchedOn: boolean; units: Counts; locations: Counts; groups: Counts; items: Counts; openingValue: string };
};

type CostCategoryEntry = { key: string; name: string; allocateRevenue?: boolean; allocateNonRevenue?: boolean };
type CostCentreEntry = { key: string; name: string; category: string; parent?: string };
const costCategoryEntries = (dataset: Dataset) => (dataset.extraFiles['costCategories.json'] ?? []) as CostCategoryEntry[];
const costCentreEntries = (dataset: Dataset) => (dataset.extraFiles['costCentres.json'] ?? []) as CostCentreEntry[];

export async function findUserId(email: string): Promise<string> {
  const { rows } = await getDatabase().pool.query<{ id: string }>('SELECT id FROM "user" WHERE lower(email) = lower($1)', [email.trim()]);
  if (!rows[0]) throw new DemoError('No user has that email address. Create the account in the app first (the first account is made by the setup screen).');
  return rows[0].id;
}

/** One line of a plain-language failure that names the dataset file and key and keeps the ledger's own message. */
function failure(dataset: Dataset, file: string, what: string, error: unknown): never {
  if (error instanceof FoundationError) throw new DemoError(`demo/${dataset.slug}/${file}.json: ${what}: ${error.message}`);
  throw error;
}

/** Whether `companyId` holds this dataset's books (see the marker rule above), read as `userId`. */
async function holdsDataset(userId: string, companyId: string, dataset: Dataset): Promise<boolean> {
  return withCompany(userId, companyId, 'read', async (client, access) => {
    const context = await ledgerContext(client, access.companyId, userId, 'read');
    const { rows: [vouchers] } = await client.query<{ marked: boolean; any: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM voucher WHERE company_id = $1 AND starts_with(idempotency_key, $2)) AS marked,
              EXISTS (SELECT 1 FROM voucher WHERE company_id = $1) AS any`, [companyId, voucherKeyPrefix(dataset.slug)]);
    if (vouchers.marked) return true;
    if (vouchers.any) return false;
    const groupNames = new Set(dataset.groups.map(group => nameMatchKey(group.name)));
    const ledgerNames = new Set(dataset.ledgers.map(ledger => nameMatchKey(ledger.name)));
    return (await listGroups(context)).every(group => group.systemKey !== null || groupNames.has(nameMatchKey(group.name)))
      && (await listLedgers(context)).every(ledger => ledger.systemKey !== null || ledgerNames.has(nameMatchKey(ledger.name)));
  });
}

export type DemoCompany = { id: string; name: string; role: string };

/**
 * The user's company that holds `dataset`, or null when there is none. The company created under this dataset's key
 * (see `creationKey`) is found first, so a renamed company is still found by both commands; otherwise the name and the
 * voucher-key marker decide. Seeding considers only companies the user owns,
 * so membership of somebody else's copy neither blocks nor redirects it; reading considers every company the user can
 * open and prefers the one they own. A same-named company that is not this dataset's, or two that are, stops the
 * command rather than guess. A named masters-only copy (`copyName`) is found by its own key only: it never matches by name,
 * and the name search above never returns it, because a copy may not carry the dataset's own name.
 */
export async function findDemoCompany(userId: string, dataset: Dataset, purpose: 'seed' | 'read', copyName?: string): Promise<DemoCompany | null> {
  // company_creation holds creation keys only (no company data, outside row-level security): a read-only lookup.
  const { rows: [created] } = await getDatabase().pool.query<{ company_id: string }>(
    'SELECT company_id FROM company_creation WHERE user_id = $1 AND idempotency_key = $2',
    [userId, copyName === undefined ? creationKey(dataset.slug, userId) : namedCreationKey(dataset.slug, userId, copyName)]);
  if (created) {
    const keyed = (await listCompanies(userId)).find(company => company.id === created.company_id && company.company !== null && !company.twoFactorLocked);
    if (keyed) {
      if (purpose === 'seed' && keyed.role !== 'owner') throw new DemoError(`The company created for "${dataset.slug}" is no longer owned by this user (they are its ${keyed.role}); the seeder writes only to companies it owns.`);
      return { id: keyed.id, name: keyed.name, role: keyed.role };
    }
  }
  if (copyName !== undefined) return null;
  const named = (await listCompanies(userId)).filter(company => company.company !== null && !company.twoFactorLocked && company.name === dataset.company.name
    && (purpose === 'read' || company.role === 'owner'));
  let ours: typeof named = [];
  for (const company of named) if (await holdsDataset(userId, company.id, dataset)) ours.push(company);
  const owned = ours.filter(company => company.role === 'owner');
  if (ours.length > 1 && owned.length === 1) ours = owned;
  const label = `"${dataset.company.name}" (${dataset.slug})`;
  if (ours.length > 1) throw new DemoError(`More than one of this user's companies holds the demo data for ${label}. Rename or remove the extra ones first.`);
  if (!ours.length) {
    if (named.length) throw new DemoError(`A company named ${label} exists that does not hold this demo data (it has other vouchers, ledgers or groups). Rename it, or use another owner.`);
    return null;
  }
  return { id: ours[0].id, name: ours[0].name, role: ours[0].role };
}

/** Everything in the dataset that ten98-books does not model, one aggregated line per file and kind of content. */
export function unmodelled(dataset: Dataset): string[] {
  const lines: string[] = [];
  // The keys the seeder reads (bills, see bill-rows.ts) are not "extras ten98-books ignores".
  const read = new Set(['billWise', 'creditDays', 'creditPeriodDays', 'openingBills', 'opening', 'bills', 'costCentres']);
  const keysOf = (entry: { extras?: Record<string, unknown> }, file: string) => Object.keys(entry.extras ?? {}).filter(key => !((file === 'ledgers.json' || file === 'vouchers.json') && read.has(key)));
  const fields = (entries: { extras?: Record<string, unknown> }[], file: string) => [...new Set(entries.flatMap(entry => keysOf(entry, file)))].sort();
  for (const feature of dataset.company.features) if (!supportedFeatures.has(feature)) lines.push(`company.json: feature "${feature}" is not modelled`);
  const note = (file: string, entries: { extras?: Record<string, unknown> }[], what: string) => {
    const withExtras = entries.filter(entry => keysOf(entry, file).length);
    if (withExtras.length) lines.push(`${file}: extras on ${withExtras.length} ${what} (${fields(withExtras, file).join(', ')})`);
  };
  note('company.json', [dataset.company], 'company');
  note('groups.json', dataset.groups, 'group(s)');
  note('ledgers.json', dataset.ledgers, 'ledger(s)');
  note('vouchers.json', dataset.vouchers, 'voucher(s)');
  note('vouchers.json', dataset.vouchers.flatMap(voucher => voucher.lines), 'voucher line(s)');
  const inventory = dataset.vouchers.filter(voucher => voucher.inventory?.length);
  if (inventory.length) lines.push(`vouchers.json: inventory on ${inventory.length} voucher(s), ${inventory.reduce((sum, voucher) => sum + voucher.inventory!.length, 0)} item line(s) (stock is not modelled)`);
  // The features the line extras carry, counted: none of them is modelled, and the amounts are posted without them.
  const lineExtras = dataset.vouchers.flatMap(voucher => voucher.lines.map(line => line.extras as Record<string, unknown> | undefined)).filter(extra => extra !== undefined);
  const withKey = (key: string) => lineExtras.filter(extra => Array.isArray(extra[key]) ? (extra[key] as unknown[]).length > 0 : extra[key] !== undefined);
  const foreign = lineExtras.filter(extra => typeof extra.currency === 'string');
  if (foreign.length) {
    const byCurrency = foreign.reduce((counts, extra) => counts.set(extra.currency as string, (counts.get(extra.currency as string) ?? 0) + 1), new Map<string, number>());
    lines.push(`vouchers.json: foreign-currency amounts on ${foreign.length} voucher line(s) (${[...byCurrency].map(([code, count]) => `${code} ${count}`).join(', ')}): posted at their base-currency amounts; currency, currencyAmount and rate are kept, not modelled`);
  }
  if (withKey('bank').length) lines.push(`vouchers.json: bank details (instrument and bank date) on ${withKey('bank').length} voucher line(s) (not modelled)`);
  for (const [file, content] of Object.entries(dataset.extraFiles)) {
    if (file === 'costCategories.json' || file === 'costCentres.json') continue;
    if (file === 'currencies.json') {
      const list = content as { code: string; rates?: unknown[] }[];
      lines.push(`currencies.json: foreign currencies not yet supported (${list.map(currency => currency.code).join(', ')}; ${list.reduce((sum, currency) => sum + (currency.rates?.length ?? 0), 0)} rate(s))`);
      continue;
    }
    if (file === 'checkpoints.json') { lines.push('checkpoints.json: scenario checkpoint figures: pending bills are compared with the bill reports and the cost centre figures with the cost category summary'); continue; }
    if (file !== 'items.json') { lines.push(`${file}: feature file not modelled (kept as is)`); continue; }
    const items = content as ItemsFile;
    const value = formatMoney(openingStockValue(items, dataset.company.minorUnits), dataset.company.minorUnits);
    lines.push(`items.json: stock is not valued yet (${items.items?.length ?? 0} item(s), ${items.locations?.length ?? 0} location(s)): the statements hold the opening stock of ${value} in every period`);
    const withExtras = (items.items ?? []).filter(item => item.extras && typeof item.extras === 'object' && Object.keys(item.extras).length);
    if (withExtras.length) lines.push(`items.json: extras on ${withExtras.length} item(s) (${[...new Set(withExtras.flatMap(item => Object.keys(item.extras as object)))].sort().join(', ')})`);
  }
  return lines;
}

/** Creates the groups and ledgers the company lacks, in one transaction; matches by name so a rerun changes nothing. */
async function seedMasters(userId: string, companyId: string, dataset: Dataset, report: SeedReport): Promise<void> {
  await runLedger(userId, companyId, 'write', async context => {
    const ids = new Map<string, string>();
    const existingGroups = await listGroups(context);
    for (const group of existingGroups) if (group.systemKey) ids.set(group.systemKey, group.id);
    const groupByName = new Map(existingGroups.map(group => [nameMatchKey(group.name), group]));
    const entries = new Map(dataset.groups.map(group => [group.key, group]));
    const place = async (key: string): Promise<string> => {
      const known = ids.get(key);
      if (known) return known;
      const entry = entries.get(key)!;
      const present = groupByName.get(nameMatchKey(entry.name));
      if (present) { ids.set(key, present.id); report.groups.present++; return present.id; }
      const parentId = await place(entry.under);
      try {
        const created = await createGroup(context, { name: entry.name, parentId, ...entry.nature ? { nature: entry.nature } : {} });
        ids.set(key, created.id);
      } catch (error) { failure(dataset, 'groups', `group "${key}"`, error); }
      report.groups.created++;
      return ids.get(key)!;
    };
    for (const group of dataset.groups) await place(group.key);

    const existingLedgers = await listLedgers(context);
    const ledgerByName = new Map(existingLedgers.map(ledger => [nameMatchKey(ledger.name), ledger]));
    for (const entry of dataset.ledgers) {
      const at = `ledger "${entry.key}"`;
      try {
        if (entry.standard) {
          const standard = existingLedgers.find(ledger => ledger.systemKey === entry.standard);
          if (!standard) throw new FoundationError(404, `the company has no ${entry.standard} ledger`);
          if (entry.group && (await place(entry.group)) !== standard.groupId) {
            throw new FoundationError(409, `group "${entry.group}" is not the group the ${entry.standard} ledger is in (${standard.groupName ?? 'none'}); a standard ledger keeps its place`);
          }
          if (standard.name !== entry.name) report.nameDifferences.push(`${at}: the dataset calls it "${entry.name}", ten98-books calls it "${standard.name}" (kept; compare by key, not by name, on the other side)`);
          report.ledgers.present++;
          if (!entry.opening) continue;
          const wanted = toMinor(entry.opening.amount, context.company.exponent);
          if (standard.opening.amount === wanted && (wanted === 0n || standard.opening.side === entry.opening.side)) continue;
          if (standard.opening.amount !== 0n) {
            report.openingDifferences.push(`${at}: the ${entry.standard} ledger already has a different opening balance; left as it is`);
            continue;
          }
          await alterLedger(context, standard.id, {
            name: standard.name, secondLanguageName: standard.secondLanguageName, groupId: standard.groupId, opening: entry.opening, revision: standard.revision,
          });
          report.ledgers.openingsSet++;
          continue;
        }
        const present = ledgerByName.get(nameMatchKey(entry.name));
        if (present) { report.ledgers.present++; continue; }
        // The dataset's bill settings (see bill-rows.ts): bill-wise flag, default credit days and opening bills.
        const { billWise, creditDays, openingBills } = readLedgerBills(entry.extras).found;
        const costCentres = readLedgerCostSetting(entry.extras);
        await createLedger(context, {
          name: entry.name, groupId: await place(entry.group!),
          ...entry.secondLanguageName ? { secondLanguageName: entry.secondLanguageName } : {},
          ...entry.opening ? { opening: { ...entry.opening, ...openingBills.length ? { bills: openingBills.map(bill => ({
            name: bill.name, ...bill.billDate !== undefined ? { billDate: bill.billDate } : {}, ...bill.creditDays !== undefined ? { creditPeriod: { count: bill.creditDays, unit: 'day' as const } } : {}, amount: bill.amount,
          })) } : {} } } : {},
          ...costCentres !== undefined ? { costCentres } : {}, ...billWise !== undefined ? { billWise } : {}, ...creditDays !== undefined ? { creditPeriod: { count: creditDays, unit: 'day' as const } } : {},
        });
        report.ledgers.created++;
        report.bills.openingBills += openingBills.length;
        if (entry.opening) report.ledgers.openingsSet++;
      } catch (error) { failure(dataset, 'ledgers', at, error); }
    }
    await seedCostMasters(context, dataset, report);
    await seedStockMasters(context, dataset, report);
  }).catch(error => { throw error instanceof DemoError ? error : failure(dataset, 'ledgers', 'masters', error); });
}

/**
 * Switches inventory on and creates the units, locations, stock groups and items (with their opening stock) of
 * items.json that the company lacks, matching each kind by name key, so a rerun changes nothing and a master spelled
 * differently is found. Existing masters, and the openings of existing items, are kept as they are. An item names its
 * unit by key or by name; locations and stock groups are created at the top level.
 */
async function seedStockMasters(context: LedgerContext, dataset: Dataset, report: SeedReport): Promise<void> {
  const items = dataset.extraFiles['items.json'] as ItemsFile | undefined;
  if (!items) return;
  const stock = report.stock;
  let value = 0n;
  try {
    if (!(await readInventorySetting(context)).enabled) { await saveInventorySetting(context, { enabled: true }); stock.switchedOn = true; }
    const units = new Map((await listUnits(context)).map(unit => [nameMatchKey(unit.symbol), unit.id]));
    const unitIds = new Map<string, string>();
    for (const entry of items.units ?? []) {
      let id = units.get(nameMatchKey(entry.name));
      if (id) stock.units.present++;
      else { id = (await createUnit(context, { symbol: entry.name, ...entry.decimals !== undefined ? { decimals: entry.decimals } : {} })).id; units.set(nameMatchKey(entry.name), id); stock.units.created++; }
      unitIds.set(entry.key, id).set(entry.name, id);
    }
    const placed = async (kind: 'stock-locations' | 'stock-groups', entries: { key: string; name: string }[], counts: Counts) => {
      const present = new Map((await listTree(context, kind)).map(row => [nameMatchKey(String(row.name)), row.id]));
      const ids = new Map<string, string>();
      for (const entry of entries) {
        let id = present.get(nameMatchKey(entry.name));
        if (id) counts.present++;
        else { id = (await createTree(context, kind, { name: entry.name })).id; present.set(nameMatchKey(entry.name), id); counts.created++; }
        ids.set(entry.key, id);
      }
      return ids;
    };
    const locationIds = await placed('stock-locations', items.locations ?? [], stock.locations);
    const groupIds = await placed('stock-groups', items.stockGroups ?? [], stock.groups);
    const existing = new Set((await listItems(context)).map(item => nameMatchKey(item.name)));
    for (const entry of items.items ?? []) {
      if (existing.has(nameMatchKey(entry.name))) { stock.items.present++; continue; }
      if (entry.unit === undefined) throw new FoundationError(400, `item "${entry.key}" names no unit`);
      let unitId = unitIds.get(entry.unit);
      if (!unitId) { unitId = (await createUnit(context, { symbol: entry.unit })).id; unitIds.set(entry.unit, unitId); stock.units.created++; }
      const created = await createItem(context, {
        name: entry.name, unitId, groupId: entry.group === undefined ? null : groupIds.get(entry.group),
        openings: (entry.opening ?? []).map(line => ({ locationId: locationIds.get(line.location), quantity: line.quantity, rate: line.rate })),
      });
      existing.add(nameMatchKey(entry.name));
      stock.items.created++;
      value += created.openingValue;
    }
    if (stock.items.created) stock.openingValue = formatMoney(value, context.company.exponent);
  } catch (error) {
    if (error instanceof FoundationError) throw new DemoError(`demo/${dataset.slug}/items.json: stock: ${error.message}`);
    throw error;
  }
}

/**
 * Switches the company's cost centres on, creates the categories and then the centres (parents first) the company lacks and
 * matches by name key, so a rerun changes nothing and a master the user spelled differently is found. Existing categories and centres are kept as they are.
 */
async function seedCostMasters(context: LedgerContext, dataset: Dataset, report: SeedReport): Promise<void> {
  if (!report.costs.masters) return;
  try {
    if (!context.company.costCentresEnabled) { await saveCostCentresSetting(context, { enabled: true }); report.costs.switchedOn = true; }
    const categoryIds = new Map<string, string>();
    const existingCategories = new Map((await listCostCategories(context)).map(category => [nameMatchKey(category.name), category.id]));
    for (const entry of costCategoryEntries(dataset)) {
      const present = existingCategories.get(nameMatchKey(entry.name));
      if (present) { categoryIds.set(entry.key, present); report.costs.categories.present++; continue; }
      const created = await createCostCategory(context, { name: entry.name, ...entry.allocateRevenue !== undefined ? { allocateRevenue: entry.allocateRevenue } : {}, ...entry.allocateNonRevenue !== undefined ? { allocateNonRevenue: entry.allocateNonRevenue } : {} });
      categoryIds.set(entry.key, created.id);
      report.costs.categories.created++;
    }
    const centreIds = new Map<string, string>();
    const existingCentres = new Map((await listCostCentres(context)).map(centre => [nameMatchKey(centre.name), centre.id]));
    const entries = new Map(costCentreEntries(dataset).map(entry => [entry.key, entry]));
    const place = async (key: string): Promise<string> => {
      const known = centreIds.get(key);
      if (known) return known;
      const entry = entries.get(key)!;
      const present = existingCentres.get(nameMatchKey(entry.name));
      if (present) { centreIds.set(key, present); report.costs.centres.present++; return present; }
      const parentId = entry.parent === undefined ? null : await place(entry.parent);
      const created = await createCostCentre(context, { name: entry.name, categoryId: categoryIds.get(entry.category), parentId });
      centreIds.set(key, created.id);
      report.costs.centres.created++;
      return created.id;
    };
    for (const entry of costCentreEntries(dataset)) await place(entry.key);
  } catch (error) {
    if (error instanceof FoundationError) throw new DemoError(`demo/${dataset.slug}/costCentres.json: cost centres: ${error.message}`);
    throw error;
  }
}

/** The rows left out, grouped by reason, one line each (the voucher keys of the first few named). */
export function describeSkippedBills(skipped: ReturnType<typeof planBills>['skipped']): string[] {
  const lines: string[] = [];
  const reasons = {
    foreign: 'bill rows on foreign-currency lines (bills are base currency only until currencies are built)',
    unknown: 'against rows settling a bill that no posted row creates (it belongs to a foreign-currency line, or to a voucher the dataset carries without lines, whose rows it does not hold)',
  };
  for (const reason of ['foreign', 'unknown'] as const) {
    const those = skipped.filter(row => row.reason === reason);
    if (!those.length) continue;
    const examples = [...new Set(those.map(row => `${row.voucher}${row.name ? ` (${row.name})` : ''}`))].slice(0, 4).join(', ');
    lines.push(`${those.length} ${reasons[reason]}; e.g. ${examples}`);
  }
  return lines;
}

/** A line as posted: the bill rows and cost rows are what a company seeded earlier may lack (see `seedVouchers`). */
type PostedLine = { ledgerId: string; side: 'Dr' | 'Cr'; amount: string; bills?: SentBillRow[]; costAllocations?: { costCentreId: string; amount: string }[] };
/** The shapes one voucher is tried in: complete, without its cost rows (bill rows kept), and without either. */
type Shape = 'full' | 'withoutCost' | 'plain';

/**
 * Posts the vouchers in entry order, each in its own transaction under its idempotency key; stops at the first error.
 * A voucher cancelled without lines is posted as a void, so it takes its number as it did in the dataset's books.
 */
async function seedVouchers(userId: string, companyId: string, dataset: Dataset, report: SeedReport): Promise<void> {
  const { ledgerByKey, typeIds, centreIds } = await runLedger(userId, companyId, 'read', async context => {
    const ledgers = await listLedgers(context);
    const ledgerByKey: Record<string, string> = {};
    for (const entry of dataset.ledgers) {
      const found = ledgers.find(ledger => entry.standard ? ledger.systemKey === entry.standard : nameMatchKey(ledger.name) === nameMatchKey(entry.name));
      if (found) ledgerByKey[entry.key] = found.id;
    }
    const centres = new Map((await listCostCentres(context)).map(centre => [nameMatchKey(centre.name), centre.id]));
    const centreIds = Object.fromEntries(costCentreEntries(dataset).flatMap(entry => centres.has(nameMatchKey(entry.name)) ? [[entry.key, centres.get(nameMatchKey(entry.name))!]] : []));
    return { ledgerByKey, typeIds: Object.fromEntries((await listVoucherTypes(context)).map(type => [type.systemKey ?? '', type.id])), centreIds };
  });
  const bump = (counts: Record<string, number>, type: string) => { counts[type] = (counts[type] ?? 0) + 1; };
  const bills = planBills(dataset);
  report.bills.skipped = describeSkippedBills(bills.skipped);
  const ledgerName = (key: string) => dataset.ledgers.find(entry => entry.key === key)?.name ?? key;
  const assigned = new Map<string, number | null>();
  const refused = new Set<string>();
  for (const voucher of dataset.vouchers) {
    const at = `voucher "${voucher.key}"`;
    const disposition = dispositionOf(voucher);
    if (disposition !== 'post' && disposition !== 'void') {
      bump(disposition === 'unsupported-type' ? report.unsupportedTypes : report.noEntries, voucher.type);
      continue;
    }
    try {
      const lines: PostedLine[] = voucher.lines.map((line, index) => {
        const rows = bills.lines.get(voucher.key)?.[index];
        const costs = readLineCosts(line.extras);
        return {
          ledgerId: ledgerByKey[line.ledger], side: line.side, amount: line.amount, ...rows ? { bills: rows } : {},
          ...costs.length ? { costAllocations: costs.map(row => ({ costCentreId: centreIds[row.centre], amount: row.amount })) } : {},
        };
      });
      const hasBills = lines.some(line => line.bills), hasCosts = lines.some(line => line.costAllocations);
      const shapes: Shape[] = ['full', ...hasBills && hasCosts ? ['withoutCost' as const] : [], ...hasBills || hasCosts ? ['plain' as const] : []];
      const payload = (shape: Shape) => ({
        idempotencyKey: voucherKeyPrefix(dataset.slug) + voucher.key, voucherTypeId: typeIds[voucher.type], date: voucher.date,
        narration: voucher.narration ?? null, status: disposition === 'void' ? 'cancelled' : voucher.status === 'optional' ? 'optional' : 'regular', postDated: voucher.postDated,
        lines: lines.map((line): PostedLine => shape === 'full' ? line : { ledgerId: line.ledgerId, side: line.side, amount: line.amount, ...shape === 'withoutCost' && line.bills ? { bills: line.bills } : {} }),
      });
      const send = (body: ReturnType<typeof payload>, shape: Shape) => runLedger(userId, companyId, 'write', async context => {
        let { voucher: posted, replayed, warnings } = await createVoucher(context, body);
        // A shape other than the complete voucher may only replay a stored voucher: refused here, inside the transaction, so it rolls back and can never post a new one.
        if (shape !== 'full' && !replayed) throw new FoundationError(409, 'This request key was already used for a different voucher.', 'idempotency_mismatch');
        if (!replayed) {
          report.bills.rowsPosted += body.lines.reduce((sum, line) => sum + (line.bills?.length ?? 0), 0);
          let sentCostRows = body.lines.reduce((sum, line) => sum + (line.costAllocations?.length ?? 0), 0);
          for (const warning of warnings) {
            const code: string = warning.code;
            if (code.startsWith('cost_')) {
              (report.costs.warnings[code] ??= []).push(`${voucher.key}${warning.line ? ` line ${warning.line}` : ''}`);
              // The ledger module drops the rows of a line whose ledger takes no cost centres; the dataset's rows on it are counted, not lost silently.
              const left = warning.line ? voucher.lines[warning.line - 1] : undefined;
              if (code === 'cost_ignored' && left) { sentCostRows -= readLineCosts(left.extras).length; report.costs.leftOutRows += readLineCosts(left.extras).length; report.costs.leftOut.push(`${voucher.key} line ${warning.line} (${ledgerName(left.ledger)})`); }
            } else (report.bills.warnings[code] ??= []).push(`${voucher.key}${warning.line ? ` line ${warning.line}` : ''}${warning.billName ? ` bill "${warning.billName}"` : ''}`);
          }
          report.costs.rowsPosted += sentCostRows;
        }
        let cancelled = false;
        if (disposition === 'post' && voucher.status === 'cancelled' && posted.status === 'regular') {
          posted = (await cancelVoucher(context, posted.id, { revision: posted.revision })).voucher;
          cancelled = true;
        }
        return { number: posted.number, replayed, cancelled };
      });
      // A company seeded before bill rows or cost rows were sent holds this voucher without them, so the request of the
      // complete voucher no longer matches what was stored. The key proves it is this dataset's voucher, so it is replayed
      // in the shape it was posted (see `Shape`) and listed in the summary; any other difference under the same key (a
      // changed amount, date or line) still stops the seed.
      let done: Awaited<ReturnType<typeof send>> | undefined;
      let first: unknown;
      let used: Shape = 'full';
      for (const shape of shapes) {
        try { done = await send(payload(shape), shape); used = shape; break; }
        catch (error) {
          if (shape === 'full') first = error;
          if (!(error instanceof FoundationError && error.code === 'idempotency_mismatch') || shape === shapes[shapes.length - 1]) throw shape === 'full' ? error : first;
        }
      }
      if (!done) throw first;
      if (used !== 'full') {
        if (used === 'plain' && hasBills) report.bills.keptWithoutBills.push(voucher.key);
        if (hasCosts) report.costs.keptWithoutCostRows.push(voucher.key);
      }
      if (done.replayed && !done.cancelled) report.vouchers.present++; else report.vouchers.created++;
      if (done.cancelled) report.vouchers.cancelled++;
      if (disposition === 'void' && !done.replayed) report.voided++;
      assigned.set(voucher.key, done.number);
    } catch (error) {
      if (error instanceof FoundationError && error.code === 'posting_rule') {
        report.refused.push(`${at} (${voucher.type}, ${voucher.date}, ${voucher.status}): ${error.message}`);
        refused.add(voucher.key);
        continue;
      }
      failure(dataset, 'vouchers', at, error);
    }
  }
  const check = checkNumbers(dataset, assigned, refused);
  Object.assign(report.numbers, { checked: check.checked, matched: check.matched, unnumbered: check.unnumbered });
  report.numberDifferences = check.differences.map(describeNumberDifference);
}

/**
 * Seeds one dataset for `userId`; safe to run again, and safe to run twice at once: a session-level advisory lock keyed on
 * the user and the dataset slug, held on one connection for the whole run, makes the second run wait and then find the
 * first run's company instead of creating another. The lock is released on every exit path (a dropped connection
 * releases it too). It is polled rather than awaited, because the pool's statement timeout would cut a long wait.
 */
export async function seedDataset(userId: string, dataset: Dataset, mastersOnly = false, copyName?: string): Promise<SeedReport> {
  if (copyName !== undefined) {
    if (!mastersOnly) throw new DemoError('--as makes a second copy of the masters only: add --masters-only (the full seed always uses the dataset\'s own company).');
    copyName = validateCopyName(dataset, copyName);
  }
  const client = await getDatabase().pool.connect();
  const lockKey = `demo-seed:${userId}:${dataset.slug}${copyName === undefined ? '' : `:as:${copyName}`}`;
  let broken = false;
  try {
    while (!(await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [lockKey])).rows[0].locked) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    try { return await seedUnderLock(userId, dataset, mastersOnly, copyName); }
    finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => { broken = true; }); }
  } catch (error) {
    broken = broken || (error as { code?: string })?.code?.startsWith('08') === true;
    throw error;
  } finally { client.release(broken); }
}

async function seedUnderLock(userId: string, dataset: Dataset, mastersOnly: boolean, copyName?: string): Promise<SeedReport> {
  const settings = dataset.company;
  const currency = baseCurrencies[settings.baseCurrency as keyof typeof baseCurrencies];
  if (!currency) throw new DemoError(`demo/${dataset.slug}/company.json: baseCurrency "${settings.baseCurrency}" is not supported by ten98-books (${Object.keys(baseCurrencies).join(', ')})`);
  if (currency.minorUnits !== settings.minorUnits) throw new DemoError(`demo/${dataset.slug}/company.json: minorUnits ${settings.minorUnits} does not match ${settings.baseCurrency}, which has ${currency.minorUnits}`);

  let company = await findDemoCompany(userId, dataset, 'seed', copyName);
  const report: SeedReport = {
    slug: dataset.slug, companyId: '', companyName: copyName ?? settings.name, companyCreated: false,
    groups: { created: 0, present: 0 }, ledgers: { created: 0, present: 0, openingsSet: 0 }, vouchers: { created: 0, present: 0, cancelled: 0 }, voided: 0,
    unsupportedTypes: {}, noEntries: {}, refused: [], numbers: { checked: 0, matched: 0, unnumbered: 0, kind: numbersKind(dataset) },
    numberDifferences: [], nameDifferences: [], openingDifferences: [], skipped: unmodelled(dataset),
    mastersOnly, bills: { openingBills: 0, rowsPosted: 0, skipped: [], warnings: {}, keptWithoutBills: [] },
    costs: { masters: costCategoryEntries(dataset).length + costCentreEntries(dataset).length > 0, switchedOn: false, categories: { created: 0, present: 0 }, centres: { created: 0, present: 0 }, rowsPosted: 0, leftOutRows: 0, leftOut: [], warnings: {}, keptWithoutCostRows: [] },
    stock: { masters: dataset.extraFiles['items.json'] !== undefined, switchedOn: false, units: { created: 0, present: 0 }, locations: { created: 0, present: 0 }, groups: { created: 0, present: 0 }, items: { created: 0, present: 0 }, openingValue: '' },
  };
  if (!company) {
    try {
      // The key (dataset slug and owner) makes a repeated create return the first company, beside the marker search and the lock.
      const { company: created, replayed } = await createCompany(userId, {
        idempotencyKey: copyName === undefined ? creationKey(dataset.slug, userId) : namedCreationKey(dataset.slug, userId, copyName),
        name: copyName ?? settings.name, baseCurrency: settings.baseCurrency, financialYearStart: settings.financialYearStart, booksBeginning: settings.booksBeginning,
        timeZone: settings.timeZone, ...settings.secondLanguageName ? { secondLanguageName: settings.secondLanguageName } : {},
      });
      company = { id: created.id, name: created.name, role: 'owner' };
      report.companyCreated = !replayed;
    } catch (error) { failure(dataset, 'company', 'company', error); }
  }
  report.companyId = company!.id;
  await seedMasters(userId, company!.id, dataset, report);
  if (!mastersOnly) await seedVouchers(userId, company!.id, dataset, report);
  return report;
}

export type DemoSelection = { email: string; company?: string; all?: boolean };

/** The datasets a command names: one by slug, or every folder under demo/. */
export async function selectDatasets(selection: DemoSelection, root = demoRoot): Promise<Dataset[]> {
  if (selection.company && selection.all) throw new DemoError('Use either --company <slug> or --all, not both.');
  const folders = await listDatasetFolders(root);
  if (selection.company && !folders.includes(selection.company)) throw new DemoError(`There is no dataset folder demo/${selection.company}.`);
  const slugs = selection.company ? [selection.company] : folders;
  if (!slugs.length) throw new DemoError('There are no dataset folders under demo/.');
  return Promise.all(slugs.map(slug => loadDataset(join(root, slug))));
}

export function formatSeedReport(report: SeedReport): string[] {
  const stock = report.stock;
  const changed = report.companyCreated || report.groups.created || report.ledgers.created || report.ledgers.openingsSet || report.vouchers.created || report.costs.switchedOn || report.costs.categories.created || report.costs.centres.created
    || stock.switchedOn || stock.units.created || stock.locations.created || stock.groups.created || stock.items.created;
  const part = (counts: Counts) => `${counts.created} created, ${counts.present} already present`;
  const lines = [
    `${report.companyName} (${report.slug}): ${changed ? 'seeded' : 'already present, nothing changed'}`,
    `  company: ${report.companyCreated ? 'created' : 'already present'}`,
    `  groups: ${part(report.groups)}`,
    `  ledgers: ${part(report.ledgers)}${report.ledgers.openingsSet ? `; ${report.ledgers.openingsSet} opening balance(s) set` : ''}`,
    report.mastersOnly ? '  vouchers: not posted (masters only)' : `  vouchers: ${part(report.vouchers)}${report.vouchers.cancelled ? `; ${report.vouchers.cancelled} cancelled` : ''}${report.voided ? `; ${report.voided} cancelled without lines (voids)` : ''}`,
  ];
  const costs = report.costs;
  if (costs.masters) lines.push(`  cost centres: ${costs.switchedOn ? 'switched on; ' : ''}categories ${part(costs.categories)}; centres ${part(costs.centres)}`);
  if (stock.masters) lines.push(`  stock: ${stock.switchedOn ? 'inventory switched on; ' : ''}units ${part(stock.units)}; locations ${part(stock.locations)}; stock groups ${part(stock.groups)}; items ${part(stock.items)}${stock.items.created ? `; opening stock ${stock.openingValue} set with the items created` : ''}`);
  if (costs.rowsPosted) lines.push(`  cost rows: ${costs.rowsPosted} posted with the vouchers`);
  if (costs.leftOutRows) lines.push(`  cost rows left out: ${costs.leftOutRows} on ${costs.leftOut.length} line(s) whose ledger takes no cost centres (the ledger module dropped them, cost_ignored); e.g. ${costs.leftOut.slice(0, 4).join(', ')}`);
  if (costs.keptWithoutCostRows.length) lines.push(`  vouchers already posted before cost rows were sent, kept as they were without cost rows: ${costs.keptWithoutCostRows.length} (e.g. ${costs.keptWithoutCostRows.slice(0, 3).join(', ')}); seed into a new company to get their cost figures`);
  const costWarnings = Object.entries(costs.warnings);
  if (costWarnings.length) lines.push('  cost warnings raised by the postings:', ...costWarnings.map(([code, which]) => `    ${code}: ${which.length} (e.g. ${which.slice(0, 3).join('; ')})`));
  if (report.bills.openingBills) lines.push(`  opening bills: ${report.bills.openingBills} set with the ledgers created`);
  const typeCounts = (counts: Record<string, number>) => Object.entries(counts).map(([type, count]) => `${count} ${type.replace(/_/g, ' ')}`).join(', ');
  if (report.bills.rowsPosted) lines.push(`  bill rows: ${report.bills.rowsPosted} posted with the vouchers`);
  if (report.bills.keptWithoutBills.length) lines.push(`  vouchers already posted before bill rows were sent, kept as they were without bill rows: ${report.bills.keptWithoutBills.length} (e.g. ${report.bills.keptWithoutBills.slice(0, 3).join(', ')}); seed into a new company to get their bills`);
  if (report.bills.skipped.length) lines.push('  bill rows left out:', ...report.bills.skipped.map(line => `    ${line}`));
  const warningCodes = Object.entries(report.bills.warnings);
  if (warningCodes.length) lines.push('  bill warnings raised by the postings:', ...warningCodes.map(([code, which]) => `    ${code}: ${which.length} (e.g. ${which.slice(0, 3).join('; ')})`));
  if (Object.keys(report.unsupportedTypes).length) lines.push(`  vouchers not posted, type not yet supported: ${typeCounts(report.unsupportedTypes)}`);
  if (Object.keys(report.noEntries).length) lines.push(`  vouchers not posted, no entries to post (no lines and not cancelled; cannot be represented yet): ${typeCounts(report.noEntries)}`);
  if (report.refused.length) lines.push('  vouchers refused by ten98-books posting rules and not posted (a difference from the dataset):', ...report.refused.map(line => `    ${line}`));
  if (report.numbers.checked || report.numbers.unnumbered) {
    lines.push(`  voucher numbers, ${report.numbers.kind}: ${report.numbers.matched} of ${report.numbers.checked} checked match expectedNumber${report.numbers.unnumbered ? `; ${report.numbers.unnumbered} optional voucher(s) hold a number in the dataset but take none until regular` : ''}`);
  }
  if (report.numberDifferences.length) lines.push(`  voucher numbers that differ from expectedNumber (${report.numbers.kind}; reported, not forced):`, ...report.numberDifferences.map(line => `    ${line}`));
  if (report.nameDifferences.length) lines.push('  standard ledger names that differ from the dataset:', ...report.nameDifferences.map(line => `    ${line}`));
  if (report.openingDifferences.length) lines.push('  opening balances left as they were:', ...report.openingDifferences.map(line => `    ${line}`));
  if (report.skipped.length) lines.push('  skipped (not modelled by ten98-books yet):', ...report.skipped.map(line => `    ${line}`));
  return lines;
}

/** The `seed-demo` command: seeds every selected dataset in turn and stops at the first error. */
export async function seedDemo(selection: DemoSelection & { yes: boolean; mastersOnly?: boolean; as?: string }, print: (line: string) => void = console.log): Promise<void> {
  if (!selection.yes) throw new DemoError('Seeding creates companies and vouchers in the database. Add --yes to confirm.');
  if (selection.as !== undefined) {
    if (selection.mastersOnly !== true) throw new DemoError('--as makes a second copy of the masters only: add --masters-only (the full seed always uses the dataset\'s own company).');
    if (selection.all || !selection.company) throw new DemoError('--as names one copy of one dataset: give --company <slug> and not --all.');
  }
  const userId = await findUserId(selection.email);
  for (const dataset of await selectDatasets(selection)) for (const line of formatSeedReport(await seedDataset(userId, dataset, selection.mastersOnly === true, selection.as))) print(line);
}
