import { useCallback, useEffect, useRef, useState } from 'react'
import { parseMoney, type MoneyExponent } from '@ten98/runtime/browser'
import { api, ApiError } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import type { BillPickerRow } from '../../lib/bills'
import type { CounterLedger, NextNumber, Side } from '../../lib/ledger'
import type { Wire } from '../../lib/money'
import type { PendingChoice } from '../../lib/voucher-entry'

/**
 * The voucher entry screen's reads (docs/LEDGER.md, "Voucher entry reads"): the expected number, the resulting balances,
 * the counter ledger from history and a party's pending bills. Each answers the latest request only: an earlier answer
 * that arrives late is dropped, and a lost session goes to sign-in.
 */

/** The number the next regular voucher of the type would take on the date, or null while unknown. */
export function useNextNumber(companyId: string, voucherTypeId: string | null, date: string, refresh: number): number | null {
  const { unauthorized } = useApp()
  const [number, setNumber] = useState<number | null>(null)
  useEffect(() => {
    if (!voucherTypeId) return
    const controller = new AbortController()
    setNumber(null)
    api<NextNumber>(`/api/companies/${companyId}/voucher-types/${voucherTypeId}/next-number?date=${date}`, { signal: controller.signal })
      .then(found => { if (!controller.signal.aborted) setNumber(found.number) })
      .catch(cause => { if (!controller.signal.aborted && cause instanceof ApiError && cause.status === 401) unauthorized() })
    return () => controller.abort()
  }, [companyId, voucherTypeId, date, refresh])
  return number
}

export type PreviewLine = { ledgerId: string; side: Side; amount: string }

/**
 * Each named ledger's balance at the date with the draft applied (signed minor units, positive on the debit side), from
 * the one preview read: the draft's complete lines, and `others` (the single-entry Account before its first line, a
 * ledger chosen without an amount yet) named in its `ledgers`. The screen computes no balance itself.
 */
export function useResultingBalances(companyId: string, date: string, lines: readonly PreviewLine[], others: readonly string[], exponent: MoneyExponent): ReadonlyMap<string, bigint> {
  const { unauthorized } = useApp()
  const [balances, setBalances] = useState<ReadonlyMap<string, bigint>>(new Map())
  const key = JSON.stringify([date, lines, others])
  useEffect(() => {
    const controller = new AbortController()
    const ledgers = [...new Set(others)]
    if (!lines.length && !ledgers.length) { setBalances(new Map()); return }
    api<{ balances: { ledgerId: string; balance: string }[] }>(`/api/companies/${companyId}/vouchers/balance-preview`, { method: 'POST', body: { date, lines, ledgers }, signal: controller.signal })
      .then(found => { if (!controller.signal.aborted) setBalances(new Map(found.balances.map(entry => [entry.ledgerId, parseMoney(entry.balance, exponent)]))) })
      .catch(cause => { if (!controller.signal.aborted && cause instanceof ApiError && cause.status === 401) unauthorized() })
    return () => controller.abort()
  }, [companyId, key])
  return balances
}

/**
 * The counter ledger a new double-entry line proposes after a line on `ledgerId` on `side`, read when that line's ledger
 * commits and kept for the voucher. `counterOf` answers what is known now (undefined while the read runs); `onAnswer`
 * hears late answers, so a line appended before the read answered can still take it.
 */
export function useCounterLedgers(companyId: string, voucherTypeId: string | null, onAnswer: (ledgerId: string, side: Side, counter: string | null) => void) {
  const known = useRef(new Map<string, string | null>())
  const asked = useRef(new Set<string>())
  const latest = useRef(onAnswer)
  latest.current = onAnswer
  useEffect(() => { known.current.clear(); asked.current.clear() }, [companyId, voucherTypeId])
  const read = useCallback((ledgerId: string, side: Side) => {
    const key = `${voucherTypeId}:${ledgerId}:${side}`
    if (!voucherTypeId || asked.current.has(key)) return
    asked.current.add(key)
    api<CounterLedger>(`/api/companies/${companyId}/ledgers/${ledgerId}/counter-ledger?voucherTypeId=${voucherTypeId}&side=${side}`)
      .then(found => { known.current.set(key, found.counter?.ledgerId ?? null); latest.current(ledgerId, side, found.counter?.ledgerId ?? null) })
      .catch(() => asked.current.delete(key))
  }, [companyId, voucherTypeId])
  const counterOf = useCallback((ledgerId: string, side: Side): string | null | undefined => known.current.get(`${voucherTypeId}:${ledgerId}:${side}`), [voucherTypeId])
  const reset = useCallback(() => { known.current.clear(); asked.current.clear() }, [])
  return { read, counterOf, reset }
}

/** A party's bills pending at the voucher date, in name order (the picker read), for the bill panel. */
export async function readPendingBills(companyId: string, ledgerId: string, date: string, exponent: MoneyExponent): Promise<PendingChoice[]> {
  const { bills } = await api<{ bills: Wire<BillPickerRow>[] }>(`/api/companies/${companyId}/ledgers/${ledgerId}/bills?asOf=${date}&scope=pending&sort=name`)
  return bills.map(bill => ({ billId: bill.billId, name: bill.name, billDate: bill.billDate, dueDate: bill.dueDate, pending: parseMoney(bill.pending, exponent), finalPending: parseMoney(bill.finalPending, exponent) }))
}
