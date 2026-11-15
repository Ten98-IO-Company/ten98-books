import { useCallback, useReducer, useRef, useState } from 'react'
import type { MoneyExponent } from '@ten98/runtime/browser'
import { api, ApiError, errMsg } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import type { BillWarning, Voucher } from '../../lib/ledger'
import type { Wire } from '../../lib/money'
import { allowedWhileLocked, blankDraft, createSaver, draftReducer, isEntryKind, toVoucherBody, type DraftAction, type DraftState, type EntryKind, type EntryLayout } from '../../lib/voucher-entry'
import { readStored, sessionStore, writeStored } from '../../lib/working-date'

type SaveAnswer = { voucher: Wire<Voucher>; warnings: Wire<BillWarning>[]; replayed: boolean }
export type SaveOutcome =
  | { kind: 'saved' } & SaveAnswer
  | { kind: 'refused'; status: number; code: string | undefined; message: string }
  /** No answer, a server or a gateway error: the outcome is unknown, so the fields stay locked until a retry answers. */
  | { kind: 'unknown'; message: string }

const draftKey = (userId: string, companyId: string) => `voucherDraft:${userId}:${companyId}`
type StoredDraft = { state: DraftState; key: string; savedAt: string }
const newKey = () => `voucher-${crypto.randomUUID()}`

/** A draft kept in this tab before a sign-in, or null when the text is not one (another version, or damaged). */
function storedDraftOf(text: string | null): StoredDraft | null {
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || !('state' in parsed) || !('key' in parsed) || !('savedAt' in parsed)) return null
    const { state, key, savedAt } = parsed
    if (typeof key !== 'string' || typeof savedAt !== 'string' || typeof state !== 'object' || state === null || !('kind' in state) || !isEntryKind(state.kind) || !('lines' in state) || !Array.isArray(state.lines)) return null
    // The shape was written by this module (`save` on a lost session) in this tab; the checks above refuse anything else.
    return { state: state as DraftState, key, savedAt }
  } catch { return null }
}

/**
 * The voucher being entered: its state (the pure reducer of src/lib/voucher-entry/) and its saves through `createSaver`:
 * one at a time, one key per draft content until a definite answer, the same key after an unknown outcome (no answer,
 * a server or a gateway error), which locks the voucher until "Check and retry" answers. While locked, nothing changes
 * the draft (`allowedWhileLocked`). On a lost session the draft is kept in this tab with its key and offered back after
 * signing in; it is cleared on save and on discard.
 */
export function useVoucherDraft(userId: string, companyId: string, start: { kind: EntryKind; layout: EntryLayout; date: string }, exponent: MoneyExponent) {
  const { unauthorized } = useApp()
  const [state, dispatchAny] = useReducer(draftReducer, undefined, () => blankDraft(start.kind, start.layout, start.date))
  const saver = useRef(createSaver<SaveAnswer>(newKey, cause => cause instanceof ApiError ? cause.status : undefined))
  const [busy, setBusy] = useState(false)
  const [unknown, setUnknown] = useState<string | null>(null)
  const lockedNow = useRef(false)
  lockedNow.current = busy || unknown !== null
  const [restorable, setRestorable] = useState<StoredDraft | null>(() => storedDraftOf(readStored(sessionStore, draftKey(userId, companyId))))

  /** Every change to the draft goes through here: while a save runs or its outcome is unknown, only the save's own steps pass. */
  const dispatch = useCallback((action: DraftAction) => { if (!lockedNow.current || allowedWhileLocked(action)) dispatchAny(action) }, [])

  const save = useCallback(async (voucherTypeId: string, current: DraftState): Promise<SaveOutcome | null> => {
    const content = JSON.stringify(toVoucherBody({ ...current, idempotencyKey: '', voucherTypeId }, exponent))
    const attempt = await saver.current.save(content, async key => {
      setBusy(true); lockedNow.current = true
      try { return await api<SaveAnswer>(`/api/companies/${companyId}/vouchers`, { method: 'POST', body: toVoucherBody({ ...current, idempotencyKey: key, voucherTypeId }, exponent) }) }
      finally { setBusy(false) }
    })
    // A second press while one save runs is dropped and changes nothing.
    if (!attempt) return null
    if (attempt.outcome === 'saved') {
      setUnknown(null); lockedNow.current = false
      writeStored(sessionStore, draftKey(userId, companyId), '')
      return { kind: 'saved', ...attempt.answer }
    }
    if (attempt.outcome === 'signed-out') {
      writeStored(sessionStore, draftKey(userId, companyId), JSON.stringify({ state: current, key: attempt.key, savedAt: new Date().toISOString() } satisfies StoredDraft))
      unauthorized()
      return null
    }
    if (attempt.outcome === 'refused') {
      setUnknown(null); lockedNow.current = false
      return { kind: 'refused', status: attempt.status ?? 0, code: attempt.error instanceof ApiError ? attempt.error.code : undefined, message: errMsg(attempt.error) }
    }
    setUnknown(errMsg(attempt.error)); lockedNow.current = true
    return { kind: 'unknown', message: errMsg(attempt.error) }
  }, [userId, companyId, exponent, unauthorized])

  /** Takes the draft kept from before a sign-in, with its key, so a resend after a committed save is a replay. */
  const restore = useCallback(() => {
    if (!restorable) return
    saver.current.useKey(restorable.key)
    dispatchAny({ type: 'restore', state: restorable.state })
    writeStored(sessionStore, draftKey(userId, companyId), '')
    setRestorable(null)
  }, [restorable, userId, companyId])
  const dropRestorable = useCallback(() => { writeStored(sessionStore, draftKey(userId, companyId), ''); setRestorable(null) }, [userId, companyId])
  const isLocked = useCallback(() => lockedNow.current, [])
  return { state, dispatch, save, busy, locked: busy || unknown !== null, isLocked, unknown, restorable, restore, dropRestorable }
}
