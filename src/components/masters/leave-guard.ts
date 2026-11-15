import { useLeaveGuard as usePackageLeaveGuard, type LeaveGuardBlocker } from '@ten98/ui'
import { createContext, useCallback, useContext } from 'react'
import type { AppConfirmRequest } from '../useConfirm'

/** What the focus helpers read of an element: enough to test them without a DOM. */
export type FocusTarget = { readonly isConnected: boolean; focus: () => void; closest: (selector: string) => unknown }

/** Whether a value (an event's target, the active element) is an element focus can return to. */
export const isFocusTarget = (value: unknown): value is FocusTarget =>
  typeof value === 'object' && value !== null && 'focus' in value && typeof value.focus === 'function' && 'closest' in value && typeof value.closest === 'function' && 'isConnected' in value

/** The last element focused outside a dialog. The signed-in shell owns one (a ref) and hands it to the guards below. */
export type FocusMemory = { current: FocusTarget | null }
export const FocusMemoryContext = createContext<FocusMemory | null>(null)

/**
 * Keeps `memory` on the last element focused outside a dialog, from now on (the element focused now included); returns the
 * function that stops it. The shell calls it once for the document.
 */
export function rememberFocusOutsideDialogs(document: { activeElement: unknown; body: unknown; addEventListener: (type: 'focusin', listener: (event: { target: unknown }) => void) => void; removeEventListener: (type: 'focusin', listener: (event: { target: unknown }) => void) => void }, memory: FocusMemory): () => void {
  const keep = (target: unknown) => { if (isFocusTarget(target) && target !== document.body && !target.closest('dialog')) memory.current = target }
  keep(document.activeElement)
  const listener = (event: { target: unknown }) => keep(event.target)
  document.addEventListener('focusin', listener)
  return () => document.removeEventListener('focusin', listener)
}

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

/** Puts focus back after a save once the form is usable again, unless something already holds it; true when it focused. */
export function refocusAfterSave<T extends { isConnected: boolean; getAttribute: (name: string) => string | null; matches: (selector: string) => boolean; focus: () => void }>(previous: T | null, active: unknown, body: unknown, find: (selector: string) => T | null): boolean {
  if (active && active !== body) return false
  const target = controlAfterSave(previous, find)
  target?.focus()
  return target !== null
}

/**
 * Builds the app's `useLeaveGuard` (src/components/masters/entry.tsx) from the router adapter: the package's leave guard
 * with the form's own `confirm` from `useConfirm`, so one dialog serves every question on the screen and each opens on
 * Cancel. `confirm` is required and always handed on: the package guard renders a dialog of its own only when it gets none,
 * and that dialog would open on the confirm button for a question that is not marked `danger`. Only `leave` and `pass` are
 * returned. `useBlocker` is a hook the guard calls on every render, so the result is built once, at module level.
 *
 * "Keep editing" puts focus back on the element the shell's focus memory holds (`focusAfterKeepEditing`), whatever
 * raised the question. Without a shell (no memory) nothing is corrected.
 */
export function createLeaveGuard(useBlocker: LeaveGuardBlocker) {
  return function useLeaveGuard(dirty: boolean, confirm: (request: AppConfirmRequest) => Promise<boolean>) {
    const memory = useContext(FocusMemoryContext)
    const ask = useCallback(async (request: AppConfirmRequest) => {
      const leave = await confirm(request)
      // The question gives focus back as it unmounts, after the answer; a body focus is corrected once that is done.
      if (!leave && memory && typeof document !== 'undefined') setTimeout(() => focusAfterKeepEditing(document.activeElement, document.body, memory.current)?.focus(), 0)
      return leave
    }, [confirm, memory])
    const { leave, pass } = usePackageLeaveGuard(dirty, { useBlocker, confirm: ask })
    return { leave, pass }
  }
}
