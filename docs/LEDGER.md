# Ledger core (M1)

The double-entry books of one company: account groups, ledgers, voucher types, vouchers and a revision log, with the posting rules on the server and a minimal read model (trial balance, ledger balance) for verification. There are no screens yet. The contract is [D-03, D-04, D-07, D-09 and D-10](DECISIONS.md); this page describes what is built.

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

Behaviour hangs on `system_key`, never on names. Built-in rows can be renamed and given a second-language name, cannot be deleted (API check and a database trigger) and keep their nature when moved. A ledger is a cash or bank ledger when its group is, or sits below, `cash_in_hand`, `bank_accounts` or `bank_overdraft`.

Seeding is not written to the revision log: built-in rows are identified by their `system_key`.

## Posting rules

All in `src/server/ledger/`; screens never compute balances. Each request is one short `withCompany` transaction: viewers read, owners, admins and editors write, and a company the user cannot reach answers "not found".

- A voucher has at least two lines, every amount is more than zero and within range, and debits equal credits.
- Every ledger belongs to the company (a ledger of another company is "not found").
- The date is on or after the books-beginning date and after the company's locked-through date. A voucher already dated on or before the lock cannot be altered, cancelled or deleted, and opening balances cannot change while the lock reaches the books-beginning date (D-09).
- Contra: every line is a cash or bank ledger. Payment: at least one credit to a cash or bank ledger, and no debit to one. Receipt: at least one debit to a cash or bank ledger, and no credit to one. Journal: no cash or bank ledger at all; money movements go through the three types above, which is the behaviour accountants expect from desktop software. Sales, purchase, credit note and debit note accept any ledgers in M1.
- The database repeats the integrity rules: a deferred constraint trigger checks at commit that every touched voucher has at least two lines, equal debits and credits, and a number exactly when it is not optional; amounts are checked positive; a number never changes once issued; a deleted voucher never changes; a cancelled voucher stays cancelled; a numbered voucher never becomes optional.
- Every create, alter, cancel and delete of a group, ledger, voucher type or voucher writes `revision_log` in the same transaction. Snapshots are the API's own objects with amounts as exact minor-unit strings. A cascaded nature change of sub-groups is recorded on the primary group's entry.
- Alter and delete take the `revision` the client last read and refuse a stale one ("changed by someone else").

## Numbering

Numbers come from the `voucher_counter` row of the company, voucher type and series, taken last in the posting transaction in one statement that issues and stores the number. Concurrent postings of one series wait on that row only; a rolled-back posting returns its number, so issued numbers have no gaps except those left on purpose.

- Each voucher type counts separately from 1, in entry order, whatever the dates.
- A deleted voucher keeps its row and number, so its number is a permanent gap; nothing is renumbered.
- An altered voucher keeps its number, also when its date moves.
- A voucher entered on an earlier date takes the next free number.
- A cancelled voucher keeps its number and row (and its lines, for the record) and has no accounting effect.
- An optional voucher takes no number and has no effect until it is altered to regular, when it takes the next number.
- A post-dated voucher is numbered like any other and counts from its own date.

Voucher creation requires an `idempotencyKey`, unique per company: the same key with the same body returns the first result (`replayed: true`, status 200); the same key with a different body is refused (409). A transaction-scoped advisory lock on the key makes a concurrent retry wait for the first attempt.

## Read model

`trialBalance(context, from, to)` returns one typed row per ledger (opening, period debits and credits, closing, each as non-negative debit and credit amounts), totals, and the opening-balance difference, which is shown rather than blocking while a company is being set up (D-10). `ledgerBalance(context, ledgerId, from, to)` returns that ledger's row. Only regular, undeleted vouchers count. Report queries run with a 30-second statement timeout.

Opening balances are computed at report time (D-04): a balance-sheet ledger opens with its opening balance plus everything before the period; an income or expense ledger opens with what was posted earlier in the same financial year only, and what it gathered in earlier years is carried into the profit and loss ledger. Gross profit, net profit and the balance sheet are derived from the rows (nature, primary group and gross-profit flag); the golden fixture test shows how.

## HTTP API

All routes are under `/api/companies/<company id>`; state changes are POST, so the central origin check in `src/server/api.ts` covers them. Amounts are decimal strings.

| Method and path | Does |
|---|---|
| `GET groups`, `POST groups` | List; create (`name`, `secondLanguageName`, `parentId`, or `nature` and `grossProfit` for a primary group) |
| `GET groups/<id>`, `POST groups/<id>`, `POST groups/<id>/delete`, `GET groups/<id>/revisions` | Read; alter (with `revision`); delete (with `revision`); history |
| `GET ledgers`, `POST ledgers` | List; create (`name`, `secondLanguageName`, `groupId`, `opening: { amount, side }`) |
| `GET ledgers/<id>`, `POST ledgers/<id>`, `POST ledgers/<id>/delete`, `GET ledgers/<id>/revisions` | Read; alter; delete (refused while any voucher uses it); history |
| `GET ledgers/<id>/balance?from=&to=` | Ledger balance for the period |
| `GET voucher-types`, `GET voucher-types/<id>`, `POST voucher-types/<id>`, `GET voucher-types/<id>/revisions` | List; read; rename; history |
| `GET vouchers?from=&to=`, `POST vouchers` | Undeleted vouchers in the period; create (`idempotencyKey`, `voucherTypeId`, `date`, `narration`, `status` regular or optional, `postDated`, `lines: [{ ledgerId, side, amount }]`) |
| `GET vouchers/<id>`, `POST vouchers/<id>` | Read (also cancelled and deleted ones); alter (`date`, `narration`, `status`, `postDated`, `lines`, `revision`) |
| `POST vouchers/<id>/cancel`, `POST vouchers/<id>/delete`, `GET vouchers/<id>/revisions` | Cancel; soft delete; history |
| `GET trial-balance?from=&to=` | Trial balance for the period |

## Tests

`tests/ledger-golden.integration.ts` posts a five-week trading fixture of 18 vouchers across all eight types and checks the trial balance (53,625 each side), gross profit (3,500), net loss (7,400) and balance sheet (42,250 each side) derived from the read model, a three-decimal company, and the tenancy negatives. `tests/ledger-posting.integration.ts` covers the refusals, the database-level backstops, numbering under 20 concurrent posts, the voucher lifecycle, idempotency, the revision log, master rules, the locked period and year-end carry-forward. `tests/ledger-seed.integration.ts` upgrades a database that already holds a company and checks the backfill, idempotent seeding and the boot assertion.

## Not in M1

No screens, day book or report layouts; no inventory lines, bill-wise allocations, cost centres, multi-currency posting or tax computation (the columns exist and stay empty); no user-created voucher types or extra numbering series; no manual numbering or renumbering (D-04); no audited unlock of a locked period (the locked-through date is set outside the API for now); no conversion job for post-dated vouchers; no maintained period-balance table (D-04 benchmark pending). Requirement status follows D-01: none of this is described as equivalent to any other product.
