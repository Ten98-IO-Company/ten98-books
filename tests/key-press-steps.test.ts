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

test('the lookups use it: Enter on typed text and the accept chord after a pick run in the key press, with React committing in between', () => {
  // The order itself is tested above; this only ties the two call sites to it.
  const lookups = readFileSync(new URL('../src/components/masters/useEntryLookups.ts', import.meta.url), 'utf8');
  const field = readFileSync(new URL('../src/components/masters/LookupField.tsx', import.meta.url), 'utf8');
  assert.match(lookups, /inOnePress\(\{ commit: flushSync, change: \(\) => \{ settle\(field, text, values\) \},\n\s+then: [^\n]*\(\) => advance\(field\)/);
  assert.match(field, /inOnePress\(\{ commit: flushSync, change: \(\) => \{ if \(highlighted\) document\.getElementById\(highlighted\)\?\.click\(\) \}, then: \(\) => accept\?\.run\(\) \}\)/);
  for (const [name, source] of [['useEntryLookups.ts', lookups], ['LookupField.tsx', field]] as const)
    assert.doesNotMatch(source, /setTimeout|requestAnimationFrame/, `${name} defers nothing to a timer`);
});
