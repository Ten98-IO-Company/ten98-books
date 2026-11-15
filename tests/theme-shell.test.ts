import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the saved theme reaches the page through the design system hook, for the signed-in user only', () => {
  const presentation = source('src/lib/account-presentation.tsx');
  assert.match(presentation, /useTheme\(\{value:state\.data\?\.user\.id===userId\?state\.data\.preferences\.theme:null\}\)/, 'another user\'s preferences are never applied');
  assert.doesNotMatch(presentation, /dataset\.theme/, 'the page theme is set in one place, the hook');
});

test('the document head applies the cached theme before the first paint, under the nonce and without unsafe-inline scripts', () => {
  const root = source('src/routes/__root.tsx');
  assert.match(root, /scripts: \[\{ children: createThemeScript\(\) \}\]/, 'the theme script is a head script, so it carries the response nonce');
  assert.match(root, /<html lang='en' suppressHydrationWarning>/, 'the script sets data-theme on html before hydration');
  const policy = root.match(/script-src ([^;]*);/)?.[1] ?? '';
  assert.equal(policy, "'self' 'nonce-${ssr.nonce}'", 'scripts run from this origin or under the nonce only');
});
