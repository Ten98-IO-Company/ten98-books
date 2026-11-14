# Company model and tenancy

How companies, teams and roles map onto the Ten98 workspace mechanism, and how company data is kept apart. The contract is [D-03 as amended on 2026-11-14](DECISIONS.md#d-03-tenancy-workspace--company-books-project--accounting-project); this page describes what is built.

## A workspace is one company

- A company is a workspace from `@ten98/runtime`'s team mechanism (`createWorkspaceTeam` over the shared `workspace`, `membership` and `workspace_invitation` tables). Its id is the workspace id, its name is the workspace name, and its team is the workspace's members.
- The books settings (base currency and its minor units, financial-year start, books beginning, time zone, locked-through date) are the `company` row whose `company_id` is the workspace id. Every accounting table carries that `company_id` through composite foreign keys.
- A workspace without a `company` row is a company that is **not set up yet**. First-user setup creates one; its owner is led straight to the company settings form, and its books exist only once that form is saved.
- A person with several companies is a member of several workspaces. Changing company is changing workspace: the company switcher in the sidebar, or the "Change company" command (`F3` in the classic keymap, `Alt+K` in web-safe).
- Accounting projects (a job, site or engagement inside one company) are a later milestone (M2, with cost centres). The `project` table is dormant until then: it holds no rows, the application role has no privileges on it, and accounting projects will add a `company_id` with composite keys and forced row-level security to it like every other accounting table.

## Roles

| Role | Books | Team and company |
|---|---|---|
| Owner | read and write | everything below, plus owners, administrators, ownership transfer and the two-factor rule |
| Admin | read and write | invite and remove editors and viewers, rename the company, set up a company that is not set up yet |
| Editor | read and write | none |
| Viewer | read | none |

A company comes into being in exactly two ways: first-user setup (which creates the installation's first company, not set up yet) and "Create company" (`POST /api/companies`, with the full books settings). Any signed-in user may create a company and becomes its owner; the installation has no further restriction. There is no route that makes a bare workspace: `POST /api/workspaces` is not in the route table and answers 404. Creating a company makes the workspace, the owner membership, the books settings and the seeded chart of accounts (D-10) in one transaction, so a failure leaves nothing behind. The create form sends an idempotency key, one per visit to the form, and ignores a second submit while the first is out: the same key and body from the same user return the first company (200, `replayed: true`), the same key with a different body is refused (409 `idempotency_mismatch`), and a concurrent duplicate waits for the first request and then gets its company. Keys are kept in `company_creation` (the user id, the key, a hash of the request body and the company id; no company data, so it stays outside row-level security). Rows are not expired: they are removed only when their user or company is deleted. That is acceptable because a row is small, holds nothing a member could not already see, and keeping it means a retry is answered the same way however late it comes. Renaming the company is the workspace rename (owners and admins). An invitation is to one company and leads into it.

## API

| Route | Who | What |
|---|---|---|
| `GET /api/companies` | signed in | Every company the user belongs to: `{ id, name, role, twoFactorLocked, company }`, where `company` holds the books settings, or null while the company is not set up (and for a company whose two-factor rule the user does not meet yet). |
| `POST /api/companies` | signed in | Creates a company; the caller becomes its owner. Optional `idempotencyKey` (8 to 100 of `A-Z a-z 0-9 _ . : -`). 201 with `{ company, replayed: false }`, 200 with `replayed: true` for a repeat, 409 `idempotency_mismatch`. |
| `GET /api/companies/<id>` | member | The company's settings. 409 with code `not_set_up` before setup. |
| `POST /api/companies/<id>/setup` | owner, admin | Saves the books settings of a company that is not set up yet and names it; 409 `already_set_up` afterwards. |
| `POST /api/workspaces/<id>/rename` | owner, admin | Renames the company. |
| `/api/workspaces/<id>/team`, `/invitations`, `/members/...` | owner, admin | The company's team (shared team controller). |
| `/api/companies/<id>/...` | member | Masters, vouchers and reports ([LEDGER.md](LEDGER.md), [REPORTS.md](REPORTS.md)). |

A user who is not a member of the company gets the same 404 "not found" as for a company that does not exist, on every route. A member of a company that is not set up yet gets 409 with code `not_set_up` on every company and books route (settings, masters, vouchers, reports and exports) that the member's role may use: reads for every member, writes for owners, admins and editors. The role is checked first, so a viewer's write gets the same 404 "not found" as on a set-up company. The ledger and reports answer it from the one place they load the company (`ledgerContext`); the code is in `ledgerErrorCodes` (`src/lib/ledger.ts`).

## Isolation

- `withCompany(userId, companyId, mode, run)` in `src/server/tenancy.ts` is the one way into a company's data: it share-locks the caller's membership row of that workspace (so a demotion or removal waits for an in-flight write and takes effect for the next one), refuses a non-member or a viewer's write with "not found", and runs `run` in one transaction whose `app.company_ids` lists that company only. `withCompanies` does the same for reads across the user's own companies (the company list, and later consolidated reports).
- Every accounting table forces row-level security with the one company policy on `app.company_ids`; the application role (`books_app`) owns nothing and cannot bypass it, and the boot assertion refuses to start otherwise. SQL as `books_app` without a company context sees and changes nothing.
- The boot assertion checks the role's attributes, that it owns no table, and row-level security on the accounting tables; it does not check grants. The application role's privileges on non-accounting tables (no access to `project`, read and insert only on `company_creation`) are covered by `tests/company-model-migration.integration.ts`.
- The two-factor rule is checked per company before every company and team route.

## Migration 0005

`migrations/0005_company_is_workspace.sql` converted databases from the earlier model, where a company was a project of a workspace. In each workspace the first company (one with books before one without, then the oldest) kept the workspace: its books took the workspace id and the workspace took the company's name. Every further company became a workspace of its own (its old id became the workspace id) with the same members, roles and two-factor rule, and its books moved intact: vouchers and their numbers and gaps, counters, the revision log and idempotency keys. A workspace without a company stayed as it was (not set up yet), and pending invitations stayed with the workspace they were sent for. The old project rows, which all stood for companies, were removed, and the migration revoked the application role's privileges on the `project` table. `tests/company-model-migration.integration.ts` prepares a database with the earlier migrations, fills it with each of these cases and checks the result; every other integration test applies all migrations to an empty database.

What the split means for an installation that had several companies in one workspace:

- Each split-off company has its own copy of the members and roles. From now on they change separately: removing someone from one company, or changing their role there, no longer affects the others; remove or change them in each company.
- A pending invitation to the old workspace admits the invitee to the company that kept the workspace only. Invite them to each other company separately.
- Each company has its own two-factor rule, copied from the old workspace, and its own name; renaming one renames only that company.
