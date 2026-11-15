import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseMoney } from '@ten98/runtime';
import { voucherCreateInput } from '../src/lib/ledger.ts';
import { lineAmount, lineFactor } from '../src/server/ledger/item-lines.ts';
import { derivedRateFits } from '../src/server/ledger/stock-masters.ts';
import { requestHash } from '../src/server/ledger/vouchers.ts';

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

test('a create body without the fields of slice b1 hashes as before them (the value pinned from the code at 0012, dev db8d240)', () => {
  const { idempotencyKey: _key, ...parsed } = voucherCreateInput.parse({ idempotencyKey: 'pin-hash-1', voucherTypeId: '01900000-0000-7000-8000-000000000001', date: '2026-02-01',
    lines: [{ ledgerId: '01900000-0000-7000-8000-000000000002', side: 'Dr', amount: '100.00' }, { ledgerId: '01900000-0000-7000-8000-000000000003', side: 'Cr', amount: '100.00' }] });
  assert.equal(requestHash(parsed), '6c199bc95195d442f90dcc81bcdf25973efa5c26bf7fa29e9f623320a4cf1c85');
  assert.equal('itemLedgerId' in parsed, false);
  assert.equal('inventory' in parsed, false);
  // The same body spelling out "no item lines" means the same thing and hashes the same.
  const spelled = (extra: Record<string, unknown>) => {
    const { idempotencyKey: _key, ...rest } = voucherCreateInput.parse({ idempotencyKey: 'pin-hash-1', voucherTypeId: '01900000-0000-7000-8000-000000000001', date: '2026-02-01',
      lines: [{ ledgerId: '01900000-0000-7000-8000-000000000002', side: 'Dr', amount: '100.00' }, { ledgerId: '01900000-0000-7000-8000-000000000003', side: 'Cr', amount: '100.00' }], ...extra });
    return requestHash(rest);
  };
  assert.equal(spelled({ itemLedgerId: null }), '6c199bc95195d442f90dcc81bcdf25973efa5c26bf7fa29e9f623320a4cf1c85', 'a null item ledger');
  assert.equal(spelled({ inventory: [] }), '6c199bc95195d442f90dcc81bcdf25973efa5c26bf7fa29e9f623320a4cf1c85', 'an empty inventory');
  assert.notEqual(spelled({ itemLedgerId: '01900000-0000-7000-8000-000000000004' }), '6c199bc95195d442f90dcc81bcdf25973efa5c26bf7fa29e9f623320a4cf1c85', 'a named item ledger is a different body');
});

test('a derived rate is checked against the quantity less its discount', () => {
  const nearlyFree = lineFactor('1', '99.9999');
  assert.equal(nearlyFree, '0.000001');
  assert.equal(derivedRateFits(9_999_999_999n, nearlyFree, 2), true, '99,999,999.99 at 99.9999 %: a rate below 10^14');
  assert.equal(derivedRateFits(10_000_000_000n, nearlyFree, 2), false, '100,000,000.00 at 99.9999 %: 10^14');
  assert.equal(derivedRateFits(10_000_000_000n, '1', 2), true, 'without the discount it would fit');
});
