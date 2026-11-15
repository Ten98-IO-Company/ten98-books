import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The project has no DOM test setup, so these read the screens' sources; each was also walked in a browser (docs/KEYBOARD.md).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('an invitation link opened while the start page is loaded is read on the hash change, not only on the first load', () => {
  const entry = read('src/routes/index.tsx');
  assert.match(entry, /window\.addEventListener\('hashchange', onHashChange\)/);
  assert.match(entry, /window\.removeEventListener\('hashchange', onHashChange\)/, 'the listener goes with the page');
  // The fragment is scrubbed from the address on the change too, before any request.
  assert.match(entry, /const onHashChange = \(\) => \{\n\s+const next = takeFragment\(\)\n\s+if \(!next\) return\n\s+fragment\.current = next/);
});

test('Switch account on an invitation for another address signs out and shows the invitation again instead of "Sign in to join"', () => {
  const entry = read('src/routes/index.tsx');
  assert.match(entry, /if \(signedInEmail\) \{ await api\('\/api\/auth\/sign-out', \{ method: 'POST', body: \{\} \}\)\.catch\(\(\) => undefined\); setSignedInEmail\(null\); return \}/);
});

test('the session list labels its date column with what it is: the sign-in time', () => {
  assert.match(read('src/components/AccountSecurityPanel.tsx'), /<SessionListFlow [^>]*messages=\{\{ lastActive: 'Signed in' \}\}/);
});

test('the account preferences use the leave guard of the master forms: the same question, opened on Keep editing', () => {
  const panel = read('src/components/AccountPreferencesPanel.tsx');
  assert.match(panel, /useLeaveGuard\(changed,confirm\);/);
  assert.doesNotMatch(panel, /useBlocker/, 'no router blocker of its own');
  assert.doesNotMatch(panel, /Discard your unsaved preferences\?/, 'no wording of its own');
});

test('the company rename is the shared workspace rename flow, with a field error for a blank name and a success notice', () => {
  const settings = read('src/routes/app/c.$companyId.settings.tsx');
  assert.match(settings, /<WorkspaceCreateFlow key=\{company\.name\} mode='rename'/);
  assert.match(settings, /nameBlank: 'Enter the company name\.'/);
  assert.match(settings, /notice=\{notice \? \{ tone: 'success', text: notice \} : undefined\}/);
  assert.match(settings, /if \(cause instanceof ApiError && cause\.status === 401\) \{ unauthorized\(\); return \}/, 'a lost session is handled here');
  assert.doesNotMatch(settings, /<Form /, 'the hand-built form is gone');
});
