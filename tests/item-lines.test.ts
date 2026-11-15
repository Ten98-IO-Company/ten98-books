import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseMoney } from '@ten98/runtime';
import { lineAmount, lineFactor } from '../src/server/ledger/item-lines.ts';

/** Item lines' pure checks (M2b slice b1): the migration's scoped region and the line arithmetic. */

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

test('every invoice item line of the demo datasets reproduces its amount: quantity x rate x (1 - discount), half-up, once per line', () => {
  let lines = 0, discounted = 0;
  for (const slug of ['sunrise', 'gulfline', 'najd']) {
    const vouchers = JSON.parse(readFileSync(join(process.cwd(), 'demo', slug, 'vouchers.json'), 'utf8')) as { key: string; type: string; inventory?: { quantity: string; rate: string; amount: string; discountPercent?: string }[] }[];
    for (const voucher of vouchers) {
      if (!['sales', 'purchase', 'credit_note', 'debit_note'].includes(voucher.type)) continue;
      for (const row of voucher.inventory ?? []) {
        lines++;
        if (row.discountPercent) discounted++;
        assert.equal(lineAmount(row.rate, row.quantity, row.discountPercent ?? null, 2), parseMoney(row.amount, 2), `${slug} ${voucher.key}: ${row.quantity} x ${row.rate} less ${row.discountPercent ?? 0} %`);
      }
    }
  }
  assert.deepEqual([lines, discounted], [531, 148], 'the dataset recount');
});

test('the line factor is exact, and rounding is per line', () => {
  assert.equal(lineFactor('4', null), '4');
  assert.equal(lineFactor('1.2345', '12.5'), '1.0801875');
  assert.equal(lineFactor('3', '33.3333'), '2.000001');
  assert.equal(lineAmount('0.33', '3', null, 2), 99n);
  assert.equal(lineAmount('10.00', '1.2345', null, 2), 1235n);
  assert.equal(lineAmount('0.01', '1', '50', 2), 1n, 'half a fils rounds up');
  assert.equal(lineAmount('1.005', '1', null, 3), 1005n);
});
