/**
 * Reading the cost keys a dataset keeps under `extras`, so the seeder can post them and the comparison can name them:
 * a voucher line's `extras.costCentres` rows (`centre`, a centre key of costCentres.json, and a base `amount`; the
 * category comes from the centre and each category's rows add up to the line, which the dataset check verifies) and a
 * ledger's `extras.costCentres` (true or false: whether the ledger takes centres).
 * Nothing here knows the ledger module; amounts stay decimal strings.
 */

export type DatasetCostRow = { centre: string; amount: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A voucher line's cost rows; entries the dataset check already refuses (no centre key, no amount) are left out. */
export function readLineCosts(extras: unknown): DatasetCostRow[] {
  const value = isRecord(extras) ? extras.costCentres : undefined;
  if (!Array.isArray(value)) return [];
  return value.flatMap(raw => isRecord(raw) && typeof raw.centre === 'string' && typeof raw.amount === 'string' ? [{ centre: raw.centre, amount: raw.amount }] : []);
}

/** A ledger's own setting, or undefined when the dataset says nothing (the ledger module's default then applies). */
export const readLedgerCostSetting = (extras: unknown): boolean | undefined =>
  isRecord(extras) && typeof extras.costCentres === 'boolean' ? extras.costCentres : undefined;
