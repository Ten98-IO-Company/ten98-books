import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/** Item lines' pure checks (M2b slice b1). */

test('migration 0013 reads forced-policy rows only inside its all-workspace scope', () => {
  const sql = readFileSync(join(process.cwd(), 'migrations', '0013_item_lines.sql'), 'utf8');
  const opened = sql.indexOf("PERFORM set_config('app.company_ids', coalesce((SELECT string_agg(id, ',') FROM workspace), ''), true);");
  const cleared = sql.lastIndexOf("set_config('app.company_ids', '', true);");
  assert.ok(opened > 0 && cleared > opened, 'the scope is set, then cleared');
  assert.equal(sql.indexOf("set_config('app.company_ids'", sql.indexOf(';', opened)), cleared, 'nothing else sets or clears the scope in between');
  const statements = ['these voucher types have the name the stock journal type takes', 'FROM voucher_type WHERE name_match_key(name) = name_match_key',
    'FOR company_row IN SELECT company_id FROM company LOOP', 'PERFORM ledger_seed_company(company_row.company_id);', 'SET CONSTRAINTS ALL IMMEDIATE;'];
  for (const statement of statements) {
    const at = sql.indexOf(statement);
    assert.ok(at > opened && at < cleared, `inside the scope: ${statement}`);
    assert.equal(sql.indexOf(statement, at + 1), -1, `once: ${statement}`);
  }
  // The only validation-free change to an existing table's rows: the kind check, widened NOT VALID (it reads no row).
  assert.match(sql, /ADD CONSTRAINT voucher_type_kind_check\s+CHECK \([^;]*\) NOT VALID;/);
  assert.equal(sql.indexOf('VALIDATE CONSTRAINT'), -1, 'nothing is validated');
});
