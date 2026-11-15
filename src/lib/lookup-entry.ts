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
/** The words of a label as keys: it is split at whitespace, at `·` and `›`, and at every character the key ignores. */
const wordsOf = (label: string): string[] => {
  const words: string[] = [];
  let word = '';
  for (const character of label) {
    if (/\s/.test(character) || '·›'.includes(character) || nameMatchKey(character) === '') { if (word) words.push(nameMatchKey(word)); word = ''; } else word += character;
  }
  if (word) words.push(nameMatchKey(word));
  return words.filter(Boolean);
};

/** The choices a lookup lists for typed text: those whose label holds the text's key anywhere, in their own order; all when the key is empty. */
export function filterChoices<T extends Choice>(options: readonly T[], text: string): readonly T[] {
  const key = nameMatchKey(text);
  return key === '' ? options : options.filter(option => nameMatchKey(option.label).includes(key));
}

/**
 * What a lookup field's typed text means. The field's value is always one of its options: blank text clears it, text
 * equal (under the key) to the chosen label keeps it, and otherwise one enabled choice is named, in this order (our own
 * rule, provisional: the reference notes do not say whether names match from the start or anywhere):
 * 1. a label whose key equals the text's (a built-in choice such as "Primary" wins over a user's name with the same key);
 * 2. the start of a label or of one of its words, words split at the ignored characters too;
 * 3. a label that holds the text's key anywhere, which is what the list shows, so one listed choice is the one Enter takes.
 * Each step names a choice only when it is the only one. Several are an error saying so, none is "not one of the
 * choices", and a choice a rule disables is never taken: it answers with its reason, also when it is the exact name.
 */
export function resolveTyped(options: readonly Choice[], text: string, current: string): { value: string } | { error: string } {
  const key = nameMatchKey(text);
  if (key === '') return { value: '' };
  const labelKey = (option: Choice) => nameMatchKey(option.label);
  const chosen = options.find(option => option.value === current && !option.disabled);
  if (chosen && labelKey(chosen) === key) return { value: current };
  const enabled = options.filter(option => !option.disabled);
  const shown = text.trim();
  const quoted = shown ? `“${shown}”` : 'That';
  const exact = enabled.filter(option => labelKey(option) === key);
  const builtIn = exact.filter(option => option.builtIn);
  if (builtIn.length === 1) return { value: builtIn[0].value };
  const steps = [
    exact,
    enabled.filter(option => labelKey(option).startsWith(key) || wordsOf(option.label).some(word => word.startsWith(key))),
    enabled.filter(option => labelKey(option).includes(key)),
  ];
  const disabledExact = options.filter(option => option.disabled && labelKey(option) === key);
  if (!exact.length && disabledExact.length === 1 && disabledExact[0].disabledReason) return { error: disabledExact[0].disabledReason };
  for (const found of steps) {
    if (found.length === 1) return { value: found[0].value };
    if (found.length > 1) return { error: `${quoted} could mean more than one choice. Type more of the name, or pick from the list.` };
  }
  const blocked = options.filter(option => option.disabled && labelKey(option).includes(key));
  if (blocked.length === 1 && blocked[0].disabledReason) return { error: blocked[0].disabledReason };
  return { error: `${quoted} is not one of the choices. Pick one from the list.` };
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
