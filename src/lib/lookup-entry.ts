import type { Choice } from './masters.ts';
import { nameMatchKey } from './names.ts';

/**
 * The decisions a lookup field makes about typed text, kept pure so they can be tested. The components only apply them
 * (src/components/masters/useEntryLookups.ts, LookupField.tsx).
 */

/**
 * Typed text and choice labels are compared under the name match key (src/lib/names.ts), as the database compares the
 * names themselves: case, spaces and the punctuation `- . / , ( ) + * ; = ~ ? { } &` do not matter, an underscore does.
 * Text whose key is empty (such as "-") is empty text. The result of a pick is always an option's value, never the text.
 */
const wordsOf = (label: string) => label.split(/[\s·›/-]+/).map(nameMatchKey).filter(Boolean);

/** The choices a lookup lists for typed text: those whose label holds the text's key anywhere, in their own order; all when the key is empty. */
export function filterChoices<T extends Choice>(options: readonly T[], text: string): readonly T[] {
  const key = nameMatchKey(text);
  return key === '' ? options : options.filter(option => nameMatchKey(option.label).includes(key));
}

/**
 * What a lookup field's typed text means. The field's value is always one of its options: blank text clears it, text
 * equal (under the key) to the chosen label keeps it, and text that names exactly one choice (its whole label, or the
 * start of the label or of one of its words, such as "cre" for "Cr · Credit") picks it. Anything else, including text
 * that fits several choices or only a choice a rule disables, is an error in plain words and nothing is chosen.
 */
export function resolveTyped(options: readonly Choice[], text: string, current: string): { value: string } | { error: string } {
  const key = nameMatchKey(text);
  if (key === '') return { value: '' };
  const chosen = options.find(option => option.value === current && !option.disabled);
  if (chosen && nameMatchKey(chosen.label) === key) return { value: current };
  const fits = (option: Choice) => nameMatchKey(option.label).startsWith(key) || wordsOf(option.label).some(word => word.startsWith(key));
  const exact = options.filter(option => !option.disabled && nameMatchKey(option.label) === key);
  const found = exact.length ? exact : options.filter(option => !option.disabled && fits(option));
  if (found.length === 1) return { value: found[0].value };
  if (found.length > 1) return { error: `“${text.trim()}” could mean more than one choice. Type more of the name, or pick from the list.` };
  const blocked = options.filter(option => option.disabled && fits(option));
  if (blocked.length === 1 && blocked[0].disabledReason) return { error: blocked[0].disabledReason };
  return { error: `“${text.trim()}” is not one of the choices. Pick one from the list.` };
}

/** What typed text means for a lookup: an error to show, the value already held, or another choice to take. */
export type TypedOutcome = { kind: 'error'; message: string } | { kind: 'keep' } | { kind: 'pick'; value: string };

/** `blank` is what an emptied field says. The text names at most one enabled choice, never free text (`resolveTyped`, above). */
export function typedOutcome(options: readonly Choice[], text: string, current: string, blank: string): TypedOutcome {
  const result = resolveTyped(options, text, current);
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
