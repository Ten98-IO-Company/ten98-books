import type { MoneyExponent } from '@ten98/runtime/browser';
import type { LedgerErrorCode } from '../ledger.ts';
import { balanceText } from './amounts.ts';

/** Where a save refusal is shown (docs/VOUCHERS.md, "Escape, leaving and failures"). Total over the codes, so a new code fails the typecheck until placed. */
export type RefusalPlace = 'alert' | 'difference' | 'cash-rule' | 'date' | 'status' | 'bills' | 'stale' | 'gone' | 'maybe-saved' | 'retry' | 'setup' | 'master-form';
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
  idempotency_mismatch: 'maybe-saved',
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
