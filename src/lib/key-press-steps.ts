/**
 * The order of a key press that changes a form and then moves on, so that text typed straight after the key goes to
 * where the key leads (docs/KEYBOARD.md, "entry screens"): the change is committed to the page at once (`commit`, which
 * is React's `flushSync` in the app), and the next step runs after it, before the key handler returns. Nothing waits for
 * a timer or the next render, so a key the keyboard has already queued cannot reach the field that was just answered.
 * Pure: the steps are passed in, so the order is testable without a page.
 */
export function inOnePress({ commit, change, then }: {
  /** Applies `work` and commits what it changed to the page before returning. */
  commit: (work: () => void) => void
  /** The change the key makes (a lookup settled from typed text, a list row picked). */
  change: () => void
  /** What follows once the change is on the page (focus the next field, accept the screen); skipped when undefined. */
  then?: () => void
}): void {
  commit(change)
  then?.()
}
