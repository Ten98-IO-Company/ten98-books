import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { afterLoadTarget } from '../src/lib/page-focus.ts';
import { appModules, renderInRouter } from './helpers/render.ts';

/**
 * Focus after a full load, route by route and state by state (docs/KEYBOARD.md, "Behaviour"): the screens are the real
 * components, rendered on the server as a full load first draws them, and `afterLoadTarget` (the rule's pure decision)
 * is asked where focus goes while the body has it. A page that focuses its own first place (a menu, a list, a form's
 * first field, a report's row) does so in an effect once its data is there; until then it shows a loading line and the
 * rule holds focus on the main area. The answer must never be the body or nothing. A refusal (a viewer on a create
 * form, an editor or viewer on the Team page) has a page heading of its own.
 */
let modules: Awaited<ReturnType<typeof appModules>>;
before(async () => { modules = await appModules(); });
after(async () => { await modules.close(); });

type Target = { name: string };
/** The main area of `page` (its `main` element, else all of it), as `afterLoadTarget` reads it: its first h1, else its first h2 or h3, else its loading state. */
function mainArea(page: string) {
  const html = /<main[^>]*>([\s\S]*)<\/main>/.exec(page)?.[1] ?? page;
  const made = new Map<string, Target & { tabIndex: number; focus: () => void; hasAttribute: () => boolean }>();
  const node = (name: string) => made.get(name) ?? made.set(name, { name, tabIndex: 0, focus() {}, hasAttribute: () => false }).get(name)!;
  const text = (inner: string) => inner.replace(/<[^>]+>/g, '').trim();
  const main = {
    ...node('main area'),
    querySelector(selector: string) {
      if (selector === 'h1') { const found = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html); return found ? node(`h1 ${text(found[1])}`) : null; }
      if (selector === 'h2, h3') { const found = /<h([23])[^>]*>([\s\S]*?)<\/h\1>/.exec(html); return found ? node(`h${found[1]} ${text(found[2])}`) : null; }
      if (selector === '[data-loading-state]') return /data-loading-state/.test(html) ? node('loading state') : null;
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  return main;
}

type Role = 'owner' | 'admin' | 'editor' | 'viewer';
const company = { id: 'c1', name: 'Gulfline', baseCurrency: 'AED', currencyMinorUnits: 2, financialYearStart: { day: 1, month: 1 }, booksBeginning: '2026-01-01', timeZone: 'Asia/Dubai', lockedThrough: null, secondLanguageName: null };

test('after a full load focus goes to a named element in the main area on every route and state, never the body', async () => {
  const shell = await modules.load<typeof import('../src/components/KeyboardShell.tsx')>('/src/components/KeyboardShell.tsx');
  const context = await modules.load<typeof import('../src/lib/app-context.ts')>('/src/lib/app-context.ts');
  const layout = await modules.load<{ CompanyUnavailable: ComponentType<{ kind: 'missing' | 'failed'; message: string; onRetry: () => void; locked?: boolean }>; CompanyNotSetUp: ComponentType<{ name: string; onRetry: () => void }> }>('/src/routes/app/c.$companyId.tsx');
  const team = await modules.load<{ Route: { options: { component: ComponentType } } }>('/src/routes/app/team.tsx');
  const masters = await modules.load<{ CreateMaster: ComponentType<{ kind: 'group' | 'ledger' }> }>('/src/components/masters/MasterScreens.tsx');
  const picker = await modules.load<{ NewMasterChoice: ComponentType<{ under?: string }> }>('/src/components/masters/MasterPicker.tsx');
  const cost = await modules.load<{ CreateCost: ComponentType<{ kind: 'cost-category' | 'cost-centre' }> }>('/src/components/masters/CostScreens.tsx');
  const signedIn = (role: Role | null, child: ReactNode) => createElement(context.AppContext, {
    value: {
      me: { user: { id: 'u', name: 'U', email: 'u@example.test' }, instanceOperator: false },
      companies: role ? [{ id: 'c1', name: 'Gulfline', role, company: {}, twoFactorLocked: false }] : [],
      current: role ? { id: 'c1', name: 'Gulfline', role, company: {}, twoFactorLocked: false } : undefined,
      reloadCompanies: async () => undefined, unauthorized: () => undefined,
    } as never,
  }, createElement(shell.KeyboardShell, { userId: 'u', onUnauthorized: () => undefined, children: createElement('main', null, createElement(context.CompanyContext, { value: company as never }, child)) }));

  const rows: [route: string, state: string, screen: ReactNode, expected: string][] = [
    ['/app/c/<id>/…', 'loading the company', createElement(shell.LoadingState, { message: 'Loading the company…' }), 'loading state'],
    ['/app/c/<id>', 'not found (not a member, or no such id)', createElement(layout.CompanyUnavailable, { kind: 'missing', message: 'Company not found or unavailable.', onRetry: () => undefined }), 'h1 Company not found'],
    ['/app/c/<id>', 'locked by the two-factor rule', createElement(layout.CompanyUnavailable, { kind: 'failed', message: 'This company requires two-factor authentication.', onRetry: () => undefined, locked: true }), 'h1 The company could not be loaded'],
    ['/app/c/<id>', 'not set up, member', createElement(layout.CompanyNotSetUp, { name: 'Gulfline', onRetry: () => undefined }), 'h3 Gulfline is not set up yet'],
    ['any page', 'failed', createElement(shell.ErrorScreen), `h1 ${shell.stateCopy.error.title}`],
    ['no route', 'not found', createElement(shell.NotFoundScreen), `h1 ${shell.stateCopy.notFound.title}`],
    ['/app/team', 'viewer', createElement(team.Route.options.component), 'h1 Gulfline team'],
    ['/app/team', 'editor', createElement(team.Route.options.component), 'h1 Gulfline team'],
    ['/app/c/<id>/masters/new/group', 'viewer', createElement(masters.CreateMaster, { kind: 'group' }), 'h1 Create group'],
    ['/app/c/<id>/masters/new/ledger', 'viewer', createElement(masters.CreateMaster, { kind: 'ledger' }), 'h1 Create ledger'],
    ['/app/c/<id>/masters/new', 'viewer', createElement(picker.NewMasterChoice, {}), 'h1 Create a master'],
    ['/app/c/<id>/masters/new/cost-category', 'viewer', createElement(cost.CreateCost, { kind: 'cost-category' }), 'h1 Create cost category'],
    ['/app/c/<id>/masters/new/group', 'editor, chart loading (the form then focuses its first field)', createElement(masters.CreateMaster, { kind: 'group' }), 'main area'],
  ];
  const roles: Record<string, Role> = { viewer: 'viewer', editor: 'editor' };
  const body = {};
  for (const [route, state, screen, expected] of rows) {
    const role = roles[state.split(',')[0]] ?? 'owner';
    const html = await renderInRouter(() => signedIn(role, screen));
    const main = mainArea(html);
    const target = afterLoadTarget(body, body, main) as Target | null;
    assert.ok(target, `${route}, ${state}: focus goes somewhere`);
    assert.equal(target.name, expected, `${route}, ${state}`);
    // A page that puts focus on its own first place keeps it; focus the rule put on the main area or a loading state
    // moves on to the heading once one is drawn.
    assert.equal(afterLoadTarget({}, body, main), null, `${route}, ${state}: a page's own focus is kept`);
  }
  // No main area yet (the scripts have not run): nothing to decide.
  assert.equal(afterLoadTarget(body, body, null), null);
});

test('focus the rule put on the main area or a loading state moves on to the heading when the page draws one', () => {
  const body = {};
  const loadingThenPage = mainArea('<h2>Trial balance</h2><div data-loading-state></div>');
  const main = loadingThenPage as unknown;
  assert.equal((afterLoadTarget(main, body, loadingThenPage) as Target | null)?.name, 'h2 Trial balance');
  const loading = loadingThenPage.querySelector('[data-loading-state]');
  assert.equal((afterLoadTarget(loading, body, loadingThenPage) as Target | null)?.name, 'h2 Trial balance');
  const stillLoading = mainArea('<div data-loading-state></div>');
  assert.equal(afterLoadTarget(stillLoading.querySelector('[data-loading-state]'), body, stillLoading), null, 'already there');
});

test('a viewer\'s master lists say open, not alter: the same keys, the wording of the read-only form', async () => {
  const code = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const picker = code('../src/components/masters/MasterPicker.tsx');
  assert.match(picker, /const verb = useCanWrite\(\) === false \? 'open' : 'alter'/);
  assert.match(picker, /title=\{verb === 'open' \? 'Open a master' : 'Alter a master'\}/);
  assert.match(picker, /openHint=\{`Enter to \$\{verb\}`\}/);
  for (const file of ['ChartOfAccounts.tsx', 'CostCentreList.tsx']) {
    const list = code(`../src/components/masters/${file}`);
    assert.match(list, /then Enter to \$\{writer === false \? 'open' : 'alter'\} the highlighted row\./, file);
    assert.match(list, /openHint=\{writer === false \? 'Enter to open' : 'Enter to alter'\}/, file);
    assert.doesNotMatch(list, /openHint='Enter to alter'/, `${file}: no fixed alter hint`);
  }
});
