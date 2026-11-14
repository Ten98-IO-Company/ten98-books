# ten98-books

Web accounting for GCC businesses on the Ten98 stack: double-entry books, inventory, GCC VAT and e-invoicing, with a keyboard-first workflow. Pre-release: nothing here is deployed, and planned capabilities are not yet implemented.

- [Contributor rules](AGENTS.md)
- [Decisions](docs/DECISIONS.md)
- [Company model and tenancy](docs/TENANCY.md): a workspace is one company with its own team and roles
- [Keyboard commands](docs/KEYBOARD.md)
- [Ledger core](docs/LEDGER.md): data model, posting rules, numbering and the HTTP API of the double-entry books
- [Reports](docs/REPORTS.md): day book, trial balance, profit and loss, balance sheet and the drill-down to a voucher, with CSV export

`main` is production, `dev` is staging; feature branches start from `dev`.

## Run locally

Node 24 and Docker. `corepack pnpm install`, then `pnpm setup:local` (writes a private `.env`) and `docker compose up -d --build`; open http://localhost:3410, create the owner account and enter the first company's details. For development, run only the database (`docker compose up -d postgres`), then `pnpm migrate` and `pnpm dev` (same address). Checks: `pnpm test`, `pnpm test:integration` (needs the Compose database; each test file creates and drops its own database), `pnpm build`. A new company is seeded with the default chart of accounts and voucher types; `pnpm migrate` seeds companies that existed before the ledger migration.

## Keyboard

Every signed-in page answers to keyboard commands from one registry (D-05). Each user chooses a keymap, asked on first use of a company and changeable on the Account page:

- **Web-safe** (default): no function keys and no key that browsers or operating systems keep for themselves; single letters work only inside a focused menu.
- **Classic**: function keys and Alt or Ctrl chords familiar from desktop accounting software, where a browser tab can receive them.

The company home is a menu: Up and Down move the highlight, Enter opens, an item's letter opens it directly, and Escape on any company page returns to the menu with the last item highlighted again. The bar above each page lists the commands available there, and `Ctrl+/` (or `F1` in classic) lists them all. Command ids and both keymaps are in [docs/KEYBOARD.md](docs/KEYBOARD.md).

## Company model

A workspace is one company: one set of books with its own team. Owners, admins and editors post; viewers read; owners and admins manage the team and the company name. Any signed-in user can create another company and becomes its owner, and changing company (the sidebar switcher, `F3` in classic or `Alt+K` in web-safe) is changing workspace. Accounting projects inside a company come later (M2). Details in [docs/TENANCY.md](docs/TENANCY.md).

MIT licensed; see [LICENSE](LICENSE).
