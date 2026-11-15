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

test('a rename refused because the role changed elsewhere re-reads the list and keeps the refusal on the read-only page', () => {
  const settings = code('src/routes/app/c.$companyId.settings.tsx');
  assert.match(settings, /setError\(errMsg\(cause\)\)\n\s+if \(cause instanceof ApiError && \(cause\.status === 403 \|\| cause\.status === 404\)\) void reloadCompanies\(\)/);
  assert.match(settings, /\{!manager && error && <Stack ref=\{refusal\} tabIndex=\{-1\}><Alert tone='danger' role='alert' title=\{error\} \/><\/Stack>\}/);
  assert.match(settings, /const refusal = useCallback\(\(alert: HTMLElement \| null\) => \{ alert\?\.focus\(\) \}, \[\]\)/);
});

/** A source without its comments, so a note or a commented-out line cannot satisfy a check. */
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

// The three checks below read call sites that run in effects or event handlers, which a server render does not run and
// the repository has no DOM runner for; the helpers they call are run in tests/focus-and-fragments.test.ts.
test('the start page reads the fragment on load and keeps watching it: a later link restarts the page with its capability', () => {
  const entry = code('src/routes/index.tsx');
  const effect = entry.slice(entry.indexOf('fragment.current = takeAuthFragment(window)'), entry.indexOf('}, [])', entry.indexOf('fragment.current = takeAuthFragment(window)')));
  assert.match(effect, /^fragment\.current = takeAuthFragment\(window\)\n\s+void boot\(\)\n/);
  assert.match(effect, /const stop = watchAuthFragment\(window, next => \{ fragment\.current = next; setPhase\('loading'\); void boot\(\) \}\)/);
  assert.match(effect, /return \(\) => \{ generation\.current\+\+; stop\(\) \}/, 'the watch stops with the page');
});

test('the preferences page counts as changed exactly when its draft differs from the saved values, and guards only then', () => {
  const panel = code('src/components/AccountPreferencesPanel.tsx');
  assert.match(panel, /const saved=data\?savedDraft\(data\):null;\n\s*const changed=preferencesChanged\(draft,saved\);/);
  assert.equal(panel.match(/\bchanged(?=[=,);])/g)?.length, 2, '`changed` is computed once and used once, by the leave guard');
});

test('turning a factor on or off reads the company list again at once, after the change and before the account is re-read', () => {
  const panel = code('src/components/AccountSecurityPanel.tsx');
  const mutate = panel.slice(panel.indexOf('async function mutate'), panel.indexOf('if (data === null)'));
  assert.match(mutate, /commit\?\.\(value\)\n\s+if \(op === 'factor'\) void reloadCompanies\(\)\n\s+await load\(\)/);
  assert.equal(panel.match(/reloadCompanies\(\)/g)?.length, 1, 'only a factor change re-reads it');
});
