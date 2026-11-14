# Reports (M1)

The M1 reports of one company: the day book, the trial balance, profit and loss, the balance sheet, and the drill-down from a statement through the group summary, a ledger's monthly summary and its vouchers to a single voucher. Every report is read-only, runs through `withCompany` in read mode (viewers read), reads typed rows from SQL with a statement-timeout budget of its own, and returns amounts as `bigint` minor units on the server and decimal strings on the wire (D-03, D-07, D-09). The contract is [D-01, D-04, D-05, D-09, D-10 and D-11](DECISIONS.md); this page describes what is built.

Code: [src/server/reports/](../src/server/reports) (report modules and CSV tables), [src/server/ledger/reports.ts](../src/server/ledger/reports.ts) (the shared read model: one row per ledger for a period), [src/server/api/reports.ts](../src/server/api/reports.ts) (HTTP), [src/lib/reports.ts](../src/lib/reports.ts) (query schemas, shapes, formatting helpers), screens in `src/routes/app/c.$companyId.reports*.tsx` with their frame in [src/components/reports/](../src/components/reports). Keys are in [KEYBOARD.md](KEYBOARD.md#reports).

## What counts

Only regular, undeleted vouchers affect any balance. Cancelled, deleted and optional vouchers never do. A post-dated voucher counts from its own date like any other. Opening balances are computed at report time (D-04): a balance-sheet ledger opens with its opening balance (as of the books-beginning date) plus everything before the period; an income or expense ledger opens with what was posted earlier in the same financial year, and what it gathered in earlier years is carried into the profit and loss ledger. Opening balances entered out of balance (D-10) are shown as a difference line on the short side, so every statement still agrees.

## Periods

- A period is two calendar dates (`YYYY-MM-DD`, in the company's calendar), the start not after the end, at most ten years long. The balance sheet takes one date.
- Statements, the group summary and the ledger screens open on the financial-year start through the **last voucher date**: the latest date of a regular, undeleted voucher that is not post-dated (optional and post-dated vouchers do not move it), or the books-beginning date while there is none. The day book opens on that one day.
- The period is part of every report's address (`?from=&to=`), so a report survives a reload and can be linked. It carries from one report to the next, both when drilling down and through "open another report"; a report opened from the menu without one uses the period shown last in the tab.
- Profit and loss covers one financial year at most (a longer period is refused with a plain message). The ledger monthly summary shows one financial year at a time: its end is clipped to the end of the year that contains its start, and the screen says so.

## Reports

| Report | API (`GET /api/companies/<id>/reports/...`) | What it shows |
|---|---|---|
| Defaults | `defaults` | The last voucher date, the default statement period, the day book's default day, the books-beginning date |
| Day book | `day-book?from=&to=[&limit=][&after=]` | Undeleted vouchers dated in the period, by date and entry order, 200 per page (keyset cursor). Particulars are the first line's ledger, and the voucher amount stands in that line's debit or credit column. Cancelled and optional vouchers are listed and marked but left out of the totals; post-dated vouchers are marked and counted. Totals cover the whole period, not just the page |
| Trial balance | `trial-balance?from=&to=` | The group hierarchy (primary groups by nature, then sub-groups, then ledgers) with opening debit and credit, period debit and credit, closing debit and credit. A group's columns are the sums of its ledgers' debit and credit balances kept apart, so a group can show both. The opening difference line and grand totals that agree |
| Profit and loss | `profit-and-loss?from=&to=` | Trading income and cost of sales (groups flagged for gross profit) to the gross profit or loss; other income and other expenses to the net profit or loss. A ledger's figure is its movement in the period, plus its opening balance when the books begin inside the period |
| Balance sheet | `balance-sheet?date=` | Capital and liabilities, then assets, by group, with closing balances from the start of that date's financial year. The profit and loss account carries the earlier years' result (brought forward: the profit and loss ledger) and this year's result to date (current period); a profit stands with the liabilities, a loss with the assets. The difference line when openings disagree |
| Group summary | `group-summary[/<group id>]?from=&to=` | One group's direct sub-groups and ledgers with opening balance, debit, credit and closing balance; without a group, the primary groups and the ledgers outside every group |
| Ledger monthly summary | `ledger-monthly/<ledger id>?from=&to=` | The ledger's opening balance at the start of the period, then debit, credit and closing per calendar month (the first and last months clipped to the period) |
| Ledger vouchers | `ledger-vouchers/<ledger id>?from=&to=[&limit=][&after=]` | One row per voucher touching the ledger in the period: date, particulars (the first ledger on the other side and how many more), type, number, debit, credit and the running balance; opening, period totals and closing. Paged like the day book; the running balance continues across pages |

Each report except defaults has a CSV export at the same path plus `/export` (for example `trial-balance/export?from=&to=`), with the same authorization: RFC 4180 records through the runtime CSV helpers, every cell quoted, a cell that could start a spreadsheet formula prefixed with an apostrophe, a UTF-8 byte-order mark so spreadsheets read Arabic names, plain decimal amounts with the currency's decimal places, balances as an amount column and a Dr or Cr column, and a level column instead of indentation. An export holds the whole period, up to 100,000 lines.

Amounts in JSON are decimal strings; a signed balance is positive on the debit side and negative on the credit side. Unknown or repeated query parameters are refused (400), as are a group id that names no group and a ledger id that names no ledger (404). A company the user cannot reach answers "not found" (404) for every route and export.

## Drill-down and screens

Enter goes down one level and Escape goes back one level, to the line it left from (D-05, D-09: drill-down is by route):

- trial balance → group summary (group line) or monthly summary (ledger line)
- profit and loss → group summary or monthly summary
- balance sheet → group summary, monthly summary, or the profit and loss statement (the profit and loss account and current-period lines)
- group summary → a sub-group's summary or a ledger's monthly summary
- monthly summary → that month's ledger vouchers
- ledger vouchers and day book → the voucher, read-only

Going back follows the path taken in this tab and restores the highlighted line (`hl` in the address of the level left). A level reached any other way (a link, a reload) goes back to its logical parent: a group to its parent group or its statement, a ledger to its group, a month's vouchers to the monthly summary, a voucher to its day.

Every level adds up to the one above it: a statement line equals its group summary's total, a group summary row its monthly summary's total, a month its vouchers. The integration tests walk the whole golden fixture to show it.

Screens show amounts right-aligned with grouping and the company's decimal places (2 or 3), debit and credit in their own columns and balances as "amount Dr" or "amount Cr". The statements have a condensed view (primary groups) and a detailed view (every sub-group and ledger), lines without amounts hidden unless asked for, and the totals that must agree side by side with whether they do. Tables have a caption, row headers and the design system's focus ring; the layout uses logical directions and holds in a right-to-left document. Print goes through the browser.

## Performance

Measured on a generated company of 52,784 voucher lines (12,600 four-line vouchers over two years, 42 ledgers) as `books_app` with row-level security, PostgreSQL 18: the trial balance query took 46.7 ms for two years and 39.6 ms for half a year; a 200-row page of one ledger's vouchers 18.2 ms; the day book page 3.5 ms and its period totals 37.8 ms. Over HTTP against the development server every report answered in 39 to 135 ms. Budgets: statements 30 s, ledger screens 20 s, day book 15 s.

## Not in M1

- Stock: no opening or closing stock and no stock valuation in profit and loss or the balance sheet; no inventory columns in the day book.
- Cost centres, bill-wise details, multi-currency columns, tax reports, budgets.
- Comparative and additional columns (previous period, other periods, percentages), monthly views of a group, a cash-flow or funds-flow statement, ratio analysis.
- Configurable layouts (vertical or horizontal statements, narrations in the day book, filters, saved views); the day book filter by voucher type.
- Editing from a report: the voucher view is read-only.
- Print styles: `@ten98/ui` 0.37.0 has none and apps may not add their own, so a printed report also shows the command bar and view switches above it (requested from the design system). Tables are not virtualized: very long statements render every line (requested with the print styles).

Requirement status follows D-01: none of this is described as equivalent to any other product.
