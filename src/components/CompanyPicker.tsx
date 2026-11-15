import { Button, Dialog, SelectableList } from '@ten98/ui'
import type { CompanySummary } from '../lib/app-context'
import { roleLabels } from '../lib/company'
import { DialogKeys } from './KeyboardShell'

/** Changes company from the keyboard: arrow keys move, Enter opens. Each company is its own workspace (D-03). */
export function CompanyPicker({ open, onOpenChange, companies, currentId, onChoose, onCreate }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  companies: readonly CompanySummary[]
  currentId?: string
  onChoose: (companyId: string) => void
  onCreate: () => void
}) {
  return <DialogKeys name='Change company' open={open}><Dialog open={open} onOpenChange={onOpenChange} title='Change company' description='Use the arrow keys to move and Enter to open a company.' initialFocus={listStop}>
    {/* Keyed by `open` so each opening starts a fresh list whose tab stop is the current company, not the last one moved to. */}
    <SelectableList key={String(open)} label={listLabel} selectedId={currentId ?? null} emptyMessage='You do not belong to any company yet.'
      items={companies.map(company => ({ id: company.id, title: company.name, meta: roleLabels[company.role],
        status: company.id === currentId ? 'Open now' : company.company ? undefined : company.twoFactorLocked ? 'Needs two-factor' : 'Not set up yet' }))}
      onSelect={id => { onOpenChange(false); if (id !== currentId) onChoose(id) }}
      footer={<Button variant='secondary' onClick={() => { onOpenChange(false); onCreate() }}>Create company</Button>} />
  </Dialog></DialogKeys>
}

const listLabel = 'Companies'

/** The list's tab stop (the current company, else the first): focus starts there when the dialog opens. */
const listStop = { get current() { return document.querySelector<HTMLElement>(`dialog[open] [role="listbox"][aria-label="${listLabel}"] [role="option"][tabindex="0"]`) } }

