import { addMoney, compareMoney, formatMoney, subtractMoney, type MoneyExponent } from '@ten98/runtime/browser';
import type { Side, VoucherKind } from '../ledger.ts';
import { byName, descendantIds } from '../masters.ts';
import { readStored, writeStored, type StoreSource } from '../working-date.ts';
import { amountText, minorOf } from './amounts.ts';

/** Voucher types, layouts, lines, lists and the type switch (docs/VOUCHERS.md, "Opening and types", "The Enter path"). */

/** The voucher types slice 1 builds. */
export const entryKinds = ['payment', 'receipt', 'contra', 'journal'] as const;
export type EntryKind = (typeof entryKinds)[number];
export const isEntryKind = (value: unknown): value is EntryKind => entryKinds.includes(value as EntryKind);

export const kindTitles: Record<VoucherKind, string> = {
  payment: 'Payment', receipt: 'Receipt', contra: 'Contra', journal: 'Journal', sales: 'Sales', purchase: 'Purchase',
  credit_note: 'Credit note', debit_note: 'Debit note', stock_journal: 'Stock journal',
};

/** Single entry: an Account field and particulars lines. Double entry: lines with a side each. */
export type EntryLayout = 'single' | 'double';
export const layoutTitles: Record<EntryLayout, string> = { single: 'Single entry', double: 'Double entry' };
/** The layouts a type offers: journal is double entry only. */
export const layoutsOf = (kind: EntryKind): readonly EntryLayout[] => kind === 'journal' ? ['double'] : ['single', 'double'];
/** Each type's own layout before any choice (observed): payment, receipt and contra open in single entry. */
export const defaultLayout = (kind: EntryKind): EntryLayout => kind === 'journal' ? 'double' : 'single';

const other = (side: Side): Side => side === 'Dr' ? 'Cr' : 'Dr';
/** A side read back from a grid cell's text: Dr, Cr, or '' for anything else. */
export const sideOf = (value: string | undefined): Side | '' => value === 'Dr' || value === 'Cr' ? value : '';
/**
 * The side of the single-entry Account: credited on a payment, debited on a receipt and on a contra (observed: the
 * contra's Account is the receiving side, and the starter dataset's contra lines follow that order).
 */
export const accountSide = (kind: EntryKind): Side => kind === 'payment' ? 'Cr' : 'Dr';
/** The side of single-entry particulars lines: the other side of the Account. */
export const particularsSide = (kind: EntryKind): Side => other(accountSide(kind));
/**
 * The first line's side in double entry, fixed by the type (observed: payment and journal debit first, receipt credits
 * first). The contra's is not observed; ours follows its Account, the receiving side.
 */
export const firstLineSide = (kind: EntryKind): Side => kind === 'receipt' ? 'Cr' : 'Dr';

// ---- Mode memory ----

/**
 * A layout chosen in one type applies to every type of its family (observed). The cash family (payment, receipt,
 * contra) keeps its choice per tab, user and company; the journal has no choice. Invoice types (slice 2) keep theirs
 * per browser (slice 2).
 */
export const cashModeKey = (userId: string, companyId: string): string => `voucherMode:${userId}:${companyId}:cash`;

export function readLayout(kind: EntryKind, session: StoreSource, userId: string, companyId: string): EntryLayout {
  if (kind === 'journal') return 'double';
  const stored = readStored(session, cashModeKey(userId, companyId));
  return stored === 'single' || stored === 'double' ? stored : defaultLayout(kind);
}

export function writeLayout(kind: EntryKind, layout: EntryLayout, session: StoreSource, userId: string, companyId: string): void {
  if (kind !== 'journal') writeStored(session, cashModeKey(userId, companyId), layout);
}

// ---- Lines ----

/** One line as the screen holds it: a side ('' only while a double-entry line has none yet), a ledger id and an amount. */
export type EntryLine = { key: string; side: Side | ''; ledger: string; amount: string };
/** A line with nothing in it: no ledger and no amount (its side alone does not count). */
export const isBlankLine = (line: Pick<EntryLine, 'ledger' | 'amount'>): boolean => line.ledger === '' && line.amount === '';
/** A line the body carries: a ledger and an amount, and a side in double entry. */
export const isCompleteLine = (line: EntryLine): boolean => line.ledger !== '' && line.amount !== '' && line.side !== '';

/** Debit and credit totals of the complete lines (typed amounts, not ledger balances). */
export function lineTotals(lines: readonly EntryLine[], exponent: MoneyExponent): { debit: bigint; credit: bigint } {
  let debit = 0n, credit = 0n;
  for (const line of lines) {
    if (!isCompleteLine(line)) continue;
    if (line.side === 'Dr') debit = addMoney(debit, minorOf(line.amount, exponent));
    else credit = addMoney(credit, minorOf(line.amount, exponent));
  }
  return { debit, credit };
}

/** What a double-entry voucher is short of: the side that needs more and by how much, or null when it balances. */
export function shortfall(lines: readonly EntryLine[], exponent: MoneyExponent): { side: Side; amount: bigint } | null {
  const { debit, credit } = lineTotals(lines, exponent);
  const sign = compareMoney(debit, credit);
  if (sign === 0) return null;
  return sign > 0 ? { side: 'Cr', amount: subtractMoney(debit, credit) } : { side: 'Dr', amount: subtractMoney(credit, debit) };
}

/** The status line's difference: "Difference 50.00 Dr" names the side that is ahead, as the totals read. */
export function differenceText(lines: readonly EntryLine[], exponent: MoneyExponent): string | null {
  const short = shortfall(lines, exponent);
  return short && `Difference ${amountText(short.amount, exponent)} ${other(short.side)}`;
}

/** The single-entry total: the particulars' amounts. */
export function particularsTotal(lines: readonly EntryLine[], exponent: MoneyExponent): bigint {
  return lines.reduce((sum, line) => line.ledger !== '' && line.amount !== '' ? addMoney(sum, minorOf(line.amount, exponent)) : sum, 0n);
}

// ---- The type and layout switch ----

/** The draft's content as the screen holds it (everything a type switch or a body needs). */
export type EntryDraft = { kind: EntryKind; layout: EntryLayout; account: string; lines: readonly EntryLine[] };
export type Relaid = EntryDraft;

/**
 * The lines in another type's or layout's arrangement. Lines are kept and laid out again, never cleared and never
 * re-checked; the new type's rules apply at accept (observed). No line ever changes side or amount, and no line with
 * bill rows is dropped; where that cannot be kept, the switch is refused and the voucher stays as it is.
 * - Single entry to double entry, the same type (the layout key): the particulars, then the Account's line on the
 *   Account's side with the total, which is the body's order.
 * - Single entry to double entry, another type (observed): the Account first, on the new type's first-line side, with
 *   the total; the particulars keep their sides; a line on the short side follows when it does not balance.
 * - Single to single: the same arrangement when the two types put their Account on one side; otherwise the voucher is
 *   laid out in double entry of the new type, keeping every side.
 * - Double entry to single entry: the Account is the first line on the new type's Account side whose ledger the Account
 *   field offers (`isAccount`: cash or bank); every other line must be on the particulars' side and add up to it.
 * - Double to double: unchanged.
 * - A voucher with nothing entered yet (no Account, every line blank) simply takes the new type's own layout.
 */
export function relayLines(from: EntryDraft & { bills: Readonly<Record<string, readonly unknown[]>> }, to: { kind: EntryKind; layout: EntryLayout }, exponent: MoneyExponent, key: () => string, isAccount: (ledgerId: string) => boolean): Relaid | { refused: string } {
  const kept = from.lines.filter(line => !isBlankLine(line));
  const blank = (side: Side): EntryLine => ({ key: key(), side, ledger: '', amount: '' });
  if (from.account === '' && !kept.length) return { kind: to.kind, layout: to.layout, account: '', lines: [blank(to.layout === 'single' ? particularsSide(to.kind) : firstLineSide(to.kind))] };
  if (from.layout === 'single') {
    const total = particularsTotal(kept, exponent);
    const sided: EntryLine[] = kept.map(line => ({ ...line, side: particularsSide(from.kind) }));
    const accountLine = (side: Side): EntryLine[] => from.account === '' ? [] : [{ key: key(), side, ledger: from.account, amount: total === 0n ? '' : formatMoney(total, exponent) }];
    const sameSides = accountSide(from.kind) === accountSide(to.kind);
    if (to.layout === 'single' && sameSides) return { kind: to.kind, layout: 'single', account: from.account, lines: sided.length ? sided : [blank(particularsSide(to.kind))] };
    // Body order, every side kept: the layout key, and a single-entry switch whose Account would change side.
    const lines = from.kind === to.kind || to.layout === 'single' ? [...sided, ...accountLine(accountSide(from.kind))] : [...accountLine(firstLineSide(to.kind)), ...sided];
    const short = shortfall(lines, exponent);
    if (short || !lines.length) lines.push(blank(short?.side ?? firstLineSide(to.kind)));
    return { kind: to.kind, layout: 'double', account: '', lines };
  }
  if (to.layout === 'double') return { kind: to.kind, layout: 'double', account: '', lines: from.lines.length ? [...from.lines] : [blank(firstLineSide(to.kind))] };
  const incomplete = from.lines.findIndex(line => !isBlankLine(line) && !isCompleteLine(line));
  if (incomplete >= 0) return { refused: `Finish or empty line ${incomplete + 1} first: single entry carries only complete lines.` };
  const side = accountSide(to.kind);
  const account = kept.find(line => line.side === side && isAccount(line.ledger));
  const word = side === 'Dr' ? 'debit' : 'credit';
  if (!account) return { refused: `No ${word} line has a cash or bank ledger to become the Account, so the voucher stays in double entry.` };
  if ((from.bills[account.key] ?? []).length) return { refused: 'The line that would become the Account has bill rows, which the Account cannot carry, so the voucher stays in double entry.' };
  const rest = kept.filter(line => line !== account);
  const extra = rest.findIndex(line => line.side !== particularsSide(to.kind));
  if (extra >= 0) return { refused: `Line ${from.lines.indexOf(rest[extra]) + 1} is a second ${word}: single entry has one Account, so the voucher stays in double entry.` };
  if (minorOf(account.amount, exponent) !== particularsTotal(rest, exponent)) return { refused: 'The lines do not balance, so the Account\'s amount would change: the voucher stays in double entry until they do.' };
  return { kind: to.kind, layout: 'single', account: account.ledger, lines: rest.length ? rest : [blank(particularsSide(to.kind))] };
}

// ---- Ledger lists ----

export type EntryLedger = { id: string; name: string; secondLanguageName: string | null; cashOrBank: boolean };
export type LedgerOption = { value: string; label: string; description?: string };
/** Where a lookup sits: the single-entry Account, or a line (in single entry a particulars line). */
export type LedgerPosition = 'account' | 'line';
/**
 * What a ledger lookup offers: `defaults` while nothing is typed, `all` when typing; `closed` when the two are one set
 * and other text is refused.
 */
export type LedgerLists = { defaults: LedgerOption[]; all: LedgerOption[]; closed: boolean };

const optionOf = (ledger: EntryLedger): LedgerOption => ({ value: ledger.id, label: ledger.name, ...ledger.secondLanguageName ? { description: ledger.secondLanguageName } : {} });

/**
 * The ledgers a lookup offers (docs/VOUCHERS.md, "Lists"; observed), in the master lists' name order:
 * - contra: cash and bank only, everywhere (closed);
 * - the single-entry Account of a payment or receipt: cash and bank (closed);
 * - the side that pays on a double-entry payment (credit) or receipt (debit): every ledger, cash and bank first;
 * - every other line, and the journal: other ledgers when nothing is typed, every ledger when typing (a cash or bank
 *   ledger is found by typing its name).
 */
export function ledgerOptions(kind: EntryKind, layout: EntryLayout, position: LedgerPosition, side: Side | '', ledgers: readonly EntryLedger[]): LedgerLists {
  const sorted = [...ledgers].sort(byName);
  const cash = sorted.filter(ledger => ledger.cashOrBank).map(optionOf);
  const rest = sorted.filter(ledger => !ledger.cashOrBank).map(optionOf);
  if (kind === 'contra' || (layout === 'single' && position === 'account' && kind !== 'journal')) return { defaults: cash, all: cash, closed: true };
  const paysOn = kind === 'payment' ? 'Cr' : kind === 'receipt' ? 'Dr' : null;
  if (layout === 'double' && paysOn !== null && side === paysOn) { const first = [...cash, ...rest]; return { defaults: first, all: first, closed: true }; }
  return { defaults: rest, all: sorted.map(optionOf), closed: false };
}

/** The posting rule's refusal before sending, with the first line of the side that needs cash or bank; undefined when it holds. */
export function cashRuleProblem(kind: EntryKind, lines: readonly { side: Side; ledger: string }[], isCash: (ledgerId: string) => boolean): { message: string; line: number } | undefined {
  if (kind === 'contra') {
    const index = lines.findIndex(line => !isCash(line.ledger));
    return index < 0 ? undefined : { message: `A contra voucher moves money between cash and bank ledgers only; line ${index + 1} uses another ledger.`, line: index };
  }
  if (kind !== 'payment' && kind !== 'receipt') return undefined;
  const pays: Side = kind === 'payment' ? 'Cr' : 'Dr';
  if (lines.some(line => line.side === pays && isCash(line.ledger))) return undefined;
  const index = Math.max(0, lines.findIndex(line => line.side === pays));
  return { message: kind === 'payment' ? 'No cash or bank ledger is credited: a payment must credit at least one.' : 'No cash or bank ledger is debited: a receipt must debit at least one.', line: index };
}

/**
 * The cash-in-hand ledgers (not bank): those under the seeded cash-in-hand group or one of its sub-groups, found by the
 * group's built-in key through the group tree as the server reports it, never by a name. A single-entry Account among
 * them skips the total stop, and a credit taking one below zero warns.
 */
export function cashInHandIds(groups: readonly { id: string; parentId: string | null; systemKey: string | null }[], ledgers: readonly { id: string; groupId: string | null }[]): Set<string> {
  const family = new Set<string>();
  for (const group of groups) if (group.systemKey === 'cash_in_hand') { family.add(group.id); for (const id of descendantIds(groups, group.id)) family.add(id); }
  return new Set(ledgers.filter(ledger => ledger.groupId !== null && family.has(ledger.groupId)).map(ledger => ledger.id));
}
