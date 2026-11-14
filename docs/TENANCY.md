# Company model and tenancy

How companies, teams and roles map onto the Ten98 workspace mechanism, and how company data is kept apart. The contract is [D-03 as amended on 2026-11-14](DECISIONS.md#d-03-tenancy-workspace--company-books-project--accounting-project); this page describes what is built.

## A workspace is one company

- A company is a workspace from `@ten98/runtime`'s team mechanism (`createWorkspaceTeam` over the shared `workspace`, `membership` and `workspace_invitation` tables). Its id is the workspace id, its name is the workspace name, and its team is the workspace's members.
- The books settings (base currency and its minor units, financial-year start, books beginning, time zone, locked-through date) are the `company` row whose `company_id` is the workspace id. Every accounting table carries that `company_id` through composite foreign keys.
- A workspace without a `company` row is a company that is **not set up yet**. First-user setup creates one; its owner is led straight to the company settings form, and its books exist only once that form is saved.
- A person with several companies is a member of several workspaces. Changing company is changing workspace: the company switcher in the sidebar, or the "Change company" command (`F3` in the classic keymap, `Alt+K` in web-safe).
- Accounting projects (a job, site or engagement inside one company) are a later milestone (M2, with cost centres). The `project` table is kept for them; nothing lists or creates projects yet.

## Roles

| Role | Books | Team and company |
|---|---|---|
| Owner | read and write | everything below, plus owners, administrators, ownership transfer and the two-factor rule |
| Admin | read and write | invite and remove editors and viewers, rename the company, set up a company that is not set up yet |
| Editor | read and write | none |
| Viewer | read | none |

Any signed-in user may create a company and becomes its owner, as any signed-in user may create a workspace; the installation has no further restriction on either. Creating a company makes the workspace, the owner membership, the books settings and the seeded chart of accounts (D-10) in one transaction, so a failure leaves nothing behind. Renaming the company is the workspace rename (owners and admins). An invitation is to one company and leads into it.

## API

| Route | Who | What |
|---|---|---|
| `GET /api/companies` | signed in | Every company the user belongs to: `{ id, name, role, twoFactorLocked, company }`, where `company` holds the books settings, or null while the company is not set up (and for a company whose two-factor rule the user does not meet yet). |
| `POST /api/companies` | signed in | Creates a company; the caller becomes its owner. 201 with the company. |
| `GET /api/companies/<id>` | member | The company's settings. 409 with code `not_set_up` before setup. |
| `POST /api/companies/<id>/setup` | owner, admin | Saves the books settings of a company that is not set up yet and names it; 409 `already_set_up` afterwards. |
| `POST /api/workspaces/<id>/rename` | owner, admin | Renames the company. |
| `/api/workspaces/<id>/team`, `/invitations`, `/members/...` | owner, admin | The company's team (shared team controller). |
| `/api/companies/<id>/...` | member | Masters, vouchers and reports ([LEDGER.md](LEDGER.md), [REPORTS.md](REPORTS.md)). |

A user who is not a member of the company gets the same 404 "not found" as for a company that does not exist, on every route.

## Isolation

- `withCompany(userId, companyId, mode, run)` in `src/server/tenancy.ts` is the one way into a company's data: it share-locks the caller's membership row of that workspace (so a demotion or removal waits for an in-flight write and takes effect for the next one), refuses a non-member or a viewer's write with "not found", and runs `run` in one transaction whose `app.company_ids` lists that company only. `withCompanies` does the same for reads across the user's own companies (the company list, and later consolidated reports).
- Every accounting table forces row-level security with the one company policy on `app.company_ids`; the application role (`books_app`) owns nothing and cannot bypass it, and the boot assertion refuses to start otherwise. SQL as `books_app` without a company context sees and changes nothing.
- The two-factor rule is checked per company before every company and team route.

## Migration 0005

`migrations/0005_company_is_workspace.sql` converted databases from the earlier model, where a company was a project of a workspace. In each workspace the first company (one with books before one without, then the oldest) kept the workspace: its books took the workspace id and the workspace took the company's name. Every further company became a workspace of its own (its old id became the workspace id) with the same members, roles and two-factor rule, and its books moved intact: vouchers and their numbers and gaps, counters, the revision log and idempotency keys. A workspace without a company stayed as it was (not set up yet), and pending invitations stayed with the workspace they were sent for. The old project rows, which all stood for companies, were removed. `tests/company-model-migration.integration.ts` prepares a database with the earlier migrations, fills it with each of these cases and checks the result; every other integration test applies all migrations to an empty database.
