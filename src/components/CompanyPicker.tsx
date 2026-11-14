import { Button, Dialog, SelectableList } from '@ten98/ui'
import { useEffect } from 'react'
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
  // `@ten98/ui` 0.37.0 Dialog focuses its close button and has no initial-focus option yet, so focus moves to the
  // list's tab stop (the current company, else the first) once the dialog has opened. Replace this effect with the
  // Dialog's initial-focus prop when the design system ships it.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>(`dialog[open] [role="listbox"][aria-label="${listLabel}"] [role="option"][tabindex="0"]`)?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  return <Dialog open={open} onOpenChange={onOpenChange} title='Change company' description='Use the arrow keys to move and Enter to open a company.'>
    {/* Keyed by `open` so each opening starts a fresh list whose tab stop is the current company, not the last one moved to. */}
    <SelectableList key={String(open)} label={listLabel} selectedId={currentId ?? null} emptyMessage='You do not belong to any company yet.'
      items={companies.map(company => ({ id: company.id, title: company.name, meta: roleLabels[company.role],
        status: company.id === currentId ? 'Open now' : company.company ? undefined : company.twoFactorLocked ? 'Needs two-factor' : 'Not set up yet' }))}
      onSelect={id => { onOpenChange(false); if (id !== currentId) onChoose(id) }}
      footer={<Button variant='secondary' onClick={() => { onOpenChange(false); onCreate() }}>Create company</Button>} />
  </Dialog>
}

const listLabel = 'Companies'

export const roleLabels: Record<CompanySummary['role'], string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' }
