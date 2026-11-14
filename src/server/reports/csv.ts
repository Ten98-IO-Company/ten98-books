import { formatMoney, toCsv, type MoneyExponent } from '@ten98/runtime';
import {
  splitBalance, type BalanceSheetReport, type DayBookReport, type GroupSummaryReport, type LedgerMonthlyReport,
  type LedgerVouchersReport, type NodeAmounts, type ProfitAndLossReport, type StatementLine, type TrialBalanceReport,
} from '../../lib/reports.ts';
import type { AgeingBucket, AgeingReport, BillDetailReport, BillsOutstandingReport, PartyBillsReport } from '../../lib/bills.ts';
import type { CostCategorySummary, CostCentreBreakup, CostFigures } from '../../lib/cost-centres.ts';

/**
 * Each report as CSV rows through the runtime CSV helpers (RFC 4180, formula-injection-safe cells). Amounts are plain
 * decimal strings with the currency's decimal places and no grouping, so spreadsheets read them as numbers; balances
 * are an amount column and a Dr or Cr column. Indentation is a level column rather than leading spaces.
 */

type Money = (amount: bigint) => string;
const balance = (money: Money, signed: bigint) => { const { amount, side } = splitBalance(signed); return [money(amount), side ?? '']; };
const amounts = (money: Money, row: NodeAmounts) => [row.openingDebit, row.openingCredit, row.debit, row.credit, row.closingDebit, row.closingCredit].map(money);

/** The CSV document: a byte-order mark first, so spreadsheet programs read second-language (Arabic) names as UTF-8. */
export const csvDocument = (rows: readonly (readonly unknown[])[]) => `﻿${toCsv(rows)}`;

export function trialBalanceCsv(report: TrialBalanceReport, exponent: MoneyExponent): string[][] {
  const money: Money = amount => formatMoney(amount, exponent);
  return [
    ['Particulars', 'Kind', 'Level', 'Opening debit', 'Opening credit', 'Debit', 'Credit', 'Closing debit', 'Closing credit'],
    ...report.nodes.map(node => [node.name, node.kind, String(node.depth), ...amounts(money, node)]),
    ...report.difference ? [['Difference in opening balances', 'difference', '0', ...amounts(money, report.difference)]] : [],
    ['Total', 'total', '', ...amounts(money, report.grandTotals)],
  ];
}

function statementCsv(lines: readonly StatementLine[], exponent: MoneyExponent): string[][] {
  return [
    ['Line', 'Kind', 'Level', 'Amount'],
    ...lines.map(line => [line.label, line.kind, line.depth === null ? '' : String(line.depth), line.amount === null ? '' : formatMoney(line.amount, exponent)]),
  ];
}
export const profitAndLossCsv = (report: ProfitAndLossReport, exponent: MoneyExponent) => statementCsv(report.lines, exponent);
export const balanceSheetCsv = (report: BalanceSheetReport, exponent: MoneyExponent) => statementCsv(report.lines, exponent);

export function groupSummaryCsv(report: GroupSummaryReport, exponent: MoneyExponent): string[][] {
  const money: Money = amount => formatMoney(amount, exponent);
  return [
    ['Particulars', 'Kind', 'Opening balance', 'Opening side', 'Debit', 'Credit', 'Closing balance', 'Closing side'],
    ...report.rows.map(row => [row.name, row.kind, ...balance(money, row.opening), money(row.debit), money(row.credit), ...balance(money, row.closing)]),
    ['Total', 'total', ...balance(money, report.totals.opening), money(report.totals.debit), money(report.totals.credit), ...balance(money, report.totals.closing)],
  ];
}

export function ledgerMonthlyCsv(report: LedgerMonthlyReport, exponent: MoneyExponent): string[][] {
  const money: Money = amount => formatMoney(amount, exponent);
  return [
    ['Month', 'From', 'To', 'Debit', 'Credit', 'Closing balance', 'Closing side'],
    ['Opening balance', report.from, report.from, '', '', ...balance(money, report.opening)],
    ...report.months.map(month => [month.month, month.from, month.to, money(month.debit), money(month.credit), ...balance(money, month.closing)]),
    ['Total', report.from, report.to, money(report.totals.debit), money(report.totals.credit), ...balance(money, report.totals.closing)],
  ];
}

export function ledgerVouchersCsv(report: LedgerVouchersReport, exponent: MoneyExponent): string[][] {
  const money: Money = amount => formatMoney(amount, exponent);
  return [
    ['Date', 'Particulars', 'Voucher type', 'Number', 'Debit', 'Credit', 'Balance', 'Balance side'],
    [report.from, 'Opening balance', '', '', '', '', ...balance(money, report.opening)],
    ...report.rows.map(row => [row.date, row.otherLedgers ? `${row.particulars} and ${row.otherLedgers} more` : row.particulars,
      row.voucherTypeName, row.number === null ? '' : String(row.number), money(row.debit), money(row.credit), ...balance(money, row.balance)]),
    [report.to, 'Total', '', '', money(report.totals.debit), money(report.totals.credit), ...balance(money, report.totals.closing)],
  ];
}

export function dayBookCsv(report: DayBookReport, exponent: MoneyExponent): string[][] {
  const money: Money = amount => formatMoney(amount, exponent);
  return [
    ['Date', 'Particulars', 'Voucher type', 'Number', 'Status', 'Post-dated', 'Debit', 'Credit', 'Narration'],
    ...report.rows.map(row => [row.date, row.particulars, row.voucherTypeName, row.number === null ? '' : String(row.number), row.status,
      row.postDated ? 'yes' : 'no', row.side === 'Dr' ? money(row.amount) : '', row.side === 'Cr' ? money(row.amount) : '', row.narration ?? '']),
    ['', 'Total of regular vouchers', '', '', '', '', money(report.totals.debit), money(report.totals.credit), ''],
  ];
}

const bucketLabel = (bucket: AgeingBucket) => bucket.toDays === null ? `Over ${bucket.fromDays} days` : `${bucket.fromDays} to ${bucket.toDays} days`;

export function billsOutstandingCsv(report: BillsOutstandingReport, exponent: MoneyExponent): string[][] {
  const money: Money = amount => formatMoney(amount, exponent);
  return [
    ['Bill date', 'Bill', 'Party', 'Pending', 'Due date', 'Days overdue'],
    ...report.bills.map(bill => [bill.billDate ?? '', bill.name, bill.ledgerName, money(bill.amount), bill.dueDate ?? '', String(bill.overdueDays)]),
    ['', 'Total', '', money(report.total ?? 0n), '', ''],
  ];
}

export function partyBillsCsv(report: PartyBillsReport, exponent: MoneyExponent): string[][] {
  const money: Money = amount => formatMoney(amount, exponent);
  return [
    ['Bill date', 'Bill', 'Method', 'Pending', 'Pending side', 'Due date', 'Days overdue'],
    ...report.bills.map(bill => [bill.billDate ?? '', bill.name, bill.method, ...balance(money, bill.pending), bill.dueDate ?? '', String(bill.overdueDays)]),
    ['', 'On account', '', ...balance(money, report.onAccount), '', ''],
    ['', 'Balance', '', ...balance(money, report.balance), '', ''],
  ];
}

export function billDetailCsv(report: BillDetailReport, exponent: MoneyExponent): string[][] {
  const money: Money = amount => formatMoney(amount, exponent);
  return [
    ['Date', 'Voucher type', 'Number', 'Method', 'Status', 'Debit', 'Credit', 'Pending', 'Pending side'],
    ...report.rows.map(row => [row.date, row.voucherTypeName ?? 'Opening balance', row.number === null ? '' : String(row.number), row.method, row.status,
      row.side === 'Dr' ? money(row.amount) : '', row.side === 'Cr' ? money(row.amount) : '', ...row.pending === null ? ['', ''] : balance(money, row.pending)]),
  ];
}

export function ageingCsv(report: AgeingReport, exponent: MoneyExponent): string[][] {
  const money: Money = amount => formatMoney(amount, exponent);
  const notDue = report.basis === 'due';
  return [
    ['Party', ...notDue ? ['Not yet due'] : [], ...report.buckets.map(bucketLabel), 'Total'],
    ...report.parties.map(party => [party.name, ...notDue ? [money(party.notDue ?? 0n)] : [], ...party.buckets.map(money), money(party.total)]),
    ['Total', ...notDue ? [money(report.totals.notDue ?? 0n)] : [], ...report.totals.buckets.map(money), money(report.totals.total)],
  ];
}

const costFigures = (money: Money, row: CostFigures) => [...balance(money, row.opening), money(row.debit), money(row.credit), ...balance(money, row.closing)];
const costHeader = ['Opening balance', 'Opening side', 'Debit', 'Credit', 'Closing balance', 'Closing side'];

/** The cost category summary: a row per category (its total) followed by its root centres. */
export function costCategorySummaryCsv(report: CostCategorySummary, exponent: MoneyExponent): string[][] {
  const money: Money = amount => formatMoney(amount, exponent);
  return [
    ['Category', 'Cost centre', 'Kind', ...costHeader],
    ...report.categories.flatMap(category => [
      [category.name, '', 'category', ...costFigures(money, category)],
      ...category.centres.map(centre => [category.name, centre.name, 'centre', ...costFigures(money, centre)]),
    ]),
  ];
}

export function costCentreBreakupCsv(report: CostCentreBreakup, exponent: MoneyExponent): string[][] {
  const money: Money = amount => formatMoney(amount, exponent);
  return [
    ['Particulars', 'Kind', ...costHeader],
    ...report.rows.map(row => [row.name, row.kind, ...costFigures(money, row)]),
    ['Total', 'total', ...costFigures(money, report.totals)],
  ];
}
