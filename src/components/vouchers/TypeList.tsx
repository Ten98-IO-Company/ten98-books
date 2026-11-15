import { Dialog } from '@ten98/ui'
import { useRef, useState } from 'react'
import { KeyboardMenu } from '../KeyboardMenu'
import { DialogKeys } from '../KeyboardShell'
import type { CommandId } from '../../lib/commands'
import { entryKinds, kindTitles, type EntryKind } from '../../lib/voucher-entry'

const typeCommands: Record<EntryKind, CommandId> = {
  payment: 'entry.voucher.payment', receipt: 'entry.voucher.receipt', contra: 'entry.voucher.contra', journal: 'entry.voucher.journal',
}

/** The type list (F10): the other voucher types, each picked by Enter or its own type key; the current one is left out. */
export function TypeList({ open, current, onPick, onClose }: { open: boolean; current: EntryKind; onPick: (kind: EntryKind) => void; onClose: () => void }) {
  const others = entryKinds.filter(kind => kind !== current)
  const [active, setActive] = useState<CommandId>(typeCommands[others[0]])
  const menu = useRef<HTMLElement>(null)
  return <DialogKeys name='Voucher types' open={open}>
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }} title='Choose another voucher type'
      description={`Now: ${kindTitles[current]}. The lines and narration are kept and laid out again in the new type.`} initialFocus={menu}>
      {open && <KeyboardMenu label='Voucher types' menuRef={menu} active={active} onActiveChange={setActive}
        groups={[{ id: 'types', label: 'Voucher types', items: others.map(kind => ({ command: typeCommands[kind], label: kindTitles[kind], open: () => onPick(kind) })) }]} />}
    </Dialog>
  </DialogKeys>
}
