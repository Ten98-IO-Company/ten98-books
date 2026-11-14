import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findChordConflicts, isPrintableChord, mergeKeymaps, parseChord, reservedChord, resolveShortcut, type ResolvedCommand, type ShortcutPlatform, type ShortcutTarget } from '@ten98/ui';
import { readFileSync } from 'node:fs';
import { commandIds, commands, keepsEscape, type CommandContext, type CommandId } from '../src/lib/commands.ts';
import { browserReservedChords, classicOnly, classicParity, classicReserved, defaultKeymap, keymapNames, keymaps, reservedShadows, type KeymapName } from '../src/lib/keymaps.ts';
import { lookupKeyAction } from '../src/lib/masters.ts';

const platforms: readonly ShortcutPlatform[] = ['other', 'apple'];

/** The keymap as the registry sees it: one command per id, scoped by its context, chords in canonical form. */
function registered(name: KeymapName, platform: ShortcutPlatform = 'other'): ResolvedCommand[] {
  const merged = mergeKeymaps(keymaps[name]);
  return commandIds.map(id => ({
    id, scope: commands[id].context, enabled: true,
    chords: (merged[id] ?? []).map(chord => { const canonical = parseChord(chord, platform); assert.ok(canonical, `${name}: ${id} has an invalid chord "${chord}"`); return canonical; }),
  }));
}

/** Commands the screens register with allowInTextInput (entry.tsx, MasterList.tsx under its search field, MasterPicker.tsx). */
const inTextInput = new Set<string>(['entry.next-field', 'entry.accept', 'entry.cancel', 'list.next', 'list.previous', 'list.open', 'list.cancel']);

function resolve(name: KeymapName, chord: string, contexts: readonly (CommandContext | `${CommandContext}:focus`)[], target: ShortcutTarget = 'other', disabled: readonly string[] = []) {
  const scopes = [...contexts.map(entry => ({ id: entry.replace(':focus', ''), focus: entry.endsWith(':focus') })), { id: 'global', focus: false }];
  const commandsNow = registered(name).map(command => ({ ...command, enabled: !disabled.includes(command.id), allowInTextInput: inTextInput.has(command.id) }));
  return resolveShortcut({ chord: parseChord(chord)!, scopes, commands: commandsNow, target })?.command.id;
}

/** A dialog wrapped in DialogKeys (KeyboardShell.tsx): a modal scope, so only its own close and accept can run. */
function resolveInDialog(name: KeymapName, chord: string, target: ShortcutTarget, { accept = true } = {}) {
  const merged = mergeKeymaps(keymaps[name]);
  const own = (['nav.quit', 'entry.accept'] as const).map(id => ({ id, scope: 'dialog', enabled: id !== 'entry.accept' || accept, allowInTextInput: id === 'entry.accept',
    chords: (merged[id] ?? []).map(key => parseChord(key)!) }));
  return resolveShortcut({ chord: parseChord(chord)!, scopes: [{ id: 'dialog', focus: false }], commands: [...own, ...registered(name)], target })?.command.id;
}

/** A focused element as the Escape guard sees it. */
const element = (tagName: string, extra: { type?: string; role?: string; isContentEditable?: boolean } = {}) =>
  ({ tagName, type: extra.type, isContentEditable: extra.isContentEditable, getAttribute: (name: string) => name === 'role' ? extra.role ?? null : null });

test('both keymaps bind every command, and only commands the registry defines; web-safe leaves the classic-only ones unbound', () => {
  for (const name of keymapNames) {
    assert.deepEqual(Object.keys(keymaps[name]).sort(), [...commandIds].sort(), name);
    for (const platform of platforms) for (const command of registered(name, platform)) {
      const unbound = name === 'web-safe' && classicOnly.includes(command.id as CommandId);
      assert.equal(command.chords.length > 0, !unbound, `${name}: ${command.id}`);
    }
  }
});

test('classic is the default keymap', () => {
  assert.equal(defaultKeymap, 'classic');
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
    // Classic also goes back with Ctrl+Q, so its entry screens shadow that key the same way.
    // The alter list's search field owns Escape the same way (clear the filter, then go back).
    // Classic leaves with Ctrl+Q (nav.quit), which entry and list screens take over the same way.
    assert.deepEqual(shadows.sort(), (name === 'classic'
      ? ['entry.cancel over nav.back on Escape', 'entry.cancel over nav.quit on Ctrl+Q', 'list.cancel over nav.back on Escape', 'list.cancel over nav.quit on Ctrl+Q']
      : ['entry.cancel over nav.back on Escape', 'list.cancel over nav.back on Escape']).sort(), name);
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
  assert.equal(resolve('classic', 'Alt+K', []), undefined, 'reserved in classic for the company menu');
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

test('Escape in a text field: the engine runs nav.back there, so the shell disables it while a field keeps Escape', () => {
  for (const name of keymapNames) {
    // @ten98/ui 0.37.0 lets Escape run a command from a single-line field; this is why the app-side guard exists.
    assert.equal(resolve(name, 'Escape', [], 'text'), 'nav.back');
    assert.equal(resolve(name, 'Escape', [], 'multiline'), 'nav.back');
    // With the guard, nav.back is disabled while the field has focus: nothing claims the key and the field keeps it.
    assert.equal(resolve(name, 'Escape', [], 'text', ['nav.back']), undefined);
    assert.equal(resolve(name, 'Escape', ['entry'], 'text', ['nav.back']), 'entry.cancel', 'an entry screen still decides Escape in its fields');
  }
});

test('the Escape guard keeps Escape for text fields, selects, editable regions and comboboxes only', () => {
  for (const kept of [element('INPUT'), element('INPUT', { type: 'search' }), element('input', { type: 'date' }), element('TEXTAREA'), element('SELECT'),
    element('DIV', { isContentEditable: true }), element('DIV', { role: 'combobox' }), element('SPAN', { role: 'textbox' }), element('DIV', { role: 'spinbutton' })]) {
    assert.equal(keepsEscape(kept), true, JSON.stringify(kept));
  }
  for (const free of [null, undefined, element('BODY'), element('UL', { role: 'menu' }), element('BUTTON'), element('A'), element('INPUT', { type: 'checkbox' }),
    element('INPUT', { type: 'radio' }), element('INPUT', { type: 'submit' }), element('LI', { role: 'option' })]) {
    assert.equal(keepsEscape(free), false, JSON.stringify(free));
  }
});

test('classic keys never take a key reserved for a feature still to come, in the same context or from a global reservation', () => {
  const keyed = registered('classic');
  const shadows: string[] = [];
  const seen = new Map<string, string>();
  for (const reserved of classicReserved) for (const key of reserved.keys) {
    const chord = parseChord(key);
    assert.ok(chord, `reserved ${key} parses`);
    assert.notEqual(reservedChord(chord, 'other')?.kind, 'reserved', `${key} must be a key a tab can receive`);
    const slot = `${reserved.context} ${chord}`;
    assert.equal(seen.get(slot), undefined, `${slot} is reserved twice`);
    seen.set(slot, reserved.purpose);
    for (const command of keyed) if (command.chords.includes(chord)) {
      if (command.scope === reserved.context) assert.fail(`${command.id} takes ${chord}, reserved for: ${reserved.purpose}`);
      if (reserved.context === 'global') shadows.push(`${command.id} on ${chord}`);
    }
  }
  assert.deepEqual(shadows, reservedShadows);
});

test('a reserved catalogue key that a tab cannot receive names its reason and an alternate a tab can', () => {
  const alternates = classicReserved.filter(entry => entry.catalogueKey);
  assert.ok(alternates.length >= 4);
  for (const entry of alternates) {
    const catalogue = parseChord(entry.catalogueKey!) ?? entry.catalogueKey!;
    assert.ok(entry.reason && entry.reason.length > 20, entry.purpose);
    assert.ok(reservedChord(catalogue, 'other')?.kind === 'reserved' || catalogue.startsWith('Ctrl+Alt+'), `${entry.catalogueKey} is not a key a tab is denied`);
    assert.ok(!entry.keys.includes(catalogue));
  }
});

test('every command has a parity entry, and docs/KEYBOARD.md shows each with its status', () => {
  assert.deepEqual(Object.keys(classicParity).sort(), [...commandIds].sort());
  const doc = readFileSync(new URL('../docs/KEYBOARD.md', import.meta.url), 'utf8');
  const parity = doc.slice(doc.indexOf('## Parity with desktop accounting keys'));
  assert.ok(parity.length > 100, 'the parity section exists');
  for (const id of commandIds) {
    const row = parity.split('\n').find(line => line.startsWith('| `' + id + '` |'));
    assert.ok(row, `${id} has a parity row`);
    assert.ok(row.includes(`| ${classicParity[id].status} |`), `${id} row shows ${classicParity[id].status}`);
  }
  for (const entry of Object.values(classicParity)) if (entry.status === 'alternate') assert.ok(entry.note, 'an alternate states its reason');
});

test('global keys behave the same from every context and focus target', () => {
  const contexts = [[], ['company-home:focus'], ['list'], ['entry'], ['report']] as const;
  for (const context of contexts) for (const target of ['other', 'text', 'control'] as const) {
    const where = `${context.join() || 'global'} / ${target}`;
    assert.equal(resolve('classic', 'F1', context, target), 'help.keyboard', where);
    assert.equal(resolve('classic', 'F3', context, target), 'company.switch', where);
    assert.equal(resolve('classic', 'Alt+G', context, target), 'nav.go-to', where);
    assert.equal(resolve('classic', 'Ctrl+G', context, target), 'nav.go-to', where);
    // Ctrl+Q leaves one level: entry and list screens leave through their own cancel, everywhere else nav.quit.
    const quit = context[0] === 'entry' ? 'entry.cancel' : context[0] === 'list' ? 'list.cancel' : 'nav.quit';
    assert.equal(resolve('classic', 'Ctrl+Q', context, target), quit, where);
    // F2 changes the period on a report; elsewhere it is held for the working date and does nothing yet.
    assert.equal(resolve('classic', 'F2', context, target), context[0] === 'report' ? 'report.period' : undefined, where);
    // Accept runs only where there is something to accept.
    assert.equal(resolve('classic', 'Ctrl+A', context, target), context[0] === 'entry' ? 'entry.accept' : undefined, where);
  }
});

test('focus targets: a text field, a lookup, a button, a list row, a report row and a dialog', () => {
  // Text field on an entry screen: accept, cancel and Enter run from inside it (the catalogue's accept from a field).
  assert.equal(resolve('classic', 'Ctrl+A', ['entry'], 'text'), 'entry.accept');
  assert.equal(resolve('classic', 'Enter', ['entry'], 'text'), 'entry.next-field');
  assert.equal(resolve('classic', 'Escape', ['entry'], 'text'), 'entry.cancel');
  // A text field outside entry and list screens keeps Escape (the shell turns nav.back off), but Ctrl+Q still leaves.
  assert.equal(resolve('classic', 'Escape', [], 'text', ['nav.back']), undefined);
  assert.equal(resolve('classic', 'Ctrl+Q', [], 'text', ['nav.back']), 'nav.quit');
  // A lookup is a text field whose combobox keeps Escape and Enter; lookupKeyAction decides what reaches the form.
  const acceptKeys = mergeKeymaps(keymaps.classic)['entry.accept'];
  assert.equal(lookupKeyAction({ chord: 'Escape', open: false, highlighted: false, acceptKeys }), 'cancel', 'closed: Escape leaves the screen');
  assert.equal(lookupKeyAction({ chord: 'Escape', open: true, highlighted: true, acceptKeys }), 'ignore', 'open: Escape only closes the list');
  assert.equal(lookupKeyAction({ chord: 'Ctrl+A', open: true, highlighted: true, acceptKeys }), 'accept-row', 'open: Ctrl+A picks the row, then accepts');
  assert.equal(lookupKeyAction({ chord: 'Ctrl+A', open: true, highlighted: false, acceptKeys }), 'accept-text');
  assert.equal(lookupKeyAction({ chord: 'Ctrl+A', open: false, highlighted: false, acceptKeys }), 'ignore', 'closed: the registry runs entry.accept itself');
  // A button keeps Enter and Space; chords still run.
  assert.equal(resolve('classic', 'Enter', ['entry'], 'control'), undefined);
  assert.equal(resolve('classic', 'Ctrl+A', ['entry'], 'control'), 'entry.accept');
  assert.equal(resolve('classic', 'Escape', ['entry'], 'control'), 'entry.cancel');
  assert.equal(resolve('classic', 'Ctrl+D', ['entry'], 'control'), 'entry.delete');
  // A focused list row (an option) keeps its arrows and Enter; the list's chords run.
  assert.equal(resolve('classic', 'ArrowDown', ['list'], 'control'), undefined);
  assert.equal(resolve('classic', 'Alt+C', ['list'], 'control'), 'list.create');
  assert.equal(resolve('classic', 'Alt+D', ['list'], 'control'), 'list.delete');
  assert.equal(resolve('classic', 'Alt+H', ['list'], 'control'), 'list.history');
  assert.equal(resolve('classic', 'Escape', ['list'], 'control'), 'list.cancel');
  // A report row likewise; the report's chords run.
  assert.equal(resolve('classic', 'Enter', ['report'], 'control'), undefined);
  assert.equal(resolve('classic', 'Ctrl+E', ['report'], 'control'), 'report.export');
  assert.equal(resolve('classic', 'Ctrl+P', ['report'], 'control'), 'report.print');
  assert.equal(resolve('classic', 'Alt+F5', ['report'], 'control'), 'report.detail');
  assert.equal(resolve('classic', 'Escape', ['report'], 'control'), 'nav.back');
  // A dialog: Ctrl+Q closes it and the accept keys apply it, from its fields too; nothing outside it runs.
  assert.equal(resolveInDialog('classic', 'Ctrl+Q', 'text'), 'nav.quit');
  assert.equal(resolveInDialog('classic', 'Ctrl+A', 'text'), 'entry.accept');
  assert.equal(resolveInDialog('classic', 'Ctrl+A', 'text', { accept: false }), undefined, 'a dialog with nothing to apply leaves Ctrl+A to the field');
  assert.equal(resolveInDialog('classic', 'F1', 'other'), undefined);
  assert.equal(resolveInDialog('classic', 'Escape', 'other'), undefined, 'the dialog closes itself on Escape');
});
