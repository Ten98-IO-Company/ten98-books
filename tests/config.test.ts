import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getConfig, postgresUrl } from '../src/server/config.ts';
import { clientRateKey } from '../src/server/client-rate-limit.ts';

const secret = 'a'.repeat(40);
const base = { DATABASE_URL: 'postgres://app:pw@db.books.test/books', AUTH_SECRET: secret };

function withFile<T>(contents: string, run: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'books-config-'));
  try { const path = join(dir, 'value'); writeFileSync(path, contents); return run(path); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const invalid = (message: RegExp) => (error: unknown) => (error as { code?: string }).code === 'CONFIG_INVALID' && message.test((error as Error).message);

test('a configuration value comes from the variable or from the trimmed file its _FILE names', () => {
  assert.equal(getConfig(base).authSecret, secret);
  withFile(`${secret}\n`, path => assert.equal(getConfig({ DATABASE_URL: base.DATABASE_URL, AUTH_SECRET_FILE: path }).authSecret, secret));
  withFile('postgres://app:pw@file.books.test/books\n', path => assert.equal(postgresUrl('DATABASE_URL', { DATABASE_URL_FILE: path }), 'postgres://app:pw@file.books.test/books'));
  assert.equal(postgresUrl('DATABASE_URL', {}), undefined);
});

test('a variable and its file together, an unreadable file and a short secret are refused as CONFIG_INVALID', () => {
  withFile(secret, path => assert.throws(() => getConfig({ ...base, AUTH_SECRET_FILE: path }), invalid(/Set only AUTH_SECRET or AUTH_SECRET_FILE/)));
  assert.throws(() => getConfig({ DATABASE_URL: base.DATABASE_URL, AUTH_SECRET_FILE: join(tmpdir(), 'books-config-missing', 'secret') }), invalid(/AUTH_SECRET_FILE names a file that cannot be read \(ENOENT\)/));
  assert.throws(() => getConfig({ ...base, AUTH_SECRET: 'too short' }), invalid(/AUTH_SECRET must contain at least 32 characters/));
  assert.throws(() => getConfig({ DATABASE_URL: base.DATABASE_URL }), invalid(/AUTH_SECRET must contain at least 32 characters/));
});

test('a refusal names the key, never the file path or the value', () => {
  const missing = join(tmpdir(), 'books-config-missing', 'secret');
  assert.throws(() => getConfig({ DATABASE_URL: base.DATABASE_URL, AUTH_SECRET_FILE: missing }), (error: Error) => !error.message.includes('books-config-missing'));
  assert.throws(() => getConfig({ ...base, DATABASE_URL: 'mysql://x' }), (error: Error) => /DATABASE_URL must be a PostgreSQL URL/.test(error.message) && !error.message.includes('mysql'));
});

test('the per-client rate key reads AUTH_SECRET through the same reader', () => {
  const request = new Request('http://books.test/api/session');
  assert.match(clientRateKey(request, 'sign-in', base), /^sign-in:client:/);
  assert.throws(() => clientRateKey(request, 'sign-in', { AUTH_SECRET: 'short' }), invalid(/AUTH_SECRET/));
});
