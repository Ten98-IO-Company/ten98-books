import { useEffect, useReducer, useRef, useState } from 'react'
import type { MoneyExponent } from '@ten98/runtime/browser'
import { api, ApiError, errMsg } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import type { BillWarning, Voucher } from '../../lib/ledger'
import type { Wire } from '../../lib/money'
import { blankDraft, createDraftController, isLocked, toVoucherBody, type DraftState, type EntryKind, type EntryLayout, type SendFailure } from '../../lib/voucher-entry'
import { readStored, sessionStore, writeStored } from '../../lib/working-date'

/** `warnings` may carry codes beyond the bill warnings (a later slice's): the screen ignores the ones it does not know. */
export type SaveAnswer = { voucher: Wire<Voucher>; warnings: readonly ({ code: string } & Partial<Wire<BillWarning>>)[]; replayed: boolean }

const draftKey = (userId: string, companyId: string) => `voucherDrafts:${userId}:${companyId}`
const newKey = () => `voucher-${crypto.randomUUID()}`
const failureOf = (error: unknown): SendFailure => error instanceof ApiError
  // Status 0: no answer, or one that could not be read.
  ? { status: error.status === 0 ? undefined : error.status, code: error.code, message: errMsg(error), json: error.json }
  : { status: undefined, code: undefined, message: errMsg(error), json: false }

/**
 * The voucher on screen: the draft controller of src/lib/voucher-entry/ (one state machine for the content, the key,
 * the save and the drafts kept across a lost session) bound to the voucher API and this tab's session storage. The
 * screen renders from `machine` and changes the draft only through `edit`, which the machine refuses while locked.
 */
export function useVoucherDraft(userId: string, companyId: string, start: { kind: EntryKind; layout: EntryLayout; date: string }, exponent: MoneyExponent) {
  const { unauthorized } = useApp()
  /** What a lost session does: the screen sets it to go to signing in past its leave question (the draft is kept by then). */
  const signedOut = useRef(unauthorized)
  const [, render] = useReducer((count: number) => count + 1, 0)
  const [controller] = useState(() => createDraftController<SaveAnswer>({
    start: blankDraft(start.kind, start.layout, start.date),
    makeKey: newKey,
    store: { read: () => readStored(sessionStore, draftKey(userId, companyId)), write: text => writeStored(sessionStore, draftKey(userId, companyId), text) },
    send: body => { const value: unknown = JSON.parse(body); return api<SaveAnswer>(`/api/companies/${companyId}/vouchers`, { method: 'POST', body: value }) },
    failureOf,
    onChange: render,
    onSignedOut: () => signedOut.current(),
  }))
  // Development mode mounts effects twice, running the cleanup in between: shown again on every mount.
  useEffect(() => { controller.onScreen(true); return () => controller.onScreen(false) }, [controller])
  const machine = controller.machine()
  /** Sends the draft on screen under its key; null when the machine refuses (a save running, or the draft locked). */
  const save = (voucherTypeId: string) => {
    const { draft, key } = controller.machine()
    return controller.save(JSON.stringify(toVoucherBody({ ...draft, idempotencyKey: key, voucherTypeId }, exponent)))
  }
  return {
    machine, state: machine.draft, locked: isLocked(machine), busy: machine.phase === 'sending',
    /** The machine as of now, for keys and events that run before React renders the last change. */
    current: controller.machine,
    edit: controller.edit, problem: controller.problem, save, retry: controller.retry, settled: controller.settled,
    discard: (draft: DraftState) => controller.discard(draft), restore: controller.restore, drop: controller.drop, signedOut,
  }
}
