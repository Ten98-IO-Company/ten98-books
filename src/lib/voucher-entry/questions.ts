import type { DraftMachine, StoredDraft } from './draft-machine.ts';
import { draftDirty, type DraftState } from './enter-path.ts';
import { kindTitles } from './layout.ts';

/**
 * The voucher entry screen's questions and the actions they guard (docs/VOUCHERS.md, "The draft, its key and its
 * lock"): each one decides whether to ask from the machine's state, so leaving, starting a new voucher and discarding a
 * kept draft never lose work without asking, and never say something the state cannot prove.
 */

export type Question = { title: string; description: string; confirmLabel: string; cancelLabel: string };
export type Ask = (question: Question) => Promise<boolean>;

const keptHere = 'It is kept in this tab under its key: when you come back to voucher entry it is offered again with Check and retry, which saves it once or finds it already saved.';

/** The question before the voucher on screen is left or discarded, or null when nothing would be lost. */
export function leaveQuestion(machine: DraftMachine, typing: boolean, verb: 'Leave' | 'Discard'): Question | null {
  const kind = kindTitles[machine.draft.kind].toLowerCase();
  const stay = { confirmLabel: verb, cancelLabel: 'Stay' };
  switch (machine.phase) {
    case 'editing':
      return draftDirty(machine.draft) || typing ? { title: `${verb} this ${kind} unsaved?`, description: 'What you entered in this voucher is not saved.', confirmLabel: verb, cancelLabel: 'Keep entering' } : null;
    case 'sending':
      return { title: `${verb} this ${kind} while it is being saved?`, description: `Its save has not been answered yet, so it may already be in the books. ${keptHere}`, ...stay };
    case 'unknown':
      return verb === 'Leave'
        ? { title: `Leave this ${kind}? It may already be saved`, description: `No definite answer came for its save, so it may be in the books. ${keptHere}`, ...stay }
        : { title: `Discard this ${kind}? It may already be saved`, description: 'No definite answer came for its save, so it may be in the books. Discarding it forgets its key: entering it again could save it twice.', ...stay };
    case 'conflict':
      return verb === 'Leave'
        ? { title: `Leave this ${kind}? It was not saved`, description: 'Its key is already used by a voucher in the books with other content. It is kept in this tab and offered again when you come back.', ...stay }
        : { title: `Discard this ${kind}? It was not saved`, description: 'Its key is already used by a voucher in the books with other content. Discarding it keeps nothing; a new voucher gets a new key.', ...stay };
  }
}

/** The question before a kept draft is discarded from the banner, or null when it holds nothing. */
export function dropQuestion(kept: StoredDraft): Question | null {
  const kind = kindTitles[kept.draft.kind].toLowerCase();
  const labels = { confirmLabel: 'Discard', cancelLabel: 'Keep it' };
  if (kept.phase === 'unknown') return { title: `Discard the kept ${kind}? It may already be saved`, description: 'Its save got no definite answer, so it may be in the books. Discarding it forgets its key: entering it again could save it twice. Restore it and check and retry instead, or look in the day book.', ...labels };
  if (kept.phase === 'conflict') return { title: `Discard the kept ${kind}?`, description: 'It was not saved: its key is already used by a voucher in the books with other content. What was entered in it is lost.', ...labels };
  return draftDirty(kept.draft) ? { title: `Discard the kept ${kind}?`, description: 'It was not saved, and what was entered in it is lost.', ...labels } : null;
}

/**
 * Asks before leaving, by the state the draft is in. While its request is in flight the question stays open only until
 * the answer arrives: then it is asked again for the new state (a newer question replaces the open one), or not at all
 * when nothing is left to lose (a saved voucher). It never asks about a state that is about to change.
 */
export async function askBeforeLeaving(current: () => DraftMachine, settled: () => Promise<void>, typing: () => boolean, ask: Ask): Promise<boolean> {
  for (;;) {
    const machine = current();
    const question = leaveQuestion(machine, typing(), 'Leave');
    if (!question) return true;
    if (machine.phase !== 'sending') return ask(question);
    const answered = await Promise.race([ask(question).then(yes => ({ yes })), settled().then(() => null)]);
    if (answered) return answered.yes;
    // Settled without a new state (it cannot, the answer moves it): ask once more and take that answer.
    if (current() === machine) return ask(question);
  }
}

/** "Start a new voucher": discards the draft on screen after the question (a new key), or keeps it. */
export async function startNewVoucher(current: () => DraftMachine, ask: Ask, discard: (draft: DraftState) => boolean, blank: DraftState): Promise<boolean> {
  const question = leaveQuestion(current(), false, 'Discard');
  if (question && !(await ask(question))) return false;
  return discard(blank);
}

/** "Discard it" on the banner: drops the first kept draft after the question when it holds anything. */
export async function dropKeptDraft(current: () => DraftMachine, ask: Ask, drop: () => boolean): Promise<boolean> {
  const kept = current().offered[0];
  if (!kept) return false;
  const question = dropQuestion(kept);
  if (question && !(await ask(question))) return false;
  return drop();
}
