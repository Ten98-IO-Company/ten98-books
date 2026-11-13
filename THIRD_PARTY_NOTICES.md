# Source provenance

## Ten98 Discover foundation

The M0 foundation is adapted from [ten98-discover](https://github.com/Ten98-IO-Company/ten98-discover) at commit `175b8ddc05647df19e25c9e228454086d15fde3a` (branch `dev`, read on 2026-11-13), MIT licensed, copyright (c) 2026 Ten98 Technologies Ltd and contributors, the same holder and licence as this repository ([LICENSE](LICENSE)). Catalogue features adopted: first-user-bootstrap, local-signin-account-security, workspaces-projects-rbac-invitations, account-preferences and application-shell-auth-presentation ([feature catalogue](https://github.com/Ten98-IO-Company/ten98-code-system/blob/main/features/catalog.json)). Later fixes in those Discover paths are ported here by the ten98-books coordinator.

| This repository | Discover source | Adaptation |
| --- | --- | --- |
| `src/server/auth.ts`, `workspace-team.ts`, `teams.ts`, `validation.ts`, `resource-cleanup.ts`, `shutdown.ts` | same paths | Product name; own email lock key; OIDC adapters and analytics schemas removed. |
| `src/server/account-security.ts` | same path | OIDC bindings, account closure and operator step-up removed. |
| `src/server/client-rate-limit.ts` | same path, `src/server/analytics-network.ts` (peer read) | Analytics network modes removed; TRUSTED_PROXIES only. |
| `src/server/email.ts` | same path | SMTP transport only; suppression list removed. |
| `src/server/config.ts`, `db.ts`, `schema.ts`, `startup-migrate.ts`, `cli.ts`, `jobs.ts` | same paths | Two database roles, own advisory lock key, int8 and DATE parsers, role assertion; product commands, keyrings and queues removed. |
| `src/server/api.ts`, `src/server/api/*.ts` | `src/server/api.ts` | Foundation routes only, split into one module per area with a route table; company routes added. |
| `src/components/AccountPreferencesPanel.tsx`, `InvitePanel.tsx`, `PasswordRecoveryPanel.tsx`, `AccountSecurityPanel.tsx`, `TeamPanel.tsx` | same paths | Security and team panels re-expressed on the shared `@ten98/ui` flows; product wording. |
| `src/lib/api.ts`, `account-preferences.ts`, `account-presentation.tsx`, `auth-messages.ts`, `team-roles.ts`, `zod-browser.ts` | same paths | Own locale list; OIDC messages removed; fragment parsing reduced to invitations and password reset. |
| `src/routes/index.tsx`, `src/routes/app.tsx`, `src/router.tsx`, `src/routes/__root.tsx`, `src/routes/api/$.ts` | `src/routes/index.tsx`, `src/router.tsx`, `src/routes/__root.tsx`, `src/routes/api/$.ts` | Sign-in, setup and shell flows split into file routes. |
| `migrations/0001_foundation.sql` | `migrations/0001`, `0002`, `0004`, `0045`, `0068`, `0073`, `0075` and `@ten98/runtime` `workspace-team.sql` | One fresh sequence with grants to the application role; product tables removed. |
| `Dockerfile`, `compose.yaml`, `.env.example`, `.dockerignore`, `.github/workflows/foundation.yml` | same paths | Two roles, own project name and ports, product services removed. |
