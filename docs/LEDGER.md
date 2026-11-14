# Ledger core (M1)

The double-entry books of one company: account groups, ledgers, voucher types, vouchers and a revision log, with the posting rules on the server and a minimal read model (trial balance, ledger balance) for verification. The app's screens consume this API through the routes below (masters first; the other company pages are still placeholders); this page documents the API, not the screens. The contract is [D-03, D-04, D-07, D-09 and D-10](DECISIONS.md); this page describes what is built.

Code: [migrations/0004_ledger.sql](../migrations/0004_ledger.sql) (tables, constraints, seeding routine), [src/server/ledger/](../src/server/ledger) (posting rules and read model), [src/server/api/masters.ts](../src/server/api/masters.ts) and [src/server/api/vouchers.ts](../src/server/api/vouchers.ts) (HTTP), [src/lib/ledger.ts](../src/lib/ledger.ts) (wire schemas and types), [src/lib/money.ts](../src/lib/money.ts) (money on the wire).

## Data model

Every table carries `company_id`, references its neighbours through composite foreign keys that include it, and forces the one company row-level security policy (D-03). The tables are listed in `accountingTables` in `src/server/tenancy.ts`, so the boot assertion refuses to start if any of them loses forced RLS or its policy.

| Table | Holds | Application role may |
|---|---|---|
| `account_group` | Group tree: parent, nature (asset, liability, income, expense), gross-profit flag, `system_key`, name, second-language name, revision | read, insert, delete, update name, parent, nature and flag |
| `ledger` | Group, `system_key`, names, opening balance (amount and Dr/Cr side as of books beginning), revision; bill-wise flag, default credit period (a count of days, weeks or months, or a fixed due date) and credit-days check | read, insert, delete, update group, names, opening and the bill-wise settings |
| `voucher_type` | Kind (one of the eight below), `system_key`, names, numbering series, revision | read, insert, rename |
| `voucher_counter` | Last number issued per company, voucher type and series | read, insert, update |
| `voucher` | Type, series, number, date (`DATE`), narration, reference and reference date (the supplier's invoice, or the original invoice of a note), status (regular, cancelled, optional), post-dated flag, idempotency key and request hash, revision, soft-delete marker | read, insert, update lifecycle columns and the reference; never delete |
| `voucher_line` | Line order, ledger, side, base amount (`BIGINT` minor units, > 0), transaction currency, amount and FX rate, tax classification and rate | read, insert, delete (alter replaces lines) |
| `revision_log` | Who, when, entity, action, before and after snapshots | read and insert only |
| `bill` | One party ledger's bill: its name (unique per ledger ignoring case, first spelling kept) and currency | read and insert; never update or delete |
| `bill_allocation` | A bill row of a voucher line, or of a ledger's opening balance: method as entered, bill, side, amount, and its terms (due date and credit period; copied onto settlements) | read, insert, delete (with its line, or when the opening rows are replaced) |
| `ageing_bucket` | The company's ageing columns, in order; none by default | read, insert, delete |

Nature and the gross-profit flag are stored on every group and must equal the parent's (a composite foreign key with `ON UPDATE CASCADE`), so a whole sub-tree always shares its primary group's nature, and changing a primary group's nature carries its sub-groups along. A trigger refuses a group cycle.

M1 posts in the base currency only: the database requires rate 1 and equal transaction and base amounts (`voucher_line_base_currency_only`), and empty tax columns (`voucher_line_no_tax_yet`). M2 and M3 drop those two named checks; the columns are already there (D-01). Bills are base-currency only too (`bill_base_currency_only`, `bill_allocation_base_currency_only`) until foreign amounts arrive.

## Bills (M2a slice 1)

A bill is one party ledger's reference name, compared without regard to case, and its pending amount is the signed sum of its live rows (opening rows, and rows of regular, undeleted vouchers dated on or before the date). The behaviour follows what was observed on the reference workflow:

- **Methods.** A line on a bill-wise ledger may carry rows: a new reference, an advance, an against reference (a settlement naming its bill, by name or id) or on account. A new reference or advance on a name the party already has joins that bill, also after it was settled or its invoice was deleted; the same name on another party is another bill. A line without rows, and whatever its rows leave, is on account. Only the rows' net is checked against the line: it must lie between zero and the line amount (`allocation_total` otherwise), so a row on the opposite side is a bill of its own and settling more than a bill's pending is accepted.
- **Dates and terms.** A bill's date is its voucher's date; the reference date moves neither the bill date nor the credit start. A new reference or advance takes a credit period (the party's default, or one entered: days, weeks, calendar months, or a fixed due date); a settlement copies its bill's terms when posted. Which row created a bill is derived: its first live row in storage order (opening rows, then by voucher entry time, voucher, line and row), so a back-dated settlement never takes over the bill's dates, and when an invoice is cancelled, deleted or renamed, its settlements stand on their own, dated by themselves with their copied terms.
- **Names.** A new reference without a name takes the voucher's number, or on a purchase or debit note the supplier's reference (the reference field); an optional voucher, or a purchase without a reference, must name it. The number-named rows are written just after the number is issued, the one write that follows the counter.
- **Bill-wise.** A ledger setting only (no group setting exists). New ledgers below trade receivables or payables are bill-wise by default; cash, bank and the profit and loss ledger never are, and a ledger or group holding bills does not move under the cash and bank groups. Switching it off keeps the ledger's bills pending; rows sent for it later are dropped, except that an alter keeps the rows a line already had.
- **Opening bills.** Any method, dated on or before the books beginning (default: the day before), netting towards the opening side to at most the opening balance; locked with the opening balances.
- **Warnings.** Behaviour the reference shows without a refusal is reproduced, and the answer says so in `warnings`: `bills_ignored` (rows dropped on a ledger that is not bill-wise), `bills_kept` (an alter kept a line's earlier rows), `bill_attached` (a new reference or advance joined another voucher's bill), `bill_over_settled` (a settlement took a bill past zero, with the excess), `bill_both_sides` (one line on both sides of one bill) and `bill_split` (an alter, cancel or delete left other vouchers' rows on a bill this voucher created).
- **Concurrency.** Ledgers are key-share locked in id order as before; new bills are inserted in (ledger, name) order with `ON CONFLICT DO NOTHING` and read back, so two postings creating one name for one party end with one bill (the second waits for the first), and two postings creating two names never wait on each other in a cycle; the counter comes next, then the number-named bills. A change to a ledger's bill-wise settings locks the ledger row first, so it waits for postings in flight.
- **One check per voucher.** The deferred balance check of M1 now also checks each line's bill rows. It still fires for every changed voucher, line and bill row; a transaction-local mark (`app.voucher_checked`, prefixed with the transaction id) lets it scan each voucher once, and every write to a voucher or its rows clears the mark first, so `SET CONSTRAINTS ALL IMMEDIATE` followed by another write is checked again.

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

For bills the database also refuses: a row naming a bill of another ledger or currency, a row that does not match its line's ledger and currency, rows netting beyond their line or opening balance, a row on a cash, bank or profit and loss ledger, a bill without rows, a second bill for a party differing only by case, a changed bill, a due date that does not follow the stated credit period, rows changed on a cancelled or deleted voucher, an opening row dated after the books begin or changed inside the locked period, and a bill-wise cash, bank or profit and loss ledger. The voucher-checked mark is written by the application role's own triggers: SQL that sets it on purpose skips the check, which is the same trust boundary as the company scope.

Outside what the database guards cover (the API enforces these; direct SQL can break them): which ledgers are bill-wise when a row is written (rows written while a ledger was bill-wise may stay after it is switched off), a nature change of a group whose ledgers have postings or opening balances; replacing a voucher's lines and cancelling it in one direct transaction (the lines change while it is still regular); the posting rules per voucher kind, the books-beginning date and the period lock; idempotency; and writing a revision log entry for each change.

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
| `GET ledgers`, `POST ledgers` | List; create (`name`, `secondLanguageName`, `groupId`, `opening: { amount, side, bills? }`, `billWise?`, `creditPeriod?`, `creditDaysCheck?`) |
| `GET ledgers/<id>`, `POST ledgers/<id>`, `POST ledgers/<id>/delete`, `GET ledgers/<id>/revisions` | Read; alter; delete (refused while any voucher uses it); history |
| `GET ledgers/<id>/balance?from=&to=` | Ledger balance for the period |
| `GET ledgers/<id>/bills?asOf=[&scope=pending\|all][&sort=][&direction=]` | The pending list for entry: each bill's pending at the date and its final pending over all dates, sorted by name, bill date, due date, pending or final pending |
| `GET ledgers/<id>/credit-check?date=` | `{ check, overdueBills }`: with the party's credit-days check on, how many of its debit bills are past their due date (a warning for sales entry; posting never refuses for it) |
| `GET ageing-buckets`, `POST ageing-buckets` | The company's ageing columns; replace them (`buckets: [{ fromDays, toDays }]`, contiguous from 0, only the last open-ended; editors and above) |
| `GET voucher-types`, `GET voucher-types/<id>`, `POST voucher-types/<id>`, `GET voucher-types/<id>/revisions` | List; read; rename; history |
| `GET vouchers?from=&to=[&limit=][&after=]`, `POST vouchers` | One page of undeleted vouchers in the period, by date then entry order (`limit` 1 to 500, default 100; `after` is the previous page's `next`, null on the last page); create (`idempotencyKey`, `voucherTypeId`, `date`, `narration`, `status` regular or optional, `postDated`, `lines: [{ ledgerId, side, amount }]`) |
| `GET vouchers/<id>`, `POST vouchers/<id>` | Read (also cancelled and deleted ones); alter (all required: `date`, `narration`, `status`, `postDated`, `reference`, `referenceDate`, `lines`, `revision`; null clears the narration and the reference) |
| `POST vouchers/<id>/cancel`, `POST vouchers/<id>/delete`, `GET vouchers/<id>/revisions` | Cancel; soft delete; history |
| `GET trial-balance?from=&to=` | Trial balance for the period |

Voucher bodies take `reference` and `referenceDate`, and each line may carry `bills: [{ kind, name? | billId?, creditPeriod?, amount, side? }]` (a credit period is `{ count, unit: 'day' | 'week' | 'month' }` or `{ dueDate }`). Opening bills are `{ kind, name, billDate?, creditPeriod?, amount, side? }`; sending `opening.bills` replaces the ledger's opening rows. Posting, alter and cancel answer `{ voucher, warnings }` (create also `replayed`), delete `{ deleted: true, warnings }`; every line of a voucher lists its bill rows, and ledgers list their bill-wise settings and opening bills. Bill reports are in [REPORTS.md](REPORTS.md).

Response details the screens rely on:

- **`inUse`** on every row of `GET groups`, `GET groups/<id>`, `GET ledgers` and `GET ledgers/<id>`: true when a delete would be refused for use, computed by the same SQL test the delete runs. A group is in use when it holds sub-groups or ledgers; a ledger when any voucher line names it, including lines of cancelled and deleted vouchers. Built-in rows are refused on another ground (`systemKey` is set). Create and alter answers, and revision snapshots, are the plain master without `inUse`.
- **`actorName`** on every row of the `.../revisions` routes: the display name of the user who made the change, or null once that user no longer exists (`actorId` stays). It is read inside the company transaction like the rest of the history, and no email is ever returned.
- **Errors** answer `{ "error": "<plain-language message>", "code": "<reason>" }` with the same status as before. `code` is one of `ledgerErrorCodes` in `src/lib/ledger.ts` (typed `LedgerErrorCode`, shared by client and server): `validation`, `not_found`, `stale_revision`, `retry` (deadlock or serialization failure; nothing saved), `duplicate_name`, `in_use`, `seeded_row`, `nature_fixed`, `family_rule`, `cycle`, `locked_period`, `before_books_beginning`, `unbalanced`, `posting_rule` (a voucher type's cash and bank rule), `voucher_state` (cancelled, optional or numbered status forbids the change), `idempotency_mismatch` (also on company creation), `not_set_up` (409: the company has no books settings yet; members only). A company the user cannot reach answers `not_found` exactly as a missing one does. A member of a company that is not set up yet gets 409 `not_set_up` on every route ([TENANCY.md](TENANCY.md)). Refusals outside the ledger (sign-in, origin check, rate limit, other areas) carry no `code`, as before.

## Tests

`tests/ledger-golden.integration.ts` posts a five-week trading fixture of 18 vouchers across all eight types and checks the trial balance (53,625 each side), gross profit (3,500), net loss (7,400) and balance sheet (42,250 each side) derived from the read model, a three-decimal company, and the tenancy negatives. `tests/ledger-posting.integration.ts` covers the refusals, the database-level backstops, numbering under 50 concurrent posts, the voucher lifecycle, idempotency, the revision log, master rules, the locked period and year-end carry-forward. `tests/ledger-seed.integration.ts` upgrades a database that already holds a company and checks the backfill, idempotent seeding and the boot assertion. `tests/ledger-guards.integration.ts` drives the database guards with raw SQL as `books_app` (scope tampering before commit, forged and rewound numbers, frozen lines, concurrent opposite group moves) and the behaviour-family, nature-change, alter and pagination rules through the API, including the races between ledger moves, group moves, nature changes and postings. `tests/ledger-api.integration.ts` checks `actorName`, the error codes (with statuses and messages unchanged, and none outside the ledger) and `inUse` against the delete rule. `tests/bills.integration.ts` replays the analyst's observed bill cases and scenario through the API (reuse, cancel, delete, rename and party change of settled invoices, partial, over and opposite-side rows, naming, credit periods and the credit check, bill-wise off, opening bills, ageing, the picker, wrong-company refusals), checking that bills plus on account, computed from the lines, equal each party's balance. `tests/bills-guards.integration.ts` drives the bill guards with raw SQL as `books_app`, the re-check after `SET CONSTRAINTS ALL IMMEDIATE`, and the races (one new name from two postings, bill-wise switched off during a posting, the number-named bill's deadlock), and `tests/bills-migration.integration.ts` upgrades a database an earlier release left.

## Not in M1

No report read models beyond the trial balance and ledger balance; no inventory lines, foreign-currency bills, interest on bills, credit limits, cost centres, multi-currency posting or tax computation (the columns exist and stay empty); no user-created voucher types or extra numbering series; no manual numbering or renumbering (D-04); no audited unlock of a locked period (the locked-through date is set outside the API for now); no conversion job for post-dated vouchers; no maintained period-balance table (D-04 benchmark pending). Requirement status follows D-01: none of this is described as equivalent to any other product.
