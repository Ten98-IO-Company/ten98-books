import type { PoolClient } from 'pg';

/**
 * D-10: seeds a company's default chart (15 primary groups, 13 sub-groups, the cash and profit and loss ledgers) and its
 * eight voucher types. The routine itself is the SQL function `ledger_seed_company` in migrations/0004_ledger.sql, so
 * company creation (here, inside the company's withCompany transaction) and the migration's backfill of existing
 * companies run exactly the same statements. It is idempotent: rows already present by system_key are left alone.
 */
export async function seedCompanyLedger(client: PoolClient, companyId: string): Promise<void> {
  await client.query('SELECT ledger_seed_company($1)', [companyId]);
}
