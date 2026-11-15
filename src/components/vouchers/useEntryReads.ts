import { useCallback, useEffect, useRef, useState } from 'react'
import { parseMoney, subtractMoney, type MoneyExponent } from '@ten98/runtime/browser'
import { api, ApiError } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import type { BillPickerRow } from '../../lib/bills'
import { financialYearOf } from '../../lib/company'
import type { CounterLedger, NextNumber, Side, TrialBalanceRow } from '../../lib/ledger'
import type { Wire } from '../../lib/money'
import type { PendingChoice } from '../../lib/voucher-entry'
import { readWorkingDate, sessionStore, startingWorkingDate, writeWorkingDate } from '../../lib/working-date'
import { loadDefaults } from '../reports/navigation'

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
 * Each named ledger's balance at the date with the draft applied (signed minor units, positive on the debit side): the
 * preview read for the draft's complete lines, and the plain balance for a ledger chosen without an amount yet (the
 * single-entry Account before its first line). The screen computes no balance itself.
 */
export function useResultingBalances(companyId: string, date: string, lines: readonly PreviewLine[], others: readonly string[], financialYearStart: { month: number; day: number }, exponent: MoneyExponent): ReadonlyMap<string, bigint> {
  const { unauthorized } = useApp()
  const [balances, setBalances] = useState<ReadonlyMap<string, bigint>>(new Map())
  const key = JSON.stringify([date, lines, others])
  useEffect(() => {
    const controller = new AbortController()
    const from = financialYearOf(financialYearStart, date).from
    const named = new Set(lines.map(line => line.ledgerId))
    const plain = [...new Set(others)].filter(ledgerId => !named.has(ledgerId))
    Promise.all([
      lines.length ? api<{ balances: { ledgerId: string; balance: string }[] }>(`/api/companies/${companyId}/vouchers/balance-preview`, { method: 'POST', body: { date, lines }, signal: controller.signal })
        .then(found => found.balances.map(entry => [entry.ledgerId, parseMoney(entry.balance, exponent)] as const)) : Promise.resolve([]),
      ...plain.map(ledgerId => api<{ balance: Wire<TrialBalanceRow> }>(`/api/companies/${companyId}/ledgers/${ledgerId}/balance?from=${from}&to=${date}`, { signal: controller.signal })
        .then(found => [ledgerId, subtractMoney(parseMoney(found.balance.closingDebit, exponent), parseMoney(found.balance.closingCredit, exponent))] as const)),
    ]).then(([preview, ...rest]) => { if (!controller.signal.aborted) setBalances(new Map([...preview, ...rest])) })
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
  return { read, counterOf }
}

const workingListeners = new Set<() => void>()

/**
 * The tab's working date for the signed-in user and the company (src/lib/working-date.ts): the kept one, else the last
 * voucher date from the report defaults; null while that loads. The setter keeps it and tells every screen of the tab
 * that shows it.
 */
export function useWorkingDate(company: { id: string; booksBeginning: string }): [string | null, (date: string) => void] {
  const { me } = useApp()
  const userId = me.user.id
  const read = useCallback(() => readWorkingDate(sessionStore, userId, company.id, company.booksBeginning), [userId, company.id, company.booksBeginning])
  const [date, setDate] = useState(read)
  useEffect(() => {
    let live = true
    const listener = () => { const kept = read(); if (kept) setDate(kept) }
    workingListeners.add(listener)
    const kept = read()
    if (kept) setDate(kept)
    else loadDefaults(company.id).then(found => { if (live) setDate(startingWorkingDate(found)) }).catch(() => undefined)
    return () => { live = false; workingListeners.delete(listener) }
  }, [read])
  const change = useCallback((next: string) => {
    writeWorkingDate(sessionStore, userId, company.id, next)
    for (const listener of workingListeners) listener()
  }, [userId, company.id])
  return [date, change]
}

/** A party's bills pending at the voucher date, in name order (the picker read), for the bill panel. */
export async function readPendingBills(companyId: string, ledgerId: string, date: string, exponent: MoneyExponent): Promise<PendingChoice[]> {
  const { bills } = await api<{ bills: Wire<BillPickerRow>[] }>(`/api/companies/${companyId}/ledgers/${ledgerId}/bills?asOf=${date}&scope=pending&sort=name`)
  return bills.map(bill => ({ billId: bill.billId, name: bill.name, billDate: bill.billDate, dueDate: bill.dueDate, pending: parseMoney(bill.pending, exponent), finalPending: parseMoney(bill.finalPending, exponent) }))
}
