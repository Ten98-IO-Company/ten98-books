-- 0009: bill checks that read their own line or bill on any statistics; the name match key (bill identity and order);
-- vouchers created cancelled without lines; vouchers altered into another voucher type.

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

-- ---- The name match key: when two bill names are the same bill ----

-- A bill is its party's name compared by this key, and bills are listed in the order of the key (ties: bill id). The key
-- is the name in lower case without the characters the reference ignores when it compares names (observed through
-- import and read back from its outstanding export; on screen for settlement by name): space and TAB anywhere, and
-- - . / , ( ) + * ; = ~ ? { } &. Every other character counts: underscore, colon, hash, backslash, at sign, exclamation
-- mark, apostrophe, vertical bar, percent, less-than, dollar, caret, square brackets, backtick, double quote, the
-- non-breaking space, the en dash, leading zeros, accents, and Arabic-Indic digits against ASCII ones. Lower case is
-- the built-in pg_c_utf8 mapping (simple Unicode case mapping, the same on every server): it folds no accents and no
-- digits. The removed characters are this one list; src/lib/names.ts holds its twin, and a test requires both to give
-- the same key. The bill keeps its first spelling for display. The same rule decides duplicate master names on the
-- creation screens (observed), so the name is generic; masters keep their own uniqueness until a later migration.
CREATE FUNCTION name_match_key(p_name text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN lower(translate(p_name, E' \t-./,()+*;=~?{}&', '') COLLATE pg_c_utf8);
GRANT EXECUTE ON FUNCTION name_match_key(text) TO books_app;

-- Two bills of one party that the key makes equal are not merged silently: the migration stops and names them (no
-- released installation holds bills yet; an operator renames or merges them by hand first). The scope lists every
-- workspace for this transaction only, as in 0008.
DO $$
DECLARE v_clash text;
BEGIN
  PERFORM set_config('app.company_ids', coalesce((SELECT string_agg(id, ',') FROM workspace), ''), true);
  SELECT string_agg(format('company %s, ledger %s: %s', company_id, ledger_id, names), '; ') INTO v_clash
  FROM (SELECT company_id, ledger_id, string_agg(name, ', ' ORDER BY name) AS names FROM bill
        GROUP BY company_id, ledger_id, name_match_key(name) HAVING count(*) > 1) clashes;
  PERFORM set_config('app.company_ids', '', true);
  IF v_clash IS NOT NULL THEN
    RAISE EXCEPTION 'these bills become one bill under the new name match key; rename or merge them first: %', v_clash;
  END IF;
END $$;
DROP INDEX bill_identity_idx;
CREATE UNIQUE INDEX bill_identity_idx ON bill (company_id, ledger_id, name_match_key(name));

-- ---- Vouchers created cancelled, without lines ----

-- A voucher may be entered already cancelled and without lines (a void): it takes the next number of its type in its
-- date's period and has no accounting effect. Whether a voucher was created cancelled is set by the guard at insert and
-- kept on every update, so no other voucher can claim it. A cancelled voucher's lines are frozen, so a void never gains
-- lines, and a cancelled voucher never becomes regular again.
ALTER TABLE voucher ADD COLUMN created_cancelled boolean NOT NULL DEFAULT false;

-- The lifecycle rules of 0007, plus created_cancelled and a change of voucher type (see the next section).
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
    IF OLD.number IS NOT NULL AND (NEW.number IS NULL OR (NEW.number_period IS NOT DISTINCT FROM OLD.number_period AND NEW.number <> OLD.number
        AND NEW.voucher_type_id = OLD.voucher_type_id)) THEN
      RAISE EXCEPTION 'voucher number cannot change' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lifecycle';
    END IF;
    IF (OLD.status = 'cancelled' AND NEW.status <> 'cancelled') OR (OLD.status <> 'optional' AND NEW.status = 'optional') THEN
      RAISE EXCEPTION 'voucher status cannot go back' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lifecycle';
    END IF;
  END IF;
  IF NEW.number IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.number IS NULL OR NEW.number_period IS DISTINCT FROM OLD.number_period
      OR NEW.voucher_type_id <> OLD.voucher_type_id OR NEW.series <> OLD.series OR NEW.number <> OLD.number) AND (
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

-- ---- Vouchers altered into another voucher type ----

-- An alter may move a voucher to another type (observed). A numbered voucher then takes the new type's next number in
-- its date's period, issued by that type's counter in the same transaction (voucher_guard above: a number, type or
-- series that changes is checked against the counter of the new type and series); the old number stays a gap of the
-- old type, as a deleted voucher's does. An optional voucher changes type and stays unnumbered.
GRANT UPDATE (voucher_type_id, series) ON voucher TO books_app;
