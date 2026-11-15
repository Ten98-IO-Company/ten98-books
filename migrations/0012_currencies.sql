-- M2a slice 3 (currencies, part a): currency masters, the three dated rate lists and a currency on ledgers. Nothing
-- changes for vouchers: the base-only checks on lines, bills and bill rows stay, so a foreign amount is still refused.
-- Every new table carries company_id, joins through composite keys that include it and forces the one company policy.

-- ---- Currencies ----

-- A currency of the company, keyed by its three-letter code. The symbol is what a user types before an amount; under the
-- name match key it is unique across every symbol and every code of the company (currency_guard), so a typed amount
-- resolves one way. `symbol_key` stores that key in plain-text order: under the forced row-level policy only leakproof
-- comparisons on plain columns become index conditions. `id` names the currency in the revision log, whose entity ids
-- are uuids. The base row is seeded (system_key 'base') from the company's base currency and minor units.
CREATE TABLE currency (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Z]{3}$'),
  id uuid NOT NULL DEFAULT uuidv7(),
  system_key text CHECK (system_key IN ('base')),
  symbol text NOT NULL CHECK (symbol = btrim(symbol) AND length(symbol) BETWEEN 1 AND 20),
  symbol_key text COLLATE "C" GENERATED ALWAYS AS (name_match_key(symbol)) STORED,
  -- A symbol of ignored characters only ("...", "-") has an empty key, which would then block every such symbol.
  CONSTRAINT currency_symbol_key CHECK (symbol_key <> ''),
  formal_name text NOT NULL CHECK (formal_name = btrim(formal_name) AND length(formal_name) BETWEEN 1 AND 120),
  iso_code text CHECK (iso_code ~ '^[A-Z]{3}$'),
  -- The runtime money module supports exponents 0, 2 and 3; 1 and 4 are a declared gap.
  decimals smallint NOT NULL CHECK (decimals IN (0, 2, 3)),
  -- Presentation, stored as entered and not yet applied to amounts (a declared gap).
  in_millions boolean NOT NULL DEFAULT false,
  symbol_after boolean NOT NULL DEFAULT false,
  space_between boolean NOT NULL DEFAULT false,
  decimal_word text CHECK (decimal_word IS NULL OR (decimal_word = btrim(decimal_word) AND length(decimal_word) BETWEEN 1 AND 40)),
  words_decimals smallint NOT NULL DEFAULT 2 CHECK (words_decimals BETWEEN 0 AND 4),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, code)
);
-- The symbol index leads with the key. The table keeps no other company-led index: while it has no statistics, the
-- planner prices every index that leads with company_id alike apart from its height, and took a small one with the
-- company as its only condition, reading the company's currencies for each lookup (measured: 66 rows instead of 1).
-- So the one base row per company is a partial index, which serves only lookups of seeded rows.
CREATE UNIQUE INDEX currency_symbol_idx ON currency (symbol_key, company_id);
CREATE UNIQUE INDEX currency_base_idx ON currency (company_id) WHERE system_key IS NOT NULL;

-- Rates per currency, kind and effective date: base units per foreign unit. The rate in force on a date is the row of
-- that kind with the latest effective date on or before it (a backward scan of the primary key).
CREATE TABLE exchange_rate (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  currency text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('standard', 'selling', 'buying')),
  effective_date date NOT NULL,
  rate numeric NOT NULL CONSTRAINT exchange_rate_bounds CHECK (rate > 0 AND rate = round(rate, 4) AND rate < 10000000000),
  PRIMARY KEY (company_id, currency, kind, effective_date),
  FOREIGN KEY (company_id, currency) REFERENCES currency (company_id, code) ON DELETE CASCADE
);

-- ---- Ledgers ----

-- Every ledger names a currency, the base unless stated (ledger_guard fills it on insert); backfilled below.
ALTER TABLE ledger ADD COLUMN currency text;

-- ---- Guards ----

-- Currencies: the base row keeps its code and decimals and is not deleted; no currency changes its code; decimals change
-- only while no ledger names the currency; a delete is refused while a ledger names the currency or a rate row
-- lies in the locked period. A ledger insert still in flight key-shares the currency row, and any UPDATE of a currency
-- row waits for it: `symbol_key` is a stored generated column in a non-partial unique index and the table has a BEFORE
-- UPDATE row trigger, so PostgreSQL recomputes the generated column, treats that key as updated and takes the stronger
-- row lock (measured: even `revision = revision` waits, while an explicit FOR NO KEY UPDATE does not). The use check
-- after the wait sees that ledger. Dropping this trigger, that index or the generated column silently weakens the lock;
-- tests/currencies-guards.integration.ts pins the outcome. In REPEATABLE READ or SERIALIZABLE the check would run on a
-- snapshot older than the ledger and pass, so a decimals change is refused outside READ COMMITTED, as group changes are.
-- Symbols and codes: every create and symbol change takes the company's base row FOR NO KEY
-- UPDATE (serialising currency writes, while postings, which only key-share currency rows, never wait on it) and then
-- refuses a symbol equal under the key to another currency's symbol or code, or a code equal to another's symbol.
-- The lookups run through EXECUTE, planned with their values each time. A cached generic plan (PL/pgSQL switches to one
-- after a few runs in a session) knows only average selectivities: almost every ledger is in the base currency, so the
-- generic plan of "a ledger in this currency" read every ledger of the table (measured: 508 rows instead of none).
CREATE FUNCTION currency_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_company company;
  v_found boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ledger_assert_scope(OLD.company_id);
    SELECT * INTO v_company FROM company WHERE company_id = OLD.company_id FOR SHARE;
    -- Removed with its whole company: nothing left to protect.
    IF NOT FOUND THEN RETURN OLD; END IF;
    IF OLD.system_key IS NOT NULL THEN
      RAISE EXCEPTION 'the base currency cannot be deleted' USING ERRCODE = '23514', CONSTRAINT = 'currency_builtin';
    END IF;
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM ledger WHERE currency = $1 AND company_id = $2)' INTO v_found USING OLD.code, OLD.company_id;
    IF v_found THEN
      RAISE EXCEPTION 'currency % is named by a ledger', OLD.code USING ERRCODE = '23503', CONSTRAINT = 'currency_in_use';
    END IF;
    IF v_company.locked_through IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM exchange_rate WHERE company_id = $1 AND currency = $2 AND effective_date <= $3)' INTO v_found
        USING OLD.company_id, OLD.code, v_company.locked_through;
      IF v_found THEN
        RAISE EXCEPTION 'currency % has rates inside the locked period', OLD.code USING ERRCODE = '23514', CONSTRAINT = 'exchange_rate_locked';
      END IF;
    END IF;
    RETURN OLD;
  END IF;
  PERFORM ledger_assert_scope(NEW.company_id);
  IF TG_OP = 'UPDATE' THEN
    IF NEW.code <> OLD.code OR NEW.id <> OLD.id OR NEW.system_key IS DISTINCT FROM OLD.system_key THEN
      RAISE EXCEPTION 'a currency keeps its code' USING ERRCODE = '23514', CONSTRAINT = 'currency_builtin';
    END IF;
    IF NEW.decimals <> OLD.decimals THEN
      IF OLD.system_key IS NOT NULL THEN
        RAISE EXCEPTION 'the base currency keeps the company''s decimals' USING ERRCODE = '23514', CONSTRAINT = 'currency_builtin';
      END IF;
      -- The use check below must see a ledger committed while this update waited for it.
      IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'currency decimals change in READ COMMITTED transactions only' USING ERRCODE = '25001', CONSTRAINT = 'currency_in_use';
      END IF;
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM ledger WHERE currency = $1 AND company_id = $2)' INTO v_found USING NEW.code, NEW.company_id;
      IF v_found THEN
        RAISE EXCEPTION 'currency % is named by a ledger: its decimals are fixed', NEW.code USING ERRCODE = '23503', CONSTRAINT = 'currency_in_use';
      END IF;
    END IF;
  ELSIF NEW.system_key IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM company WHERE company_id = NEW.company_id AND base_currency = NEW.code AND currency_minor_units = NEW.decimals) THEN
    RAISE EXCEPTION 'the base currency row has the company''s base code and decimals' USING ERRCODE = '23514', CONSTRAINT = 'currency_builtin';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.symbol IS DISTINCT FROM OLD.symbol THEN
    -- The base row by its code (the primary key); none yet while the seeding routine inserts it.
    EXECUTE 'SELECT 1 FROM currency WHERE company_id = $1 AND code = (SELECT base_currency FROM company WHERE company_id = $1) FOR NO KEY UPDATE' USING NEW.company_id;
    -- One lookup per rule: another currency's symbol equal under the key to this symbol (currency_symbol_idx; the stored
    -- key is computed after this trigger, so it is computed here the same way); another currency's code equal to it (a
    -- code is three capital letters, so its key is its lower case: `code = upper(key)` finds it by the primary key and
    -- `lower(code) = key` keeps only an exact match); and, for a new currency, another currency's symbol equal to its code.
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM currency WHERE symbol_key = $1 AND company_id = $2 AND code <> $3)
        OR EXISTS (SELECT 1 FROM currency WHERE company_id = $2 AND code = upper($1) AND code <> $3 AND lower(code) = $1)
        OR ($4 AND EXISTS (SELECT 1 FROM currency WHERE symbol_key = name_match_key($3) AND company_id = $2 AND code <> $3))'
      INTO v_found USING name_match_key(NEW.symbol), NEW.company_id, NEW.code, TG_OP = 'INSERT';
    IF v_found THEN
      RAISE EXCEPTION 'another currency of the company has this symbol or code' USING ERRCODE = '23505', CONSTRAINT = 'currency_symbol_idx';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER currency_guard BEFORE INSERT OR UPDATE OR DELETE ON currency FOR EACH ROW EXECUTE FUNCTION currency_guard();

-- Rate rows: never for the base currency, and never inserted, changed or removed on or before the locked-through date
-- (figures of a locked period would move). The company row is share-locked, so advancing the lock waits for this write.
CREATE FUNCTION exchange_rate_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_row exchange_rate;
  v_company company;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
  PERFORM ledger_assert_scope(v_row.company_id);
  SELECT * INTO v_company FROM company WHERE company_id = v_row.company_id FOR SHARE;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'rate outside its company' USING ERRCODE = '23514', CONSTRAINT = 'exchange_rate_base';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.currency = v_company.base_currency THEN
    RAISE EXCEPTION 'the base currency has no rates' USING ERRCODE = '23514', CONSTRAINT = 'exchange_rate_base';
  END IF;
  IF v_company.locked_through IS NOT NULL AND (v_row.effective_date <= v_company.locked_through
    OR (TG_OP = 'UPDATE' AND OLD.effective_date <= v_company.locked_through)) THEN
    RAISE EXCEPTION 'rates dated on or before % are locked', v_company.locked_through USING ERRCODE = '23514', CONSTRAINT = 'exchange_rate_locked';
  END IF;
  RETURN v_row;
END $$;
CREATE TRIGGER exchange_rate_guard BEFORE INSERT OR UPDATE OR DELETE ON exchange_rate FOR EACH ROW EXECUTE FUNCTION exchange_rate_guard();

-- Ledgers, as in 0006, plus currencies: a new ledger without one takes the base; a ledger in a foreign currency is not
-- bill-wise, has no credit period or credit-days check, takes no cost centres and is neither the profit and loss ledger
-- nor below an income or expense group; its currency changes only while it has no lines, opening amount, bill rows or
-- cost rows, after taking its row FOR UPDATE (a posting in flight key-shares it, so this waits and then sees its lines).
CREATE OR REPLACE FUNCTION ledger_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_base text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ledger_assert_scope(OLD.company_id);
    IF OLD.system_key IS NOT NULL AND EXISTS (SELECT 1 FROM company WHERE company_id = OLD.company_id) THEN
      RAISE EXCEPTION 'built-in ledger cannot be deleted' USING ERRCODE = '23514', CONSTRAINT = 'ledger_builtin';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM ledger_assert_scope(NEW.company_id);
  -- A ledger entering or changing a group takes the company's group-tree lock, so it cannot race a move or a nature
  -- change of that group: whichever transaction runs second waits, then checks against what the first committed.
  IF TG_OP = 'INSERT' OR NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'ledgers change group in READ COMMITTED transactions only' USING ERRCODE = '25001', CONSTRAINT = 'ledger_cash_family';
    END IF;
    PERFORM ledger_group_tree_lock(NEW.company_id);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.system_key IS NOT NULL AND NEW.group_id IS DISTINCT FROM OLD.group_id AND (
    SELECT nature FROM account_group WHERE company_id = NEW.company_id AND id = NEW.group_id) IS DISTINCT FROM (
    SELECT nature FROM account_group WHERE company_id = OLD.company_id AND id = OLD.group_id) THEN
    RAISE EXCEPTION 'built-in ledger keeps its nature' USING ERRCODE = '23514', CONSTRAINT = 'ledger_builtin';
  END IF;
  IF NEW.system_key = 'cash' AND (TG_OP = 'INSERT' OR NEW.group_id IS DISTINCT FROM OLD.group_id) AND NOT ledger_in_cash_family(NEW.company_id, NEW.group_id) THEN
    RAISE EXCEPTION 'the cash ledger stays in the cash and bank groups' USING ERRCODE = '23514', CONSTRAINT = 'ledger_cash_family';
  END IF;
  IF (NEW.bill_wise AND (TG_OP = 'INSERT' OR NOT OLD.bill_wise OR NEW.group_id IS DISTINCT FROM OLD.group_id)
      AND (NEW.group_id IS NULL OR ledger_in_cash_family(NEW.company_id, NEW.group_id)))
    OR (TG_OP = 'UPDATE' AND NEW.group_id IS DISTINCT FROM OLD.group_id AND ledger_in_cash_family(NEW.company_id, NEW.group_id)
      AND EXISTS (SELECT 1 FROM bill b WHERE b.company_id = NEW.company_id AND b.ledger_id = NEW.id)) THEN
    RAISE EXCEPTION 'cash, bank and profit and loss ledgers keep no bills' USING ERRCODE = '23514', CONSTRAINT = 'ledger_bill_wise_family';
  END IF;
  SELECT base_currency INTO v_base FROM company WHERE company_id = NEW.company_id;
  IF TG_OP = 'INSERT' AND NEW.currency IS NULL THEN NEW.currency := v_base; END IF;
  -- Checked first, so a ledger with an opening amount moving to a foreign currency is refused as fixed, not as an opening.
  IF TG_OP = 'UPDATE' AND NEW.currency IS DISTINCT FROM OLD.currency AND OLD.currency IS NOT NULL THEN
    PERFORM 1 FROM ledger WHERE company_id = NEW.company_id AND id = NEW.id FOR UPDATE;
    IF OLD.opening_amount <> 0 OR NEW.opening_amount <> 0
      OR EXISTS (SELECT 1 FROM voucher_line WHERE company_id = NEW.company_id AND ledger_id = NEW.id)
      OR EXISTS (SELECT 1 FROM bill_allocation WHERE company_id = NEW.company_id AND ledger_id = NEW.id)
      OR EXISTS (SELECT 1 FROM cost_allocation WHERE company_id = NEW.company_id AND ledger_id = NEW.id) THEN
      RAISE EXCEPTION 'the currency of a ledger with postings, an opening amount, bill rows or cost rows is fixed' USING ERRCODE = '23514', CONSTRAINT = 'ledger_currency_in_use';
    END IF;
  END IF;
  IF NEW.currency IS DISTINCT FROM v_base THEN
    -- No opening balance either until foreign openings are built (slice b): an amount here would be base units with no
    -- foreign amount beside it. Opening bills must fit the opening amount (ledger_assert_opening_bills), so none fit.
    IF NEW.bill_wise OR NEW.credit_count IS NOT NULL OR NEW.credit_due_date IS NOT NULL OR NEW.credit_days_check OR NEW.cost_centres OR NEW.opening_amount <> 0 THEN
      RAISE EXCEPTION 'a ledger in a foreign currency is not bill-wise, has no credit terms or opening balance and takes no cost centres' USING ERRCODE = '23514', CONSTRAINT = 'ledger_currency_settings';
    END IF;
    IF NEW.group_id IS NULL OR (SELECT nature FROM account_group WHERE company_id = NEW.company_id AND id = NEW.group_id) IN ('income', 'expense') THEN
      RAISE EXCEPTION 'the profit and loss ledger and income and expense ledgers stay in the base currency' USING ERRCODE = '23514', CONSTRAINT = 'ledger_currency_family';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A group whose nature becomes income or expense (directly, or through the cascade from a moved parent) holds no ledger
-- in a foreign currency. A separate trigger, so account_group_guard (0006) stays as it is.
CREATE FUNCTION account_group_currency_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM ledger_assert_scope(NEW.company_id);
  IF NEW.nature IN ('income', 'expense') AND EXISTS (
    SELECT 1 FROM ledger l JOIN company c ON c.company_id = l.company_id
    WHERE l.company_id = NEW.company_id AND l.group_id = NEW.id AND l.currency <> c.base_currency) THEN
    RAISE EXCEPTION 'income and expense groups hold no ledger in a foreign currency' USING ERRCODE = '23514', CONSTRAINT = 'ledger_currency_family';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_group_currency_guard BEFORE UPDATE OF nature ON account_group FOR EACH ROW
  WHEN (NEW.nature IS DISTINCT FROM OLD.nature) EXECUTE FUNCTION account_group_currency_guard();

-- The check at commit of 0009, plus: until foreign lines are built (slice b), every line of a voucher is in its company's
-- base currency. The base-only check on the line tests its rate and amounts, not its code, and the key to currency now
-- accepts any code the company has. Counted in the check's existing one statement per voucher, not looked up per line.
CREATE OR REPLACE FUNCTION voucher_assert_balanced() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_company text;
  v_voucher uuid;
  v_status text;
  v_number integer;
  v_void boolean;
  v_base text;
  v_lines integer;
  v_foreign integer;
  v_debit numeric;
  v_credit numeric;
BEGIN
  IF TG_TABLE_NAME = 'voucher' THEN v_company := NEW.company_id; v_voucher := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN v_company := OLD.company_id; v_voucher := OLD.voucher_id;
  ELSE v_company := NEW.company_id; v_voucher := NEW.voucher_id;
  END IF;
  PERFORM ledger_assert_scope(v_company);
  SELECT v.status, v.number, v.created_cancelled, c.base_currency INTO v_status, v_number, v_void, v_base
  FROM voucher v JOIN company c ON c.company_id = v.company_id WHERE v.company_id = v_company AND v.id = v_voucher;
  IF NOT FOUND THEN
    -- In scope, only a line removed together with its voucher (company removal) finds no voucher; never skip otherwise.
    IF TG_OP = 'DELETE' THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'voucher % is not visible to its own check', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_balanced';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE currency <> v_base), coalesce(sum(amount) FILTER (WHERE side = 'Dr'), 0), coalesce(sum(amount) FILTER (WHERE side = 'Cr'), 0)
    INTO v_lines, v_foreign, v_debit, v_credit FROM voucher_line WHERE company_id = v_company AND voucher_id = v_voucher;
  IF NOT (v_void AND v_status = 'cancelled' AND v_lines = 0) AND (v_lines < 2 OR v_debit <> v_credit) THEN
    RAISE EXCEPTION 'voucher % is not balanced', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_balanced';
  END IF;
  IF v_foreign > 0 THEN
    RAISE EXCEPTION 'voucher % has lines in a currency other than the base currency', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_line_base_currency_only';
  END IF;
  IF (v_status = 'optional') <> (v_number IS NULL) THEN
    RAISE EXCEPTION 'voucher % has no number', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_numbered';
  END IF;
  RETURN NULL;
END $$;

-- ---- Revision log, row-level security and grants ----

-- Widened from 0011's list NOT VALID, as 0008 did: every existing row already passes.
ALTER TABLE revision_log DROP CONSTRAINT revision_log_entity_check;
ALTER TABLE revision_log ADD CONSTRAINT revision_log_entity_check CHECK (entity IN ('group', 'ledger', 'voucher_type', 'voucher', 'cost_category', 'cost_centre',
  'stock_unit', 'stock_group', 'stock_category', 'stock_location', 'stock_item', 'currency', 'exchange_rate')) NOT VALID;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['currency', 'exchange_rate'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format($policy$CREATE POLICY %I ON %I
      USING (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')))
      WITH CHECK (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')))$policy$, table_name || '_company_scope', table_name);
  END LOOP;
END $$;

GRANT SELECT, INSERT, DELETE, UPDATE (symbol, formal_name, iso_code, decimals, in_millions, symbol_after, space_between, decimal_word, words_decimals, revision) ON currency TO books_app;
GRANT SELECT, INSERT, DELETE, UPDATE (rate) ON exchange_rate TO books_app;
GRANT UPDATE (currency) ON ledger TO books_app;

-- ---- Seeding (D-10) ----

-- The one seeding routine gains the base currency row, first, so the ledgers it seeds can name it; everything else is
-- as in 0011 (which added the main location).
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

-- Everything from here to the end reads rows of tables under the forced company policy, which applies to the migrator
-- too: the pre-check, the seeding and backfill, SET NOT NULL and the four key validations. Without a scope they would see
-- no rows, and a validation would mark its key valid without checking anything. So the scope lists every workspace (a
-- company's id is its workspace's) until the last statement clears it; the deferred checks run before that.
DO $$
BEGIN
  PERFORM set_config('app.company_ids', coalesce((SELECT string_agg(id, ',') FROM workspace), ''), true);
END $$;

-- Before 0012 a voucher line or a bill row could carry another currency code (the base-only checks test the rate and the
-- amounts, not the code). The keys below would refuse such rows, so they stop the migration first, named: company,
-- table, how many and a few of them. The operator corrects them and migrates again.
DO $$
DECLARE v_found text;
BEGIN
  SELECT string_agg(format('%s in company %s: %s row(s), e.g. %s', kind, company_id, rows, examples), '; ' ORDER BY kind, company_id) INTO v_found FROM (
    SELECT 'voucher lines' AS kind, l.company_id, count(*) AS rows,
      array_to_string((array_agg(format('voucher %s line %s in %s', l.voucher_id, l.line_no, l.currency) ORDER BY l.voucher_id, l.line_no))[1:3], ', ') AS examples
    FROM voucher_line l JOIN company c ON c.company_id = l.company_id WHERE l.currency <> c.base_currency GROUP BY l.company_id
    UNION ALL
    SELECT 'bills', b.company_id, count(*), array_to_string((array_agg(format('bill %s in %s', b.id, b.currency) ORDER BY b.id))[1:3], ', ')
    FROM bill b JOIN company c ON c.company_id = b.company_id WHERE b.currency <> c.base_currency GROUP BY b.company_id
    UNION ALL
    SELECT 'bill rows', a.company_id, count(*), array_to_string((array_agg(format('row %s in %s', a.id, a.currency) ORDER BY a.id))[1:3], ', ')
    FROM bill_allocation a JOIN company c ON c.company_id = a.company_id WHERE a.currency <> c.base_currency GROUP BY a.company_id) found;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'these rows carry a currency other than their company''s base currency; correct them first: %', v_found;
  END IF;
END $$;

-- Every company gets its base row, and every ledger states the base currency it already had. The backfill is not an
-- alter: no revision is bumped or logged.
DO $$
DECLARE company_row record;
BEGIN
  FOR company_row IN SELECT company_id FROM company LOOP
    PERFORM ledger_seed_company(company_row.company_id);
  END LOOP;
  UPDATE ledger l SET currency = c.base_currency FROM company c WHERE c.company_id = l.company_id AND l.currency IS NULL;
  -- The backfill queued the deferred ledger checks; they run now, under the scope, and must not be pending when the
  -- table is altered below.
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
END $$;

ALTER TABLE ledger ALTER COLUMN currency SET NOT NULL;
-- Whether a ledger names a currency (the decimals and delete guards, the in-use read and the foreign key's check),
-- led by the sought columns.
CREATE INDEX ledger_currency_idx ON ledger (currency, company_id);

-- The foreign keys to currency, added NOT VALID and then validated under the scope set above. The migration is one
-- transaction, so its locks are held until it commits: `ledger` ACCESS EXCLUSIVE (SET NOT NULL, the new column), and
-- `voucher_line`, `bill` and `bill_allocation` SHARE ROW EXCLUSIVE (adding a key), which blocks writes to them while it
-- runs. Every existing value is its company's base code (the pre-check above).
ALTER TABLE ledger ADD CONSTRAINT ledger_currency_fkey FOREIGN KEY (company_id, currency) REFERENCES currency (company_id, code) NOT VALID;
ALTER TABLE voucher_line ADD CONSTRAINT voucher_line_currency_fkey FOREIGN KEY (company_id, currency) REFERENCES currency (company_id, code) NOT VALID;
ALTER TABLE bill ADD CONSTRAINT bill_currency_fkey FOREIGN KEY (company_id, currency) REFERENCES currency (company_id, code) NOT VALID;
ALTER TABLE bill_allocation ADD CONSTRAINT bill_allocation_currency_fkey FOREIGN KEY (company_id, currency) REFERENCES currency (company_id, code) NOT VALID;
ALTER TABLE ledger VALIDATE CONSTRAINT ledger_currency_fkey;
ALTER TABLE voucher_line VALIDATE CONSTRAINT voucher_line_currency_fkey;
ALTER TABLE bill VALIDATE CONSTRAINT bill_currency_fkey;
ALTER TABLE bill_allocation VALIDATE CONSTRAINT bill_allocation_currency_fkey;

DO $$
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM set_config('app.company_ids', '', true);
END $$;
