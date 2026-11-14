import { join } from 'node:path';
import { formatMoney } from '@ten98/runtime';
import { baseCurrencies } from '../../lib/company.ts';
import { FoundationError } from '../auth.ts';
import { createCompany, listCompanies } from '../companies.ts';
import { getDatabase } from '../db.ts';
import { ledgerContext, runLedger } from '../ledger/context.ts';
import { alterLedger, createGroup, createLedger, listGroups, listLedgers, listVoucherTypes } from '../ledger/masters.ts';
import { cancelVoucher, createVoucher } from '../ledger/vouchers.ts';
import { withCompany } from '../tenancy.ts';
import { readLedgerBills } from './bill-rows.ts';
import { planBills } from './bills.ts';
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
 * (no vouchers, nothing foreign in the chart) is resumed. Groups and ledgers are matched by name, vouchers by key.
 */

/** Feature names (company.json `features`) ten98-books models; anything else is listed as skipped. */
export const supportedFeatures: ReadonlySet<string> = new Set(['accounting', 'billWise']);

export const voucherKeyPrefix = (slug: string) => `demo:${slug}:`;
/** The idempotency key the company is created under: one company per dataset and owner, however it is renamed later. */
export const creationKey = (slug: string, userId: string) => `demo:${slug}:${userId}`;

export type Counts = { created: number; present: number };
export type SeedReport = {
  slug: string; companyId: string; companyName: string; companyCreated: boolean;
  groups: Counts; ledgers: Counts & { openingsSet: number }; vouchers: Counts & { cancelled: number };
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
};

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
    const groupNames = new Set(dataset.groups.map(group => group.name.toLowerCase()));
    const ledgerNames = new Set(dataset.ledgers.map(ledger => ledger.name.toLowerCase()));
    return (await listGroups(context)).every(group => group.systemKey !== null || groupNames.has(group.name.toLowerCase()))
      && (await listLedgers(context)).every(ledger => ledger.systemKey !== null || ledgerNames.has(ledger.name.toLowerCase()));
  });
}

export type DemoCompany = { id: string; name: string; role: string };

/**
 * The user's company that holds `dataset`, or null when there is none. The company created under this dataset's key
 * (see `creationKey`) is found first, so a renamed company is still found by both commands; otherwise the name and the
 * voucher-key marker decide. Seeding considers only companies the user owns,
 * so membership of somebody else's copy neither blocks nor redirects it; reading considers every company the user can
 * open and prefers the one they own. A same-named company that is not this dataset's, or two that are, stops the
 * command rather than guess.
 */
export async function findDemoCompany(userId: string, dataset: Dataset, purpose: 'seed' | 'read'): Promise<DemoCompany | null> {
  // company_creation holds creation keys only (no company data, outside row-level security): a read-only lookup.
  const { rows: [created] } = await getDatabase().pool.query<{ company_id: string }>(
    'SELECT company_id FROM company_creation WHERE user_id = $1 AND idempotency_key = $2', [userId, creationKey(dataset.slug, userId)]);
  if (created) {
    const keyed = (await listCompanies(userId)).find(company => company.id === created.company_id && company.company !== null && !company.twoFactorLocked);
    if (keyed) {
      if (purpose === 'seed' && keyed.role !== 'owner') throw new DemoError(`The company created for "${dataset.slug}" is no longer owned by this user (they are its ${keyed.role}); the seeder writes only to companies it owns.`);
      return { id: keyed.id, name: keyed.name, role: keyed.role };
    }
  }
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
  const read = new Set(['billWise', 'creditDays', 'creditPeriodDays', 'openingBills', 'opening', 'bills']);
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
  if (withKey('costCentres').length) lines.push(`vouchers.json: cost centre allocations on ${withKey('costCentres').length} voucher line(s) (cost centres are not modelled)`);
  const foreign = lineExtras.filter(extra => typeof extra.currency === 'string');
  if (foreign.length) {
    const byCurrency = foreign.reduce((counts, extra) => counts.set(extra.currency as string, (counts.get(extra.currency as string) ?? 0) + 1), new Map<string, number>());
    lines.push(`vouchers.json: foreign-currency amounts on ${foreign.length} voucher line(s) (${[...byCurrency].map(([code, count]) => `${code} ${count}`).join(', ')}): posted at their base-currency amounts; currency, currencyAmount and rate are kept, not modelled`);
  }
  if (withKey('bank').length) lines.push(`vouchers.json: bank details (instrument and bank date) on ${withKey('bank').length} voucher line(s) (not modelled)`);
  for (const [file, content] of Object.entries(dataset.extraFiles)) {
    if (file === 'costCategories.json') { lines.push(`costCategories.json: cost categories not yet supported (${(content as unknown[]).length})`); continue; }
    if (file === 'costCentres.json') { lines.push(`costCentres.json: cost centres not yet supported (${(content as unknown[]).length} centre(s))`); continue; }
    if (file === 'currencies.json') {
      const list = content as { code: string; rates?: unknown[] }[];
      lines.push(`currencies.json: foreign currencies not yet supported (${list.map(currency => currency.code).join(', ')}; ${list.reduce((sum, currency) => sum + (currency.rates?.length ?? 0), 0)} rate(s))`);
      continue;
    }
    if (file === 'checkpoints.json') { lines.push('checkpoints.json: scenario checkpoint figures: pending bills are compared with the bill reports, the cost centre figures are kept as they are (not compared)'); continue; }
    if (file !== 'items.json') { lines.push(`${file}: feature file not modelled (kept as is)`); continue; }
    const items = content as ItemsFile;
    const value = formatMoney(openingStockValue(items, dataset.company.minorUnits), dataset.company.minorUnits);
    lines.push(`items.json: stock not yet supported (${items.items?.length ?? 0} item(s), ${items.locations?.length ?? 0} location(s); opening stock worth ${value} is not a ledger balance)`);
  }
  return lines;
}

/** Creates the groups and ledgers the company lacks, in one transaction; matches by name so a rerun changes nothing. */
async function seedMasters(userId: string, companyId: string, dataset: Dataset, report: SeedReport): Promise<void> {
  await runLedger(userId, companyId, 'write', async context => {
    const ids = new Map<string, string>();
    const existingGroups = await listGroups(context);
    for (const group of existingGroups) if (group.systemKey) ids.set(group.systemKey, group.id);
    const groupByName = new Map(existingGroups.map(group => [group.name.toLowerCase(), group]));
    const entries = new Map(dataset.groups.map(group => [group.key, group]));
    const place = async (key: string): Promise<string> => {
      const known = ids.get(key);
      if (known) return known;
      const entry = entries.get(key)!;
      const present = groupByName.get(entry.name.toLowerCase());
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
    const ledgerByName = new Map(existingLedgers.map(ledger => [ledger.name.toLowerCase(), ledger]));
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
        const present = ledgerByName.get(entry.name.toLowerCase());
        if (present) { report.ledgers.present++; continue; }
        // The dataset's bill settings (see bill-rows.ts): bill-wise flag, default credit days and opening bills.
        const { billWise, creditDays, openingBills } = readLedgerBills(entry.extras).found;
        await createLedger(context, {
          name: entry.name, groupId: await place(entry.group!),
          ...entry.secondLanguageName ? { secondLanguageName: entry.secondLanguageName } : {},
          ...entry.opening ? { opening: { ...entry.opening, ...openingBills.length ? { bills: openingBills.map(bill => ({
            name: bill.name, ...bill.billDate !== undefined ? { billDate: bill.billDate } : {}, ...bill.creditDays !== undefined ? { creditPeriod: { count: bill.creditDays, unit: 'day' as const } } : {}, amount: bill.amount,
          })) } : {} } } : {},
          ...billWise !== undefined ? { billWise } : {}, ...creditDays !== undefined ? { creditPeriod: { count: creditDays, unit: 'day' as const } } : {},
        });
        report.ledgers.created++;
        report.bills.openingBills += openingBills.length;
        if (entry.opening) report.ledgers.openingsSet++;
      } catch (error) { failure(dataset, 'ledgers', at, error); }
    }
  }).catch(error => { throw error instanceof DemoError ? error : failure(dataset, 'ledgers', 'masters', error); });
}

/** The rows left out, grouped by reason, one line each (the voucher keys of the first few named). */
export function describeSkippedBills(skipped: ReturnType<typeof planBills>['skipped']): string[] {
  const lines: string[] = [];
  const reasons = {
    foreign: 'bill rows on foreign-currency lines (bills are base currency only until currencies are built)',
    unknown: 'against rows settling a bill that no posted row creates (it belongs to a foreign-currency line, or to a voucher the dataset carries without lines)',
  };
  for (const reason of ['foreign', 'unknown'] as const) {
    const those = skipped.filter(row => row.reason === reason);
    if (!those.length) continue;
    const examples = [...new Set(those.map(row => `${row.voucher}${row.name ? ` (${row.name})` : ''}`))].slice(0, 4).join(', ');
    lines.push(`${those.length} ${reasons[reason]}; e.g. ${examples}`);
  }
  return lines;
}

/** Posts the vouchers in entry order, each in its own transaction under its idempotency key; stops at the first error. */
async function seedVouchers(userId: string, companyId: string, dataset: Dataset, report: SeedReport): Promise<void> {
  const { ledgerByKey, typeIds } = await runLedger(userId, companyId, 'read', async context => {
    const ledgers = await listLedgers(context);
    const ledgerByKey: Record<string, string> = {};
    for (const entry of dataset.ledgers) {
      const found = ledgers.find(ledger => entry.standard ? ledger.systemKey === entry.standard : ledger.name.toLowerCase() === entry.name.toLowerCase());
      if (found) ledgerByKey[entry.key] = found.id;
    }
    return { ledgerByKey, typeIds: Object.fromEntries((await listVoucherTypes(context)).map(type => [type.systemKey ?? '', type.id])) };
  });
  const bump = (counts: Record<string, number>, type: string) => { counts[type] = (counts[type] ?? 0) + 1; };
  const bills = planBills(dataset);
  report.bills.skipped = describeSkippedBills(bills.skipped);
  const assigned = new Map<string, number | null>();
  const refused = new Set<string>();
  for (const voucher of dataset.vouchers) {
    const at = `voucher "${voucher.key}"`;
    const disposition = dispositionOf(voucher);
    if (disposition !== 'post') {
      bump(disposition === 'unsupported-type' ? report.unsupportedTypes : report.noEntries, voucher.type);
      continue;
    }
    try {
      const body = {
        idempotencyKey: voucherKeyPrefix(dataset.slug) + voucher.key, voucherTypeId: typeIds[voucher.type], date: voucher.date,
        narration: voucher.narration ?? null, status: voucher.status === 'optional' ? 'optional' : 'regular', postDated: voucher.postDated,
        lines: voucher.lines.map((line, index) => ({ ledgerId: ledgerByKey[line.ledger], side: line.side, amount: line.amount, ...bills.lines.get(voucher.key)?.[index] ? { bills: bills.lines.get(voucher.key)![index] } : {} })),
      };
      const send = (payload: typeof body) => runLedger(userId, companyId, 'write', async context => {
        let { voucher: posted, replayed, warnings } = await createVoucher(context, payload);
        if (!replayed) {
          report.bills.rowsPosted += payload.lines.reduce((sum, line) => sum + ('bills' in line ? line.bills!.length : 0), 0);
          for (const warning of warnings) (report.bills.warnings[warning.code] ??= []).push(`${voucher.key}${warning.line ? ` line ${warning.line}` : ''}${warning.billName ? ` bill "${warning.billName}"` : ''}`);
        }
        let cancelled = false;
        if (voucher.status === 'cancelled' && posted.status === 'regular') {
          posted = (await cancelVoucher(context, posted.id, { revision: posted.revision })).voucher;
          cancelled = true;
        }
        return { number: posted.number, replayed, cancelled };
      });
      let done: Awaited<ReturnType<typeof send>>;
      try { done = await send(body); }
      catch (error) {
        // A company seeded before bill rows were sent holds this voucher without them, so its request hash differs. Replay
        // it as it was posted (the key proves it is this dataset's voucher) and say so; any other mismatch still stops.
        if (!(error instanceof FoundationError && error.code === 'idempotency_mismatch' && body.lines.some(line => 'bills' in line))) throw error;
        const plain = { ...body, lines: body.lines.map(({ ledgerId, side, amount }) => ({ ledgerId, side, amount })) };
        try { done = await send(plain as typeof body); } catch { throw error; }
        if (!done.replayed) throw error;
        report.bills.keptWithoutBills.push(voucher.key);
      }
      if (done.replayed && !done.cancelled) report.vouchers.present++; else report.vouchers.created++;
      if (done.cancelled) report.vouchers.cancelled++;
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
export async function seedDataset(userId: string, dataset: Dataset, mastersOnly = false): Promise<SeedReport> {
  const client = await getDatabase().pool.connect();
  const lockKey = `demo-seed:${userId}:${dataset.slug}`;
  let broken = false;
  try {
    while (!(await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [lockKey])).rows[0].locked) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    try { return await seedUnderLock(userId, dataset, mastersOnly); }
    finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => { broken = true; }); }
  } catch (error) {
    broken = broken || (error as { code?: string })?.code?.startsWith('08') === true;
    throw error;
  } finally { client.release(broken); }
}

async function seedUnderLock(userId: string, dataset: Dataset, mastersOnly: boolean): Promise<SeedReport> {
  const settings = dataset.company;
  const currency = baseCurrencies[settings.baseCurrency as keyof typeof baseCurrencies];
  if (!currency) throw new DemoError(`demo/${dataset.slug}/company.json: baseCurrency "${settings.baseCurrency}" is not supported by ten98-books (${Object.keys(baseCurrencies).join(', ')})`);
  if (currency.minorUnits !== settings.minorUnits) throw new DemoError(`demo/${dataset.slug}/company.json: minorUnits ${settings.minorUnits} does not match ${settings.baseCurrency}, which has ${currency.minorUnits}`);

  let company = await findDemoCompany(userId, dataset, 'seed');
  const report: SeedReport = {
    slug: dataset.slug, companyId: '', companyName: settings.name, companyCreated: false,
    groups: { created: 0, present: 0 }, ledgers: { created: 0, present: 0, openingsSet: 0 }, vouchers: { created: 0, present: 0, cancelled: 0 },
    unsupportedTypes: {}, noEntries: {}, refused: [], numbers: { checked: 0, matched: 0, unnumbered: 0, kind: numbersKind(dataset) },
    numberDifferences: [], nameDifferences: [], openingDifferences: [], skipped: unmodelled(dataset),
    mastersOnly, bills: { openingBills: 0, rowsPosted: 0, skipped: [], warnings: {}, keptWithoutBills: [] },
  };
  if (!company) {
    try {
      // The key (dataset slug and owner) makes a repeated create return the first company, beside the marker search and the lock.
      const { company: created, replayed } = await createCompany(userId, {
        idempotencyKey: creationKey(dataset.slug, userId),
        name: settings.name, baseCurrency: settings.baseCurrency, financialYearStart: settings.financialYearStart, booksBeginning: settings.booksBeginning,
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
  const changed = report.companyCreated || report.groups.created || report.ledgers.created || report.ledgers.openingsSet || report.vouchers.created;
  const part = (counts: Counts) => `${counts.created} created, ${counts.present} already present`;
  const lines = [
    `${report.companyName} (${report.slug}): ${changed ? 'seeded' : 'already present, nothing changed'}`,
    `  company: ${report.companyCreated ? 'created' : 'already present'}`,
    `  groups: ${part(report.groups)}`,
    `  ledgers: ${part(report.ledgers)}${report.ledgers.openingsSet ? `; ${report.ledgers.openingsSet} opening balance(s) set` : ''}`,
    report.mastersOnly ? '  vouchers: not posted (masters only)' : `  vouchers: ${part(report.vouchers)}${report.vouchers.cancelled ? `; ${report.vouchers.cancelled} cancelled` : ''}`,
  ];
  if (report.bills.openingBills) lines.push(`  opening bills: ${report.bills.openingBills} set with the ledgers created`);
  const typeCounts = (counts: Record<string, number>) => Object.entries(counts).map(([type, count]) => `${count} ${type.replace(/_/g, ' ')}`).join(', ');
  if (report.bills.rowsPosted) lines.push(`  bill rows: ${report.bills.rowsPosted} posted with the vouchers`);
  if (report.bills.keptWithoutBills.length) lines.push(`  vouchers already posted before bill rows were sent, kept as they were without bill rows: ${report.bills.keptWithoutBills.length} (e.g. ${report.bills.keptWithoutBills.slice(0, 3).join(', ')}); seed into a new company to get their bills`);
  if (report.bills.skipped.length) lines.push('  bill rows left out:', ...report.bills.skipped.map(line => `    ${line}`));
  const warningCodes = Object.entries(report.bills.warnings);
  if (warningCodes.length) lines.push('  bill warnings raised by the postings:', ...warningCodes.map(([code, which]) => `    ${code}: ${which.length} (e.g. ${which.slice(0, 3).join('; ')})`));
  if (Object.keys(report.unsupportedTypes).length) lines.push(`  vouchers not posted, type not yet supported: ${typeCounts(report.unsupportedTypes)}`);
  if (Object.keys(report.noEntries).length) lines.push(`  vouchers not posted, no entries to post (cancelled or no accounting effect; cannot be represented yet): ${typeCounts(report.noEntries)}`);
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
export async function seedDemo(selection: DemoSelection & { yes: boolean; mastersOnly?: boolean }, print: (line: string) => void = console.log): Promise<void> {
  if (!selection.yes) throw new DemoError('Seeding creates companies and vouchers in the database. Add --yes to confirm.');
  const userId = await findUserId(selection.email);
  for (const dataset of await selectDatasets(selection)) for (const line of formatSeedReport(await seedDataset(userId, dataset, selection.mastersOnly === true))) print(line);
}
