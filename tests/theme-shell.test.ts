import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { themeScript } from '../src/lib/theme-script.ts';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the saved theme reaches the page through the design system hook, for the signed-in user only', () => {
  const presentation = source('src/lib/account-presentation.tsx');
  assert.match(presentation, /useTheme\(\{value:state\.data\?\.user\.id===userId\?state\.data\.preferences\.theme:null\}\)/, 'another user\'s preferences are never applied');
  assert.doesNotMatch(presentation, /dataset\.theme/, 'the page theme is set in one place, the hook');
});

test('the document head applies the cached theme before the first paint, under the nonce and without unsafe-inline scripts', () => {
  const root = source('src/routes/__root.tsx');
  assert.match(root, /scripts: \[\{ children: themeScript \}\]/, 'the theme script is a head script, so it carries the response nonce');
  assert.match(root, /<html lang='en' suppressHydrationWarning>/, 'the script sets data-theme on html before hydration');
  const policy = root.match(/script-src ([^;]*);/)?.[1] ?? '';
  assert.equal(policy, "'self' 'nonce-${ssr.nonce}'", 'scripts run from this origin or under the nonce only');
});

/** Runs the head script against a fake document and storage; returns every value written to `data-theme`. */
function runThemeScript(initial: string | undefined, storage: 'dark' | 'stale-light' | 'blocked'): { writes: string[]; theme: string | undefined; storageReads: number } {
  const writes: string[] = [];
  let theme = initial;
  let storageReads = 0;
  const dataset = { get theme() { return theme; }, set theme(value: string | undefined) { theme = value; writes.push(String(value)); } };
  const localStorage = { getItem: () => { storageReads++; if (storage === 'blocked') throw new Error('blocked'); return storage === 'dark' ? 'dark' : 'light'; } };
  vm.runInNewContext(themeScript, { document: { documentElement: { dataset } }, localStorage });
  return { writes, theme, storageReads };
}

test('the head script applies the cached theme on a first load and never rewrites a theme the page already has', () => {
  // First load: the server markup has no theme, so the cached one is applied (system when storage is blocked).
  assert.deepEqual(runThemeScript(undefined, 'dark').writes, ['dark']);
  assert.deepEqual(runThemeScript(undefined, 'blocked').writes, ['system']);
  // A client navigation runs it again: useTheme has set the account's theme, so a stale cache or blocked storage changes nothing.
  for (const storage of ['stale-light', 'blocked'] as const) {
    const run = runThemeScript('dark', storage);
    assert.deepEqual(run.writes, [], storage);
    assert.equal(run.theme, 'dark');
    assert.equal(run.storageReads, 0, 'storage is not even read');
  }
});
