# Acceptance inventory

This page lists every feature a person can reach in ten98-books, so that an acceptance test of the production build can be measured against a list written before the walk. It lists what **exists in the source**, not what works: a row is neutral until a tester records a result on it. It was built from the routes in `src/routes/`, the HTTP routes in `src/server/api.ts`, `src/server/api/*.ts` and `src/server/account-security.ts`, the command registry (`src/lib/commands.ts`, `src/lib/keymaps.ts`), and the documents named in [ROADMAP.md](ROADMAP.md). Where a feature has no screen it is marked **API only, no screen** and is tested over HTTP. Where its screen is not merged it is marked **not on this commit**.

## The run this page belongs to

Filled in by the tester before the walk starts.

| Field | Value |
|---|---|
| Commit tested | |
| Image digest | |
| Date of the walk | |
| Tester(s) | |
| Browser(s) and version(s) | |
| Operating system | |
| Email transport (disabled, or a mail catcher) | |
| Companies and users used (roles) | |

## How to use the tables

- **id**: the area prefix and a stable number. Rows are never renumbered; a row that is dropped keeps its number and says so in the notes.
- **feature**: one action, in plain words. A form with create, change and delete is three rows, plus one row for each refusal worth trying (duplicate name, in use, stale revision, wrong company, viewer).
- **where**: the address of the screen (relative to the site, `<company>` is the company's id), the HTTP route, the command id, or the tool.
- **roles and negatives to try**: who may do it, and what to try that must be refused. *Outsider* means a signed-in person who is not a member of the company: every route answers them "not found", exactly as for a company that does not exist. *Not set up* means a company whose books settings were never saved: members get a 409 "not set up" on every books route.
- **status**: leave empty until tested; then write `pass`, `fail` or `blocked` (blocked: it could not be tried, and why in the notes).
- **evidence** and **notes**: leave empty until tested (a screenshot name, a response, the command output; anything a reader needs to see what happened).

Roles, in the order of power: owner, admin, editor, viewer. Owners and admins manage the team; owners, admins and editors change the books; viewers read them. Only owners and admins switch company features on or off (cost centres, inventory). Only owners set the two-factor requirement and transfer ownership.

API-only rows: a `GET` can be opened in the browser's address bar while signed in. A `POST` must carry the site's own `Origin` header, so send it from the browser console of a page of the site (`fetch` with `method: 'POST'` and a JSON body), or from a tool that sets that header; without it the answer is 403.

Keys are written for both keymaps: **classic** (the default) and **web-safe** (an account choice). `Ctrl` is the Control key on every platform.

## Companies and tenancy (CMP)

A company is a workspace: its id is the workspace id, it has its own books and its own team. The switcher, creation, first-time setup, the home page, the settings page and the isolation between companies are here.

| id | feature | where | roles and negatives to try | status | evidence | notes |
|---|---|---|---|---|---|---|
| CMP-001 | Open the site's app address with at least one company: the last company used in this browser opens, else the first | `/app` | Any member. Sign out and in as another user in the same browser: that user's own last company, not the first user's | | | |
| CMP-002 | Open the app address when the person has no company: the Create company screen opens | `/app` | A new account with no membership | | | |
| CMP-003 | The company switcher lists each company with the person's role under its name ("Owner", "Admin", "Editor", "Viewer"; "not set up yet" for a company without books settings) | sidebar switcher | One company in each role; one not set up | | | |
| CMP-004 | With no company the switcher says "No companies yet" beside a "Create company" link | sidebar switcher | An account with no membership | | | |
| CMP-005 | Choose another company in the switcher: the same page opens under that company (a page that shows one record falls back to its section, with no record ids or search parameters carried over) | sidebar switcher | From a report with a period, from a form, from the Team page | | | |
| CMP-006 | The switcher follows the company in the address; on the Team page it shows the current company | sidebar switcher, `/app/team` | Paste another company's address | | | |
| CMP-007 | A role changed from another session (promotion, demotion, removal) shows in the switcher and menus after a page change or window focus, without a reload | `/app` shell | Demote a member in one session while they have another open | | | |
| CMP-008 | A pasted address with an uppercase company id opens the same company | `/app/c/<company>` | Any member | | | |
| CMP-009 | The Change company dialog lists the companies with role, "Open now", "Not set up yet" or "Needs two-factor", and a "Create company" button; arrows move, Enter opens | command `company.switch` | Classic `F3`; web-safe `Alt+K`; from inside a text field; Escape closes it | | | |
| CMP-010 | Create a company with every field valid: it is created, its home opens, the creator is its owner | `/app/companies/new`, `POST /api/companies` | Any signed-in person (no installation limit) | | | |
| CMP-011 | Create a company in a two-decimal base currency (AED, QAR, SAR, USD, EUR, GBP, INR) | `/app/companies/new` | The Books card on home then shows two decimal places | | | |
| CMP-012 | Create a company in a three-decimal base currency (BHD, KWD, OMR) | `/app/companies/new` | Amounts on every screen then show three decimal places | | | |
| CMP-013 | Create with an empty name: "Enter the company name." | `/app/companies/new` | A name of 121 characters is refused | | | |
| CMP-014 | The second-language name is optional | `/app/companies/new` | Right-to-left text displays correctly | | | |
| CMP-015 | Financial-year start: a day that does not exist in the month (31 April, 29 February) is refused | `/app/companies/new` | Day 0 and day 32 | | | |
| CMP-016 | Books begin: a date that is not real, or outside 1900 to 2199, is refused | `/app/companies/new` | `2026-02-30` | | | |
| CMP-017 | Time zone: an unrecognised name is refused; a named zone such as Asia/Dubai is accepted | `/app/companies/new` | `UTC+4`, an empty value | | | |
| CMP-018 | Submitting twice (Enter then click) creates one company only | `/app/companies/new` | Count the companies afterwards | | | |
| CMP-019 | The same request key with the same body returns the first company (200, `replayed: true`) | `POST /api/companies` | API only, no screen for the key. Same key and a different body: 409 `idempotency_mismatch` | | | |
| CMP-020 | A new company holds the default chart: 15 primary groups, 13 sub-groups, the Cash and Profit and Loss ledgers, eight voucher types, the General cost category, the Main Store location and a base currency row | chart of accounts, `GET groups`, `GET ledgers`, `GET voucher-types`, `GET cost-categories`, `GET stock-locations`, `GET currencies` | Compare names and counts with [LEDGER.md](LEDGER.md), "Default chart" | | | |
| CMP-021 | More than 20 creations or setups in a minute are refused with "Too many requests" | `POST /api/companies` | Same user | | | |
| CMP-022 | Creating a company signed out is refused (401) | `POST /api/companies` | Signed out | | | |
| CMP-023 | A company created by first-time setup opens the "Set up the company" form (name, books settings); saving opens the company | `/app/c/<company>` | Owner or admin | | | |
| CMP-024 | A not-set-up company shows an editor or viewer "<name> is not set up yet" with a Try again button | `/app/c/<company>` | Editor, viewer | | | |
| CMP-025 | Saving the setup form twice: the second answer is 409 `already_set_up` | `POST /api/companies/<company>/setup` | API only for the repeat; an editor is refused | | | |
| CMP-026 | On a not-set-up company every books route answers a member 409 `not_set_up` (settings, masters, vouchers, reports, exports) | `/api/companies/<company>/...` | A viewer's write answers "not found" as on any company | | | |
| CMP-027 | Company home shows the name, the second-language name, the company menu and the Books card (base currency and decimal places, current financial year, books begin, time zone) | `/app/c/<company>` | All roles | | | |
| CMP-028 | The company menu lists 12 items for an owner, admin or editor; a viewer sees 10 (no New master, no Edit a master) | `/app/c/<company>` | Viewer: the hidden letters `C` and `A` do nothing | | | |
| CMP-029 | The item last opened in this tab is highlighted again when coming back to the menu with Escape | `/app/c/<company>` | Open a report, press Escape | | | |
| CMP-030 | Company settings, owner or admin: the Name form renames the company; the new name shows in the switcher, breadcrumb, home and reports | `/app/c/<company>/settings`, `POST /api/workspaces/<company>/rename` | Editor and viewer see no form and a rename request is refused | | | |
| CMP-031 | Rename with an empty name: "Enter the company name." | `/app/c/<company>/settings` | Owner or admin | | | |
| CMP-032 | The Books section shows, read-only, the second-language name, base currency, financial-year start, books beginning, time zone and "Locked through" ("Not locked" when empty) | `/app/c/<company>/settings` | All roles; there is no way to edit these here | | | |
| CMP-033 | The sidebar lists Home, Masters, Vouchers, Reports and Company settings only for a set-up company, Team only for owners and admins, and Account always | sidebar | Not-set-up company; editor; admin | | | |
| CMP-034 | The top bar shows the company and page title, a "Development preview" badge (hidden on a narrow screen) and the account menu | top bar | Narrow window: the menu toggle opens the sidebar | | | |
| CMP-035 | The skip link jumps to the main content | shell | Keyboard: first Tab on a page | | | |
| CMP-036 | The Vouchers section opens a page saying vouchers are not built yet, and records nothing | `/app/c/<company>/vouchers` | All roles | | | |
| CMP-037 | A company the person is not a member of shows "Company not found" | `/app/c/<outsider company>` | Outsider; a made-up id gives the same page | | | |
| CMP-038 | The company read answers an outsider "not found", identical to a missing id | `GET /api/companies/<company>` | Outsider; compare the two answers | | | |
| CMP-039 | There is no route that creates a bare workspace | `POST /api/workspaces` | 404 "Route unavailable" | | | |
| CMP-040 | Two companies keep separate books: a ledger made in one is not in the other | chart of accounts in both | One user with two companies | | | |
| CMP-041 | One person holds different roles in two companies and sees the matching menus and refusals in each | both companies | Owner in A, viewer in B | | | |
| CMP-042 | A company that requires two-factor shows a member without it a warning banner "Two-factor authentication required" with a link to Account security, and its routes answer 403 | shell banner, `/api/companies/<company>/...` | Member without a verified factor; `GET /api/me` and the company list still work | | | |
| CMP-043 | A page address that matches no route shows the router's default not-found page | any unknown address under the site | Record what appears | | | |

## Account and security (ACC)

First-time setup, sign-in, two-factor, password recovery, the account page (profile, keymap, password, two-factor, sessions) and sign-out. The signed-out entry is the site's root address; everything else is under `/app/account`.

| id | feature | where | roles and negatives to try | status | evidence | notes |
|---|---|---|---|---|---|---|
| ACC-001 | On a fresh installation the root address offers "Create owner account" (name, email, password of 12 to 128 characters); saving signs the person in and leads to the first company's setup | `/`, `POST /api/auth/setup` | Password of 11 and of 129 characters refused | | | |
| ACC-002 | The first account is the installation operator and the owner of the first company, which is not set up yet | `GET /api/me` | `instanceOperator` is true for this account only | | | |
| ACC-003 | Setup after the installation is claimed is refused (409) and the page offers "sign in instead" | `/`, `POST /api/auth/setup` | Open setup from a second browser | | | |
| ACC-004 | More than 10 setup attempts in 15 minutes from one client are refused with "Too many attempts" | `POST /api/auth/setup` | Unresolved client address: a lower ceiling | | | |
| ACC-005 | After setup the root address shows the sign-in form; the installation status probe says configured | `/`, `GET /api/status`, `GET /api/session` | Signed out: `user` is null and no person is named | | | |
| ACC-006 | Sign in with a valid email and password opens the app | `/`, `POST /api/auth/sign-in/email` | The email is accepted in any case and with spaces around it | | | |
| ACC-007 | Sign in with a wrong password, and with an unknown email, give the same message "Email or password is incorrect." | `/` | Compare the two messages | | | |
| ACC-008 | More than 5 sign-in attempts for one email in a minute are refused with "Too many attempts" | `POST /api/auth/sign-in/email` | Per client 60 a minute | | | |
| ACC-009 | With two-factor on, sign-in leads to "Verify your sign-in"; a correct six-digit authenticator code completes it | `/`, `POST /api/auth/two-factor/verify-totp` | Wrong code: "The code was not accepted" | | | |
| ACC-010 | The challenge also takes one unused recovery code; the same code again is refused | `POST /api/auth/two-factor/verify-backup-code` | Wrong format refused | | | |
| ACC-011 | An authenticator code already used is refused until the next code: "Wait for the next authenticator code" | verify-totp | Reuse within 90 seconds | | | |
| ACC-012 | Ten failed codes lock the challenge; more than 10 tries a minute on one challenge are refused | verify-totp | Then try a right code | | | |
| ACC-013 | "Back to sign in" on the challenge returns to the sign-in form | `/` | | | | |
| ACC-014 | A signed-in person who opens the root address is sent to the app | `/` | | | | |
| ACC-015 | A signed-out person who opens an app address is sent to the root address once a request answers 401 | `/app/...` | Delete the session cookie, then act | | | |
| ACC-016 | Sign out from the account menu returns to the root address and ends the session | account menu, `POST /api/auth/sign-out` | Back button: no app data without signing in; `GET /api/me` answers 401 | | | |
| ACC-017 | The identity library's own routes are not reachable | `/api/auth/get-session` and any other `/api/auth/...` | 404 "Authentication route unavailable" | | | |
| ACC-018 | "Forgot password" on the sign-in form opens the recovery request, carrying the typed email | `/` | | | | |
| ACC-019 | With email enabled, the recovery request answers the same message for a known and an unknown address ("If a local password account matches...") | `/`, `POST /api/auth/request-password-reset` | Compare the two | | | |
| ACC-020 | With email disabled the recovery page says recovery is not configured, and the request is refused (503) | `/`, `GET /api/auth/password-reset-status` | `configured` is false | | | |
| ACC-021 | The recovery email holds a link with a 24-character code, valid for one hour and one use | the email | Needs a mail catcher | | | |
| ACC-022 | The recovery link opens "Choose a new password" (12 to 128 characters, entered twice); success returns to sign-in with a notice that the password changed | `/#password-reset=<code>`, `POST /api/auth/reset-password` | Different confirmation refused | | | |
| ACC-023 | A reset link that is expired, used, malformed or incomplete shows "invalid, expired or already used" and offers a new link | `/#password-reset=...` | Use it twice; cut a character | | | |
| ACC-024 | A reset signs out the person's other sessions and leaves their two-factor settings and recovery codes unchanged | after ACC-022 | Another browser with a session | | | |
| ACC-025 | Recovery limits: 3 requests a minute per email, 20 per client, 5 attempts per code | recovery routes | | | | |
| ACC-026 | A recovery or invitation code in the address bar is removed from the address once read; a reload loses it ("reopen the email") | `/#...` | | | | |
| ACC-027 | The recovery routes refuse URL parameters, and the status read refuses a request body | `/api/auth/password-reset-status` | 400 | | | |
| ACC-028 | The account page shows the email (read-only), name, time zone, regional format and theme; Save changes is enabled only after a change | `/app/account` | All roles | | | |
| ACC-029 | Change the display name; it shows in the account menu | `/app/account` | Empty and 121 characters refused | | | |
| ACC-030 | Change the time zone, including "detect from this browser" | `/app/account` | An unrecognised zone is refused | | | |
| ACC-031 | Change the regional format; the draft preview of a number and a date follows it | `/app/account` | Right-to-left locale | | | |
| ACC-032 | Change the theme (light, dark, system); it applies at once, survives a reload, and does not flash on load | `/app/account` | Blocked browser storage shows the system theme until the account loads | | | |
| ACC-033 | "Restore default preferences" stages the defaults; Save applies them | `/app/account` | | | | |
| ACC-034 | "Reload saved preferences" discards unsaved edits | `/app/account` | | | | |
| ACC-035 | Leaving the page with unsaved preferences asks "Discard your unsaved preferences?" with focus on Keep editing | `/app/account` | Browser back, a link, reload | | | |
| ACC-036 | Saving preferences changed in another session is refused ("changed on another device") and the form stays disabled until reloaded | `POST /api/account/preferences` | Two tabs | | | |
| ACC-037 | Preferences read and write refuse URL parameters, and limit writes to 30 and reads to 120 a minute | `/api/account/preferences` | | | | |
| ACC-038 | The Keyboard shortcuts card offers Classic and Web-safe; a change is saved at once and applies without a reload | `/app/account`, `PUT /api/account/keymap` | An invalid keymap name: 400 | | | |
| ACC-039 | "Show all shortcuts" opens the keyboard help | `/app/account` | | | | |
| ACC-040 | Until a keymap is chosen the company home shows "Choose your keyboard shortcuts" (Keep classic keys, Switch to web-safe keys); it blocks nothing and goes after a choice | `/app/c/<company>` | A save failure keeps the prompt with its error | | | |
| ACC-041 | The keymap choice follows the account to another device | `GET /api/account/keymap` | `chosen` is false until a choice | | | |
| ACC-042 | Change password: current and new (12 to 128); success says the other sessions were signed out and this one stays | `/app/account`, `POST /api/account/password` | Wrong current password refused; other browser is signed out | | | |
| ACC-043 | Start two-factor setup with the password: a setup key and link for an authenticator app are shown | `/app/account`, `POST /api/account/two-factor/enable` | Wrong password refused; already enabled refused | | | |
| ACC-044 | Confirm setup with a six-digit code: two-factor turns on and the recovery codes are shown once | `POST /api/account/two-factor/verify` | Wrong code refused; no setup started: 409 | | | |
| ACC-045 | Download the recovery codes as `books-recovery-codes.txt`; acknowledging closes the list, and they are not shown again | `/app/account` | | | | |
| ACC-046 | Replace the recovery codes with the password: a new set shows and the old ones stop working | `POST /api/account/two-factor/recovery-codes` | Without two-factor on: refused | | | |
| ACC-047 | Turn two-factor off with the password and an authenticator or recovery code | `POST /api/account/two-factor/disable` | A wrong password does not consume a code | | | |
| ACC-048 | Turning two-factor on or off, replacing codes and changing the password end the person's other sessions | account page | Another browser | | | |
| ACC-049 | The sessions list shows each session's device, when it was started and which one is current (at most 100) | `/app/account`, `GET /api/account/security` | | | | |
| ACC-050 | Revoke another session: that browser is signed out at its next request | `POST /api/account/sessions/revoke` | | | | |
| ACC-051 | Revoke the current session: the person is signed out | same | | | | |
| ACC-052 | "Sign out other sessions" keeps only the current one | `POST /api/account/sessions/revoke-others` | | | | |
| ACC-053 | Revoking a session id that is not the person's own answers "Session not found" | `POST /api/account/sessions/revoke` | Another user's id | | | |
| ACC-054 | Account security routes need a session (401) and limit reads to 120 and writes to 30 a minute | `/api/account/...` | Signed out | | | |
| ACC-055 | A state-changing request without the site's own Origin header, or with another, is refused (403) | any `POST` or `PUT` | A form posted from another site | | | |

## Team and invitations (TEM)

The Team page (owners and admins), the invitation links, the public invitation screen, roles, ownership transfer and the two-factor requirement. Editors and viewers have no Team page.

| id | feature | where | roles and negatives to try | status | evidence | notes |
|---|---|---|---|---|---|---|
| TEM-001 | The Team page lists the members with name, email and role | `/app/team`, `GET /api/workspaces/<company>/team` | Owner, admin | | | |
| TEM-002 | Editors and viewers are told only owners and admins manage the team; Team is not in their sidebar; the team read is refused | `/app/team` | Editor, viewer | | | |
| TEM-003 | With no company the Team page says "You do not belong to any company yet." | `/app/team` | New account | | | |
| TEM-004 | Invite an email with a role: owners may offer admin, editor, viewer; admins may offer editor and viewer; a pending invitation appears with its expiry (7 days) and a link to copy | Team page, `POST /api/workspaces/<company>/invitations` | An admin asking for admin or owner is refused | | | |
| TEM-005 | With email enabled the result says the provider accepted the message (not that it was delivered); with email disabled it says to share the link yourself; a send failure says it could not be sent | Team page | `emailConfigured` on the team read | | | |
| TEM-006 | The invitation email has fixed wording (no company or inviter name) and the link `/#invite=<code>` | the email | Needs a mail catcher | | | |
| TEM-007 | Inviting an email that is already a member | Team page | Record the answer | | | |
| TEM-008 | Inviting the same email again replaces the earlier link: only the newest link works | Team page | Use the old link | | | |
| TEM-009 | Invitation emails are limited to 3 per address and 20 in all a minute; the invitation still exists when the email is refused | invite | Result shows "failed" | | | |
| TEM-010 | More than 60 team actions a minute by one user are refused | team routes | | | | |
| TEM-011 | Resend an invitation by email (offered only when email is set up): a new link goes out and the previous link stops | Team page, `POST .../invitations/<id>/resend` | Limits: 3 an hour per invitation, 20 an hour per company | | | |
| TEM-012 | Resend with email disabled (API): 409 telling the person to use New link; the current link still works | `.../resend` | API only for the refusal | | | |
| TEM-013 | New link: a link to copy; the previous link stops; no email is sent | Team page, `.../new-link` | | | | |
| TEM-014 | Revoke an invitation: it leaves the list and its link says it is unavailable | Team page, `.../revoke` | | | | |
| TEM-015 | An invitation older than 7 days is not listed and its link is refused | team read, link | Needs the clock moved or an old invitation | | | |
| TEM-016 | An invitation whose inviter can no longer grant its role is no longer pending | team read | Demote the inviter after inviting | | | |
| TEM-017 | Change a member's role: owners change admin, editor and viewer; admins change editors and viewers only | Team page, `POST .../members/<id>/role` | Changing yourself, or an admin changing an admin or an owner: refused | | | |
| TEM-018 | A role change takes effect for that person at once in their other session (menus and refusals) | their session | Demote an editor, then try a write | | | |
| TEM-019 | Remove a member: they lose the company at once and it leaves their switcher | Team page, `POST .../members/<id>/remove` | Admin removing an admin or an owner; record the answer for removing an owner | | | |
| TEM-020 | A member removes themselves | `POST .../members/<own id>/remove` | API only, no screen for it; the owner is always kept | | | |
| TEM-021 | Transfer ownership (owner only): pick a member and confirm; they become owner and the caller becomes admin | Team page, `POST .../transfer-ownership` | Wrong confirmation email, a non-member, an admin as caller: refused | | | |
| TEM-022 | The ownership and two-factor controls are shown to owners only | Team page | Admin sees neither | | | |
| TEM-023 | Require two-factor for the company (owner only); the owner must have two-factor on first | Team page, `POST .../two-factor` | Owner without two-factor: 409 | | | |
| TEM-024 | With the rule on, a member without two-factor sees the warning banner on every page and every company and team route answers 403 | shell | Member | | | |
| TEM-025 | The member turns two-factor on and gets access back without signing in again | `/app/account` | | | | |
| TEM-026 | The owner turns the requirement off | Team page | | | | |
| TEM-027 | New person, no account: the invitation screen shows the company, email, role and expiry; choosing a name and password creates the account, signs in and opens that company | `/#invite=<code>`, `POST /api/invitations/accept` | Password rules as sign-up | | | |
| TEM-028 | Existing account, signed out: the screen asks to sign in ("Sign in to join"); after signing in the invitation reopens and accepting adds the membership | `/#invite=<code>` | Wrong password | | | |
| TEM-029 | Signed in as a different email than the invited one | `/#invite=<code>` | Offered sign-in as the invited account; accepting as the wrong user refused | | | |
| TEM-030 | Signed in as the invited email: accept directly | `/#invite=<code>` | | | | |
| TEM-031 | An invalid, expired, used or revoked link says it is unavailable or no longer pending | `/#invite=<code>` | | | | |
| TEM-032 | A malformed code in the address is ignored and the normal entry shows | `/#invite=abc` | | | | |
| TEM-033 | "Back to invitation" and cancel return correctly between the sign-in form and the invitation screen | `/` | | | | |
| TEM-034 | Public invitation routes are limited to 60 a minute per client and 10 a minute per code | `POST /api/invitations/inspect`, `.../accept` | | | | |
| TEM-035 | Accepting grants only the invited role and uses the invitation up; a second use is refused | accept | | | | |
| TEM-036 | Inspecting an invitation shows only company name, email, role, expiry and whether an account exists | `POST /api/invitations/inspect` | No member list | | | |
| TEM-037 | The new member appears on the Team page with the invited role | Team page | | | | |
| TEM-038 | Accepting into a company that requires two-factor leaves the new member locked until they turn it on | accept, shell | | | | |
| TEM-039 | An admin or owner of company A cannot read or change the team, invitations or members of company B | team routes | Outsider: 404 | | | |
| TEM-040 | An editor or viewer calling any team route is refused | team routes | | | | |

## Masters: groups, ledgers and voucher types (MAS)

The chart of accounts, the create and change forms for groups and ledgers, the change list, the history views, and the voucher type routes (API only). Cost categories and centres are in their own area. Names are unique per kind under the name match key: case, spaces and `- . / , ( ) + * ; = ~ ? { } &` do not tell names apart, an underscore does.

| id | feature | where | roles and negatives to try | status | evidence | notes |
|---|---|---|---|---|---|---|
| MAS-001 | The Masters section opens the chart of accounts | `/app/c/<company>/masters` | Redirects to `/masters/chart-of-accounts` | | | |
| MAS-002 | The chart lists the four natures with their group and ledger counts, then groups and ledgers as an indented tree; built-in rows carry a badge; each ledger shows its opening balance with Dr or Cr, or "No opening balance" | `/masters/chart-of-accounts` | All roles; Arabic names display correctly | | | |
| MAS-003 | The header counts the groups and ledgers | chart | | | | |
| MAS-004 | Arrow keys move the highlighted row; coming back from a form lands on the same row | chart | | | | |
| MAS-005 | Enter on a row opens its change form | chart | Group row, ledger row | | | |
| MAS-006 | The Create button, and `Alt+C`, open the choice of what to create, starting under the highlighted group (or the ledger's group) | chart, command `list.create` | Viewer: no button, key does nothing | | | |
| MAS-007 | `Alt+D` (classic) or `Alt+X` (web-safe) on an unused row asks "Delete the group/ledger ...?" (focus on cancel); confirming deletes it, shows a message and moves the highlight to the neighbour | chart, command `list.delete` | There is no delete button on the chart | | | |
| MAS-008 | Delete is unavailable, with the reason shown, for a built-in row, a group that holds groups or ledgers, and a ledger that vouchers use | chart | Highlight each kind of row | | | |
| MAS-009 | `Alt+H` (classic) or `Alt+Y` (web-safe) on a row opens its history | chart, command `list.history` | | | | |
| MAS-010 | A viewer sees the chart read-only with "Viewers can read the chart but not change it." | chart | Viewer | | | |
| MAS-011 | A failed load shows "The chart could not be loaded" with Try again | chart | Stop the server briefly | | | |
| MAS-012 | The create choice lists Group, Ledger, Cost category and Cost centre; Enter opens the form; it remembers the last choice | `/masters/new` | Viewer: "Viewers cannot create masters." | | | |
| MAS-013 | Create a group under another group: name, second-language name, Under; saved with a message; the form clears for the next entry and keeps the parent | `/masters/new/group`, `POST /api/companies/<company>/groups` | Owner, admin, editor | | | |
| MAS-014 | Create a primary group: Under is Primary; its nature (asset, liability, income, expense) is required and "Counts towards gross profit" shows | `/masters/new/group` | | | | |
| MAS-015 | A sub-group takes the nature of its parent, and the form says so | `/masters/new/group` | | | | |
| MAS-016 | Enter on the last field shows "Save this group?" with Save focused; Enter saves, Escape keeps editing | group form | Holding Enter down does not save | | | |
| MAS-017 | A group with an empty name is refused on the Name field | group form | | | | |
| MAS-018 | A duplicate group name (same under the name match key, for example "Sales" and "s a l e s") is refused on the Name field, keeping what was typed | group form | An underscore makes a different name | | | |
| MAS-019 | Change a group's name and second-language name; the chart shows a saved message | `/masters/edit/group/<group>`, `POST .../groups/<group>` | | | | |
| MAS-020 | Move a group under another group; the Under list disables the group itself and its sub-groups, with reasons | group form | A move that would make a cycle is refused | | | |
| MAS-021 | A group's nature is locked, with the reason, while its sub-tree holds a built-in row or a ledger with postings or a non-zero opening | group form | | | | |
| MAS-022 | Change "Counts towards gross profit" | group form | | | | |
| MAS-023 | Two people change the same group: the second save is refused ("changed by someone else") and the screen offers a reload | group form | Two tabs | | | |
| MAS-024 | Delete a group from its form: confirmation, then it leaves the chart | group form, `POST .../groups/<group>/delete` | A group with sub-groups or ledgers, or a built-in one: not deletable | | | |
| MAS-025 | The history of a group lists when, who, what happened and the details, newest first, in the company's time zone; a deleted group's history stays readable | `/masters/history/group/<group>`, `GET .../groups/<group>/revisions` | Escape and Back return to the chart row | | | |
| MAS-026 | A viewer opening a group sees it read-only with Back focused and the history open | `/masters/edit/group/<group>` | Viewer | | | |
| MAS-027 | Create a ledger: name, second-language name, group, takes cost centres, opening balance, debit or credit; saved with a message; the form clears and keeps the group | `/masters/new/ledger`, `POST .../ledgers` | | | | |
| MAS-028 | The Group lookup filters as you type, shows where each group sits, and a disabled group says why | ledger form | | | | |
| MAS-029 | The opening balance takes the company's decimal places; extra places, letters and signs are refused | ledger form | Two- and three-decimal companies | | | |
| MAS-030 | The side defaults from the group's nature (debit for assets and expenses, credit for liabilities and income) until chosen | ledger form | | | | |
| MAS-031 | Opening balances are locked, with a note, when the books are locked through the books-beginning date | ledger form | Needs a company with the lock set outside the app | | | |
| MAS-032 | The "Opening balances of the company" card shows the opening stock when there is one, total debit and total credit (counting the stock) and the difference, and updates after each save | ledger form | Saving is never blocked by a difference | | | |
| MAS-033 | A duplicate ledger name is refused on the Name field | ledger form | | | | |
| MAS-034 | "Takes cost centres" follows the group (income and expense: yes) until chosen, says what applies, and the profit and loss ledger has it locked | ledger form | See also COS-029 | | | |
| MAS-035 | Change a ledger's name, group and opening balance | `/masters/edit/ledger/<ledger>`, `POST .../ledgers/<ledger>` | | | | |
| MAS-036 | The built-in Profit and Loss ledger has no group and no cost centres; it can be renamed and not deleted | ledger form | | | | |
| MAS-037 | The built-in Cash ledger cannot leave the cash and bank groups | ledger form | | | | |
| MAS-038 | Two people change the same ledger: stale revision refused | ledger form | Two tabs | | | |
| MAS-039 | Delete an unused ledger: confirmation, then it leaves the chart | ledger form, `POST .../ledgers/<ledger>/delete` | A ledger used by any voucher line (cancelled and deleted vouchers included) is refused | | | |
| MAS-040 | The history of a ledger, including changes of its cost centre setting | `/masters/history/ledger/<ledger>` | | | | |
| MAS-041 | A viewer opening a ledger sees it read-only | `/masters/edit/ledger/<ledger>` | Viewer | | | |
| MAS-042 | In every lookup, typing a choice (`yes`, `no`, the start of a name) and pressing Enter picks it and moves on | forms | | | | |
| MAS-043 | Free text is never kept: Enter on text that names no choice says it is not one of the choices | forms | | | | |
| MAS-044 | Lookups match names under the name match key ("z-nm 1" finds "ZNM.1") | forms | | | | |
| MAS-045 | Leaving a form with typed changes asks "Discard unsaved changes?" with focus on Keep editing, whether by Escape, `Ctrl+Q`, the Leave button, go-to, the company switcher, a link or the browser's back; a reload or closing the tab warns | forms | After a save the form leaves without asking | | | |
| MAS-046 | The change list has a search field with focus, lists groups, ledgers, cost categories and cost centres with a kind badge and where each sits, and filters by name, second-language name or place | `/masters/edit` | Escape clears the filter, then moves to the list, then goes to the company menu | | | |
| MAS-047 | Enter on a row of the change list opens that master's change form | `/masters/edit` | Each of the four kinds | | | |
| MAS-048 | A viewer who opens the change list by address can read it but not change anything | `/masters/edit` | Viewer; record what is offered | | | |
| MAS-049 | List groups and ledgers, with an `inUse` flag on each row | `GET .../groups`, `GET .../ledgers` | API only: the flag matches what delete allows | | | |
| MAS-050 | Read one group and one ledger | `GET .../groups/<group>`, `GET .../ledgers/<ledger>` | An id of another company: 404 | | | |
| MAS-051 | List the eight voucher types | `GET .../voucher-types` | API only, no screen | | | |
| MAS-052 | Rename a voucher type | `POST .../voucher-types/<type>` | API only; a duplicate name under the key and a stale revision are refused | | | |
| MAS-053 | Read one voucher type and its history | `GET .../voucher-types/<type>`, `.../revisions` | API only | | | |
| MAS-054 | Voucher types cannot be created or deleted | `POST .../voucher-types`, `.../delete` | API only: refused (405 or 404) | | | |
| MAS-055 | A ledger's balance for a period | `GET .../ledgers/<ledger>/balance?from=&to=` | API only; equals its trial balance row | | | |
| MAS-056 | The history of a group, ledger or voucher type lists the actor's name, or none once that user is gone | `GET .../revisions` | API only | | | |
| MAS-057 | A viewer's write to any master route answers "not found"; an outsider's answers the same | `POST .../groups`, `.../ledgers` | Viewer, outsider | | | |
| MAS-058 | More than 120 master writes a minute by one user are refused | masters routes | | | | |
| MAS-059 | Second-language names carry no uniqueness rule | forms | Two masters with one second name | | | |

## Cost categories and centres (COS)

The list of categories and centres, the company switch, the create and change forms, history, and the API-only parts. Cost reports are in the Reports area; allocation on voucher lines is in the Voucher entry area.

| id | feature | where | roles and negatives to try | status | evidence | notes |
|---|---|---|---|---|---|---|
| COS-001 | Open the cost categories and centres list from the company menu (`E`), the go-to list, or the change company menu | `/masters/cost-centres` | All roles | | | |
| COS-002 | The list shows each category (a Built-in badge on General, its two "Used on" settings in words) followed by its centres as a tree | `/masters/cost-centres` | A centre whose parent was left in another category says where the parent is | | | |
| COS-003 | While the feature is off the list says so ("Cost centres are switched off for this company") and that vouchers do not ask for them yet; categories and centres can still be set up | `/masters/cost-centres` | New company | | | |
| COS-004 | Switch cost centres on from the notice button or `Alt+N`; it takes effect at once with a message | `/masters/cost-centres`, command `list.switch`, `POST .../cost-centres-setting` | Owner, admin | | | |
| COS-005 | Switch them off: a question first ("Switch cost centres off?", focus on cancel); after confirming, new allocations are dropped and saved ones still count | same | Owner, admin | | | |
| COS-006 | Editors and viewers see no switch and are told to ask an owner or admin; the setting can still be read | `/masters/cost-centres`, `GET .../cost-centres-setting` | Editor, viewer; their `POST` answers "not found" | | | |
| COS-007 | Create a cost category: name, second-language name, "used on income and expense ledgers" (Yes by default), "used on balance-sheet ledgers" (No by default); saved with a message | `/masters/new/cost-category`, `POST .../cost-categories` | The form says the two settings are stored and not checked on vouchers | | | |
| COS-008 | A duplicate category name (under the name match key) is refused on the Name field; a category and a centre may share a name | cost category form | | | | |
| COS-009 | Change a category's name, second-language name and its two settings | `/masters/edit/cost-category/<category>`, `POST .../cost-categories/<category>` | | | | |
| COS-010 | The General category can be renamed and has no delete | cost category form | | | | |
| COS-011 | Two people change the same category: stale revision refused | cost category form | Two tabs | | | |
| COS-012 | Delete an empty, unused category: confirmation, then it leaves the list; one that holds centres or is used shows the server's refusal in an announced alert and focus stays on the row | list, form, `POST .../cost-categories/<category>/delete` | | | | |
| COS-013 | Create a cost centre: category, name, second-language name, Under; saved with a message | `/masters/new/cost-centre`, `POST .../cost-centres` | Owner, admin, editor | | | |
| COS-014 | The Under list offers the top level and the centres of the chosen category, never the centre itself or anything below it | cost centre form | | | | |
| COS-015 | A centre created or moved under a parent takes the parent's category; choosing another category drops a parent that is not in it | cost centre form | | | | |
| COS-016 | A centre name is unique across all categories: a duplicate is refused on the Name field | cost centre form | Same name in another category | | | |
| COS-017 | Change a centre's name, category and parent | `/masters/edit/cost-centre/<centre>`, `POST .../cost-centres/<centre>` | Saved vouchers keep the category they were saved with; reports follow the centre | | | |
| COS-018 | `Alt+Q` on a centre row opens its change form with the cursor on the category | `/masters/cost-centres`, command `list.move` | Not available on a category row | | | |
| COS-019 | `Alt+C` on a category row starts a centre in that category; on a centre row, beside it (same category and parent) | `/masters/cost-centres`, command `list.create` | | | | |
| COS-020 | The buttons "Create cost centre" and "Create cost category" open the two forms | `/masters/cost-centres` | Viewer: no buttons | | | |
| COS-021 | Moving a centre under its own sub-centre is refused | `POST .../cost-centres/<centre>` | API only for the refusal (`cycle`) | | | |
| COS-022 | Delete an unused centre; one that holds sub-centres or is used by allocation rows is refused | list, form, `POST .../cost-centres/<centre>/delete` | | | | |
| COS-023 | History of a category and of a centre | `/masters/history/cost-category/<category>`, `/masters/history/cost-centre/<centre>` | `Alt+H` or `Alt+Y` on a list row | | | |
| COS-024 | The change list (`A` on the company menu) finds categories and centres by name | `/masters/edit` | | | | |
| COS-025 | A viewer sees the list and every form read-only with Back focused, and no Create, Delete, Move or Switch | `/masters/cost-centres` | Viewer | | | |
| COS-026 | A failed load shows "Cost categories and centres could not be loaded" with Try again | list | | | | |
| COS-027 | List cost categories (with an in-use flag) and cost centres (each naming its category) | `GET .../cost-categories`, `GET .../cost-centres` | API only for the flags | | | |
| COS-028 | Read one category and one centre | `GET .../cost-categories/<id>`, `GET .../cost-centres/<id>` | An id of another company: 404 | | | |
| COS-029 | The ledger form's "Takes cost centres" default and lock; the ledger's history lists a change of it | `/masters/new/ledger`, `/masters/edit/ledger/<ledger>` | When the company has the feature off, the field says vouchers do not ask yet | | | |
| COS-030 | The entry prefill: the centre of a ledger's most recent live allocation row | `GET .../ledgers/<ledger>/cost-default` | API only, no screen; null when none | | | |
| COS-031 | Revision history of categories and centres | `GET .../cost-categories/<id>/revisions`, `.../cost-centres/<id>/revisions` | API only | | | |
| COS-032 | A viewer's write on any cost master route answers "not found"; an outsider's answers the same | cost routes | Viewer, outsider | | | |

## Reports (REP)

Eleven report screens, the drill-down between them, period handling, paging, CSV export and print, then the report routes that have no screen. Screen paths are under `/app/c/<company>/reports/`. Read-only for every role, viewers included. Only regular, undeleted vouchers count: cancelled, deleted and optional ones never move a balance ([REPORTS.md](REPORTS.md)).

| id | feature | where | roles and negatives to try | status | evidence | notes |
|---|---|---|---|---|---|---|
| REP-001 | The Reports section shows one menu of every report, grouped Statements, Registers and Cost centres; arrows and Enter, or a report's letter, open it | `/reports` | All roles | | | |
| REP-002 | Statements and the ledger screens open on the financial-year start through the last voucher date; the day book opens on that one day | each report | A company with no voucher: the books-beginning date | | | |
| REP-003 | The period is in the address (`from`, `to`); a reload keeps it and the address can be shared | each report | Edit the address by hand | | | |
| REP-004 | Change the period in a dialog (two dates; Enter applies; Escape or Cancel closes) | any ranged report, command `report.period` | A start after the end, or longer than ten years, is refused with a message | | | |
| REP-005 | A statement's period carries to the next report opened by drill-down or "open another report"; the day book's day does not | statements, day book | Open another report from the day book | | | |
| REP-006 | "Open another report" lists the reports; its title says go to or switch to; a letter or Enter opens one | any report, commands `nav.go-to`, `nav.switch-to` | Classic `Alt+G` and `Ctrl+G`; web-safe `Alt+G` only | | | |
| REP-007 | Escape goes back one drill level and highlights the line it left from; from a statement it goes to the company menu | any report, command `nav.back` | After a reload there is no trail: Escape goes to the logical parent | | | |
| REP-008 | The highlighted line, the page of a register and the period are kept in the address, so Back restores them | registers, statements | | | | |
| REP-009 | Amounts are right-aligned with grouping and the company's decimals; balances read "amount Dr" or "amount Cr" | all reports | Two- and three-decimal companies | | | |
| REP-010 | The panel shows the title, the period (or "As at" date), the company and currency, and a status; a failed load says why and offers Try again | all reports | Stop the server, then Try again | | | |
| REP-011 | Export as CSV from the action bar button or the key; the file is saved and the screen says "Saved <name>.csv" | any exporting report, command `report.export` | Classic `Ctrl+E`; web-safe `Alt+O` | | | |
| REP-012 | A failed export shows its message on the screen | any exporting report | Exceed the export limit (REP-014) | | | |
| REP-013 | The CSV starts with a byte-order mark, quotes every cell, writes plain decimals with the currency's places and Dr or Cr columns, prefixes a formula-like cell with an apostrophe, and uses a level column instead of indentation | any export | Open in a spreadsheet; Arabic names | | | |
| REP-014 | More than 20 exports a minute by one user are refused ("Too many requests"); reading reports is not limited | all `/export` routes | | | | |
| REP-015 | Print the report on screen from the action bar button or the key; the sidebar, top bar, action bar and buttons are left out | any report, command `report.print` | Classic `Ctrl+P`; web-safe `Alt+I`; print preview only | | | |
| REP-016 | A one-page report prints every line; a register prints only the page on screen, with its summary line naming the vouchers | trial balance, day book | | | | |
| REP-017 | A viewer reads and exports every report | all reports | Viewer | | | |
| REP-018 | An outsider is answered "not found" on every report and export; a not-set-up company answers 409 | `/api/companies/<company>/reports/...` | Outsider | | | |
| REP-019 | The trial balance shows the group hierarchy with opening, period and closing debit and credit, grand totals, and, when openings disagree, a "Difference in opening balances" line | `/reports/trial-balance`, `GET .../reports/trial-balance` | | | | |
| REP-020 | The trial balance's condensed view shows primary groups; the Detailed switch shows every sub-group and ledger | trial balance, command `report.detail` | Classic `Alt+F5`; web-safe `Alt+M` | | | |
| REP-021 | The "Lines without amounts" switch shows or hides lines with no figures | trial balance, command `report.zero-lines` | `Alt+N` | | | |
| REP-022 | Enter on a group line opens its group summary; on a ledger line its monthly summary | trial balance | The stock row (a company with opening stock) opens nothing | | | |
| REP-023 | A period starting after the books begin shows one profit and loss row holding earlier income and expense; a period before the books begin shows the openings | trial balance | A February period of a year starting in January | | | |
| REP-024 | A period across several financial years is accepted | trial balance, group summary | | | | |
| REP-025 | Profit and loss shows trading income and cost of sales to the gross profit or loss, then other income and expenses to the net profit or loss | `/reports/profit-and-loss`, `GET .../reports/profit-and-loss` | | | | |
| REP-026 | A period longer than one financial year is refused with a plain message | profit and loss | | | | |
| REP-027 | Profit and loss: Detailed and Lines without amounts switches; Enter on a group opens the group summary and on a ledger the monthly summary | profit and loss | | | | |
| REP-028 | A company with opening stock shows Opening stock and Closing stock lines in profit and loss; a company without shows none | profit and loss | | | | |
| REP-029 | The balance sheet is read at one date (the dialog asks "As at"); capital and liabilities and assets are listed by group, and both sides agree | `/reports/balance-sheet?to=`, `GET .../reports/balance-sheet?date=` | | | | |
| REP-030 | The balance sheet shows the profit and loss account as brought forward and current period; a profit stands with the liabilities and a loss with the assets | balance sheet | | | | |
| REP-031 | Balance sheet: Detailed and Lines without amounts switches; Enter on a group, ledger or the profit and loss lines opens the group summary, monthly summary or profit and loss | balance sheet | | | | |
| REP-032 | A company with opening stock shows a Closing stock line in current assets | balance sheet | | | | |
| REP-033 | The group summary without a group lists the primary groups and the ledgers outside every group; with a group, its direct sub-groups and ledgers with opening, debit, credit and closing | `/reports/group-summary`, `GET .../reports/group-summary[/<group>]` | Opened from the "open another report" list (it is not on the company menu) | | | |
| REP-034 | Group summary: Enter on a sub-group opens its summary, on a ledger its monthly summary; the "Lines without amounts" switch works | group summary | | | | |
| REP-035 | Opened by address, Escape on a group summary goes to the parent group or to its statement | group summary | | | | |
| REP-036 | The day book lists vouchers of the day or period by date and entry order: date, particulars, voucher type, number, debit and credit | `/reports/day-book`, `GET .../reports/day-book` | | | | |
| REP-037 | Cancelled and optional vouchers are listed and marked and left out of the totals; post-dated vouchers are marked and counted | day book | | | | |
| REP-038 | A voucher cancelled without lines is listed once with its number, "(cancelled, no lines)", no side and no amount | day book | Needs a seeded company with voids | | | |
| REP-039 | The day book shows 200 vouchers a page; Next and Previous pages work; the summary line names the vouchers shown ("Vouchers 1 to 200; more on the next page.") and the totals cover the whole period | day book, `limit` and `after` | A period of more than 200 vouchers (the larger demo companies) | | | |
| REP-040 | Enter on a day book row opens the voucher view | day book | | | | |
| REP-041 | The ledger screen lists ledgers with their group; typing filters by name or second-language name; Enter opens the highlighted ledger's monthly summary | `/reports/ledger` | There is no export on this screen | | | |
| REP-042 | The ledger monthly summary shows the opening balance, then debit, credit and closing for each calendar month | `/reports/ledger-monthly?ledger=`, `GET .../reports/ledger-monthly/<ledger>` | An income or expense ledger opens at zero in a period after the books begin | | | |
| REP-043 | A monthly summary longer than one financial year is clipped to the year of its start, and the screen says so | monthly summary | | | | |
| REP-044 | Enter on a month opens that month's ledger vouchers | monthly summary | | | | |
| REP-045 | Ledger vouchers lists one row per voucher touching the ledger: date, particulars, type, number, debit, credit and running balance, with opening, totals and closing | `/reports/ledger-vouchers?ledger=`, `GET .../reports/ledger-vouchers/<ledger>` | | | | |
| REP-046 | Ledger vouchers pages like the day book and the running balance continues across pages | ledger vouchers | A ledger with more than 200 vouchers | | | |
| REP-047 | Enter on a ledger voucher row opens the voucher view | ledger vouchers | | | | |
| REP-048 | The voucher view is read-only: date, type and number, status marks, narration, lines with debit and credit and totals; it has no period and no export | `/reports/voucher?voucher=` | A cancelled and a deleted voucher show their marks; Escape returns to the screen it came from | | | |
| REP-049 | The cost category summary lists each category with its top-level centres (sub-centres rolled into their top-most centre) with opening, debit, credit and closing | `/reports/cost-category-summary`, `GET .../reports/cost-category-summary` | Menu letter `Y` | | | |
| REP-050 | Enter on a centre of the summary opens its break-up | cost category summary | | | | |
| REP-051 | Opened without a centre, the cost centre break-up lists the centres; typing narrows and Enter opens the highlighted one | `/reports/cost-centre-breakup` | Menu letter `U` | | | |
| REP-052 | The break-up shows one centre: its sub-centres, then the ledgers of its own rows, and the total | `/reports/cost-centre-breakup?centre=`, `GET .../reports/cost-centre-breakup/<centre>` | | | | |
| REP-053 | In the break-up, Enter on a sub-centre opens its break-up and on a ledger opens that ledger's vouchers with the notice "Not filtered by cost centre" | cost centre break-up | The ledger's totals are the ledger's, not the centre's | | | |
| REP-054 | With cost centres switched off both cost reports show the masters screen's notice and still show saved amounts | both cost reports | Company with the feature off | | | |
| REP-055 | The cost reports export CSV | both cost reports | | | | |
| REP-056 | The cost category summary can be limited to one category | `GET .../reports/cost-category-summary?categoryId=` | API only, no screen for the filter | | | |
| REP-057 | The report defaults: last voucher date, default statement period, day book day, books-beginning date | `GET .../reports/defaults` | API only (the screens call it) | | | |
| REP-058 | An unknown or repeated query parameter, a start after the end, and a group or ledger id that names nothing are refused (400, 400, 404) | report routes | API only | | | |
| REP-059 | The trial balance as a verification read: ledger rows, the opening stock beside them when there is one, and totals that count it | `GET .../trial-balance?from=&to=` | API only | | | |
| REP-060 | Bills receivable or payable by party, as at a date, with paging and a first-page total | `GET .../reports/bills-outstanding?side=&asOf=` | API only, no screen; `side` receivable or payable, optional `groupId`, `limit`, `after` | | | |
| REP-061 | One party's bills on either side, with on-account and balance | `GET .../reports/party-bills/<ledger>?asOf=` | API only, no screen | | | |
| REP-062 | One bill's rows with the running pending | `GET .../reports/bill/<bill>?asOf=` | API only, no screen | | | |
| REP-063 | Ageing of bills per party in the company's columns, by bill date or due date | `GET .../reports/ageing?side=&asOf=&basis=` | API only, no screen; none until columns are set | | | |
| REP-064 | CSV export of each bill report | `.../reports/bills-outstanding/export`, `ageing/export`, `party-bills/<ledger>/export`, `bill/<bill>/export` | API only; same limit as other exports | | | |
| REP-065 | Read and replace the ageing columns | `GET`, `POST .../ageing-buckets` | API only; editors and above write; columns must be contiguous from 0 and only the last open-ended | | | |
| REP-066 | A party's pending bills for entry, and its credit-days check at a date | `GET .../ledgers/<ledger>/bills`, `.../credit-check?date=` | API only, no screen | | | |

## Keyboard shell and commands (KEY)

All 59 commands of the registry (`src/lib/commands.ts`), each with its keys in both keymaps (`src/lib/keymaps.ts`, [KEYBOARD.md](KEYBOARD.md)), followed by the rules that apply across screens. A command is tested in each context where it is registered; the contexts are Everywhere (every signed-in page), Company menu (only while a company menu has focus), Lists, Entry screens (the master forms; voucher entry is not on this commit) and Reports. A key that a browser or operating system takes before the page sees it is recorded as blocked, with the browser. The action bar above each page lists the enabled commands as buttons; a button and its key do the same.

| id | feature | where | roles and negatives to try | status | evidence | notes |
|---|---|---|---|---|---|---|
| KEY-001 | Open the keyboard help: every command with its keys in the active keymap, grouped by context | `help.keyboard`; classic `F1` or `Ctrl+/`; web-safe `Ctrl+/` | From a company page, a form field, the account page; inside another dialog `F1` opens it too | | | |
| KEY-002 | Go back one level (to the company menu from a company page; one drill level on a report) | `nav.back`; both keymaps `Escape` | A text field, select, combobox, open list, dialog or popover keeps Escape for itself; at the company menu nothing happens | | | |
| KEY-003 | Leave this screen at once, also from inside a text field | `nav.quit`; classic `Ctrl+Q`; web-safe none | At the company menu nothing happens; Firefox on Linux quits before the page sees it | | | |
| KEY-004 | Change company: open the company list | `company.switch`; classic `F3`; web-safe `Alt+K` | From a field; not while another dialog is open | | | |
| KEY-005 | Go to a screen: a list of masters, vouchers and reports opened by letter or Enter; Escape on the opened screen comes back | `nav.go-to`; both keymaps `Alt+G` | On a report the list is its own and carries the period | | | |
| KEY-006 | Switch to a screen: replaces the current one; Escape there ends at the company menu | `nav.switch-to`; classic `Ctrl+G`; web-safe none | Web-safe: the key does nothing special | | | |
| KEY-007 | Company menu: highlight the next item | `menu.next`; both `ArrowDown` | Menu must have focus | | | |
| KEY-008 | Company menu: highlight the previous item | `menu.previous`; both `ArrowUp` | | | | |
| KEY-009 | Company menu: highlight the first item | `menu.first`; both `Home` | | | | |
| KEY-010 | Company menu: highlight the last item | `menu.last`; both `End` | | | | |
| KEY-011 | Company menu: open the highlighted item | `menu.open`; both `Enter` | | | | |
| KEY-012 | Company menu letter: new master | `home.new-master`; both `C` | Viewer: hidden, no effect | | | |
| KEY-013 | Company menu letter: change a master | `home.edit-master`; both `A` | Viewer: hidden, no effect | | | |
| KEY-014 | Company menu letter: chart of accounts | `home.chart-of-accounts`; both `H` | | | | |
| KEY-015 | Company menu letter: vouchers (opens the "not built yet" page) | `home.vouchers`; both `V` | | | | |
| KEY-016 | Company menu letter: day book | `home.day-book`; both `K` | | | | |
| KEY-017 | Company menu letter: balance sheet | `home.balance-sheet`; both `B` | | | | |
| KEY-018 | Company menu letter: profit and loss | `home.profit-and-loss`; both `P` | | | | |
| KEY-019 | Company menu letter: trial balance | `home.trial-balance`; both `T` | | | | |
| KEY-020 | Company menu letter: ledger | `home.ledger`; both `L` | | | | |
| KEY-021 | Company menu letter: cost categories and centres | `home.cost-centres`; both `E` | | | | |
| KEY-022 | Menu letter: group summary (in the reports list and go-to lists) | `report.open.group-summary`; both `G` | Not on the company home menu | | | |
| KEY-023 | Menu letter: cost category summary | `report.open.cost-category-summary`; both `Y` | | | | |
| KEY-024 | Menu letter: cost centre break-up | `report.open.cost-centre-breakup`; both `U` | | | | |
| KEY-025 | List: highlight the next row | `list.next`; both `ArrowDown` | Chart, cost list, change list | | | |
| KEY-026 | List: highlight the previous row | `list.previous`; both `ArrowUp` | | | | |
| KEY-027 | List: highlight the first row | `list.first`; both `Home` | In the change list's search field Home keeps moving the caret | | | |
| KEY-028 | List: highlight the last row | `list.last`; both `End` | | | | |
| KEY-029 | List: open the highlighted row for change | `list.open`; both `Enter` | | | | |
| KEY-030 | List: create | `list.create`; both `Alt+C` | Viewer: off | | | |
| KEY-031 | List: delete the selected item (asks first) | `list.delete`; classic `Alt+D`; web-safe `Alt+X` | Built-in row, a row in use, viewer: off | | | |
| KEY-032 | List: history of the selected item | `list.history`; classic `Alt+H`; web-safe `Alt+Y` | | | | |
| KEY-033 | List: clear the filter, then go back | `list.cancel`; both `Escape` | On the change list; `Ctrl+Q` leaves at once in classic | | | |
| KEY-034 | List: move the selected cost centre | `list.move`; both `Alt+Q` | Only on a centre row; viewer off | | | |
| KEY-035 | List: switch cost centres on or off | `list.switch`; both `Alt+N` | Owner, admin only; editor, viewer off | | | |
| KEY-036 | Entry: save the whole form from anywhere, including inside a field | `entry.accept`; classic `Ctrl+A` or `Ctrl+Enter`; web-safe `Ctrl+Enter` | Web-safe `Ctrl+A` selects the field's text; viewer off | | | |
| KEY-037 | Entry: leave without saving (asks first when something was typed) | `entry.cancel`; classic `Escape` or `Ctrl+Q`; web-safe `Escape` | Save panel: Escape closes it and returns to the last field | | | |
| KEY-038 | Entry: next field | `entry.next-field`; both `Enter` | Fixed field order; Enter on the last field opens the Save panel | | | |
| KEY-039 | Entry: create a master from inside a lookup | `entry.create-master`; both `Alt+C` | Registered switched off on every entry screen; the key does nothing | | | |
| KEY-040 | Entry: delete this entry (asks first) | `entry.delete`; classic `Alt+D`; web-safe `Alt+X` | Create form, built-in, in use, viewer: off | | | |
| KEY-041 | Entry: history of this entry | `entry.history`; classic `Alt+H`; web-safe `Alt+Y` | Create form: off | | | |
| KEY-042 | Entry: switch to a contra voucher | `entry.voucher.contra`; classic `F4`; web-safe `Alt+O` | Not on this commit: no screen registers it | | | |
| KEY-043 | Entry: switch to a payment voucher | `entry.voucher.payment`; classic `F5`; web-safe `Alt+P` | Not on this commit | | | |
| KEY-044 | Entry: switch to a receipt voucher | `entry.voucher.receipt`; classic `F6`; web-safe `Alt+I` | Not on this commit | | | |
| KEY-045 | Entry: switch to a journal voucher | `entry.voucher.journal`; classic `F7`; web-safe `Alt+J` | Not on this commit | | | |
| KEY-046 | Entry: switch to a sales voucher | `entry.voucher.sales`; classic `F8`; web-safe `Alt+L` | Not on this commit | | | |
| KEY-047 | Entry: switch to a purchase voucher | `entry.voucher.purchase`; classic `F9`; web-safe `Alt+U` | Not on this commit | | | |
| KEY-048 | Report: highlight the next line | `report.next`; both `ArrowDown` | On the last line of a register the next page opens | | | |
| KEY-049 | Report: highlight the previous line | `report.previous`; both `ArrowUp` | | | | |
| KEY-050 | Report: move one page (ten lines) down | `report.page-down`; both `PageDown` | On a register, past the last line it turns the page, once per press | | | |
| KEY-051 | Report: move one page up | `report.page-up`; both `PageUp` | | | | |
| KEY-052 | Report: highlight the first line | `report.first`; both `Home` | | | | |
| KEY-053 | Report: highlight the last line | `report.last`; both `End` | | | | |
| KEY-054 | Report: open the highlighted line (drill down) | `report.drill`; both `Enter` | A line with nothing to open does nothing | | | |
| KEY-055 | Report: change the period (the date on the balance sheet) | `report.period`; classic `F2`; web-safe `Alt+P` | In the dialog Enter or classic `Ctrl+A` applies, Escape or `Ctrl+Q` closes | | | |
| KEY-056 | Report: show more or less detail | `report.detail`; classic `Alt+F5`; web-safe `Alt+M` | Only on trial balance, profit and loss, balance sheet | | | |
| KEY-057 | Report: show or hide lines without amounts | `report.zero-lines`; both `Alt+N` | Only on the three statements and the group summary | | | |
| KEY-058 | Report: export as CSV | `report.export`; classic `Ctrl+E`; web-safe `Alt+O` | Only where the report exports | | | |
| KEY-059 | Report: print | `report.print`; classic `Ctrl+P`; web-safe `Alt+I` | | | | |
| KEY-060 | Menu letters work only while a company menu has focus: the same letters typed in a field, list or form do nothing | company home, go-to lists | Type `C` in a form's Name field | | | |
| KEY-061 | A menu letter also works by key position when the keyboard layout types another script there | company home | An Arabic layout: the key where a Latin layout has `T` opens the trial balance; AZERTY goes by the letter it types | | | |
| KEY-062 | A text field, select, combobox or open list keeps Escape; a dialog closes on it | forms, dialogs | Entry cancel and the list's cancel are the exceptions and work from inside their fields | | | |
| KEY-063 | Go to stacks and switch to replaces: after go-to, Escape returns to the screen it came from; after switch-to it lands on the company menu; go-tos nest and unwind one Escape each | any screen | Classic only for switch-to | | | |
| KEY-064 | A go-to to the screen already shown opens it in place without stacking | any report | | | | |
| KEY-065 | After a reload the go-to return and the drill trail are gone: Escape falls back to the logical parent | any report | | | | |
| KEY-066 | The action bar lists only commands that are enabled and apply now, once each, one per key (on an entry screen Escape reads "Leave without saving") | every page | Viewer: write commands absent | | | |
| KEY-067 | Classic keeps a disabled command's key from the browser (for example `Alt+D` on a built-in row does nothing) | lists, forms | Web-safe leaves the browser key alone | | | |
| KEY-068 | Classic keeps the habit chords from the browser application-wide (`Ctrl+P`, `Ctrl+D`, `Ctrl+H`, `Ctrl+E`, `Ctrl+B`, `Ctrl+J`, `Ctrl+L`, `Ctrl+U`, `Ctrl+R`, `F5`, `F10`, `F12`, `Alt+D` and the browser's menu letters) and its reserved keys, doing nothing; web-safe claims no key | any page | Press `F5`: no reload in classic | | | |
| KEY-069 | Copy and edit chords are never taken (`Ctrl+C`, `Ctrl+X`, `Ctrl+V`, `Ctrl+Z`, `Ctrl+Y`, `Ctrl+Shift+Z`), nor `Ctrl+F` | lists, reports, fields, dialogs | Copy figures out of a report and the period dialog | | | |
| KEY-070 | `Ctrl+A` selects all where nothing accepts, and accepts only on entry screens and in a dialog that applies something | report, list, menu, forms | | | | |
| KEY-071 | Every dialog closes on `Ctrl+Q` (classic), opens help on `F1`, and claims the other classic keys | help, go-to, company list, period, confirmations | | | | |
| KEY-072 | Every confirmation opens with focus on its cancel button, so Enter keeps things as they are | delete questions, switch off, discard changes | | | | |
| KEY-073 | The Save panel answers only to a fresh key press: Enter, `Y` and `N` held down do nothing; `Y` saves and `N` keeps editing in classic | forms | Hold Enter through the last field | | | |
| KEY-074 | A lookup with its list open keeps Enter for picking a row; the accept chord picks the highlighted row (or settles the typed text) and then saves once | forms | Classic and web-safe accept chords | | | |
| KEY-075 | Changing the keymap on the account page changes the keys, the help and the action bar at once, without a reload | `/app/account` | Switch and press a key of each | | | |
| KEY-076 | Keys unavailable to a web page (`Ctrl+N`, `Ctrl+T`, `Ctrl+W`, `F11`) are not bound | all pages | They keep their browser action | | | |
| KEY-077 | Keys the browser or system takes before the page (`F1`, `F3`, `F5`, `F6`, `Ctrl+D`, `Ctrl+E`, `Ctrl+G`, `Ctrl+P`, `Ctrl+Q`; `F-keys` on macOS without Fn) | classic keymap | Record per browser which key reached the page | | | |
| KEY-078 | The company menu is announced as a menu with its letters in `aria-keyshortcuts` and a badge saying whether letters are live; buttons carry their keys in `aria-keyshortcuts` | company home, action bar | Screen reader | | | |

## Stock masters (STK): API only, no screen

Units, stock groups, stock categories, locations and stock items with opening stock, and the company inventory switch. Routes are under `/api/companies/<company>/`. Every route runs as the signed-in person: viewers read, owners, admins and editors write, an outsider is answered "not found". Quantities and rates are decimal strings, never numbers.

| id | feature | where | roles and negatives to try | status | evidence | notes |
|---|---|---|---|---|---|---|
| STK-001 | Read the inventory switch | `GET inventory-setting` | Any member | | | |
| STK-002 | Switch inventory on or off | `POST inventory-setting` | Owner, admin; editor and viewer answered "not found"; off is refused (`in_use`) while stock items exist | | | |
| STK-003 | Creating an item while inventory is off is refused (409 `feature_off`) | `POST stock-items` | Other stock masters may be created while off | | | |
| STK-004 | List units, with an in-use flag | `GET stock-units` | Any member | | | |
| STK-005 | Create a unit: symbol, formal name, decimals 0 to 4 | `POST stock-units` | Owner, admin, editor; decimals 5 refused | | | |
| STK-006 | Read one unit | `GET stock-units/<id>` | An id of another company: 404 | | | |
| STK-007 | Change a unit (with its revision) | `POST stock-units/<id>` | Stale revision refused; decimals lowered below what an opening row uses refused | | | |
| STK-008 | Delete a unit | `POST stock-units/<id>/delete` | A unit with items is refused (`in_use`) | | | |
| STK-009 | History of a unit | `GET stock-units/<id>/revisions` | | | | |
| STK-010 | List stock groups | `GET stock-groups` | | | | |
| STK-011 | Create a stock group: name, second-language name, parent, add quantities | `POST stock-groups` | A duplicate name under the name match key refused | | | |
| STK-012 | Read one stock group | `GET stock-groups/<id>` | | | | |
| STK-013 | Change a stock group; moving it under its own sub-group is refused | `POST stock-groups/<id>` | Stale revision; cycle | | | |
| STK-014 | Delete a stock group | `POST stock-groups/<id>/delete` | One holding items or sub-groups is refused | | | |
| STK-015 | History of a stock group | `GET stock-groups/<id>/revisions` | | | | |
| STK-016 | List stock categories | `GET stock-categories` | | | | |
| STK-017 | Create a stock category | `POST stock-categories` | Duplicate name refused | | | |
| STK-018 | Read one stock category | `GET stock-categories/<id>` | | | | |
| STK-019 | Change a stock category | `POST stock-categories/<id>` | Stale revision; cycle | | | |
| STK-020 | Delete a stock category | `POST stock-categories/<id>/delete` | One with items or sub-categories is refused | | | |
| STK-021 | History of a stock category | `GET stock-categories/<id>/revisions` | | | | |
| STK-022 | List locations (the seeded main location carries `systemKey: main`) | `GET stock-locations` | | | | |
| STK-023 | Create a location | `POST stock-locations` | Duplicate name refused | | | |
| STK-024 | Read one location | `GET stock-locations/<id>` | | | | |
| STK-025 | Change a location; the main location may be renamed | `POST stock-locations/<id>` | Stale revision | | | |
| STK-026 | Delete a location | `POST stock-locations/<id>/delete` | The main location, one with opening rows or sub-locations: refused | | | |
| STK-027 | History of a location | `GET stock-locations/<id>/revisions` | | | | |
| STK-028 | List stock items, each with its openings and opening value | `GET stock-items` | | | | |
| STK-029 | Create an item: name, group, category, unit, standard selling rate | `POST stock-items` | Duplicate name refused; an item may share a name with a group, category, location or ledger | | | |
| STK-030 | Create an item with opening stock given as quantity and rate; the value is quantity times rate rounded to the currency | `POST stock-items` (`openings`) | Quantity with more places than the unit refused; one row per location | | | |
| STK-031 | Create an item with opening stock given as quantity and value; the rate is derived | `POST stock-items` (`openings`) | A value whose rate is out of range refused | | | |
| STK-032 | Read one item | `GET stock-items/<id>` | | | | |
| STK-033 | Change an item; `openings` replaces the rows as a set, left out keeps them | `POST stock-items/<id>` | Stale revision; unit change refused while opening rows exist | | | |
| STK-034 | Opening stock rows are refused while the books are locked through the books-beginning date | `POST stock-items` | `locked_period`; re-sending the same rows is no change | | | |
| STK-035 | Delete an item | `POST stock-items/<id>/delete` | Refused while locked, when it has opening rows | | | |
| STK-036 | History of an item, with its opening rows | `GET stock-items/<id>/revisions` | | | | |
| STK-037 | A company with opening stock shows opening stock on the trial balance, profit and loss and balance sheet | reports | See REP-028 and REP-032 | | | |
| STK-038 | A viewer's write on any stock route, and any call by an outsider, answer "not found" | stock routes | Viewer, outsider | | | |

## Currencies and rates (CUR): API only, no screen

Company currencies, dated exchange rates and a currency on each ledger. Nothing changes for vouchers: a line in another currency is refused.

| id | feature | where | roles and negatives to try | status | evidence | notes |
|---|---|---|---|---|---|---|
| CUR-001 | List currencies, with `isBase` and `inUse`; the base row is seeded | `GET currencies` | Any member | | | |
| CUR-002 | Create a currency: code, symbol, formal name, ISO code, decimals (0, 2 or 3) and the presentation fields | `POST currencies` | Owner, admin, editor; decimals 1 or 4 refused | | | |
| CUR-003 | A symbol or code that clashes with another currency's symbol or code, under the name match key, is refused | `POST currencies` | `duplicate_name`; a symbol of ignored characters only refused | | | |
| CUR-004 | Read one currency (the code in the path is matched without case) | `GET currencies/<code>` | An unknown code | | | |
| CUR-005 | Change a currency (not its code); an omitted field keeps its value, null clears the ISO code or decimal word | `POST currencies/<code>` | Stale revision; the base row's code and decimals cannot change | | | |
| CUR-006 | Change decimals or delete a currency a ledger names | `POST currencies/<code>`, `.../delete` | Refused (`in_use`) | | | |
| CUR-007 | Delete an unused foreign currency; its rate rows go with it | `POST currencies/<code>/delete` | The base row is refused (`seeded_row`); refused when a rate row is on or before the locked-through date | | | |
| CUR-008 | History of a currency | `GET currencies/<code>/revisions` | | | | |
| CUR-009 | List every rate row of a currency, by kind and date | `GET currencies/<code>/rates` | | | | |
| CUR-010 | Read the rates in force on a date: standard, selling and buying for each foreign currency | `GET exchange-rates?date=` | Latest row on or before the date; none before the first | | | |
| CUR-011 | Write rates for a date: a value writes the row, null removes it, an omitted kind is left alone | `POST exchange-rates` | More than 4 decimals, zero or negative refused; resending the same value writes nothing | | | |
| CUR-012 | Writing rates on or before the last voucher date answers a `rates_move_reports` warning | `POST exchange-rates` | | | | |
| CUR-013 | Writing, changing or removing a rate dated on or before the locked-through date is refused | `POST exchange-rates` | `locked_period` | | | |
| CUR-014 | Create a ledger in a foreign currency: not bill-wise, no cost centres, no opening balance, not under income or expense | `POST ledgers` (`currency`) | Each of those combinations refused | | | |
| CUR-015 | A ledger's currency changes only while it has no lines, opening, bill rows or cost rows | `POST ledgers/<id>` | `in_use` | | | |
| CUR-016 | A viewer's write on any currency route, and any call by an outsider, answer "not found" | currency routes | Viewer, outsider | | | |

## Voucher entry (VCH)

The voucher entry screen is **not on this commit**: the Vouchers section opens a "not built yet" page (CMP-036). What exists is the HTTP API that posts and reads vouchers and the three reads the screen will use. The rows below marked "API only, no screen" can be tested now. The rows marked "not on this commit" are the screen's planned features, taken from [LEDGER.md](LEDGER.md) ("Voucher entry reads", "Posting rules", "Numbering"), [ROADMAP.md](ROADMAP.md) and [KEYBOARD.md](KEYBOARD.md); they list what the screen is planned to do and are not tested until it is merged. Routes are under `/api/companies/<company>/`.

| id | feature | where | roles and negatives to try | status | evidence | notes |
|---|---|---|---|---|---|---|
| VCH-001 | List vouchers of a period, by date then entry order, with `limit` (1 to 500) and `after` paging | `GET vouchers?from=&to=` | API only, no screen; all roles | | | |
| VCH-002 | Post a regular voucher (two or more lines, debits equal credits, a request key) in each of the eight types | `POST vouchers` | API only, no screen; owner, admin, editor; viewer answered "not found" | | | |
| VCH-003 | Posting the same request key and body again returns the first voucher (200, `replayed: true`); the same key with another body is refused (409 `idempotency_mismatch`) | `POST vouchers` | API only | | | |
| VCH-004 | A voucher with one line, unequal debits and credits, a zero amount or more than 500 lines is refused | `POST vouchers` | API only; `unbalanced`, `validation` | | | |
| VCH-005 | A contra with a line that is not a cash or bank ledger, a payment that credits no cash or bank ledger, and a receipt that debits none are refused (`posting_rule`) | `POST vouchers` | API only | | | |
| VCH-006 | A date before the books begin, or on or before the locked-through date, is refused | `POST vouchers` | API only; `before_books_beginning`, `locked_period` | | | |
| VCH-007 | Post an optional voucher: it takes no number and has no effect on any report | `POST vouchers` | API only | | | |
| VCH-008 | Post a post-dated voucher: it is numbered at entry and counts from its own date | `POST vouchers` | API only | | | |
| VCH-009 | Post a voucher cancelled without lines (a void): it takes the next number of its type and has no effect; lines sent with it are refused | `POST vouchers` (`status: cancelled`) | API only; shows in the day book | | | |
| VCH-010 | Numbers run per voucher type and financial year, in entry order; a date in the next year starts that year at 1 | `POST vouchers` | API only | | | |
| VCH-011 | Read one voucher (cancelled and deleted ones too) | `GET vouchers/<id>` | API only; an id of another company: 404 | | | |
| VCH-012 | Change a voucher: the whole body, the revision and optionally another voucher type (it takes that type's next number) | `POST vouchers/<id>` | API only; stale revision, a cancelled voucher, a date in the locked period refused | | | |
| VCH-013 | Cancel a voucher: it keeps its number and has no effect | `POST vouchers/<id>/cancel` | API only; cancelled vouchers cannot be made regular again | | | |
| VCH-014 | Delete a voucher (soft): its number stays a gap and its lines still count as "in use" for ledgers | `POST vouchers/<id>/delete` | API only | | | |
| VCH-015 | History of a voucher | `GET vouchers/<id>/revisions` | API only | | | |
| VCH-016 | A voucher line may carry bill rows (new reference, advance, against reference, on account); the answer carries warnings such as `bill_attached` or `bill_over_settled` | `POST vouchers` (`lines[].bills`) | API only; rows on a ledger that is not bill-wise are dropped with `bills_ignored` | | | |
| VCH-017 | A voucher line may carry cost allocation rows; each category used on a line nets to the line amount; the answer may warn `cost_ignored`, `cost_kept`, `cost_rebalanced` or `cost_dropped` | `POST vouchers` (`lines[].costAllocations`) | API only; `allocation_total` when rows do not net to the line | | | |
| VCH-018 | The expected next number of a voucher type on a date (a preview: nothing is reserved) | `GET voucher-types/<type>/next-number?date=` | API only, no screen; equals the number then issued unless another voucher takes it first | | | |
| VCH-019 | The resulting balance of each ledger of a draft, with the stored lines of a named voucher left out; the draft may be unbalanced | `POST vouchers/balance-preview` | API only, no screen; a read, so viewers may call it; at most 500 lines | | | |
| VCH-020 | The counter ledger a new line proposes after a ledger on a side | `GET ledgers/<ledger>/counter-ledger?voucherTypeId=&side=` | API only, no screen; null when the ledger has no earlier voucher | | | |
| VCH-021 | More than 600 voucher writes a minute by one user are refused | voucher routes | API only | | | |
| VCH-022 | The voucher entry screen for payment, receipt, contra and journal: create | Vouchers section | Not on this commit | | | |
| VCH-023 | The voucher entry screen for sales, purchase, credit note and debit note | Vouchers section | Not on this commit; later slices | | | |
| VCH-024 | Entry shows the expected next number of the type and date, marked as expected | Vouchers section | Not on this commit | | | |
| VCH-025 | Entry shows each ledger's resulting balance as lines are entered | Vouchers section | Not on this commit | | | |
| VCH-026 | A new double-entry line proposes the counter ledger of the ledger's latest voucher; single entry proposes nothing | Vouchers section | Not on this commit | | | |
| VCH-027 | Switch voucher type from the keyboard (contra, payment, receipt, journal, sales, purchase) | `entry.voucher.*` | Not on this commit; see KEY-042 to KEY-047 | | | |
| VCH-028 | Journal entry hides cash and bank ledgers until asked | Vouchers section | Not on this commit | | | |
| VCH-029 | The entry screen enforces its own date bound | Vouchers section | Not on this commit | | | |
| VCH-030 | The bill panel: pending bills to settle, new reference names, credit periods, and a warning when a sales voucher starts for a party past its credit days | Vouchers section | Not on this commit | | | |
| VCH-031 | Cost allocation on a line, prefilled from the ledger's latest centre, when the company has cost centres on | Vouchers section | Not on this commit | | | |
| VCH-032 | Narration, reference, reference date, post-dated and optional marks | Vouchers section | Not on this commit | | | |
| VCH-033 | Change, cancel, delete and history of a voucher from the screen; save and leave keys; the leave guard | Vouchers section | Not on this commit | | | |
| VCH-034 | Open a voucher for change from a report row (the voucher view is read-only today) | reports | Not on this commit | | | |

## Health, limits and operations (OPS)

Health endpoints, the worker, startup, email, rate limits, request protection, error answers, and the demo tools a tester will use. Rate-limit rows count requests in one minute unless a window is stated; the answer past the limit is 429 with a plain "Too many requests" or "Too many attempts" message.

| id | feature | where | roles and negatives to try | status | evidence | notes |
|---|---|---|---|---|---|---|
| OPS-001 | The liveness probe answers `{ status: alive }` without touching the database | `GET /api/health/live` | Signed out | | | |
| OPS-002 | The readiness probe answers `{ status: ready }` once the schema is current and the database roles are right | `GET /api/health/ready` | Signed out; with the database stopped it answers 503 "The installation is not ready" | | | |
| OPS-003 | The status probe says whether the installation is claimed, naming no one | `GET /api/status` | Signed out | | | |
| OPS-004 | The session read says whether setup is required and, when signed in, who the person is | `GET /api/session` | Signed out: `user` null | | | |
| OPS-005 | The signed-in read lists the person's companies with role and a two-factor lock flag, and whether they are the instance operator | `GET /api/me` | Signed out: 401 | | | |
| OPS-006 | The web service reports healthy through the readiness probe in the container healthcheck | `docker compose ps` | Stop the database: unhealthy | | | |
| OPS-007 | The worker writes a heartbeat about every 10 seconds | worker, `worker_heartbeat` | Stop the worker: the row stops advancing | | | |
| OPS-008 | The worker's diagnose check passes while the heartbeat is newer than 30 seconds, and fails (exit 1) without one | `node src/server/cli.ts diagnose worker` | Run with the worker running and stopped | | | |
| OPS-009 | The diagnose check without `worker` checks configuration, database, schema and the application role, and prints no secrets | `node src/server/cli.ts diagnose` | Exit code 1 when anything is unavailable | | | |
| OPS-010 | A graceful stop of the worker removes its heartbeat row | worker, `SIGTERM` | | | | |
| OPS-011 | The migrate service applies pending migrations once and exits; web and worker start after it and wait for a current schema | `docker compose up` | A second run says migrations are already applied | | | |
| OPS-012 | A failed migration is rolled back whole and the message names a PostgreSQL error code, no SQL or credentials | `node src/server/cli.ts migrate` | | | | |
| OPS-013 | The server refuses to serve as a database role that would make row-level security inert | web start, readiness | Wrong role: 503 | | | |
| OPS-014 | The setup command writes a private `.env` with fresh credentials and refuses to overwrite one | `node src/server/cli.ts setup` | Run it twice | | | |
| OPS-015 | A command with unknown or extra arguments prints the usage line | `node src/server/cli.ts ...` | | | | |
| OPS-016 | With email disabled, password recovery says it is not configured and invitations say to share the link | email transport `disabled` | See ACC-020, TEM-005 | | | |
| OPS-017 | With a mail server configured, invitation and recovery emails are sent once each, with no automatic retry and no copy of the message in logs | email transport `smtp` | A failing server: the person sees "could not be sent" and nothing is retried | | | |
| OPS-018 | The invitation email and the recovery email carry the fixed wording and link only | the emails | Needs a mail catcher | | | |
| OPS-019 | Sign-in limit: 5 a minute per email, 60 per client (15 when the client address is unknown) | `POST /api/auth/sign-in/email` | | | | |
| OPS-020 | Second-factor limit: 10 a minute per challenge, 60 per client | verify-totp, verify-backup-code | | | | |
| OPS-021 | Setup limit: 10 in 15 minutes per client (2 when unknown) | `POST /api/auth/setup` | | | | |
| OPS-022 | Recovery limits: request 3 per email and 20 per client; reset 5 per code and 60 per client | recovery routes | | | | |
| OPS-023 | Public invitation limits: 60 per client, 10 per code | `/api/invitations/...` | | | | |
| OPS-024 | Invitation email limits: 3 per address and 20 in all; resend 3 an hour per invitation and 20 an hour per company | team routes | | | | |
| OPS-025 | Team writes 60, master writes 120, voucher writes 600, company creations 20, report exports 20 (per user) | their routes | | | | |
| OPS-026 | Keymap reads 120 and writes 30; preferences reads 120 and writes 30; account security reads 120 and writes 30 (per user) | account routes | | | | |
| OPS-027 | Per-client limits use the client address only from a trusted proxy header; an untrusted forwarding header is ignored | any limited route | With `TRUSTED_PROXIES` set and unset | | | |
| OPS-028 | A state-changing request must come from the application's own origin (a missing Origin is refused too) | every `POST` and `PUT` | 403 "must originate from the application" | | | |
| OPS-029 | Pages are served with a content security policy using a per-response nonce (no inline script allowance), no referrer, no framing, and nosniff | any page of the production build | View the response headers | | | |
| OPS-030 | API answers are marked no-store and nosniff | any `/api/...` | | | | |
| OPS-031 | An unknown API path answers 404 "Route unavailable."; a wrong method answers 405 with an Allow header | `/api/...` | | | | |
| OPS-032 | A duplicate key anywhere answers 409 "This item already exists in the company."; an unexpected failure answers a generic 500 with no internal detail | API | | | | |
| OPS-033 | Signed-in sessions are listed and can be revoked (ACC-049 to ACC-052) | `/app/account` | | | | |
| OPS-034 | The containers run as an unprivileged user with a read-only filesystem and no extra privileges; the database port is bound to loopback only | `compose.yaml` | | | | |
| OPS-035 | Seed the demo companies for a user: creates each company, its masters, cost masters and vouchers through the ledger module, and prints a summary; refuses without `--yes` | `pnpm seed:demo -- --owner <email> [--company <slug> or --all] --yes` | The owner must already exist; a rerun says "already present, nothing changed" | | | |
| OPS-036 | Seed masters only, so vouchers can be entered by hand against the same masters; a later full seed adds the vouchers | `pnpm seed:demo -- ... --masters-only --yes` | A rerun changes nothing | | | |
| OPS-037 | Seed a separately named masters-only copy of a dataset's company for the same owner | `pnpm seed:demo -- ... --masters-only --as "<name>" --yes` | `--as` without `--masters-only` is refused; a second name is another copy | | | |
| OPS-038 | The seed summary lists what it skipped and the warnings the ledger raised, naming file and key on a stop | `pnpm seed:demo` | Mistyped slug; a missing owner | | | |
| OPS-039 | Compare a seeded company with the figures its dataset expects, in three groups (match, differs, not yet comparable) | `pnpm demo:compare -- --owner <email> [--company <slug> or --all]` | Exit code 1 when any comparable line differs; 0 otherwise | | | |
| OPS-040 | The five demo datasets are present: starter-trading, gulfline, najd, harbourview, sunrise | `demo/` | | | | |

## In source, entry point not found

Features that exist in the source with no screen, key or route that reaches them on this commit. They are listed so the walk does not count them as missed; a tester records only whether pressing the key or looking for the screen changes anything.

| id | in source | file | what was looked for |
|---|---|---|---|
| NF-001 | Six commands to switch the voucher type on an entry screen: `entry.voucher.contra`, `.payment`, `.receipt`, `.journal`, `.sales`, `.purchase` (classic `F4` to `F9`, web-safe `Alt+O`, `Alt+P`, `Alt+I`, `Alt+J`, `Alt+L`, `Alt+U`) | `src/lib/commands.ts`, `src/lib/keymaps.ts` | No screen registers them: the voucher entry screen is not merged. They appear in the keyboard help under Entry screens (KEY-042 to KEY-047) |
| NF-002 | `entry.create-master` (create a master from inside a lookup, `Alt+C`) | `src/components/masters/entry.tsx` | It is registered on every master form and switched off, so the key does nothing (KEY-039) |

## Defects

Every failed row gets an entry here with its row id, what was done, what was expected and what happened, in plain words, so that someone can repeat it. Nothing is listed before the walk.

## Critique

Judgements that are not failures of a row: confusing wording, a screen that is hard to use by keyboard, missing feedback, anything a careful user would stumble on. Each entry names the row or screen it is about.

## Missing dependencies

Anything the walk needed and did not have: a mail catcher, a second browser engine, a screen reader, an authenticator app, a company with more than 200 vouchers, the clock moved. Each entry names the rows it blocked.

## Not tested and why

Every row left without a status, with the reason (blocked by a missing dependency, out of time, cannot be tried on this build). A row may not be left empty without an entry here.
