-- 0013: item lines (M2b slice b1). Sales, purchase, credit-note and debit-note vouchers take item lines that post to
-- their sales or purchase ledger line; a new stock-journal kind holds item lines only. Quantities move; values do not:
-- the statements keep stock at the opening rows until valuation (slice c). Every new row carries company_id, joins
-- through composite keys that include it and is under the forced company policy.
--
-- Locks (one transaction, held until it commits): voucher_type ACCESS EXCLUSIVE (its kind check is replaced), and
-- SHARE ROW EXCLUSIVE on voucher, voucher_line, ledger, stock_item and stock_location (the new table's foreign keys),
-- which blocks writes to them while it runs. Replacing a function takes no table lock.

-- ---- Voucher kind ----

-- The kind check only widens, so it is re-added NOT VALID: it reads no existing row.
ALTER TABLE voucher_type DROP CONSTRAINT voucher_type_kind_check;
ALTER TABLE voucher_type ADD CONSTRAINT voucher_type_kind_check
  CHECK (kind IN ('contra', 'payment', 'receipt', 'journal', 'sales', 'purchase', 'credit_note', 'debit_note', 'stock_journal')) NOT VALID;

-- ---- Item lines ----

-- One row per item line of a voucher, in entry order. On an invoice kind the row names the derived ledger line it posts
-- to (line_no) and that line's ledger; a stock journal's rows name neither. Rows are never updated: an alter replaces
-- them, and those with a line go with it. The amount is the stored truth (entered, or quantity x rate x (1 - discount)
-- rounded half-up); the rate is kept to 6 places for display and editing.
CREATE TABLE inventory_line (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  voucher_id uuid NOT NULL,
  entry_no smallint NOT NULL CHECK (entry_no BETWEEN 1 AND 500),
  item_id uuid NOT NULL,
  location_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  quantity numeric(20, 4) NOT NULL CHECK (quantity > 0),
  rate numeric(20, 6) NOT NULL CHECK (rate >= 0),
  discount_percent numeric(7, 4) CHECK (discount_percent >= 0 AND discount_percent < 100),
  amount bigint NOT NULL CHECK (amount >= 0),
  ledger_id uuid,
  line_no smallint,
  PRIMARY KEY (company_id, voucher_id, entry_no),
  CONSTRAINT inventory_line_posts_to_line CHECK ((ledger_id IS NULL) = (line_no IS NULL)),
  FOREIGN KEY (company_id, voucher_id) REFERENCES voucher (company_id, id),
  FOREIGN KEY (company_id, voucher_id, line_no) REFERENCES voucher_line (company_id, voucher_id, line_no) ON DELETE CASCADE,
  FOREIGN KEY (company_id, item_id) REFERENCES stock_item (company_id, id),
  FOREIGN KEY (company_id, location_id) REFERENCES stock_location (company_id, id),
  FOREIGN KEY (company_id, ledger_id) REFERENCES ledger (company_id, id)
);
-- Each index leads with the column it is sought by: without table statistics every index led by company_id looks alike
-- to the planner (0008, 0011). The item index serves the unit and item guards, the in-use reads, a quantity per item and
-- location, and valuation item by item; the line index the per-line check, the voucher read and a line's cascade; the
-- location index a location delete's key check. There is no ledger-led index: a ledger delete's key check reads the
-- company's item rows (a ledger with lines is refused by voucher_line's key first, and deletes are rare).
CREATE INDEX inventory_line_item_idx ON inventory_line (item_id, location_id, company_id) INCLUDE (direction, quantity, amount);
CREATE INDEX inventory_line_line_idx ON inventory_line (voucher_id, line_no, company_id);
CREATE INDEX inventory_line_location_idx ON inventory_line (location_id, company_id);

-- ---- Guards (the database's second line; the API refuses the same first) ----

-- Whether an item row fits its voucher's kind: the direction of an invoice kind (sales and debit notes out, purchases and
-- credit notes in) with a line on the kind's side (sales and debit notes Cr, purchases and credit notes Dr) of the row's
-- ledger and a non-zero amount; a stock journal's rows in either direction, with no line and no discount; no rows on
-- any other kind.
CREATE FUNCTION inventory_line_fits(p_kind text, p_direction text, p_line_no smallint, p_discount numeric, p_amount bigint,
  p_ledger uuid, p_line_ledger uuid, p_line_side text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_kind = 'stock_journal' THEN p_line_no IS NULL AND p_discount IS NULL
    WHEN p_kind IN ('sales', 'purchase', 'credit_note', 'debit_note') THEN p_line_no IS NOT NULL AND p_amount > 0
      AND p_direction = CASE WHEN p_kind IN ('sales', 'debit_note') THEN 'out' ELSE 'in' END
      AND p_line_ledger IS NOT DISTINCT FROM p_ledger
      AND p_line_side IS NOT DISTINCT FROM CASE WHEN p_kind IN ('sales', 'debit_note') THEN 'Cr' ELSE 'Dr' END
    ELSE false END
$$;

-- Item rows of a cancelled or deleted voucher are frozen, as its lines are. An inserted row's quantity carries no more
-- places than its item's unit allows, checked against the item and then the unit as share-locked here (the posting's
-- order: items, units, locations), so a unit's decimals lowered, or an item's unit changed, in a transaction still open
-- is waited for and its result checked. A writer of several items' rows takes the item locks and then the unit locks
-- itself, each in id order, before inserting: locked row by row here, two writers that do not could deadlock.
CREATE FUNCTION inventory_line_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_row inventory_line; v_unit uuid; v_decimals smallint;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
  PERFORM ledger_assert_scope(v_row.company_id);
  -- A row removed with its whole company has no voucher record left to protect.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM company WHERE company_id = v_row.company_id) THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM voucher v WHERE v.company_id = v_row.company_id AND v.id = v_row.voucher_id AND (v.status = 'cancelled' OR v.deleted_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'item lines of a cancelled or deleted voucher cannot change' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lines_frozen';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  SELECT unit_id INTO v_unit FROM stock_item WHERE company_id = NEW.company_id AND id = NEW.item_id FOR SHARE;
  SELECT decimals INTO v_decimals FROM stock_unit WHERE company_id = NEW.company_id AND id = v_unit FOR SHARE;
  IF v_decimals IS NOT NULL AND NEW.quantity <> round(NEW.quantity, v_decimals) THEN
    RAISE EXCEPTION 'the quantity of an item line has more decimal places than its unit' USING ERRCODE = '23514', CONSTRAINT = 'inventory_line_quantity_places';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_line_guard BEFORE INSERT OR DELETE ON inventory_line FOR EACH ROW EXECUTE FUNCTION inventory_line_guard();

-- At commit, for every inserted or deleted row: an inserted row fits its voucher's kind as it is then (a type change
-- in the same transaction included); the rows on one line add up to that line's amount (read through the line index);
-- a stock journal keeps at least one row. Rows are never updated and a line's rows go with it, so this is complete
-- with voucher_assert_balanced, which checks the rows again when the voucher itself changes (a type change).
CREATE FUNCTION inventory_line_assert_line() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_row inventory_line;
  v_kind text;
  v_line voucher_line;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
  PERFORM ledger_assert_scope(v_row.company_id);
  SELECT t.kind INTO v_kind FROM voucher v JOIN voucher_type t ON t.company_id = v.company_id AND t.id = v.voucher_type_id
  WHERE v.company_id = v_row.company_id AND v.id = v_row.voucher_id;
  -- Removed with its company: nothing left to check.
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_row.line_no IS NOT NULL THEN
    SELECT * INTO v_line FROM voucher_line WHERE company_id = v_row.company_id AND voucher_id = v_row.voucher_id AND line_no = v_row.line_no;
    -- The line is gone, and its rows with it (an alter replaced it): nothing left to check on it.
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP = 'INSERT' AND NOT inventory_line_fits(v_kind, v_row.direction, v_row.line_no, v_row.discount_percent, v_row.amount,
      v_row.ledger_id, v_line.ledger_id, v_line.side) THEN
    RAISE EXCEPTION 'an item line of voucher % does not fit its kind %', v_row.voucher_id, v_kind USING ERRCODE = '23514', CONSTRAINT = 'inventory_line_kind';
  END IF;
  IF TG_OP = 'DELETE' AND v_kind = 'stock_journal'
    AND NOT EXISTS (SELECT 1 FROM inventory_line WHERE voucher_id = v_row.voucher_id AND company_id = v_row.company_id) THEN
    RAISE EXCEPTION 'stock journal % keeps at least one item line', v_row.voucher_id USING ERRCODE = '23514', CONSTRAINT = 'inventory_line_kind';
  END IF;
  IF v_row.line_no IS NOT NULL THEN
    -- Grouped by company, as in 0008: the line index is then the path; a row of another company with the same voucher id
    -- can only make the check refuse.
    PERFORM 1 FROM inventory_line WHERE voucher_id = v_row.voucher_id AND line_no = v_row.line_no
    GROUP BY company_id HAVING company_id <> v_row.company_id OR sum(amount) <> v_line.amount LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'the item lines on line % of voucher % do not add up to the line', v_row.line_no, v_row.voucher_id USING ERRCODE = '23514', CONSTRAINT = 'inventory_line_total';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_line_checked AFTER INSERT OR DELETE ON inventory_line DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inventory_line_assert_line();

-- The check at commit of 0012, plus the kind: a stock journal has no voucher lines and at least one item line (a void,
-- created cancelled with neither, stays exempt); every other kind is as before. When the voucher row itself changes
-- (an update: its type, by an alter or by direct SQL), its item rows are read once, through the line index, and each must fit the
-- voucher's kind as it now is; the per-row check above covers rows inserted or deleted, and so a new voucher's rows.
CREATE OR REPLACE FUNCTION voucher_assert_balanced() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_company text;
  v_voucher uuid;
  v_status text;
  v_number integer;
  v_void boolean;
  v_base text;
  v_kind text;
  v_lines integer;
  v_items integer;
  v_foreign integer;
  v_debit numeric;
  v_credit numeric;
BEGIN
  IF TG_TABLE_NAME = 'voucher' THEN v_company := NEW.company_id; v_voucher := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN v_company := OLD.company_id; v_voucher := OLD.voucher_id;
  ELSE v_company := NEW.company_id; v_voucher := NEW.voucher_id;
  END IF;
  PERFORM ledger_assert_scope(v_company);
  SELECT v.status, v.number, v.created_cancelled, c.base_currency, t.kind INTO v_status, v_number, v_void, v_base, v_kind
  FROM voucher v JOIN company c ON c.company_id = v.company_id JOIN voucher_type t ON t.company_id = v.company_id AND t.id = v.voucher_type_id
  WHERE v.company_id = v_company AND v.id = v_voucher;
  IF NOT FOUND THEN
    -- In scope, only a line removed together with its voucher (company removal) finds no voucher; never skip otherwise.
    IF TG_OP = 'DELETE' THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'voucher % is not visible to its own check', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_balanced';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE currency <> v_base), coalesce(sum(amount) FILTER (WHERE side = 'Dr'), 0), coalesce(sum(amount) FILTER (WHERE side = 'Cr'), 0)
    INTO v_lines, v_foreign, v_debit, v_credit FROM voucher_line WHERE company_id = v_company AND voucher_id = v_voucher;
  SELECT count(*) INTO v_items FROM inventory_line WHERE voucher_id = v_voucher AND company_id = v_company;
  IF v_kind = 'stock_journal' THEN
    IF NOT (v_void AND v_status = 'cancelled' AND v_lines = 0 AND v_items = 0) AND (v_lines > 0 OR v_items = 0) THEN
      RAISE EXCEPTION 'stock journal % has voucher lines or no item line', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_inventory_kind';
    END IF;
  ELSIF NOT (v_void AND v_status = 'cancelled' AND v_lines = 0) AND (v_lines < 2 OR v_debit <> v_credit) THEN
    RAISE EXCEPTION 'voucher % is not balanced', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_balanced';
  END IF;
  IF v_foreign > 0 THEN
    RAISE EXCEPTION 'voucher % has lines in a currency other than the base currency', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_line_base_currency_only';
  END IF;
  IF (v_status = 'optional') <> (v_number IS NULL) THEN
    RAISE EXCEPTION 'voucher % has no number', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_numbered';
  END IF;
  IF TG_TABLE_NAME = 'voucher' AND TG_OP = 'UPDATE' AND v_items > 0 AND EXISTS (
    SELECT 1 FROM inventory_line i
      LEFT JOIN voucher_line l ON l.company_id = i.company_id AND l.voucher_id = i.voucher_id AND l.line_no = i.line_no
    WHERE i.voucher_id = v_voucher AND i.company_id = v_company
      AND NOT inventory_line_fits(v_kind, i.direction, i.line_no, i.discount_percent, i.amount, i.ledger_id, l.ledger_id, l.side)) THEN
    RAISE EXCEPTION 'voucher % has item lines that do not fit its kind %', v_voucher, v_kind USING ERRCODE = '23514', CONSTRAINT = 'voucher_inventory_kind';
  END IF;
  RETURN NULL;
END $$;

-- 0011's unit and item guards, now also counting item lines (through stock_item_unit_idx and the item index). An
-- item-line write in flight share-locks the item and the unit (inventory_line_guard), so the update waits for it to
-- commit and these checks, reading afresh, see its rows.
CREATE OR REPLACE FUNCTION stock_unit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_item uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM ledger_assert_scope(OLD.company_id); RETURN OLD; END IF;
  PERFORM ledger_assert_scope(NEW.company_id);
  IF TG_OP = 'UPDATE' AND NEW.decimals < OLD.decimals THEN
    IF EXISTS (SELECT 1 FROM stock_item i JOIN stock_opening o ON o.company_id = i.company_id AND o.item_id = i.id
        WHERE i.unit_id = NEW.id AND i.company_id = NEW.company_id) THEN
      RAISE EXCEPTION 'the decimals of a unit in use cannot be lowered' USING ERRCODE = '23514', CONSTRAINT = 'stock_unit_decimals';
    END IF;
    -- One probe of the item index per item of the unit. A join here is planned from the item lines' statistics: beside
    -- a few busy items, an item without lines looks common and the planner reads every line instead. The company is
    -- not a filter (as in 0008): with company_id = $1 a cached generic plan reads the company's rows through the
    -- primary key; the policy keeps the scope, and a row of another company with the same id can only make it refuse.
    FOR v_item IN SELECT id FROM stock_item WHERE unit_id = NEW.id LOOP
      IF EXISTS (SELECT 1 FROM inventory_line WHERE item_id = v_item) THEN
        RAISE EXCEPTION 'the decimals of a unit in use cannot be lowered' USING ERRCODE = '23514', CONSTRAINT = 'stock_unit_decimals';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION stock_item_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM ledger_assert_scope(OLD.company_id); RETURN OLD; END IF;
  PERFORM ledger_assert_scope(NEW.company_id);
  IF TG_OP = 'UPDATE' AND NEW.unit_id <> OLD.unit_id AND (
      EXISTS (SELECT 1 FROM stock_opening o WHERE o.company_id = NEW.company_id AND o.item_id = NEW.id)
      -- By item only, as in stock_unit_guard.
      OR EXISTS (SELECT 1 FROM inventory_line l WHERE l.item_id = NEW.id)) THEN
    RAISE EXCEPTION 'the unit of an item with stock cannot change' USING ERRCODE = '23514', CONSTRAINT = 'stock_item_unit_fixed';
  END IF;
  RETURN NEW;
END $$;

-- ---- Row-level security and grants ----

ALTER TABLE inventory_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_line FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_line_company_scope ON inventory_line
  USING (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')))
  WITH CHECK (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')));
GRANT SELECT, INSERT, DELETE ON inventory_line TO books_app;

-- ---- Seeding (D-10) ----

-- The one seeding routine gains the stock journal type; everything else is as in 0012.
CREATE OR REPLACE FUNCTION ledger_seed_company(p_company text) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO currency (company_id, code, system_key, symbol, formal_name, decimals)
  SELECT company_id, base_currency, 'base', base_currency, base_currency, currency_minor_units FROM company WHERE company_id = p_company
  ON CONFLICT (company_id) WHERE system_key IS NOT NULL DO NOTHING;

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
    ('sales', 'Sales'), ('purchase', 'Purchase'), ('credit_note', 'Credit Note'), ('debit_note', 'Debit Note'),
    ('stock_journal', 'Stock Journal')
  ) AS s(kind, name)
  ON CONFLICT (company_id, system_key) DO NOTHING;
  INSERT INTO cost_category (company_id, system_key, name, allocate_revenue, allocate_non_revenue)
  VALUES (p_company, 'primary', 'General', true, true)
  ON CONFLICT (company_id, system_key) DO NOTHING;
  INSERT INTO stock_location (company_id, system_key, name) VALUES (p_company, 'main', 'Main Store')
  ON CONFLICT (company_id, system_key) DO NOTHING;
END $$;

-- ---- Existing companies ----

-- Everything from here to the end reads rows of tables under the forced company policy, which applies to the migrator
-- too: the pre-check and the seeding. Without a scope they would see no rows (the pre-check would pass and no company
-- would get its type). So the scope lists every workspace until the last statement clears it; the deferred checks run
-- before that.
DO $$
BEGIN
  PERFORM set_config('app.company_ids', coalesce((SELECT string_agg(id, ',') FROM workspace), ''), true);
END $$;

-- A company may have renamed one of its voucher types to the seeded type's name (or one equal to it under the name
-- match key); the seeding would then break voucher_type_name_idx, which ON CONFLICT on the system key does not absorb.
-- Such companies stop the migration, named with the type, before anything is seeded; the operator renames the type
-- and migrates again (docs/LEDGER.md gives the query).
DO $$
DECLARE v_found text;
BEGIN
  SELECT string_agg(format('company %s: voucher type "%s"', company_id, name), '; ' ORDER BY company_id, name) INTO v_found
  FROM voucher_type WHERE name_match_key(name) = name_match_key('Stock Journal') AND system_key IS DISTINCT FROM 'stock_journal';
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'these voucher types have the name the stock journal type takes; rename them first: %', v_found;
  END IF;
END $$;

-- Every company gets its stock journal type (and, by 0007's trigger, its numbering row).
DO $$
DECLARE company_row record;
BEGIN
  FOR company_row IN SELECT company_id FROM company LOOP
    PERFORM ledger_seed_company(company_row.company_id);
  END LOOP;
END $$;

DO $$
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM set_config('app.company_ids', '', true);
END $$;
