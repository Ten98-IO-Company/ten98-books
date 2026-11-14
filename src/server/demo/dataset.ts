import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { multiplyMoney, parseMoney, type MoneyExponent } from '@ten98/runtime';
import { z } from 'zod';
import { daysInMonth, isCalendarDate } from '../../lib/company.ts';
import { natures, sides, voucherKinds } from '../../lib/ledger.ts';

/**
 * Demo dataset format v1 (documented in demo/README.md). A dataset is one folder per company under demo/: five known
 * JSON files (company, groups, ledgers, vouchers, expected) that this module validates, plus any further feature files
 * (items.json, employees.json, ...) and `extras` / `inventory` content that describe features ten98-books does not model
 * yet; those are accepted, kept untouched and listed as skipped by the seeder. Amounts are plain decimal strings, dates
 * are YYYY-MM-DD and every key is a lowercase slug, unique inside its file.
 */

/** A dataset problem the user can fix: every message names the file and the key at fault. */
export class DemoError extends Error {}
export class DatasetError extends DemoError {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join('\n'));
    this.issues = issues;
  }
}

/** The groups every company is seeded with (D-10); a dataset group may sit under one of these by `system_key`. */
export const seededGroupKeys = [
  'branches', 'capital', 'current_assets', 'current_liabilities', 'direct_expenses', 'direct_income', 'fixed_assets',
  'indirect_expenses', 'indirect_income', 'investments', 'loans', 'deferred_expenses', 'purchases', 'sales', 'suspense',
  'reserves', 'bank_accounts', 'cash_in_hand', 'deposits_paid', 'advances_given', 'inventory', 'receivables',
  'duties_taxes', 'provisions', 'payables', 'bank_overdraft', 'secured_loans', 'unsecured_loans',
] as const;
/** The voucher types every company is seeded with: their system keys are the voucher kinds. */
export const seededVoucherTypeKeys: readonly string[] = voucherKinds;
export const standardLedgers = ['cash', 'profit_and_loss'] as const;

const knownFiles = ['company', 'groups', 'ledgers', 'vouchers', 'expected'] as const;

const slug = z.string().max(40).regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, 'must be a lowercase slug (letters, digits, "-" and "_")');
const text = z.string().trim().min(1, 'must not be empty').max(120);
const amount = z.string().regex(/^\d+(?:\.\d+)?$/, 'must be a plain decimal string such as "1250.50" (digits and one dot; no grouping, sign or exponent)');
const signedAmount = z.string().regex(/^-?\d+(?:\.\d+)?$/, 'must be a plain decimal string such as "-1250.50" (no grouping or exponent)');
const date = z.string().refine(isCalendarDate, 'must be a real date written YYYY-MM-DD');
const side = z.enum(sides);
const extras = z.record(z.string(), z.unknown());
const count = z.number().int().min(0);

const companyFile = z.strictObject({
  slug, name: text, secondLanguageName: text.optional(), country: z.string().trim().min(2).max(60),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/, 'must be a three-letter currency code'),
  minorUnits: z.union([z.literal(2), z.literal(3)], 'must be 2 or 3'),
  financialYearStart: z.strictObject({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) })
    .refine(start => start.day <= daysInMonth(start.month), 'must be a day that exists in that month'),
  booksBeginning: date, timeZone: z.string().min(1).max(80), features: z.array(z.string().min(1)), extras: extras.optional(),
});
const groupsFile = z.array(z.strictObject({ key: slug, name: text, under: z.string().min(1), nature: z.enum(natures).optional(), extras: extras.optional() }));
const ledgersFile = z.array(z.strictObject({
  key: slug, name: text, secondLanguageName: text.optional(), group: z.string().min(1).optional(), standard: z.enum(standardLedgers).optional(),
  opening: z.strictObject({ amount, side }).optional(), extras: extras.optional(),
}));
const vouchersFile = z.array(z.strictObject({
  key: slug, type: slug, date, status: z.enum(['regular', 'cancelled', 'optional']), postDated: z.boolean(),
  narration: z.string().max(2000).optional(),
  lines: z.array(z.strictObject({ ledger: z.string().min(1), side, amount, extras: extras.optional() })),
  inventory: z.array(z.unknown()).optional(), extras: extras.optional(),
  expectedNumber: z.union([z.number().int().min(1), z.string().min(1)]).optional(),
}));
const expectedFile = z.looseObject({
  period: z.strictObject({ from: date, to: date }),
  voucherCount: count.optional(),
  vouchersByType: z.record(z.string(), count).optional(),
  trialBalance: z.looseObject({
    totalDebit: amount, totalCredit: amount,
    ledgers: z.record(z.string(), z.strictObject({ closing: amount, side })),
  }).optional(),
  profitAndLoss: z.looseObject({
    grossProfit: signedAmount, netProfit: signedAmount,
    grossProfitExcludingStock: signedAmount.optional(), netProfitExcludingStock: signedAmount.optional(),
  }).optional(),
  balanceSheet: z.looseObject({ total: signedAmount, closingStockInAssets: amount.optional() }).optional(),
});
/**
 * items.json (units, locations, stock groups, items with opening stock per location): ten98-books does not model stock
 * yet, so only its shape and references are checked; every other field is kept as it is.
 */
const itemsFile = z.looseObject({
  units: z.array(z.looseObject({ key: slug, name: text })).optional(),
  locations: z.array(z.looseObject({ key: slug, name: text })).optional(),
  stockGroups: z.array(z.looseObject({ key: slug, name: text })).optional(),
  items: z.array(z.looseObject({
    key: slug, name: text, group: z.string().min(1).optional(), unit: z.string().min(1).optional(),
    opening: z.array(z.looseObject({ location: z.string().min(1), quantity: amount, rate: amount })).optional(),
  })).optional(),
});
export type ItemsFile = z.infer<typeof itemsFile>;

export type CompanyFile = z.infer<typeof companyFile>;
export type GroupEntry = z.infer<typeof groupsFile>[number];
export type LedgerEntry = z.infer<typeof ledgersFile>[number];
export type VoucherEntry = z.infer<typeof vouchersFile>[number];
export type Expected = z.infer<typeof expectedFile>;

export type Dataset = {
  slug: string; company: CompanyFile; groups: GroupEntry[]; ledgers: LedgerEntry[]; vouchers: VoucherEntry[]; expected: Expected;
  /** Further top-level feature files, parsed JSON kept untouched, by file name. */
  extraFiles: Record<string, unknown>;
};
/** The parsed JSON of each file; `groups` may be absent (no groups beyond the seeded chart). */
export type RawDataset = { company: unknown; groups?: unknown; ledgers: unknown; vouchers: unknown; expected: unknown; extraFiles?: Record<string, unknown> };

/**
 * What the opening stock in items.json is worth in minor units: quantity times rate for every item and location, each
 * rounded half up. Opening stock is not a ledger balance, so ledger openings alone leave a difference of this amount.
 */
export function openingStockValue(items: ItemsFile | undefined, exponent: MoneyExponent): bigint {
  let total = 0n;
  for (const item of items?.items ?? []) for (const line of item.opening ?? []) total += multiplyMoney(toMinor(line.rate, exponent), line.quantity, 'half-up');
  return total;
}

/**
 * What ten98-books can do with a voucher: `post` it through the ledger module, skip it because its type is not one of the
 * seeded eight (`unsupported-type`), or skip it because it has no lines to post (`no-entries`: a cancelled voucher or one
 * with no accounting effect; a voucher needs two lines here, so it cannot be represented yet). Seeder and comparison
 * share this so what is skipped is also what is left out of the figures compared.
 */
export function dispositionOf(voucher: VoucherEntry): 'post' | 'unsupported-type' | 'no-entries' {
  if (!seededVoucherTypeKeys.includes(voucher.type)) return 'unsupported-type';
  return voucher.lines.length === 0 ? 'no-entries' : 'post';
}

/** Minor units of a plain decimal string; refuses more decimal places than the currency has instead of rounding. */
export function toMinor(value: string, exponent: MoneyExponent): bigint {
  if ((value.split('.')[1] ?? '').length > exponent) throw new RangeError(`has more than ${exponent} decimal places`);
  return parseMoney(value, exponent);
}

/** "voucher "key" lines[1].amount: " from a zod path, naming an array entry by its key when it has one. */
function where(raw: unknown, path: readonly PropertyKey[]): string {
  let node: unknown = raw;
  let text = '';
  path.forEach((segment, depth) => {
    node = node !== null && typeof node === 'object' ? (node as Record<PropertyKey, unknown>)[segment] : undefined;
    if (typeof segment === 'number') {
      const key = node !== null && typeof node === 'object' ? (node as { key?: unknown }).key : undefined;
      text += depth === 0 ? `entry ${typeof key === 'string' ? `"${key}"` : `#${segment + 1}`} ` : `[${segment}]`;
    } else text += depth === 0 || text.endsWith(' ') ? String(segment) : `.${String(segment)}`;
  });
  return text ? `${text.trimEnd()}: ` : '';
}

function structural<S extends z.ZodType>(schema: S, raw: unknown, file: string, issues: string[]): z.output<S> | undefined {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) issues.push(`${file}: ${where(raw, issue.path)}${issue.message}`);
  return undefined;
}

/**
 * Validates parsed dataset files. Structure first (strict keys, types, formats), then the references and rules that
 * need several files: every `under`, `group`, `ledger` and `type` resolves, amounts fit the currency's minor units,
 * every regular voucher balances and no date is before the books begin. All problems are reported together, each naming
 * `label/file` and the key.
 */
export function parseDataset(raw: RawDataset, label = 'dataset'): Dataset {
  const issues: string[] = [];
  const company = structural(companyFile, raw.company, `${label}/company.json`, issues);
  const groups = structural(groupsFile, raw.groups ?? [], `${label}/groups.json`, issues);
  const ledgers = structural(ledgersFile, raw.ledgers, `${label}/ledgers.json`, issues);
  const vouchers = structural(vouchersFile, raw.vouchers, `${label}/vouchers.json`, issues);
  const expected = structural(expectedFile, raw.expected, `${label}/expected.json`, issues);
  const itemsRaw = raw.extraFiles?.['items.json'];
  const items = itemsRaw === undefined ? undefined : structural(itemsFile, itemsRaw, `${label}/items.json`, issues);
  if (!company || !groups || !ledgers || !vouchers || !expected || (itemsRaw !== undefined && !items)) throw new DatasetError(issues);

  const problem = (file: string, at: string, message: string) => issues.push(`${label}/${file}.json: ${at}${message}`);
  const exponent = company.minorUnits;
  const fits = (file: string, at: string, value: string) => {
    if ((value.split('.')[1] ?? '').length > exponent) problem(file, at, `amount "${value}" has more than ${exponent} decimal places (the company's minor units)`);
  };
  const duplicates = (file: string, what: string, keys: string[]) => {
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) problem(file, `${what} "${key}": `, 'the key is used more than once');
      seen.add(key);
    }
  };

  // Groups.
  duplicates('groups', 'group', groups.map(group => group.key));
  const groupKeys = new Set(groups.map(group => group.key));
  const seededGroups = new Set<string>(seededGroupKeys);
  for (const group of groups) if (seededGroups.has(group.key)) problem('groups', `group "${group.key}": `, 'the key is the system key of a seeded group; choose another key');
  const parentOf = new Map(groups.map(group => [group.key, group.under]));
  for (const group of groups) {
    if (!groupKeys.has(group.under) && !seededGroups.has(group.under)) { problem('groups', `group "${group.key}": `, `under "${group.under}" is neither a group key in groups.json nor a seeded group's system key`); continue; }
    const path = new Set([group.key]);
    for (let up = group.under; parentOf.has(up); up = parentOf.get(up)!) {
      if (path.has(up)) { problem('groups', `group "${group.key}": `, 'the groups form a cycle through "under"'); break; }
      path.add(up);
    }
  }
  const lower = (names: string[]) => names.map(name => name.toLowerCase());
  duplicates('groups', 'group name', lower(groups.map(group => group.name)));

  // Ledgers.
  duplicates('ledgers', 'ledger', ledgers.map(ledger => ledger.key));
  duplicates('ledgers', 'ledger name', lower(ledgers.map(ledger => ledger.name)));
  duplicates('ledgers', 'standard ledger', ledgers.flatMap(ledger => ledger.standard ? [ledger.standard] : []));
  const ledgerKeys = new Set(ledgers.map(ledger => ledger.key));
  for (const ledger of ledgers) {
    const at = `ledger "${ledger.key}": `;
    if (ledger.group === undefined) { if (!ledger.standard) problem('ledgers', at, 'group is required (a group key or a seeded group system key)'); }
    else if (!groupKeys.has(ledger.group) && !seededGroups.has(ledger.group)) problem('ledgers', at, `group "${ledger.group}" is neither a group key in groups.json nor a seeded group's system key`);
    if (ledger.standard === 'profit_and_loss' && ledger.group !== undefined) problem('ledgers', at, 'the profit and loss ledger stays outside every group; remove "group"');
    if (ledger.standard === 'cash' && ledger.group !== undefined && ledger.group !== 'cash_in_hand') problem('ledgers', at, `a standard cash ledger sits in cash_in_hand and is not moved, but group is "${ledger.group}"`);
    if (ledger.opening) fits('ledgers', `${at}opening: `, ledger.opening.amount);
  }

  // Vouchers.
  duplicates('vouchers', 'voucher', vouchers.map(voucher => voucher.key));
  for (const voucher of vouchers) {
    const at = `voucher "${voucher.key}": `;
    const unposted = voucher.status === 'cancelled' || voucher.extras?.noAccountingEffect === true;
    if (voucher.lines.length === 0 && !unposted) problem('vouchers', at, 'a voucher without lines must be cancelled or carry extras.noAccountingEffect: true');
    if (voucher.extras?.noAccountingEffect === true && voucher.lines.length > 0) problem('vouchers', at, 'a voucher marked extras.noAccountingEffect carries no lines');
    if (voucher.date < company.booksBeginning) problem('vouchers', at, `date ${voucher.date} is before the books begin on ${company.booksBeginning}`);
    let debit = 0n, credit = 0n;
    voucher.lines.forEach((line, index) => {
      const lineAt = `${at}lines[${index}]: `;
      if (!ledgerKeys.has(line.ledger)) problem('vouchers', lineAt, `ledger "${line.ledger}" is not a ledger key in ledgers.json`);
      fits('vouchers', lineAt, line.amount);
      if (/^0+(?:\.0+)?$/.test(line.amount)) problem('vouchers', lineAt, 'the amount must be more than zero');
      else if ((line.amount.split('.')[1] ?? '').length <= exponent) {
        if (line.side === 'Dr') debit += toMinor(line.amount, exponent); else credit += toMinor(line.amount, exponent);
      }
    });
    if (voucher.status === 'regular' && debit !== credit) problem('vouchers', at, `a regular voucher must balance; debits ${debit} and credits ${credit} (in minor units) differ`);
  }

  // items.json: references, and the item and location of every inventory line when the file is present.
  const itemKeys = new Set((items?.items ?? []).map(item => item.key));
  if (items) {
    duplicates('items', 'item', (items.items ?? []).map(item => item.key));
    const locationKeys = new Set((items.locations ?? []).map(location => location.key));
    const stockGroupKeys = new Set((items.stockGroups ?? []).map(group => group.key));
    const units = new Set((items.units ?? []).flatMap(unit => [unit.key, unit.name]));
    for (const item of items.items ?? []) {
      const at = `item "${item.key}": `;
      if (item.group !== undefined && !stockGroupKeys.has(item.group)) problem('items', at, `group "${item.group}" is not a stock group key`);
      if (item.unit !== undefined && (items.units ?? []).length && !units.has(item.unit)) problem('items', at, `unit "${item.unit}" is not a unit key or name`);
      for (const line of item.opening ?? []) {
        if (!locationKeys.has(line.location)) problem('items', `${at}opening: `, `location "${line.location}" is not a location key`);
        if ((line.rate.split('.')[1] ?? '').length > exponent) problem('items', `${at}opening: `, `rate "${line.rate}" has more than ${exponent} decimal places (the company's minor units)`);
      }
    }
    for (const voucher of vouchers) for (const [index, line] of (voucher.inventory ?? []).entries()) {
      const detail = line as { item?: unknown; location?: unknown } | null;
      const at = `voucher "${voucher.key}": inventory[${index}]: `;
      if (typeof detail?.item === 'string' && !itemKeys.has(detail.item)) problem('vouchers', at, `item "${detail.item}" is not an item key in items.json`);
      if (typeof detail?.location === 'string' && !locationKeys.has(detail.location)) problem('vouchers', at, `location "${detail.location}" is not a location key in items.json`);
    }
  }

  // Expected figures.
  const period = expected.period;
  if (period.from > period.to) problem('expected', 'period: ', 'from must not be after to');
  const types = expected.vouchersByType;
  if (types) {
    const known = new Set([...seededVoucherTypeKeys, ...vouchers.map(voucher => voucher.type)]);
    for (const type of Object.keys(types)) if (!known.has(type)) problem('expected', `vouchersByType "${type}": `, 'neither a seeded voucher type nor a type used in vouchers.json');
    const total = Object.values(types).reduce((sum, value) => sum + value, 0);
    if (expected.voucherCount !== undefined && total !== expected.voucherCount) problem('expected', 'vouchersByType: ', `the counts add up to ${total} but voucherCount is ${expected.voucherCount}`);
  }
  const trial = expected.trialBalance;
  if (trial) {
    fits('expected', 'trialBalance.totalDebit: ', trial.totalDebit);
    fits('expected', 'trialBalance.totalCredit: ', trial.totalCredit);
    for (const [key, figure] of Object.entries(trial.ledgers)) {
      if (!ledgerKeys.has(key)) problem('expected', `trialBalance.ledgers "${key}": `, 'not a ledger key in ledgers.json');
      fits('expected', `trialBalance.ledgers "${key}": `, figure.closing);
    }
  }
  if (expected.profitAndLoss) for (const name of ['grossProfit', 'netProfit', 'grossProfitExcludingStock', 'netProfitExcludingStock'] as const) {
    const value = expected.profitAndLoss[name];
    if (value !== undefined) fits('expected', `profitAndLoss.${name}: `, value);
  }
  if (expected.balanceSheet) {
    fits('expected', 'balanceSheet.total: ', expected.balanceSheet.total);
    if (expected.balanceSheet.closingStockInAssets !== undefined) fits('expected', 'balanceSheet.closingStockInAssets: ', expected.balanceSheet.closingStockInAssets);
  }

  if (issues.length) throw new DatasetError(issues);
  return { slug: company.slug, company, groups, ledgers, vouchers, expected, extraFiles: raw.extraFiles ?? {} };
}

/** The demo/ folder at the repository root. */
export const demoRoot = fileURLToPath(new URL('../../../demo/', import.meta.url));

/** The most one dataset file may hold. A mistake (a data dump, the wrong file) is refused with a clear message, not parsed. */
export const maxFileBytes = 32 * 1024 * 1024;

/**
 * Keys that appear twice in one JSON object: `JSON.parse` keeps the last silently, so the first value would vanish
 * unseen. Runs on text that already parsed, so it only has to walk the structure, not validate it.
 */
export function duplicateKeys(text: string): string[] {
  const found: string[] = [];
  let at = 0;
  const skip = () => { while (at < text.length && ' \t\r\n'.includes(text[at])) at++; };
  const string = (): string => {
    const start = at++;
    while (text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
    return JSON.parse(text.slice(start, ++at)) as string;
  };
  const value = (path: string): void => {
    skip();
    if (text[at] === '"') { string(); return; }
    if (text[at] === '{' || text[at] === '[') {
      const object = text[at++] === '{', seen = new Set<string>();
      for (let index = 0; ; index++) {
        skip();
        if (text[at] === '}' || text[at] === ']') { at++; return; }
        if (object) {
          const key = string();
          if (seen.has(key)) found.push(`${path || 'the top level'}: the key "${key}" appears more than once`);
          seen.add(key);
          skip(); at++;
          value(path ? `${path}.${key}` : key);
        } else value(`${path}[${index}]`);
        skip();
        if (text[at] === ',') at++;
      }
    }
    while (at < text.length && !',]} \t\r\n'.includes(text[at])) at++;
  };
  value('');
  return found;
}

const bytes = (count: number) => count >= 1048576 ? `${(count / 1048576).toFixed(1)} MB` : `${count} bytes`;

async function readJson(label: string, directory: string, name: string, required: boolean, limit: number): Promise<unknown> {
  const path = join(directory, name);
  let content: string;
  try {
    const { size } = await stat(path);
    if (size > limit) throw new DatasetError([`${label}/${name}: the file is ${bytes(size)}; the limit is ${bytes(limit)} per file`]);
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof DatasetError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) return undefined;
    throw new DatasetError([`${label}/${name}: ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'the file is missing' : 'the file cannot be read'}`]);
  }
  content = content.replace(/^\uFEFF/, '');
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch (error) { throw new DatasetError([`${label}/${name}: not valid JSON (${(error as Error).message})`]); }
  const repeated = duplicateKeys(content);
  if (repeated.length) throw new DatasetError(repeated.slice(0, 20).map(issue => `${label}/${name}: ${issue}`));
  return parsed;
}

/** Loads and validates the dataset in `directory`; its company slug must equal the folder name. */
export async function loadDataset(directory: string, { maxBytes = maxFileBytes }: { maxBytes?: number } = {}): Promise<Dataset> {
  const folder = directory.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? directory;
  const label = `demo/${folder}`;
  const required = (name: string) => readJson(label, directory, `${name}.json`, true, maxBytes);
  const [company, ledgers, vouchers, expected, groups] = await Promise.all([required('company'), required('ledgers'), required('vouchers'), required('expected'), readJson(label, directory, 'groups.json', false, maxBytes)]);
  const extraFiles: Record<string, unknown> = {};
  for (const entry of (await readdir(directory)).sort()) {
    if (!entry.endsWith('.json') || (knownFiles as readonly string[]).includes(entry.slice(0, -5))) continue;
    extraFiles[entry] = await readJson(label, directory, entry, true, maxBytes);
  }
  const dataset = parseDataset({ company, groups, ledgers, vouchers, expected, extraFiles }, label);
  if (dataset.slug !== folder) throw new DatasetError([`${label}/company.json: slug "${dataset.slug}" must equal the folder name "${folder}"`]);
  return dataset;
}

/** The dataset folder names under `root`, sorted. */
export async function listDatasetFolders(root = demoRoot): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort();
}
