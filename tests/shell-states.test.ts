import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement, type ComponentType, type ReactNode } from 'react';
import type { AnyRoute } from '@tanstack/react-router';
import { appModules, renderAt, renderInRouter, testRoute } from './helpers/render.ts';

type Shell = typeof import('../src/components/KeyboardShell.tsx');
let modules: Awaited<ReturnType<typeof appModules>>;
let shell: Shell;
let appContext: typeof import('../src/lib/app-context.ts');
before(async () => {
  modules = await appModules();
  shell = await modules.load<Shell>('/src/components/KeyboardShell.tsx');
  appContext = await modules.load('/src/lib/app-context.ts');
});
after(async () => { await modules.close(); });

const secret = new Error('relation "secret_table" failed at /api/companies/42 with token abc123');
/** Inside the signed-in shell: the real KeyboardShell around the page, with a marker for the sidebar it leaves in place. */
const inShell = (children: ReactNode) => createElement(appContext.AppContext, {
  value: { me: { user: { id: 'u', name: 'U', email: 'u@example.test' }, instanceOperator: false }, companies: [], current: undefined, reloadCompanies: async () => undefined, unauthorized: () => undefined },
}, createElement(shell.KeyboardShell, { userId: 'u', onUnauthorized: () => undefined, children: [createElement('nav', { key: 'nav' }, 'SIDEBAR'), children] }));

test('a page that fails inside the shell is caught by its own route: the shell stays and the error screen shows a fixed text', async () => {
  const { getRouter } = await modules.load<typeof import('../src/router.tsx')>('/src/router.tsx');
  const options = getRouter().options;
  assert.equal(options.defaultErrorComponent, shell.ErrorScreen, 'every route catches its own failure with the app\'s error screen');
  const app = await modules.load<{ Route: { options: { errorComponent?: unknown; notFoundComponent?: unknown } } }>('/src/routes/app.tsx');
  assert.equal(app.Route.options.errorComponent, undefined, 'the /app route does not catch for its children (that would replace the shell)');
  assert.equal(app.Route.options.notFoundComponent, shell.NotFoundScreen);
  // A layout with the shell and a child whose loader throws, rendered with the app's router default. An error thrown while
  // a page renders is caught by the same route boundary only in the browser: React's server renderer runs no error
  // boundaries (it fails the whole render instead), and the repository has no DOM test runner, so that case is the
  // browser walk in docs/KEYBOARD.md, not a test here.
  const { Outlet } = await import('@tanstack/react-router');
  const html = await renderAt('/app/page', root => {
    const layout = testRoute(root, '/app', { component: () => inShell(createElement(Outlet)) });
    return [layout.addChildren([testRoute(layout, '/page', { error: secret })])] as AnyRoute[];
  }, { defaultErrorComponent: options.defaultErrorComponent });
  assert.ok(html.includes('SIDEBAR'), 'the layout around the failed page is still there');
  assert.ok(html.includes(shell.stateCopy.error.title) && html.includes('Try again'));
  for (const part of [secret.message, 'secret_table', '/api/companies/42', 'abc123']) assert.ok(!html.includes(part), `the error's ${part} is not shown`);
  assert.equal((html.match(/<main/g) ?? []).length, 0, 'inside the shell the state screen adds no main landmark (the shell has the page\'s one)');
});

test('outside the shell the root route shows the same screens: a fixed error text, one main landmark', async () => {
  const root = await modules.load<{ Route: { options: { errorComponent?: unknown; notFoundComponent?: unknown } } }>('/src/routes/__root.tsx');
  assert.equal(root.Route.options.errorComponent, shell.ErrorScreen);
  assert.equal(root.Route.options.notFoundComponent, shell.NotFoundScreen);
  const html = await renderAt('/broken', base => [testRoute(base, '/broken', { error: secret })], { defaultErrorComponent: shell.ErrorScreen });
  assert.ok(html.includes(shell.stateCopy.error.message) && html.includes('Try again'));
  assert.ok(!html.includes(secret.message) && !html.includes('secret_table'));
  assert.equal((html.match(/<main/g) ?? []).length, 1);
});

test('"Go to the start page" is a router link to /app inside the shell and to / outside it', async () => {
  const inside = await renderInRouter(() => inShell(createElement(shell.NotFoundScreen)));
  const outside = await renderInRouter(() => createElement(shell.NotFoundScreen));
  assert.match(inside, /<a[^>]*href="\/app"[^>]*>Go to the start page<\/a>/);
  assert.match(outside, /<a[^>]*href="\/"[^>]*>Go to the start page<\/a>/);
  assert.equal(inside.includes('href="/"'), false);
});

test('Company not found reads the same for a company the person is not a member of and for an id that does not exist', async () => {
  const { CompanyUnavailable } = await modules.load<{ CompanyUnavailable: ComponentType<{ kind: 'missing' | 'failed'; message: string; onRetry: () => void }> }>('/src/routes/app/c.$companyId.tsx');
  // What the server answers for each (tests/*.integration.ts and CMP-038: one 404 body for both cases).
  const answer = { error: 'Company not found or unavailable.', code: 'not_found' };
  const page = (message: string) => renderInRouter(() => inShell(createElement(CompanyUnavailable, { kind: 'missing', message, onRetry: () => undefined })));
  const outsider = await page(answer.error);
  const madeUp = await page(answer.error);
  assert.equal(outsider, madeUp);
  assert.ok(outsider.includes('Company not found') && outsider.includes(answer.error) && outsider.includes('href="/app"'));
  assert.ok(!outsider.includes('Try again'), 'not found offers the start page, not a retry');
  // A company that failed to load for another reason (the two-factor rule's 403) is a different screen, with a retry.
  const failed = await renderInRouter(() => inShell(createElement(CompanyUnavailable, { kind: 'failed', message: 'This company requires two-factor authentication.', onRetry: () => undefined })));
  assert.ok(failed.includes('The company could not be loaded') && failed.includes('Try again'));
});

test('reading the same company again keeps its page mounted (a rename keeps its notice in the page); another company does not', async () => {
  const { keptWhileReading } = await modules.load<{ keptWhileReading: <T extends { id: string }>(shown: T | null, id: string) => T | null }>('/src/routes/app/c.$companyId.tsx');
  const company = { id: 'a', name: 'Renamed' };
  assert.equal(keptWhileReading(company, 'a'), company, 'the renamed company stays on screen while it is read again');
  assert.equal(keptWhileReading(company, 'b'), null, 'another company starts from the loading state');
  assert.equal(keptWhileReading(null, 'a'), null);
  // The notice lives only in the settings page's own state: nothing in the history entry, nothing outside React.
  const settings = await modules.load<Record<string, unknown>>('/src/routes/app/c.$companyId.settings.tsx');
  assert.deepEqual(Object.keys(settings), ['Route'], 'the settings module holds no shared state of its own');
});

/** Every element in a React element tree as written (not rendered), for reading the handlers a component hands down. */
function elements(node: unknown): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as { type: unknown; props: Record<string, unknown> };
  return [element, ...elements(element.props.children)];
}

/** Calls `component` as a function inside a router render, so its hooks run, and returns what it rendered and the router. */
async function rendered<P>(component: (props: P) => unknown, props: P, wrap: (child: ReactNode) => ReactNode = child => child) {
  const { useRouter } = await import('@tanstack/react-router');
  let tree: unknown; let router: { invalidate: () => Promise<void> } | undefined;
  const Probe = () => { router = useRouter() as never; tree = component(props); return null };
  await renderInRouter(() => wrap(createElement(Probe)));
  assert.ok(router);
  return { tree, router };
}

/** An element as the focus helpers see it. */
function focusable(name: string, log: string[], children: Record<string, unknown> = {}) {
  return { name, tabIndex: 0, focus() { log.push(name) }, hasAttribute: () => false, querySelector: (selector: string) => children[selector] ?? null };
}

/** Installs a document whose body has focus and whose main area holds `children`, with a MutationObserver that never fires. */
function fakeDocument(log: string[], children: Record<string, unknown>): () => void {
  const body = {};
  const main = focusable('main', log, children);
  const doc = { body, activeElement: body, querySelector: (selector: string) => selector === 'main' ? main : null, addEventListener() {}, removeEventListener() {} };
  const globals = globalThis as Record<string, unknown>;
  const previous = { document: globals.document, MutationObserver: globals.MutationObserver };
  globals.document = doc;
  globals.MutationObserver = class { observe() {} disconnect() {} };
  return () => { globals.document = previous.document; globals.MutationObserver = previous.MutationObserver; };
}

/** A source without its comments, so a note or a commented-out line cannot satisfy a check. */
const code = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('the state screen focuses its heading as it is attached, made focusable first', async () => {
  for (const wrap of [(child: ReactNode) => inShell(child), (child: ReactNode) => child]) {
    const { tree } = await rendered(shell.StateScreen, { state: 'not-found', title: 'Gone', message: 'No page.' }, wrap);
    const log: string[] = [];
    const heading = focusable('h1', log);
    (tree as { props: { ref: (node: unknown) => void } }).props.ref(focusable('holder', log, { h1: heading }));
    assert.deepEqual(log, ['h1']);
    assert.equal(heading.tabIndex, -1);
  }
});

test('"Try again" resets the boundary, reloads the page\'s data through the router and starts the page-focus rule again', async () => {
  const calls: string[] = [];
  const { tree, router } = await rendered(shell.ErrorScreen, { reset: () => calls.push('reset') });
  router.invalidate = async () => { calls.push('invalidate') };
  (tree as { props: { onRetry: () => void } }).props.onRetry();
  assert.deepEqual(calls, ['reset', 'invalidate']);
  // The state screen's button: the retry, then the rule, so the recovered page takes focus instead of the body.
  const { tree: state } = await rendered(shell.StateScreen, { state: 'error', title: 'Failed', message: 'Try again.', onRetry: () => calls.push('retry') }, inShell);
  const button = elements(state).find(element => element.props.children === 'Try again');
  assert.ok(button, 'an error screen offers Try again');
  const log: string[] = [];
  const restore = fakeDocument(log, { h1: focusable('page heading', log) });
  try { (button.props.onClick as () => void)() } finally { restore() }
  assert.deepEqual(calls, ['reset', 'invalidate', 'retry']);
  assert.deepEqual(log, ['page heading'], 'focus goes to the recovered page, not the body');
});

test('a company locked by its two-factor rule sends Escape and "Go back one level" to the account\'s security section', async () => {
  const { CompanyUnavailable, lockedBack } = await modules.load<{ CompanyUnavailable: (props: { kind: 'missing' | 'failed'; message: string; onRetry: () => void; locked?: boolean }) => { props: { backTo?: unknown } }; lockedBack: unknown }>('/src/routes/app/c.$companyId.tsx');
  assert.deepEqual(lockedBack, { to: '/app/account', hash: 'security' });
  const locked = CompanyUnavailable({ kind: 'failed', message: 'This company requires two-factor authentication.', onRetry: () => undefined, locked: true });
  assert.equal(locked.props.backTo, lockedBack);
  assert.equal(CompanyUnavailable({ kind: 'failed', message: 'Failed.', onRetry: () => undefined }).props.backTo, undefined, 'another failure goes to the start page');
  // Where the layout takes `locked` from and how the screen uses it: the back override runs in an effect, which a server
  // render does not run, so these are read from the sources (the walk in docs/KEYBOARD.md presses the keys).
  assert.match(code('../src/routes/app/c.$companyId.tsx'), /locked=\{companies\?\.find\(item => item\.id === companyId\)\?\.twoFactorLocked === true\}/);
  assert.match(code('../src/components/KeyboardShell.tsx'), /useBackOverride\(\(\) => void navigate\(\(backTo \?\? \{ to: start \}\) as never\)\)/);
  assert.match(code('../src/routes/app/account.tsx'), /<Stack id='security' ref=\{focusSecurity\} tabIndex=\{-1\} aria-label='Account security'>/);
});

test('the loading state is a labelled status that can take focus and is marked for the page-focus rule', async () => {
  const html = await renderInRouter(() => inShell(createElement(shell.LoadingState, { message: 'Loading the company…' })));
  assert.match(html, /role="status"/);
  assert.match(html, /tabindex="-1"/);
  assert.match(html, /aria-label="Loading the company…"/);
  assert.match(html, /data-loading-state=""/);
});

test('the real app layout draws its first screen (the account read) as a state screen with a heading and one main landmark', async () => {
  // AppLayout shows the shell only once its account read has answered, and that read starts in an effect, which a server
  // render does not run; so the layout itself is rendered as a full load first draws it, and the failures of a page
  // inside the shell are rendered with the real KeyboardShell around them (the first test and the next). The repository
  // has no DOM test runner to run the effects, and a worker does not add one.
  const app = await modules.load<{ Route: { options: { component: ComponentType } } }>('/src/routes/app.tsx');
  const html = await renderAt('/app', root => [testRoute(root, '/app', { component: app.Route.options.component })]);
  assert.match(html, /<h1[^>]*>Loading<\/h1>/);
  assert.equal((html.match(/<main/g) ?? []).length, 1);
  // The layout starts the page-focus rule from its first render, before the account has loaded (an effect, read here).
  assert.match(code('../src/routes/app.tsx'), /useEffect\(\(\) => focusHeadingAfterLoad\(document\), \[\]\)\n\n\s+const reloadCompanies/);
});

test('a slow page inside the shell shows the loading state, which takes focus only from the body; outside the shell nothing', async () => {
  const { getRouter } = await modules.load<typeof import('../src/router.tsx')>('/src/router.tsx');
  assert.equal(getRouter().options.defaultPendingComponent, shell.PendingScreen);
  const inside = await renderInRouter(() => inShell(createElement(shell.PendingScreen)));
  assert.match(inside, /aria-label="Loading the page…"/);
  assert.match(inside, /data-loading-state=""/);
  const outside = await renderInRouter(() => createElement(shell.PendingScreen));
  assert.doesNotMatch(outside, /Loading the page/, 'the sign-in and invitation pages keep their own loading states');
  // The holder it hands the loading state: focus from the body, a page's own focus left alone, the rule on giving way.
  const { tree } = await rendered(shell.PendingScreen, {}, inShell);
  const hold = (tree as { props: { holder: (node: unknown) => (() => void) | void } }).props.holder;
  const log: string[] = [];
  const status = focusable('status', log);
  // As the loading state gives way it is still in the main area, beside the page that arrived.
  const restore = fakeDocument(log, { h1: focusable('next page heading', log), '[data-loading-state]': status });
  try {
    const doc = (globalThis as { document: { activeElement: unknown; body: unknown } }).document;
    const release = hold(status);
    assert.deepEqual(log, ['status'], 'the page it replaced dropped focus: the loading state takes it');
    doc.activeElement = status;
    release?.();
    assert.deepEqual(log, ['status', 'next page heading'], 'giving way, it hands focus to the page that arrived');
    doc.activeElement = { ...focusable('hidden row of the page being left', log), checkVisibility: () => false };
    hold(focusable('status from a hidden row', log));
    assert.deepEqual(log, ['status', 'next page heading', 'status from a hidden row'], 'focus on the hidden page counts as lost');
    doc.activeElement = { ...focusable('field', log), checkVisibility: () => true };
    hold(focusable('status again', log));
    assert.deepEqual(log, ['status', 'next page heading', 'status from a hidden row'], 'focus held on a shown element is left alone');
  } finally { restore() }
});
