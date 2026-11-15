import { billKinds, sides } from '../ledger.ts';
import type { BillDraft } from './bills.ts';
import { draftDirty, draftReducer, nextDraft, type DraftAction, type DraftState } from './enter-path.ts';
import { isEntryKind, type EntryLine } from './layout.ts';

/**
 * The voucher on screen as one state machine (docs/VOUCHERS.md, "The draft, its key and its lock"): its content, its
 * idempotency key, the state of its save, and the drafts kept in the tab. Every change goes
 * through `step`, which refuses whatever the state does not allow, so no caller has to check a lock of its own.
 *
 * The key rule: a draft has one key from its creation until a voucher is known saved under it (`saved`) or the user
 * discards the draft (`discard`). A refusal, an edit, an unknown outcome or a restore never changes it. That is safe
 * because the server writes the key only with a committed voucher: a refused body leaves no trace of it, the same body
 * again is a replay, and a different body under a used key is answered 409 (`conflict`), never a second voucher.
 */

export type DraftPhase = 'editing' | 'sending' | 'unknown' | 'conflict';
/** What an answer to a create means (`classifyAnswer`). */
export type AnswerClass = 'saved' | 'refused' | 'denied' | 'conflict' | 'signed-out' | 'limited' | 'none';
/** The answers whose request never reached the replay, so they say nothing about an earlier send under the key. */
const beforeTheReplay: readonly AnswerClass[] = ['signed-out', 'limited', 'denied'];

/**
 * A draft kept in the tab: the machine's whole state, so a restore gives back exactly that state. A draft whose state
 * is `sending`, `unknown` or `conflict` is kept from the moment it enters that state; an `editing` one only on a lost
 * session.
 */
export type StoredDraft = {
  phase: 'editing' | 'unknown' | 'conflict';
  key: string; draft: DraftState; sent: string | null; message: string | null; savedAt: string;
};

export type DraftMachine = {
  phase: DraftPhase;
  key: string;
  draft: DraftState;
  /** The exact body sent, while sending and in `unknown` and `conflict`: "Check and retry" sends it again unchanged. */
  sent: string | null;
  /** The state a send returns to when its request did not reach the replay (a lost session, a limit, a denial). */
  resume: 'editing' | 'unknown' | null;
  /** In `editing` a refusal or a check before sending; in `unknown` and `conflict` what the user is told. */
  message: string | null;
  /** In `unknown`, the latest retry's answer when it said nothing about the first send (a limit, a denial). */
  note: string | null;
  /** Drafts kept in this tab, the first one offered. */
  offered: readonly StoredDraft[];
};

export type DraftEvent =
  | { type: 'edit'; action: DraftAction }
  /** A check before sending found something to correct (shown like a refusal; the draft stays editable). */
  | { type: 'problem'; message: string }
  | { type: 'accept'; body: string }
  /** "Check and retry": the same body under the same key. */
  | { type: 'retry' }
  | { type: 'saved'; nextKey: string }
  | { type: 'answered'; answer: Exclude<AnswerClass, 'saved'>; message: string }
  /** The user discards the draft ("Start a new voucher"): from `unknown` and `conflict` only after the warning question. */
  | { type: 'discard'; nextKey: string; draft: DraftState }
  | { type: 'restore' }
  | { type: 'drop' };

export function startMachine(key: string, draft: DraftState, offered: readonly StoredDraft[] = []): DraftMachine {
  return { phase: 'editing', key, draft, sent: null, resume: null, message: null, note: null, offered };
}

/** Whether the draft can be changed: only while `editing`. Everything the screen locks reads this. */
export const isLocked = (machine: DraftMachine): boolean => machine.phase !== 'editing';
/** A kept draft can be restored or dropped only while the draft on screen is `editing` and empty. */
export const canTakeStored = (machine: DraftMachine): boolean => machine.phase === 'editing' && !draftDirty(machine.draft) && machine.offered.length > 0;
/** The alert that locks the voucher, shown exactly in `unknown` and `conflict`. */
export const lockAlert = (machine: DraftMachine): { phase: 'unknown' | 'conflict'; message: string; note: string | null } | null =>
  machine.phase === 'unknown' || machine.phase === 'conflict' ? { phase: machine.phase, message: machine.message ?? '', note: machine.note } : null;
/** The refusal or check shown while editing ("Not saved"). */
export const refusal = (machine: DraftMachine): string | null => machine.phase === 'editing' ? machine.message : null;

/** An answer as the controller hands it over: its status, the server's code and whether it was the application's own JSON. */
export type FailedAnswer = { ok: false; status: number | undefined; code: string | undefined; json: boolean };

/**
 * The one classification of an answer to a create (the full table is in docs/VOUCHERS.md):
 * - 2xx saved; 401 signed out; 429 limited; 409 `idempotency_mismatch` conflict (a voucher exists under the key).
 * - 403 and 404 from the application (origin, role, membership, a route) denied: those checks run before the replay, so
 *   they say nothing about an earlier send; from `editing` they read as a refusal, from `unknown` it stays unknown.
 * - Any other 4xx from the application, coded or not, refused: the request ran and rolled back, and for the same body
 *   under the same key it also proves no earlier send committed (the server would have replayed).
 * - A 5xx, a 4xx that is not the application's JSON (a proxy's page), an unreadable answer or none at all: none.
 */
export function classifyAnswer(answer: { ok: true }): 'saved';
export function classifyAnswer(answer: FailedAnswer): Exclude<AnswerClass, 'saved'>;
export function classifyAnswer(answer: { ok: true } | FailedAnswer): AnswerClass {
  if (answer.ok) return 'saved';
  const { status, code, json } = answer;
  if (status === undefined || status < 400 || status >= 500) return 'none';
  if (status === 401) return 'signed-out';
  if (status === 429) return 'limited';
  if (!json) return 'none';
  if (status === 409 && code === 'idempotency_mismatch') return 'conflict';
  if (status === 403 || status === 404) return 'denied';
  return 'refused';
}

export function step(machine: DraftMachine, event: DraftEvent): DraftMachine {
  switch (event.type) {
    case 'edit': {
      if (machine.phase !== 'editing') return machine;
      const draft = draftReducer(machine.draft, event.action);
      return draft === machine.draft ? machine : { ...machine, draft, message: null };
    }
    case 'problem': return machine.phase === 'editing' ? { ...machine, message: event.message } : machine;
    case 'accept': return machine.phase === 'editing' ? { ...machine, phase: 'sending', sent: event.body, resume: 'editing', message: null } : machine;
    case 'retry': return machine.phase === 'unknown' && machine.sent !== null ? { ...machine, phase: 'sending', resume: 'unknown' } : machine;
    // The only place a key is made, besides discard. A kept draft under the saved key is that voucher: no longer offered.
    case 'saved': return machine.phase === 'sending' ? startMachine(event.nextKey, nextDraft(machine.draft), machine.offered.filter(kept => kept.key !== machine.key)) : machine;
    case 'answered': {
      if (machine.phase !== 'sending') return machine;
      const { answer, message } = event;
      // The request did not reach the replay: from `unknown` it stays unknown, with that answer as a note; from
      // `editing` the draft is editable again with the answer shown.
      if (beforeTheReplay.includes(answer)) {
        return machine.resume === 'unknown'
          ? { ...machine, phase: 'unknown', resume: null, note: message }
          : { ...machine, phase: 'editing', sent: null, resume: null, message, note: null };
      }
      if (answer === 'refused') return { ...machine, phase: 'editing', sent: null, resume: null, message, note: null };
      if (answer === 'conflict') return { ...machine, phase: 'conflict', resume: null, message, note: null };
      return { ...machine, phase: 'unknown', resume: null, message, note: null };
    }
    // While a request is in flight nothing is discarded: its answer still has to arrive.
    case 'discard': return machine.phase === 'sending' ? machine : startMachine(event.nextKey, event.draft, machine.offered);
    case 'restore': {
      if (!canTakeStored(machine)) return machine;
      const [kept, ...rest] = machine.offered;
      return { phase: kept.phase, key: kept.key, draft: kept.draft, sent: kept.sent, resume: null, message: kept.message, note: null, offered: rest };
    }
    case 'drop': return canTakeStored(machine) ? { ...machine, offered: machine.offered.slice(1) } : machine;
  }
}

/** What a draft kept while its request was in flight is told: its answer never reached this tab. */
export const answerNeverArrived = 'Its answer never reached this tab: the page was left, reloaded or closed while it was being saved.';

/**
 * The draft as kept in the tab. A `sending` draft is kept as `unknown`: whatever its answer was, it never arrived here,
 * so all that can be proved is that a voucher may be saved under its key.
 */
export function storedOf(machine: DraftMachine, savedAt: string): StoredDraft {
  const phase = machine.phase === 'sending' ? 'unknown' : machine.phase;
  // An editing draft's message is the lost session's own ("sign in"): stale once restored.
  const message = machine.phase === 'sending' ? answerNeverArrived : phase === 'editing' ? null : machine.message;
  return { phase, key: machine.key, draft: machine.draft, sent: machine.sent, message, savedAt };
}

// ---- Reading the kept drafts back: everything is checked, nothing is taken on trust ----

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isSide = (value: unknown): value is EntryLine['side'] => value === '' || sides.some(side => side === value);
const isLine = (value: unknown): value is EntryLine =>
  isRecord(value) && isString(value.key) && isSide(value.side) && isString(value.ledger) && isString(value.amount);
const isBill = (value: unknown): value is BillDraft =>
  isRecord(value) && isString(value.key) && (value.method === '' || billKinds.some(kind => kind === value.method)) && isString(value.bill)
  && isString(value.name) && isString(value.credit) && isString(value.amount) && isSide(value.side);

function draftOf(value: unknown): DraftState | null {
  if (!isRecord(value)) return null;
  const { kind, layout, date, account, narration, bills, lines, serial } = value;
  if (!isEntryKind(kind) || (layout !== 'single' && layout !== 'double') || !isString(date) || !isString(account) || !isString(narration)) return null;
  if (typeof serial !== 'number' || !Number.isSafeInteger(serial) || !Array.isArray(lines) || !lines.every(isLine) || !isRecord(bills)) return null;
  const billRows: Record<string, readonly BillDraft[]> = {};
  for (const [row, rows] of Object.entries(bills)) {
    if (!Array.isArray(rows) || !rows.every(isBill)) return null;
    billRows[row] = rows;
  }
  if (layout === 'single' && kind === 'journal') return null;
  return { kind, layout, date, account, narration, bills: billRows, lines, serial };
}

function storedDraftOf(value: unknown): StoredDraft | null {
  if (!isRecord(value)) return null;
  const { phase, key, sent, message, savedAt } = value;
  if ((phase !== 'editing' && phase !== 'unknown' && phase !== 'conflict') || !isString(key) || key === '' || !isString(savedAt)) return null;
  if (!(sent === null || isString(sent)) || !(message === null || isString(message))) return null;
  // A draft whose save got no definite answer must keep the exact body: "Check and retry" sends it again.
  if (phase !== 'editing' && sent === null) return null;
  const draft = draftOf(value.draft);
  return draft ? { phase, key, draft, sent, message, savedAt } : null;
}

/** The drafts kept in this tab, or none when the text is not a list of them (another version, or damaged). */
export function storedDraftsOf(text: string | null): StoredDraft[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(entry => { const kept = storedDraftOf(entry); return kept ? [kept] : []; });
  } catch { return []; }
}
