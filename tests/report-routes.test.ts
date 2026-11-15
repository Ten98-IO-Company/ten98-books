import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'vite';

// Loads every report route as the build does (through vite's module loader, no browser) and tests the route options
// themselves: no source text is read, so dead code or a comment cannot satisfy it.

const folder = new URL('../src/routes/app/', import.meta.url);
const routeFiles = readdirSync(folder).filter(name => /^c\.\$companyId\.reports_\..+\.tsx$/.test(name));

type Options = { validateSearch?: (search: Record<string, unknown>) => Record<string, unknown> };
const hostile: unknown[] = [2027, 0, ['2026-06-30', '2026-07-31'], {}, { a: 1 }, true, false, null, '', 'soon', '2026-02-30', '1850-01-01', '9999-12-31', 'Call support on 000'];
const searchKeys = ['centre', 'detail', 'from', 'fromCentre', 'group', 'hl', 'ledger', 'pages', 'to', 'voucher', 'zeros'];

test('every report route validates its search with reportSearch itself, the balance sheet alone excepted; and that one never returns a raw value', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false, logLevel: 'error', appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { reportSearch } = await server.ssrLoadModule('/src/components/reports/navigation.ts') as { reportSearch: Options['validateSearch'] };
    assert.equal(routeFiles.length, 11, 'the eleven report routes are found');
    for (const name of routeFiles) {
      const { Route } = await server.ssrLoadModule(`/src/routes/app/${name}`) as { Route: { options: Options } };
      const validate = Route.options.validateSearch;
      assert.equal(typeof validate, 'function', `${name} validates its search`);
      if (name.endsWith('.balance-sheet.tsx')) continue;
      assert.equal(validate, reportSearch, `${name} validates with reportSearch itself`);
    }
    // The balance sheet adds the marker of an unread date; whatever it is given, no key of its search is a raw value.
    const { Route } = await server.ssrLoadModule('/src/routes/app/c.$companyId.reports_.balance-sheet.tsx') as { Route: { options: Options } };
    const validate = Route.options.validateSearch!;
    for (const value of hostile) {
      const read = validate(Object.fromEntries([...searchKeys, 'badTo'].map(key => [key, value])));
      for (const key of searchKeys) {
        // A page cursor is a text whose shape is checked, so a text may stay a cursor; any other value may not.
        if (key === 'pages' && typeof value === 'string') continue;
        assert.equal(read[key], key === 'detail' || key === 'zeros' ? (value === true ? true : undefined) : undefined, `${key} from ${JSON.stringify(value)}`);
      }
      assert.ok(read.badTo === undefined || read.badTo === true, `the marker carries no text (${JSON.stringify(value)} gave ${JSON.stringify(read.badTo)})`);
    }
    assert.deepEqual(Object.keys(validate({})).sort(), [...searchKeys, 'badTo'].sort(), 'every key is written, also for an empty address');
  } finally {
    await server.close();
  }
});
