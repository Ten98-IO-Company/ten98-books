import { Button, Dialog, Stack } from '@ten98/ui'
import { useRef } from 'react'
import { DialogKeys } from '../KeyboardShell'
import { layoutTitles, type EntryLayout } from '../../lib/voucher-entry'

const layoutNotes: Record<EntryLayout, string> = {
  single: 'An Account (cash or bank) and the lines on the other side.',
  double: 'Each line with its own side, debit or credit.',
}

/** The layout list (Ctrl+H): single or double entry for payment, receipt and contra. The choice holds for all three in this tab. */
export function ModeList({ open, current, onPick, onClose }: { open: boolean; current: EntryLayout; onPick: (layout: EntryLayout) => void; onClose: () => void }) {
  const other: EntryLayout = current === 'single' ? 'double' : 'single'
  const first = useRef<HTMLButtonElement>(null)
  return <DialogKeys name='Entry layout' open={open}>
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }} title='Change the entry layout'
      description={`Now: ${layoutTitles[current]}. Payment, receipt and contra open in the chosen layout from now on in this tab.`} initialFocus={first}>
      <Stack gap={2}>
        <Button ref={first} onClick={() => onPick(other)}>{layoutTitles[other]}: {layoutNotes[other]}</Button>
        <Button variant='secondary' onClick={onClose}>Keep {layoutTitles[current].toLowerCase()}</Button>
      </Stack>
    </Dialog>
  </DialogKeys>
}
