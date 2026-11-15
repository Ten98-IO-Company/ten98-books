import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { inOnePress } from '../src/lib/key-press-steps.ts';

/** Runs one key press with the steps recording what happened, and checks no timer was asked for. */
function press(withThen: boolean) {
  const steps: string[] = [];
  const timers: unknown[] = [];
  const realTimeout = globalThis.setTimeout;
  const realFrame = globalThis.requestAnimationFrame;
  globalThis.setTimeout = ((...args: unknown[]) => { timers.push(args); return 0; }) as typeof setTimeout;
  globalThis.requestAnimationFrame = ((callback: unknown) => { timers.push(callback); return 0; }) as typeof requestAnimationFrame;
  try {
    inOnePress({
      // As React's flushSync: the change runs and is committed to the page before commit returns.
      commit: work => { steps.push('commit:start'); work(); steps.push('commit:done (page shows the change)'); },
      change: () => { steps.push('change (lookup settled)'); },
      then: withThen ? () => { steps.push('then (focus the next field)'); } : undefined,
    });
    steps.push('handler returns');
  } finally {
    globalThis.setTimeout = realTimeout;
    globalThis.requestAnimationFrame = realFrame;
  }
  return { steps, timers };
}

test('a key that changes a lookup and moves on does both before its handler returns: commit the change, then move, no timer', () => {
  const { steps, timers } = press(true);
  assert.deepEqual(steps, ['commit:start', 'change (lookup settled)', 'commit:done (page shows the change)', 'then (focus the next field)', 'handler returns']);
  assert.deepEqual(timers, [], 'nothing waits for a timer or a frame, so a key typed straight after cannot reach the field just answered');
});

test('with nothing to do after the change (an error on the field, or a key that does not move) only the change runs', () => {
  const { steps, timers } = press(false);
  assert.deepEqual(steps, ['commit:start', 'change (lookup settled)', 'commit:done (page shows the change)', 'handler returns']);
  assert.deepEqual(timers, []);
});

/** A source file without its comments, so a commented-out call or a note cannot satisfy a check. */
const code = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** The text of the `inOnePress({ ... })` call that starts at `from` in `source`. */
function pressCall(source: string, from: number): string {
  const then = source.indexOf('then:', from);
  return source.slice(from, source.indexOf('})', then === -1 ? from : then) + 2);
}

/** Asserts that `parts` appear in `text` in this order, each once. */
function inOrder(text: string, parts: readonly string[], where: string) {
  let last = -1;
  for (const part of parts) {
    assert.equal(text.split(part).length - 1, 1, `${where}: "${part}" appears once`);
    const at = text.indexOf(part);
    assert.ok(at > last, `${where}: "${part}" comes after the step before it`);
    last = at;
  }
}

test('the lookups use it: the pick is committed before focus moves or the save starts, in the key press', () => {
  // A source check, because the repository has no DOM test runner; the behaviour is proved by the real-key walk in
  // docs/KEYBOARD.md (ledger, group, cost category and cost centre lookups, text typed straight after Enter or the accept
  // chord, in both keymaps). The order of the helper itself is run in the tests above.
  const lookups = code('../src/components/masters/useEntryLookups.ts');
  const typedEnter = lookups.slice(lookups.indexOf('function typedEnter('), lookups.indexOf('function settleAll('));
  const enter = typedEnter.indexOf('inOnePress({');
  assert.ok(enter >= 0, 'Enter on typed text goes through inOnePress');
  const enterCall = pressCall(typedEnter, enter);
  inOrder(enterCall, ['commit: flushSync', 'settle(field, text, values)', 'then:', 'advance(field)'], 'typedEnter');
  for (const step of ['settle(field, text, values)', 'advance(field)'])
    assert.equal(typedEnter.split(step).length - 1, 1, `typedEnter calls ${step} only inside the key press`);

  const field = code('../src/components/masters/LookupField.tsx');
  const handler = field.slice(field.indexOf('onKeyDownCapture='), field.indexOf('<Combobox {'));
  const pick = handler.indexOf('inOnePress({');
  assert.ok(pick >= 0, 'the accept chord after a highlighted row goes through inOnePress');
  const pickCall = pressCall(handler, pick);
  inOrder(pickCall, ['commit: flushSync', '.click()', 'then:', 'accept?.run()'], 'accept after a pick');
  assert.equal(handler.split('.click()').length - 1, 1, 'the row is picked only inside the key press');
  // Typed text with no row: onTypedEnter commits its own pick (typedEnter above), then accept runs at once.
  const rest = handler.slice(pick + pickCall.length);
  inOrder(rest, ['onTypedEnter?.(input.value, false)', 'accept?.run()'], 'accept after typed text');
  for (const [name, source] of [['useEntryLookups.ts', lookups], ['LookupField.tsx', field]] as const)
    assert.doesNotMatch(source, /setTimeout|requestAnimationFrame/, `${name} defers nothing to a timer`);
});
