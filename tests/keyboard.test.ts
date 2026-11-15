import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chordFromEvent, findChordConflicts, useLeaveGuard, type ConfirmRequest, type LeaveGuard, isPrintableChord, mergeKeymaps, parseChord, physicalChordFromEvent, reservedChord, resolveShortcut, type ResolvedCommand, type ShortcutPlatform, type ShortcutTarget } from '@ten98/ui';
import { readdirSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterHistory, ariaKeyShortcuts, backSource, commandIds, commands, drilledFrom, heldReturn, type CommandContext, type CommandId, type GoToReturn, type HistoryMove } from '../src/lib/commands.ts';
import { reportLevel } from '../src/lib/reports.ts';
import { browserReservedChords, claimable, classicOnly, classicParity, classicReserved, defaultKeymap, dialogClaims, disabledClaims, habitChords, keymapNames, neverClaimed, keymaps, reservedClaims, reservedShadows, type KeymapName } from '../src/lib/keymaps.ts';
import { lookupKeyAction } from '../src/lib/masters.ts';
import { confirmRequest, type AppConfirmRequest } from '../src/components/useConfirm.ts';

const platforms: readonly ShortcutPlatform[] = ['other', 'apple'];

/** The keymap as the registry sees it: one command per id, scoped by its context, chords in canonical form. */
function registered(name: KeymapName, platform: ShortcutPlatform = 'other'): ResolvedCommand[] {
  const merged = mergeKeymaps(keymaps[name]);
  return commandIds.map(id => ({
    id, scope: commands[id].context, enabled: true,
    chords: (merged[id] ?? []).map(chord => { const canonical = parseChord(chord, platform); assert.ok(canonical, `${name}: ${id} has an invalid chord "${chord}"`); return canonical; }),
  }));
}

/** Commands the screens register with allowInTextInput (entry.tsx, MasterList.tsx under its search field, MasterPicker.tsx, a dialog's accept); a test below reads them from the sources. */
const inTextInput = new Set<string>(['entry.next-field', 'entry.accept', 'entry.cancel', 'list.next', 'list.previous', 'list.open', 'list.cancel']);

/** `popupOpen`: the focused element is a select or holds an open popup (a lookup's list), as the registry checks it. */
function resolve(name: KeymapName, chord: string, contexts: readonly (CommandContext | `${CommandContext}:focus`)[], target: ShortcutTarget = 'other', disabled: readonly string[] = [], popupOpen = false) {
  const scopes = [...contexts.map(entry => ({ id: entry.replace(':focus', ''), focus: entry.endsWith(':focus') })), { id: 'global', focus: false }];
  const commandsNow = registered(name).map(command => ({ ...command, enabled: !disabled.includes(command.id), allowInTextInput: inTextInput.has(command.id) }));
  return resolveShortcut({ chord: parseChord(chord)!, scopes, commands: commandsNow, target, popupOpen })?.command.id;
}

/** Every `.tsx` file under a source folder. */
const sources = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(new URL(`${entry.name}/`, dir)) : entry.name.endsWith('.tsx') ? [new URL(entry.name, dir)] : []);

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

/** The text of the call whose opening parenthesis is at `open`, to its matching close (strings skipped). */
function callAt(source: string, open: number): string {
  let depth = 0, quote = '';
  for (let at = open; at < source.length; at++) {
    const char = source[at];
    if (quote) { if (char === '\\') at++; else if (char === quote) quote = ''; continue; }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return source.slice(open, at + 1);
  }
  return source.slice(open);
}

test('Escape stays with a text field, a select and an open popup: nav.back never leaves from there, a form or picker cancel does', () => {
  for (const name of keymapNames) {
    assert.equal(resolve(name, 'Escape', []), 'nav.back', 'outside a field Escape goes back one level');
    assert.equal(resolve(name, 'Escape', [], 'control'), 'nav.back', 'a focused button or row does not keep Escape');
    for (const target of ['text', 'multiline'] as const) assert.equal(resolve(name, 'Escape', [], target), undefined, `a ${target} field keeps Escape`);
    assert.equal(resolve(name, 'Escape', [], 'control', [], true), undefined, 'a select or a control with its popup open keeps Escape');
    assert.equal(resolve(name, 'Escape', ['report'], 'text'), undefined, 'a report filter keeps Escape');
    // A master form and a picker under its search field cancel from inside the field, as on the catalogue's forms.
    assert.equal(resolve(name, 'Escape', ['entry'], 'text'), 'entry.cancel');
    assert.equal(resolve(name, 'Escape', ['list'], 'text'), 'list.cancel');
    assert.equal(resolve(name, 'Escape', ['entry'], 'text', [], true), undefined, 'a lookup with its list open closes the list first');
  }
  assert.equal(resolve('classic', 'Ctrl+Q', [], 'text'), 'nav.quit', 'classic Ctrl+Q leaves from inside a field');
});

test('the commands that run from a text field are the ones the screens register with allowInTextInput, and nav.back is not one', () => {
  const optedIn = new Set<string>();
  for (const file of sources(new URL('../src/', import.meta.url))) {
    const source = readFileSync(file, 'utf8');
    for (const start of source.matchAll(/useAppCommand\('([a-z.-]+)'/g)) {
      const call = callAt(source, start.index + 'useAppCommand'.length);
      if (/allowInTextInput: (?!false)/.test(call)) optedIn.add(start[1]);
    }
  }
  assert.deepEqual([...optedIn].sort(), [...inTextInput].sort());
  assert.equal(optedIn.has('nav.back'), false);
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
  // The router adapter is the package guard's hook: defined once at module level, never inside the wrapper or a component.
  const adapter = entry.indexOf('const useRouterBlocker: LeaveGuardBlocker');
  assert.ok(adapter > 0 && adapter < entry.indexOf('export function useLeaveGuard'), 'the adapter is a module-level constant');
  assert.match(entry, /const useRouterBlocker: LeaveGuardBlocker = shouldBlock => \{ useBlocker\(\{ shouldBlockFn: shouldBlock, enableBeforeUnload: false \}\) \}/);
  const guard = entry.slice(entry.indexOf('export function useLeaveGuard'), entry.indexOf('export type Failure'));
  assert.match(guard, /usePackageLeaveGuard\(dirty, \{ useBlocker: useRouterBlocker, confirm \}\)/, 'the package guard gets the adapter and the app confirm');
  assert.doesNotMatch(guard, /\bdialog\b/, 'the package guard has no dialog of its own to render here');
  assert.match(guard, /confirm: \(request: AppConfirmRequest\) => Promise<boolean>\)/, 'the confirm is a required argument');
  const screens = sources(new URL('../src/components/', import.meta.url)).filter(file => /<EntryScope[\s>]/.test(readFileSync(file, 'utf8')));
  assert.ok(screens.length >= 2, 'the group and ledger forms render EntryScope');
  for (const file of screens) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /useLeaveGuard\(dirty.*, confirm\)/, `${file.pathname} guards its dirty state with the app confirm`);
    assert.doesNotMatch(source, /setFlash\([^)]*\); leave\(\)/, `${file.pathname} leaves after a save or delete through guard.pass`);
  }
  // The package hook is reached from entry.tsx only, and there always with the app confirm.
  for (const file of sources(new URL('../src/', import.meta.url))) {
    if (file.pathname.endsWith('/src/components/masters/entry.tsx')) continue;
    for (const statement of readFileSync(file, 'utf8').matchAll(/(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@ten98\/ui['"]/g)) {
      assert.doesNotMatch(statement[1], /\buseLeaveGuard\b|\bLeaveGuardBlocker\b/, `${file.pathname} reaches the package guard through entry.tsx`);
    }
  }
});

test('the package leave guard, given the app confirm: no dialog of its own, its default question through that confirm, one question at a time', async () => {
  let guard!: LeaveGuard;
  const asked: ConfirmRequest[] = [];
  const confirm = (request: ConfirmRequest) => new Promise<boolean>(resolve => { asked.push(confirmRequest(request)); setTimeout(() => resolve(false), 5); });
  const Screen = () => { guard = useLeaveGuard(true, { confirm }); return null; };
  renderToString(createElement(Screen));
  assert.equal(guard.dialog, null, 'with a confirm the guard renders no dialog, so its own (confirm-first) dialog is unreachable');
  const exits: string[] = [];
  const first = guard.leave(() => exits.push('first'));
  const second = guard.leave(() => exits.push('second'));
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(asked.length, 1, 'a second attempt while the question is open waits for the same answer');
  assert.deepEqual(exits, [], 'Keep editing runs no exit');
  assert.deepEqual(asked[0], { title: 'Discard unsaved changes?', description: 'Your changes have not been saved.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true, initialFocus: 'cancel' });
});

test('only the app confirmation hook imports the package confirmation pieces, so every question goes through it', () => {
  const files = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(new URL(`${entry.name}/`, dir)) : /\.tsx?$/.test(entry.name) ? [new URL(entry.name, dir)] : []);
  const importers: string[] = [];
  let questions = 0;
  // The package itself, in either quote, not one of its files (`@ten98/ui/styles.css`).
  const pkg = String.raw`['"]@ten98\/ui['"]`;
  for (const file of files(new URL('../src/', import.meta.url))) {
    const source = readFileSync(file, 'utf8');
    const name = file.pathname.slice(file.pathname.indexOf('/src/') + 1);
    // Every way to reach the whole package: a namespace or default import, `export *` and a dynamic import.
    assert.doesNotMatch(source, new RegExp(String.raw`import\s+(?:\*\s*as\s+)?\w+\s*(?:,\s*\{[^}]*\}\s*)?from\s*${pkg}`), `${name} imports the whole package`);
    assert.doesNotMatch(source, new RegExp(String.raw`export\s*\*\s*(?:as\s+\w+\s*)?from\s*${pkg}`), `${name} re-exports the whole package`);
    assert.doesNotMatch(source, new RegExp(String.raw`import\s*\(\s*${pkg}\s*\)`), `${name} imports the package at run time`);
    for (const statement of source.matchAll(new RegExp(String.raw`(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from\s*${pkg}`, 'g'))) {
      if (/\b(?:useConfirmDialog|ConfirmDialog|ConfirmDialogProps)\b/.test(statement[1])) importers.push(name);
    }
    if (name !== 'src/components/useConfirm.ts' && /\buseConfirm\(\)/.test(source)) questions +=source.match(/\bconfirm\(/g)?.length ?? 0;
  }
  assert.deepEqual(importers, ['src/components/useConfirm.ts']);
  // Six deletes, switching cost centres off and the preferences page's question. The leave question of the four master forms is the
  // package guard's, asked through the form's `confirm` (checked above), so it is no call site of its own.
  assert.equal(questions, 8, 'every question is asked through useConfirm');
  // The hook forwards each request through its merge rule, not as the caller wrote it.
  const hook = readFileSync(new URL('../src/components/useConfirm.ts', import.meta.url), 'utf8');
  assert.match(hook, /=>\s*confirm\(confirmRequest\(request\)\)/);
  assert.equal(hook.match(/\bconfirm\(/g)?.length, 1, 'the hook forwards in one place only');
});

test('a confirmation opens on Cancel unless the caller names the confirm button; a spread cannot change that', () => {
  const base = { title: 'Delete?', description: 'Gone for good.' };
  assert.equal(confirmRequest(base).initialFocus, 'cancel');
  assert.equal(confirmRequest({ ...base, danger: true }).initialFocus, 'cancel');
  assert.equal(confirmRequest({ ...base, startOnConfirmButton: true }).initialFocus, 'confirm');
  // A request built elsewhere with the package's own option keeps the application's rule.
  const smuggled = { ...base, initialFocus: 'confirm' } as unknown as AppConfirmRequest;
  assert.equal(confirmRequest({ ...smuggled }).initialFocus, 'cancel');
  assert.equal(confirmRequest({ ...base, startOnConfirmButton: 'yes' } as unknown as AppConfirmRequest).initialFocus, 'cancel');
  assert.equal('startOnConfirmButton' in confirmRequest({ ...base, startOnConfirmButton: true }), false, 'the app option does not reach the package');
  assert.deepEqual(confirmRequest({ ...base, confirmLabel: 'Delete', cancelLabel: 'Keep', danger: true }), { ...base, confirmLabel: 'Delete', cancelLabel: 'Keep', danger: true, initialFocus: 'cancel' });
});

test('menu letters also run by key position on a layout that types another script, still only while the menu has focus', () => {
  const menu = readFileSync(new URL('../src/components/KeyboardMenu.tsx', import.meta.url), 'utf8');
  assert.match(menu, /useAppCommand\(item\.command, item\.open, \{ matchPhysicalKey: true \}\)/, 'MenuItem registers its letter by position too');
  const key = (typed: string, code: string) => ({ key: typed, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
  for (const name of keymapNames) {
    const letters = registered(name).map(command => command.scope === 'company-home' ? { ...command, matchPhysicalKey: true } : command);
    const press = (event: ReturnType<typeof key>, focus = true, target: ShortcutTarget = 'other') => resolveShortcut({
      chord: chordFromEvent(event)!, physicalChord: physicalChordFromEvent(event), target, commands: letters,
      scopes: [{ id: 'company-home', focus }, { id: 'global', focus: false }],
    })?.command.id;
    assert.equal(press(key('t', 'KeyT')), 'home.trial-balance');
    assert.equal(press(key('ف', 'KeyT')), 'home.trial-balance', 'an Arabic layout types another letter on the T key');
    assert.equal(press(key('ف', 'KeyT'), false), undefined, 'a menu without focus takes no letters');
    assert.equal(press(key('ف', 'KeyT'), true, 'text'), undefined, 'typing in a field never opens a report');
    assert.equal(press(key('q', 'KeyA')), undefined, 'a Latin layout with letters elsewhere (AZERTY) goes by the letter typed');
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
  // A masters form registers no voucher-type command; create-in-place is registered switched off (useEntryCommands), a claim.
  const notOnMastersForms = commandIds.filter(id => id.startsWith('entry.voucher.'));
  for (const chord of ['F5', 'Ctrl+B', 'Ctrl+J', 'Alt+D']) assert.equal(resolveScreen('classic', chord, ['entry'], 'text', [], [...notOnMastersForms, 'entry.delete']), 'reserved.global', `${chord} on a form without delete`);
  // Create-in-place is switched off on every masters form, and classic still keeps its chord from the browser.
  assert.equal(resolveScreen('classic', 'Alt+C', ['entry'], 'text', ['entry.create-master']), 'claim.entry.create-master');
  assert.equal(resolveScreen('web-safe', 'Alt+C', ['entry'], 'text', ['entry.create-master']), undefined);
  // A form that can delete runs its own Alt+D; one whose delete is off claims it.
  assert.equal(resolveScreen('classic', 'Alt+D', ['entry'], 'text'), 'entry.delete');
  assert.equal(resolveScreen('classic', 'Alt+D', ['entry'], 'text', ['entry.delete']), 'claim.entry.delete');
  assert.equal(resolveScreen('classic', 'F10', ['report'], 'control'), 'reserved.global');
  // The alter list registers no list.delete: Alt+D is still kept from the browser's address bar.
  assert.equal(resolveScreen('classic', 'Alt+D', ['list'], 'text', [], ['list.delete', 'list.create', 'list.history']), 'reserved.global');
});

/**
 * The shell's back decision walked through key presses, over a model of the browser history:
 * - a push drops the forward entries, and back, forward and go move along them;
 * - the go-to returns follow every history change (afterHistory), as KeyboardShell's history subscription does;
 * - the report trail (useReportNavigation) records a numbered step per drill-down, compares levels with reportLevel,
 *   and on Escape pushes the level it came from;
 * - a masters form's cancel goes back in history (useLeave), and other screens fall back to the company menu.
 */
function shellWalk(start: string) {
  const home = '/app/c/x';
  const entries = [start];
  let cursor = 0, stack: readonly GoToReturn[] = [], drills = 0;
  const trail: { child: string; parent: string; n: number }[] = [];
  const level = () => entries[cursor];
  const path = (at = level()) => at.split('?')[0];
  const step = () => trail.findLast(entry => entry.child === reportLevel(level()))?.n ?? null;
  const move = (type: HistoryMove['type'], trailBack = false) => { stack = afterHistory(stack, { type, index: cursor, path: path(), level: reportLevel(level()), trailBack }); };
  const push = (to: string, trailBack = false) => { entries.splice(cursor + 1, Infinity, to); cursor++; move('PUSH', trailBack); };
  const replace = (to: string) => { entries[cursor] = to; move('REPLACE'); };
  const go = (delta: number) => { cursor += delta; move(delta === -1 ? 'BACK' : delta === 1 ? 'FORWARD' : 'GO'); };
  const isForm = (at: string) => at.includes('/masters/new/') || at.includes('/masters/edit/');
  return {
    get level() { return level(); },
    get returns() { return stack.length; },
    goTo(to: string, { blocked = false } = {}) {
      if (path(to).toLowerCase() === path().toLowerCase()) { replace(to); return; }
      const entry: GoToReturn = { from: level(), to: path(to), level: '', index: -1, fromIndex: cursor, mark: drills, pending: true };
      stack = [...stack, entry];
      if (blocked) { stack = stack.filter(item => item !== entry); return; }
      push(to);
      stack = stack.map(item => item === entry ? { ...entry, level: reportLevel(level()), index: cursor, pending: undefined } : item);
    },
    switchTo(to: string) { replace(home); stack = []; push(to); },
    drill(to: string) {
      const child = reportLevel(to);
      const existing = trail.findIndex(entry => entry.child === child);
      if (existing >= 0) trail.splice(existing);
      trail.push({ child, parent: level(), n: ++drills });
      push(to);
    },
    open: (to: string) => push(to),
    replace,
    back: () => go(-1),
    forward: () => go(1),
    reload() { stack = []; },
    escape() {
      if (isForm(level())) { go(-1); return level(); }
      const innermost = stack[stack.length - 1];
      const source = backSource({ path: path(), index: cursor, step: step() }, stack, { screen: level().includes('/reports/'), shell: level() !== home });
      const held = heldReturn({ path: path(), index: cursor }, stack);
      if (source === 'go-to' && held) { stack = stack.filter(item => item !== held); go(held.fromIndex - cursor); }
      else if (source === 'screen') {
        const index = trail.findLastIndex(entry => entry.child === reportLevel(level()));
        if (index >= 0) { const trailBack = drilledFrom(step(), innermost); push(trail.splice(index)[0].parent, trailBack); } else push(home);
      } else if (source === 'shell') push(home);
      return level();
    },
  };
}

const at = {
  home: '/app/c/x', dayBook: '/app/c/x/reports/day-book?from=2026-01-31&to=2026-01-31', trial: '/app/c/x/reports/trial-balance?from=2026-01-01&to=2026-01-31',
  groups: '/app/c/x/reports/group-summary?from=2026-01-01&to=2026-01-31', group: '/app/c/x/reports/group-summary?from=2026-01-01&to=2026-01-31&group=a',
  monthly: '/app/c/x/reports/ledger-monthly?from=2026-01-01&to=2026-01-31&ledger=l', chart: '/app/c/x/masters/chart-of-accounts',
  ledgerForm: '/app/c/x/masters/edit/ledger/l', newMaster: '/app/c/x/masters/new', newLedger: '/app/c/x/masters/new/ledger',
  register: '/app/c/x/reports/ledger-vouchers?from=2026-01-01&to=2026-01-31&ledger=l',
};

test('go-to stacks: Escape on the screen it opened returns to the origin, and nested go-tos unwind one at a time', () => {
  const walk = shellWalk(at.dayBook);
  walk.goTo(at.trial);
  assert.equal(walk.escape(), at.dayBook);
  assert.equal(walk.returns, 0, 'a used return is spent');
  walk.goTo(at.trial); walk.goTo(at.chart);
  assert.equal(walk.escape(), at.trial);
  assert.equal(walk.escape(), at.dayBook);
  assert.equal(walk.escape(), at.home, 'the day book itself goes back to the menu');
  // An address in other letter case is the same screen.
  const held: GoToReturn = { from: at.dayBook, to: '/app/c/x/reports/trial-balance', level: '', index: 1, fromIndex: 0, mark: 0 };
  assert.equal(backSource({ path: '/APP/C/X/REPORTS/TRIAL-BALANCE', index: 1, step: null }, [held], { screen: true, shell: true }), 'go-to');
});

test('switch-to replaces: Escape on the screen it opened lands on the company menu, and earlier returns are gone', () => {
  const walk = shellWalk(at.dayBook);
  walk.goTo(at.chart);
  walk.switchTo(at.trial);
  assert.equal(walk.returns, 0);
  assert.equal(walk.escape(), at.home);
});

test('a level drilled into after a go-to goes up one level before the go-to return applies (scenario 1)', () => {
  const walk = shellWalk(at.dayBook);
  walk.goTo(at.groups);
  walk.drill(at.group);
  assert.equal(walk.escape(), at.groups);
  assert.equal(walk.escape(), at.dayBook);
  // A drill into another path keeps the return too: trial balance, a group, a ledger's months, back up three times.
  walk.goTo(at.trial); walk.drill(at.group); walk.drill(at.monthly);
  assert.equal(walk.escape(), at.group);
  assert.equal(walk.escape(), at.trial);
  assert.equal(walk.escape(), at.dayBook);
});

test('a spent or abandoned go-to never applies to a later visit of the same screen (scenario 2)', () => {
  const walk = shellWalk(at.dayBook);
  walk.goTo(at.groups); walk.drill(at.group); walk.escape(); walk.escape();
  assert.equal(walk.escape(), at.home);
  walk.open(at.trial); walk.drill(at.groups);
  assert.equal(walk.escape(), at.trial, 'the old origin (the day book) must not come back');
  // Left by a link to the menu and reached again by another push: another entry, so no return.
  const left = shellWalk(at.dayBook);
  left.goTo(at.groups); left.open(at.home); left.open(at.groups);
  assert.equal(left.escape(), at.home, 'the group summary opened again goes back to the menu, not the day book');
});

test('a form opened from the go-to screen and closed again keeps the return (finding 1)', () => {
  // Day book, go-to the chart of accounts, Enter on a ledger, Escape (the form goes back in history), Escape.
  const edit = shellWalk(at.dayBook);
  edit.goTo(at.chart); edit.open(at.ledgerForm);
  assert.equal(edit.escape(), at.chart);
  assert.equal(edit.escape(), at.dayBook);
  // Go-to the new-master list, pick a ledger, Escape, Escape.
  const create = shellWalk(at.dayBook);
  create.goTo(at.newMaster); create.open(at.newLedger);
  assert.equal(create.escape(), at.newMaster);
  assert.equal(create.escape(), at.dayBook);
});

test('a period change or page turn on a drilled level keeps the trail and the return (finding 2)', () => {
  const walk = shellWalk(at.dayBook);
  walk.goTo(at.trial);
  walk.replace('/app/c/x/reports/trial-balance?from=2026-01-01&to=2026-03-31');
  walk.drill('/app/c/x/reports/group-summary?from=2026-01-01&to=2026-03-31&group=a');
  // The period changes on the drilled level (a replace with other dates and a highlight): still the same level.
  walk.replace('/app/c/x/reports/group-summary?from=2026-02-01&to=2026-02-28&group=a&hl=g:b');
  assert.equal(walk.escape(), '/app/c/x/reports/trial-balance?from=2026-01-01&to=2026-03-31');
  assert.equal(walk.escape(), at.dayBook);
  // A register's page turn (a replace adding the earlier pages) is the same level as well.
  walk.goTo(at.trial); walk.drill(at.register);
  walk.replace(`${at.register}&pages=abc`);
  assert.equal(walk.escape(), at.trial);
  assert.equal(walk.escape(), at.dayBook);
});

test('a go-to to the screen already shown records no return (finding 3)', () => {
  const walk = shellWalk(at.trial);
  walk.drill(at.groups);
  walk.goTo(`${at.groups}&hl=g:a`);
  assert.equal(walk.returns, 0);
  assert.equal(walk.escape(), at.trial, 'the group summary goes back the usual way (its trail to the trial balance), not to itself');
});

test('browser back and forward keep a held return on its own entry; a reload or a push over it drops it', () => {
  const walk = shellWalk(at.dayBook);
  walk.goTo(at.trial);
  walk.back();
  assert.equal(walk.level, at.dayBook);
  walk.forward();
  assert.equal(walk.escape(), at.dayBook, 'forward again: the trial balance still returns to the day book');
  // Back, then a push from the origin overwrites the go-to's entry.
  walk.goTo(at.trial); walk.back();
  assert.equal(walk.escape(), at.home);
  assert.equal(walk.returns, 0);
  // A reload forgets every return: Escape falls back to the screen's own logical parent.
  walk.open(at.dayBook); walk.goTo(at.trial); walk.reload();
  assert.equal(walk.escape(), at.home);
});

test('a return held under a later go-to still applies on its own entry (browser back past the later go-to)', () => {
  // Cost centres, go-to the chart of accounts, open a ledger form, go-to the trial balance from the form, browser back to
  // the form, Escape (the form goes back to the chart), Escape: the chart's return still leads to cost centres.
  const walk = shellWalk('/app/c/x/masters/cost-centres');
  walk.goTo(at.chart); walk.open(at.ledgerForm); walk.goTo(at.trial);
  walk.back();
  assert.equal(walk.level, at.ledgerForm);
  assert.equal(walk.escape(), at.chart);
  assert.equal(walk.escape(), '/app/c/x/masters/cost-centres');
  // The later go-to's return is still held on its own entry: forward three times reaches the trial balance, which
  // returns to the form.
  walk.forward(); walk.forward(); walk.forward();
  assert.equal(walk.level, at.trial);
  assert.equal(walk.escape(), at.ledgerForm);
});

test('a go-to to the screen already shown with another address replaces it in place and keeps its return', () => {
  const walk = shellWalk(at.dayBook);
  walk.goTo(at.trial);
  walk.goTo('/app/c/x/reports/trial-balance?from=2026-01-01&to=2026-01-31&hl=g:a');
  assert.equal(walk.returns, 1);
  assert.equal(walk.escape(), at.dayBook);
});

test('a go-to the leave guard keeps from happening leaves no return', () => {
  const walk = shellWalk(at.chart);
  walk.goTo(at.trial, { blocked: true });
  assert.equal(walk.returns, 0);
  assert.equal(walk.level, at.chart);
});

test('a drill step older than the go-to does not take over the screen the go-to opened', () => {
  const walk = shellWalk(at.trial);
  walk.drill(at.groups);
  walk.goTo(at.dayBook); walk.open(at.home); walk.open(at.dayBook);
  walk.goTo(at.groups);
  assert.equal(walk.escape(), at.dayBook);
  assert.equal(backSource({ path: '/app/c/x/reports/group-summary', index: 3, step: 3 }, [], { screen: true, shell: true }), 'screen');
  assert.equal(backSource({ path: '/app/c/x/masters/chart-of-accounts', index: 3, step: null }, [], { screen: false, shell: true }), 'shell');
  assert.equal(backSource({ path: '/app/c/x', index: 0, step: null }, [], { screen: false, shell: false }), 'none');
});

test('afterHistory: pushes drop overwritten entries, replaces keep the same screen, pending returns stay', () => {
  const held: GoToReturn = { from: at.dayBook, to: '/app/c/x/reports/trial-balance', level: 'l', index: 2, fromIndex: 1, mark: 0 };
  const pending: GoToReturn = { ...held, index: -1, pending: true };
  const stack = [held, pending];
  assert.equal(afterHistory(stack, { type: 'PUSH', index: 3, path: '/x', level: 'x' }), stack);
  assert.deepEqual(afterHistory(stack, { type: 'PUSH', index: 2, path: '/x', level: 'x' }), [pending]);
  assert.equal(afterHistory(stack, { type: 'REPLACE', index: 2, path: '/app/c/x/reports/TRIAL-BALANCE', level: 'l' }), stack);
  assert.deepEqual(afterHistory(stack, { type: 'REPLACE', index: 2, path: '/app/c/x', level: 'h' }), [pending]);
  assert.equal(afterHistory(stack, { type: 'BACK', index: 1, path: '/x', level: 'x' }), stack);
  assert.deepEqual(afterHistory([held], { type: 'PUSH', index: 5, path: held.to, level: 'l', trailBack: true }), [{ ...held, index: 5 }]);
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

test('the cost reports open from a focused menu by their letters in both keymaps, which nothing else there holds', () => {
  for (const name of keymapNames) {
    assert.equal(resolve(name, 'Y', ['company-home:focus']), 'report.open.cost-category-summary', name);
    assert.equal(resolve(name, 'U', ['company-home:focus']), 'report.open.cost-centre-breakup', name);
    assert.equal(resolve(name, 'Y', ['company-home:focus'], 'text'), undefined, 'typing in a field never opens a report');
    assert.equal(resolve(name, 'U', ['report']), undefined, 'a menu letter does nothing on a report');
    const holders = (Object.keys(keymaps[name]) as CommandId[]).filter(id => commands[id].context === 'company-home' && [keymaps[name][id]].flat().some(key => key === 'Y' || key === 'U'));
    assert.deepEqual(holders.sort(), ['report.open.cost-category-summary', 'report.open.cost-centre-breakup'], name);
  }
  for (const entry of classicReserved.filter(item => item.context === 'company-home')) assert.ok(!entry.keys.includes('Y') && !entry.keys.includes('U'), 'not a reserved menu letter');
});

test('docs/KEYBOARD.md states the parity counts the code has', () => {
  const doc = readFileSync(new URL('../docs/KEYBOARD.md', import.meta.url), 'utf8');
  const count = (status: string) => Object.values(classicParity).filter(entry => entry.status === status).length;
  assert.ok(doc.includes(`Counts: ${count('same')} same, ${count('alternate')} alternate, ${count('ours')} ours, over ${commandIds.length} commands.`), 'the counts line matches classicParity');
});
