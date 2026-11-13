-- Identity, workspaces, companies (projects), limits and worker health. Adopted from ten98-discover's foundation
-- schema and @ten98/runtime workspace-team.sql; see THIRD_PARTY_NOTICES.md.
-- Run by the migrator role (books_migrator), which owns every table here. The application role (books_app) is granted
-- only the statements web and worker issue; it owns nothing in this schema (D-03).
CREATE TABLE installation (id text PRIMARY KEY CHECK (id = 'instance'), claimed boolean NOT NULL DEFAULT false);
INSERT INTO installation(id) VALUES ('instance');

CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, "emailVerified" boolean NOT NULL DEFAULT false,
  image text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "twoFactorEnabled" boolean NOT NULL DEFAULT false, closed_at timestamptz);
CREATE UNIQUE INDEX user_email_normalized_idx ON "user" (lower(email));
CREATE TABLE session (id text PRIMARY KEY, token text NOT NULL UNIQUE, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text, "userAgent" text);
CREATE INDEX session_user_active_idx ON session("userId", "expiresAt");
CREATE TABLE account (id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, scope text,
  password text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("providerId", "accountId"));
CREATE INDEX account_user_idx ON account("userId");
CREATE TABLE verification (id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX verification_identifier_idx ON verification(identifier);
CREATE TABLE "rateLimit" (id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL, "lastRequest" bigint NOT NULL);
CREATE TABLE "twoFactor" (id text PRIMARY KEY, "userId" text NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
  secret text NOT NULL, "backupCodes" text NOT NULL, verified boolean NOT NULL DEFAULT false,
  "failedVerificationCount" integer NOT NULL DEFAULT 0, "lockedUntil" timestamptz);
CREATE TABLE user_preference (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 80 AND time_zone ~ '^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+.-]+)+)$'),
  locale text NOT NULL CHECK (locale IN ('en-US', 'en-GB', 'ar-SA')),
  theme text NOT NULL CHECK (theme IN ('light', 'dark', 'system')),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE workspace (id text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE membership (workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')), PRIMARY KEY (workspace_id, user_id));
CREATE INDEX membership_user_idx ON membership(user_id);
CREATE TABLE workspace_invitation (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  inviter_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email)),
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);
CREATE TABLE workspace_two_factor_requirement (workspace_id text PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE);
CREATE TABLE instance_operator (user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE, source text NOT NULL CHECK (source IN ('bootstrap', 'host')),
  granted_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE instance_operator_audit (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('bootstrap', 'grant', 'revoke', 'paid_work_export', 'email_suppression_clear')), scope text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instance_operator_audit_scope_check CHECK ((action = 'paid_work_export') = (scope IS NOT NULL)
    AND (scope IS NULL OR scope ~ '^workspace:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(/website:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$')));

-- A project is shown to users as a company: one set of books (D-03).
CREATE TABLE project (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (workspace_id, id));
CREATE INDEX project_workspace_idx ON project(workspace_id);

CREATE TABLE request_limit (key text NOT NULL, minute bigint NOT NULL, count integer NOT NULL, PRIMARY KEY (key, minute));
CREATE INDEX request_limit_minute_idx ON request_limit(minute);
CREATE TABLE worker_heartbeat (id text PRIMARY KEY, last_seen_at timestamptz NOT NULL);

GRANT SELECT ON schema_version TO books_app;
GRANT SELECT, UPDATE ON installation TO books_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "user", session, account, verification, "rateLimit", "twoFactor", user_preference,
  workspace, membership, workspace_invitation, workspace_two_factor_requirement, instance_operator, project, request_limit, worker_heartbeat TO books_app;
GRANT SELECT, INSERT ON instance_operator_audit TO books_app;

-- pg-boss keeps its job tables in this schema and runs its own DDL there, so the application role owns it. It holds no
-- company data and stays outside row-level security (D-03). The migrator must be a member of books_app to create it.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION books_app;
