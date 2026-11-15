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
| Keyboard shell: command registry, `classic` and `web-safe` keymaps, company menu | merged | [KEYBOARD.md](KEYBOARD.md). A go-to returns once to the screen it was opened from and gives way to a report's own drill-down trail; covered by key-walk tests, not yet checked in a real browser by a reviewer |
| Ledger core: groups, ledgers, voucher types, vouchers, numbering, revision log, seeded chart | merged | [LEDGER.md](LEDGER.md) |
| Ledger API additions: names in history, stable error codes, in-use flags | merged | |
| Reports: day book, trial balance, profit and loss, balance sheet, group and ledger drill-down, CSV export | merged | [REPORTS.md](REPORTS.md). Re-checked independently on `dev`; its findings are fixed (statements before the books begin, register pages kept in the address, statement CSV sides). A trial balance for a period starting after the books begin carries all earlier income and expense in one profit and loss row, as observed |
| Masters screens: chart of accounts, create and alter group and ledger, history | merged | The group and ledger forms share one lookup behaviour with the cost-centre forms (see M2). Master names are unique under the name match key ([D-10](DECISIONS.md), migration 0010): names that differ only by case, spaces or the ignored characters are one name, as observed The forms' lookups compare typed text and choices under the same key, and a duplicate-name refusal shows on the Name field with what was typed kept. The order in which Enter resolves typed text is ours and provisional ([KEYBOARD.md](KEYBOARD.md)); it is not yet settled by observation The company switcher, the theme and the unsaved-changes question come from `@ten98/ui` 0.39.0; the accept question at the end of a form answers only a fresh key press, so a held key cannot save |
| Company model: a workspace is one company ([D-03](DECISIONS.md) as amended) | merged | [TENANCY.md](TENANCY.md), migration 0005 |
| Demo data: dataset format, `seed:demo`, `demo:compare` | merged | [demo/README.md](../demo/README.md). Five companies seeded through the ledger module: masters and bills matched under the name match key, vouchers cancelled without lines, and each line's cost rows. Compared with the reference installation, voucher numbers, pending bills and cost centre figures show no difference in any company (lines matching: starter 30, two trading companies 64 each, the fabrication company 64, the consulting company 81). The consulting company's 12 foreign-currency lines are reported as not yet comparable; stock figures are not compared yet |
| Voucher entry screen | in progress | The entry grid arrived with `@ten98/ui` 0.38.0, which is adopted. Design reviewed and revised against observed entry flows; three slices planned; the first (payment, receipt, contra, journal: create) is being built. The reads the screen needs are merged (expected next number, resulting balances of a draft, proposed counter ledger: [LEDGER.md](LEDGER.md)) |
| `classic` as the default keymap and a parity audit of every command ([D-05](DECISIONS.md) as amended) | merged | Parity table and reserved keys in [KEYBOARD.md](KEYBOARD.md) |
| Voucher numbers per voucher type and financial year of the voucher's date; posting rules per voucher type as observed | merged | [LEDGER.md](LEDGER.md), migrations 0007 and 0009, [D-04](DECISIONS.md) as amended. A voucher can be saved as cancelled without lines and altered into another voucher type (it takes that type's next number). Prefix, suffix, manual numbering and other restart periods are not built |

Open items inside merged pieces:

- Printing: the app chrome is no longer printed and a one-page report prints every line. A register prints only the page on screen and its summary line names the vouchers shown; printing a whole register is not built. Print preview and paper have not been checked.
- Report tables use the package's paging keys and focus control. Keeping the highlight in step with the focused row still reads the rendered rows, because the table reports no focus change (requested from `@ten98/ui`); it must change before table virtualization is switched on.
- Menu letters also work by key position on non-Latin keyboard layouts (checked with synthetic key events, not on a real keyboard). Apple-platform chords are not adopted: they need choosing.
- Cross-browser key reachability is unmeasured; the profile has no browser test runner yet.
- The profile has no DOM test setup either: how a form is wired to its lookups and messages is covered by tests that read the source and by key-by-key walks, not by rendered tests.
- The period lock is enforced in the application only, and the audited unlock is not built.

M1 is accepted when, on a fresh installation and by keyboard only in both keymaps, a user can set up a company, maintain masters, enter and alter every accounting voucher type, and read the reports with drill-down; and `demo:compare` shows no difference on the starter company.

## M2 Inventory, receivables and banking: in progress

Delivered in slices, each from a design reviewed against observed behaviour.

| Piece | Status | Notes |
|---|---|---|
| Bill-wise receivables and payables in the base currency: bills, bill rows on voucher lines and opening balances, credit periods, pending list, outstanding, party bills and ageing reports (server and API) | merged | [LEDGER.md](LEDGER.md), [REPORTS.md](REPORTS.md), migrations 0006 and 0009. Bills are identified by the name match key ([D-10](DECISIONS.md)); the outstanding lists go by the side a bill lies on, so a customer's advance is a payable, as observed. No screen yet: the bill panel comes with the voucher entry screen |
| Cost categories and cost centres: masters, allocation rows on voucher lines, category summary and centre break-up reports (server and API) | merged | [LEDGER.md](LEDGER.md), [REPORTS.md](REPORTS.md), migration 0008. The masters screens are merged (categories, centres with their tree, the company switch, the ledger setting; [KEYBOARD.md](KEYBOARD.md)); the category summary and centre break-up screens are merged too ([REPORTS.md](REPORTS.md)); allocation on the voucher entry screen and the other observed cost reports are not built. Accounting projects ride on cost centres; how they are marked awaits an owner decision |
| Stock masters and opening stock: units, stock groups, categories, locations, items, opening stock per item and location, the company inventory switch (server and API) | merged | [LEDGER.md](LEDGER.md), [REPORTS.md](REPORTS.md), migration 0011. Statements stay balanced with stock in them: an opening stock row on the trial balance, opening and closing stock on the profit and loss account and the balance sheet. Stock is not valued yet: closing stock equals the opening rows' value. The demo datasets' stock masters are seeded and compared. Screens for the stock masters are not built |
| Item lines on vouchers and the stock journal; valuation (weighted average and FIFO) and stock reports; orders and notes | not started | Designed and reviewed against observed behaviour; built in three further slices |
| Currency masters, dated rates and a currency on ledgers (server and API) | merged | [LEDGER.md](LEDGER.md), migration 0012. Currencies are company masters with a symbol unique under the name match key; three dated rate lists (standard, selling, buying) with the latest rate on or before a date; rates inside the locked period are refused. Nothing changes for vouchers yet: a line in another currency is refused by the application and the database. Screens for currencies and rates are not built |
| Foreign amounts on voucher lines and bills; exchange differences at report time | not started | Designed and reviewed against observed behaviour; follows the inventory item lines, which change the same posting code |

Open items inside merged pieces:

- Bills are base-currency only; interest on bills and credit limits are not built.
- The voucher check and the opening-bill check re-read their voucher or ledger for every row (measured in [LEDGER.md](LEDGER.md)); not optimised.
- Cost centres: the other observed cost reports and allocation on the voucher entry screen are not built.

Stock masters, units and locations; inventory vouchers and valuation (weighted average and FIFO first); orders and their tracking; bill-wise receivables and payables with credit periods and ageing; cost centres and accounting projects (the project dimension of D-03); multi-currency with exchange differences; banking with cheque details and reconciliation; interest. Budgets are not planned: the reference installation has no budget masters, switch or reports, so there is nothing to match.

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
| [demo/README.md](../demo/README.md) | The demo dataset format, seeding and comparison |
| [TENANCY.md](TENANCY.md) | Company model, roles, creation paths, what migration 0005 changes |
| [ACCEPTANCE.md](ACCEPTANCE.md) | The feature inventory an acceptance walk of the production build is measured against, with the result columns left empty until a run |
