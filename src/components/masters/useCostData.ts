import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, errMsg } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import type { CostCategoryRow, CostCentreRow } from '../../lib/cost-centre-forms'

/** The company's cost categories and centres and whether it keeps cost centres, loaded together; `reload` refetches after a change. */
export function useCostData(companyId: string) {
  const { unauthorized } = useApp()
  const [data, setData] = useState<{ categories: CostCategoryRow[]; centres: CostCentreRow[]; enabled: boolean } | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    Promise.all([
      api<{ costCategories: CostCategoryRow[] }>(`/api/companies/${companyId}/cost-categories`, { signal: controller.signal }),
      api<{ costCentres: CostCentreRow[] }>(`/api/companies/${companyId}/cost-centres`, { signal: controller.signal }),
      api<{ costCentres: { enabled: boolean } }>(`/api/companies/${companyId}/cost-centres-setting`, { signal: controller.signal }),
    ]).then(([{ costCategories }, { costCentres }, setting]) => setData({ categories: costCategories, centres: costCentres, enabled: setting.costCentres.enabled })).catch(cause => {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) unauthorized()
      else setError(errMsg(cause))
    })
    return () => controller.abort()
  }, [companyId, attempt])

  const reload = useCallback(() => setAttempt(value => value + 1), [])
  return { categories: data?.categories ?? null, centres: data?.centres ?? null, enabled: data?.enabled ?? null, error, reload }
}

/** Whether the company keeps cost centres (the ledger form says so beside its setting); null while loading or when it cannot be read. */
export function useCostCentresEnabled(companyId: string): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setEnabled(null)
    api<{ costCentres: { enabled: boolean } }>(`/api/companies/${companyId}/cost-centres-setting`, { signal: controller.signal })
      .then(setting => { if (!controller.signal.aborted) setEnabled(setting.costCentres.enabled) }).catch(() => undefined)
    return () => controller.abort()
  }, [companyId])
  return enabled
}
