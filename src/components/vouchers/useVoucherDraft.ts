import { useCallback, useReducer, useRef, useState } from 'react'
import type { MoneyExponent } from '@ten98/runtime/browser'
import { api, ApiError, errMsg } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import type { BillWarning, Voucher } from '../../lib/ledger'
import type { Wire } from '../../lib/money'
import { blankDraft, draftReducer, toVoucherBody, type DraftState, type EntryKind, type EntryLayout } from '../../lib/voucher-entry'
import { readStored, sessionStore, writeStored } from '../../lib/working-date'

export type SaveOutcome =
  | { kind: 'saved'; voucher: Wire<Voucher>; warnings: Wire<BillWarning>[]; replayed: boolean }
  | { kind: 'refused'; status: number; code: string | undefined; message: string }
  /** No answer (network, timeout): the outcome is unknown, so the fields stay locked until a retry or a discard. */
  | { kind: 'unknown'; message: string }

const draftKey = (companyId: string) => `voucherDraft:${companyId}`
type StoredDraft = { state: DraftState; key: string; savedAt: string }
const newKey = () => `voucher-${crypto.randomUUID()}`

/**
 * The voucher being entered: its state (the pure reducer of src/lib/voucher-entry.ts), its idempotency key and its one
 * save at a time. The key is made when the voucher opens and renewed only after a save succeeds, so a resend after a
 * lost answer is the same save (the server answers `replayed`). While a save's outcome is unknown the voucher is locked.
 * On a lost session the draft is kept in this tab (`voucherDraft:<companyId>`) with its key, and offered back after
 * signing in; it is cleared on save and on discard.
 */
export function useVoucherDraft(companyId: string, start: { kind: EntryKind; layout: EntryLayout; date: string }, exponent: MoneyExponent) {
  const { unauthorized } = useApp()
  const [state, dispatch] = useReducer(draftReducer, undefined, () => blankDraft(start.kind, start.layout, start.date))
  const key = useRef(newKey())
  const [busy, setBusy] = useState(false)
  const [unknown, setUnknown] = useState<string | null>(null)
  const flying = useRef(false)
  const [restorable, setRestorable] = useState<StoredDraft | null>(() => {
    const stored = readStored(sessionStore, draftKey(companyId))
    try { return stored ? JSON.parse(stored) as StoredDraft : null } catch { return null }
  })

  const save = useCallback(async (voucherTypeId: string, current: DraftState): Promise<SaveOutcome | null> => {
    if (flying.current) return null
    flying.current = true; setBusy(true)
    const body = toVoucherBody({ ...current, idempotencyKey: key.current, voucherTypeId }, exponent)
    try {
      const answer = await api<{ voucher: Wire<Voucher>; warnings: Wire<BillWarning>[]; replayed: boolean }>(`/api/companies/${companyId}/vouchers`, { method: 'POST', body })
      key.current = newKey()
      setUnknown(null)
      writeStored(sessionStore, draftKey(companyId), '')
      return { kind: 'saved', ...answer }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        writeStored(sessionStore, draftKey(companyId), JSON.stringify({ state: current, key: key.current, savedAt: new Date().toISOString() } satisfies StoredDraft))
        unauthorized()
        return null
      }
      if (cause instanceof ApiError && cause.status > 0) { setUnknown(null); return { kind: 'refused', status: cause.status, code: cause.code, message: errMsg(cause) } }
      const message = errMsg(cause)
      setUnknown(message)
      return { kind: 'unknown', message }
    } finally { flying.current = false; setBusy(false) }
  }, [companyId, exponent, unauthorized])

  /** Takes the draft kept from before a sign-in, with its key, so a resend after a committed save is a replay. */
  const restore = useCallback(() => {
    if (!restorable) return
    key.current = restorable.key
    dispatch({ type: 'restore', state: restorable.state })
    writeStored(sessionStore, draftKey(companyId), '')
    setRestorable(null)
  }, [restorable, companyId])
  const dropRestorable = useCallback(() => { writeStored(sessionStore, draftKey(companyId), ''); setRestorable(null) }, [companyId])
  /**
   * Unlocks the fields after a save whose outcome is unknown. The key is kept: if that save did commit, sending a changed
   * voucher under it answers `idempotency_mismatch` ("may already be saved") instead of posting it twice.
   */
  const discardUnknown = useCallback(() => { setUnknown(null) }, [])

  return { state, dispatch, save, busy, locked: busy || unknown !== null, unknown, discardUnknown, restorable, restore, dropRestorable }
}
