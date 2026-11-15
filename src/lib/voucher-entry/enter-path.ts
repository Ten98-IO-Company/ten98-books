import { formatMoney, type MoneyExponent } from '@ten98/runtime/browser';
import type { BillDraft } from './bills.ts';
import { firstLineSide, isBlankLine, isCompleteLine, particularsSide, shortfall, type EntryDraft, type EntryKind, type EntryLayout, type EntryLine, type Relaid } from './layout.ts';

/** Where Enter, Escape and the other keys take the cursor, and the draft's state (docs/VOUCHERS.md, "The Enter path"). */

/** Where focus goes: a header field, the total or narration stop, or a grid cell. */
export type EntryFocus =
  | { field: 'date' | 'account' | 'total' | 'narration' }
  | { cell: { row: string; column: 'side' | 'ledger' | 'amount'; open?: boolean; edit?: boolean } };

/**
 * What Enter does at the end of the list (the grid's `onEnd`, on its last row), or null to let the grid go on (append
 * the next line or move to the next cell):
 * - On a blank line's ledger cell: the list ends. Single entry goes to Total when the Account is not cash in hand and
 *   straight to Narration with a cash Account (observed); double entry goes to Narration.
 * - Double entry, on a complete last line, balanced: straight to Narration, with no new line (observed).
 */
export function listEnd(input: { layout: EntryLayout; lines: readonly EntryLine[]; row: string; column: string; accountIsCash: boolean; exponent: MoneyExponent }): EntryFocus | null {
  const line = input.lines.find(entry => entry.key === input.row);
  if (!line) return null;
  if (input.column === 'ledger' && isBlankLine(line)) {
    if (input.layout === 'double') return { field: 'narration' };
    return { field: input.accountIsCash ? 'narration' : 'total' };
  }
  if (input.layout === 'double' && input.column === 'amount' && isCompleteLine(line)) {
    const complete = input.lines.filter(isCompleteLine);
    if (complete.length >= 2 && shortfall(input.lines, input.exponent) === null) return { field: 'narration' };
  }
  return null;
}

/**
 * The next line Enter appends after a complete last line (the grid's `createRow`). Single entry: a blank particulars
 * line. Double entry: a line on the short side (observed; two of the four readings of the notes say so, the coordinator
 * keeps it pending another observation) with the counter ledger from history (or empty), and the difference as its
 * amount once a ledger is there; a balanced voucher never gets here (`listEnd`).
 */
export function appendedLine(input: { kind: EntryKind; layout: EntryLayout; lines: readonly EntryLine[]; counter: string | null; exponent: MoneyExponent; key: string }): EntryLine {
  if (input.layout === 'single') return { key: input.key, side: particularsSide(input.kind), ledger: '', amount: '' };
  const short = shortfall(input.lines, input.exponent);
  const last = input.lines[input.lines.length - 1]?.side || firstLineSide(input.kind);
  const side = short?.side ?? (last === 'Dr' ? 'Cr' : 'Dr');
  const ledger = input.counter ?? '';
  return { key: input.key, side, ledger, amount: ledger !== '' && short ? formatMoney(short.amount, input.exponent) : '' };
}

/** The difference a new double-entry line proposes once its ledger is chosen (observed), or '' when nothing is short. */
export function proposedAmount(lines: readonly EntryLine[], row: string, exponent: MoneyExponent): string {
  const line = lines.find(entry => entry.key === row);
  if (!line || line.amount !== '' || line.ledger === '' || line.side === '') return '';
  const short = shortfall(lines.filter(entry => entry.key !== row), exponent);
  return short && short.side === line.side ? formatMoney(short.amount, exponent) : '';
}

/** "No" at the accept prompt: back to the first field of the layout with its list open, everything kept (observed). */
export function afterDeclinedAccept(layout: EntryLayout, lines: readonly EntryLine[]): EntryFocus {
  if (layout === 'single') return { field: 'account' };
  return lines.length ? { cell: { row: lines[0].key, column: 'ledger', open: true } } : { field: 'date' };
}

/** Where the date key's field returns: the field or cell it was opened from, editing, so typing goes on there; a ledger cell reopens its list (observed). */
export type FocusOrigin = { field: 'date' | 'account' | 'total' | 'narration' } | { cell: { row: string; column: 'side' | 'ledger' | 'amount' } };
export function afterDate(origin: FocusOrigin): EntryFocus {
  if ('field' in origin) return origin;
  return { cell: { ...origin.cell, ...origin.cell.column === 'ledger' ? { open: true } : { edit: true } } };
}

/**
 * Escape on a focused field or cell that is not editing (the grid hands it over): the first press empties a value,
 * prefilled ones included; with nothing to empty it asks to quit when anything was entered, else it leaves (observed).
 */
export const escapeStep = (value: string, dirty: boolean): 'clear' | 'ask' | 'leave' => value !== '' ? 'clear' : dirty ? 'ask' : 'leave';

// ---- The draft ----

export type DraftState = EntryDraft & {
  date: string; narration: string; bills: Readonly<Record<string, readonly BillDraft[]>>;
  /** The next line key's number, so keys never repeat inside one voucher. */
  serial: number;
};

export type DraftAction =
  | { type: 'date'; date: string }
  | { type: 'account'; ledger: string }
  | { type: 'lines'; lines: readonly EntryLine[] }
  | { type: 'narration'; text: string }
  | { type: 'bills'; row: string; rows: readonly BillDraft[] }
  /** A type or layout switch that `relayLines` allowed. */
  | { type: 'relaid'; relaid: Relaid }
  | { type: 'next' }
  /** The draft kept in the tab before a sign-in, taken back as it was. */
  | { type: 'restore'; state: DraftState };

export const lineKey = (serial: number): string => `line-${serial}`;
const serialOf = (lines: readonly EntryLine[], serial: number) => lines.reduce((top, line) => Math.max(top, Number(/^line-(\d+)$/.exec(line.key)?.[1] ?? 0) + 1), serial);
/** Bill rows of the lines that are still there. */
const billsOf = (bills: DraftState['bills'], lines: readonly EntryLine[]) => { const keys = new Set(lines.map(line => line.key)); return Object.fromEntries(Object.entries(bills).filter(([key]) => keys.has(key))); };

/** A blank voucher of a type and layout on a date: one empty line. */
export function blankDraft(kind: EntryKind, layout: EntryLayout, date: string, serial = 1): DraftState {
  const side = layout === 'single' ? particularsSide(kind) : firstLineSide(kind);
  return { kind, layout, date, account: '', narration: '', bills: {}, lines: [{ key: lineKey(serial), side, ledger: '', amount: '' }], serial: serial + 1 };
}

/** Whether anything was entered: a leave or quit then asks first. */
export const draftDirty = (state: DraftState): boolean =>
  state.account !== '' || state.narration.trim() !== '' || state.lines.some(line => !isBlankLine(line));

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case 'date': return { ...state, date: action.date };
    case 'account': return { ...state, account: action.ledger };
    case 'narration': return { ...state, narration: action.text };
    case 'lines': return { ...state, lines: action.lines, bills: billsOf(state.bills, action.lines), serial: serialOf(action.lines, state.serial) };
    case 'bills': return { ...state, bills: { ...state.bills, [action.row]: action.rows } };
    case 'relaid': return { ...state, ...action.relaid, bills: billsOf(state.bills, action.relaid.lines), serial: serialOf(action.relaid.lines, state.serial) };
    // After a save: same type, layout and date; everything else empty (optional and post-dated are never carried).
    case 'next': return blankDraft(state.kind, state.layout, state.date, state.serial);
    case 'restore': return action.state;
  }
}
