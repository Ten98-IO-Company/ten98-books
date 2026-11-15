import { useCallback, useReducer, useRef, useState } from 'react'
import type { MoneyExponent } from '@ten98/runtime/browser'
import { api, ApiError, errMsg } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import type { BillWarning, Voucher } from '../../lib/ledger'
import type { Wire } from '../../lib/money'
import { singleFlight } from '../../lib/masters'
import { blankDraft, draftReducer, keyForSave, saveOutcome, toVoucherBody, type DraftState, type EntryKind, type EntryLayout } from '../../lib/voucher-entry'
import { readStored, sessionStore, writeStored } from '../../lib/working-date'

export type SaveOutcome =
  | { kind: 'saved'; voucher: Wire<Voucher>; warnings: Wire<BillWarning>[]; replayed: boolean }
  | { kind: 'refused'; status: number; code: string | undefined; message: string }
  /** No answer (network, timeout): the outcome is unknown, so the fields stay locked until a retry or a discard. */
  | { kind: 'unknown'; message: string }

const draftKey = (userId: string, companyId: string) => `voucherDraft:${userId}:${companyId}`
type StoredDraft = { state: DraftState; key: string; savedAt: string }
const newKey = () => `voucher-${crypto.randomUUID()}`

/**
 * The voucher being entered: its state (the pure reducer of src/lib/voucher-entry/), its idempotency key and its one
 * save at a time. The key is made when the voucher opens and renewed after a save succeeds, or after a definite refusal
 * once the body changes; a resend after a lost answer is the same save (the server answers `replayed`). No answer, a
 * server error or a gateway error leaves the outcome unknown: the voucher stays locked until "Check and retry" answers.
 * On a lost session the draft is kept in this tab (`voucherDraft:<companyId>`) with its key, and offered back after
 * signing in; it is cleared on save and on discard.
 */
export function useVoucherDraft(userId: string, companyId: string, start: { kind: EntryKind; layout: EntryLayout; date: string }, exponent: MoneyExponent) {
  const { unauthorized } = useApp()
  const [state, dispatch] = useReducer(draftReducer, undefined, () => blankDraft(start.kind, start.layout, start.date))
  const key = useRef(newKey())
  const [busy, setBusy] = useState(false)
  const [unknown, setUnknown] = useState<string | null>(null)
  const [restorable, setRestorable] = useState<StoredDraft | null>(() => {
    const stored = readStored(sessionStore, draftKey(userId, companyId))
    try { return stored ? JSON.parse(stored) as StoredDraft : null } catch { return null }
  })

  // One save at a time: a second accept while one runs is ignored (the masters' tested single flight).
  const flight = useRef(singleFlight())
  // The body a definite refusal answered: a changed body then goes under a new key (keyForSave).
  const refusedBody = useRef<string | null>(null)

  const save = useCallback(async (voucherTypeId: string, current: DraftState): Promise<SaveOutcome | null> => {
    const shape = JSON.stringify(toVoucherBody({ ...current, idempotencyKey: '', voucherTypeId }, exponent))
    key.current = keyForSave({ key: key.current, refusedBody: refusedBody.current }, shape, newKey)
    const body = toVoucherBody({ ...current, idempotencyKey: key.current, voucherTypeId }, exponent)
    const result = await flight.current(async (): Promise<SaveOutcome | null> => {
      setBusy(true)
      try {
        const answer = await api<{ voucher: Wire<Voucher>; warnings: Wire<BillWarning>[]; replayed: boolean }>(`/api/companies/${companyId}/vouchers`, { method: 'POST', body })
        key.current = newKey()
        refusedBody.current = null
        setUnknown(null)
        writeStored(sessionStore, draftKey(userId, companyId), '')
        return { kind: 'saved', ...answer }
      } catch (cause) {
        const status = cause instanceof ApiError ? cause.status : undefined
        const outcome = saveOutcome(status)
        if (outcome === 'signed-out') {
          writeStored(sessionStore, draftKey(userId, companyId), JSON.stringify({ state: current, key: key.current, savedAt: new Date().toISOString() } satisfies StoredDraft))
          unauthorized()
          return null
        }
        if (outcome === 'refused') { refusedBody.current = shape; setUnknown(null); return { kind: 'refused', status: status ?? 0, code: cause instanceof ApiError ? cause.code : undefined, message: errMsg(cause) } }
        // No answer, or a server or gateway error: the voucher may be in the books. Locked until a retry answers.
        setUnknown(errMsg(cause))
        return { kind: 'unknown', message: errMsg(cause) }
      } finally { setBusy(false) }
    })
    return result ?? null
  }, [userId, companyId, exponent, unauthorized])

  /** Takes the draft kept from before a sign-in, with its key, so a resend after a committed save is a replay. */
  const restore = useCallback(() => {
    if (!restorable) return
    key.current = restorable.key
    dispatch({ type: 'restore', state: restorable.state })
    writeStored(sessionStore, draftKey(userId, companyId), '')
    setRestorable(null)
  }, [restorable, userId, companyId])
  const dropRestorable = useCallback(() => { writeStored(sessionStore, draftKey(userId, companyId), ''); setRestorable(null) }, [userId, companyId])
  return { state, dispatch, save, busy, locked: busy || unknown !== null, unknown, restorable, restore, dropRestorable }
}
