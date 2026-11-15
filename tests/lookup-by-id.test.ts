import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * Migration 0014's statement order. Its pre-check counts rows sharing an id under the all-company scope (outside it the
 * forced policy hides every row and the check passes without looking), and stops the migration before any index is
 * built, so a duplicate can never surface as an index error naming an id. So: the scope is set, the counts run, the
 * scope is cleared, and only then the refusal and every index statement, each once; the file writes no row.
 */
test('migration 0014 counts shared ids inside its all-company scope, before any index statement', () => {
  const sql = readFileSync(join(process.cwd(), 'migrations', '0014_lookup_by_id.sql'), 'utf8');
  const code = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
  const opened = code.indexOf("PERFORM set_config('app.company_ids', coalesce((SELECT string_agg(id, ',') FROM workspace), ''), true);");
  const cleared = code.indexOf("PERFORM set_config('app.company_ids', '', true);");
  assert.ok(opened > 0 && cleared > opened, 'the scope is set, then cleared');
  assert.equal(code.indexOf("PERFORM set_config('app.company_ids'", code.indexOf(';', opened)), cleared, 'nothing else sets or clears the scope in between');
  for (const table of ['ledger', 'stock_item', 'stock_unit', 'voucher', 'voucher_type']) {
    const counted = code.indexOf(`FROM (SELECT id FROM ${table} GROUP BY id HAVING count(*) > 1)`);
    assert.ok(counted > opened && counted < cleared, `${table} is counted inside the scope`);
  }
  const refusal = code.indexOf('RAISE EXCEPTION');
  assert.ok(refusal > cleared, 'the refusal follows the counts');
  const statements = ['CREATE UNIQUE INDEX voucher_id_key ON voucher (id);', 'CREATE UNIQUE INDEX ledger_id_key ON ledger (id);',
    'CREATE UNIQUE INDEX stock_item_id_key ON stock_item (id);', 'CREATE UNIQUE INDEX stock_unit_id_key ON stock_unit (id);',
    'CREATE UNIQUE INDEX voucher_type_id_key ON voucher_type (id);', 'DROP INDEX inventory_line_item_idx;',
    'CREATE INDEX inventory_line_item_idx ON inventory_line (item_id, location_id) INCLUDE (direction, quantity, amount);'];
  let last = refusal;
  for (const statement of statements) {
    const at = code.indexOf(statement);
    assert.ok(at > last, `in order, after the pre-check: ${statement}`);
    assert.equal(code.indexOf(statement, at + 1), -1, `once: ${statement}`);
    last = at;
  }
  assert.equal(code.match(/\b(INSERT|UPDATE|DELETE)\b/g), null, 'the file writes no row');
  assert.equal(code.match(/CREATE (UNIQUE )?INDEX|DROP INDEX/g)?.length, statements.length, 'no other index statement');
});
