import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * The application marker is set in one place, handleApi, so no answer of the API can leave without it: this checks that
 * the API has exactly one server route and that it hands every request, whatever the method, to handleApi. A server
 * route added beside it would answer without the marker and fails here. (The marker on each kind of answer is checked
 * in tests/api-contract.integration.ts.)
 */
test('one server route serves the API, and it hands every request to handleApi', async () => {
  const root = join(import.meta.dirname, '..', 'src', 'routes');
  const files = (await readdir(root, { recursive: true })).filter(file => /\.tsx?$/.test(file));
  const serving: string[] = [];
  for (const file of files) if (/\bserver\s*:/.test(await readFile(join(root, file), 'utf8'))) serving.push(file.replaceAll('\\', '/'));
  assert.deepEqual(serving, ['api/$.ts']);
  const source = await readFile(join(root, 'api', '$.ts'), 'utf8');
  assert.match(source, /server: \{ handlers: \{ ANY: \(\{ request \}\) => handleApi\(request\) \} \}/);
});
