import { useLeaveGuard as usePackageLeaveGuard, type LeaveGuardBlocker } from '@ten98/ui'
import { useCallback, useEffect } from 'react'
import type { AppConfirmRequest } from '../useConfirm'

/** What `focusAfterKeepEditing` reads of an element: enough to test it without a DOM. */
export type FocusTarget = { readonly isConnected: boolean; focus: () => void; closest: (selector: string) => unknown }

/**
 * Where focus goes once "Keep editing" has closed the question: back to the element that had it, outside any dialog,
 * when the command that raised the question was pressed. A question raised from inside another dialog (go-to,
 * switch-to, the company list) opens after that dialog has started closing, so its own focus return points at an
 * element that is gone and focus would fall to the page body. Only a body focus is corrected; a control that already
 * has focus keeps it.
 */
export function focusAfterKeepEditing(active: unknown, body: unknown, remembered: FocusTarget | null): FocusTarget | null {
  if (active !== null && active !== body) return null
  return remembered?.isConnected && !remembered.closest('dialog') ? remembered : null
}

/**
 * The control to focus again after a save that locked and remounted a form (the account preferences): the one that
 * saved while it is still on the page and enabled, else the control of the same name in the remounted form (a field
 * submitted with Enter), else its Save button. The preferences flow disables Save once nothing differs from the saved
 * values, so a save made with that button lands on the form's first editable field instead.
 */
export function controlAfterSave<T extends { isConnected: boolean; getAttribute: (name: string) => string | null; matches: (selector: string) => boolean }>(previous: T | null, find: (selector: string) => T | null): T | null {
  if (!previous) return null
  if (previous.isConnected && !previous.matches(':disabled')) return previous
  const name = previous.getAttribute('name')
  return (name ? find(`[name="${name}"]:not(:disabled)`) : null) ?? find('button[type="submit"]:not(:disabled)') ?? find('input:not([type="hidden"]):not([readonly]):not(:disabled)')
}

/**
 * Builds the app's `useLeaveGuard` (src/components/masters/entry.tsx) from the router adapter: the package's leave guard
 * with the form's own `confirm` from `useConfirm`, so one dialog serves every question on the screen and each opens on
 * Cancel. `confirm` is required and always handed on: the package guard renders a dialog of its own only when it gets none,
 * and that dialog would open on the confirm button for a question that is not marked `danger`. Only `leave` and `pass` are
 * returned. `useBlocker` is a hook the guard calls on every render, so the result is built once, at module level.
 *
 * While a guarded screen is mounted it remembers the last element focused outside a dialog, and "Keep editing" puts
 * focus back there (`focusAfterKeepEditing`), whatever raised the question.
 */
export function createLeaveGuard(useBlocker: LeaveGuardBlocker) {
  let remembered: FocusTarget | null = null
  const remember = (event: FocusEvent) => {
    const target = event.target as FocusTarget | null
    if (target && typeof target.closest === 'function' && !target.closest('dialog')) remembered = target
  }
  return function useLeaveGuard(dirty: boolean, confirm: (request: AppConfirmRequest) => Promise<boolean>) {
    useEffect(() => {
      const active = document.activeElement as FocusTarget | null
      if (active && active !== document.body && !active.closest('dialog')) remembered = active
      document.addEventListener('focusin', remember)
      return () => document.removeEventListener('focusin', remember)
    }, [])
    const ask = useCallback(async (request: AppConfirmRequest) => {
      const leave = await confirm(request)
      // The question gives focus back as it unmounts, after the answer; a body focus is corrected once that is done.
      if (!leave && typeof document !== 'undefined') setTimeout(() => focusAfterKeepEditing(document.activeElement, document.body, remembered)?.focus(), 0)
      return leave
    }, [confirm])
    const { leave, pass } = usePackageLeaveGuard(dirty, { useBlocker, confirm: ask })
    return { leave, pass }
  }
}
