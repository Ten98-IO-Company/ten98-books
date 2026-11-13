import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findChordConflicts, isPrintableChord, mergeKeymaps, parseChord, reservedChord, resolveShortcut, type ResolvedCommand, type ShortcutPlatform, type ShortcutTarget } from '@ten98/ui';
import { commandIds, commands, type CommandContext } from '../src/lib/commands.ts';
import { browserReservedChords, keymapNames, keymaps, type KeymapName } from '../src/lib/keymaps.ts';

const platforms: readonly ShortcutPlatform[] = ['other', 'apple'];

/** The keymap as the registry sees it: one command per id, scoped by its context, chords in canonical form. */
function registered(name: KeymapName, platform: ShortcutPlatform = 'other'): ResolvedCommand[] {
  const merged = mergeKeymaps(keymaps[name]);
  return commandIds.map(id => ({
    id, scope: commands[id].context, enabled: true,
    chords: (merged[id] ?? []).map(chord => { const canonical = parseChord(chord, platform); assert.ok(canonical, `${name}: ${id} has an invalid chord "${chord}"`); return canonical; }),
  }));
}

function resolve(name: KeymapName, chord: string, contexts: readonly (CommandContext | `${CommandContext}:focus`)[], target: ShortcutTarget = 'other') {
  const scopes = [...contexts.map(entry => ({ id: entry.replace(':focus', ''), focus: entry.endsWith(':focus') })), { id: 'global', focus: false }];
  return resolveShortcut({ chord: parseChord(chord)!, scopes, commands: registered(name), target })?.command.id;
}

test('both keymaps bind every command, and only commands the registry defines', () => {
  for (const name of keymapNames) {
    assert.deepEqual(Object.keys(keymaps[name]).sort(), [...commandIds].sort(), name);
    for (const platform of platforms) for (const command of registered(name, platform)) assert.ok(command.chords.length > 0, `${name}: ${command.id} has no key`);
  }
});

test('no two commands share a key in the same context, in either keymap or platform', () => {
  for (const name of keymapNames) for (const platform of platforms) assert.deepEqual(findChordConflicts(registered(name, platform)), [], `${name} on ${platform}`);
});

test('an inner context reuses a key of the global context only where that is the intent', () => {
  for (const name of keymapNames) {
    const commandsByContext = registered(name);
    const globalKeys = new Map(commandsByContext.filter(command => command.scope === 'global').flatMap(command => command.chords.map(chord => [chord, command.id])));
    const shadows = commandsByContext.filter(command => command.scope !== 'global').flatMap(command => command.chords.filter(chord => globalKeys.has(chord)).map(chord => `${command.id} over ${globalKeys.get(chord)} on ${chord}`));
    // Escape on an entry screen discards the entry instead of leaving the page behind it.
    assert.deepEqual(shadows, ['entry.cancel over nav.back on Escape'], name);
  }
});

test('single printable keys are bound only in the focused company menu (WCAG 2.1.4)', () => {
  for (const name of keymapNames) for (const command of registered(name)) {
    if (command.chords.some(isPrintableChord)) assert.equal(command.scope, 'company-home', `${name}: ${command.id}`);
  }
});

test('web-safe assigns no function key and none of the documented browser and operating-system keys', () => {
  const documented = new Map(browserReservedChords.flatMap(({ reason, chords }) => chords.map(chord => [parseChord(chord), reason])));
  assert.ok(documented.size > 60 && !documented.has(undefined), 'the documented list parses');
  for (const platform of platforms) for (const command of registered('web-safe', platform)) for (const chord of command.chords) {
    assert.doesNotMatch(chord, /(^|\+)F\d+$/, `${command.id}: ${chord}`);
    assert.equal(documented.get(chord), undefined, `${command.id}: ${chord}`);
    assert.equal(reservedChord(chord, platform), undefined, `${command.id}: ${chord} on ${platform}`);
  }
});

test('classic never relies on a key a page cannot receive', () => {
  for (const platform of platforms) for (const command of registered('classic', platform)) for (const chord of command.chords) {
    assert.notEqual(reservedChord(chord, platform)?.kind, 'reserved', `${command.id}: ${chord} on ${platform}`);
  }
});

test('the innermost active context that binds a key wins; otherwise the key falls through to global', () => {
  for (const name of keymapNames) {
    assert.equal(resolve(name, 'Escape', []), 'nav.back');
    assert.equal(resolve(name, 'Escape', ['entry']), 'entry.cancel');
    assert.equal(resolve(name, 'Escape', ['company-home:focus']), 'nav.back', 'the menu has no Escape of its own');
    assert.equal(resolve(name, 'Alt+C', ['list']), 'list.create');
    assert.equal(resolve(name, 'Alt+C', ['entry']), 'entry.create-master');
    assert.equal(resolve(name, 'Alt+C', []), undefined);
    assert.equal(resolve(name, 'Ctrl+/', ['entry'], 'text'), 'help.keyboard', 'a global chord still works while typing on an entry screen');
  }
  assert.equal(resolve('classic', 'F5', ['entry']), 'entry.voucher.payment');
  assert.equal(resolve('classic', 'F5', []), undefined, 'outside entry the browser keeps F5');
  assert.equal(resolve('classic', 'F1', []), 'help.keyboard');
  assert.equal(resolve('web-safe', 'F1', []), undefined);
  assert.equal(resolve('web-safe', 'Alt+K', []), 'company.switch');
  assert.equal(resolve('classic', 'Alt+K', []), undefined);
});

test('menu letters and menu keys run only while the menu itself has focus', () => {
  for (const name of keymapNames) {
    assert.equal(resolve(name, 'B', ['company-home:focus']), 'home.balance-sheet');
    assert.equal(resolve(name, 'B', ['company-home']), undefined, 'a mounted but unfocused menu takes no letters');
    assert.equal(resolve(name, 'B', ['company-home:focus'], 'text'), undefined, 'typing in a field never opens a report');
    assert.equal(resolve(name, 'Enter', ['company-home:focus']), 'menu.open');
    assert.equal(resolve(name, 'ArrowDown', ['company-home:focus']), 'menu.next');
    assert.equal(resolve(name, 'Enter', ['company-home:focus'], 'control'), undefined, 'a focused button keeps Enter');
    assert.equal(resolve(name, 'Shift+B', ['company-home:focus']), undefined);
  }
});
