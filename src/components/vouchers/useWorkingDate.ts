import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../../lib/app-context'
import { readWorkingDate, sessionStore, startingWorkingDate, writeWorkingDate } from '../../lib/working-date'
import { loadDefaults } from '../reports/navigation'

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
