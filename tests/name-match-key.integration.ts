import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { ignoredInNames, nameMatchKey } from '../src/lib/bills.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';

/**
` * The name match key has two copies, `name_match_key` in the database (migration 0009) and `nameMatchKey` in
 * src/lib/bills.ts for the screens: every observed character, Arabic text, accented letters and both digit kinds give
 * the same key in both.
 */
let database: TestDatabase;
let admin: pg.Client;
before(async () => {
  database = await freshDatabase('name_match_key');
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
});
after(async () => { await admin?.end(); await database?.drop(); });

const ignored = [' ', '\t', '-', '.', '/', ',', '(', ')', '+', '*', ';', '=', '~', '?', '{', '}', '&'];
const kept = ['_', ':', '#', String.fromCharCode(92), '@', '!', "'", '|', '%', '<', '$', '^', '[', ']', '`', '"', '\u00a0', '\u2013'];
const names = [
  ...ignored.map(character => `A${character}b1`), ...kept.map(character => `A${character}b1`),
  'ab1', 'AB-1', 'A-B1', 'Ab-1', 'a.b 1', ' AB1 ', 'AB01', 'Éclair', 'éclair', 'Eclair', 'ÀÉÎÕÜ', 'İstanbul', 'ΣΑΣ', 'فاتورة 12', 'فاتورة١٢', '١٢٣', '123', '10', '9', 'B-050', 'b3',
];

test('the list of ignored characters is the one observed, and every other observed character is kept', () => {
  assert.deepEqual([...ignoredInNames].sort(), [...ignored].sort());
  for (const character of ignored) assert.equal(nameMatchKey(`A${character}b1`), 'ab1', JSON.stringify(character));
  for (const character of kept) assert.notEqual(nameMatchKey(`A${character}b1`), 'ab1', JSON.stringify(character));
  assert.deepEqual([nameMatchKey('AB01'), nameMatchKey('éclair'), nameMatchKey('Éclair'), nameMatchKey('Eclair'), nameMatchKey('١٢'), nameMatchKey('12')],
    ['ab01', 'éclair', 'éclair', 'eclair', '١٢', '12'], 'no leading zeros dropped, accents kept, digit kinds apart');
});

test('the database and the TypeScript twin give the same key for every name', async () => {
  const { rows } = await admin.query<{ name: string; key: string }>('SELECT name, name_match_key(name) AS key FROM unnest($1::text[]) AS t(name)', [names]);
  for (const row of rows) assert.equal(nameMatchKey(row.name), row.key, JSON.stringify(row.name));
  assert.equal(rows.length, names.length);
});
