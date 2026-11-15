import type { MoneyExponent } from '@ten98/runtime/browser';
import { billWarningCodes, type LedgerErrorCode } from '../ledger.ts';
import { balanceText } from './amounts.ts';

/** Where a save refusal is shown (docs/VOUCHERS.md, "Escape, leaving and failures"). Total over the codes, so a new code fails the typecheck until placed. */
export type RefusalPlace = 'alert' | 'difference' | 'cash-rule' | 'date' | 'status' | 'bills' | 'stale' | 'gone' | 'conflict' | 'retry' | 'setup' | 'master-form';
export const refusalPlaces: Record<LedgerErrorCode, RefusalPlace> = {
  validation: 'alert',
  not_found: 'gone',
  stale_revision: 'stale',
  retry: 'retry',
  duplicate_name: 'master-form',
  in_use: 'master-form',
  seeded_row: 'master-form',
  nature_fixed: 'master-form',
  family_rule: 'master-form',
  cycle: 'master-form',
  locked_period: 'date',
  before_books_beginning: 'date',
  unbalanced: 'difference',
  posting_rule: 'cash-rule',
  voucher_state: 'status',
  // Never a refusal on a create: `classifyAnswer` makes it the `conflict` state, with its own alert.
  idempotency_mismatch: 'conflict',
  not_set_up: 'setup',
  allocation_total: 'bills',
  bill_inactive: 'bills',
  feature_off: 'alert',
};
export const refusalPlace = (code: string | undefined): RefusalPlace => code !== undefined && Object.hasOwn(refusalPlaces, code) ? refusalPlaces[code as LedgerErrorCode] : 'alert';

/** The warning a credit to a cash-in-hand ledger raises when its balance goes below zero; never blocks (observed). */
export function negativeCashWarning(name: string, balance: bigint | undefined, exponent: MoneyExponent): string | null {
  return balance !== undefined && balance < 0n ? `${name} will be ${balanceText(balance, exponent)} after this voucher.` : null;
}

/**
 * The notes a saved voucher's message carries: the bill warnings this screen knows, in words. Any other code (a later
 * slice's stock warnings, say) is ignored here, never a failure; its own screen will show it.
 */
export function savedNotes(warnings: readonly { code: string }[]): string {
  const known = warnings.flatMap(warning => billWarningCodes.some(code => code === warning.code) ? [warning.code.replaceAll('_', ' ')] : []);
  return known.length ? ` ${known.length === 1 ? 'Note' : 'Notes'}: ${known.join(', ')}.` : '';
}
