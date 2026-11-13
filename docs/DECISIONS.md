# Decisions

Decision records for ten98-books. Levels follow [ten98-code-system DECISIONS](https://github.com/Ten98-IO-Company/ten98-code-system/blob/main/docs/DECISIONS.md): L0 worker session, L1/L2 coordinator (main session) with evidence, L3 owner. D-01 to D-08 were researched on 2026-11-13, challenged by an independent reviewer the same day, and amended where the objection held. A record changes only when its reversal trigger fires or the owner overrides it.

## D-01 Scope: workflow compatibility by milestone

- **Decision (L2).** The product gives accountants who come from keyboard-driven desktop accounting software the same accounting outcomes and task flows (same steps and keyboard path where a browser allows it), rendered with `@ten98/ui` and our own wording. Build order: M0 foundation → M1 core accounting loop (company, groups, ledgers, accounting vouchers, day book, trial balance, balance sheet, P&L, ledger drill-down, keyboard shell) → M2 inventory, orders, bill-wise, cost centres, multi-currency, banking → M3 GCC tax and e-invoicing → M4 payroll, audit views, import/export → M5 remaining rows. Tax is modelled in the M1 voucher schema (tax classification and rate on lines, second-language names) so M3 adds behaviour, not columns. The first tax release targets the 2027 UAE SME and Oman e-invoicing windows and late Saudi adopters; it does not chase the 1 February 2027 Saudi wave.
- **Requirement status.** A requirement row is `doc-derived` (from public documentation), `observed` (confirmed on a licensed install in ordinary use) or `done` (observed, with a fixture of the expected accounting outcome and a passing test). Nothing is described as equivalent before `done`.
- **Rationale.** The double-entry loop is the dependency of everything else. A statutory date 80 days out cannot be met on an unbuilt ledger, and buyers in that wave will already have chosen.
- **Rejected.** A visual copy of any reference screen. Tax first.
- **Reversal trigger.** Interviews or sales evidence showing a different first segment.
- **Confidence.** High on order, medium on row completeness.

## D-02 Stack: the Discover profile

- **Decision (L2).** TanStack Start + Nitro on Node 24, React 19, TypeScript 7 strict, PostgreSQL 18, Drizzle, Better Auth through `createTen98Auth`, zod, pg-boss, pnpm, `@ten98/runtime` and `@ten98/ui` at the canonical pins, under a `ten98-books` profile in the code-system architecture declaration. The foundation (auth, workspaces, RBAC, invitations, account, API keys, shell, migration runner, Docker, CI) is adopted from ten98-discover per the feature catalogue. Screens use TanStack Router file routes; the API keeps Discover's `api/$.ts` → `handleApi` entry with one handler module per feature area.
- **Rationale.** `defaultAuthenticatedNodeStack` is `discover`; the database policy default is PostgreSQL + Drizzle; Campaign's SQLite profile is in transition.
- **Rejected.** Campaign's stack. A new stack. Adopting a copyleft accounting codebase.
- **Risk.** Discover is a single-route app with a large raw-SQL server; adopt its mechanisms, not its single-file layout. Report queries need their own statement-timeout budget (Discover's pool default is 10 s).
- **Confidence.** High.

## D-03 Tenancy: workspace = customer, project = company (books)

- **Decision (L2).** A workspace is the customer organisation; each project is one company (one set of books). Every accounting table carries `company_id` with composite foreign keys that include it. Authorization stays at every server entry point (`projectAccess`), and the access check and the transaction are one call: `withCompany`. Accounting tables enable forced row-level security. Two database roles: a migrator that owns the tables, and a non-owner application role (`NOSUPERUSER NOBYPASSRLS`) used by web and job processes. Policies read `current_setting('app.company_ids', true)`, a list set transaction-locally, so a missing context returns nothing and group-company reports remain possible. Boot and CI assert the role attributes and `relforcerowsecurity` on every accounting table. Jobs carry `company_id` in the payload and go through `withCompany`. Better Auth and pg-boss tables stay outside RLS.
- **Rationale.** A cross-company leak in a ledger is unrecoverable; RLS is cheap on day one and costly to retrofit. Without the role split the policy is silently inert, because owners without FORCE and all superusers bypass it.
- **Rejected.** Schema per tenant. App-layer checks only. RLS with a single superuser connection.
- **Fallback.** If two roles cannot be delivered in M0, ship `withCompany` + composite keys + wrong-company negative tests and track RLS as an open gap; do not call that RLS.
- **Reversal trigger.** Measured planner regressions that indexes cannot fix.
- **Confidence.** Medium-high.

## D-04 Ledger model

- **Decision (L2).** `voucher` header + `voucher_line` (ledger, Dr/Cr) + `inventory_line`. Money is `BIGINT` minor units with a per-currency `minor_units` (2 or 3; changing it needs a migration). Each line stores transaction-currency and base-currency amounts already rounded, plus the FX rate. Quantities, unit rates and FX rates are `NUMERIC`. Tax is rounded where the country rule says (per line or per document), recorded on the tax configuration. Vouchers are editable and deletable, with an always-on append-only revision log and soft delete; masters are logged the same way. A voucher locks when its e-invoice is cleared/reported or its date falls in a locked period. Voucher numbers come from locked counter rows per company, voucher type and series; counters are taken last in the posting transaction, in a fixed order (voucher series, then e-invoice counter), and posting transactions stay short. Opening balances and year-end carry-forward are computed at report time; a fixture of about three years and 500,000 lines is the benchmark that decides when a maintained period-balance table is added.
- **Numbering (amended 2026-11-14 after observation on a licensed install).** Automatic numbering never reuses or renumbers: a deleted voucher leaves a permanent gap, an altered voucher keeps its number when its date changes, and a voucher inserted on an earlier date takes the next free number. This matches the observed default of the reference workflow, so it is no longer a disclosed difference. A cancelled voucher keeps its number and its row and has no accounting effect. An optional voucher takes no number and stays out of the books until it is made regular. Renumber-on-insert and manual numbering are not offered; renumbering conflicts with e-invoice counter chains.
- **Rejected.** Immutable reversal-only ledger (breaks the alter/delete flow). Float or `NUMERIC` money. Sequences for numbering (not gapless).
- **Risk.** Back-dated stock edits force revaluation of later issues: weighted average and FIFO only at first, with a recompute job and regression fixtures.
- **Reversal trigger.** Regulator or auditor guidance requiring immutability at posting.
- **Confidence.** Medium-high.

## D-05 Keyboard-first UX in the browser

- **Decision (L2).** One command registry with contexts drives menus, key hints, a command palette and a remappable keymap. Two keymaps: "classic" (function keys for voucher types, accept shortcut, create-master-in-place) and "web-safe"; the user chooses at onboarding and can switch. Enter-advances-field applies on entry surfaces only. Keys a browser tab cannot deliver (Ctrl+N/T/W, Alt+F4, F11) and keys that collide with browser chrome get documented alternates, settled by a Playwright key-reachability test on Chromium, Firefox and WebKit. Reusable pieces land in `@ten98/ui` first, in this order: shortcut registry hook, dense entry grid (built while the M1 back end is built), print styles, command palette. M0 needs none of them.
- **Rejected.** Desktop wrapper as the primary client. Printable single-key shortcuts outside focused widgets (WCAG 2.1.4).
- **Reversal trigger.** Reachability results or user feedback rejecting the alternates; then propose an installable shell.
- **Confidence.** High on feasibility, medium on the exact remaps.

## D-06 Clean room

- **Decision (L2, binding on every session).** Reimplement behaviour, never expression. No third-party product code, help text, screenshots, icons, sample data, screen artwork or product names in source, UI copy, tests or public docs. Reference notes (requirement rows, flow notes, market and legal research) stay outside this repository. Reference products are studied only under licences and vendor permissions the owner holds; analysts write behaviour in their own words outside this repository, and implementers work from those notes, never from vendor code or text. Import features read only files a user exported from their own system.
- **Rationale.** Functionality and workflows may be reimplemented; expression and marks may not.
- **Reversal trigger.** Written advice from counsel.
- **Confidence.** Medium (not legal advice).

## D-07 Money arithmetic and dependencies

- **Decision (L2).** One money module, promoted to `@ten98/runtime` (standard library only): `bigint` minor units, parse/format by currency exponent, multiplication by a decimal-string rate with an explicit rounding mode, remainder allocation, property-tested. Division-heavy valuation runs in PostgreSQL `NUMERIC`. On the wire and in JSON, money is a string; the app owns the zod schema and registers a `pg` `int8` parser that returns `bigint`. Drizzle columns use `bigint({ mode: 'bigint' })`. Other packages are added only when a milestone needs them and only through the code-system profile: XML building and XML-DSig for e-invoicing, Arabic number-to-words, server PDF if browser print proves insufficient. Copyleft and source-available accounting projects are reference reading only.
- **Rejected.** A decimal library in the runtime (its boundary forbids dependencies; exact scaled `bigint` arithmetic covers multiply and allocate). Ad-hoc arithmetic in screens.
- **Risk.** In-house e-invoice signing is a known source of rejections: validate against the official validators in CI before any live onboarding.
- **Confidence.** High on licences, medium on the arithmetic scope.

## D-08 Session model and model routing

- **Decision (L1).** The main session coordinates, decides L1/L2, owns shared contracts (migration numbering, API route table, command registry, requirement status) and performs every merge into `dev`. Each feature set gets one worker session on one branch cut from `dev`, with a file allowlist and acceptance cases; it is archived after its branch merges. At most two implementation workers and one independent reviewer run at a time per repository. Models: Opus 5.5 at high effort for foundation, ledger, money, tenancy and tax engines and for independent review; Sonnet 5.5 at medium effort for masters, screens and reports that follow an established pattern and for research harvests; Haiku 5.5 for mechanical edits. The coordinator's own model is not used for workers.
- **Reversal trigger.** Repeated failed repairs on a tier (move up) or consistently clean reviews (move down).
- **Confidence.** Medium.

## D-09 Foundation conventions

- **Decision (L2).**
  - **Dates.** Voucher and report dates are `DATE` in the company's calendar; instants are `timestamptz`. A company stores its time zone, financial-year start and books-beginning date. E-invoice issue time derives from the company time zone.
  - **Period lock.** A company has a locked-through date, advanced manually or by filing a tax return; creating, altering or deleting a voucher on or before it needs an audited unlock by an owner.
  - **Languages.** Masters carry an optional second-language name from M1. Layouts must hold in RTL. UI localisation arrives with M3.
  - **Reports.** Server report modules return typed rows from SQL with their own timeout budget; drill-down is by route; export uses the runtime CSV helpers; print uses browser print styles first.
  - **API.** JSON through `handleApi`, zod at the boundary, money as strings, an idempotency key on every create that posts.
  - **Tests.** `node --test` against a real PostgreSQL 18 connected as the non-owner role; golden accounting fixtures (debits equal credits, trial balance sums to zero); a wrong-company negative test per handler module.
- **Confidence.** Medium-high.

## D-10 Default chart of accounts and voucher types

- **Decision (L2, 2026-11-14).** A new company is seeded with a default chart: 15 primary groups, each with a nature (asset, liability, income or expense), 13 sub-groups, and two ledgers (cash, and the profit and loss account), plus the eight accounting voucher types of M1 (contra, payment, receipt, journal, sales, purchase, credit note, debit note). The hierarchy and the accounting behaviour follow what accountants from desktop software expect; the names are ordinary accounting terms in our own wording. Every seeded row carries a stable `system_key`; behaviour (cash and bank handling, party ledgers, tax ledgers, stock, the profit and loss transfer, voucher-type rules) hangs on the key, never on the name, so users can rename and translate freely and seeded rows cannot be deleted. One seeding routine serves company creation and the backfill of existing companies.
- **Ledger opening balances** are entered per ledger as of the books-beginning date and may be out of balance while a company is being set up; the trial balance shows the difference instead of blocking entry.
- **Rationale.** Later features (bank reconciliation, receivables, tax, stock valuation, import) need to recognise groups reliably; names are user data. Functional categories are not expression (D-06), wording is.
- **Rejected.** Matching on names. An empty chart. A country-specific statutory chart in M1.
- **Reversal trigger.** Interview evidence that GCC accountants expect a statutory chart by default.
- **Confidence.** Medium-high. Reviewed with the ledger core change that implements it.

## Open owner decisions (L3)

| ID | Question |
|---|---|
| O-6 | UAE e-invoicing route: which accredited service provider to contract (paid). Needed at M3 planning. |
| O-7 | Interviews with 10–15 GCC accountants before locking the M3–M5 order. |
| O-8 | Hosting region and Saudi data residency. Needed before any production deploy. |
