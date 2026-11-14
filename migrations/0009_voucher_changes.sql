-- 0009: bill checks that read their own line or bill on any statistics; vouchers created cancelled without lines;
-- vouchers altered into another voucher type.

-- ---- Bill checks without statistics ----

-- Without table statistics (a new table) every index that leads with company_id looks alike to the planner, which then
-- read the company's rows for each deferred check and filtered them (measured: 93,875 rows fetched for a 500-line
-- voucher with 250 bills). The line and bill indexes are now led by the line and by the bill, without company_id: with
-- company_id as a later column, the row-level policy's company_id = ANY(...) made them look dearer than a company-led
-- index under the application role. The policy filters the few rows they return. Both keep their names; no foreign
-- key or ON CONFLICT names either, and the reads by company and voucher, or company and bill, use them as well.
DROP INDEX bill_allocation_line_idx;
CREATE INDEX bill_allocation_line_idx ON bill_allocation (voucher_id, line_no);
DROP INDEX bill_allocation_bill_idx;
CREATE INDEX bill_allocation_bill_idx ON bill_allocation (bill_id);

-- As in 0006, but the line's rows are read by voucher and line only, with no company filter and no grouping: either
-- lets an index that leads with company_id win again. The company is checked over the rows read: a row of another
-- company in scope with the same voucher id makes the check refuse.
CREATE OR REPLACE FUNCTION bill_allocation_assert_line() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_row bill_allocation;
  v_line voucher_line;
  v_bad boolean;
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
  SELECT coalesce(bool_or(company_id <> v_row.company_id), false), coalesce(sum(CASE side WHEN v_line.side THEN amount ELSE -amount END), 0),
    coalesce(sum(CASE side WHEN v_line.side THEN currency_amount ELSE -currency_amount END), 0)
    INTO v_bad, v_net, v_currency_net
  FROM bill_allocation WHERE voucher_id = v_row.voucher_id AND line_no = v_row.line_no;
  v_bad := v_bad OR v_net < 0 OR v_net > v_line.amount OR v_currency_net < 0 OR v_currency_net > v_line.currency_amount;
  IF v_bad THEN
    RAISE EXCEPTION 'the bill rows of line % of voucher % exceed the line', v_line.line_no, v_line.voucher_id USING ERRCODE = '23514', CONSTRAINT = 'bill_allocation_total';
  END IF;
  RETURN NULL;
END $$;

-- A bill is made together with its first row: no bill without rows can be committed. Read by bill only (a company
-- filter lets a company-led index win without statistics); one of the rows read must be of the bill's own company.
CREATE OR REPLACE FUNCTION bill_assert_used() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM ledger_assert_scope(NEW.company_id);
  IF NOT coalesce((SELECT bool_or(company_id = NEW.company_id) FROM bill_allocation WHERE bill_id = NEW.id), false) THEN
    RAISE EXCEPTION 'bill % has no rows', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'bill_used';
  END IF;
  RETURN NULL;
END $$;

-- ---- Bill name order ----

-- Bills are listed by name as text, ignoring case and punctuation (observed for ten bills of one debtor: 10, 9, A-020,
-- A-100, a2, B-050, B1, b3, B-300, C-200). An ICU collation at primary strength with punctuation shifted gives that
-- order; it is not deterministic (B-1 and b1 compare equal), so every order by it ends with the bill id. Bill identity
-- is unchanged: a bill is still its party's name ignoring case (bill_identity_idx).
CREATE COLLATION bill_name_order (provider = icu, locale = 'und-u-ka-shifted-ks-level1', deterministic = false);
CREATE INDEX bill_name_order_idx ON bill (company_id, ledger_id, name COLLATE bill_name_order, id);

-- ---- Vouchers created cancelled, without lines ----

-- A voucher may be entered already cancelled and without lines (a void): it takes the next number of its type in its
-- date's period and has no accounting effect. Whether a voucher was created cancelled is set by the guard at insert and
-- kept on every update, so no other voucher can claim it. A cancelled voucher's lines are frozen, so a void never gains
-- lines, and a cancelled voucher never becomes regular again.
ALTER TABLE voucher ADD COLUMN created_cancelled boolean NOT NULL DEFAULT false;

-- The lifecycle rules of 0007, plus created_cancelled.
CREATE OR REPLACE FUNCTION voucher_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM ledger_assert_scope(NEW.company_id);
  IF TG_OP = 'INSERT' THEN
    NEW.created_cancelled := NEW.status = 'cancelled';
  ELSE
    NEW.created_cancelled := OLD.created_cancelled;
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'deleted voucher cannot change' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lifecycle';
    END IF;
    IF OLD.number IS NOT NULL AND (NEW.number IS NULL OR (NEW.number_period IS NOT DISTINCT FROM OLD.number_period AND NEW.number <> OLD.number)) THEN
      RAISE EXCEPTION 'voucher number cannot change' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lifecycle';
    END IF;
    IF (OLD.status = 'cancelled' AND NEW.status <> 'cancelled') OR (OLD.status <> 'optional' AND NEW.status = 'optional') THEN
      RAISE EXCEPTION 'voucher status cannot go back' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lifecycle';
    END IF;
  END IF;
  IF NEW.number IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.number IS NULL OR NEW.number_period IS DISTINCT FROM OLD.number_period) AND (
    NEW.number_period IS DISTINCT FROM ledger_numbering_period(NEW.company_id, NEW.voucher_type_id, NEW.date) OR NOT EXISTS (
      SELECT 1 FROM voucher_counter c WHERE c.company_id = NEW.company_id AND c.voucher_type_id = NEW.voucher_type_id AND c.series = NEW.series
        AND c.period_start = NEW.number_period AND c.last_number = NEW.number AND c.xmin = pg_current_xact_id()::xid)) THEN
    RAISE EXCEPTION 'voucher number was not issued by its counter' USING ERRCODE = '23514', CONSTRAINT = 'voucher_numbered';
  END IF;
  RETURN NEW;
END $$;

-- The check at commit of 0004, with one exemption: a voucher created cancelled that has no lines.
CREATE OR REPLACE FUNCTION voucher_assert_balanced() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_company text;
  v_voucher uuid;
  v_status text;
  v_number integer;
  v_void boolean;
  v_lines integer;
  v_debit numeric;
  v_credit numeric;
BEGIN
  IF TG_TABLE_NAME = 'voucher' THEN v_company := NEW.company_id; v_voucher := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN v_company := OLD.company_id; v_voucher := OLD.voucher_id;
  ELSE v_company := NEW.company_id; v_voucher := NEW.voucher_id;
  END IF;
  PERFORM ledger_assert_scope(v_company);
  SELECT status, number, created_cancelled INTO v_status, v_number, v_void FROM voucher WHERE company_id = v_company AND id = v_voucher;
  IF NOT FOUND THEN
    -- In scope, only a line removed together with its voucher (company removal) finds no voucher; never skip otherwise.
    IF TG_OP = 'DELETE' THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'voucher % is not visible to its own check', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_balanced';
  END IF;
  SELECT count(*), coalesce(sum(amount) FILTER (WHERE side = 'Dr'), 0), coalesce(sum(amount) FILTER (WHERE side = 'Cr'), 0)
    INTO v_lines, v_debit, v_credit FROM voucher_line WHERE company_id = v_company AND voucher_id = v_voucher;
  IF NOT (v_void AND v_status = 'cancelled' AND v_lines = 0) AND (v_lines < 2 OR v_debit <> v_credit) THEN
    RAISE EXCEPTION 'voucher % is not balanced', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_balanced';
  END IF;
  IF (v_status = 'optional') <> (v_number IS NULL) THEN
    RAISE EXCEPTION 'voucher % has no number', v_voucher USING ERRCODE = '23514', CONSTRAINT = 'voucher_numbered';
  END IF;
  RETURN NULL;
END $$;
