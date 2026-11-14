-- 0010: master names are unique under the name match key (migration 0009), as the creation screens decide duplicates
-- (observed for groups, ledgers, voucher types and cost centres: two names equal apart from case, spaces and
-- - . / , ( ) + * ; = ~ ? { } & are the same name; an underscore keeps them apart). Each unique index keeps its name,
-- so the API's duplicate_name mappings by constraint name keep working, and is built in plain-text order (COLLATE "C")
-- like bill_identity_idx. A cost category and a cost centre may share a name (separate indexes, as before). Second-
-- language names had no uniqueness rule and still have none. The seeding routine finds its rows by system_key only.

-- Existing rows of one company that become one name under the key are not renamed silently: the migration stops and
-- names them per table (LEDGER.md "Known limits" has the operator query). The scope lists every workspace for this
-- transaction only, as in 0008 and 0009.
DO $$
DECLARE v_clash text;
BEGIN
  PERFORM set_config('app.company_ids', coalesce((SELECT string_agg(id, ',') FROM workspace), ''), true);
  SELECT string_agg(format('%s in company %s: %s', kind, company_id, names), '; ' ORDER BY kind, company_id) INTO v_clash FROM (
    SELECT 'groups' AS kind, company_id, string_agg(name, ', ' ORDER BY name) AS names FROM account_group GROUP BY company_id, name_match_key(name) HAVING count(*) > 1
    UNION ALL SELECT 'ledgers', company_id, string_agg(name, ', ' ORDER BY name) FROM ledger GROUP BY company_id, name_match_key(name) HAVING count(*) > 1
    UNION ALL SELECT 'voucher types', company_id, string_agg(name, ', ' ORDER BY name) FROM voucher_type GROUP BY company_id, name_match_key(name) HAVING count(*) > 1
    UNION ALL SELECT 'cost categories', company_id, string_agg(name, ', ' ORDER BY name) FROM cost_category GROUP BY company_id, name_match_key(name) HAVING count(*) > 1
    UNION ALL SELECT 'cost centres', company_id, string_agg(name, ', ' ORDER BY name) FROM cost_centre GROUP BY company_id, name_match_key(name) HAVING count(*) > 1) clashes;
  PERFORM set_config('app.company_ids', '', true);
  IF v_clash IS NOT NULL THEN
    RAISE EXCEPTION 'these master names become one name under the name match key; rename them first: %', v_clash;
  END IF;
END $$;

DROP INDEX account_group_name_idx;
CREATE UNIQUE INDEX account_group_name_idx ON account_group (company_id, name_match_key(name) COLLATE "C");
DROP INDEX ledger_name_idx;
CREATE UNIQUE INDEX ledger_name_idx ON ledger (company_id, name_match_key(name) COLLATE "C");
DROP INDEX voucher_type_name_idx;
CREATE UNIQUE INDEX voucher_type_name_idx ON voucher_type (company_id, name_match_key(name) COLLATE "C");
DROP INDEX cost_category_name_idx;
CREATE UNIQUE INDEX cost_category_name_idx ON cost_category (company_id, name_match_key(name) COLLATE "C");
DROP INDEX cost_centre_name_idx;
CREATE UNIQUE INDEX cost_centre_name_idx ON cost_centre (company_id, name_match_key(name) COLLATE "C");
