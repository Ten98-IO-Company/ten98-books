import { useConfirmDialog, type ConfirmRequest } from '@ten98/ui'
import { useCallback, type ReactNode } from 'react'

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
export function useConfirm(): [(request: AppConfirmRequest) => Promise<boolean>, ReactNode] {
  const [confirm, dialog] = useConfirmDialog()
  const ask = useCallback((request: AppConfirmRequest) => confirm(confirmRequest(request)), [confirm])
  return [ask, dialog]
}
