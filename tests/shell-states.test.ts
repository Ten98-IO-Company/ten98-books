import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
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
  // A layout with the shell and a child whose loader throws, rendered with the app's router default.
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
