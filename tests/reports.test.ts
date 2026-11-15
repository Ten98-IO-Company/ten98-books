/*
 * Report screens have no DOM test runner, so each decision a screen makes is a pure function in src/lib/reports.ts and is
 * tested here. Only a walk proves what these cannot: that the choosers' find field has focus on arrival (autoFocus), that
 * Escape from an empty field goes back through the shell, that the movement keys reach the table from the field, that the
 * scope line and the failure buttons render what the functions return, and that the cost list calls its notice function.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import type { AccountGroup } from '../src/lib/ledger.ts';
import { addressDate, asAtPeriod, balanceSheetDates, centreOriginNotice, chooserFilters, costCentresOffNotice, failureActions, lineToOpen, listTarget, monthlyClipNotice, readReportSearch, unreadableTo, narrowByName, pickerEscape, restoredFilter, scopeLine, unreadableDate, unreadableDateNotice, defaultScopeNote, costBreakupKey, costBreakupSummary, costBreakupTarget, costSummaryLines, costSummaryTarget, dataForSubject, defaultPeriod, ledgerVouchersParent, reportLevel, reportSubject, syncHighlight, voucherParent, formatAmount, formatBalance, isZeroNode, periodDays, periodText, popCursor, pushCursor, readCursorStack, recordPeriod, registerPageSize, registerRange, rememberedPeriod, reportPageQuery, reportPeriodQuery, splitBalance, writeCursorStack } from '../src/lib/reports.ts';
import type { LedgerRow } from '../src/server/ledger/reports.ts';
import { rollUp, statementTree, subtree } from '../src/server/reports/tree.ts';

test('amounts read with grouping and exactly the currency decimal places, never through a float', () => {
  assert.equal(formatAmount('53625.00', 2), '53,625.00');
  assert.equal(formatAmount('1487.781', 3), '1,487.781');
  assert.equal(formatAmount('-375.00', 2), '-375.00');
  assert.equal(formatAmount('92233720368547758.07', 2), '92,233,720,368,547,758.07', 'the largest bigint amount stays exact');
  assert.equal(formatBalance('-32000.00', 2), '32,000.00 Cr');
  assert.equal(formatBalance('2100.000', 3), '2,100.000 Dr');
  assert.equal(formatBalance('0.00', 2), '0.00');
  assert.deepEqual(splitBalance(-5n), { amount: 5n, side: 'Cr' });
  assert.deepEqual(splitBalance(0n), { amount: 0n, side: null });
});

test('periods are real dates, in order and at most ten years; the default runs from the financial-year start', () => {
  assert.equal(periodDays('2026-01-01', '2026-12-31'), 365);
  assert.equal(reportPeriodQuery.safeParse({ from: '2026-01-01', to: '2026-02-03' }).success, true);
  for (const bad of [{ from: '2026-02-03', to: '2026-01-01' }, { from: '2026-02-29', to: '2026-03-01' }, { from: '2015-01-01', to: '2026-01-02' }, { from: '2026-01-01', to: '2026-01-02', extra: 'x' }]) {
    assert.equal(reportPeriodQuery.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(reportPageQuery.parse({ from: '2026-01-01', to: '2026-01-31' }).limit, 200);
  assert.deepEqual(defaultPeriod({ month: 4, day: 1 }, '2026-02-03'), { from: '2025-04-01', to: '2026-02-03' });
  assert.equal(periodText({ from: '2026-01-01', to: '2026-02-03' }), '1 January 2026 to 3 February 2026');
});

const group = (id: string, parentId: string | null, name: string, nature: AccountGroup['nature'] = 'asset'): AccountGroup =>
  ({ id, parentId, name, nature, grossProfit: false, systemKey: null, secondLanguageName: null, revision: 1 });
const ledger = (ledgerId: string, groupId: string | null, name: string, closing: bigint): LedgerRow => ({
  ledgerId, groupId, name, systemKey: null, primaryGroupId: null, primaryGroupName: null, nature: 'asset', grossProfit: false, enteredOpening: 0n,
  openingDebit: 0n, openingCredit: 0n, debit: closing > 0n ? closing : 0n, credit: closing < 0n ? -closing : 0n,
  closingDebit: closing > 0n ? closing : 0n, closingCredit: closing < 0n ? -closing : 0n,
});

test('the statement tree is pre-order, sums every ledger into each group above it and keeps debit and credit apart', () => {
  const groups = [group('b', null, 'Liabilities', 'liability'), group('a', null, 'Assets'), group('a1', 'a', 'Bank'), group('a2', 'a', 'Cash')];
  const nodes = statementTree(groups, [ledger('l1', 'a1', 'Main bank', 500n), ledger('l2', 'a1', 'Overdrawn bank', -200n), ledger('l3', 'a2', 'Till', 50n), ledger('l4', 'b', 'Loan', -350n), ledger('pl', null, 'Profit and loss', 0n)]);
  assert.deepEqual(nodes.map(node => `${'  '.repeat(node.depth)}${node.name}`), ['Liabilities', '  Loan', 'Assets', '  Bank', '    Main bank', '    Overdrawn bank', '  Cash', '    Till', 'Profit and loss']);
  const assets = nodes.find(node => node.name === 'Assets')!;
  assert.deepEqual([assets.closingDebit, assets.closingCredit, assets.closing], [550n, 200n, 350n]);
  assert.deepEqual(subtree(nodes, nodes.indexOf(assets)).map(node => node.name), ['Assets', 'Bank', 'Main bank', 'Overdrawn bank', 'Cash', 'Till']);
  const values = rollUp(nodes, node => node.closing);
  assert.equal(values.get('g:a'), 350n);
  assert.equal(values.get('g:a1'), 300n);
  assert.equal(isZeroNode(nodes.at(-1)!), true);
  assert.equal(isZeroNode({ openingDebit: '0.00', openingCredit: '0.00', debit: '0.00', credit: '0.00', closingDebit: '0.000', closingCredit: '1.000' }), false);
});

test('only statement periods are remembered: the day book keeps its day to itself', () => {
  const memory = new Map<string, { from: string; to: string }>();
  recordPeriod(memory, 'c1', 'statement', { from: '2026-01-01', to: '2026-02-03' });
  recordPeriod(memory, 'c1', 'day', { from: '2026-02-03', to: '2026-02-03' });
  recordPeriod(memory, 'c1', 'none', { from: '2026-02-03', to: '2026-02-03' });
  assert.deepEqual(rememberedPeriod(memory, 'c1', 'statement'), { from: '2026-01-01', to: '2026-02-03' }, 'opening the day book does not narrow the trial balance');
  assert.equal(rememberedPeriod(memory, 'c1', 'day'), undefined, 'the day book opens on its own default day');
  assert.equal(rememberedPeriod(memory, 'c2', 'statement'), undefined);
});

test('a register page names the vouchers it shows once the period needs more than one page, so a printout says more exist', () => {
  assert.equal(registerRange(0, 150, false), null, 'one page: nothing to say');
  assert.equal(registerRange(0, 200, true), 'Vouchers 1 to 200; more on the next page.');
  assert.equal(registerRange(1, 200, true), 'Vouchers 201 to 400; more on the next page.');
  assert.equal(registerRange(1, 103, false), 'Vouchers 201 to 303, the last of the period.');
  assert.equal(registerRange(1, 1, false), 'Voucher 201, the last of the period.', 'one voucher on the last page');
  assert.equal(registerRange(1, 0, false), null, 'an empty page (a stale address past the last voucher) names no range');
  assert.equal(registerRange(2, 0, true), null);
  assert.equal(registerPageSize, reportPageQuery.parse({ from: '2026-01-01', to: '2026-12-31' }).limit, 'the screens rely on the server default page size');
});

test('page cursors: a repeated push of the cursor on top is ignored, so PageUp still returns to the first page', () => {
  let stack: readonly string[] = [];
  // Three quick PageDowns while page 2 loads: the old page's next cursor is pushed each time.
  for (let press = 0; press < 3; press++) stack = pushCursor(stack, 'page-2');
  assert.deepEqual(stack, ['page-2']);
  stack = pushCursor(stack, 'page-3');
  assert.deepEqual(stack, ['page-2', 'page-3']);
  stack = popCursor(popCursor(stack));
  assert.deepEqual(stack, [], 'two PageUps return to the first page');
});

test('the cursor stack of a register round-trips through the address; anything else reads as the first page', () => {
  const stack = ['MjAyNi0wMS0wNH4wMWExZGFkZi1iNTcw', 'MjAyNi0wMS0wOX4wMWExZGFkZi1iNTcw'];
  assert.equal(writeCursorStack(stack), stack.join('.'));
  assert.deepEqual(readCursorStack(writeCursorStack(stack)), stack);
  assert.equal(writeCursorStack([]), undefined, 'the first page leaves no parameter');
  for (const text of [undefined, '', 'a..b', '.a', 'a.', 'a b', 'a/b', 7, ['a'], 'x'.repeat(121), Array.from({ length: 201 }, () => 'a').join('.')]) {
    assert.deepEqual(readCursorStack(text), [], JSON.stringify(text)?.slice(0, 40));
  }
});

test('the cost category summary becomes table lines: each category, then its top-level centres one level in, keys kept apart', () => {
  const figures = (closing: string) => ({ opening: '0.00', debit: closing, credit: '0.00', closing });
  const lines = costSummaryLines({ from: '2026-01-01', to: '2026-01-31', categories: [
    { categoryId: 'a1', name: 'Area', ...figures('70.00'), centres: [{ costCentreId: 'c1', name: 'North', ...figures('50.00') }, { costCentreId: 'c2', name: 'South', ...figures('20.00') }] },
    { categoryId: 'b1', name: 'Projects', ...figures('5.00'), centres: [{ costCentreId: 'c3', name: 'Roof', ...figures('5.00') }] },
  ] });
  assert.deepEqual(lines.map(line => [line.key, line.kind, line.depth, line.name, line.closing]), [
    ['k:a1', 'category', 0, 'Area', '70.00'], ['c:c1', 'centre', 1, 'North', '50.00'], ['c:c2', 'centre', 1, 'South', '20.00'],
    ['k:b1', 'category', 0, 'Projects', '5.00'], ['c:c3', 'centre', 1, 'Roof', '5.00'],
  ]);
  assert.deepEqual(costSummaryLines({ from: '2026-01-01', to: '2026-01-31', categories: [] }), []);
  // A sub-centre and a ledger with the same id stay two lines.
  assert.notEqual(costBreakupKey({ kind: 'centre', id: 'x' }), costBreakupKey({ kind: 'ledger', id: 'x' }));
});

test('the highlight follows the address when the subject or its hl changes, and keeps the user\'s line otherwise', () => {
  const parent = reportSubject({ centre: 'a' }), child = reportSubject({ centre: 'b' });
  assert.notEqual(parent, child);
  assert.equal(reportSubject({ centre: 'a' }), reportSubject({ centre: 'a', ledger: undefined }));
  const opened = { subject: parent, hl: undefined, highlight: undefined };
  const moved = { ...opened, highlight: 'l:x' };
  assert.equal(syncHighlight(moved, parent, undefined), moved, 'the same level keeps the line moved to');
  const drilled = syncHighlight(moved, child, undefined);
  assert.deepEqual(drilled.highlight, undefined, 'a drill on the same route starts the child at its first line');
  const back = syncHighlight(drilled, parent, 'c:b');
  assert.equal(back.highlight, 'c:b', 'back restores the hl the trail wrote');
  // Down twice after coming back, then a period change clears hl from the address: the moved-to line stays.
  const afterPeriod = syncHighlight({ ...back, highlight: 'l:y' }, parent, undefined);
  assert.deepEqual(afterPeriod, { subject: parent, hl: undefined, highlight: 'l:y' });
  assert.equal(syncHighlight(afterPeriod, parent, undefined), afterPeriod, 'then nothing changes');
  assert.equal(syncHighlight({ ...back, highlight: 'l:y' }, child, undefined).highlight, undefined, 'another subject without hl starts at the top');
  // Data read for one subject is never shown for another; a period change (same subject) keeps it.
  assert.equal(dataForSubject({ subject: parent, data: [1] }, child), null);
  assert.deepEqual(dataForSubject({ subject: parent, data: [1] }, parent), [1]);
});

test('cost report lines: which open, what they open, the chooser filter and the not-filtered notice', () => {
  assert.equal(costSummaryTarget({ kind: 'category', id: 'k' }), null, 'a category leads nowhere');
  assert.deepEqual(costSummaryTarget({ kind: 'centre', id: 'c1' }), { report: 'cost-centre-breakup', search: { centre: 'c1' } });
  assert.deepEqual(costBreakupTarget({ kind: 'centre', id: 'c2' }, 'c1'), { report: 'cost-centre-breakup', search: { centre: 'c2' } });
  assert.deepEqual(costBreakupTarget({ kind: 'ledger', id: 'l1' }, 'c1'), { report: 'ledger-vouchers', search: { ledger: 'l1', fromCentre: 'c1' } });

  const centre = { id: 'c1', name: 'North', categoryId: 'k', categoryName: 'Area' };
  const row = (kind: 'centre' | 'ledger') => ({ kind, id: 'x', name: 'x', opening: '0.00', debit: '1.00', credit: '0.00', closing: '1.00' });
  assert.equal(costBreakupSummary({ centre, rows: [] }), 'Category: Area. No amounts in this period.');
  assert.equal(costBreakupSummary({ centre, rows: [row('centre')] }), 'Category: Area.');
  assert.match(costBreakupSummary({ centre, rows: [row('ledger')] }), /^Category: Area\. A ledger’s figures here are this centre’s share; Enter on a ledger opens all of its vouchers/);

  const centres = [{ name: 'North', secondLanguageName: 'شمال' }, { name: 'South Harbour', secondLanguageName: null }];
  assert.deepEqual(narrowByName(centres, '').map(item => item.name), ['North', 'South Harbour']);
  assert.deepEqual(narrowByName(centres, ' harb ').map(item => item.name), ['South Harbour']);
  assert.deepEqual(narrowByName(centres, 'شمال').map(item => item.name), ['North']);

  assert.equal(centreOriginNotice({}), null);
  assert.match(centreOriginNotice({ fromCentre: 'c1' })!, /all of the ledger’s vouchers .* not the centre’s/);
  assert.deepEqual(ledgerVouchersParent({ from: '2026-01-01', to: '2026-01-31', ledger: 'l1', fromCentre: 'c1' }), { report: 'cost-centre-breakup', search: { from: '2026-01-01', to: '2026-01-31', centre: 'c1' } });
  assert.deepEqual(ledgerVouchersParent({ from: '2026-01-01', to: '2026-01-31', ledger: 'l1' }), { report: 'ledger-monthly', search: { from: '2026-01-01', to: '2026-01-31', ledger: 'l1' } });
  assert.equal(ledgerVouchersParent({}), null);
});

test('a drill-down level ignores the period, the page, the view and the highlight, and keeps the subject', () => {
  const level = reportLevel('/app/c/x/Reports/Group-Summary?group=g1&from=2026-01-01&to=2026-01-31&hl=l%3Aa&pages=abc&detail=true&zeros=true');
  assert.equal(level, '/app/c/x/reports/group-summary?group=g1');
  assert.equal(reportLevel('/app/c/x/reports/group-summary?to=2026-02-28&from=2026-02-01&group=g1'), level, 'a period changed after the drill is the same level');
  assert.notEqual(reportLevel('/app/c/x/reports/group-summary?group=g2'), level);
  assert.equal(reportLevel('/r/ledger-vouchers?ledger=l1&fromCentre=c1&from=2026-01-01'), '/r/ledger-vouchers?fromCentre=c1&ledger=l1');
});

test('the voucher view goes back to the ledger vouchers it came from, keeping the break-up origin, else to its day', () => {
  assert.deepEqual(voucherParent({ from: '2026-01-01', to: '2026-01-31', ledger: 'l1', fromCentre: 'c1' }, '2026-01-09'),
    { report: 'ledger-vouchers', search: { from: '2026-01-01', to: '2026-01-31', ledger: 'l1', fromCentre: 'c1' } });
  assert.deepEqual(voucherParent({ from: '2026-01-01', to: '2026-01-31', ledger: 'l1' }, '2026-01-09'),
    { report: 'ledger-vouchers', search: { from: '2026-01-01', to: '2026-01-31', ledger: 'l1' } });
  assert.deepEqual(voucherParent({}, '2026-01-09'), { report: 'day-book', search: { from: '2026-01-09', to: '2026-01-09' } });
});

test('report screens take their highlight through syncHighlight and their data per subject (source check: no hook renderer in the tests)', () => {
  const hook = readFileSync(new URL('../src/components/reports/useReportScreen.ts', import.meta.url), 'utf8');
  assert.ok(hook.includes('syncHighlight(tracked, subject, search.hl)'), 'the highlight follows the address on every render');
  assert.ok(hook.includes("'report', subject)"), 'the report is read per subject');
  assert.ok(!hook.includes('useState(search.hl)'), 'the address is not read once');
  const navigation = readFileSync(new URL('../src/components/reports/navigation.ts', import.meta.url), 'utf8');
  assert.ok(navigation.includes('data: dataForSubject(state, subject)'));
  assert.ok(navigation.includes('const levelOf = reportLevel'));
});

test('the cost list tells only those who can write that they can set up categories and centres', () => {
  const viewer = costCentresOffNotice({ canWrite: false, canSwitch: false });
  assert.doesNotMatch(viewer, /You can set up/);
  assert.match(viewer, /Ask an owner or admin/);
  const editor = costCentresOffNotice({ canWrite: true, canSwitch: false });
  assert.match(editor, /You can set up categories and centres now./);
  assert.match(editor, /Ask an owner or admin/);
  const admin = costCentresOffNotice({ canWrite: true, canSwitch: true });
  assert.match(admin, /You can set up/);
  assert.doesNotMatch(admin, /Ask an owner/);
});

test('the clipped monthly summary says what was asked for and why it ends earlier, and says nothing when nothing was cut', () => {
  const asked = { from: '2026-01-01', to: '2027-02-27' };
  const notice = monthlyClipNotice(asked, { from: '2026-01-01', to: '2026-12-31' });
  assert.match(notice ?? '', /1 January 2026 to 27 February 2027/);
  assert.match(notice ?? '', /ends on 31 December 2026/);
  assert.match(notice ?? '', /one financial year/);
  assert.equal(monthlyClipNotice({ from: '2026-01-01', to: '2026-06-30' }, { from: '2026-01-01', to: '2026-06-30' }), null);
});

test('the scope line names why a report opened on the period it did, only when it is the default', () => {
  const defaults = { lastVoucherDate: '2027-02-27', period: { from: '2027-01-01', to: '2027-02-27' }, dayBookDate: '2027-02-27' };
  assert.equal(defaultScopeNote(defaults.period, 'statement', false, defaults), 'the financial year to the last voucher date');
  assert.equal(defaultScopeNote({ from: '2027-01-01', to: '2027-01-31' }, 'statement', false, defaults), null);
  assert.equal(defaultScopeNote({ from: '2026-01-01', to: '2027-02-27' }, 'statement', false, defaults), null, 'another start is no default');
  assert.equal(defaultScopeNote({ from: '2027-02-27', to: '2027-02-27' }, 'statement', true, defaults), 'the last voucher date', 'an as-at date counts by its end only');
  assert.equal(defaultScopeNote({ from: '2027-02-27', to: '2027-02-27' }, 'day', false, defaults), 'the day of the last voucher');
  assert.equal(defaultScopeNote({ from: '2027-02-26', to: '2027-02-26' }, 'day', false, defaults), null);
  assert.equal(defaultScopeNote(defaults.period, 'none', false, defaults), null);
  const empty = { lastVoucherDate: null, period: { from: '2026-01-01', to: '2026-01-01' }, dayBookDate: '2026-01-01' };
  assert.equal(defaultScopeNote(empty.period, 'statement', false, empty), 'the financial year to the date the books begin');
});

test('every address a person can type reads as a date or as nothing: the balance sheet search never passes a raw value on', () => {
  // The router parses a number as a number and a repeated parameter as an array; the shared schema drops what it cannot read.
  const strange: unknown[] = [2027, 2026.5, ['2026-06-30', '2026-07-31'], ['2026-06-30'], [], {}, { a: 1 }, true, null, undefined, '', 'soon', '2026-02-30', '1850-01-01', '2026-06-30 '];
  for (const value of strange) {
    assert.deepEqual(balanceSheetDates({ from: value, to: value }), { from: undefined, to: undefined }, String(JSON.stringify(value)));
    assert.equal(addressDate(value), undefined);
  }
  assert.deepEqual(balanceSheetDates({ from: '2026-01-10', to: '2026-06-30' }), { from: '2026-01-10', to: '2026-06-30' });
  // Both keys are always present, so that the router's raw value cannot show through under an absent key.
  assert.deepEqual(Object.keys(balanceSheetDates({})).sort(), ['from', 'to']);
  assert.deepEqual(Object.keys(balanceSheetDates({ to: 2027, from: ['x'] })).sort(), ['from', 'to']);
  assert.deepEqual(balanceSheetDates({ from: '2026-02-30', to: '2026-06-30' }), { from: undefined, to: '2026-06-30' }, 'an invalid from is not passed on');
});

test('the balance sheet honours a lone to as its as-at date and reads nothing else as a date', () => {
  const january = { month: 1, day: 1 };
  const april = { month: 4, day: 1 };
  assert.deepEqual(asAtPeriod({ to: '2026-01-31' }, january), { from: '2026-01-01', to: '2026-01-31' });
  assert.deepEqual(asAtPeriod({ to: '2026-12-31' }, april), { from: '2026-04-01', to: '2026-12-31' });
  assert.deepEqual(asAtPeriod({ to: '2026-03-31' }, april), { from: '2025-04-01', to: '2026-03-31' });
  assert.deepEqual(asAtPeriod({ from: '2026-01-10', to: '2026-01-31' }, january), { from: '2026-01-10', to: '2026-01-31' });
  assert.deepEqual(asAtPeriod({ from: '2026-02-10', to: '2026-01-31' }, january), { from: '2026-01-01', to: '2026-01-31' });
  assert.deepEqual(asAtPeriod({ from: '2026-02-30', to: '2026-06-30' }, january), { from: '2026-01-01', to: '2026-06-30' }, 'an invalid from is replaced by the year start');
  // No date: no period, so the screen fills in its default (a lone from stays ignored, as on every report). Nothing throws.
  for (const to of [undefined, '', 'soon', '2026-02-30', 2027, ['2026-06-30', '2026-07-31'], {}, null]) assert.equal(asAtPeriod({ to }, january), null, JSON.stringify(to));
  assert.equal(asAtPeriod({ from: '2026-01-10' }, january), null);
});

test('what a to that is no date reads as, for the notice: any value, short, nothing for a date or an empty value', () => {
  assert.equal(unreadableDate('soon'), 'soon');
  assert.equal(unreadableDate('2026-02-30'), '2026-02-30');
  assert.equal(unreadableDate('1850-01-01'), '1850-01-01');
  assert.equal(unreadableDate(2027), '2027');
  assert.equal(unreadableDate(['2026-06-30', '2026-07-31']), '["2026-06-30","2026-07-31"]');
  assert.equal(unreadableDate({ a: 1 }), '{"a":1}');
  assert.equal(unreadableDate('x'.repeat(100))?.length, 40);
  for (const value of ['2026-01-31', '', undefined, null, []]) assert.equal(unreadableDate(value), undefined, JSON.stringify(value));
  const notice = unreadableDateNotice('2026-02-30', '2026-02-03');
  assert.match(notice, /2026-02-30/);
  assert.match(notice, /3 February 2026/);
  assert.match(unreadableDateNotice('soon', null), /Change date/);
});

test('which actions a failed load offers: a refusal the user can fix offers to change the period (and the first page of a register), anything else Try again', () => {
  const offers = (status: number | undefined, hasPeriod = true, onLaterPage = false) => failureActions({ failure: status === undefined ? null : { status }, hasPeriod, onLaterPage });
  assert.deepEqual(offers(400), ['change-period'], 'a period or date the server refused');
  assert.deepEqual(offers(400, true, true), ['first-page', 'change-period'], 'on a later page the cursor may be the cause');
  assert.deepEqual(offers(400, false, true), ['first-page']);
  assert.deepEqual(offers(400, false, false), ['retry'], 'nothing the user can change');
  for (const status of [0, 401, 403, 404, 409, 429, 500, 502, 503]) assert.deepEqual(offers(status, true, true), ['retry'], String(status));
  assert.deepEqual(offers(undefined), ['retry']);
  assert.deepEqual(failureActions({ failure: {}, hasPeriod: true, onLaterPage: false }), ['retry'], 'no answer from the server');
});

test('the scope line states the period actually shown and the as-of date, with the default period named', () => {
  const defaults = { lastVoucherDate: '2027-02-27', period: { from: '2027-01-01', to: '2027-02-27' }, dayBookDate: '2027-02-27' };
  assert.deepEqual(scopeLine(undefined, null, 'none', null), { scope: 'Read-only', asOf: null });
  const asked = { kind: 'range' as const, period: { from: '2026-01-01', to: '2027-02-27' } };
  assert.deepEqual(scopeLine(asked, { from: '2026-01-01', to: '2026-12-31' }, 'statement', defaults), { scope: '1 January 2026 to 31 December 2026', asOf: '31 December 2026' }, 'the clipped period, not the asked one');
  assert.deepEqual(scopeLine(asked, null, 'statement', null), { scope: '1 January 2026 to 27 February 2027', asOf: '27 February 2027' });
  assert.deepEqual(scopeLine({ kind: 'range', period: defaults.period }, null, 'statement', defaults), { scope: '1 January 2027 to 27 February 2027 (the financial year to the last voucher date)', asOf: '27 February 2027' });
  assert.deepEqual(scopeLine({ kind: 'range', period: null }, null, 'statement', defaults), { scope: 'Choosing the period…', asOf: null });
  assert.deepEqual(scopeLine({ kind: 'date', date: '2027-02-27' }, null, 'statement', defaults), { scope: 'As at 27 February 2027 (the last voucher date)', asOf: '27 February 2027' });
  assert.deepEqual(scopeLine({ kind: 'date', date: null }, null, 'statement', defaults), { scope: 'Choosing the date…', asOf: null });
  assert.deepEqual(scopeLine({ kind: 'range', period: { from: '2027-02-27', to: '2027-02-27' } }, null, 'day', defaults), { scope: '27 February 2027 (the day of the last voucher)', asOf: '27 February 2027' });
});

test('a chooser narrows by the product\'s name match key, as the master forms\' lookups do', () => {
  const ledgers = [{ name: 'JOB-105', secondLanguageName: null }, { name: 'Job 2', secondLanguageName: null }, { name: 'Bank A/c', secondLanguageName: 'حساب' }];
  assert.deepEqual(narrowByName(ledgers, 'job 105').map(row => row.name), ['JOB-105']);
  assert.deepEqual(narrowByName(ledgers, 'JOB105').map(row => row.name), ['JOB-105']);
  assert.deepEqual(narrowByName(ledgers, 'bank ac').map(row => row.name), ['Bank A/c']);
  assert.deepEqual(narrowByName(ledgers, 'حس').map(row => row.name), ['Bank A/c']);
  assert.deepEqual(narrowByName(ledgers, ' - ').length, 3, 'only ignored characters counts as empty');
  assert.deepEqual(narrowByName(ledgers, 'zzz'), []);
});

test('a chooser\'s keys: Escape clears text first, Enter opens the highlighted line (the first before any key), the movement keys stay inside the list', () => {
  assert.equal(pickerEscape('north'), 'clear');
  assert.equal(pickerEscape(' '), 'clear', 'spaces are text too');
  assert.equal(pickerEscape(''), 'back');
  const keys = ['a', 'b', 'c'];
  assert.equal(lineToOpen(keys, undefined), 'a', 'the first line shows highlighted before any key');
  assert.equal(lineToOpen(keys, 'c'), 'c');
  assert.equal(lineToOpen(keys, 'gone'), 'a', 'a highlight that left the narrowed list falls back to the first line');
  assert.equal(lineToOpen([], undefined), undefined, 'nothing to open in an empty list');
  assert.equal(listTarget('next', 0, 3), 1);
  assert.equal(listTarget('next', 2, 3), 2, 'stops at the last line');
  assert.equal(listTarget('previous', 0, 3), 0, 'stops at the first line');
  assert.equal(listTarget('previous', 2, 3), 1);
  assert.equal(listTarget('first', 2, 3), 0);
  assert.equal(listTarget('last', 0, 3), 2);
  assert.equal(listTarget('page-down', 0, 25), 10);
  assert.equal(listTarget('page-down', 20, 25), 24);
  assert.equal(listTarget('page-up', 12, 25), 2);
  assert.equal(listTarget('page-up', 3, 25), 0);
  for (const move of ['next', 'previous', 'first', 'last', 'page-down', 'page-up'] as const) assert.equal(listTarget(move, 0, 0), null, move);
});

test('coming back to a chooser from the line opened restores the typed text; any other arrival starts empty', () => {
  const memory = new Map([['c1:ledger', 'job 105']]);
  assert.equal(restoredFilter(memory, 'c1:ledger', 'led-1'), 'job 105');
  assert.equal(restoredFilter(memory, 'c1:ledger', undefined), '', 'a fresh arrival has no hl');
  assert.equal(restoredFilter(memory, 'c2:ledger', 'led-1'), '', 'another company or chooser');
  assert.ok(chooserFilters instanceof Map);
});

test('the notice text of a bad to: from the raw to, or from the badTo the route carries once; never attached to a date that was read', () => {
  assert.equal(unreadableTo({ to: 2027 }), '2027');
  assert.equal(unreadableTo({ to: ['2026-06-30', '2026-07-31'] }), '["2026-06-30","2026-07-31"]');
  assert.equal(unreadableTo({ to: '2026-02-30' }), '2026-02-30');
  assert.equal(unreadableTo({ badTo: '2027' }), '2027', 'the address after the server rewrote it');
  assert.equal(unreadableTo({ to: '2026-06-30', badTo: 'made up' }), undefined, 'a link cannot put a notice on a date that was read');
  assert.equal(unreadableTo({}), undefined);
  assert.equal(unreadableTo({ to: '' }), undefined);
});

test('every report route reads its address through readReportSearch: only readable values, every key written, so no raw value shows through', () => {
  const id = '5A11A54F-CA35-4CE7-942F-4BAB9AD3F660';
  const keys = ['centre', 'detail', 'from', 'fromCentre', 'group', 'hl', 'ledger', 'pages', 'to', 'voucher', 'zeros'];
  const read = readReportSearch({ from: '2026-01-01', to: '2026-02-03', detail: true, zeros: true, hl: `p:${id.toLowerCase()}`, ledger: id, pages: 'AAA.BBB' });
  assert.deepEqual(Object.keys(read).sort(), keys);
  assert.deepEqual({ ...read }, { from: '2026-01-01', to: '2026-02-03', detail: true, zeros: true, hl: `p:${id.toLowerCase()}`, group: undefined, ledger: id.toLowerCase(), voucher: undefined, centre: undefined, fromCentre: undefined, pages: 'AAA.BBB' });
  // Values the router parses into numbers, lists and objects, and texts that are no date or no id, read as nothing, never as themselves.
  for (const value of [2027, ['2026-06-30', '2026-07-31'], {}, true, null, '', 'soon', '2026-02-30', '1850-01-01']) {
    const strange = readReportSearch({ from: value, to: value, detail: value, zeros: value, hl: value, group: value, ledger: value, voucher: value, centre: value, fromCentre: value, pages: value });
    assert.deepEqual(Object.keys(strange).sort(), keys, 'every key is written');
    for (const key of keys.filter(name => name !== 'pages' || typeof value !== 'string')) assert.equal((strange as Record<string, unknown>)[key], key === 'detail' || key === 'zeros' ? (value === true ? true : undefined) : undefined, `${key} from ${JSON.stringify(value)}`);
  }
  assert.deepEqual(Object.keys(readReportSearch({})).sort(), keys);
});
