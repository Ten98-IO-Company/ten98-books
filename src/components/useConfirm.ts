import { useConfirmDialog, type ConfirmRequest } from '@ten98/ui'
import { isValidElement, useCallback, useRef, type ReactNode } from 'react'

/** A confirmation as the application asks it: the package's request without its focus choice. */
export type AppConfirmRequest = Omit<ConfirmRequest, 'initialFocus'> & {
  /**
   * Opens with focus on the confirm button, so Enter confirms. Only for a question whose confirming loses nothing;
   * without it the question opens on its cancel button.
   */
  startOnConfirmButton?: true
}

/**
 * The package request for an application request: focus starts on Cancel unless the caller set `startOnConfirmButton`
 * to true. The focus is written after the caller's fields, so a spread that carries the package's own `initialFocus`
 * cannot change it.
 */
export function confirmRequest(request: AppConfirmRequest): ConfirmRequest {
  const { startOnConfirmButton, ...rest } = request
  return { ...rest, initialFocus: startOnConfirmButton === true ? 'confirm' : 'cancel' }
}

/**
 * The application's only way to ask for a confirmation (`useConfirmDialog` of `@ten98/ui` underneath): every question
 * opens on its cancel button, so Enter never deletes, switches off or discards work. A test checks that no other file
 * imports the package's confirmation pieces.
 */
export function useConfirm(): [(request: AppConfirmRequest) => Promise<boolean>, ReactNode, () => void] {
  const [confirm, dialog] = useConfirmDialog()
  const ask = useCallback((request: AppConfirmRequest) => confirm(confirmRequest(request)), [confirm])
  const latest = useRef<ReactNode>(dialog)
  latest.current = dialog
  /**
   * Closes the open question as a cancel, for a question the screen's own state has answered meanwhile (a save's
   * answer). The package has no close of its own yet: this calls the open dialog's own `onOpenChange(false)`, the path
   * Escape takes.
   */
  const close = useCallback(() => {
    const open = latest.current
    const props: unknown = isValidElement(open) ? open.props : null
    if (typeof props === 'object' && props !== null && 'onOpenChange' in props && typeof props.onOpenChange === 'function') props.onOpenChange(false)
  }, [])
  return [ask, dialog, close]
}
