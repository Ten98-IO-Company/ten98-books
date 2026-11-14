import { Alert } from '@ten98/ui'
import { useCostCentresEnabled } from '../masters/useCostData'

/**
 * The cost reports' notice when the company has cost centres switched off, titled as on the masters screen. The report
 * still shows what was saved, because saved allocations keep counting.
 */
export function CostCentresOff({ companyId }: { companyId: string }) {
  const enabled = useCostCentresEnabled(companyId)
  if (enabled !== false) return null
  return <Alert tone='info' title='Cost centres are switched off for this company'>
    Vouchers do not ask for cost centres until an owner or admin switches them on. Amounts saved before still count here.
  </Alert>
}
