import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, errMsg } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import type { GroupRow, LedgerRow } from '../../lib/masters'

/** The company's groups and ledgers, loaded together; `reload` refetches after a change. */
export function useMasterData(companyId: string) {
  const { unauthorized } = useApp()
  const [data, setData] = useState<{ groups: GroupRow[]; ledgers: LedgerRow[] } | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    Promise.all([
      api<{ groups: GroupRow[] }>(`/api/companies/${companyId}/groups`, { signal: controller.signal }),
      api<{ ledgers: LedgerRow[] }>(`/api/companies/${companyId}/ledgers`, { signal: controller.signal }),
    ]).then(([{ groups }, { ledgers }]) => setData({ groups, ledgers })).catch(cause => {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) unauthorized()
      else setError(errMsg(cause))
    })
    return () => controller.abort()
  }, [companyId, attempt])

  const reload = useCallback(() => setAttempt(value => value + 1), [])
  return { groups: data?.groups ?? null, ledgers: data?.ledgers ?? null, error, reload }
}
