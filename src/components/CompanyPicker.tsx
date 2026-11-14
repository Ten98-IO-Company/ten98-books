import { Button, Dialog, SelectableList } from '@ten98/ui'
import type { CompanySummary } from '../lib/app-context'

/** Changes company from the keyboard: arrow keys move, Enter opens. Each company is its own workspace (D-03). */
export function CompanyPicker({ open, onOpenChange, companies, currentId, onChoose, onCreate }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  companies: readonly CompanySummary[]
  currentId?: string
  onChoose: (companyId: string) => void
  onCreate: () => void
}) {
  return <Dialog open={open} onOpenChange={onOpenChange} title='Change company' description='Use the arrow keys to move and Enter to open a company.'>
    <SelectableList label='Companies' selectedId={currentId ?? null} emptyMessage='You do not belong to any company yet.'
      items={companies.map(company => ({ id: company.id, title: company.name, meta: roleLabels[company.role],
        status: company.id === currentId ? 'Open now' : company.company ? undefined : company.twoFactorLocked ? 'Needs two-factor' : 'Not set up yet' }))}
      onSelect={id => { onOpenChange(false); if (id !== currentId) onChoose(id) }}
      footer={<Button variant='secondary' onClick={() => { onOpenChange(false); onCreate() }}>Create company</Button>} />
  </Dialog>
}

export const roleLabels: Record<CompanySummary['role'], string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' }
