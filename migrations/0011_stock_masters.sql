-- 0011: stock masters (M2b slice a). Units, stock groups, stock categories, locations and stock items, with opening
-- stock per item and location as of the books beginning, and the company's inventory switch. Item lines on vouchers and
-- valuation come later (0013 and slice c); until then the statements value stock at the opening rows. Every new table
-- carries company_id, joins through composite keys that include it and forces the one company policy. This migration
-- only adds: no existing row is checked or changed apart from the seeded main location of each company.

-- ---- Company setting ----

-- On for new companies (the reference workflow's default), off for existing ones: none holds items yet. Switching it
-- off while items exist is refused by the API only.
ALTER TABLE company ADD COLUMN inventory_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE company ALTER COLUMN inventory_enabled SET DEFAULT true;

-- ---- Masters ----

-- Names (and unit symbols) are unique per company within each kind under the name match key (0009, adopted for masters
-- in 0010); kinds are separate name spaces, so an item may share its name with a group, a location or a ledger
-- (observed). The key is stored, in plain-text order, so a list or lookup that seeks or orders by it compares a plain
-- column: under the forced row-level policy only leakproof comparisons become index conditions, and name_match_key is
-- not leakproof.
CREATE TABLE stock_unit (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  symbol text NOT NULL CHECK (symbol = btrim(symbol) AND length(symbol) BETWEEN 1 AND 40),
  symbol_key text COLLATE "C" GENERATED ALWAYS AS (name_match_key(symbol)) STORED,
  formal_name text CHECK (formal_name IS NULL OR (formal_name = btrim(formal_name) AND length(formal_name) BETWEEN 1 AND 120)),
  -- Quantity places: 0 by default, at most 4 (observed).
  decimals smallint NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 4),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE UNIQUE INDEX stock_unit_symbol_idx ON stock_unit (company_id, symbol_key);

CREATE TABLE stock_group (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  parent_id uuid,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120),
  name_key text COLLATE "C" GENERATED ALWAYS AS (name_match_key(name)) STORED,
  second_language_name text CHECK (second_language_name IS NULL OR (second_language_name = btrim(second_language_name) AND length(second_language_name) BETWEEN 1 AND 120)),
  -- Whether the group's reports add up its items' quantities (off by default, observed).
  add_quantities boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, parent_id) REFERENCES stock_group (company_id, id),
  CONSTRAINT stock_group_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX stock_group_name_idx ON stock_group (company_id, name_key);
CREATE INDEX stock_group_parent_idx ON stock_group (parent_id, company_id);

CREATE TABLE stock_category (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  parent_id uuid,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120),
  name_key text COLLATE "C" GENERATED ALWAYS AS (name_match_key(name)) STORED,
  second_language_name text CHECK (second_language_name IS NULL OR (second_language_name = btrim(second_language_name) AND length(second_language_name) BETWEEN 1 AND 120)),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, parent_id) REFERENCES stock_category (company_id, id),
  CONSTRAINT stock_category_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX stock_category_name_idx ON stock_category (company_id, name_key);
CREATE INDEX stock_category_parent_idx ON stock_category (parent_id, company_id);

-- One seeded location per company (system_key 'main'): it can be renamed, never deleted, so a default location always
-- exists (observed).
CREATE TABLE stock_location (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  system_key text CHECK (system_key IN ('main')),
  parent_id uuid,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120),
  name_key text COLLATE "C" GENERATED ALWAYS AS (name_match_key(name)) STORED,
  second_language_name text CHECK (second_language_name IS NULL OR (second_language_name = btrim(second_language_name) AND length(second_language_name) BETWEEN 1 AND 120)),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, system_key),
  FOREIGN KEY (company_id, parent_id) REFERENCES stock_location (company_id, id),
  CONSTRAINT stock_location_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX stock_location_name_idx ON stock_location (company_id, name_key);
CREATE INDEX stock_location_parent_idx ON stock_location (parent_id, company_id);

-- A group of null is the top level. The standard selling rate is one current figure (dated lists come later).
CREATE TABLE stock_item (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  group_id uuid,
  category_id uuid,
  unit_id uuid NOT NULL,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120),
  name_key text COLLATE "C" GENERATED ALWAYS AS (name_match_key(name)) STORED,
  second_language_name text CHECK (second_language_name IS NULL OR (second_language_name = btrim(second_language_name) AND length(second_language_name) BETWEEN 1 AND 120)),
  standard_selling_rate numeric(20, 6) CHECK (standard_selling_rate >= 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, group_id) REFERENCES stock_group (company_id, id),
  FOREIGN KEY (company_id, category_id) REFERENCES stock_category (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES stock_unit (company_id, id)
);
CREATE UNIQUE INDEX stock_item_name_idx ON stock_item (company_id, name_key);
-- The in-use reads, the foreign key checks of a delete and the unit guard below seek items by group, category or unit.
-- Each index leads with the column it seeks on: without table statistics every index that leads with company_id looks
-- alike to the planner (the lesson of 0008's cost_allocation_line_idx).
CREATE INDEX stock_item_group_idx ON stock_item (group_id, company_id);
CREATE INDEX stock_item_category_idx ON stock_item (category_id, company_id);
CREATE INDEX stock_item_unit_idx ON stock_item (unit_id, company_id);

-- Opening stock of an item at a location, as of the books beginning. The value is the stored truth: entered, or the
-- quantity times an entered rate rounded half-up to the currency; the rate is kept to 6 places for display and editing.
-- A zero value is opening stock at no cost. Rows are replaced as a set with their item, never updated.
CREATE TABLE stock_opening (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  location_id uuid NOT NULL,
  quantity numeric(20, 4) NOT NULL CHECK (quantity > 0),
  rate numeric(20, 6) NOT NULL CHECK (rate >= 0),
  value bigint NOT NULL CHECK (value >= 0),
  PRIMARY KEY (company_id, item_id, location_id),
  FOREIGN KEY (company_id, item_id) REFERENCES stock_item (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, location_id) REFERENCES stock_location (company_id, id)
);
-- Whether a location holds opening rows (its in-use read and its delete's foreign key check).
CREATE INDEX stock_opening_location_idx ON stock_opening (location_id, company_id);

-- ---- Guards (the database's second line; the API refuses the same first) ----

-- Moves in one company's tree of one kind serialise, as group moves do, so two opposite moves cannot each pass the
-- cycle check.
CREATE FUNCTION stock_tree_lock(p_table text, p_company text) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_table || ':' || p_company, 0));
END $$;

-- Shared by the three trees (groups, categories, locations): scope, cycle and, for locations, the seeded main row
-- (nested conditions: a record field is resolved even behind a false AND, and only locations have system_key).
CREATE FUNCTION stock_tree_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_cycle boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ledger_assert_scope(OLD.company_id);
    IF TG_TABLE_NAME = 'stock_location' THEN
      IF OLD.system_key IS NOT NULL AND EXISTS (SELECT 1 FROM company WHERE company_id = OLD.company_id) THEN
        RAISE EXCEPTION 'the main location can be renamed but not deleted' USING ERRCODE = '23514', CONSTRAINT = 'stock_location_builtin';
      END IF;
    END IF;
    RETURN OLD;
  END IF;
  PERFORM ledger_assert_scope(NEW.company_id);
  IF TG_TABLE_NAME = 'stock_location' AND TG_OP = 'UPDATE' THEN
    IF NEW.system_key IS DISTINCT FROM OLD.system_key THEN
      RAISE EXCEPTION 'a location keeps its system key' USING ERRCODE = '23514', CONSTRAINT = 'stock_location_builtin';
    END IF;
  END IF;
  IF NEW.parent_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
    -- The walk must see moves committed while this transaction waited for the lock.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'stock masters are moved in READ COMMITTED transactions only' USING ERRCODE = '25001', CONSTRAINT = TG_TABLE_NAME || '_cycle';
    END IF;
    PERFORM stock_tree_lock(TG_TABLE_NAME, NEW.company_id);
    EXECUTE format($walk$
      WITH RECURSIVE up(id) AS (
        SELECT $1
        UNION SELECT t.parent_id FROM %I t JOIN up ON t.company_id = $2 AND t.id = up.id WHERE t.parent_id IS NOT NULL)
      SELECT EXISTS (SELECT 1 FROM up WHERE id = $3)$walk$, TG_TABLE_NAME) INTO v_cycle USING NEW.parent_id, NEW.company_id, NEW.id;
    IF v_cycle THEN
      RAISE EXCEPTION 'a stock master cannot sit under its own sub-master' USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_cycle';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_group_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_group FOR EACH ROW EXECUTE FUNCTION stock_tree_guard();
CREATE TRIGGER stock_category_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_category FOR EACH ROW EXECUTE FUNCTION stock_tree_guard();
CREATE TRIGGER stock_location_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_location FOR EACH ROW EXECUTE FUNCTION stock_tree_guard();

-- A unit's decimals cannot be lowered while an opening row uses it (observed through export and import; item lines join
-- this rule in 0013). Raising them is allowed. An opening write in flight share-locks the unit (stock_opening_guard), so
-- the update waits for it to commit and this check, reading afresh, sees its rows.
CREATE FUNCTION stock_unit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM ledger_assert_scope(OLD.company_id); RETURN OLD; END IF;
  PERFORM ledger_assert_scope(NEW.company_id);
  IF TG_OP = 'UPDATE' AND NEW.decimals < OLD.decimals AND EXISTS (
    SELECT 1 FROM stock_item i JOIN stock_opening o ON o.company_id = i.company_id AND o.item_id = i.id
    WHERE i.unit_id = NEW.id AND i.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'the decimals of a unit in use cannot be lowered' USING ERRCODE = '23514', CONSTRAINT = 'stock_unit_decimals';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_unit_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_unit FOR EACH ROW EXECUTE FUNCTION stock_unit_guard();

-- An item's unit cannot change once it has opening rows (item lines join this rule in 0013). An opening write in flight
-- share-locks the item, so the update waits for it to commit and this check sees its rows.
CREATE FUNCTION stock_item_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM ledger_assert_scope(OLD.company_id); RETURN OLD; END IF;
  PERFORM ledger_assert_scope(NEW.company_id);
  IF TG_OP = 'UPDATE' AND NEW.unit_id <> OLD.unit_id
    AND EXISTS (SELECT 1 FROM stock_opening o WHERE o.company_id = NEW.company_id AND o.item_id = NEW.id) THEN
    RAISE EXCEPTION 'the unit of an item with stock cannot change' USING ERRCODE = '23514', CONSTRAINT = 'stock_item_unit_fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_item_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_item FOR EACH ROW EXECUTE FUNCTION stock_item_guard();

-- Opening rows follow the opening balances' lock, as opening bills do (0006): none is written or removed while the
-- locked-through date reaches the books beginning. An opening quantity carries no more places than its item's unit
-- allows, checked against the item and then the unit as share-locked here (the API's order: items, units, locations),
-- so a unit's decimals lowered, or an item's unit changed, in a transaction still open is waited for and its result checked.
CREATE FUNCTION stock_opening_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_row stock_opening; v_company company; v_unit uuid; v_decimals smallint;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
  PERFORM ledger_assert_scope(v_row.company_id);
  -- A row removed with its whole company has no record left to protect.
  SELECT * INTO v_company FROM company WHERE company_id = v_row.company_id;
  IF FOUND AND v_company.locked_through IS NOT NULL AND v_company.locked_through >= v_company.books_beginning THEN
    RAISE EXCEPTION 'opening stock is inside the locked period' USING ERRCODE = '23514', CONSTRAINT = 'stock_opening_locked';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  SELECT unit_id INTO v_unit FROM stock_item WHERE company_id = NEW.company_id AND id = NEW.item_id FOR SHARE;
  SELECT decimals INTO v_decimals FROM stock_unit WHERE company_id = NEW.company_id AND id = v_unit FOR SHARE;
  IF v_decimals IS NOT NULL AND NEW.quantity <> round(NEW.quantity, v_decimals) THEN
    RAISE EXCEPTION 'the opening quantity has more decimal places than its unit' USING ERRCODE = '23514', CONSTRAINT = 'stock_opening_quantity_places';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_opening_guard BEFORE INSERT OR DELETE ON stock_opening FOR EACH ROW EXECUTE FUNCTION stock_opening_guard();

-- ---- Revision log, row-level security and grants ----

-- The entity check only widens, so it is added NOT VALID, as in 0008.
ALTER TABLE revision_log DROP CONSTRAINT revision_log_entity_check;
ALTER TABLE revision_log ADD CONSTRAINT revision_log_entity_check CHECK (entity IN ('group', 'ledger', 'voucher_type', 'voucher', 'cost_category', 'cost_centre',
  'stock_unit', 'stock_group', 'stock_category', 'stock_location', 'stock_item')) NOT VALID;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['stock_unit', 'stock_group', 'stock_category', 'stock_location', 'stock_item', 'stock_opening'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format($policy$CREATE POLICY %I ON %I
      USING (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')))
      WITH CHECK (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')))$policy$, table_name || '_company_scope', table_name);
  END LOOP;
END $$;

GRANT UPDATE (inventory_enabled) ON company TO books_app;
GRANT SELECT, INSERT, DELETE, UPDATE (symbol, formal_name, decimals, revision) ON stock_unit TO books_app;
GRANT SELECT, INSERT, DELETE, UPDATE (parent_id, name, second_language_name, add_quantities, revision) ON stock_group TO books_app;
GRANT SELECT, INSERT, DELETE, UPDATE (parent_id, name, second_language_name, revision) ON stock_category TO books_app;
GRANT SELECT, INSERT, DELETE, UPDATE (parent_id, name, second_language_name, revision) ON stock_location TO books_app;
GRANT SELECT, INSERT, DELETE, UPDATE (group_id, category_id, unit_id, name, second_language_name, standard_selling_rate, revision) ON stock_item TO books_app;
GRANT SELECT, INSERT, DELETE ON stock_opening TO books_app;
REVOKE ALL ON FUNCTION stock_tree_lock(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stock_tree_lock(text, text) TO books_app;

-- ---- Seeding (D-10) ----

-- The one seeding routine gains the main location; everything else is as in 0008.
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
  INSERT INTO stock_location (company_id, system_key, name) VALUES (p_company, 'main', 'Main Store')
  ON CONFLICT (company_id, system_key) DO NOTHING;
END $$;

-- ---- Existing companies ----

-- Every company gets its main location. The migrator owns the tables but FORCE applies the policy to it too, so the
-- scope lists every workspace for this transaction only, as in 0008. A company that already has a location master
-- named like the seeded one cannot exist: the table is new.
DO $$
DECLARE company_row record;
BEGIN
  PERFORM set_config('app.company_ids', coalesce((SELECT string_agg(id, ',') FROM workspace), ''), true);
  FOR company_row IN SELECT company_id FROM company LOOP
    PERFORM ledger_seed_company(company_row.company_id);
  END LOOP;
  PERFORM set_config('app.company_ids', '', true);
END $$;
