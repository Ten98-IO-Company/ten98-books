-- Voucher numbers restart each numbering period (D-04 as amended): a counter is kept per company, voucher type, series
-- and period, and a number is unique only within its period. A series names its period kind; the financial year of
-- the voucher's date is the one kind implemented. Every existing voucher keeps its number and is filed under the period
-- of its date; each period's counter continues from the highest number present in that period (deleted vouchers
-- included, so a deleted number is still never reissued). Row-level security, FORCE, ownership and the existing grants
-- are untouched; the application role may also set the new voucher column, through the same guard as the number.

-- ---- Schema ----

-- The period a series' numbers restart in. Only 'financial_year' is implemented; other kinds (month, day, never) need
-- a branch in ledger_numbering_period and a wider check here.
ALTER TABLE voucher_type ADD COLUMN numbering_period text NOT NULL DEFAULT 'financial_year'
  CONSTRAINT voucher_type_numbering_period_check CHECK (numbering_period IN ('financial_year'));

-- The first day of the period whose counter issued the number; set with the number and never changed afterwards.
ALTER TABLE voucher ADD COLUMN number_period date;

-- The counter key gains the period; the old key goes before the per-period counters are written below.
ALTER TABLE voucher_counter ADD COLUMN period_start date;
ALTER TABLE voucher_counter DROP CONSTRAINT voucher_counter_pkey;

-- The one place that says which numbering period a date falls in, for a voucher type of a company. The financial year
-- runs from the company's financial year start (a January year restarts on 1 January, an April year on 1 April).
CREATE FUNCTION ledger_numbering_period(p_company text, p_voucher_type uuid, p_date date) RETURNS date
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_kind text;
  v_month integer;
  v_day integer;
  v_start date;
BEGIN
  SELECT t.numbering_period, c.fy_start_month, c.fy_start_day INTO v_kind, v_month, v_day
  FROM voucher_type t JOIN company c ON c.company_id = t.company_id
  WHERE t.company_id = p_company AND t.id = p_voucher_type;
  IF NOT FOUND OR p_date IS NULL THEN RETURN NULL; END IF;
  IF v_kind = 'financial_year' THEN
    v_start := make_date(extract(year FROM p_date)::integer, v_month, v_day);
    RETURN CASE WHEN p_date >= v_start THEN v_start ELSE make_date(extract(year FROM p_date)::integer - 1, v_month, v_day) END;
  END IF;
  RAISE EXCEPTION 'numbering period % is not supported', v_kind USING ERRCODE = '23514', CONSTRAINT = 'voucher_type_numbering_period_check';
END $$;

-- Counters only move forward, one number at a time, from 1, and keep their key (now including the period).
CREATE OR REPLACE FUNCTION voucher_counter_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM ledger_assert_scope(NEW.company_id);
  IF (TG_OP = 'INSERT' AND NEW.last_number <> 1) OR (TG_OP = 'UPDATE' AND (
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

-- Voucher lifecycle (0006's rules, plus the period): a number is set only together with the period of the voucher's
-- date, to the value that period's counter issued in this same transaction, and neither changes afterwards. A
-- numbered voucher's date stays inside the period of its number (`numberedDateChange` in the server answers first).
CREATE OR REPLACE FUNCTION voucher_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM ledger_assert_scope(NEW.company_id);
  IF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'deleted voucher cannot change' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lifecycle';
    END IF;
    IF OLD.number IS NOT NULL AND (NEW.number IS DISTINCT FROM OLD.number OR NEW.number_period IS DISTINCT FROM OLD.number_period) THEN
      RAISE EXCEPTION 'voucher number cannot change' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lifecycle';
    END IF;
    IF OLD.number IS NOT NULL AND NEW.date IS DISTINCT FROM OLD.date
        AND ledger_numbering_period(NEW.company_id, NEW.voucher_type_id, NEW.date) IS DISTINCT FROM OLD.number_period THEN
      RAISE EXCEPTION 'a numbered voucher stays in the numbering period of its number' USING ERRCODE = '23514', CONSTRAINT = 'voucher_number_period';
    END IF;
    IF (OLD.status = 'cancelled' AND NEW.status <> 'cancelled') OR (OLD.status <> 'optional' AND NEW.status = 'optional') THEN
      RAISE EXCEPTION 'voucher status cannot go back' USING ERRCODE = '23514', CONSTRAINT = 'voucher_lifecycle';
    END IF;
    PERFORM ledger_voucher_mark(NEW.id, false);
  END IF;
  IF NEW.number IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.number IS NULL) AND (
    NEW.number_period IS DISTINCT FROM ledger_numbering_period(NEW.company_id, NEW.voucher_type_id, NEW.date) OR NOT EXISTS (
      SELECT 1 FROM voucher_counter c WHERE c.company_id = NEW.company_id AND c.voucher_type_id = NEW.voucher_type_id AND c.series = NEW.series
        AND c.period_start = NEW.number_period AND c.last_number = NEW.number AND c.xmin = pg_current_xact_id()::xid)) THEN
    RAISE EXCEPTION 'voucher number was not issued by its counter' USING ERRCODE = '23514', CONSTRAINT = 'voucher_numbered';
  END IF;
  RETURN NEW;
END $$;

-- ---- Existing data ----

-- The migrator owns the tables but FORCE applies the policy to it too, so the scope lists every workspace (a company's
-- id is its workspace's) for this transaction only. The guards are off while rows are filed under their period: the
-- rows are not being altered (no revision, no log), and rebuilt counters start past one by design.
DO $$
BEGIN
  PERFORM set_config('app.company_ids', coalesce((SELECT string_agg(id, ',') FROM workspace), ''), true);
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
REVOKE ALL ON FUNCTION ledger_numbering_period(text, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_numbering_period(text, uuid, date) TO books_app;
