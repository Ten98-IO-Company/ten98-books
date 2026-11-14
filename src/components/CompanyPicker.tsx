import { Dialog, SelectableList } from '@ten98/ui'
import type { CompanySummary } from '../lib/app-context'

/** Opens another company of the workspace from the keyboard: arrow keys move, Enter opens. */
export function CompanyPicker({ open, onOpenChange, companies, currentId, onChoose }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  companies: readonly CompanySummary[]
  currentId?: string
  onChoose: (companyId: string) => void
}) {
  return <Dialog open={open} onOpenChange={onOpenChange} title='Choose a company' description='Use the arrow keys to move and Enter to open a company.'>
    <SelectableList label='Companies' selectedId={currentId ?? null} emptyMessage='This workspace has no companies yet.'
      items={companies.map(company => ({ id: company.id, title: company.name, status: company.id === currentId ? 'Open now' : undefined }))}
      onSelect={id => { onOpenChange(false); if (id !== currentId) onChoose(id) }} />
  </Dialog>
}
