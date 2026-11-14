# Demo data

Invented companies for demonstration and for checking ten98-books against another accounting system line by line. Every name, amount and date here is made up; none of it describes a real business, and it is for demonstration and parity checking only.

Two commands read this folder (run from the repository root, against the database in `.env`, after the user has been created in the app):

```bash
pnpm seed:demo -- --owner <email> [--company <slug> | --all] --yes
pnpm demo:compare -- --owner <email> [--company <slug> | --all]
```

Without `--company` or `--all`, every folder is used. `seed:demo` refuses to run without `--yes`, never runs at startup or in a migration, and prints no secrets.

## What the seeder does

For the named user, per company folder:

1. Creates the company through the application's own company-creation function (the user becomes its owner) with `company.json`'s settings.
2. Creates the groups of `groups.json` and the ledgers of `ledgers.json`, with opening balances, through the ledger module.
3. Posts `vouchers.json` in file order through the ledger module, so posting rules, numbering and the revision log apply. A voucher marked `cancelled` is posted and then cancelled; `optional` stays optional and takes no number.

What it cannot post is skipped and counted, never dropped silently. The summary lists: vouchers of a type ten98-books does not have (`not yet supported: 3 sales order, 4 stock journal, ...`); vouchers of a supported type that have no lines (cancelled ones, or ones marked `extras.noAccountingEffect`: a voucher needs two lines here, so they cannot be represented yet); vouchers the ledger's own posting rules refuse (for example a journal on a bank ledger), with the ledger's reason, because that is a difference from the dataset; and `items.json` (stock is not modelled), with the opening stock value. Any other refusal stops the seed.

Voucher numbers: `expectedNumber` is compared for every posted voucher; the summary says how many matched and lists each that differs, naming the earlier vouchers of the same type that hold a number in the dataset but none here (skipped, refused or optional ones), which usually accounts for the whole difference. Numbers are never forced.

It is idempotent and resumable. A company is recognised, not guessed: it is one of the user's companies named exactly as `company.json` names it, **and** its books carry this dataset's voucher-key namespace (every voucher is posted with the idempotency key `demo:<slug>:<voucher key>`), or it is a company this seeder created that has no vouchers yet and nothing the dataset does not define. A same-named company holding anything else is somebody's own books and is never written to (the command stops and says so). Seeding considers only companies the user owns: belonging to somebody else's copy (as viewer, editor or admin) neither blocks nor redirects it, so such a user gets a copy of their own and the other company is never written to. Two seeds at once for one user and dataset are serialised by an advisory lock, so only one creates the company. Groups and ledgers are matched by name, vouchers by key, so a second run reports "already present" and changes nothing; a run that stopped at an error resumes where it left off. Changing a voucher after it was seeded is refused (the key was used for a different voucher); seed into another user, or remove the company, instead.

It stops at the first error and names the file and key (`demo/<slug>/vouchers.json: voucher "payment-02": ...`). It applies only what ten98-books models and lists, in a summary, every feature, further file, `extras` field and `inventory` line it skipped. Voucher numbers ten98-books assigns are compared with `expectedNumber` when the file gives one; differences are reported, never forced.

## What the comparison does

Reads the seeded company through the report modules and compares it with `expected.json`, exactly in minor units: voucher counts (total and by type), trial balance totals and each listed ledger's closing balance and side, gross and net profit, and the balance sheet total (against both sides of the balance sheet). The output is a table of expected, actual and difference per line. Counts are for the types ten98-books has: vouchers of other types and vouchers without lines are taken out of the expected counts and named. Stock is not modelled, so opening stock is not a ledger balance: ledger openings alone leave a difference of exactly its value (computed from `items.json`, quantity times rate per item and location), and the comparison checks that the opening-balance difference the trial balance reports equals it. When `expected.json` gives figures excluding stock (`grossProfitExcludingStock`, `netProfitExcludingStock`) those are compared and the stock-inclusive ones are listed as needing inventory; a balance sheet with `closingStockInAssets` is listed the same way. Blocks such as `stockSummary`, `receivables`, `payables` and `vat` are listed with their reason. Vouchers dated after the period are seeded but not compared.

Every ledger of the company is accounted for: one that `expected.json` leaves out is a difference when its closing balance is not zero, a ledger it names that the company lacks is a difference, and unlisted ledgers that close at zero are named under "Not yet comparable" with the reason. Blocks that ten98-books cannot compute yet are listed there too and never count as differences. The first line says which company was read (a user who owns a copy and belongs to another is compared against their own). The exit code is 1 when any comparable line differs.

## Format v1

One folder per company, named by its slug. Amounts are plain decimal strings with a dot and no grouping, sign or exponent (`"1250.50"`), with at most as many decimal places as the company's `minorUnits`. Dates are `YYYY-MM-DD`. Keys are lowercase slugs (`a-z`, `0-9`, `-`, `_`), unique inside their file. Files that are not listed below, and the `extras` and `inventory` content, are accepted and kept untouched: they describe features ten98-books does not model yet. Known files are strict: an unknown key is an error that names the file and key, as is a key repeated inside one object (JSON readers would silently keep the last). A file may be at most 32 MB. The format is checked by `src/server/demo/dataset.ts`; `pnpm test` validates every folder here.

### `company.json`

```json
{ "slug": "starter-trading", "name": "Starter Trading", "secondLanguageName": "optional", "country": "AE", "baseCurrency": "AED", "minorUnits": 2,
  "financialYearStart": { "month": 1, "day": 1 }, "booksBeginning": "2026-01-01", "timeZone": "Asia/Dubai", "features": ["accounting"] }
```

`slug` equals the folder name. `baseCurrency` must be one ten98-books supports and `minorUnits` that currency's (2 or 3); `timeZone` is a named zone. `features` lists the areas the dataset uses; ten98-books models `accounting` only and lists any other as skipped. `extras` is allowed.

### `groups.json` (optional)

`[ { "key", "name", "under", "nature"? } ]` for groups beyond the seeded chart. `under` is another group's key in this file (any order, no cycles) or the `system_key` of a seeded group: `branches`, `capital`, `current_assets`, `current_liabilities`, `direct_expenses`, `direct_income`, `fixed_assets`, `indirect_expenses`, `indirect_income`, `investments`, `loans`, `deferred_expenses`, `purchases`, `sales`, `suspense`, `reserves`, `bank_accounts`, `cash_in_hand`, `deposits_paid`, `advances_given`, `inventory`, `receivables`, `duties_taxes`, `provisions`, `payables`, `bank_overdraft`, `secured_loans`, `unsecured_loans`. A sub-group takes its parent's nature.

### `ledgers.json`

`[ { "key", "name", "secondLanguageName"?, "group", "standard"?, "opening"?: { "amount", "side": "Dr" | "Cr" }, "extras"? } ]`. `group` is a group key of this file or a seeded `system_key`, and is required unless the ledger is standard. `standard` (`"cash"` or `"profit_and_loss"`, each at most once) names a ledger every company already has: it is not created again, keeps its seeded name and place, and takes the opening balance if it has none. A `group` that is not the ledger's actual group is an error (the profit and loss ledger has none), and a `name` that differs from the seeded one is listed in the seed report, because the other system will carry the dataset's name.

### `vouchers.json`

An array in entry order: `{ "key", "type", "date", "status": "regular" | "cancelled" | "optional", "postDated", "narration"?, "lines": [ { "ledger", "side", "amount", "extras"? } ], "inventory"?, "extras"?, "expectedNumber"? }`. `type` is a slug. The eight voucher types ten98-books has are `contra`, `payment`, `receipt`, `journal`, `sales`, `purchase`, `credit_note` and `debit_note`; any other type (`sales_order`, `stock_journal`, `memorandum`, ...) is valid and is skipped and counted when seeding. `lines` may be empty only when the voucher is `cancelled` or carries `extras.noAccountingEffect: true`, and a marked voucher carries no lines. Every `ledger` is a ledger key of `ledgers.json`; a date is on or after `booksBeginning`; every regular voucher balances; line amounts are more than zero. The ledger's posting rules still apply when seeding (for example a payment must credit a cash or bank ledger).

### `expected.json`

```json
{ "period": { "from": "2026-01-01", "to": "2026-02-03" }, "voucherCount": 18, "vouchersByType": { "payment": 5 },
  "trialBalance": { "totalDebit": "53625.00", "totalCredit": "53625.00", "ledgers": { "cash": { "closing": "9600.00", "side": "Dr" } } },
  "profitAndLoss": { "grossProfit": "3500.00", "netProfit": "-7400.00" }, "balanceSheet": { "total": "42250.00" } }
```

Only `period` is required. `vouchersByType` may name any type the dataset's vouchers use. `profitAndLoss` may add `grossProfitExcludingStock` and `netProfitExcludingStock`, and `balanceSheet` `closingStockInAssets`. Keys named `source`, `report`, `note` and `voucherCountNote` only describe where a figure came from and are not listed. Conventions the comparison uses: `voucherCount` and `vouchersByType` count every undeleted voucher dated in the period, whatever its status; the trial balance is for the period, with closing balances (a zero closing matches either side); profit is positive and a loss negative, over the period (one financial year at most); the balance sheet is as at `period.to`. Ledger keys refer to `ledgers.json`. Further blocks (for example `cashFlow`) are kept and listed as not yet comparable.

### `items.json` (optional)

`{ units: [{ key, name }], locations: [{ key, name }], stockGroups: [{ key, name }], items: [{ key, name, group?, unit?, opening?: [{ location, quantity, rate }] }] }`, other fields kept. Only its shape and references are checked: an item's `group` is a stock group key, its `unit` a unit key or name, an opening's `location` a location key, rates fit the currency's decimals, and every `inventory` line of a voucher names an item and a location that exist. Stock is not modelled yet, so the file is listed as not yet supported.

### Further files

Any other `*.json` (`items.json`, `costCentres.json`, `employees.json`, ...) is read as JSON, kept untouched and listed as skipped. A `README.md` per company is welcome: say what the company is for and where its expected figures come from.

## Adding a company

1. Make `demo/<slug>/` with `company.json`, `ledgers.json`, `vouchers.json` and `expected.json` (and `groups.json` if needed). Invent every name; use no names, text or data from any other product.
2. Run `pnpm test`: the dataset test validates every folder and names the file and key of any problem.
3. Seed it into a development database with `seed:demo` and run `demo:compare`; investigate each difference before changing `expected.json` (the figures are the reference, not whatever ten98-books computes).

## Companies

| Folder | What it is |
|---|---|
| `gulfline/` | An invented UAE electrical trading company (AED): 319 vouchers across 15 voucher types (orders, delivery and receipt notes, stock journals, cancelled and optional entries, 30 vouchers after the compared period), three stock locations with opening stock, bill-wise parties. Figures read from an independent system. |
| `najd/` | The same pattern as `gulfline` as an invented Saudi company (SAR) with VAT at 15 %, and a VAT return block in `expected.json`. |
| `starter-trading/` | A small trading company's first five weeks: 18 vouchers across the eight voucher types, opening balances and tax ledgers. Authored from the ledger's golden test fixture, so ten98-books' own tests assert its figures; `expected.json` is for the reference system to confirm. |
