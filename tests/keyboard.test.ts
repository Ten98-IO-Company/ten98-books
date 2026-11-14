import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findChordConflicts, isPrintableChord, mergeKeymaps, parseChord, reservedChord, resolveShortcut, type ResolvedCommand, type ShortcutPlatform, type ShortcutTarget } from '@ten98/ui';
import { readdirSync, readFileSync } from 'node:fs';
import { ariaKeyShortcuts, backSource, commandIds, commands, keepsEscape, type CommandContext, type CommandId } from '../src/lib/commands.ts';
import { browserReservedChords, claimable, classicOnly, classicParity, classicReserved, defaultKeymap, dialogClaims, disabledClaims, habitChords, keymapNames, neverClaimed, keymaps, reservedClaims, reservedShadows, type KeymapName } from '../src/lib/keymaps.ts';
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

/**
 * A dialog as DialogKeys (KeyboardShell.tsx) registers it: a modal scope holding nav.quit, help.keyboard, entry.accept
 * when the dialog applies something, and one claim of `dialogClaims` for every other classic key.
 */
function resolveInDialog(name: KeymapName, chord: string, target: ShortcutTarget, { accept = true } = {}) {
  const merged = mergeKeymaps(keymaps[name]);
  const ownIds: CommandId[] = accept ? ['nav.quit', 'help.keyboard', 'entry.accept'] : ['nav.quit', 'help.keyboard'];
  const own = ownIds.map(id => ({ id: id as string, scope: 'dialog', enabled: true, allowInTextInput: id === 'entry.accept', chords: (merged[id] ?? []).map(key => parseChord(key)!) }));
  const claim = claimCommand('claim.dialog', 'dialog', dialogClaims(name, ownIds));
  return resolveShortcut({ chord: parseChord(chord)!, scopes: [{ id: 'dialog', focus: false }], commands: [...own, claim, ...registered(name)], target })?.command.id;
}

/** A claim as useClaim and useAppCommand register it: one do-nothing command holding its keys. */
const claimCommand = (id: string, scope: string, keys: readonly string[]) => ({ id, scope, enabled: true, chords: keys.map(key => parseChord(key)!) });

/**
 * The registry as the screens build it in a keymap: each scope's commands, with a switched-off command replaced by its
 * claim (useAppCommand), commands the screen does not register left out (`absent`), and each context's reserved claim
 * (ReservedKeys) registered in its scope, the habit chords in the application scope.
 */
function resolveScreen(name: KeymapName, chord: string, contexts: readonly CommandContext[], target: ShortcutTarget, disabled: readonly CommandId[] = [], absent: readonly CommandId[] = []) {
  const screen = registered(name).filter(command => !absent.includes(command.id as CommandId)).map(command => {
    const id = command.id as CommandId;
    if (!disabled.includes(id)) return { ...command, allowInTextInput: inTextInput.has(id) };
    const claims = disabledClaims(name, id);
    return claims.length ? claimCommand(`claim.${id}`, command.scope, claims) : { ...command, enabled: false };
  });
  const reserved = (['global', ...contexts] as CommandContext[]).map(context => claimCommand(`reserved.${context}`, context, reservedClaims(name, context)));
  const scopes = [...contexts.map(id => ({ id, focus: false })), { id: 'global', focus: false }];
  return resolveShortcut({ chord: parseChord(chord)!, scopes, commands: [...screen, ...reserved], target })?.command.id;
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
    // A list leaves at once on Ctrl+Q through nav.quit; its own cancel keeps only the Escape ladder.
    assert.deepEqual(shadows.sort(), (name === 'classic'
      ? ['entry.cancel over nav.back on Escape', 'entry.cancel over nav.quit on Ctrl+Q', 'list.cancel over nav.back on Escape']
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
  assert.deepEqual([...shadows].sort(), [...reservedShadows].sort());
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
    assert.equal(resolve('classic', 'Ctrl+G', context, target), 'nav.switch-to', where);
    // Ctrl+Q leaves one level: an entry screen through its own cancel (which asks first), everywhere else nav.quit.
    const quit = context[0] === 'entry' ? 'entry.cancel' : 'nav.quit';
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
  assert.equal(resolve('classic', 'Alt+D', ['entry'], 'control'), 'entry.delete');
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
  // A dialog: covered by the dialog tests below.
});

test('a dialog built by DialogKeys closes on Ctrl+Q, opens help on F1, applies on Ctrl+A, and claims every other classic key', () => {
  for (const target of ['text', 'control', 'other'] as const) {
    assert.equal(resolveInDialog('classic', 'Ctrl+Q', target), 'nav.quit', target);
    assert.equal(resolveInDialog('classic', 'F1', target), 'help.keyboard', target);
    for (const chord of ['F2', 'F3', 'Ctrl+G', 'Alt+G', 'Ctrl+P', 'Ctrl+D', 'Ctrl+E', 'Alt+F5', 'Ctrl+H', 'Alt+D', 'Ctrl+F7', 'Ctrl+M']) {
      assert.equal(resolveInDialog('classic', chord, target), 'claim.dialog', `${chord} on ${target}`);
    }
    assert.equal(resolveInDialog('classic', 'Escape', target), undefined, 'the dialog closes itself on Escape');
  }
  assert.equal(resolveInDialog('classic', 'Ctrl+A', 'text'), 'entry.accept', 'applies from a field');
  assert.equal(resolveInDialog('classic', 'Ctrl+A', 'control', { accept: false }), undefined, 'with nothing to apply, Ctrl+A keeps its browser meaning');
  assert.equal(resolveInDialog('classic', 'Enter', 'control'), undefined, 'a focused button keeps Enter');
  // Web-safe claims nothing: its keys are chosen to leave the browser's alone.
  assert.equal(resolveInDialog('web-safe', 'F3', 'other'), undefined);
  assert.equal(resolveInDialog('web-safe', 'Ctrl+P', 'other'), undefined);
  assert.equal(resolveInDialog('web-safe', 'Ctrl+/', 'other'), 'help.keyboard');
});

test('classic claims every reserved key in its context, and the keys of a switched-off command; web-safe claims none', () => {
  // The day book (a report): the reserved row actions and report keys never reach the browser.
  for (const chord of ['Alt+D', 'Ctrl+D', 'Ctrl+H', 'Alt+X', 'Ctrl+B', 'F5']) assert.equal(resolveScreen('classic', chord, ['report'], 'control'), 'reserved.report', chord);
  // An entry form, from inside a field: print, export and the reserved entry keys are claimed.
  assert.equal(resolveScreen('classic', 'Ctrl+P', ['entry'], 'text'), 'reserved.global');
  assert.equal(resolveScreen('classic', 'Ctrl+E', ['entry'], 'text'), 'reserved.global');
  assert.equal(resolveScreen('classic', 'Ctrl+H', ['entry'], 'text'), 'reserved.entry');
  assert.equal(resolveScreen('classic', 'Alt+R', ['entry'], 'text'), 'reserved.entry');
  // A list: the disputed create and delete candidates and the list settings keys.
  for (const chord of ['Ctrl+H', 'F10', 'F5', 'Alt+R', 'Alt+U']) assert.equal(resolveScreen('classic', chord, ['list'], 'control'), 'reserved.list', chord);
  // Ctrl+C and Ctrl+D do nothing on the catalogue's lists and are not list keys here: Ctrl+C copies; Ctrl+D is a habit chord kept from the bookmark dialog.
  assert.equal(resolveScreen('classic', 'Ctrl+C', ['list'], 'control'), undefined);
  assert.equal(resolveScreen('classic', 'Ctrl+D', ['list'], 'control'), 'reserved.global');
  // A built-in row: delete is switched off, and Alt+D is still claimed.
  assert.equal(resolveScreen('classic', 'Alt+D', ['list'], 'control', ['list.delete']), 'claim.list.delete');
  assert.equal(resolveScreen('classic', 'Alt+D', ['list'], 'control'), 'list.delete');
  // A viewer's form: accept is off; its other key, Ctrl+Enter, is still claimed.
  assert.equal(resolveScreen('classic', 'Ctrl+Enter', ['entry'], 'text', ['entry.accept']), 'claim.entry.accept');
  // Commands still win over reservations, inner over outer.
  assert.equal(resolveScreen('classic', 'Ctrl+P', ['report'], 'control'), 'report.print');
  assert.equal(resolveScreen('classic', 'F2', ['report'], 'control'), 'report.period');
  // Escape is never claimed: a field keeps it when nav.back is off.
  assert.equal(resolveScreen('classic', 'Escape', [], 'text', ['nav.back']), undefined);
  // Web-safe is unchanged.
  assert.equal(resolveScreen('web-safe', 'Ctrl+H', ['entry'], 'text'), undefined);
  assert.equal(resolveScreen('web-safe', 'Alt+X', ['list'], 'control', ['list.delete']), undefined);
  assert.deepEqual(reservedClaims('web-safe', 'global'), []);
});

test('only chords with Ctrl, Alt or Meta, and function keys, are ever claimed', () => {
  for (const chord of ['Ctrl+D', 'Alt+F5', 'F1', 'Shift+F3', 'Meta+K', 'Ctrl+Shift+N']) assert.equal(claimable(chord), true, chord);
  for (const chord of ['Escape', 'Enter', 'ArrowDown', 'Tab', 'C', 'Space', 'Shift+A', 'Home', 'Ctrl+A', 'Ctrl+C', 'Ctrl+F']) assert.equal(claimable(chord), false, chord);
  for (const context of ['global', 'list', 'entry', 'report', 'company-home'] as const) for (const chord of reservedClaims('classic', context)) assert.equal(claimable(chord), true);
});

test('every entry screen guards typed work against leaving: route changes ask first and unload warns', () => {
  const entry = readFileSync(new URL('../src/components/masters/entry.tsx', import.meta.url), 'utf8');
  const guard = entry.slice(entry.indexOf('export function useLeaveGuard'));
  assert.match(guard, /useBlocker\(/);
  assert.match(guard, /shouldBlockFn/);
  assert.match(guard, /enableBeforeUnload/);
  const sources = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(new URL(`${entry.name}/`, dir)) : entry.name.endsWith('.tsx') ? [new URL(entry.name, dir)] : []);
  const screens = sources(new URL('../src/components/', import.meta.url)).filter(file => /<EntryScope[\s>]/.test(readFileSync(file, 'utf8')));
  assert.ok(screens.length >= 2, 'the group and ledger forms render EntryScope');
  for (const file of screens) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /useLeaveGuard\(dirty/, `${file.pathname} guards its dirty state`);
    assert.doesNotMatch(source, /setFlash\([^)]*\); leave\(\)/, `${file.pathname} leaves after a save or delete through guard.pass`);
  }
});

test('aria-keyshortcuts lists the keys with Control spelled out', () => {
  assert.equal(ariaKeyShortcuts(['Ctrl+A', 'Ctrl+Enter']), 'Control+A Control+Enter');
  assert.equal(ariaKeyShortcuts(['F1', 'Ctrl+/']), 'F1 Control+/');
  assert.equal(ariaKeyShortcuts([]), undefined);
});

test('rule 1: the clipboard and editing chords, and Ctrl+A where nothing accepts, are never claimed on any screen, dialog or target', () => {
  const contexts = [[], ['company-home'], ['list'], ['entry'], ['report']] as const;
  for (const context of contexts) for (const target of ['text', 'multiline', 'control', 'other'] as const) {
    for (const chord of ['Ctrl+C', 'Ctrl+X', 'Ctrl+V', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z']) {
      assert.equal(resolveScreen('classic', chord, context, target), undefined, `${chord} in ${context.join() || 'global'} on ${target}`);
      assert.equal(resolveInDialog('classic', chord, target), undefined, `${chord} in a dialog on ${target}`);
    }
    // Ctrl+A: only the accept key of an entry screen (D-05) or of a dialog that applies something.
    assert.equal(resolveScreen('classic', 'Ctrl+A', context, target), context[0] === 'entry' && target !== 'control' ? 'entry.accept' : context[0] === 'entry' ? 'entry.accept' : undefined, `Ctrl+A in ${context.join() || 'global'} on ${target}`);
  }
  // A report row selected for copying: nothing takes Ctrl+C or Ctrl+A, though both stay reserved for column actions.
  assert.ok(classicReserved.some(entry => entry.context === 'report' && entry.keys.includes('Ctrl+C') && entry.keys.includes('Ctrl+A')));
  assert.equal(resolveScreen('classic', 'Ctrl+C', ['report'], 'control'), undefined);
  // A viewer's form: accept is off, so Ctrl+A is not claimed (Ctrl+Enter still is).
  assert.equal(resolveScreen('classic', 'Ctrl+A', ['entry'], 'text', ['entry.accept']), undefined);
  assert.equal(resolveScreen('classic', 'Ctrl+Enter', ['entry'], 'text', ['entry.accept']), 'claim.entry.accept');
  // Dialogs: without an apply action Ctrl+A selects; the period dialog applies with it.
  assert.equal(resolveInDialog('classic', 'Ctrl+A', 'text', { accept: false }), undefined);
  assert.equal(resolveInDialog('classic', 'Ctrl+A', 'text'), 'entry.accept');
  for (const chord of neverClaimed) assert.equal(claimable(chord), false, chord);
});

test('rule 2: Ctrl+F is not claimed until a find feature exists', () => {
  for (const context of [[], ['list'], ['entry'], ['report']] as const) for (const target of ['text', 'control'] as const) {
    assert.equal(resolveScreen('classic', 'Ctrl+F', context, target), undefined, `${context.join() || 'global'} on ${target}`);
  }
  assert.equal(resolveInDialog('classic', 'Ctrl+F', 'other'), undefined);
});

test('rule 3: the habit chords are claimed on every list, report and entry screen, fields included, and in dialogs', () => {
  const claimed = ['Ctrl+P', 'Ctrl+D', 'Ctrl+H', 'Ctrl+E', 'Ctrl+B', 'Ctrl+J', 'Ctrl+L', 'Ctrl+U', 'Ctrl+R', 'Ctrl+G', 'F1', 'F3', 'F5', 'F10', 'F12', 'Alt+K', 'Alt+Y', 'Alt+O', 'Alt+E', 'Alt+M', 'Alt+P', 'Alt+F', 'Alt+D'];
  for (const context of [['list'], ['entry'], ['report']] as const) for (const target of ['text', 'control'] as const) for (const chord of claimed) {
    assert.notEqual(resolveScreen('classic', chord, context, target), undefined, `${chord} in ${context[0]} on ${target}`);
  }
  for (const chord of claimed) assert.notEqual(resolveInDialog('classic', chord, 'text'), undefined, `${chord} in a dialog`);
  // Commands still take their keys first: print and export on a report, switch-to everywhere.
  assert.equal(resolveScreen('classic', 'Ctrl+P', ['report'], 'control'), 'report.print');
  assert.equal(resolveScreen('classic', 'Ctrl+G', ['entry'], 'text'), 'nav.switch-to');
  // The habit chords never shadow a global command.
  const globalKeys = registered('classic').filter(command => command.scope === 'global').flatMap(command => command.chords);
  for (const chord of habitChords) assert.ok(!globalKeys.includes(parseChord(chord)!), chord);
  // Web-safe claims none of them.
  assert.equal(resolveScreen('web-safe', 'Ctrl+D', ['report'], 'control'), undefined);
  assert.equal(resolveScreen('web-safe', 'F5', ['list'], 'control'), undefined);
});

test('rule 4: entry screens claim like lists and reports, F10 is claimed on reports, Alt+D on the alter list', () => {
  // A masters form registers no voucher-type or create-in-place command.
  const notOnMastersForms = commandIds.filter(id => id.startsWith('entry.voucher.') || id === 'entry.create-master');
  for (const chord of ['F5', 'Ctrl+B', 'Ctrl+J', 'Alt+D']) assert.equal(resolveScreen('classic', chord, ['entry'], 'text', [], [...notOnMastersForms, 'entry.delete']), 'reserved.global', `${chord} on a form without delete`);
  // A form that can delete runs its own Alt+D; one whose delete is off claims it.
  assert.equal(resolveScreen('classic', 'Alt+D', ['entry'], 'text'), 'entry.delete');
  assert.equal(resolveScreen('classic', 'Alt+D', ['entry'], 'text', ['entry.delete']), 'claim.entry.delete');
  assert.equal(resolveScreen('classic', 'F10', ['report'], 'control'), 'reserved.global');
  // The alter list registers no list.delete: Alt+D is still kept from the browser's address bar.
  assert.equal(resolveScreen('classic', 'Alt+D', ['list'], 'text', [], ['list.delete', 'list.create', 'list.history']), 'reserved.global');
});

test('go-to stacks and switch-to replaces: where Escape leads from the screen they opened', () => {
  const dayBook = '/app/c/x/reports/day-book', trial = '/app/c/x/reports/trial-balance';
  // Alt+G from the day book to the trial balance: Escape there returns to the day book, before the report's own back.
  const fromDayBook = { from: `${dayBook}?from=2026-01-01&to=2026-01-31`, to: trial };
  assert.equal(backSource(trial, fromDayBook, true, true), 'go-to');
  assert.equal(backSource(trial.toUpperCase(), fromDayBook, true, true), 'go-to', 'an address in other letter case is the same screen');
  // Once the user has moved on (a drill-down), that screen's own back applies again.
  assert.equal(backSource('/app/c/x/reports/group-summary', fromDayBook, true, true), 'screen');
  // Ctrl+G leaves no return: the screen goes back its usual way, and switch-to has put the company menu under it.
  assert.equal(backSource(trial, null, true, true), 'screen');
  assert.equal(backSource('/app/c/x/masters/chart-of-accounts', null, false, true), 'shell');
  assert.equal(backSource('/app/c/x', null, false, false), 'none');
  // Both open the same list, on different keys, in classic.
  const merged = mergeKeymaps(keymaps.classic);
  assert.deepEqual([merged['nav.go-to'], merged['nav.switch-to']], [['Alt+G'], ['Ctrl+G']]);
});

test('row and record actions on the bottom bar are Alt chords, bar letters, accept and quit are Ctrl chords', () => {
  const merged = mergeKeymaps(keymaps.classic);
  for (const id of ['list.create', 'list.delete', 'entry.create-master', 'entry.delete'] as const) assert.match(merged[id][0], /^Alt\+/, id);
  for (const id of ['entry.accept', 'nav.quit'] as const) assert.match(merged[id][0], /^Ctrl\+/, id);
  const rowActions = classicReserved.filter(entry => /line|row:/i.test(entry.purpose)).flatMap(entry => entry.keys).filter(key => key !== 'Space');
  assert.ok(rowActions.length >= 6 && rowActions.every(key => key.startsWith('Alt+')), rowActions.join());
});
