# najd

Najd Electrical Supplies Co is an invented Saudi Arabian electrical trading company (SAR) with the same trading pattern as `gulfline`, and VAT switched on at 15 %. Every name is invented; any resemblance to a real business is accidental.

Files: `company.json`, `groups.json`, `ledgers.json` (two standard ledgers, cash and profit and loss, which every company already has), `vouchers.json` (entry order; `expectedNumber` is the number the voucher holds in the system the figures were read from), `items.json` (units, locations, stock groups and items with opening stock per location) and `expected.json` (figures with the report and period of each block, read from an independent accounting system loaded with this dataset; ten98-books did not produce them).

Conventions and caveats:

- Amounts have two decimals.
- Vouchers with no accounting effect (orders, delivery and receipt notes, stock journals) carry `lines: []` and `extras.noAccountingEffect`. Cancelled vouchers carry `lines: []` too, because no entries were recorded for them. Inventory vouchers carry their item detail in `inventory`. Invoices carry their complete double-entry lines (party, tax, sales or purchase ledger) as well as `inventory`.
- Opening stock (369,440.00) is not a ledger balance: ledger openings alone leave a difference of that amount against capital; the stock value comes from the item openings in `items.json`.
- 30 vouchers are dated 2027-01-01 to 2027-02-28, after `expected.json`'s period (the financial year 2026); they are in `vouchers.json` and are compared only for the stated period.
- Profit and balance sheet figures in `expected.json` include opening and closing stock; the `...ExcludingStock` figures come from the sales, purchase and expense ledgers only.
- `expectedNumber` is the number the voucher holds in the system the figures were read from (`numbersVerified` is true): numbering is per voucher type in entry order and restarts at 1 on 1 January 2027, so the 2027 vouchers expect numbers that restart. Optional vouchers take no number.
- Bill references (`extras.bills`) are `new`, `against` and `advance` allocations; `creditDays` is the due-date rule applied.
- VAT: the ledgers Output VAT 15% and Input VAT 15% have duty type VAT. `expected.json` `vat` holds the VAT return figures read from the other system; its 25 purchase vouchers could not be classified there (tax amount modified), so no inward-supplies figure exists.
