# Starter Trading

A small trading company's first five weeks (2026-01-01 to 2026-02-03): twelve ledgers beyond the standard two, opening balances of 12,000.00 a side, and 18 vouchers across all eight voucher types (payments, receipts, contras, journals, sales, purchases, a credit note and a debit note, with tax ledgers). All names are invented.

It carries the same ledgers, openings, dates and amounts as the golden fixture in `tests/helpers/golden.ts`, which ten98-books' own tests assert. `expected.json` is filled from the figures those tests assert: trial balance 53,625.00 a side, gross profit 3,500.00, net loss 7,400.00, balance sheet 42,250.00, and each ledger's closing balance. The dataset was loaded into the reference system, and on 2026-11-14 its figures and every voucher number were confirmed (`numbersVerified` is true in `expected.json`).
