import { useEffect, useRef } from 'react'
import { SaveConfirm } from '../masters/entry'

/**
 * "Save this payment?" after Enter on the narration (observed: Enter or Y saves, N goes back to the first field of the
 * layout). The masters' inline question, so Y and N answer it as well as Enter and Escape. It takes focus when it
 * appears: the Enter that opened it was pressed in the narration, which would otherwise keep the next key.
 */
export function AcceptPrompt({ title, summary, onYes, onNo }: { title: string; summary: string; onYes: () => void; onNo: () => void }) {
  const holder = useRef<HTMLDivElement>(null)
  useEffect(() => { window.setTimeout(() => holder.current?.querySelector('button')?.focus(), 0) }, [])
  return <div ref={holder}><SaveConfirm title={title} description={summary} onConfirm={onYes} onCancel={onNo} /></div>
}
