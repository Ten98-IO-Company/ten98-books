import type { Dispatch, RefObject, SetStateAction } from 'react'
import { resolveLookup, type Choice } from '../../lib/masters'
import { entryText, focusEntryField } from './entry'

/** One lookup field of a form: what it offers, how a chosen value changes the form, and what a blank field says. */
export type LookupSpec<V, A> = { options: readonly Choice[]; current: (from: V) => string; actions: (value: string, from: V) => A[]; blank: string }

/**
 * The lookup handling the masters forms share: what typed text means (`settle`: its single matching choice, or an error
 * on that field), Enter on typed text with no row highlighted (`typedEnter`), and settling every lookup from the text on
 * screen before a save (`settleAll`). A lookup never keeps free text (`resolveLookup` in src/lib/masters.ts).
 * `advance` is called with the field to leave after a typed pick on Enter, once the new value is on screen.
 */
export function useEntryLookups<V, A extends { type: string }, F extends string>({ form, values, reduce, dispatch, specs, order, shown = () => true, setErrors, advance }: {
  form: RefObject<HTMLElement | null>
  values: V
  reduce: (state: V, action: A) => V
  dispatch: (action: A) => void
  specs: Record<F, LookupSpec<V, A>>
  /** The lookups in keyboard order. */
  order: readonly F[]
  /** Whether a lookup is on this form for these values (a conditional field). */
  shown?: (field: F, from: V) => boolean
  setErrors: Dispatch<SetStateAction<Partial<Record<F, string>>>>
  advance: (from: F) => void
}) {
  /** Applies what was typed in one lookup to `from`: its single matching choice, or an error on that field (null). */
  function settle(field: F, text: string, from: V): V | null {
    const spec = specs[field]
    const result = resolveLookup(spec.options, text, spec.current(from))
    const error = 'error' in result ? result.error : result.value === '' ? spec.blank : ''
    if (error) { setErrors(previous => ({ ...previous, [field]: error })); return null }
    setErrors(previous => ({ ...previous, [field]: undefined }))
    if ('error' in result || result.value === spec.current(from)) return from
    let next = from
    for (const action of spec.actions(result.value, from)) { next = reduce(next, action); dispatch(action) }
    return next
  }

  /** Typed lookup text with no row highlighted, on Enter or the accept chord: pick the one choice it names or show the error here. */
  function typedEnter(field: F, text: string, move: boolean): 'picked' | 'error' | 'unchanged' {
    const spec = specs[field]
    const result = resolveLookup(spec.options, text, spec.current(values))
    // Text that names the value already chosen changes nothing, but Enter still moves on.
    if ('value' in result && result.value === spec.current(values)) { if (move) window.setTimeout(() => advance(field), 0); return 'unchanged' }
    if (!settle(field, text, values)) return 'error'
    if (move) window.setTimeout(() => advance(field), 0)
    return 'picked'
  }

  /** Every lookup settled from the text on screen, or null with the problem shown on the first that fails (focus goes there). */
  function settleAll(): V | null {
    let next = values
    for (const field of order) {
      const text = entryText(form.current, field)
      if (text === null || !shown(field, next)) continue
      const settled = settle(field, text, next)
      if (!settled) { focusEntryField(form.current, field); return null }
      next = settled
    }
    return next
  }

  return { settle, typedEnter, settleAll, isLookup: (name: string): name is F => name in specs }
}
