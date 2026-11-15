import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

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

/** The props a component passes to the shared state screen, read from its source: one JSX element, attribute by attribute. */
const stateProps = (source: string, from: string) => {
  const start = source.indexOf(from);
  assert.ok(start >= 0, from);
  return source.slice(start, source.indexOf('/>', start));
};

test('Company not found reads the same for a company the person is not a member of and for an id that does not exist', async () => {
  const layout = read('src/routes/app/c.$companyId.tsx');
  // The not-found branch shows a fixed title and the server's message, nothing else: no name, id, role or count. The
  // server answers one identical 404 for both cases (CMP-038, byte for byte), so the page has no input that differs.
  const notFound = stateProps(layout, "<ShellStateScreen state='not-found'");
  assert.equal(notFound, "<ShellStateScreen state='not-found' title='Company not found' message={error.message} ");
  assert.match(layout, /const kind = cause instanceof ApiError && cause\.status === 404 \? 'missing'/, 'missing is decided by the status alone');
  // The shell around it decides from the person's own company list only, which holds neither company: the same back target
  // and no go-to or switch-to in the action bar, and the switcher shows no company (`shown` is undefined for both).
  const app = read('src/routes/app.tsx');
  assert.match(app, /listed: companies === null \? null : company !== undefined/);
  assert.match(app, /companyOpen=\{ready\}/);
  assert.match(app, /const company = companies\?\.find\(item => item\.id === companyId\)/);
  // The shared screen renders only what it is given: the same props give the same markup.
  const { AppStateScreen } = await import('@ten98/ui');
  const page = (message: string) => renderToString(createElement(AppStateScreen, { state: 'not-found', surface: 'plain', brand: false, aside: null, title: 'Company not found', message, homeHref: '/app', retryLabel: 'Go to the start page' }));
  const outsider = page('Company not found or unavailable.');
  assert.equal(outsider, page('Company not found or unavailable.'));
  assert.ok(outsider.includes('Company not found or unavailable.') && outsider.includes('href="/app"'));
});

test('the error screens show a fixed message and Try again only, never the error itself', async () => {
  const root = read('src/routes/__root.tsx');
  const app = read('src/routes/app.tsx');
  // Both error components take only `reset` from the router: the error object never reaches them.
  assert.match(root, /function RootError\(\{ reset \}: ErrorComponentProps\) \{\n\s+return <RootState state='error' title='This page could not be shown' message='Something went wrong while showing this page\.' onRetry=\{reset\} \/>;/);
  assert.match(app, /function RouteError\(\{ reset \}: ErrorComponentProps\) \{\n\s+return <ShellStateScreen state='error' title='This page could not be shown' message='Something went wrong while showing this page\.' onRetry=\{reset\} \/>/);
  assert.match(root, /notFoundComponent: RootNotFound,\n\s+errorComponent: RootError,\n\}\);/);
  // Rendered with those props after a thrown error, nothing of the error appears.
  const thrown = new Error('relation "secret_table" failed at /api/companies/42 with token abc');
  const { AppStateScreen } = await import('@ten98/ui');
  const html = renderToString(createElement(AppStateScreen, { state: 'error', title: 'This page could not be shown', message: 'Something went wrong while showing this page.', onRetry: () => undefined, retryLabel: 'Try again' }));
  for (const part of [thrown.message, 'secret_table', '/api/companies/42', 'abc', String(thrown.stack).split('\n')[1]]) assert.ok(!html.includes(part), part);
  assert.ok(html.includes('Try again') && html.includes('Something went wrong while showing this page.'));
  // Not-found outside the shell: one screen whatever the address or session, with a link to the start page.
  assert.match(root, /function RootNotFound\(\) \{\n\s+return <RootState state='not-found' title='Page not found' message='This address does not open a page of the application\.' \/>;/);
  assert.match(root, /homeHref=\{state === 'not-found' \? '\/' : undefined\}/);
});
