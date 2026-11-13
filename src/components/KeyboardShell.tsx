import { ShortcutProvider, useCommand } from '@ten98/ui'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError, errMsg } from '../lib/api'
import { commandOf, contextTitles, type CommandId } from '../lib/commands'
import { defaultKeymap, keymaps, type KeymapName } from '../lib/keymaps'
import { KeyboardHelp } from './KeyboardHelp'

type KeymapSetting = { keymap: KeymapName; chosen: boolean }

export type KeyboardState = {
  /** The active keymap: the saved choice, or the default until it loads or while none is saved. */
  keymap: KeymapName
  /** null while loading or after a failed load; false until the user picks a keymap. */
  chosen: boolean | null
  saving: boolean
  error: string
  choose: (keymap: KeymapName) => Promise<void>
  openHelp: () => void
}

const KeyboardContext = createContext<KeyboardState | null>(null)

export function useKeyboard(): KeyboardState {
  const state = useContext(KeyboardContext)
  if (!state) throw new Error('useKeyboard is only available inside KeyboardShell.')
  return state
}

/** Registers a command from the registry (commands.ts) in the nearest ShortcutScope, with its title and context heading. */
export function useAppCommand(id: CommandId, run: () => void, { enabled = true, repeat = false } = {}) {
  const command = commandOf(id)
  useCommand({ id, label: command.title, group: contextTitles[command.context], run, enabled, repeat })
}

/**
 * The keyboard layer of the signed-in shell (D-05): loads the user's keymap, mounts the `@ten98/ui` shortcut registry
 * with both keymaps, registers the global commands and owns the keyboard help dialog.
 */
export function KeyboardShell({ userId, onUnauthorized, back, onSwitchCompany, children }: {
  userId: string
  onUnauthorized: () => void
  /** Goes back one level from the current page; undefined where Escape should keep its native meaning. */
  back?: () => void
  /** Opens the company picker; undefined while the workspace has no companies. */
  onSwitchCompany?: () => void
  children: ReactNode
}) {
  const [setting, setSetting] = useState<KeymapSetting | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [helpOpen, setHelpOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setSetting(null)
    api<KeymapSetting>('/api/account/keymap', { signal: controller.signal }).then(setSetting).catch(cause => {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized()
      else setError(`Your keyboard shortcuts could not be loaded, so the default keys apply: ${errMsg(cause)}`)
    })
    return () => controller.abort()
  }, [userId])

  const choose = useCallback(async (keymap: KeymapName) => {
    setSaving(true); setError('')
    try { setSetting(await api<KeymapSetting>('/api/account/keymap', { method: 'PUT', body: { keymap } })) }
    catch (cause) { if (cause instanceof ApiError && cause.status === 401) onUnauthorized(); else setError(`Could not save your keyboard shortcuts: ${errMsg(cause)}`) }
    finally { setSaving(false) }
  }, [onUnauthorized])
  const openHelp = useCallback(() => setHelpOpen(true), [])

  const keymap = setting?.keymap ?? defaultKeymap
  const state = useMemo<KeyboardState>(() => ({ keymap, chosen: setting?.chosen ?? null, saving, error, choose, openHelp }), [keymap, setting, saving, error, choose, openHelp])

  return <KeyboardContext value={state}>
    <ShortcutProvider keymaps={keymaps} keymap={keymap}>
      <GlobalCommands back={back} onSwitchCompany={onSwitchCompany} onHelp={openHelp} />
      {children}
      <KeyboardHelp open={helpOpen} onOpenChange={setHelpOpen} keymap={keymap} />
    </ShortcutProvider>
  </KeyboardContext>
}

function GlobalCommands({ back, onSwitchCompany, onHelp }: { back?: () => void; onSwitchCompany?: () => void; onHelp: () => void }) {
  useAppCommand('help.keyboard', onHelp)
  useAppCommand('nav.back', () => back?.(), { enabled: back !== undefined })
  useAppCommand('company.switch', () => onSwitchCompany?.(), { enabled: onSwitchCompany !== undefined })
  return null
}
