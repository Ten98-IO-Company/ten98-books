# ten98-books contributor rules

ten98-books is a web, multi-tenant accounting application for GCC businesses: double-entry books, inventory, GCC VAT and e-invoicing, with a keyboard-first workflow for accountants who come from desktop accounting software. It is built on the Ten98 code system and design system.

Read, in this order, before editing: this file, [docs/DECISIONS.md](docs/DECISIONS.md), the requirement rows and flow notes named in your brief, then the installed `node_modules/@ten98/runtime/README.md` and `architecture.json`.

## Clean room (D-06, no exceptions)

Reimplement behaviour in your own words and code. Never add third-party product code, help text, screenshots, icons, sample data or product names to source, UI copy, tests or docs. Reference notes are kept outside this repository; the coordinator's brief gives you the rows you need. Rows marked `(unverified)` or `doc-derived` are hypotheses: implement only what the brief or a coordinator decision supports, and report the gap.

## Stack and reuse

The stack is the Discover profile (D-02); versions come from the code-system architecture declaration, never from memory. Import shared mechanisms from `@ten98/runtime` and presentation from `@ten98/ui`; do not create app-local copies. A reusable piece that is missing goes to its canonical package first: report it to the coordinator instead of building it here. Workers do not add, remove or upgrade dependencies.

## Branches

`main` is production and the default branch. `dev` is staging. Both always exist. Feature branches are cut from `dev`, named `feat/<area>`, and merge into `dev`; `dev` is promoted to `main` only by the coordinator with owner approval. Workers never commit to `main` or `dev`, and never push, deploy or publish unless their brief quotes the owner's authorization for it.

## Sessions

The main session coordinates (D-08): it decides, owns shared contracts and merges. A worker session owns one feature set on one branch with a file allowlist and acceptance cases from its brief. Stop and report to the coordinator on: a file outside the allowlist, a failing baseline, a security or tenancy boundary that needs a new decision, a migration number or shared-contract conflict, or two failed repair attempts. Finish with at most ten bullets: changes, paths, commands run with actual results, skipped checks, remaining gaps.

A worker decides anything inside its brief that is reversible within a day. Everything else goes to the coordinator, who records it in docs/DECISIONS.md with evidence. Irreversible or outward actions belong to the owner.

## Documentation

One canonical document per topic, linked from [docs/ROADMAP.md](docs/ROADMAP.md). A change to behaviour, setup, configuration, an HTTP route or a keyboard command updates its document in the same branch; a reviewer treats a stale document as a defect. Documents state what was verified and what was not, and never describe unfinished behaviour as working. The coordinator updates the roadmap's status table with each merge into `dev`. Progress diaries, plans that were superseded and review transcripts stay out of the repository.

## Engineering

- Ponytail: smallest complete change, reuse first, no speculative abstraction; non-trivial logic leaves a meaningful test that fails without it.
- Checked TypeScript only; no `@ts-nocheck`, no weakened strict options.
- Money is `BIGINT` minor units and `bigint` in code, a string on the wire; quantities and rates are `NUMERIC`/strings. Never a float (D-04, D-07).
- Every server entry point, export and job authorizes the company and runs accounting queries through `withCompany` (D-03). Each handler module has a wrong-company negative test.
- Migrations are immutable numbered SQL files; the coordinator assigns numbers.
- Posting rules live in the server ledger module only; screens never compute balances.
- A requirement is `done` only when observed, fixtured and tested (D-01); never describe unfinished behaviour as equivalent.
