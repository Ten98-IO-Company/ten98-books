-- M2a slice 1: bills in the base currency (bill-wise receivables and payables). A bill is one party ledger's reference
-- name, compared without regard to case; bill rows on voucher lines and on a ledger's opening balance point at it. A
-- bill's pending amount is the signed sum of its live rows, and the row that dates it is derived at read time (its
-- earliest-dated live new reference), so cancelling, deleting or renaming one voucher never rewrites another.
-- Every new table carries company_id, joins through composite keys that include it and forces the one company policy.

-- ---- Ledger and voucher columns ----

-- Bill-wise is a ledger setting only. The default credit period is kept as entered: a count of days, weeks or months,
-- or a fixed due date. The credit-days check makes sales entry warn about the party's overdue bills.
ALTER TABLE ledger
  ADD COLUMN bill_wise boolean NOT NULL DEFAULT false,
  ADD COLUMN credit_count integer CHECK (credit_count BETWEEN 0 AND 3650),
  ADD COLUMN credit_unit text CHECK (credit_unit IN ('day', 'week', 'month')),
  ADD COLUMN credit_due_date date,
  ADD COLUMN credit_days_check boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT ledger_credit_period_form CHECK ((credit_count IS NULL) = (credit_unit IS NULL) AND (credit_count IS NULL OR credit_due_date IS NULL));

-- The supplier's invoice number and date on purchases, the original invoice on notes. They name a purchase's bill by
-- default and move neither the bill date nor the credit start.
ALTER TABLE voucher
  ADD COLUMN reference text CHECK (reference IS NULL OR (reference = btrim(reference) AND length(reference) BETWEEN 1 AND 100)),
  ADD COLUMN reference_date date;

-- The due date of a credit period counted from a date. Months are calendar months (the 31st becomes the month's last day).
CREATE FUNCTION bill_due_date(p_date date, p_count integer, p_unit text) RETURNS date LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_unit WHEN 'day' THEN p_date + p_count WHEN 'week' THEN p_date + 7 * p_count
    WHEN 'month' THEN (p_date + make_interval(months => p_count))::date END
$$;

-- ---- Bills ----

CREATE TABLE bill (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  ledger_id uuid NOT NULL,
  -- The first spelling is kept; later rows find the bill ignoring case.
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  -- Base currency only until foreign amounts arrive (bill_guard); part of the key so every row shares it.
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  UNIQUE (company_id, id, ledger_id, currency),
  FOREIGN KEY (company_id, ledger_id) REFERENCES ledger (company_id, id)
);
CREATE UNIQUE INDEX bill_identity_idx ON bill (company_id, ledger_id, lower(name));

-- One row of a line's (or an opening balance's) bill-wise breakup. `kind` is the method as entered; whether a row is
-- shown as the bill's new reference or as a settlement is derived. Terms are kept on new references and advances, and
-- copied onto settlements when they are posted, so a settlement that ends up as the bill's first row still has them.
CREATE TABLE bill_allocation (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  ledger_id uuid NOT NULL,
  voucher_id uuid,                    -- both NULL: an opening row on the ledger
  line_no smallint,
  kind text NOT NULL CHECK (kind IN ('new_ref', 'advance', 'against_ref', 'on_account')),
  bill_id uuid,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  side text NOT NULL CHECK (side IN ('Dr', 'Cr')),
  amount bigint NOT NULL CHECK (amount > 0),
  currency_amount bigint NOT NULL CHECK (currency_amount > 0),
  bill_date date,                     -- opening rows only; voucher rows are dated by their voucher
  due_date date,
  credit_count integer CHECK (credit_count BETWEEN 0 AND 3650),
  credit_unit text CHECK (credit_unit IN ('day', 'week', 'month')),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, ledger_id) REFERENCES ledger (company_id, id),
  FOREIGN KEY (company_id, voucher_id, line_no) REFERENCES voucher_line (company_id, voucher_id, line_no) ON DELETE CASCADE,
  FOREIGN KEY (company_id, bill_id, ledger_id, currency) REFERENCES bill (company_id, id, ledger_id, currency),
  CONSTRAINT bill_allocation_opening_shape CHECK ((voucher_id IS NULL) = (line_no IS NULL) AND (voucher_id IS NULL) = (bill_date IS NOT NULL)
    AND (voucher_id IS NOT NULL OR kind = 'new_ref')),
  CONSTRAINT bill_allocation_bill_shape CHECK ((kind = 'on_account') = (bill_id IS NULL)),
  CONSTRAINT bill_allocation_terms CHECK ((credit_count IS NULL) = (credit_unit IS NULL)
    AND (kind NOT IN ('new_ref', 'advance') OR due_date IS NOT NULL)
    AND (kind <> 'on_account' OR (due_date IS NULL AND credit_count IS NULL))),
  CONSTRAINT bill_allocation_base_currency_only CHECK (currency_amount = amount)
);
CREATE INDEX bill_allocation_ledger_idx ON bill_allocation (company_id, ledger_id, bill_id) INCLUDE (side, amount, voucher_id, kind);
CREATE INDEX bill_allocation_bill_idx ON bill_allocation (company_id, bill_id);
CREATE INDEX bill_allocation_line_idx ON bill_allocation (company_id, voucher_id, line_no);

-- Ageing columns are company data that start empty (observed: no default buckets). `to_days` NULL is the open last one.
CREATE TABLE ageing_bucket (
  company_id text NOT NULL REFERENCES company(company_id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 20),
  from_days integer NOT NULL CHECK (from_days BETWEEN 0 AND 36500),
  to_days integer CHECK (to_days IS NULL OR (to_days > from_days AND to_days <= 36500)),
  PRIMARY KEY (company_id, position)
);

-- ---- Bill rows against their line ----

-- Each line's bill rows net, towards the line's side, to between zero and the line amount (the rest is on account; a
-- row on the other side is a bill of its own). Checked at commit for every inserted or deleted row, on that row's line
-- only: lines are never updated, so a line's amount changes only by deleting it, which removes its rows too. M1's
-- voucher check (voucher_assert_balanced, on every voucher and line event) is untouched, and no session state can
-- skip either check.
CREATE FUNCTION bill_allocation_assert_line() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_row bill_allocation;
  v_line voucher_line;
  v_net numeric;
  v_currency_net numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
  -- Opening rows have no line; ledger_opening_bills checks them.
  IF v_row.voucher_id IS NULL THEN RETURN NULL; END IF;
  PERFORM ledger_assert_scope(v_row.company_id);
  SELECT * INTO v_line FROM voucher_line WHERE company_id = v_row.company_id AND voucher_id = v_row.voucher_id AND line_no = v_row.line_no;
  -- The line is gone, and its rows with it (an alter replaced it, or the company was removed): nothing left to check.
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT coalesce(sum(CASE side WHEN v_line.side THEN amount ELSE -amount END), 0),
    coalesce(sum(CASE side WHEN v_line.side THEN currency_amount ELSE -currency_amount END), 0)
    INTO v_net, v_currency_net
  FROM bill_allocation WHERE company_id = v_row.company_id AND voucher_id = v_row.voucher_id AND line_no = v_row.line_no;
  IF v_net < 0 OR v_net > v_line.amount OR v_currency_net < 0 OR v_currency_net > v_line.currency_amount THEN
    RAISE EXCEPTION 'the bill rows of line % of voucher % exceed the line', v_line.line_no, v_line.voucher_id USING ERRCODE = '23514', CONSTRAINT = 'bill_allocation_total';
  END IF;
  RETURN NULL;
END $$;

-- ---- Guards ----

-- A bill never changes, and holds base-currency amounts only for now.
CREATE FUNCTION bill_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM ledger_assert_scope(NEW.company_id);
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a bill never changes' USING ERRCODE = '23514', CONSTRAINT = 'bill_fixed';
  END IF;
  IF NEW.currency IS DISTINCT FROM (SELECT base_currency FROM company WHERE company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'bills are in the base currency' USING ERRCODE = '23514', CONSTRAINT = 'bill_base_currency_only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bill_guard BEFORE INSERT OR UPDATE ON bill FOR EACH ROW EXECUTE FUNCTION bill_guard();

-- A bill is made together with its first row: no bill without rows can be committed.
CREATE FUNCTION bill_assert_used() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM ledger_assert_scope(NEW.company_id);
  IF NOT EXISTS (SELECT 1 FROM bill_allocation a WHERE a.company_id = NEW.company_id AND a.bill_id = NEW.id) THEN
    RAISE EXCEPTION 'bill % has no rows', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'bill_used';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bill_used AFTER INSERT ON bill DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bill_assert_used();

-- Bill rows: frozen with a cancelled or deleted voucher; a voucher row matches its line's ledger and currency; opening
-- rows follow the opening balance's lock and are dated on or before the books begin; never on a cash, bank or profit and
-- loss ledger; a stated credit period gives exactly its due date. Whether the ledger is bill-wise now is the posting
-- rule's concern (rows posted while it was may stay after it is switched off, as observed).
CREATE FUNCTION bill_allocation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_row bill_allocation;
  v_company company;
  v_voucher voucher;
  v_line voucher_line;
  v_date date;
  v_group uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
  PERFORM ledger_assert_scope(v_row.company_id);
  SELECT * INTO v_company FROM company WHERE company_id = v_row.company_id;
  -- A row removed with its whole company has no record left to protect.
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'bill row outside its company' USING ERRCODE = '23514', CONSTRAINT = 'bill_allocation_line';
  END IF;
  IF v_row.voucher_id IS NOT NULL THEN
    SELECT * INTO v_voucher FROM voucher WHERE company_id = v_row.company_id AND id = v_row.voucher_id;
    IF v_voucher.status = 'cancelled' OR v_voucher.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'bill rows of a cancelled or deleted voucher cannot change' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lines_frozen';
    END IF;
    IF TG_OP = 'INSERT' THEN
      SELECT * INTO v_line FROM voucher_line WHERE company_id = NEW.company_id AND voucher_id = NEW.voucher_id AND line_no = NEW.line_no;
      IF NOT FOUND OR v_line.ledger_id <> NEW.ledger_id OR v_line.currency <> NEW.currency THEN
        RAISE EXCEPTION 'a bill row matches its line''s ledger and currency' USING ERRCODE = '23514', CONSTRAINT = 'bill_allocation_line';
      END IF;
    END IF;
    v_date := v_voucher.date;
  ELSE
    IF v_company.locked_through IS NOT NULL AND v_company.locked_through >= v_company.books_beginning THEN
      RAISE EXCEPTION 'opening bills are inside the locked period' USING ERRCODE = '23514', CONSTRAINT = 'bill_allocation_opening_locked';
    END IF;
    IF TG_OP = 'INSERT' AND (NEW.bill_date > v_company.books_beginning OR NEW.currency <> v_company.base_currency) THEN
      RAISE EXCEPTION 'an opening bill is dated on or before the books begin, in the base currency' USING ERRCODE = '23514', CONSTRAINT = 'bill_allocation_opening_date';
    END IF;
    v_date := v_row.bill_date;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT group_id INTO v_group FROM ledger WHERE company_id = NEW.company_id AND id = NEW.ledger_id;
    IF v_group IS NULL OR ledger_in_cash_family(NEW.company_id, v_group) THEN
      RAISE EXCEPTION 'cash, bank and profit and loss ledgers keep no bills' USING ERRCODE = '23514', CONSTRAINT = 'ledger_bill_wise_family';
    END IF;
    IF NEW.kind IN ('new_ref', 'advance') AND NEW.credit_count IS NOT NULL AND NEW.due_date IS DISTINCT FROM bill_due_date(v_date, NEW.credit_count, NEW.credit_unit) THEN
      RAISE EXCEPTION 'the due date does not follow from the credit period' USING ERRCODE = '23514', CONSTRAINT = 'bill_allocation_terms';
    END IF;
  END IF;
  RETURN v_row;
END $$;
CREATE TRIGGER bill_allocation_guard BEFORE INSERT OR DELETE ON bill_allocation FOR EACH ROW EXECUTE FUNCTION bill_allocation_guard();
CREATE CONSTRAINT TRIGGER bill_allocation_balanced AFTER INSERT OR DELETE ON bill_allocation DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bill_allocation_assert_line();

-- Opening bills are new bills on the opening balance's side, together at most the opening amount (the rest is on
-- account; observed). Checked at commit for the ledger whose opening or opening rows changed.
CREATE FUNCTION ledger_assert_opening_bills() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_company text;
  v_ledger uuid;
  v_amount bigint;
  v_side text;
  v_net numeric;
BEGIN
  IF TG_TABLE_NAME = 'ledger' THEN v_company := NEW.company_id; v_ledger := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.voucher_id IS NOT NULL THEN RETURN NULL; END IF;
    v_company := OLD.company_id; v_ledger := OLD.ledger_id;
  ELSE
    IF NEW.voucher_id IS NOT NULL THEN RETURN NULL; END IF;
    v_company := NEW.company_id; v_ledger := NEW.ledger_id;
  END IF;
  PERFORM ledger_assert_scope(v_company);
  SELECT opening_amount, opening_side INTO v_amount, v_side FROM ledger WHERE company_id = v_company AND id = v_ledger;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT coalesce(sum(amount), 0) INTO v_net
  FROM bill_allocation WHERE company_id = v_company AND ledger_id = v_ledger AND voucher_id IS NULL;
  IF v_net > v_amount OR EXISTS (SELECT 1 FROM bill_allocation WHERE company_id = v_company AND ledger_id = v_ledger AND voucher_id IS NULL AND side <> v_side) THEN
    RAISE EXCEPTION 'the opening bills of ledger % exceed its opening balance', v_ledger USING ERRCODE = '23514', CONSTRAINT = 'bill_allocation_opening_total';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_opening_bills AFTER UPDATE ON ledger DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_opening_bills();
CREATE CONSTRAINT TRIGGER bill_allocation_opening_bills AFTER INSERT OR DELETE ON bill_allocation DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_opening_bills();

-- Ledgers, as in M1, plus: cash, bank and the profit and loss ledger are never bill-wise, and a ledger holding bills does
-- not move into the cash and bank family.
CREATE OR REPLACE FUNCTION ledger_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
  RETURN NEW;
END $$;

-- Groups, as in M1, plus: a group whose sub-tree holds bill-wise ledgers, or ledgers with bills, does not move into the
-- cash and bank family.
CREATE OR REPLACE FUNCTION account_group_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ledger_assert_scope(OLD.company_id);
    IF OLD.system_key IS NOT NULL AND EXISTS (SELECT 1 FROM company WHERE company_id = OLD.company_id) THEN
      RAISE EXCEPTION 'built-in group cannot be deleted' USING ERRCODE = '23514', CONSTRAINT = 'account_group_builtin';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM ledger_assert_scope(NEW.company_id);
  IF NEW.nature <> OLD.nature THEN
    IF OLD.system_key IS NOT NULL OR EXISTS (SELECT 1 FROM ledger WHERE company_id = NEW.company_id AND group_id = NEW.id AND system_key IS NOT NULL) THEN
      RAISE EXCEPTION 'built-in groups and groups holding built-in ledgers keep their nature' USING ERRCODE = '23514', CONSTRAINT = 'account_group_builtin';
    END IF;
  END IF;
  IF (NEW.nature, NEW.gross_profit) IS DISTINCT FROM (OLD.nature, OLD.gross_profit) AND NEW.revision = OLD.revision THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    -- The walks below must see moves committed while this transaction waited for the lock.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'groups are moved in READ COMMITTED transactions only' USING ERRCODE = '25001', CONSTRAINT = 'account_group_cycle';
    END IF;
    PERFORM ledger_group_tree_lock(NEW.company_id);
    -- Walk up from the new parent: reaching this group would close a cycle.
    IF NEW.parent_id IS NOT NULL AND EXISTS (
      WITH RECURSIVE up(id) AS (
        SELECT NEW.parent_id
        UNION SELECT g.parent_id FROM account_group g JOIN up ON g.company_id = NEW.company_id AND g.id = up.id WHERE g.parent_id IS NOT NULL)
      SELECT 1 FROM up WHERE id = NEW.id) THEN
      RAISE EXCEPTION 'group cannot sit under its own sub-group' USING ERRCODE = '23514', CONSTRAINT = 'account_group_cycle';
    END IF;
    -- Walk down this sub-tree with the family it will have under the new parent.
    IF EXISTS (
      WITH RECURSIVE down(id, family) AS (
        SELECT NEW.id, coalesce(NEW.system_key IN ('cash_in_hand', 'bank_accounts', 'bank_overdraft'), false) OR ledger_in_cash_family(NEW.company_id, NEW.parent_id)
        UNION ALL
        SELECT g.id, d.family OR coalesce(g.system_key IN ('cash_in_hand', 'bank_accounts', 'bank_overdraft'), false)
        FROM account_group g JOIN down d ON g.company_id = NEW.company_id AND g.parent_id = d.id)
      SELECT 1 FROM down JOIN ledger l ON l.company_id = NEW.company_id AND l.group_id = down.id WHERE l.system_key = 'cash' AND NOT down.family) THEN
      RAISE EXCEPTION 'the cash ledger stays in the cash and bank groups' USING ERRCODE = '23514', CONSTRAINT = 'ledger_cash_family';
    END IF;
    IF EXISTS (
      WITH RECURSIVE down(id, family) AS (
        SELECT NEW.id, coalesce(NEW.system_key IN ('cash_in_hand', 'bank_accounts', 'bank_overdraft'), false) OR ledger_in_cash_family(NEW.company_id, NEW.parent_id)
        UNION ALL
        SELECT g.id, d.family OR coalesce(g.system_key IN ('cash_in_hand', 'bank_accounts', 'bank_overdraft'), false)
        FROM account_group g JOIN down d ON g.company_id = NEW.company_id AND g.parent_id = d.id)
      SELECT 1 FROM down JOIN ledger l ON l.company_id = NEW.company_id AND l.group_id = down.id
      WHERE down.family AND (l.bill_wise OR EXISTS (SELECT 1 FROM bill b WHERE b.company_id = l.company_id AND b.ledger_id = l.id))) THEN
      RAISE EXCEPTION 'cash, bank and profit and loss ledgers keep no bills' USING ERRCODE = '23514', CONSTRAINT = 'ledger_bill_wise_family';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---- Row-level security and grants ----

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['bill', 'bill_allocation', 'ageing_bucket'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format($policy$CREATE POLICY %I ON %I
      USING (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')))
      WITH CHECK (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')))$policy$, table_name || '_company_scope', table_name);
  END LOOP;
END $$;

-- Column grants extend M1's: the new ledger settings and the voucher reference are editable; bills are never updated or
-- deleted; bill rows are written and removed with their line or the opening balance, never updated.
GRANT UPDATE (bill_wise, credit_count, credit_unit, credit_due_date, credit_days_check) ON ledger TO books_app;
GRANT UPDATE (reference, reference_date) ON voucher TO books_app;
GRANT SELECT, INSERT, DELETE ON bill TO books_app;
GRANT SELECT, INSERT, DELETE ON bill_allocation TO books_app;
GRANT SELECT, INSERT, DELETE ON ageing_bucket TO books_app;
REVOKE ALL ON FUNCTION bill_due_date(date, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bill_due_date(date, integer, text) TO books_app;

-- ---- Existing companies ----

-- Receivables and payables ledgers that have no voucher lines and no opening balance become bill-wise, as new ones are
-- by default; a ledger with history stays as it is (its owner opts in), because its earlier invoices would hold no bills.
-- Each change is logged as an alter by the migration. The migrator owns the tables but FORCE applies the policy to it
-- too, so the scope lists every workspace (a company's id is its workspace's) for this transaction only.
DO $$
BEGIN
  PERFORM set_config('app.company_ids', coalesce((SELECT string_agg(id, ',') FROM workspace), ''), true);
  WITH RECURSIVE parties(company_id, id) AS (
    SELECT company_id, id FROM account_group WHERE system_key IN ('receivables', 'payables')
    UNION ALL SELECT g.company_id, g.id FROM account_group g JOIN parties p ON g.company_id = p.company_id AND g.parent_id = p.id),
  eligible AS (
    SELECT l.company_id, l.id FROM ledger l JOIN parties p ON p.company_id = l.company_id AND p.id = l.group_id
    WHERE l.opening_amount = 0 AND NOT l.bill_wise AND NOT ledger_in_cash_family(l.company_id, l.group_id)
      AND NOT EXISTS (SELECT 1 FROM voucher_line x WHERE x.company_id = l.company_id AND x.ledger_id = l.id)),
  changed AS (
    UPDATE ledger l SET bill_wise = true, revision = l.revision + 1 FROM eligible e
    WHERE l.company_id = e.company_id AND l.id = e.id
    RETURNING l.company_id, l.id, l.group_id, l.system_key, l.name, l.second_language_name, l.opening_side, l.revision)
  INSERT INTO revision_log (company_id, entity, entity_id, action, actor_id, before, after)
  SELECT c.company_id, 'ledger', c.id, 'alter', 'migration:0006_bills', s.snapshot || jsonb_build_object('billWise', false, 'revision', c.revision - 1),
    s.snapshot || jsonb_build_object('billWise', true, 'revision', c.revision)
  FROM changed c JOIN account_group g ON g.company_id = c.company_id AND g.id = c.group_id
    CROSS JOIN LATERAL (SELECT jsonb_build_object('id', c.id, 'groupId', c.group_id, 'groupName', g.name, 'nature', g.nature,
      'systemKey', c.system_key, 'name', c.name, 'secondLanguageName', c.second_language_name, 'cashOrBank', false,
      'opening', jsonb_build_object('amount', '0', 'side', c.opening_side), 'creditPeriod', NULL::jsonb,
      'creditDaysCheck', false, 'openingBills', '[]'::jsonb) AS snapshot) s;
  -- The ledger updates queue deferred checks; run them now, while the scope still lists every company.
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM set_config('app.company_ids', '', true);
END $$;
