import { singleFlight } from '../masters.ts';

/** What a save's answer means for the voucher on screen (docs/VOUCHERS.md, "Escape, leaving and failures"). */

/**
 * A save's outcome from its answer: no answer, a server error (5xx) or a gateway's (502 to 504, which are 5xx too) is
 * UNKNOWN, since the voucher may be in the books; a 4xx is a definite refusal; a 401 is a lost session.
 */
export function saveOutcome(status: number | undefined): 'unknown' | 'refused' | 'signed-out' {
  if (status === 401) return 'signed-out';
  if (status === undefined || status === 0 || status >= 500) return 'unknown';
  return 'refused';
}

/** The voucher's idempotency key and the body a definite refusal last answered, if any. */
export type KeyState = { key: string; refusedBody: string | null };

/**
 * The key a send uses. One draft content has one key from its first send until a definite answer for that content: an
 * unknown outcome never renews it (a resend is the same save, which the server replays or creates). Only a body that
 * differs from the one last definitely refused gets a new key, and that new key then belongs to the new body, so the
 * refusal is forgotten.
 */
export function keyForSend(state: KeyState, body: string, makeKey: () => string): KeyState {
  return state.refusedBody !== null && state.refusedBody !== body ? { key: makeKey(), refusedBody: null } : state;
}

export type SaveAttempt<T> =
  | { outcome: 'saved'; answer: T }
  | { outcome: 'refused' | 'unknown' | 'signed-out'; status: number | undefined; error: unknown; key: string };

/**
 * One voucher's saves: one at a time (a second call while one runs is dropped and changes nothing), each under the key
 * `keyForSend` gives, inside the flight. After a save the next voucher gets a new key; after a definite refusal the
 * refused body is remembered; after an unknown outcome nothing changes, so "Check and retry" sends the same key.
 */
export function createSaver<T>(makeKey: () => string, statusOf: (error: unknown) => number | undefined) {
  let state: KeyState = { key: makeKey(), refusedBody: null };
  const flight = singleFlight();
  return {
    key: (): string => state.key,
    /** Takes a key kept from before a sign-in (the restored draft): a resend after a committed save is a replay. */
    useKey: (key: string): void => { state = { key, refusedBody: null }; },
    /** `body` is the draft's content without its key; `send` posts it under the key it is given. Undefined: dropped (one runs). */
    save: (body: string, send: (key: string) => Promise<T>): Promise<SaveAttempt<T> | undefined> => flight(async (): Promise<SaveAttempt<T>> => {
      state = keyForSend(state, body, makeKey);
      const key = state.key;
      try {
        const answer = await send(key);
        state = { key: makeKey(), refusedBody: null };
        return { outcome: 'saved', answer };
      } catch (error) {
        const status = statusOf(error);
        const outcome = saveOutcome(status);
        if (outcome === 'refused') state = { key, refusedBody: body };
        return { outcome, status, error, key };
      }
    }),
  };
}
