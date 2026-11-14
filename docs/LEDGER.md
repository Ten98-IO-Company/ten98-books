# Ledger core (M1)

The double-entry books of one company: account groups, ledgers, voucher types, vouchers and a revision log, with the posting rules on the server and a minimal read model (trial balance, ledger balance) for verification. The app's screens consume this API through the routes below (masters first; the other company pages are still placeholders); this page documents the API, not the screens. The contract is [D-03, D-04, D-07, D-09 and D-10](DECISIONS.md); this page describes what is built.

Code: [migrations/0004_ledger.sql](../migrations/0004_ledger.sql) (tables, constraints, seeding routine), [src/server/ledger/](../src/server/ledger) (posting rules and read model), [src/server/api/masters.ts](../src/server/api/masters.ts) and [src/server/api/vouchers.ts](../src/server/api/vouchers.ts) (HTTP), [src/lib/ledger.ts](../src/lib/ledger.ts) (wire schemas and types), [src/lib/money.ts](../src/lib/money.ts) (money on the wire).

## Data model

Every table carries `company_id`, references its neighbours through composite foreign keys that include it, and forces the one company row-level security policy (D-03). The tables are listed in `accountingTables` in `src/server/tenancy.ts`, so the boot assertion refuses to start if any of them loses forced RLS or its policy.

| Table | Holds | Application role may |
|---|---|---|
| `account_group` | Group tree: parent, nature (asset, liability, income, expense), gross-profit flag, `system_key`, name, second-language name, revision | read, insert, delete, update name, parent, nature and flag |
| `ledger` | Group, `system_key`, names, opening balance (amount and Dr/Cr side as of books beginning), revision | read, insert, delete, update group, names and opening |
| `voucher_type` | Kind (one of the eight below), `system_key`, names, numbering series, revision | read, insert, rename |
| `voucher_counter` | Last number issued per company, voucher type and series | read, insert, update |
| `voucher` | Type, series, number, date (`DATE`), narration, status (regular, cancelled, optional), post-dated flag, idempotency key and request hash, revision, soft-delete marker | read, insert, update lifecycle columns; never delete |
| `voucher_line` | Line order, ledger, side, base amount (`BIGINT` minor units, > 0), transaction currency, amount and FX rate, tax classification and rate | read, insert, delete (alter replaces lines) |
| `revision_log` | Who, when, entity, action, before and after snapshots | read and insert only |

Nature and the gross-profit flag are stored on every group and must equal the parent's (a composite foreign key with `ON UPDATE CASCADE`), so a whole sub-tree always shares its primary group's nature, and changing a primary group's nature carries its sub-groups along. A trigger refuses a group cycle.

M1 posts in the base currency only: the database requires rate 1 and equal transaction and base amounts (`voucher_line_base_currency_only`), and empty tax columns (`voucher_line_no_tax_yet`). M2 and M3 drop those two named checks; the columns are already there (D-01).

Money is `bigint` minor units in the server and the database, and a decimal string on the wire (D-07). Input amounts are checked for shape by `moneyText` and parsed with the company's currency exponent by `parseMoney` from `@ten98/runtime`, which refuses extra decimal places and amounts outside the `bigint` range instead of rounding. All sums go through the runtime's money functions. `pgTypes` in `src/server/db.ts` (from M0) reads `int8` as `bigint` and `DATE` as text on the application pools only. pg-boss opens its own connections and keeps its own parsing; Better Auth's one `int8` column (`rateLimit.lastRequest`, unused because the shared preset turns its limiter off) is declared in Drizzle's number mode, which converts the `bigint`. The ledger needed no change there. Responses format every `bigint` with `moneyToWire`, so in ledger responses every `bigint` is an amount; numbers and revisions are plain integers.

## Default chart (D-10)

`ledger_seed_company(company_id)` in the migration is the one seeding routine: company creation calls it inside the company's `withCompany` transaction, and the migration runs it for every company that existed before it. It is idempotent: rows already present by `system_key` are left as the user renamed or moved them.

- 15 primary groups: Branches and Divisions, Capital, Suspense, Current Liabilities, Loans and Borrowings (liabilities); Current Assets, Fixed Assets, Investments, Deferred Expenses (assets); Sales, Direct Income, Indirect Income (income); Purchases, Direct Expenses, Indirect Expenses (expenses). Sales, Purchases, Direct Income and Direct Expenses count towards gross profit.
- 13 sub-groups: Reserves and Surplus (Capital); Bank Accounts, Cash on Hand, Deposits Paid, Loans and Advances Given, Inventory, Trade Receivables (Current Assets); Taxes and Duties, Provisions, Trade Payables (Current Liabilities); Bank Overdrafts, Secured Loans, Unsecured Loans (Loans and Borrowings).
- Two ledgers: Cash (Cash on Hand) and Profit and Loss (outside every group; the only ledger without one).
- Eight voucher types, one per kind: contra, payment, receipt, journal, sales, purchase, credit note, debit note.

Behaviour hangs on `system_key`, never on names. Built-in rows can be renamed and given a second-language name, cannot be deleted (API check and a database trigger) and keep their nature when moved.

Behaviour families (coordinator decision under D-10, enforced in the API and the database):

- Cash and bank behaviour comes from the seeded cash and bank groups by `system_key` ancestry: a ledger is a cash or bank ledger when its group is, or sits below, `cash_in_hand`, `bank_accounts` or `bank_overdraft`.
- A built-in ledger moves only inside its behaviour family: the cash ledger stays under the cash and bank groups (moving the ledger, or a group holding it, out of them is refused), and the profit and loss ledger never has a group.
- A group's nature cannot change, by editing it or by moving it under a parent of another nature, while its sub-tree holds a built-in group or ledger, or any ledger with posted lines or a non-zero opening balance. Reclassify by moving user ledgers between groups; that stays allowed and logged. The database enforces the built-in part; the API enforces all of it.

Seeding is not written to the revision log: built-in rows are identified by their `system_key`.

## Posting rules

All in `src/server/ledger/`; screens never compute balances. Each request is one short `withCompany` transaction: viewers read, owners, admins and editors write, and a company the user cannot reach answers "not found".

- A voucher has at least two lines, every amount is more than zero and within range, and debits equal credits.
- Every ledger belongs to the company (a ledger of another company is "not found").
- The date is on or after the books-beginning date and after the company's locked-through date. A voucher already dated on or before the lock cannot be altered, cancelled or deleted, and opening balances cannot change while the lock reaches the books-beginning date (D-09).
- Contra: every line is a cash or bank ledger. Payment: at least one credit to a cash or bank ledger, and no debit to one. Receipt: at least one debit to a cash or bank ledger, and no credit to one. Journal: no cash or bank ledger at all; money movements go through the three types above, which is the behaviour accountants expect from desktop software. Sales, purchase, credit note and debit note accept any ledgers in M1.
- The database repeats the integrity rules: a deferred constraint trigger checks at commit that every touched voucher has at least two lines, equal debits and credits, and a number exactly when it is not optional; amounts are checked positive; a counter only moves forward by one, from 1; a number is set only to the value its counter issued in the same transaction and never changes afterwards; a deleted voucher never changes; a cancelled voucher stays cancelled; a numbered voucher never becomes optional; lines of a cancelled or deleted voucher cannot be added, changed or removed.
- Group moves and nature changes are serialised per company (a transaction-scoped advisory lock, taken by the API before any row lock and again inside the database trigger, which also requires READ COMMITTED), so two opposite moves cannot both pass the cycle check. A deadlock or serialization failure answers 409 "try again"; nothing is saved.
- Every create, alter, cancel and delete of a group, ledger, voucher type or voucher writes `revision_log` in the same transaction. Snapshots are the API's own objects with amounts as exact minor-unit strings. When a nature or gross-profit change cascades to sub-groups, each sub-group's revision is bumped and its own `alter` entry is written.
- Alter and delete take the `revision` the client last read and refuse a stale one ("changed by someone else"). Altering a voucher states its whole body: `date`, `narration` (null to clear), `status`, `postDated`, `lines`; nothing falls back to a default.

## Trust boundary

Authorization is `withCompany` at every entry point. Through the API every rule on this page holds, including under concurrency: the group-tree lock serialises group moves, nature changes and every change of a ledger's group, and a nature change locks the sub-tree's ledger rows (in the same id order postings take them) before it checks for postings.

The database guards are a second line against bugs in this application, not authorization: anyone able to run SQL as `books_app` chooses the company scope (`app.company_ids`) and can act on any company they list. Every guard that reads other rows first requires the changed row's company to be inside the current scope, so clearing or changing the scope before commit makes the transaction fail instead of hiding rows from the check; as a consequence, removing a company (a cascade from its workspace) must run inside that company's scope, and nothing in M1 removes companies. For direct SQL inside the scope, the database itself refuses: an unbalanced or one-line voucher, a non-positive amount, a counter that does not move forward by exactly one or that issues a number no voucher holds, a number its counter did not issue in the same transaction, a series other than its voucher type's, a changed number, any change to a deleted voucher, an un-cancelled or re-optional voucher, a line change on a cancelled or deleted voucher, a deleted built-in row, a built-in group (or a group holding a built-in ledger) changing nature, the cash ledger leaving the cash and bank groups, and a group cycle.

Outside what the database guards cover (the API enforces these; direct SQL can break them): a nature change of a group whose ledgers have postings or opening balances; replacing a voucher's lines and cancelling it in one direct transaction (the lines change while it is still regular); the posting rules per voucher kind, the books-beginning date and the period lock; idempotency; and writing a revision log entry for each change.

The period lock (locked-through date) is enforced by the application only, not by the database, and the audited owner unlock (D-09) is not built: the date is set outside the API for now.

## Numbering

Numbers come from the `voucher_counter` row of the company, voucher type and series, taken last in the posting transaction: one statement advances the counter, the next stores the number on the voucher (the database accepts only a number its counter issued in that transaction). Concurrent postings of one series wait on that row only, and a rolled-back posting returns its number. At commit the database checks that every number a counter issued belongs to a voucher row of that type and series, so the only gaps in a series are the numbers of deleted vouchers, whose rows remain.

- Each voucher type counts separately from 1, in entry order, whatever the dates.
- A deleted voucher keeps its row and number, so its number is a permanent gap; nothing is renumbered.
- An altered voucher keeps its number, also when its date moves.
- A voucher entered on an earlier date takes the next free number.
- A cancelled voucher keeps its number and row (and its lines, for the record) and has no accounting effect.
- An optional voucher takes no number and has no effect until it is altered to regular, when it takes the next number.
- A post-dated voucher is numbered like any other and counts from its own date.

Voucher creation requires an `idempotencyKey`, unique per company: the same key with the same body returns the first result (`replayed: true`, status 200); the same key with a different body is refused (409). A transaction-scoped advisory lock on the key makes a concurrent retry wait for the first attempt.

## Read model

`trialBalance(context, from, to)` returns one typed row per ledger (opening, period debits and credits, closing, each as non-negative debit and credit amounts), totals, and the opening-balance difference, which is shown rather than blocking while a company is being set up (D-10). `ledgerBalance(context, ledgerId, from, to)` returns that ledger's row from the same shared query with a single-ledger filter, so the two always agree. The report modules in `src/server/reports/` build on that query (see [REPORTS.md](REPORTS.md)). Only regular, undeleted vouchers count. Report queries run with a 30-second statement timeout.

Opening balances are computed at report time (D-04): a balance-sheet ledger opens with its opening balance plus everything before the period; an income or expense ledger opens with what was posted earlier in the same financial year only, and what it gathered in earlier years is carried into the profit and loss ledger. Gross profit, net profit and the balance sheet are derived from the rows (nature, primary group and gross-profit flag); the golden fixture test shows how.

## HTTP API

All routes are under `/api/companies/<company id>`, where the company id is its workspace id ([TENANCY.md](TENANCY.md)); state changes are POST, so the central origin check in `src/server/api.ts` covers them. Amounts are decimal strings.

| Method and path | Does |
|---|---|
| `GET groups`, `POST groups` | List; create (`name`, `secondLanguageName`, `parentId`, or `nature` and `grossProfit` for a primary group) |
| `GET groups/<id>`, `POST groups/<id>`, `POST groups/<id>/delete`, `GET groups/<id>/revisions` | Read; alter (with `revision`); delete (with `revision`); history |
| `GET ledgers`, `POST ledgers` | List; create (`name`, `secondLanguageName`, `groupId`, `opening: { amount, side }`) |
| `GET ledgers/<id>`, `POST ledgers/<id>`, `POST ledgers/<id>/delete`, `GET ledgers/<id>/revisions` | Read; alter; delete (refused while any voucher uses it); history |
| `GET ledgers/<id>/balance?from=&to=` | Ledger balance for the period |
| `GET voucher-types`, `GET voucher-types/<id>`, `POST voucher-types/<id>`, `GET voucher-types/<id>/revisions` | List; read; rename; history |
| `GET vouchers?from=&to=[&limit=][&after=]`, `POST vouchers` | One page of undeleted vouchers in the period, by date then entry order (`limit` 1 to 500, default 100; `after` is the previous page's `next`, null on the last page); create (`idempotencyKey`, `voucherTypeId`, `date`, `narration`, `status` regular or optional, `postDated`, `lines: [{ ledgerId, side, amount }]`) |
| `GET vouchers/<id>`, `POST vouchers/<id>` | Read (also cancelled and deleted ones); alter (all required: `date`, `narration`, `status`, `postDated`, `lines`, `revision`) |
| `POST vouchers/<id>/cancel`, `POST vouchers/<id>/delete`, `GET vouchers/<id>/revisions` | Cancel; soft delete; history |
| `GET trial-balance?from=&to=` | Trial balance for the period |

Response details the screens rely on:

- **`inUse`** on every row of `GET groups`, `GET groups/<id>`, `GET ledgers` and `GET ledgers/<id>`: true when a delete would be refused for use, computed by the same SQL test the delete runs. A group is in use when it holds sub-groups or ledgers; a ledger when any voucher line names it, including lines of cancelled and deleted vouchers. Built-in rows are refused on another ground (`systemKey` is set). Create and alter answers, and revision snapshots, are the plain master without `inUse`.
- **`actorName`** on every row of the `.../revisions` routes: the display name of the user who made the change, or null once that user no longer exists (`actorId` stays). It is read inside the company transaction like the rest of the history, and no email is ever returned.
- **Errors** answer `{ "error": "<plain-language message>", "code": "<reason>" }` with the same status as before. `code` is one of `ledgerErrorCodes` in `src/lib/ledger.ts` (typed `LedgerErrorCode`, shared by client and server): `validation`, `not_found`, `stale_revision`, `retry` (deadlock or serialization failure; nothing saved), `duplicate_name`, `in_use`, `seeded_row`, `nature_fixed`, `family_rule`, `cycle`, `locked_period`, `before_books_beginning`, `unbalanced`, `posting_rule` (a voucher type's cash and bank rule), `voucher_state` (cancelled, optional or numbered status forbids the change), `idempotency_mismatch`. A company the user cannot reach answers `not_found` exactly as a missing one does. A member of a company that is not set up yet gets 409 `not_set_up` on every route ([TENANCY.md](TENANCY.md)). Refusals outside the ledger (sign-in, origin check, rate limit, other areas) carry no `code`, as before.

## Tests

`tests/ledger-golden.integration.ts` posts a five-week trading fixture of 18 vouchers across all eight types and checks the trial balance (53,625 each side), gross profit (3,500), net loss (7,400) and balance sheet (42,250 each side) derived from the read model, a three-decimal company, and the tenancy negatives. `tests/ledger-posting.integration.ts` covers the refusals, the database-level backstops, numbering under 50 concurrent posts, the voucher lifecycle, idempotency, the revision log, master rules, the locked period and year-end carry-forward. `tests/ledger-seed.integration.ts` upgrades a database that already holds a company and checks the backfill, idempotent seeding and the boot assertion. `tests/ledger-guards.integration.ts` drives the database guards with raw SQL as `books_app` (scope tampering before commit, forged and rewound numbers, frozen lines, concurrent opposite group moves) and the behaviour-family, nature-change, alter and pagination rules through the API, including the races between ledger moves, group moves, nature changes and postings. `tests/ledger-api.integration.ts` checks `actorName`, the error codes (with statuses and messages unchanged, and none outside the ledger) and `inUse` against the delete rule.

## Not in M1

No report read models beyond the trial balance and ledger balance; no inventory lines, bill-wise allocations, cost centres, multi-currency posting or tax computation (the columns exist and stay empty); no user-created voucher types or extra numbering series; no manual numbering or renumbering (D-04); no audited unlock of a locked period (the locked-through date is set outside the API for now); no conversion job for post-dated vouchers; no maintained period-balance table (D-04 benchmark pending). Requirement status follows D-01: none of this is described as equivalent to any other product.
