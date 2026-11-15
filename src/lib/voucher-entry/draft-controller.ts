import { classifyAnswer, startMachine, step, storedDraftsOf, storedOf, type AnswerClass, type DraftEvent, type DraftMachine, type StoredDraft } from './draft-machine.ts';
import type { DraftAction, DraftState } from './enter-path.ts';

/**
 * The voucher on screen with its saves: the state machine of draft-machine.ts plus the requests and the tab's store,
 * which are handed in, so the same code runs in the screen (`useVoucherDraft`) and in the tests against a fake or the
 * real server. It holds the machine synchronously: a key pressed before React renders the last change sees it.
 */

export type SendFailure = { status: number | undefined; code: string | undefined; message: string };
export type SaveResult<T> =
  | { kind: 'saved'; answer: T; key: string }
  | { kind: Exclude<AnswerClass, 'saved'>; message: string; code: string | undefined };
/** Where the drafts kept across a lost session live (the tab's session storage in the screen). */
export type DraftStore = { read: () => string | null; write: (text: string) => void };

export type DraftController<T> = ReturnType<typeof createDraftController<T>>;

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
  now?: () => string;
}) {
  let machine = startMachine(options.makeKey(), options.start, storedDraftsOf(options.store.read()));
  const keep = (drafts: readonly StoredDraft[]) => options.store.write(drafts.length ? JSON.stringify(drafts) : '');

  function apply(event: DraftEvent): boolean {
    const next = step(machine, event);
    if (next === machine) return false;
    const offeredChanged = next.offered !== machine.offered;
    machine = next;
    if (offeredChanged) keep(next.offered);
    options.onChange?.(next);
    return true;
  }

  let inFlight: Promise<SaveResult<T>> | null = null;
  function track(pending: Promise<SaveResult<T>>): Promise<SaveResult<T>> {
    inFlight = pending;
    void pending.finally(() => { if (inFlight === pending) inFlight = null; });
    return pending;
  }

  async function run(body: string): Promise<SaveResult<T>> {
    const key = machine.key;
    try {
      const answer = await options.send(body);
      apply({ type: 'saved', nextKey: options.makeKey() });
      return { kind: 'saved', answer, key };
    } catch (error) {
      const failure = options.failureOf(error);
      const answer = classifyAnswer({ ok: false, status: failure.status, code: failure.code });
      apply({ type: 'answered', answer, message: failure.message });
      if (answer === 'signed-out') {
        // Kept with its key and its state, beside any draft kept earlier and not taken back yet.
        keep([...machine.offered.filter(kept => kept.key !== machine.key), storedOf(machine, options.now?.() ?? new Date().toISOString())]);
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
    restore: (): boolean => apply({ type: 'restore' }),
    drop: (): boolean => apply({ type: 'drop' }),
  };
}
