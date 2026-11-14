-- Voucher numbers restart each numbering period (D-04 as amended, observed numbering rules): every voucher type holds
-- stored restart rules (applicable from, starting number, periodicity), seeded with one row: the start of the financial
-- year in which the books begin, 1, yearly. The rule in force on a voucher's date gives its period; a counter is kept
-- per company, voucher type, series and period, and a number is unique only within its period. Only yearly restart is
-- built; its periods are the company's financial years. Every existing voucher keeps its number
-- and is filed under the period of its date; each period's counter continues from the highest number present in that
-- period (deleted vouchers included, so a deleted number is still never reissued). Row-level security, FORCE, ownership
-- and the existing grants are untouched; the application role may also set the new voucher column, through the same
-- guard as the number, and read and seed restart rules.

-- ---- Schema ----

-- Restart rules per voucher type and series. Daily, weekly, monthly and never are the other periodicities the reference
-- offers; rows with them are refused until they are built, and so is any row beyond the seeded one (changing the rules
-- needs its own change, which must also decide what happens to vouchers already numbered under the old rule).
CREATE TABLE voucher_numbering_restart (
  company_id text NOT NULL,
  voucher_type_id uuid NOT NULL,
  series text NOT NULL,
  applicable_from date NOT NULL,
  starting_number integer NOT NULL CHECK (starting_number > 0),
  periodicity text NOT NULL CHECK (periodicity IN ('daily', 'weekly', 'monthly', 'yearly', 'never')),
  PRIMARY KEY (company_id, voucher_type_id, series, applicable_from),
  FOREIGN KEY (company_id, voucher_type_id, series) REFERENCES voucher_type (company_id, id, numbering_series) ON DELETE CASCADE
);
ALTER TABLE voucher_numbering_restart ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_numbering_restart FORCE ROW LEVEL SECURITY;
CREATE POLICY voucher_numbering_restart_company_scope ON voucher_numbering_restart
  USING (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')))
  WITH CHECK (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')));

CREATE FUNCTION voucher_numbering_restart_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM ledger_assert_scope(NEW.company_id);
  IF NEW.periodicity <> 'yearly' THEN
    RAISE EXCEPTION 'only yearly restart of voucher numbering is available for now; % is not built yet', NEW.periodicity
      USING ERRCODE = '23514', CONSTRAINT = 'voucher_numbering_restart_periodicity';
  END IF;
  IF EXISTS (SELECT 1 FROM voucher_numbering_restart r WHERE r.company_id = NEW.company_id AND r.voucher_type_id = NEW.voucher_type_id AND r.series = NEW.series) THEN
    RAISE EXCEPTION 'the restart rules of a voucher type cannot be changed yet' USING ERRCODE = '23514', CONSTRAINT = 'voucher_numbering_restart_fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voucher_numbering_restart_guard BEFORE INSERT ON voucher_numbering_restart FOR EACH ROW EXECUTE FUNCTION voucher_numbering_restart_guard();

-- The first day of the financial year (starting on month/day) that contains the date.
CREATE FUNCTION ledger_financial_year_start(p_date date, p_month integer, p_day integer) RETURNS date
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN make_date(extract(year FROM p_date)::integer, p_month, p_day) <= p_date
    THEN make_date(extract(year FROM p_date)::integer, p_month, p_day) ELSE make_date(extract(year FROM p_date)::integer - 1, p_month, p_day) END $$;

-- Every voucher type starts with the reference's default row: from the start of the financial year in which the books
-- begin (observed: books beginning 15 October in an April year hold the row 1 April), starting at 1, yearly.
CREATE FUNCTION voucher_type_seed_restart() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO voucher_numbering_restart (company_id, voucher_type_id, series, applicable_from, starting_number, periodicity)
  SELECT NEW.company_id, NEW.id, NEW.numbering_series, ledger_financial_year_start(c.books_beginning, c.fy_start_month, c.fy_start_day), 1, 'yearly'
  FROM company c WHERE c.company_id = NEW.company_id;
  RETURN NULL;
END $$;
CREATE TRIGGER voucher_type_seed_restart AFTER INSERT ON voucher_type FOR EACH ROW EXECUTE FUNCTION voucher_type_seed_restart();

-- The first day of the period whose counter issued the number; set with the number and changed only with it.
ALTER TABLE voucher ADD COLUMN number_period date;

-- The counter key gains the period; the old key goes before the per-period counters are written below.
ALTER TABLE voucher_counter ADD COLUMN period_start date;
ALTER TABLE voucher_counter DROP CONSTRAINT voucher_counter_pkey;

-- The one place that says which numbering period a date falls in, and the period's first number: the rule in force on
-- the date (the latest row applicable on or before it; the earliest row for a date before every row). A yearly period
-- is the company's financial year containing the date.
CREATE FUNCTION ledger_numbering_rule(p_company text, p_voucher_type uuid, p_date date, OUT period_start date, OUT starting_number integer)
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_periodicity text;
  v_month integer;
  v_day integer;
BEGIN
  IF p_date IS NULL THEN RETURN; END IF;
  SELECT r.starting_number, r.periodicity, c.fy_start_month, c.fy_start_day
    INTO starting_number, v_periodicity, v_month, v_day
  FROM voucher_type t
    JOIN company c ON c.company_id = t.company_id
    JOIN voucher_numbering_restart r ON r.company_id = t.company_id AND r.voucher_type_id = t.id AND r.series = t.numbering_series
  WHERE t.company_id = p_company AND t.id = p_voucher_type
  ORDER BY r.applicable_from <= p_date DESC, CASE WHEN r.applicable_from <= p_date THEN r.applicable_from END DESC, r.applicable_from
  LIMIT 1;
  IF NOT FOUND THEN starting_number := NULL; RETURN; END IF;
  IF v_periodicity = 'yearly' THEN
    period_start := ledger_financial_year_start(p_date, v_month, v_day);
    RETURN;
  END IF;
  RAISE EXCEPTION 'only yearly restart of voucher numbering is available for now; % is not built yet', v_periodicity
    USING ERRCODE = '23514', CONSTRAINT = 'voucher_numbering_restart_periodicity';
END $$;

CREATE FUNCTION ledger_numbering_period(p_company text, p_voucher_type uuid, p_date date) RETURNS date
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$ SELECT period_start FROM ledger_numbering_rule(p_company, p_voucher_type, p_date) $$;

-- Counters start at their period's starting number, only move forward by one, and keep their key (now with the period).
CREATE OR REPLACE FUNCTION voucher_counter_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM ledger_assert_scope(NEW.company_id);
  IF (TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM ledger_numbering_rule(NEW.company_id, NEW.voucher_type_id, NEW.period_start) r
        WHERE r.period_start = NEW.period_start AND r.starting_number = NEW.last_number))
     OR (TG_OP = 'UPDATE' AND (
      NEW.last_number <> OLD.last_number + 1 OR (NEW.company_id, NEW.voucher_type_id, NEW.series, NEW.period_start)
        IS DISTINCT FROM (OLD.company_id, OLD.voucher_type_id, OLD.series, OLD.period_start))) THEN
    RAISE EXCEPTION 'a voucher counter only moves forward by one' USING ERRCODE = '23514', CONSTRAINT = 'voucher_counter_sequence';
  END IF;
  RETURN NEW;
END $$;

-- Checked at commit for every advance: the number it issued belongs to a voucher of that type, series and period.
CREATE OR REPLACE FUNCTION voucher_counter_assert_used() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM ledger_assert_scope(NEW.company_id);
  IF NOT EXISTS (SELECT 1 FROM voucher v WHERE v.company_id = NEW.company_id AND v.voucher_type_id = NEW.voucher_type_id
      AND v.series = NEW.series AND v.number_period = NEW.period_start AND v.number = NEW.last_number) THEN
    RAISE EXCEPTION 'voucher counter advanced to % without a voucher', NEW.last_number USING ERRCODE = '23514', CONSTRAINT = 'voucher_counter_sequence';
  END IF;
  RETURN NULL;
END $$;

-- Voucher lifecycle (M1's rules from 0004, plus the period): a number is set together with the period of the voucher's date, to
-- the value that period's counter issued in this same transaction. Inside its period a numbered voucher keeps its
-- number; a date moved into another period takes that period's next number in the same statement, and the old number
-- stays a gap. A number is never removed.
CREATE OR REPLACE FUNCTION voucher_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM ledger_assert_scope(NEW.company_id);
  IF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'deleted voucher cannot change' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lifecycle';
    END IF;
    IF OLD.number IS NOT NULL AND (NEW.number IS NULL OR (NEW.number_period IS NOT DISTINCT FROM OLD.number_period AND NEW.number <> OLD.number)) THEN
      RAISE EXCEPTION 'voucher number cannot change' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lifecycle';
    END IF;
    IF OLD.number IS NOT NULL AND NEW.number_period IS NOT DISTINCT FROM OLD.number_period AND NEW.date IS DISTINCT FROM OLD.date
        AND ledger_numbering_period(NEW.company_id, NEW.voucher_type_id, NEW.date) IS DISTINCT FROM OLD.number_period THEN
      RAISE EXCEPTION 'a voucher moved to another numbering period takes that period''s next number' USING ERRCODE = '23514', CONSTRAINT = 'voucher_number_period';
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

-- ---- Existing data ----

-- The migrator owns the tables but FORCE applies the policy to it too, so the scope lists every workspace (a company's
-- id is its workspace's) for this transaction only. Each existing voucher type gets the default restart row. The voucher
-- and counter guards are off while rows are filed under their period: the rows are not being altered (no revision, no
-- log), and rebuilt counters start past their first number by design.
DO $$
BEGIN
  PERFORM set_config('app.company_ids', coalesce((SELECT string_agg(id, ',') FROM workspace), ''), true);
  INSERT INTO voucher_numbering_restart (company_id, voucher_type_id, series, applicable_from, starting_number, periodicity)
  SELECT t.company_id, t.id, t.numbering_series, ledger_financial_year_start(c.books_beginning, c.fy_start_month, c.fy_start_day), 1, 'yearly'
  FROM voucher_type t JOIN company c ON c.company_id = t.company_id;
  ALTER TABLE voucher DISABLE TRIGGER USER;
  ALTER TABLE voucher_counter DISABLE TRIGGER USER;

  UPDATE voucher SET number_period = ledger_numbering_period(company_id, voucher_type_id, date) WHERE number IS NOT NULL;

  -- One counter per period that holds numbered vouchers, at the highest number present in it. A company whose single
  -- running sequence already crossed a year keeps every number; each year then continues from its own highest number,
  -- so an earlier year's next number may repeat one a later year already holds (legitimate from now on).
  DELETE FROM voucher_counter;
  INSERT INTO voucher_counter (company_id, voucher_type_id, series, period_start, last_number)
  SELECT company_id, voucher_type_id, series, number_period, max(number) FROM voucher
  WHERE number IS NOT NULL GROUP BY company_id, voucher_type_id, series, number_period;

  ALTER TABLE voucher_counter ENABLE TRIGGER USER;
  ALTER TABLE voucher ENABLE TRIGGER USER;
  PERFORM set_config('app.company_ids', '', true);
END $$;

-- ---- Keys ----

ALTER TABLE voucher ADD CONSTRAINT voucher_number_period_set CHECK ((number IS NULL) = (number_period IS NULL));
ALTER TABLE voucher_counter ALTER COLUMN period_start SET NOT NULL;
ALTER TABLE voucher_counter ADD CONSTRAINT voucher_counter_pkey PRIMARY KEY (company_id, voucher_type_id, series, period_start);
ALTER TABLE voucher DROP CONSTRAINT voucher_company_id_voucher_type_id_series_number_key;
ALTER TABLE voucher ADD CONSTRAINT voucher_number_key UNIQUE (company_id, voucher_type_id, series, number_period, number);

-- ---- Grants ----

GRANT UPDATE (number_period) ON voucher TO books_app;
GRANT SELECT, INSERT ON voucher_numbering_restart TO books_app;
REVOKE ALL ON FUNCTION ledger_numbering_rule(text, uuid, date), ledger_numbering_period(text, uuid, date), ledger_financial_year_start(date, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_numbering_rule(text, uuid, date), ledger_numbering_period(text, uuid, date), ledger_financial_year_start(date, integer, integer) TO books_app;
