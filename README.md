# ten98-books

Web accounting for GCC businesses on the Ten98 stack: double-entry books, inventory, GCC VAT and e-invoicing, with a keyboard-first workflow. Pre-release: nothing here is deployed, and planned capabilities are not yet implemented.

- [Contributor rules](AGENTS.md)
- [Decisions](docs/DECISIONS.md)

`main` is production, `dev` is staging; feature branches start from `dev`.

## Run locally

Node 24 and Docker. `corepack pnpm install`, then `pnpm setup:local` (writes a private `.env`) and `docker compose up -d --build`; open http://localhost:3410 and create the owner account. For development, run only the database (`docker compose up -d postgres`), then `pnpm migrate` and `pnpm dev` (same address). Checks: `pnpm test`, `pnpm test:integration` (needs the Compose database), `pnpm build`.

MIT licensed; see [LICENSE](LICENSE).
