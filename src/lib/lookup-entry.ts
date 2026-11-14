import { resolveLookup, type Choice } from './masters.ts';

/**
 * The decisions a lookup field makes about typed text, kept pure so they can be tested. The components only apply them
 * (src/components/masters/useEntryLookups.ts, LookupField.tsx).
 */

/** What typed text means for a lookup: an error to show, the value already held, or another choice to take. */
export type TypedOutcome = { kind: 'error'; message: string } | { kind: 'keep' } | { kind: 'pick'; value: string };

/** `blank` is what an emptied field says. The text names at most one enabled choice, never free text (`resolveLookup`). */
export function typedOutcome(options: readonly Choice[], text: string, current: string, blank: string): TypedOutcome {
  const result = resolveLookup(options, text, current);
  if ('error' in result) return { kind: 'error', message: result.error };
  if (result.value === '') return { kind: 'error', message: blank };
  return result.value === current ? { kind: 'keep' } : { kind: 'pick', value: result.value };
}

/**
 * Whether Enter (`move`) carries the cursor to the next field after typed text: it does for a new pick and for text that
 * names the value already held (otherwise Enter would have to be pressed twice), never after an error, and never for
 * the accept chord, which saves instead.
 */
export const typedOutcomeMoves = (outcome: TypedOutcome, move: boolean): boolean => move && outcome.kind !== 'error';

/** The Yes/No choices of every form that asks one. */
export const yesNo: readonly Choice[] = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
