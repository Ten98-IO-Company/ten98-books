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

/**
 * The idempotency key a save sends. The same key while the outcome is unknown (a resend is a replay or the first
 * create); after a definite refusal, a new key once the body has changed, since the refused body was never stored and
 * the server would refuse a different body under the same key; otherwise the key the voucher has.
 */
export function keyForSave(current: { key: string; refusedBody: string | null }, body: string, makeKey: () => string): string {
  return current.refusedBody !== null && current.refusedBody !== body ? makeKey() : current.key;
}
