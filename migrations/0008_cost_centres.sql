-- M2a slice 2: cost categories and cost centres. A voucher line on a ledger with cost centres may be split, per cost
-- category, over centres; each category used on a line adds up to the line exactly (observed: the entry screen
-- rebalances its last row, import refuses a mismatch). Each allocation row keeps the category it was saved with; the
-- cost reports group by each centre's category as it is today (observed after a centre moved). Every new table carries
-- company_id, joins through composite keys that include it and forces the one company policy.

-- ---- Company and ledger settings ----

-- Cost centres are a company feature, off by default; a ledger says whether its lines take cost centres (new income and
-- expense ledgers do by default). The profit and loss ledger, the only ledger outside every group, never does.
ALTER TABLE company ADD COLUMN cost_centres_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE ledger ADD COLUMN cost_centres boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT ledger_cost_centres_group CHECK (NOT cost_centres OR group_id IS NOT NULL);

-- ---- Masters ----

CREATE TABLE cost_category (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  system_key text CHECK (system_key IN ('primary')),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120),
  second_language_name text CHECK (second_language_name IS NULL OR (second_language_name = btrim(second_language_name) AND length(second_language_name) BETWEEN 1 AND 120)),
  -- Stored, not enforced (observed: a category with non-revenue No took an allocation from a fixed-asset line).
  allocate_revenue boolean NOT NULL DEFAULT true,
  allocate_non_revenue boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, system_key)
);
CREATE UNIQUE INDEX cost_category_name_idx ON cost_category (company_id, lower(name));

CREATE TABLE cost_centre (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  category_id uuid NOT NULL,
  -- "Under": no key ties a centre's category to its parent's, because a used centre may move to another category and
  -- leave its sub-centres where they are (observed).
  parent_id uuid,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120),
  second_language_name text CHECK (second_language_name IS NULL OR (second_language_name = btrim(second_language_name) AND length(second_language_name) BETWEEN 1 AND 120)),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, category_id) REFERENCES cost_category (company_id, id),
  FOREIGN KEY (company_id, parent_id) REFERENCES cost_centre (company_id, id),
  CONSTRAINT cost_centre_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);
-- Centre names are unique across all categories of a company (observed).
CREATE UNIQUE INDEX cost_centre_name_idx ON cost_centre (company_id, lower(name));
CREATE INDEX cost_centre_parent_idx ON cost_centre (company_id, parent_id);
CREATE INDEX cost_centre_category_idx ON cost_centre (company_id, category_id);

-- ---- Allocations ----

-- One row of a line's cost allocation: the line's ledger, the category as saved, the centre, a side (the row that
-- absorbs a difference may go to the other side) and a base amount. Never updated: written and removed with its line.
CREATE TABLE cost_allocation (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  voucher_id uuid NOT NULL,
  line_no smallint NOT NULL,
  ledger_id uuid NOT NULL,
  category_id uuid NOT NULL,
  cost_centre_id uuid NOT NULL,
  side text NOT NULL CHECK (side IN ('Dr', 'Cr')),
  amount bigint NOT NULL CHECK (amount > 0),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, voucher_id, line_no) REFERENCES voucher_line (company_id, voucher_id, line_no) ON DELETE CASCADE,
  FOREIGN KEY (company_id, ledger_id) REFERENCES ledger (company_id, id),
  FOREIGN KEY (company_id, category_id) REFERENCES cost_category (company_id, id),
  FOREIGN KEY (company_id, cost_centre_id) REFERENCES cost_centre (company_id, id)
);
-- A centre once per line and stored category (observed: a duplicate is refused); also the per-line check's index.
CREATE UNIQUE INDEX cost_allocation_line_idx ON cost_allocation (company_id, voucher_id, line_no, category_id, cost_centre_id);
CREATE INDEX cost_allocation_centre_idx ON cost_allocation (company_id, cost_centre_id) INCLUDE (side, amount, voucher_id, ledger_id);
-- The last-used centre of a ledger (most recently entered row) and the reads by ledger.
CREATE INDEX cost_allocation_ledger_idx ON cost_allocation (company_id, ledger_id, id DESC);

-- ---- Guards ----

-- Centre moves serialise per company, as group moves do, so two opposite moves cannot each pass the cycle check.
CREATE FUNCTION cost_centre_tree_lock(p_company text) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cost_centre_tree:' || p_company, 0));
END $$;

CREATE FUNCTION cost_centre_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ledger_assert_scope(OLD.company_id);
    RETURN OLD;
  END IF;
  PERFORM ledger_assert_scope(NEW.company_id);
  IF NEW.parent_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
    -- The walk must see moves committed while this transaction waited for the lock.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'cost centres are moved in READ COMMITTED transactions only' USING ERRCODE = '25001', CONSTRAINT = 'cost_centre_cycle';
    END IF;
    PERFORM cost_centre_tree_lock(NEW.company_id);
    IF EXISTS (
      WITH RECURSIVE up(id) AS (
        SELECT NEW.parent_id
        UNION SELECT c.parent_id FROM cost_centre c JOIN up ON c.company_id = NEW.company_id AND c.id = up.id WHERE c.parent_id IS NOT NULL)
      SELECT 1 FROM up WHERE id = NEW.id) THEN
      RAISE EXCEPTION 'a cost centre cannot sit under its own sub-centre' USING ERRCODE = '23514', CONSTRAINT = 'cost_centre_cycle';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cost_centre_guard BEFORE INSERT OR UPDATE OR DELETE ON cost_centre FOR EACH ROW EXECUTE FUNCTION cost_centre_guard();

-- The seeded category stays (it can be renamed); a category or centre in use is kept by the foreign keys.
CREATE FUNCTION cost_category_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ledger_assert_scope(OLD.company_id);
    IF OLD.system_key IS NOT NULL AND EXISTS (SELECT 1 FROM company WHERE company_id = OLD.company_id) THEN
      RAISE EXCEPTION 'the seeded cost category cannot be deleted' USING ERRCODE = '23514', CONSTRAINT = 'cost_category_builtin';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM ledger_assert_scope(NEW.company_id);
  IF TG_OP = 'UPDATE' AND NEW.system_key IS DISTINCT FROM OLD.system_key THEN
    RAISE EXCEPTION 'a cost category keeps its system key' USING ERRCODE = '23514', CONSTRAINT = 'cost_category_builtin';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cost_category_guard BEFORE INSERT OR UPDATE OR DELETE ON cost_category FOR EACH ROW EXECUTE FUNCTION cost_category_guard();

-- Allocation rows: frozen with a cancelled or deleted voucher; a row matches its line's ledger, which is never the
-- profit and loss ledger. Whether the ledger has cost centres on now is the posting rule's concern (rows posted while
-- it had may be kept after it is switched off).
CREATE FUNCTION cost_allocation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_row cost_allocation;
  v_voucher voucher;
  v_line voucher_line;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
  PERFORM ledger_assert_scope(v_row.company_id);
  -- A row removed with its whole company has no record left to protect.
  IF NOT EXISTS (SELECT 1 FROM company WHERE company_id = v_row.company_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'cost allocation outside its company' USING ERRCODE = '23514', CONSTRAINT = 'cost_allocation_line';
  END IF;
  SELECT * INTO v_voucher FROM voucher WHERE company_id = v_row.company_id AND id = v_row.voucher_id;
  IF v_voucher.status = 'cancelled' OR v_voucher.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'cost allocations of a cancelled or deleted voucher cannot change' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lines_frozen';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_line FROM voucher_line WHERE company_id = NEW.company_id AND voucher_id = NEW.voucher_id AND line_no = NEW.line_no;
    IF NOT FOUND OR v_line.ledger_id <> NEW.ledger_id
      OR (SELECT group_id FROM ledger WHERE company_id = NEW.company_id AND id = NEW.ledger_id) IS NULL THEN
      RAISE EXCEPTION 'a cost allocation matches its line''s ledger, never the profit and loss ledger' USING ERRCODE = '23514', CONSTRAINT = 'cost_allocation_line';
    END IF;
  END IF;
  RETURN v_row;
END $$;
CREATE TRIGGER cost_allocation_guard BEFORE INSERT OR DELETE ON cost_allocation FOR EACH ROW EXECUTE FUNCTION cost_allocation_guard();

-- Each stored category used on a line nets, towards the line's side, to exactly the line amount. Checked at commit for
-- every inserted or deleted row, on that row's line only, through cost_allocation_line_idx: lines are never updated, a
-- line's rows go with it, and rows are never updated, so this check is complete. voucher_assert_balanced is untouched.
CREATE FUNCTION cost_allocation_assert_line() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_row cost_allocation;
  v_line voucher_line;
  v_category uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
  PERFORM ledger_assert_scope(v_row.company_id);
  SELECT * INTO v_line FROM voucher_line WHERE company_id = v_row.company_id AND voucher_id = v_row.voucher_id AND line_no = v_row.line_no;
  -- The line is gone, and its rows with it (an alter replaced it, or the company was removed): nothing left to check.
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- The company is a group, not a filter: with `company_id = ...` in WHERE and no statistics yet (a new table), the
  -- planner reads every row of the company through the primary key for each check. Grouped, the line index is the
  -- only good path; a row of another company in scope with the same voucher id can only make the check refuse.
  SELECT category_id INTO v_category FROM cost_allocation
  WHERE voucher_id = v_row.voucher_id AND line_no = v_row.line_no
  GROUP BY company_id, category_id
  HAVING company_id <> v_row.company_id OR sum(CASE side WHEN v_line.side THEN amount ELSE -amount END) <> v_line.amount
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'the cost allocations of line % of voucher % do not add up to the line', v_line.line_no, v_line.voucher_id USING ERRCODE = '23514', CONSTRAINT = 'cost_allocation_total';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cost_allocation_balanced AFTER INSERT OR DELETE ON cost_allocation DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cost_allocation_assert_line();

-- ---- Revision log, row-level security and grants ----

ALTER TABLE revision_log DROP CONSTRAINT revision_log_entity_check;
ALTER TABLE revision_log ADD CONSTRAINT revision_log_entity_check CHECK (entity IN ('group', 'ledger', 'voucher_type', 'voucher', 'cost_category', 'cost_centre'));

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['cost_category', 'cost_centre', 'cost_allocation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format($policy$CREATE POLICY %I ON %I
      USING (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')))
      WITH CHECK (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')))$policy$, table_name || '_company_scope', table_name);
  END LOOP;
END $$;

-- Column grants extend the earlier ones. Allocation rows are written and removed with their line, never updated.
GRANT UPDATE (cost_centres_enabled) ON company TO books_app;
GRANT UPDATE (cost_centres) ON ledger TO books_app;
GRANT SELECT, INSERT, DELETE, UPDATE (name, second_language_name, allocate_revenue, allocate_non_revenue, revision) ON cost_category TO books_app;
GRANT SELECT, INSERT, DELETE, UPDATE (category_id, parent_id, name, second_language_name, revision) ON cost_centre TO books_app;
GRANT SELECT, INSERT, DELETE ON cost_allocation TO books_app;
REVOKE ALL ON FUNCTION cost_centre_tree_lock(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cost_centre_tree_lock(text) TO books_app;

-- ---- Seeding (D-10) ----

-- The one seeding routine gains the general cost category; everything else is as in 0004.
CREATE OR REPLACE FUNCTION ledger_seed_company(p_company text) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
  INSERT INTO cost_category (company_id, system_key, name, allocate_revenue, allocate_non_revenue)
  VALUES (p_company, 'primary', 'General', true, true)
  ON CONFLICT (company_id, system_key) DO NOTHING;
END $$;

-- ---- Existing companies ----

-- Every company gets the general category; existing income and expense ledgers take cost centres, as new ones do (the
-- company feature stays off until an owner switches it on, so nothing changes in their books). Each flipped ledger is
-- logged as an alter by the migration, with snapshots in the shape the API returns. The migrator owns the tables but
-- FORCE applies the policy to it too, so the scope lists every workspace (a company's id is its workspace's) for this
-- transaction only; the deferred checks run before the scope is cleared.
DO $$
DECLARE company_row record;
BEGIN
  PERFORM set_config('app.company_ids', coalesce((SELECT string_agg(id, ',') FROM workspace), ''), true);
  FOR company_row IN SELECT company_id FROM company LOOP
    PERFORM ledger_seed_company(company_row.company_id);
  END LOOP;
  WITH flipped AS (
    UPDATE ledger l SET cost_centres = true, revision = l.revision + 1
    FROM account_group g
    WHERE g.company_id = l.company_id AND g.id = l.group_id AND g.nature IN ('income', 'expense') AND NOT l.cost_centres
    RETURNING l.*)
  INSERT INTO revision_log (company_id, entity, entity_id, action, actor_id, before, after)
  SELECT f.company_id, 'ledger', f.id, 'alter', 'migration:0008_cost_centres',
    s.snapshot || jsonb_build_object('costCentres', false, 'revision', f.revision - 1),
    s.snapshot || jsonb_build_object('costCentres', true, 'revision', f.revision)
  FROM flipped f JOIN account_group g ON g.company_id = f.company_id AND g.id = f.group_id
    CROSS JOIN LATERAL (SELECT jsonb_build_object('id', f.id, 'groupId', f.group_id, 'groupName', g.name, 'nature', g.nature,
      'systemKey', f.system_key, 'name', f.name, 'secondLanguageName', f.second_language_name, 'cashOrBank', false,
      'opening', jsonb_build_object('amount', f.opening_amount::text, 'side', f.opening_side), 'billWise', f.bill_wise,
      'creditPeriod', CASE WHEN f.credit_count IS NOT NULL THEN jsonb_build_object('count', f.credit_count, 'unit', f.credit_unit)
        WHEN f.credit_due_date IS NOT NULL THEN jsonb_build_object('dueDate', to_char(f.credit_due_date, 'YYYY-MM-DD')) END,
      'creditDaysCheck', f.credit_days_check,
      'openingBills', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', a.kind, 'billId', a.bill_id, 'billName', b.name,
          'billDate', to_char(a.bill_date, 'YYYY-MM-DD'), 'dueDate', to_char(a.due_date, 'YYYY-MM-DD'), 'amount', a.amount::text, 'side', a.side,
          'creditPeriod', CASE WHEN a.credit_count IS NOT NULL THEN jsonb_build_object('count', a.credit_count, 'unit', a.credit_unit) END) ORDER BY a.id)
        FROM bill_allocation a LEFT JOIN bill b ON b.company_id = a.company_id AND b.id = a.bill_id
        WHERE a.company_id = f.company_id AND a.ledger_id = f.id AND a.voucher_id IS NULL), '[]'::jsonb)) AS snapshot) s;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM set_config('app.company_ids', '', true);
END $$;
