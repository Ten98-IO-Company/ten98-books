/**
 * The product's name match key: two names equal under it are the same name. Observed for bills (import, the outstanding
 * export, settlement by name on screen) and on the creation screens of groups, ledgers, voucher types and cost centres.
 * The database's `name_match_key` (migration 0009) removes the same characters; a test requires both to give the same
 * key for every character observed. Bills use it from 0009; masters keep their own uniqueness until a later migration.
 *
 * The database's key is the authority: it alone decides identity (one bill or two). This twin is for matching names in
 * lists on the screens only. Its lower-casing follows Node's Unicode tables, which may be newer than the database
 * server's (28 code points differed when this was written, U+A7CE, U+A7D2, U+A7D4 and U+16EA0 to U+16EB8).
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
