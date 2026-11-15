import { useLeaveGuard as usePackageLeaveGuard, type LeaveGuardBlocker } from '@ten98/ui'
import type { AppConfirmRequest } from '../useConfirm'

/**
 * Builds the app's `useLeaveGuard` (src/components/masters/entry.tsx) from the router adapter: the package's leave guard
 * with the form's own `confirm` from `useConfirm`, so one dialog serves every question on the screen and each opens on
 * Cancel. `confirm` is required and always handed on: the package guard renders a dialog of its own only when it gets none,
 * and that dialog would open on the confirm button for a question that is not marked `danger`. Only `leave` and `pass` are
 * returned. `useBlocker` is a hook the guard calls on every render, so the result is built once, at module level.
 */
export function createLeaveGuard(useBlocker: LeaveGuardBlocker) {
  return function useLeaveGuard(dirty: boolean, confirm: (request: AppConfirmRequest) => Promise<boolean>) {
    const { leave, pass } = usePackageLeaveGuard(dirty, { useBlocker, confirm })
    return { leave, pass }
  }
}
