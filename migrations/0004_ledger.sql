-- M1 ledger core (D-03, D-04, D-07, D-09, D-10): account groups, ledgers, voucher types, numbering counters, vouchers,
-- voucher lines and the append-only revision log. Every table carries company_id, joins its neighbours through composite
-- foreign keys that include it, and forces the one canonical company policy, so the application role (books_app) sees
-- and writes only the companies listed in the transaction's app.company_ids. Posting rules live in src/server/ledger;
-- the constraints and triggers here are the last line: an unbalanced voucher, a reused or changed number, a deleted
-- built-in master or a group cycle cannot be committed whatever the application does.

-- Groups form a tree per company. Nature and the gross-profit flag are stored on every group and must equal the
-- parent's (composite foreign key with ON UPDATE CASCADE), so a sub-tree always shares its primary group's nature and
-- moving a group to a parent of another nature carries its whole sub-tree with it.
CREATE TABLE account_group (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  parent_id uuid,
  nature text NOT NULL CHECK (nature IN ('asset', 'liability', 'income', 'expense')),
  -- Income and expense groups that count towards gross profit (trading lines) rather than only net profit.
  gross_profit boolean NOT NULL DEFAULT false,
  system_key text CHECK (system_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  second_language_name text CHECK (second_language_name IS NULL OR length(second_language_name) BETWEEN 1 AND 120),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, id, nature, gross_profit),
  UNIQUE (company_id, system_key),
  CHECK (NOT gross_profit OR nature IN ('income', 'expense')),
  CHECK (parent_id IS DISTINCT FROM id),
  FOREIGN KEY (company_id, parent_id, nature, gross_profit) REFERENCES account_group (company_id, id, nature, gross_profit) ON UPDATE CASCADE
);
CREATE UNIQUE INDEX account_group_name_idx ON account_group (company_id, lower(name));
CREATE INDEX account_group_parent_idx ON account_group (company_id, parent_id);

-- The profit and loss ledger is the one ledger outside every group; every other ledger has a group.
CREATE TABLE ledger (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  group_id uuid,
  system_key text CHECK (system_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  second_language_name text CHECK (second_language_name IS NULL OR length(second_language_name) BETWEEN 1 AND 120),
  -- Opening balance as of the company's books-beginning date, in base-currency minor units.
  opening_amount bigint NOT NULL DEFAULT 0 CHECK (opening_amount >= 0),
  opening_side text NOT NULL DEFAULT 'Dr' CHECK (opening_side IN ('Dr', 'Cr')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, system_key),
  FOREIGN KEY (company_id, group_id) REFERENCES account_group (company_id, id),
  CONSTRAINT ledger_group_required CHECK ((group_id IS NULL) = (system_key IS NOT DISTINCT FROM 'profit_and_loss'))
);
CREATE UNIQUE INDEX ledger_name_idx ON ledger (company_id, lower(name));
CREATE INDEX ledger_group_idx ON ledger (company_id, group_id);

-- kind selects the posting rules; M1 has exactly the eight accounting kinds, one seeded type each.
CREATE TABLE voucher_type (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  system_key text CHECK (system_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  kind text NOT NULL CHECK (kind IN ('contra', 'payment', 'receipt', 'journal', 'sales', 'purchase', 'credit_note', 'debit_note')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  second_language_name text CHECK (second_language_name IS NULL OR length(second_language_name) BETWEEN 1 AND 120),
  numbering_series text NOT NULL DEFAULT 'main' CHECK (numbering_series ~ '^[a-z0-9_-]{1,40}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, system_key)
);
CREATE UNIQUE INDEX voucher_type_name_idx ON voucher_type (company_id, lower(name));

-- One locked row per company, voucher type and series; last_number is the highest number ever issued, so a deleted
-- voucher leaves a permanent gap and nothing is renumbered (D-04).
CREATE TABLE voucher_counter (
  company_id text NOT NULL,
  voucher_type_id uuid NOT NULL,
  series text NOT NULL,
  last_number integer NOT NULL CHECK (last_number > 0),
  PRIMARY KEY (company_id, voucher_type_id, series),
  FOREIGN KEY (company_id, voucher_type_id) REFERENCES voucher_type (company_id, id) ON DELETE CASCADE
);

-- Vouchers are never physically deleted by the application (no DELETE grant): deletion sets deleted_at.
CREATE TABLE voucher (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  voucher_type_id uuid NOT NULL,
  series text NOT NULL,
  -- NULL only while optional; set once, from the counter, and never changed afterwards.
  number integer CHECK (number > 0),
  date date NOT NULL,
  narration text CHECK (narration IS NULL OR length(narration) <= 2000),
  status text NOT NULL DEFAULT 'regular' CHECK (status IN ('regular', 'cancelled', 'optional')),
  post_dated boolean NOT NULL DEFAULT false,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_by text,
  deleted_at timestamptz,
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, voucher_type_id) REFERENCES voucher_type (company_id, id),
  UNIQUE (company_id, voucher_type_id, series, number),
  UNIQUE (company_id, idempotency_key),
  CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);
CREATE INDEX voucher_date_idx ON voucher (company_id, date);

-- M1 posts in the base currency only (rate 1) and leaves tax columns empty (D-01); M2 and M3 drop the two named checks.
CREATE TABLE voucher_line (
  company_id text NOT NULL,
  voucher_id uuid NOT NULL,
  line_no smallint NOT NULL CHECK (line_no BETWEEN 1 AND 1000),
  ledger_id uuid NOT NULL,
  side text NOT NULL CHECK (side IN ('Dr', 'Cr')),
  amount bigint NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  currency_amount bigint NOT NULL CHECK (currency_amount > 0),
  fx_rate numeric(20, 10) NOT NULL CHECK (fx_rate > 0),
  tax_classification text,
  tax_rate numeric(9, 4),
  PRIMARY KEY (company_id, voucher_id, line_no),
  FOREIGN KEY (company_id, voucher_id) REFERENCES voucher (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, ledger_id) REFERENCES ledger (company_id, id),
  CONSTRAINT voucher_line_base_currency_only CHECK (fx_rate = 1 AND currency_amount = amount),
  CONSTRAINT voucher_line_no_tax_yet CHECK (tax_classification IS NULL AND tax_rate IS NULL)
);
CREATE INDEX voucher_line_ledger_idx ON voucher_line (company_id, ledger_id);

-- Append-only: the application role may insert and read, never update or delete (grants below).
CREATE TABLE revision_log (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  entity text NOT NULL CHECK (entity IN ('group', 'ledger', 'voucher_type', 'voucher')),
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'alter', 'cancel', 'delete')),
  actor_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  before jsonb,
  after jsonb,
  PRIMARY KEY (company_id, id),
  CHECK ((action = 'create') = (before IS NULL)),
  CHECK (action = 'delete' OR after IS NOT NULL)
);
CREATE INDEX revision_log_entity_idx ON revision_log (company_id, entity, entity_id, id);

-- Built-in rows (system_key set) cannot be deleted while their company exists, and keep their nature. Removal of the
-- whole company (cascade from project) is allowed: the company row is already gone when the cascade reaches here.
CREATE FUNCTION ledger_guard_builtin() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.system_key IS NOT NULL AND EXISTS (SELECT 1 FROM company WHERE company_id = OLD.company_id) THEN
      RAISE EXCEPTION 'built-in % cannot be deleted', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_builtin';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'account_group' THEN
    IF OLD.system_key IS NOT NULL AND NEW.nature <> OLD.nature THEN
      RAISE EXCEPTION 'built-in group keeps its nature' USING ERRCODE = '23514', CONSTRAINT = 'account_group_builtin';
    END IF;
    -- Walk up from the new parent: reaching this group would close a cycle.
    IF NEW.parent_id IS NOT NULL AND NEW.parent_id IS DISTINCT FROM OLD.parent_id AND EXISTS (
      WITH RECURSIVE up(id) AS (
        SELECT NEW.parent_id
        UNION SELECT g.parent_id FROM account_group g JOIN up ON g.company_id = NEW.company_id AND g.id = up.id WHERE g.parent_id IS NOT NULL)
      SELECT 1 FROM up WHERE id = NEW.id) THEN
      RAISE EXCEPTION 'group cannot sit under its own sub-group' USING ERRCODE = '23514', CONSTRAINT = 'account_group_cycle';
    END IF;
  ELSIF TG_TABLE_NAME = 'ledger' THEN
    IF OLD.system_key IS NOT NULL AND NEW.group_id IS DISTINCT FROM OLD.group_id AND (
      SELECT nature FROM account_group WHERE company_id = NEW.company_id AND id = NEW.group_id) IS DISTINCT FROM (
      SELECT nature FROM account_group WHERE company_id = OLD.company_id AND id = OLD.group_id) THEN
      RAISE EXCEPTION 'built-in ledger keeps its nature' USING ERRCODE = '23514', CONSTRAINT = 'ledger_builtin';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_group_guard BEFORE UPDATE OR DELETE ON account_group FOR EACH ROW EXECUTE FUNCTION ledger_guard_builtin();
CREATE TRIGGER ledger_guard BEFORE UPDATE OR DELETE ON ledger FOR EACH ROW EXECUTE FUNCTION ledger_guard_builtin();

-- Voucher lifecycle in the database: a number, once issued, never changes; a deleted voucher is frozen; a cancelled
-- voucher stays cancelled; a regular (numbered) voucher cannot become optional again.
CREATE FUNCTION voucher_guard_lifecycle() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'deleted voucher cannot change' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lifecycle';
  END IF;
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'voucher number cannot change' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lifecycle';
  END IF;
  IF (OLD.status = 'cancelled' AND NEW.status <> 'cancelled') OR (OLD.status <> 'optional' AND NEW.status = 'optional') THEN
    RAISE EXCEPTION 'voucher status cannot go back' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lifecycle';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voucher_guard BEFORE UPDATE ON voucher FOR EACH ROW EXECUTE FUNCTION voucher_guard_lifecycle();

-- Checked at commit for every voucher touched in the transaction, whatever its status: at least two lines, debits
-- equal credits, and a number exactly when the voucher is not optional. Deferred, so a posting may insert the header,
-- the lines and the number in any order inside one transaction.
CREATE FUNCTION voucher_assert_balanced() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_company text;
  v_voucher uuid;
  v_status text;
  v_number integer;
  v_lines integer;
  v_debit numeric;
  v_credit numeric;
BEGIN
  IF TG_TABLE_NAME = 'voucher' THEN v_company := NEW.company_id; v_voucher := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN v_company := OLD.company_id; v_voucher := OLD.voucher_id;
  ELSE v_company := NEW.company_id; v_voucher := NEW.voucher_id;
  END IF;
  SELECT status, number INTO v_status, v_number FROM voucher WHERE company_id = v_company AND id = v_voucher;
  IF NOT FOUND THEN
    -- Only a line removed together with its voucher (company removal) may find no voucher; never skip otherwise.
    IF TG_OP = 'DELETE' THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'voucher % is not visible to its own check', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_balanced';
  END IF;
  SELECT count(*), coalesce(sum(amount) FILTER (WHERE side = 'Dr'), 0), coalesce(sum(amount) FILTER (WHERE side = 'Cr'), 0)
    INTO v_lines, v_debit, v_credit FROM voucher_line WHERE company_id = v_company AND voucher_id = v_voucher;
  IF v_lines < 2 OR v_debit <> v_credit THEN
    RAISE EXCEPTION 'voucher % is not balanced', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_balanced';
  END IF;
  IF (v_status = 'optional') <> (v_number IS NULL) THEN
    RAISE EXCEPTION 'voucher % has no number', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_numbered';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER voucher_balanced AFTER INSERT OR UPDATE ON voucher DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION voucher_assert_balanced();
CREATE CONSTRAINT TRIGGER voucher_line_balanced AFTER INSERT OR UPDATE OR DELETE ON voucher_line DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION voucher_assert_balanced();

-- D-10: the one seeding routine, used by company creation (as books_app, inside withCompany) and by the backfill below.
-- Idempotent: rows already present by system_key are left as the user renamed or moved them.
CREATE FUNCTION ledger_seed_company(p_company text) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO account_group (company_id, system_key, name, nature, gross_profit)
  SELECT p_company, s.key, s.name, s.nature, s.gross FROM (VALUES
    ('branches', 'Branches and Divisions', 'liability', false),
    ('capital', 'Capital', 'liability', false),
    ('current_assets', 'Current Assets', 'asset', false),
    ('current_liabilities', 'Current Liabilities', 'liability', false),
    ('direct_expenses', 'Direct Expenses', 'expense', true),
    ('direct_income', 'Direct Income', 'income', true),
    ('fixed_assets', 'Fixed Assets', 'asset', false),
    ('indirect_expenses', 'Indirect Expenses', 'expense', false),
    ('indirect_income', 'Indirect Income', 'income', false),
    ('investments', 'Investments', 'asset', false),
    ('loans', 'Loans and Borrowings', 'liability', false),
    ('deferred_expenses', 'Deferred Expenses', 'asset', false),
    ('purchases', 'Purchases', 'expense', true),
    ('sales', 'Sales', 'income', true),
    ('suspense', 'Suspense', 'liability', false)
  ) AS s(key, name, nature, gross)
  ON CONFLICT (company_id, system_key) DO NOTHING;

  INSERT INTO account_group (company_id, system_key, name, parent_id, nature, gross_profit)
  SELECT p_company, s.key, s.name, p.id, p.nature, p.gross_profit FROM (VALUES
    ('reserves', 'Reserves and Surplus', 'capital'),
    ('bank_accounts', 'Bank Accounts', 'current_assets'),
    ('cash_in_hand', 'Cash on Hand', 'current_assets'),
    ('deposits_paid', 'Deposits Paid', 'current_assets'),
    ('advances_given', 'Loans and Advances Given', 'current_assets'),
    ('inventory', 'Inventory', 'current_assets'),
    ('receivables', 'Trade Receivables', 'current_assets'),
    ('duties_taxes', 'Taxes and Duties', 'current_liabilities'),
    ('provisions', 'Provisions', 'current_liabilities'),
    ('payables', 'Trade Payables', 'current_liabilities'),
    ('bank_overdraft', 'Bank Overdrafts', 'loans'),
    ('secured_loans', 'Secured Loans', 'loans'),
    ('unsecured_loans', 'Unsecured Loans', 'loans')
  ) AS s(key, name, parent_key)
  JOIN account_group p ON p.company_id = p_company AND p.system_key = s.parent_key
  ON CONFLICT (company_id, system_key) DO NOTHING;

  INSERT INTO ledger (company_id, system_key, name, group_id)
  SELECT p_company, 'cash', 'Cash', g.id FROM account_group g WHERE g.company_id = p_company AND g.system_key = 'cash_in_hand'
  ON CONFLICT (company_id, system_key) DO NOTHING;
  INSERT INTO ledger (company_id, system_key, name, group_id) VALUES (p_company, 'profit_and_loss', 'Profit and Loss', NULL)
  ON CONFLICT (company_id, system_key) DO NOTHING;

  INSERT INTO voucher_type (company_id, system_key, kind, name)
  SELECT p_company, s.kind, s.kind, s.name FROM (VALUES
    ('contra', 'Contra'), ('payment', 'Payment'), ('receipt', 'Receipt'), ('journal', 'Journal'),
    ('sales', 'Sales'), ('purchase', 'Purchase'), ('credit_note', 'Credit Note'), ('debit_note', 'Debit Note')
  ) AS s(kind, name)
  ON CONFLICT (company_id, system_key) DO NOTHING;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['account_group', 'ledger', 'voucher_type', 'voucher_counter', 'voucher', 'voucher_line', 'revision_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format($policy$CREATE POLICY %I ON %I
      USING (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')))
      WITH CHECK (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')))$policy$, table_name || '_company_scope', table_name);
  END LOOP;
END $$;

-- Least privilege for the application role. Column grants keep identities, kinds, series and audit columns fixed.
GRANT SELECT, INSERT, DELETE, UPDATE (parent_id, nature, gross_profit, name, second_language_name, revision) ON account_group TO books_app;
GRANT SELECT, INSERT, DELETE, UPDATE (group_id, name, second_language_name, opening_amount, opening_side, revision) ON ledger TO books_app;
GRANT SELECT, INSERT, UPDATE (name, second_language_name, revision) ON voucher_type TO books_app;
GRANT SELECT, INSERT, UPDATE ON voucher_counter TO books_app;
GRANT SELECT, INSERT, UPDATE (number, date, narration, status, post_dated, revision, updated_at, deleted_by, deleted_at) ON voucher TO books_app;
GRANT SELECT, INSERT, DELETE ON voucher_line TO books_app;
GRANT SELECT, INSERT ON revision_log TO books_app;
REVOKE ALL ON FUNCTION ledger_seed_company(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_seed_company(text) TO books_app;

-- Backfill: seed every company that existed before this migration. The migrator owns the tables but FORCE applies the
-- policy to it too, so the scope lists every project for this transaction only (company_id is the project id).
DO $$
DECLARE company_row record;
BEGIN
  PERFORM set_config('app.company_ids', coalesce((SELECT string_agg(id, ',') FROM project), ''), true);
  FOR company_row IN SELECT company_id FROM company LOOP
    PERFORM ledger_seed_company(company_row.company_id);
  END LOOP;
  PERFORM set_config('app.company_ids', '', true);
END $$;
