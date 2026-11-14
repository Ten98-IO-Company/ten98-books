# harbourview

Harbourview Consulting FZ-LLC is an invented UAE consulting company (AED) that exercises bill-wise balances, cost categories and centres, a second and third currency, bank dates and post-dated receipts. 195 vouchers dated 2026-01-02 to 2026-12-31 in a fresh books year; no stock. Every name is invented; any resemblance to a real business is accidental.

Files: `company.json`, `groups.json` (empty), `ledgers.json`, `costCategories.json`, `costCentres.json`, `currencies.json`, `vouchers.json`, `expected.json` and `checkpoints.json` (scenario figures at 2026-02-28 and 2026-03-31 for pending bills and cost centres; not part of format v1, kept as it is).

Conventions (everything below sits under `extras`; the seeder reads the bill keys and the cost centre keys, as `demo/README.md` describes, and keeps the rest untouched):

- Ledgers: `billWise`, `creditDays`, `costCentres` (true where the ledger takes centres) and `opening.bills` (`kind` new, `name`, `billDate`, `creditDays`, `amount`, `side`); `taxType` and `taxRate` on the two tax ledgers, which are ordinary duty ledgers at 5 %. Debtor A opens with 5,000.00, of which 4,500.00 is two named bills and 500.00 has none.
- Voucher lines: `bills` (`kind` new, against, advance or on_account; `name`, `creditDays`, `amount`), `costCentres` (`centre`, `amount`; the category comes from the centre and each category's amounts add up to the line), `currency`, `currencyAmount` and `rate` on foreign lines (the line `amount` is the base-currency amount; bill amounts on such a line are in the foreign currency) and `bank` (`instrumentType`, `instrumentNumber`, `instrumentDate` and, on 102 lines, `bankDate`, the day the bank cleared it).
- 28 lines are in USD or EUR at the standard rate in force on the voucher date (`currencies.json`). A receipt or payment that settles a foreign bill at another rate carries an explicit line on `forex-gain-loss` for the difference.
- Sales, purchases and credit and debit notes are entered without stock: the party line first, then revenue or cost lines with centres, then 5 % tax. Purchases carry the supplier's invoice number in `extras.reference`.
- Types present: sales, purchase, receipt, payment, contra, journal, credit_note, debit_note, memorandum and reversing_journal; 3 optional vouchers, 4 cancelled ones (no lines, `extras.noAccountingEffect`) and 2 post-dated receipts. The first weeks follow a bill scenario: bills S-1 and S-2, C-77, advance ADV-B, an on-account receipt, a credit note, and a cancelled receipt and sale.
- `expectedNumber` is the number each voucher holds in the system the figures were read from (`numbersVerified` is true); optional vouchers take no number.
- `expected.json` was read from an independent system loaded with this dataset: trial balance, profit, balance sheet, pending bills at year end, cost centre totals and exchange differences. The trial balance totals include a separate debit row for unrealised exchange differences on open foreign bills (378.75 at year end); it is not a ledger, and ten98-books posts the base-currency amounts only. Foreign bills in the pending-bills figures are shown restated at the standard rate in force at the report date.

Not covered, on purpose: interest calculation, budgets, projects as a separate concept, ageing buckets, bank reconciliation beyond the bank dates, and adjustment vouchers for unrealised gains.

`journal-002` is an optional journal that credits a bank ledger. The system the figures come from saves it, and ten98-books now posts it too (a journal accepts cash and bank ledgers).
