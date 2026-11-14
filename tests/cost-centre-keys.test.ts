import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { findChordConflicts, mergeKeymaps, parseChord, reservedChord, resolveShortcut, type ResolvedCommand } from '@ten98/ui';
import { barCommands, commandIds, commands } from '../src/lib/commands.ts';
import { browserReservedChords, classicReserved, habitChords, keymapNames, keymaps, neverClaimed, reservedClaims, type KeymapName } from '../src/lib/keymaps.ts';

/**
 * The keys of the cost category and cost centre screens: the company menu letter, and the list actions that screen adds
 * (move a centre, switch the feature). Everything else (create, delete, history, open, accept, cancel) reuses the masters
 * commands, which tests/masters-keys.test.ts and tests/keyboard.test.ts cover.
 */
const costKeys = { 'home.cost-centres': 'E', 'list.move': 'Alt+Q', 'list.switch': 'Alt+N' } as const;

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('each new command is in the registry and bound to its key in both keymaps', () => {
  for (const [id, key] of Object.entries(costKeys)) {
    assert.ok(commandIds.includes(id as never), id);
    for (const name of keymapNames) assert.deepEqual(mergeKeymaps(keymaps[name])[id], [key], `${name}: ${id}`);
  }
  assert.equal(commands['home.cost-centres'].context, 'company-home');
  assert.equal(commands['list.move'].context, 'list');
  assert.equal(commands['list.switch'].context, 'list');
});

test('the keys that may never be claimed are untouched, and no new key is one of them, a habit chord, a reservation or a browser key', () => {
  assert.deepEqual([...neverClaimed], ['Ctrl+C', 'Ctrl+X', 'Ctrl+V', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+A', 'Ctrl+F']);
  const browser = new Set(browserReservedChords.flatMap(entry => entry.chords.map(chord => parseChord(chord))));
  const reserved = new Set(classicReserved.flatMap(entry => entry.keys).map(chord => parseChord(chord)));
  for (const key of Object.values(costKeys)) {
    const parsed = parseChord(key);
    assert.ok(parsed, key);
    assert.ok(!neverClaimed.includes(key) && !habitChords.includes(key), key);
    assert.ok(!browser.has(parsed) && !reserved.has(parsed), `${key} is not reserved`);
    for (const platform of ['other', 'apple'] as const) assert.equal(reservedChord(parseChord(key, platform)!, platform), undefined, `${key} on ${platform}`);
  }
  for (const context of ['global', 'list', 'company-home'] as const) assert.ok(!reservedClaims('classic', context).some(chord => ['Alt+Q', 'Alt+N', 'E'].includes(chord)), context);
});

test('no key is shared inside the list context or the company menu, with the new commands in, in either keymap', () => {
  for (const name of keymapNames) {
    const merged = mergeKeymaps(keymaps[name]);
    const resolved: ResolvedCommand[] = commandIds.map(id => ({ id, scope: commands[id].context, enabled: true, chords: (merged[id] ?? []).map(chord => parseChord(chord)!) }));
    assert.deepEqual(findChordConflicts(resolved), [], name);
    const listKeys = resolved.filter(command => command.scope === 'list').flatMap(command => command.chords);
    assert.equal(new Set(listKeys).size, listKeys.length, `${name}: a list key is bound twice`);
  }
});

test('on the cost list the move and switch commands resolve in the list scope and fall to nothing elsewhere', () => {
  const run = (name: KeymapName, chord: string, scopes: string[]) => {
    const merged = mergeKeymaps(keymaps[name]);
    const live = commandIds.map(id => ({ id, scope: commands[id].context, enabled: true, chords: (merged[id] ?? []).map(key => parseChord(key)!) }));
    return resolveShortcut({ chord: parseChord(chord)!, scopes: [...scopes.map(entry => ({ id: entry.replace(':focus', ''), focus: entry.endsWith(':focus') })), { id: 'global', focus: false }], commands: live, target: 'other' })?.command.id;
  };
  for (const name of keymapNames) {
    assert.equal(run(name, 'Alt+Q', ['list']), 'list.move', name);
    assert.equal(run(name, 'Alt+N', ['list']), 'list.switch', name);
    assert.equal(run(name, 'Alt+Q', ['entry']), undefined, `${name}: not on an entry screen`);
    // The company menu letter works only while the menu has focus, as every menu letter does.
    assert.equal(run(name, 'E', ['company-home:focus']), 'home.cost-centres', name);
    assert.equal(run(name, 'E', ['company-home']), undefined, `${name}: the menu does not have focus`);
    assert.equal(run(name, 'E', []), undefined, name);
  }
});

test('the action bar lists the new list actions with the others, and drops them when the screen does not offer them', () => {
  for (const name of keymapNames) {
    const merged = mergeKeymaps(keymaps[name]);
    const live = (ids: string[]) => ids.map(id => ({ id, enabled: true, keys: merged[id] ?? [] }));
    const owner = barCommands(live(['list.create', 'list.delete', 'list.history', 'list.move', 'list.switch', 'list.next', 'list.open', 'nav.back']));
    assert.deepEqual(owner.map(command => command.id), ['list.create', 'list.delete', 'list.history', 'list.move', 'list.switch', 'nav.back'], name);
    // A viewer's screen registers only history; a disabled command never lists.
    const viewer = barCommands([...live(['list.history']), { id: 'list.move', enabled: false, keys: ['Alt+Q'] }, { id: 'list.switch', enabled: false, keys: ['Alt+N'] }]);
    assert.deepEqual(viewer.map(command => command.id), ['list.history'], name);
  }
});

test('the cost list is reached from the company menu and from go-to and switch-to', () => {
  assert.match(source('src/routes/app/c.$companyId.index.tsx'), /command: 'home\.cost-centres', to: '\/app\/c\/\$companyId\/masters\/cost-centres'/);
  assert.match(source('src/components/KeyboardShell.tsx'), /item\('home\.cost-centres', '\/app\/c\/\$companyId\/masters\/cost-centres'\)/);
  // The go-to list is shown for every role, a viewer included: the list screen is read-only for them.
  const goTo = source('src/components/KeyboardShell.tsx');
  assert.ok(goTo.indexOf("item('home.cost-centres'") > goTo.indexOf('...canWrite ?'), 'the entry sits outside the writers-only part of the masters group');
  assert.ok(goTo.indexOf("item('home.cost-centres'") < goTo.indexOf("id: 'transactions'"));
});

test('both cost forms render an entry scope and guard typed work against leaving', () => {
  for (const file of ['CostCategoryForm', 'CostCentreForm']) {
    const form = source(`src/components/masters/${file}.tsx`);
    assert.match(form, /<EntryScope>/, file);
    assert.match(form, /useLeaveGuard\(dirty/, file);
    assert.doesNotMatch(form, /setFlash\([^)]*\); leave\(\)/, file);
  }
});
