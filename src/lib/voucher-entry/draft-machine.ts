import { billKinds, sides } from '../ledger.ts';
import type { BillDraft } from './bills.ts';
import { draftDirty, draftReducer, nextDraft, type DraftAction, type DraftState } from './enter-path.ts';
import { isEntryKind, type EntryLine } from './layout.ts';

/**
 * The voucher on screen as one state machine (docs/VOUCHERS.md, "The draft, its key and its lock"): its content, its
 * idempotency key, the state of its save, and the drafts kept in the tab from before a sign-in. Every change goes
 * through `step`, which refuses whatever the state does not allow, so no caller has to check a lock of its own.
 *
 * The key rule: a draft has one key from its creation until a voucher is known saved under it (`saved`) or the user
 * discards the draft (`discard`). A refusal, an edit, an unknown outcome or a restore never changes it. That is safe
 * because the server writes the key only with a committed voucher: a refused body leaves no trace of it, the same body
 * again is a replay, and a different body under a used key is answered 409 (`conflict`), never a second voucher.
 */

export type DraftPhase = 'editing' | 'sending' | 'unknown' | 'conflict';
/** What an answer to a create means (`classifyAnswer`). */
export type AnswerClass = 'saved' | 'refused' | 'conflict' | 'signed-out' | 'limited' | 'none';

/** A draft kept in the tab before a sign-in: the machine's whole state, so a restore gives back exactly that state. */
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
  /** The state a send returns to when its request did not run (a lost session, too many requests). */
  resume: 'editing' | 'unknown' | null;
  /** In `editing` a refusal or a check before sending; in `unknown` and `conflict` what the user is told. */
  message: string | null;
  /** Drafts kept in this tab from before a sign-in, the first one offered. */
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
  /** The user leaves the draft, or starts a new voucher: from `unknown` and `conflict` only after the warning question. */
  | { type: 'discard'; nextKey: string; draft: DraftState }
  | { type: 'restore' }
  | { type: 'drop' };

export function startMachine(key: string, draft: DraftState, offered: readonly StoredDraft[] = []): DraftMachine {
  return { phase: 'editing', key, draft, sent: null, resume: null, message: null, offered };
}

/** Whether the draft can be changed: only while `editing`. Everything the screen locks reads this. */
export const isLocked = (machine: DraftMachine): boolean => machine.phase !== 'editing';
/** A kept draft can be restored or dropped only while the draft on screen is `editing` and empty. */
export const canTakeStored = (machine: DraftMachine): boolean => machine.phase === 'editing' && !draftDirty(machine.draft) && machine.offered.length > 0;
/** The alert that locks the voucher, shown exactly in `unknown` and `conflict`. */
export const lockAlert = (machine: DraftMachine): { phase: 'unknown' | 'conflict'; message: string } | null =>
  machine.phase === 'unknown' || machine.phase === 'conflict' ? { phase: machine.phase, message: machine.message ?? '' } : null;
/** The refusal or check shown while editing ("Not saved"). */
export const refusal = (machine: DraftMachine): string | null => machine.phase === 'editing' ? machine.message : null;

/**
 * The one classification of an answer to a create. A 4xx that carries a ledger code is a definite refusal (the
 * transaction rolled back; for the same body under the same key it also proves no earlier send committed, or the server
 * would have replayed). A 4xx without a code is not the server's answer (a proxy's page): like no answer at all.
 */
export function classifyAnswer(answer: { ok: true }): 'saved';
export function classifyAnswer(answer: { ok: false; status: number | undefined; code: string | undefined }): Exclude<AnswerClass, 'saved'>;
export function classifyAnswer(answer: { ok: true } | { ok: false; status: number | undefined; code: string | undefined }): AnswerClass {
  if (answer.ok) return 'saved';
  const { status, code } = answer;
  if (status === 401) return 'signed-out';
  if (status === 429) return 'limited';
  if (status === 409 && code === 'idempotency_mismatch') return 'conflict';
  if (status !== undefined && status >= 400 && status < 500 && code !== undefined) return 'refused';
  return 'none';
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
    // The only place a key is made, besides discard.
    // A kept draft under the saved key is that voucher: it is no longer offered.
    case 'saved': return machine.phase === 'sending' ? startMachine(event.nextKey, nextDraft(machine.draft), machine.offered.filter(kept => kept.key !== machine.key)) : machine;
    case 'answered': {
      if (machine.phase !== 'sending') return machine;
      switch (event.answer) {
        case 'refused': return { ...machine, phase: 'editing', sent: null, resume: null, message: event.message };
        case 'conflict': return { ...machine, phase: 'conflict', resume: null, message: event.message };
        case 'none': return { ...machine, phase: 'unknown', resume: null, message: event.message };
        // The request did not run: back where the send started. From `unknown` the alert stays.
        case 'signed-out': case 'limited':
          return machine.resume === 'unknown'
            ? { ...machine, phase: 'unknown', resume: null }
            : { ...machine, phase: 'editing', sent: null, resume: null, message: event.message };
      }
    }
    // While a request is in flight nothing is discarded: its answer still has to arrive.
    case 'discard': return machine.phase === 'sending' ? machine : startMachine(event.nextKey, event.draft, machine.offered);
    case 'restore': {
      if (!canTakeStored(machine)) return machine;
      const [kept, ...rest] = machine.offered;
      return { phase: kept.phase, key: kept.key, draft: kept.draft, sent: kept.sent, resume: null, message: kept.message, offered: rest };
    }
    case 'drop': return canTakeStored(machine) ? { ...machine, offered: machine.offered.slice(1) } : machine;
  }
}

/** The draft as kept in the tab when the session is lost (the state the send returned to). */
export function storedOf(machine: DraftMachine, savedAt: string): StoredDraft {
  const phase = machine.phase === 'sending' ? 'unknown' : machine.phase;
  // An editing draft's message is the lost session's own ("sign in"): stale once restored.
  return { phase, key: machine.key, draft: machine.draft, sent: machine.sent, message: phase === 'editing' ? null : machine.message, savedAt };
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
