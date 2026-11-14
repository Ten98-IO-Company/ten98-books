# Roadmap and status

What ten98-books is building, in what order, and where each piece stands. The order and scope come from [D-01](DECISIONS.md); this page records progress. The coordinator updates it with every merge into `dev`.

Nothing is deployed. `main` holds no application code yet; everything below is on `dev` or on a branch.

## Status words

| Word | Meaning |
|---|---|
| merged | On `dev`, after independent review and a passing CI run |
| in review | Built on a branch; under independent review or review fixes |
| in progress | Being built |
| planned | Not started |
| blocked | Waiting on something named beside it |

A requirement counts as done only when its behaviour was observed, has a fixture of the expected accounting outcome, and has a passing test (D-01). "merged" is a statement about code, not about parity.

## M0 Foundation: merged

First-user setup, sign-in and account security, team and invitations, the shell, migrations, Docker and CI. Forced row-level security with two database roles and the `withCompany` access check ([D-03](DECISIONS.md)).

## M1 Core accounting loop

| Piece | Status | Notes |
|---|---|---|
| Keyboard shell: command registry, `classic` and `web-safe` keymaps, company menu | merged | [KEYBOARD.md](KEYBOARD.md) |
| Ledger core: groups, ledgers, voucher types, vouchers, numbering, revision log, seeded chart | merged | [LEDGER.md](LEDGER.md) |
| Ledger API additions: names in history, stable error codes, in-use flags | merged | |
| Reports: day book, trial balance, profit and loss, balance sheet, group and ledger drill-down, CSV export | merged | [REPORTS.md](REPORTS.md) |
| Masters screens: chart of accounts, create and alter group and ledger, history | merged | |
| Company model: a workspace is one company ([D-03](DECISIONS.md) as amended) | merged | [TENANCY.md](TENANCY.md), migration 0005 |
| Demo data: dataset format, `seed:demo`, `demo:compare` | in review | Same data is loaded into the reference installation for like-for-like checks |
| Voucher entry screen | blocked | Needs the entry grid from the next `@ten98/ui` release |
| `classic` as the default keymap and a parity audit of every command ([D-05](DECISIONS.md) as amended) | in progress | |
| Voucher numbering that restarts each financial year, as accountants expect | planned | Found by the like-for-like comparison; rules being observed before the counters change |

Open items inside merged pieces:

- Printed statements still include the app chrome; print styles come from `@ten98/ui`.
- Report page keys reach into the table's rows for focus until `@ten98/ui` exposes focus control.
- Apple-platform chords and hot letters on non-Latin keyboard layouts wait for the next `@ten98/ui` release.
- Cross-browser key reachability is unmeasured; the profile has no browser test runner yet.
- The period lock is enforced in the application only, and the audited unlock is not built.

M1 is accepted when, on a fresh installation and by keyboard only in both keymaps, a user can set up a company, maintain masters, enter and alter every accounting voucher type, and read the reports with drill-down; and `demo:compare` shows no difference on the starter company.

## M2 Inventory, receivables and banking: in progress

Delivered in slices. Bill-wise receivables and payables (base currency) is being built first, from a design that was reviewed twice against observed behaviour; then cost centres and accounting projects, currencies and rates, and exchange differences.

Stock masters, units and locations; inventory vouchers and valuation (weighted average and FIFO first); orders and their tracking; bill-wise receivables and payables with credit periods and ageing; cost centres and accounting projects (the project dimension of D-03); multi-currency with exchange differences; banking with cheque details and reconciliation; interest; budgets.

## M3 GCC tax and e-invoicing: planned

VAT for the UAE and Saudi Arabia first, then Oman, Bahrain and Kuwait rules as they apply: tax classification on lines (already in the M1 voucher schema), returns and adjustments, e-invoice generation, signing and reporting validated against the official validators before any live onboarding ([D-07](DECISIONS.md)). Interface localisation, including Arabic and right-to-left layouts.

## M4 Payroll, audit and data exchange: planned

Payroll masters and vouchers; audit views over the revision log; import of data a user exported from their own system, and export.

## M5 Remaining requirement rows: planned

Everything in the requirement inventory not covered above, in the order the evidence and user feedback justify.

## How work is verified

- Each feature set is built on its own branch from `dev` and reviewed independently before merging; reviewers run the code and try to break it.
- Tests run against a real PostgreSQL 18 as the non-owner database role; each handler module has a wrong-company negative test.
- Accounting outcomes are pinned by golden fixtures and by comparison with the same demo data in the reference installation.
- Decisions that change scope, tenancy, money handling or keyboard behaviour are recorded in [DECISIONS.md](DECISIONS.md) with their evidence.

## Documentation map

| Document | Holds |
|---|---|
| [README](../README.md) | What the project is and how to run it |
| [AGENTS.md](../AGENTS.md) | Contributor rules |
| [DECISIONS.md](DECISIONS.md) | Decision records |
| [ROADMAP.md](ROADMAP.md) | This page |
| [LEDGER.md](LEDGER.md) | Data model, posting rules, numbering, ledger HTTP API |
| [REPORTS.md](REPORTS.md) | Report definitions, period rules, reports HTTP API |
| [KEYBOARD.md](KEYBOARD.md) | Commands and both keymaps |
| [TENANCY.md](TENANCY.md) | Company model, roles, creation paths, what migration 0005 changes |
