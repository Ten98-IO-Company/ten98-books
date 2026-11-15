import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { balancePreviewInput, counterLedgerQuery, ledgerErrorCodes, nextNumberQuery, sides } from '../src/lib/ledger.ts';
import {
  afterDate, afterDeclinedAccept, afterLedgerInPlace, againstAmount, allocated, appendedLine, billDueDate, billRowBody, billsCover,
  blankDraft, cashModeKey, cashRuleProblem, creditPeriodText, defaultBillMethod, detailSteps, differenceText, draftDirty, draftReducer,
  entryDateLabel, entryDateProblem, entryKinds, escapeStep, layoutsOf, ledgerOptions, lineAccepts, listEnd, negativeCashWarning,
  nextBillRow, openBills, parseCreditPeriod, parseEntryAmount, parseEntryDate, proposedAmount, readLayout, refusalPlace, refusalPlaces,
  relayLines, toVoucherBody, writeLayout, type BillDraft, type EntryLedger, type EntryLine, type PendingChoice,
} from '../src/lib/voucher-entry.ts';
import { readWorkingDate, startingWorkingDate, workingDateKey, writeWorkingDate, type KeyStore } from '../src/lib/working-date.ts';

const line = { ledgerId: randomUUID().toUpperCase(), side: 'Dr', amount: '12.50' };

test('voucher entry read inputs are strict: a real date, known sides, preview lines without bill rows, at most 500 lines', () => {
  assert.equal(nextNumberQuery.safeParse({ date: '2026-02-28' }).success, true);
  for (const value of [{}, { date: '2026-02-29' }, { date: '2026-01-01', extra: '1' }, { date: ['2026-01-01', '2026-01-02'] }]) {
    assert.equal(nextNumberQuery.safeParse(value).success, false, JSON.stringify(value));
  }
  const parsed = balancePreviewInput.parse({ date: '2026-01-31', lines: [line] });
  assert.equal(parsed.lines[0]!.ledgerId, line.ledgerId.toLowerCase(), 'ids are compared in lower case, as elsewhere');
  assert.equal(balancePreviewInput.safeParse({ date: '2026-01-31', lines: Array.from({ length: 500 }, () => line) }).success, true);
  for (const value of [
    { date: '2026-01-31', lines: Array.from({ length: 501 }, () => line) },
    { date: '2026-01-31', lines: [{ ...line, bills: [] }] },
    { date: '2026-01-31', lines: [{ ...line, side: 'Debit' }] },
    { date: '2026-01-31', lines: [{ ...line, amount: '1,000' }] },
    { date: '2026-01-31', voucherId: 'not-an-id', lines: [] },
    { lines: [] },
  ]) assert.equal(balancePreviewInput.safeParse(value).success, false, JSON.stringify(value).slice(0, 80));
  assert.equal(counterLedgerQuery.safeParse({ voucherTypeId: randomUUID(), side: 'Cr' }).success, true);
  for (const value of [{ voucherTypeId: randomUUID() }, { voucherTypeId: randomUUID(), side: 'cr' }, { side: 'Dr' }]) {
    assert.equal(counterLedgerQuery.safeParse(value).success, false, JSON.stringify(value));
  }
});

// ---- The entry screen's pure decisions (src/lib/voucher-entry.ts, src/lib/working-date.ts) ----

const ln = (key: string, side: 'Dr' | 'Cr' | '', ledger: string, amount: string): EntryLine => ({ key, side, ledger, amount });
const memory = (): KeyStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
};
const blocked = (): KeyStore => { throw new Error('SecurityError'); };

test('amounts round half up to the currency places at entry; zero empties the cell; signs and huge values are errors', () => {
  assert.deepEqual(parseEntryAmount('1.235', 2), { value: '1.24' });
  assert.deepEqual(parseEntryAmount('1.225', 2), { value: '1.23' });
  assert.deepEqual(parseEntryAmount('1.2345', 3), { value: '1.235' });
  assert.deepEqual(parseEntryAmount('0.004', 2), { value: '' }, 'rounds to zero: no line');
  assert.deepEqual(parseEntryAmount('0.0005', 3), { value: '0.001' });
  assert.deepEqual(parseEntryAmount('1,250.5', 2), { value: '1250.50' });
  assert.deepEqual(parseEntryAmount('١٢٣٫٤٥', 2), { value: '123.45' }, 'Arabic-Indic digits and separator');
  assert.deepEqual(parseEntryAmount('7', 0), { value: '7' });
  for (const text of ['-5', '1.2.3', 'abc', '99999999999999999999']) assert.ok('error' in parseEntryAmount(text, 2), text);
});

test('dates parse day first in the observed forms, missing parts from the voucher date; refused forms stay refused', () => {
  const current = '2026-07-05';
  const accepted: [string, string][] = [
    ['9', '2026-07-09'], ['10-8', '2026-08-10'], ['11/9/26', '2026-09-11'], ['14.6.26', '2026-06-14'], ['15-10-2026', '2026-10-15'],
    ['17-11-26', '2026-11-17'], ['12 sep', '2026-09-12'], ['18-dec', '2026-12-18'], ['2-1-2026', '2026-01-02'], ['2026-01-31', '2026-01-31'],
    ['٩', '2026-07-09'], ['3 September 2026', '2026-09-03'],
  ];
  for (const [text, value] of accepted) assert.deepEqual(parseEntryDate(text, current), { value }, text);
  for (const text of ['130526', '35', '31-2', 'sep 16', '', '1-13', '29-2-2026', '1-1-202', '12 se']) assert.ok('error' in parseEntryDate(text, current), text);
  assert.equal(entryDateLabel('2026-01-01'), 'Thursday, 1 Jan 2026');
});

test('date bounds: the books beginning, the locked period, and the end of the working date\'s financial year', () => {
  const rules = { booksBeginning: '2026-01-01', lockedThrough: null, financialYearStart: { month: 1, day: 1 } };
  assert.equal(entryDateProblem('2026-06-30', rules, '2026-01-31'), undefined);
  assert.equal(entryDateProblem('2027-01-01', rules, '2026-01-31'), 'Date cannot be after the end of the current financial year, 31 Dec 2026.');
  assert.equal(entryDateProblem('2027-01-01', rules, '2027-01-01'), undefined, 'a working date in the next year moves the bound');
  assert.equal(entryDateProblem('2025-12-31', rules, '2026-01-31'), 'Date cannot be before the books begin, 1 Jan 2026.');
  const midYear = { booksBeginning: '2026-10-15', lockedThrough: null, financialYearStart: { month: 4, day: 1 } };
  assert.match(entryDateProblem('2026-10-14', midYear, '2026-10-15')!, /before the books begin, 15 Oct 2026/, 'books after the year start: the books bound');
  assert.match(entryDateProblem('2027-04-01', midYear, '2026-10-15')!, /31 Mar 2027/);
  assert.match(entryDateProblem('2026-02-10', { ...rules, lockedThrough: '2026-02-28' }, '2026-03-01')!, /locked period.*first open date is 1 Mar 2026/);
});

test('the working date is per tab and company, starts from the last voucher, and survives blocked storage', () => {
  const store = memory();
  assert.equal(readWorkingDate(() => store, 'c1'), null);
  writeWorkingDate(() => store, 'c1', '2026-01-12');
  assert.equal(store.data.get(workingDateKey('c1')), '2026-01-12');
  assert.equal(readWorkingDate(() => store, 'c1'), '2026-01-12');
  assert.equal(readWorkingDate(() => store, 'c2'), null, 'another company has its own');
  writeWorkingDate(() => store, 'c1', 'not a date');
  assert.equal(readWorkingDate(() => store, 'c1'), '2026-01-12');
  store.data.set(workingDateKey('c1'), '2026-02-30');
  assert.equal(readWorkingDate(() => store, 'c1'), null, 'a kept value that is no date is ignored');
  assert.equal(readWorkingDate(blocked, 'c1'), null);
  assert.doesNotThrow(() => writeWorkingDate(blocked, 'c1', '2026-01-01'));
  assert.equal(startingWorkingDate({ lastVoucherDate: null, booksBeginning: '2026-01-01' }), '2026-01-01');
  assert.equal(startingWorkingDate({ lastVoucherDate: '2026-02-03', booksBeginning: '2026-01-01' }), '2026-02-03');
});

test('the cash family\'s layout is kept per tab and company; journal is double entry only; blocked storage gives the defaults', () => {
  const session = memory();
  assert.deepEqual(entryKinds.map(kind => readLayout(kind, () => session, 'c1')), ['single', 'single', 'single', 'double']);
  writeLayout('receipt', 'double', () => session, 'c1');
  assert.equal(session.data.get(cashModeKey('c1')), 'double');
  assert.deepEqual(entryKinds.map(kind => readLayout(kind, () => session, 'c1')), ['double', 'double', 'double', 'double'], 'one choice for the family');
  assert.equal(readLayout('payment', () => session, 'c2'), 'single');
  writeLayout('journal', 'single', () => session, 'c1');
  assert.equal(readLayout('journal', () => session, 'c1'), 'double');
  assert.equal(readLayout('payment', blocked, 'c1'), 'single');
  assert.doesNotThrow(() => writeLayout('payment', 'double', blocked, 'c1'));
  assert.deepEqual(layoutsOf('journal'), ['double']);
});

const ledgers: EntryLedger[] = [
  { id: 'l-wages', name: 'Wages', secondLanguageName: null, cashOrBank: false },
  { id: 'l-bank', name: 'Harbour Bank', secondLanguageName: null, cashOrBank: true },
  { id: 'l-cash', name: 'Cash', secondLanguageName: 'نقد', cashOrBank: true },
  { id: 'l-cust', name: 'Customer North', secondLanguageName: null, cashOrBank: false },
  { id: 'l-cap', name: "Owners' Capital", secondLanguageName: null, cashOrBank: false },
];

test('ledger lists: each list is the set the posting rule accepts there, or a closed list whose other members another layout reaches', () => {
  const accepted = (kind: typeof entryKinds[number]) => new Set(ledgers.filter(ledger => lineAccepts(kind, ledger)).map(ledger => ledger.id));
  for (const kind of entryKinds) for (const layout of layoutsOf(kind)) for (const position of ['account', 'line'] as const) for (const side of [...sides, ''] as const) {
    if (layout === 'double' && position === 'account') continue;
    const lists = ledgerOptions(kind, layout, position, side, ledgers);
    const all = new Set(lists.all.map(option => option.value));
    const name = `${kind} ${layout} ${position} ${side}`;
    assert.ok(lists.defaults.every(option => all.has(option.value)), `${name}: defaults are part of the full set`);
    assert.ok([...all].every(id => accepted(kind).has(id)), `${name}: offers nothing the rule refuses`);
    if (lists.closed && all.size < accepted(kind).size) {
      // Closed and narrower (the single-entry Account): the rest is offered on that side in double entry.
      const wider = new Set(ledgerOptions(kind, 'double', 'line', kind === 'payment' ? 'Cr' : 'Dr', ledgers).all.map(option => option.value));
      assert.ok([...accepted(kind)].every(id => wider.has(id)), `${name}: the rest is reached in double entry`);
    } else assert.deepEqual([...all].sort(), [...accepted(kind)].sort(), `${name}: the whole accepted set`);
  }
  const ids = (options: { value: string }[]) => options.map(option => option.value);
  assert.deepEqual(ids(ledgerOptions('journal', 'double', 'line', 'Dr', ledgers).defaults), ['l-cust', 'l-cap', 'l-wages'], 'journal: no cash or bank until typed, by name');
  assert.ok(ids(ledgerOptions('journal', 'double', 'line', 'Dr', ledgers).all).includes('l-cash'), 'typing finds Cash');
  assert.deepEqual(ids(ledgerOptions('payment', 'single', 'account', '', ledgers).all), ['l-cash', 'l-bank']);
  assert.deepEqual(ids(ledgerOptions('payment', 'double', 'line', 'Cr', ledgers).defaults), ['l-cash', 'l-bank', 'l-cust', 'l-cap', 'l-wages'], 'the paying side: cash and bank first');
  assert.deepEqual(ids(ledgerOptions('receipt', 'double', 'line', 'Dr', ledgers).defaults).slice(0, 2), ['l-cash', 'l-bank']);
  assert.deepEqual(ids(ledgerOptions('receipt', 'double', 'line', 'Cr', ledgers).defaults), ['l-cust', 'l-cap', 'l-wages']);
  assert.deepEqual(ids(ledgerOptions('contra', 'single', 'line', '', ledgers).all), ['l-cash', 'l-bank']);
  assert.equal(ledgerOptions('payment', 'single', 'account', '', ledgers).all[0].description, 'نقد', 'the second-language name is the description');
});

test('the cash and bank rule is checked before sending, on the first line of the side that needs it', () => {
  const isCash = (id: string) => id === 'l-cash' || id === 'l-bank';
  assert.equal(cashRuleProblem('payment', [{ side: 'Dr', ledger: 'l-wages' }, { side: 'Cr', ledger: 'l-bank' }], isCash), undefined);
  assert.equal(cashRuleProblem('payment', [{ side: 'Dr', ledger: 'l-wages' }, { side: 'Cr', ledger: 'l-cap' }], isCash)?.line, 1);
  assert.match(cashRuleProblem('receipt', [{ side: 'Cr', ledger: 'l-cap' }, { side: 'Dr', ledger: 'l-cust' }], isCash)!.message, /debited/);
  assert.equal(cashRuleProblem('contra', [{ side: 'Dr', ledger: 'l-bank' }, { side: 'Cr', ledger: 'l-wages' }], isCash)?.line, 1);
  assert.equal(cashRuleProblem('journal', [{ side: 'Dr', ledger: 'l-wages' }, { side: 'Cr', ledger: 'l-cap' }], isCash), undefined);
});

test('a single-entry payment switched to a journal is re-laid as observed: Dr Bank 7, Dr Expense 7 and an empty Cr line', () => {
  let serial = 10;
  const key = () => `line-${serial++}`;
  const relaid = relayLines({ kind: 'payment', layout: 'single', account: 'l-bank', lines: [ln('line-1', 'Dr', 'l-wages', '7.00'), ln('line-2', 'Dr', '', '')] }, { kind: 'journal', layout: 'double' }, 2, key);
  assert.deepEqual(relaid, { account: '', lines: [ln('line-10', 'Dr', 'l-bank', '7.00'), ln('line-1', 'Dr', 'l-wages', '7.00'), ln('line-11', 'Cr', '', '')] });
  const back = relayLines({ kind: 'journal', layout: 'double', account: '', lines: relaid.lines }, { kind: 'payment', layout: 'single' }, 2, key);
  assert.deepEqual(back, { account: 'l-bank', lines: [ln('line-1', 'Dr', 'l-wages', '7.00')] });
  const receipt = relayLines({ kind: 'payment', layout: 'single', account: 'l-bank', lines: [ln('line-1', 'Dr', 'l-wages', '7.00')] }, { kind: 'receipt', layout: 'single' }, 2, key);
  assert.deepEqual(receipt, { account: 'l-bank', lines: [ln('line-1', 'Cr', 'l-wages', '7.00')] }, 'single to single: the new type\'s particulars side');
  const state = draftReducer({ ...blankDraft('payment', 'single', '2026-01-01'), account: 'l-bank', lines: [ln('line-1', 'Dr', 'l-wages', '7.00')] }, { type: 'switch', kind: 'journal', layout: 'double', exponent: 2 });
  assert.deepEqual([state.kind, state.layout, state.lines.map(entry => `${entry.side} ${entry.ledger} ${entry.amount}`)], ['journal', 'double', ['Dr l-bank 7.00', 'Dr l-wages 7.00', 'Cr  ']]);
  assert.equal(new Set(state.lines.map(entry => entry.key)).size, 3, 'keys stay unique');
});

test('the body: single entry sends the particulars then the Account for the total; double entry its complete lines; bills ride on their lines', () => {
  const bills: Record<string, BillDraft[]> = { 'line-2': [{ key: 'b1', method: 'against_ref', bill: 'bill-1', name: '', credit: '', amount: '600.00', side: 'Cr' }, { key: 'b2', method: 'on_account', bill: '', name: '', credit: '', amount: '400.00', side: 'Cr' }] };
  const single = toVoucherBody({ kind: 'receipt', layout: 'single', account: 'l-bank', lines: [ln('line-1', 'Cr', 'l-cap', '1500.00'), ln('line-2', 'Cr', 'l-cust', '1000.00'), ln('line-3', 'Cr', '', '')],
    idempotencyKey: 'key-12345678', voucherTypeId: 'type-1', date: '2026-01-12', narration: '  ', bills }, 2);
  assert.deepEqual(single, {
    idempotencyKey: 'key-12345678', voucherTypeId: 'type-1', date: '2026-01-12', narration: null, status: 'regular', postDated: false, reference: null, referenceDate: null,
    lines: [
      { ledgerId: 'l-cap', side: 'Cr', amount: '1500.00' },
      { ledgerId: 'l-cust', side: 'Cr', amount: '1000.00', bills: [{ kind: 'against_ref', billId: 'bill-1', amount: '600.00' }, { kind: 'on_account', amount: '400.00' }] },
      { ledgerId: 'l-bank', side: 'Dr', amount: '2500.00' },
    ],
  });
  const contra = toVoucherBody({ kind: 'contra', layout: 'single', account: 'l-bank', lines: [ln('line-1', 'Cr', 'l-cash', '5000.00')], idempotencyKey: 'key-12345678', voucherTypeId: 't', date: '2026-01-04', narration: 'Cash banked', bills: {} }, 2);
  assert.deepEqual(contra.lines, [{ ledgerId: 'l-cash', side: 'Cr', amount: '5000.00' }, { ledgerId: 'l-bank', side: 'Dr', amount: '5000.00' }], 'the contra Account is the receiving side, as the starter dataset');
  const double = toVoucherBody({ kind: 'journal', layout: 'double', account: '', lines: [ln('line-1', 'Dr', 'l-wages', '500.00'), ln('line-2', 'Cr', 'l-cap', '500.00'), ln('line-3', 'Dr', '', '')], idempotencyKey: 'key-12345678', voucherTypeId: 't', date: '2026-01-07', narration: ' Accrued ', bills: {} }, 2);
  assert.deepEqual([double.narration, double.lines], ['Accrued', [{ ledgerId: 'l-wages', side: 'Dr', amount: '500.00' }, { ledgerId: 'l-cap', side: 'Cr', amount: '500.00' }]]);
});

test('the Enter path: a balanced double entry goes from the last amount to Narration, a blank line ends the list, otherwise the grid goes on', () => {
  const balanced = [ln('line-1', 'Dr', 'l-wages', '5.00'), ln('line-2', 'Cr', 'l-cap', '5.00')];
  assert.deepEqual(listEnd({ layout: 'double', lines: balanced, row: 'line-2', column: 'amount', accountIsCash: false, exponent: 2 }), { field: 'narration' });
  const short = [ln('line-1', 'Dr', 'l-wages', '9.00'), ln('line-2', 'Cr', 'l-cap', '4.00')];
  assert.equal(listEnd({ layout: 'double', lines: short, row: 'line-2', column: 'amount', accountIsCash: false, exponent: 2 }), null, 'unbalanced: the grid appends a line');
  assert.equal(listEnd({ layout: 'double', lines: [...balanced, ln('line-3', 'Cr', '', '')], row: 'line-3', column: 'side', accountIsCash: false, exponent: 2 }), null, 'Enter on a side cell moves to the ledger');
  assert.deepEqual(listEnd({ layout: 'double', lines: [...balanced, ln('line-3', 'Cr', '', '')], row: 'line-3', column: 'ledger', accountIsCash: false, exponent: 2 }), { field: 'narration' });
  const single = [ln('line-1', 'Dr', 'l-wages', '7.00'), ln('line-2', 'Dr', '', '')];
  assert.deepEqual(listEnd({ layout: 'single', lines: single, row: 'line-2', column: 'ledger', accountIsCash: false, exponent: 2 }), { field: 'total' }, 'a bank Account: the total stop');
  assert.deepEqual(listEnd({ layout: 'single', lines: single, row: 'line-2', column: 'ledger', accountIsCash: true, exponent: 2 }), { field: 'narration' }, 'a cash Account: straight to Narration');
  assert.equal(listEnd({ layout: 'single', lines: single, row: 'line-1', column: 'amount', accountIsCash: true, exponent: 2 }), null);
});

test('the balancing line: the short side with the counter ledger and the difference, or empty without history; single entry a blank line', () => {
  const short = [ln('line-1', 'Dr', 'l-wages', '9.00'), ln('line-2', 'Cr', 'l-cap', '4.00')];
  assert.deepEqual(appendedLine({ kind: 'journal', layout: 'double', lines: short, counter: 'l-cust', exponent: 2, key: 'line-3' }), ln('line-3', 'Cr', 'l-cust', '5.00'));
  assert.deepEqual(appendedLine({ kind: 'journal', layout: 'double', lines: short, counter: null, exponent: 2, key: 'line-3' }), ln('line-3', 'Cr', '', ''), 'no history: empty, the side still proposed');
  assert.deepEqual(appendedLine({ kind: 'payment', layout: 'single', lines: [ln('line-1', 'Dr', 'l-wages', '7.00')], counter: 'l-cust', exponent: 2, key: 'line-2' }), ln('line-2', 'Dr', '', ''), 'single entry proposes nothing');
  const chosen = [...short, ln('line-3', 'Cr', 'l-cust', '')];
  assert.equal(proposedAmount(chosen, 'line-3', 2), '5.00', 'the difference once a ledger is chosen');
  assert.equal(proposedAmount([...short, ln('line-3', 'Dr', 'l-cust', '')], 'line-3', 2), '', 'not on the side that is ahead');
  assert.equal(differenceText(short, 2), 'Difference 5.00 Dr');
  assert.equal(differenceText([ln('line-1', 'Dr', 'l-wages', '5.00'), ln('line-2', 'Cr', 'l-cap', '5.00')], 2), null);
});

test('focus after No at accept, after the date key, after a ledger alteration; the Escape ladder', () => {
  const lines = [ln('line-1', 'Dr', 'l-wages', '5.00')];
  assert.deepEqual(afterDeclinedAccept('single', lines), { field: 'account' });
  assert.deepEqual(afterDeclinedAccept('double', lines), { cell: { row: 'line-1', column: 'ledger', open: true } });
  assert.deepEqual(afterDate({ cell: { row: 'line-2', column: 'ledger' } }), { cell: { row: 'line-2', column: 'ledger', open: true } }, 'a ledger cell reopens its list');
  assert.deepEqual(afterDate({ cell: { row: 'line-2', column: 'amount' } }), { cell: { row: 'line-2', column: 'amount', edit: false } });
  assert.deepEqual(afterDate({ field: 'narration' }), { field: 'narration' });
  assert.deepEqual(afterLedgerInPlace('saved', 'line-2'), { cell: { row: 'line-2', column: 'amount', edit: true } });
  assert.deepEqual(afterLedgerInPlace('closed', 'line-2'), { cell: { row: 'line-2', column: 'ledger', open: true } });
  assert.equal(escapeStep('5.00', true), 'clear', 'a prefilled amount is emptied first');
  assert.equal(escapeStep('', true), 'ask');
  assert.equal(escapeStep('', false), 'leave');
});

test('the next voucher keeps the type, layout and date only; optional and post-dated are never carried; dirty means something entered', () => {
  const filled = { ...blankDraft('payment', 'double', '2026-01-12'), narration: 'Rent', lines: [ln('line-1', 'Dr', 'l-wages', '5.00')], account: '' };
  assert.equal(draftDirty(filled), true);
  const next = draftReducer(filled, { type: 'next' });
  assert.deepEqual([next.kind, next.layout, next.date, next.narration, next.account, next.lines.length, draftDirty(next)], ['payment', 'double', '2026-01-12', '', '', 1, false]);
  assert.ok(!next.lines.some(entry => filled.lines.some(old => old.key === entry.key)), 'fresh line keys');
  assert.equal(draftDirty(draftReducer(next, { type: 'lines', lines: [ln('line-9', 'Cr', '', '')] })), false, 'a side alone is nothing entered');
  const body = toVoucherBody({ ...next, idempotencyKey: 'key-12345678', voucherTypeId: 't' }, 2);
  assert.deepEqual([body.status, body.postDated], ['regular', false]);
});

const pending: PendingChoice[] = [
  { billId: 'b-10', name: '10', billDate: '2026-07-09', dueDate: '2026-07-24', pending: 1000n, finalPending: 1000n },
  { billId: 'b-a020', name: 'A-020', billDate: '2026-06-25', dueDate: null, pending: 2000n, finalPending: 2000n },
];

test('bill rows: the default method, the lesser amount, the remainder row, cover and the body', () => {
  assert.equal(defaultBillMethod('sales', pending), 'new_ref');
  assert.equal(defaultBillMethod('purchase', []), 'new_ref');
  assert.equal(defaultBillMethod('receipt', pending), 'against_ref', 'pending bills on the other side');
  assert.equal(defaultBillMethod('journal', []), 'on_account');
  assert.equal(defaultBillMethod('payment', []), 'on_account');
  assert.equal(againstAmount(pending[0], 2500n, 2), '10.00', 'the bill\'s pending when the line is larger');
  assert.equal(againstAmount(pending[0], 500n, 2), '5.00', 'what is left of the line when it is smaller');
  const first = nextBillRow({ kind: 'receipt', lineSide: 'Cr', lineAmount: 2500n, rows: [], pending, exponent: 2, key: 'r1' });
  assert.deepEqual([first.method, first.amount, first.side], ['against_ref', '25.00', 'Cr']);
  const rows: BillDraft[] = [{ ...first, bill: 'b-10', amount: '15.00' }];
  assert.deepEqual(openBills(pending, rows, 'Cr', 2).map(bill => bill.name), ['A-020'], 'a bill taken (even over its pending) is no longer open');
  const second = nextBillRow({ kind: 'receipt', lineSide: 'Cr', lineAmount: 2500n, rows, pending, exponent: 2, key: 'r2' });
  assert.deepEqual([second.method, second.amount], ['against_ref', '10.00'], 'the remainder, against again while bills remain');
  const third = nextBillRow({ kind: 'receipt', lineSide: 'Cr', lineAmount: 2500n, rows: [...rows, { ...second, bill: 'b-a020', amount: '20.00', side: 'Dr' }], pending, exponent: 2, key: 'r3' });
  assert.deepEqual([third.method, third.amount], ['on_account', '30.00'], 'an opposite-side row gives back; nothing open: on account');
  assert.equal(allocated([{ ...first, amount: '15.00' }, { ...second, amount: '5.00', side: 'Dr' }], 'Cr', 2), 1000n);
  assert.equal(billsCover([{ ...first, bill: 'b-10', amount: '25.00' }], 'Cr', 2500n, 2), true);
  assert.equal(billsCover([{ ...first, bill: 'b-10', amount: '10.00' }], 'Cr', 2500n, 2), false);
  assert.equal(nextBillRow({ kind: 'sales', lineSide: 'Dr', lineAmount: 100n, rows: [], pending: [], exponent: 2, key: 'r', name: '7' }).name, '7', 'a sales bill is named by the number');
  assert.deepEqual(billRowBody({ key: 'r', method: 'new_ref', bill: '', name: ' INV-1 ', credit: '30', amount: '10.00', side: 'Dr' }, 'Dr', '2026-01-31'),
    { kind: 'new_ref', name: 'INV-1', creditPeriod: { count: 30, unit: 'day' }, amount: '10.00' });
  assert.deepEqual(billRowBody({ key: 'r', method: 'against_ref', bill: 'b-10', name: '', credit: '', amount: '20.00', side: 'Dr' }, 'Cr', '2026-01-31'),
    { kind: 'against_ref', billId: 'b-10', amount: '20.00', side: 'Dr' }, 'a row on the other side says so');
  assert.equal(billRowBody({ key: 'r', method: '', bill: '', name: '', credit: '', amount: '1.00', side: 'Dr' }, 'Dr', '2026-01-31'), null);
});

test('credit periods: the typed forms, and due dates as the database computes them (months clamp to the month end)', () => {
  assert.deepEqual(parseCreditPeriod('30', '2026-01-31'), { value: { count: 30, unit: 'day' } });
  assert.deepEqual(parseCreditPeriod('30 days', '2026-01-31'), { value: { count: 30, unit: 'day' } });
  assert.deepEqual(parseCreditPeriod('2 Weeks', '2026-01-31'), { value: { count: 2, unit: 'week' } });
  assert.deepEqual(parseCreditPeriod('1 Months', '2026-01-31'), { value: { count: 1, unit: 'month' } });
  assert.deepEqual(parseCreditPeriod('15-3-2026', '2026-01-31'), { value: { dueDate: '2026-03-15' } });
  assert.deepEqual(parseCreditPeriod('', '2026-01-31'), { value: null });
  assert.ok('error' in parseCreditPeriod('soon', '2026-01-31'));
  assert.equal(billDueDate('2026-01-31', { count: 1, unit: 'month' }), '2026-02-28', 'observed month-end clamp');
  assert.equal(billDueDate('2026-01-31', { count: 2, unit: 'week' }), '2026-02-14', 'observed');
  assert.equal(billDueDate('2026-12-20', { count: 30, unit: 'day' }), '2027-01-19');
  assert.equal(billDueDate('2028-01-31', { count: 1, unit: 'month' }), '2028-02-29');
  assert.equal(billDueDate('2026-07-05', null), '2026-07-05', 'no period: due on its date (observed)');
  assert.equal(creditPeriodText({ count: 1, unit: 'month' }), '1 month');
  assert.equal(creditPeriodText({ count: 30, unit: 'day' }), '30 days');
});

test('detail steps, the save refusal map (total over the codes) and the negative cash warning', () => {
  assert.deepEqual(detailSteps({ ledger: 'l-cust', amount: '5.00' }, { billWise: true }), ['bills']);
  assert.deepEqual(detailSteps({ ledger: 'l-cust', amount: '' }, { billWise: true }), []);
  assert.deepEqual(detailSteps({ ledger: 'l-wages', amount: '5.00' }, { billWise: false }), []);
  assert.deepEqual(Object.keys(refusalPlaces).sort(), [...ledgerErrorCodes].sort(), 'every code has a place');
  assert.equal(refusalPlace('unbalanced'), 'difference');
  assert.equal(refusalPlace('posting_rule'), 'cash-rule');
  assert.equal(refusalPlace('something_new'), 'alert');
  assert.equal(refusalPlace(undefined), 'alert');
  assert.equal(negativeCashWarning('Cash', -8_000_000n, 2), 'Cash will be 80,000.00 Cr after this voucher.');
  assert.equal(negativeCashWarning('Cash', 0n, 2), null);
});
