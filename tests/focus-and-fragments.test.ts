import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { takeAuthFragment, watchAuthFragment, type FragmentWindow } from '../src/lib/address-fragment.ts';
import { focusHeadingAfterLoad, headingTakesFocus, pageHeading } from '../src/lib/page-focus.ts';
import { preferencesChanged } from '../src/lib/preferences-draft.ts';
import { shellPageTitle } from '../src/lib/shell-title.ts';
import { createLeaveGuard, FocusMemoryContext, refocusAfterSave, rememberFocusOutsideDialogs, type FocusMemory } from '../src/components/masters/leave-guard.ts';

const token = 'A'.repeat(43);

/** A window with an address, a history and listeners, as the start page uses it. */
function fakeWindow(hash: string) {
  const listeners = new Set<() => void>();
  const replaced: string[] = [];
  const win: FragmentWindow & { fire: () => void; listeners: Set<() => void>; replaced: string[] } = {
    location: { hash, pathname: '/', search: '' },
    history: { state: { key: 'k' }, replaceState: (_state, _unused, url) => { replaced.push(url); win.location.hash = ''; } },
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
    fire: () => { for (const listener of listeners) listener(); },
    listeners, replaced,
  };
  return win;
}

test('the start page reads an invitation from the address and removes the token from the address at once', () => {
  const win = fakeWindow(`#invite=${token}`);
  assert.deepEqual(takeAuthFragment(win), { kind: 'invite', token });
  assert.deepEqual(win.replaced, ['/'], 'the address keeps its path and loses the fragment');
  assert.equal(takeAuthFragment(fakeWindow('')), null);
});

test('an invitation link opened while the start page is loaded (a hash change) is read, its token removed, and passed on', () => {
  const win = fakeWindow('');
  const seen: unknown[] = [];
  const stop = watchAuthFragment(win, fragment => seen.push(fragment));
  assert.equal(win.listeners.size, 1, 'it listens for hash changes');
  win.location.hash = `#invite=${token}`;
  win.fire();
  assert.deepEqual(seen, [{ kind: 'invite', token }]);
  assert.deepEqual(win.replaced, ['/'], 'the token leaves the address');
  win.location.hash = '#elsewhere';
  win.fire();
  assert.equal(seen.length, 1, 'a fragment that is no capability is ignored');
  stop();
  assert.equal(win.listeners.size, 0, 'it stops listening with the page');
});

/** An element the focus helpers can use, recording when it is focused. */
function element(name: string, { connected = true, disabled = false, inDialog = false } = {}) {
  const item = {
    name, focused: 0, isConnected: connected, tabIndex: 0,
    focus: () => { item.focused++; }, getAttribute: (attribute: string) => attribute === 'name' ? name : null,
    matches: (selector: string) => selector === ':disabled' && disabled, closest: (selector: string) => selector === 'dialog' && inDialog ? {} : null,
    hasAttribute: () => false,
  };
  return item;
}

test('after Save on the account page focus goes back to the control that saved, or its place in the remounted form', () => {
  const body = {};
  const saved = element('name', { connected: false });
  const remounted = element('name');
  assert.equal(refocusAfterSave(saved, body, body, selector => selector.startsWith('[name="name"]') ? remounted : null), true);
  assert.equal(remounted.focused, 1, 'the field of the same name in the new form has focus');
  const button = element('');
  assert.equal(refocusAfterSave(button, body, body, () => null), true);
  assert.equal(button.focused, 1, 'the Save button that is still there and enabled has focus');
  const other = element('other');
  const untouched = element('');
  assert.equal(refocusAfterSave(untouched, other, body, () => null), false);
  assert.equal(untouched.focused, 0, 'something that already holds focus keeps it');
});

test('the preferences page has unsaved changes only while the draft differs from what is saved', () => {
  const saved = { name: 'Quinn', timeZone: 'UTC', locale: 'en-US', theme: 'light' };
  assert.equal(preferencesChanged({ ...saved }, saved), false, 'the saved values: nothing to ask');
  assert.equal(preferencesChanged({ ...saved, theme: 'dark' }, saved), true, 'a change: the guard asks and the browser warns');
  assert.equal(preferencesChanged({ ...saved, name: 'Q' }, saved), true);
  assert.equal(preferencesChanged(null, saved), false, 'still loading');
  assert.equal(preferencesChanged(saved, null), false);
});

/** A document for the focus memory: an active element, a body and focusin listeners. */
function fakeDocument(active: unknown) {
  const body = {};
  const listeners = new Set<(event: { target: unknown }) => void>();
  return {
    body, activeElement: active ?? body, listeners,
    addEventListener: (_type: 'focusin', listener: (event: { target: unknown }) => void) => { listeners.add(listener); },
    removeEventListener: (_type: 'focusin', listener: (event: { target: unknown }) => void) => { listeners.delete(listener); },
    focus: (target: unknown) => { for (const listener of listeners) listener({ target }); },
  };
}

test('the shell\'s focus memory keeps the last element focused outside a dialog, and stops with the shell', () => {
  const field = element('name');
  const doc = fakeDocument(field);
  const memory: FocusMemory = { current: null };
  const stop = rememberFocusOutsideDialogs(doc, memory);
  assert.equal(memory.current, field, 'what has focus now is remembered');
  doc.focus(element('menu item', { inDialog: true }));
  assert.equal(memory.current, field, 'a dialog\'s elements are not remembered');
  doc.focus(doc.body);
  assert.equal(memory.current, field, 'nor the body');
  const other = element('other');
  doc.focus(other);
  assert.equal(memory.current, other);
  stop();
  assert.equal(doc.listeners.size, 0);
});

test('"Keep editing" puts focus back on the element the shell remembered; "Discard changes" and a guard without a shell do not', async () => {
  const field = element('name');
  const memory: FocusMemory = { current: field };
  const body = {};
  const global = globalThis as { document?: unknown };
  const previous = global.document;
  global.document = { activeElement: body, body };
  try {
    for (const [answer, withShell, expected] of [[false, true, 1], [true, true, 0], [false, false, 0]] as const) {
      field.focused = 0;
      let guard!: { leave: (exit: () => void) => Promise<boolean> };
      const useGuard = createLeaveGuard(() => undefined);
      const Screen = () => { guard = useGuard(true, async () => answer); return null; };
      renderToString(withShell ? createElement(FocusMemoryContext, { value: memory }, createElement(Screen)) : createElement(Screen));
      await guard.leave(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(field.focused, expected, `answer ${answer ? 'discard' : 'keep editing'}, ${withShell ? 'in' : 'without'} a shell`);
    }
  } finally { global.document = previous; }
});

test('after a full load the page heading takes focus only while nothing else has it', () => {
  const heading = element('h1');
  const main = { querySelector: (selector: string) => selector === 'h1' ? heading : null };
  assert.equal(pageHeading(main), heading);
  assert.equal(pageHeading({ querySelector: () => null }), null);
  const body = {};
  assert.equal(headingTakesFocus(body, body), true);
  assert.equal(headingTakesFocus(null, body), true);
  assert.equal(headingTakesFocus(element('field'), body), false, 'a page that focused its first field or menu keeps it');
  // Applied to a document: the heading on the page gets a tab stop of -1 and focus, once.
  const global = globalThis as { MutationObserver?: unknown };
  const previous = global.MutationObserver;
  global.MutationObserver = class { observe() {} disconnect() {} };
  try {
    const doc = { body, activeElement: body as unknown, querySelector: () => main, addEventListener: () => undefined, removeEventListener: () => undefined };
    const stop = focusHeadingAfterLoad(doc as never, { timeout: 50 });
    assert.equal(heading.focused, 1);
    assert.equal(heading.tabIndex, -1);
    stop();
    const field = element('field');
    const busy = element('h1');
    const doc2 = { body, activeElement: field as unknown, querySelector: () => ({ querySelector: () => busy }), addEventListener: () => undefined, removeEventListener: () => undefined };
    focusHeadingAfterLoad(doc2 as never, { timeout: 50 })();
    assert.equal(busy.focused, 0, 'a page that already put focus somewhere keeps it');
  } finally { global.MutationObserver = previous; }
});

test('the breadcrumb of a company the person is locked out of by its two-factor rule does not say it is to be set up', () => {
  const setUp = { company: {}, twoFactorLocked: false };
  assert.equal(shellPageTitle({ path: '/app/c/x', company: { company: null, twoFactorLocked: true } }), 'Two-factor authentication required');
  assert.equal(shellPageTitle({ path: '/app/c/x', company: { company: null, twoFactorLocked: false } }), 'Set up the company');
  assert.equal(shellPageTitle({ section: 'Masters', path: '/app/c/x/masters', company: setUp }), 'Masters');
  assert.equal(shellPageTitle({ path: '/app/account' }), 'Your account');
  assert.equal(shellPageTitle({ path: '/app/team', company: { company: null, twoFactorLocked: true } }), 'Team');
  assert.equal(shellPageTitle({ path: '/app' }), 'Companies');
});

test('the page-focus rule follows the page as it is drawn, and stops at the first key or pointer press', () => {
  const log: string[] = [];
  const node = (name: string) => ({ name, tabIndex: 0, focus() { log.push(name); doc.activeElement = this }, hasAttribute: () => false });
  const body = {};
  let content: Record<string, unknown> = {};
  const main = { ...node('main'), querySelector: (selector: string) => content[selector] ?? null };
  const listeners = new Map<string, () => void>();
  const doc = {
    body, activeElement: body as unknown, querySelector: (selector: string) => selector === 'main' ? main : null,
    addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener) },
    removeEventListener: (type: string) => { listeners.delete(type) },
  };
  let changed: () => void = () => undefined;
  const global = globalThis as { MutationObserver?: unknown };
  const previous = global.MutationObserver;
  global.MutationObserver = class { constructor(callback: () => void) { changed = callback } observe() {} disconnect() {} };
  try {
    focusHeadingAfterLoad(doc as never, { timeout: 1000 });
    assert.deepEqual(log, ['main'], 'nothing drawn yet: the main area itself');
    content = { '[data-loading-state]': node('loading') };
    changed();
    assert.deepEqual(log, ['main', 'loading'], 'a loading state takes it from the main area');
    content = { h1: node('heading') };
    doc.activeElement = body; // the loading state is gone
    changed();
    assert.deepEqual(log, ['main', 'loading', 'heading']);
    for (const type of ['keydown', 'pointerdown']) assert.ok(listeners.has(type), `${type} stops it`);
    listeners.get('keydown')!();
    assert.equal(listeners.size, 0, 'the first key removes both listeners');
    doc.activeElement = body;
    content = { h1: node('later heading') };
    changed();
    assert.deepEqual(log, ['main', 'loading', 'heading'], 'after a key the rule moves nothing');
  } finally { global.MutationObserver = previous; }
});
