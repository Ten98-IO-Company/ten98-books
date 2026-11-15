import { classifyAnswer, startMachine, step, storedDraftsOf, storedOf, type AnswerClass, type DraftEvent, type DraftMachine, type StoredDraft } from './draft-machine.ts';
import type { DraftAction, DraftState } from './enter-path.ts';

/**
 * The voucher on screen with its saves: the state machine of draft-machine.ts plus the requests and the tab's store,
 * which are handed in, so the same code runs in the screen (`useVoucherDraft`) and in the tests against a fake or the
 * real server. It holds the machine synchronously: a key pressed before React renders the last change sees it.
 *
 * The tab's kept list holds the on-screen draft whenever its state is `sending`, `unknown` or `conflict`, written the
 * moment it enters that state; it is taken out on a save, on a discard, when the draft is refused or editable again, and
 * when it is restored as editable. A lost session keeps an `editing` draft too. Leaving or reloading the tab therefore
 * never forgets a voucher that may be in the books. Writes are by key against what the store holds now. A screen no
 * longer shown (`onScreen(false)`) never takes an entry out (a newer screen in the same tab may have restored it, and
 * its user was told it is kept): it rewrites its own entry with what it learned instead, a `saved` notice ("saved as
 * No. N", only dismissed) or, refused, the editable draft with the refusal.
 */

export type SendFailure = { status: number | undefined; code: string | undefined; message: string; json: boolean };
export type SaveResult<T> =
  | { kind: 'saved'; answer: T; key: string }
  | { kind: Exclude<AnswerClass, 'saved'>; message: string; code: string | undefined };
/** Where the drafts kept across a lost session live (the tab's session storage in the screen). */
export type DraftStore = { read: () => string | null; write: (text: string) => void };

export type DraftController<T> = ReturnType<typeof createDraftController<T>>;

const locked = (machine: DraftMachine) => machine.phase !== 'editing';

export function createDraftController<T>(options: {
  start: DraftState;
  makeKey: () => string;
  store: DraftStore;
  /** Posts the body (which carries the key); resolves with the answer or throws. */
  send: (body: string) => Promise<T>;
  failureOf: (error: unknown) => SendFailure;
  onChange?: (machine: DraftMachine) => void;
  /** The session is gone: the draft is kept in the store by now. */
  onSignedOut?: () => void;
  /** What a saved voucher is called in a notice a screen no longer shown leaves in the tab ("Saved as No. 12 ..."). */
  savedAs?: (answer: T) => string;
  now?: () => string;
}) {
  let machine = startMachine(options.makeKey(), options.start, storedDraftsOf(options.store.read()));
  const now = () => options.now?.() ?? new Date().toISOString();
  /** When the on-screen draft entered its locked state, so rewriting it does not change the time it shows. */
  let lockedSince = now();

  let shown = true;
  /** Puts `kept` in the store in place of any draft under its key (or only removes that key). */
  function keep(key: string, kept: StoredDraft | null) {
    const now = storedDraftsOf(options.store.read());
    // A notice that the voucher was saved is never turned back into "may be saved" by another screen's stale state.
    if (kept && kept.phase !== 'saved' && now.some(entry => entry.key === key && entry.phase === 'saved')) return;
    const others = now.filter(entry => entry.key !== key);
    const next = kept ? [...others, kept] : others;
    options.store.write(next.length ? JSON.stringify(next) : '');
  }

  function apply(event: DraftEvent): boolean {
    const before = machine;
    const next = step(before, event);
    if (next === before) return false;
    machine = next;
    if (locked(next) && !locked(before)) lockedSince = now();
    if (event.type === 'restore' || event.type === 'drop') {
      const taken = before.offered[0];
      // A draft restored locked stays kept (below); one restored editable, or dropped, is taken out.
      if (taken && !(event.type === 'restore' && locked(next))) keep(taken.key, null);
    }
    if (locked(next)) keep(next.key, storedOf(next, lockedSince));
    // Out of a locked state: saved (a new draft and key), discarded, refused, or editable again. A screen no longer shown
    // takes nothing out: refused or editable again, it keeps the draft with the answer (a save writes its notice in run).
    else if (locked(before)) {
      if (shown) keep(before.key, null);
      else if (event.type !== 'saved') keep(before.key, { ...storedOf(next, now()), message: next.message });
    }
    options.onChange?.(next);
    return true;
  }

  /** Takes the kept drafts as the tab holds them now: a screen no longer shown may have rewritten one with its answer. */
  function refreshOffered() {
    const fresh = storedDraftsOf(options.store.read()).filter(entry => entry.key !== machine.key);
    if (JSON.stringify(fresh) !== JSON.stringify(machine.offered)) apply({ type: 'offer', offered: fresh });
  }

  let inFlight: Promise<SaveResult<T>> | null = null;
  function track(pending: Promise<SaveResult<T>>): Promise<SaveResult<T>> {
    inFlight = pending;
    void pending.finally(() => { if (inFlight === pending) inFlight = null; });
    return pending;
  }

  async function run(body: string): Promise<SaveResult<T>> {
    const key = machine.key;
    const draft = machine.draft;
    try {
      const answer = await options.send(body);
      apply({ type: 'saved', nextKey: options.makeKey() });
      // Its own entry, rewritten by a screen no longer shown: the voucher is saved, so nothing is to be retried.
      if (!shown) keep(key, { phase: 'saved', key, draft, sent: null, message: options.savedAs?.(answer) ?? 'Saved.', savedAt: now() });
      return { kind: 'saved', answer, key };
    } catch (error) {
      const failure = options.failureOf(error);
      const answer = classifyAnswer({ ok: false, status: failure.status, code: failure.code, json: failure.json });
      apply({ type: 'answered', answer, message: failure.message });
      if (answer === 'signed-out') {
        // Kept with its key and its state; an editable one too, since the screen leaves for signing in.
        keep(machine.key, storedOf(machine, now()));
        options.onSignedOut?.();
      }
      return { kind: answer, message: failure.message, code: failure.code };
    }
  }

  return {
    machine: (): DraftMachine => machine,
    /** A change to the draft; false when the machine refuses it (anything but `editing`). */
    edit: (action: DraftAction): boolean => apply({ type: 'edit', action }),
    problem: (message: string): boolean => apply({ type: 'problem', message }),
    /** Sends the body; null when it is refused (a save already running, or the draft locked). */
    save: (body: string): Promise<SaveResult<T>> | null => apply({ type: 'accept', body }) ? track(run(body)) : null,
    /** "Check and retry": the body sent before, under the same key; null unless the outcome is unknown. */
    retry: (): Promise<SaveResult<T>> | null => {
      const sent = machine.sent;
      return sent !== null && apply({ type: 'retry' }) ? track(run(sent)) : null;
    },
    /** Resolves once the request in flight, if any, has its answer (a question asked meanwhile then sees the outcome). */
    settled: async (): Promise<void> => { await inFlight; },
    discard: (draft: DraftState): boolean => apply({ type: 'discard', nextKey: options.makeKey(), draft }),
    restore: (): boolean => { refreshOffered(); return apply({ type: 'restore' }); },
    drop: (): boolean => { refreshOffered(); return apply({ type: 'drop' }); },
    /** Whether the screen is shown: one that is not (left, unmounted) still keeps its draft but takes none out. */
    onScreen: (value: boolean): void => { shown = value; },
  };
}
