-- A company's books settings, one row per project (D-03, D-04, D-09). Company data is readable and writable only inside
-- a transaction whose app.company_ids lists the company; a missing or empty setting admits no rows. FORCE applies the
-- policy to the table owner too, so only a superuser or a BYPASSRLS role could see past it, and the application role
-- is neither (asserted at boot).
CREATE TABLE company (
  company_id text PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  second_language_name text CHECK (second_language_name IS NULL OR length(second_language_name) BETWEEN 1 AND 120),
  base_currency text NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  currency_minor_units smallint NOT NULL CHECK (currency_minor_units IN (2, 3)),
  fy_start_month smallint NOT NULL CHECK (fy_start_month BETWEEN 1 AND 12),
  fy_start_day smallint NOT NULL CHECK (fy_start_day BETWEEN 1 AND 31),
  books_beginning date NOT NULL,
  time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 80),
  locked_through date,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The financial year start exists in every year: no 29 February, no 31 April.
  CHECK (fy_start_day <= extract(day FROM make_date(2001, fy_start_month, 1) + interval '1 month - 1 day'))
);

ALTER TABLE company ENABLE ROW LEVEL SECURITY;
ALTER TABLE company FORCE ROW LEVEL SECURITY;
CREATE POLICY company_scope ON company
  USING (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')))
  WITH CHECK (company_id = ANY (string_to_array(current_setting('app.company_ids', true), ',')));

GRANT SELECT, INSERT, UPDATE ON company TO books_app;
