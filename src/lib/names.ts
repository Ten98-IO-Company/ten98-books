/**
 * The product's name match key: two names equal under it are the same name. Observed for bills (import, the outstanding
 * export, settlement by name on screen) and on the creation screens of groups, ledgers, voucher types and cost centres.
 * The database's `name_match_key` (migration 0009) removes the same characters; a test requires both to give the same
 * key for every character observed. Bills use it from 0009; masters keep their own uniqueness until a later migration.
 */

/** The characters ignored when names are compared: space, TAB and these. Every other character counts. */
export const ignoredInNames = ' 	-./,()+*;=~?{}&';
const ignored = new Set(ignoredInNames);

/**
 * The key, as `name_match_key` computes it: the name without the ignored characters, each remaining character in lower
 * case by its simple mapping (accents and digits unchanged).
 */
export function nameMatchKey(name: string): string {
  let key = '';
  for (const character of name) if (!ignored.has(character)) key += [...character.toLowerCase()][0];
  return key;
}
