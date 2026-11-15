import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The project has no DOM test setup, so these read the screens' sources; each was also walked in a browser (docs/KEYBOARD.md).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Switch account on an invitation for another address signs out and shows the invitation again instead of "Sign in to join"', () => {
  // The signed-out invitation decides what to offer (InvitePanel); this ties the switch to it. Walked in the browser.
  const entry = read('src/routes/index.tsx');
  assert.match(entry, /if \(signedInEmail\) \{\n\s+await api\('\/api\/auth\/sign-out'[^\n]*\n(?:\s+\/\/[^\n]*\n)+\s+flushSync\(\(\) => setSignedInEmail\(null\)\)\n\s+focusHeadingAfterLoad\(document\)\n\s+return\n\s+\}/);
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
  // The notice is this page's own state: the company layout keeps the page mounted while it reads the renamed company
  // again, so nothing is stored in the history entry or outside React.
  assert.doesNotMatch(settings, /HistoryState|router.history/, 'no history mark');
  assert.doesNotMatch(settings, /new (Set|Map)\(/, 'no module-level hand-over');
});
