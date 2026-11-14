-- A workspace is one company (D-03 as amended 2026-11-14): company.company_id becomes the workspace id and references
-- workspace, and every accounting table follows through its composite keys. Until now a company was a project of a
-- workspace. Existing rows are converted, not dropped:
--   - in each workspace the first company (one with books before one without, then oldest) keeps the workspace: its
--     books take the workspace id and the workspace takes the company's name (one name from now on);
--   - every further company becomes a workspace of its own, with its project id as the workspace id, the company's
--     name, the same members and roles and the same two-factor requirement; its books keep their id and move intact;
--   - a workspace without a company stays as it is: a company that is not set up yet;
--   - pending invitations stay with the workspace they were sent for (the company that kept its id).
-- Project rows meant companies under the old model, so none of them is an accounting project: they are removed with
-- the company-project link. The project table stays, dormant, for accounting projects (M2). The migration also adds
-- company_creation, the idempotency keys of "create company" requests.
-- Row-level security policies, FORCE, ownership and the grants on accounting tables are untouched; the application role
-- loses its privileges on project and gets SELECT and INSERT on company_creation. Safe on an empty database: every step
-- is set-based or loops over catalog rows that exist either way.

-- The migrator owns the accounting tables, but FORCE applies their policy to it as well, so this transaction lists
-- every project and workspace id. Transaction-local; cleared again at the end.
SELECT set_config('app.company_ids', coalesce((SELECT string_agg(id, ',') FROM (SELECT id FROM project UNION SELECT id FROM workspace) ids), ''), true);

-- Where each company's books go. Dropped at the end of this migration.
CREATE TABLE company_move AS
SELECT p.id AS old_id, p.workspace_id AS from_workspace, p.name, p.created_at,
  CASE WHEN row_number() OVER (PARTITION BY p.workspace_id ORDER BY (c.company_id IS NOT NULL) DESC, p.created_at, p.id) = 1
    THEN p.workspace_id ELSE p.id END AS new_id
FROM project p LEFT JOIN company c ON c.company_id = p.id;

INSERT INTO workspace (id, name, created_at)
SELECT new_id, name, created_at FROM company_move WHERE new_id <> from_workspace;
INSERT INTO membership (workspace_id, user_id, role)
SELECT m.new_id, ms.user_id, ms.role FROM company_move m JOIN membership ms ON ms.workspace_id = m.from_workspace WHERE m.new_id <> m.from_workspace;
INSERT INTO workspace_two_factor_requirement (workspace_id)
SELECT m.new_id FROM company_move m JOIN workspace_two_factor_requirement r ON r.workspace_id = m.from_workspace WHERE m.new_id <> m.from_workspace;
UPDATE workspace w SET name = m.name FROM company_move m WHERE m.new_id = m.from_workspace AND w.id = m.new_id;

-- Rewrites company_id where it changes. The composite foreign keys are not ON UPDATE CASCADE and the guard triggers
-- refuse a changed company or counter, so: record every foreign key on or to an accounting table, drop them, rewrite
-- each table with its own triggers off (the migrator owns the tables; internal constraint triggers are not affected),
-- then add every key back by its recorded name and definition, which validates all rows again. The key from company to
-- project is not added back; company references workspace instead.
DO $$
DECLARE
  accounting text[] := ARRAY['company', 'account_group', 'ledger', 'voucher_type', 'voucher_counter', 'voucher', 'voucher_line', 'revision_log'];
  key_tables text[];
  key_names text[];
  key_definitions text[];
  key_targets regclass[];
  t text;
BEGIN
  SELECT coalesce(array_agg(c.conrelid::regclass::text ORDER BY c.conrelid::regclass::text, c.conname), '{}'),
         coalesce(array_agg(c.conname::text ORDER BY c.conrelid::regclass::text, c.conname), '{}'),
         coalesce(array_agg(pg_get_constraintdef(c.oid) ORDER BY c.conrelid::regclass::text, c.conname), '{}'),
         coalesce(array_agg(c.confrelid::regclass ORDER BY c.conrelid::regclass::text, c.conname), '{}')
    INTO key_tables, key_names, key_definitions, key_targets
  FROM pg_constraint c
  WHERE c.contype = 'f' AND (c.conrelid::regclass::text = ANY (accounting) OR c.confrelid::regclass::text = ANY (accounting));

  FOR i IN 1 .. coalesce(array_length(key_names, 1), 0) LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', key_tables[i], key_names[i]);
  END LOOP;

  FOREACH t IN ARRAY accounting LOOP
    EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER', t);
    EXECUTE format('UPDATE %I x SET company_id = m.new_id FROM company_move m WHERE x.company_id = m.old_id AND m.new_id <> m.old_id', t);
    EXECUTE format('ALTER TABLE %I ENABLE TRIGGER USER', t);
  END LOOP;

  FOR i IN 1 .. coalesce(array_length(key_names, 1), 0) LOOP
    CONTINUE WHEN key_targets[i] = 'project'::regclass;
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', key_tables[i], key_names[i], key_definitions[i]);
  END LOOP;
END $$;

-- Deleting a workspace removes its company and books, as deleting the project did. Like before, that cascade runs the
-- ledger guards, so it has to run inside the company's scope.
ALTER TABLE company ADD CONSTRAINT company_company_id_fkey FOREIGN KEY (company_id) REFERENCES workspace(id) ON DELETE CASCADE;

DELETE FROM project;
DROP TABLE company_move;
SELECT set_config('app.company_ids', '', true);

-- The project table is dormant until accounting projects (M2), which add a company_id and forced row-level security to
-- it; until then the application role may not touch it.
REVOKE ALL ON project FROM books_app;

-- Idempotency keys of "create company" requests, per user: a repeated request with the same key and body returns the
-- company the first one created. It holds ids only (no company data), like membership, so it stays outside row-level
-- security; the application reads and adds rows, and removing the user or the workspace removes them.
CREATE TABLE company_creation (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,100}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  company_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)
);
GRANT SELECT, INSERT ON company_creation TO books_app;
