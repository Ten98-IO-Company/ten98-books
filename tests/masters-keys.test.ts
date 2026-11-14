import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeKeymaps, parseChord, resolveShortcut, type ResolvedCommand, type ShortcutTarget } from '@ten98/ui';
import { barCommands, commandIds, commands } from '../src/lib/commands.ts';
import { keymapNames, keymaps, type KeymapName } from '../src/lib/keymaps.ts';

/**
 * Escape on a masters entry screen: whatever has focus (a text field, a lookup, a button, the Save panel, a viewer's
 * Back button), exactly one enabled command owns the key and it works. A regression once made entry.cancel exist only
 * while a text field had focus; the registry lets a scope whose command for a key is disabled keep that key, so Escape
 * (and classic Ctrl+Q) then did nothing off text fields.
 */
const entryCommands = new Set(['entry.accept', 'entry.cancel', 'entry.next-field', 'entry.delete', 'entry.history']);
const runsFromText = new Set(['entry.accept', 'entry.cancel', 'entry.next-field']);

function registry(name: KeymapName, overrides: Record<string, boolean> = {}): ResolvedCommand[] {
  const merged = mergeKeymaps(keymaps[name]);
  return commandIds.filter(id => commands[id].context === 'global' || entryCommands.has(id)).map(id => ({
    id, scope: commands[id].context, enabled: overrides[id] ?? true, allowInTextInput: runsFromText.has(id),
    chords: (merged[id] ?? []).map(chord => parseChord(chord)!),
  }));
}

const targets: readonly ShortcutTarget[] = ['text', 'multiline', 'control', 'other'];
const scopes = [{ id: 'entry', focus: false }, { id: 'global', focus: false }];
const escapes = (name: KeymapName) => name === 'classic' ? ['Escape', 'Ctrl+Q'] : ['Escape'];

test('on an entry screen exactly one enabled command owns Escape (and classic Ctrl+Q) from every focus position, in both keymaps', () => {
  for (const name of keymapNames) for (const chord of escapes(name)) for (const target of targets) for (const backEnabled of [true, false]) {
    const match = resolveShortcut({ chord: parseChord(chord)!, scopes, commands: registry(name, { 'nav.back': backEnabled }), target });
    const where = `${name} ${chord} on ${target}, nav.back ${backEnabled ? 'on' : 'off'}`;
    assert.ok(match, where);
    assert.equal(match.command.id, 'entry.cancel', where);
    assert.equal(match.command.enabled, true, `${where}: the owner must be enabled`);
    assert.equal(match.run, true, where);
  }
});

test('negative control: with entry.cancel disabled the scope still claims Escape, so nothing runs and the enabled go-back of the shell never does', () => {
  for (const target of targets) {
    const match = resolveShortcut({ chord: parseChord('Escape')!, scopes, commands: registry('web-safe', { 'entry.cancel': false, 'nav.back': true }), target });
    assert.equal(match, undefined, target);
  }
});

test('the action bar lists one Escape command on an entry screen and the shell\'s go-back alone elsewhere, in both keymaps', () => {
  for (const name of keymapNames) {
    const merged = mergeKeymaps(keymaps[name]);
    const live = (ids: string[]) => ids.map(id => ({ id, enabled: true, keys: merged[id] ?? [] }));
    const entry = barCommands(live(['help.keyboard', 'nav.back', 'company.switch', 'entry.accept', 'entry.cancel', 'entry.next-field', 'entry.history']));
    assert.deepEqual(entry.filter(command => command.keys.includes('Escape')).map(command => command.id), ['entry.cancel'], name);
    assert.ok(entry.some(command => command.id === 'entry.accept') && entry.some(command => command.id === 'company.switch'), 'other commands stay');
    assert.equal(entry.some(command => command.id === 'entry.next-field'), false, 'movement keys stay off the bar');
    const history = barCommands(live(['help.keyboard', 'nav.back', 'company.switch']));
    assert.deepEqual(history.filter(command => command.keys.includes('Escape')).map(command => command.id), ['nav.back'], name);
    // A disabled command never lists, and a duplicate registration lists once.
    assert.deepEqual(barCommands([{ id: 'nav.back', enabled: false, keys: ['Escape'] }, { id: 'help.keyboard', enabled: true, keys: ['Ctrl+/'] }, { id: 'help.keyboard', enabled: true, keys: ['Ctrl+/'] }]).map(command => command.id), ['help.keyboard']);
  }
});
