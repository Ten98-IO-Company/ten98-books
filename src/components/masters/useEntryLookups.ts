import type { Dispatch, RefObject, SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import { inOnePress } from '../../lib/key-press-steps'
import { typedOutcome, typedOutcomeMoves } from '../../lib/lookup-entry'
import type { Choice } from '../../lib/masters'
import { entryText, focusEntryField } from './entry'

/** One lookup field of a form: what it offers, how a chosen value changes the form, and what a blank field says. */
export type LookupSpec<V, A> = { options: readonly Choice[]; current: (from: V) => string; actions: (value: string, from: V) => A[]; blank: string }

/**
 * The lookup handling every masters form shares: what typed text means (`settle`: its single matching choice, or an error
 * on that field), Enter on typed text with no row highlighted (`typedEnter`), and settling every lookup from the text on
 * screen before a save (`settleAll`). A lookup never keeps free text. The decisions are pure (`typedOutcome` in
 * src/lib/lookup-entry.ts); this applies them. `advance` is called with the field to leave once the cursor should move on.
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
    const outcome = typedOutcome(spec.options, text, spec.current(from), spec.blank)
    if (outcome.kind === 'error') { setErrors(previous => ({ ...previous, [field]: outcome.message })); return null }
    setErrors(previous => ({ ...previous, [field]: undefined }))
    if (outcome.kind === 'keep') return from
    let next = from
    for (const action of spec.actions(outcome.value, from)) { next = reduce(next, action); dispatch(action) }
    return next
  }

  /**
   * Typed lookup text with no row highlighted, on Enter (`move`) or the accept chord: pick the one choice it names or show
   * the error here. Called from the lookup's key handler. The pick is committed at once (a pick can change which fields
   * the form shows) and focus moves to the field that is next after that change before the handler returns, so text
   * typed straight after Enter lands there (`inOnePress`).
   */
  function typedEnter(field: F, text: string, move: boolean): 'picked' | 'error' | 'unchanged' {
    const spec = specs[field]
    const outcome = typedOutcome(spec.options, text, spec.current(values), spec.blank)
    inOnePress({ commit: flushSync, change: () => { settle(field, text, values) },
      then: outcome.kind !== 'error' && typedOutcomeMoves(outcome, move) ? () => advance(field) : undefined })
    if (outcome.kind === 'error') return 'error'
    return outcome.kind === 'pick' ? 'picked' : 'unchanged'
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
