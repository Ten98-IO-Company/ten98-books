import { ShortcutProvider, useCommand } from '@ten98/ui'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError, errMsg } from '../lib/api'
import { commandOf, contextTitles, keepsEscape, type CommandId } from '../lib/commands'
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
  /** Saves the choice; resolves true once it is saved, false when saving failed (the error is in `error`). */
  choose: (keymap: KeymapName) => Promise<boolean>
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
    try { setSetting(await api<KeymapSetting>('/api/account/keymap', { method: 'PUT', body: { keymap } })); return true }
    catch (cause) { if (cause instanceof ApiError && cause.status === 401) onUnauthorized(); else setError(`Could not save your keyboard shortcuts: ${errMsg(cause)}`); return false }
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

// An open dialog, popover or expanded popup owns Escape even when focus has moved outside it.
const popupOpen = () => document.querySelector('dialog[open], :popover-open, [aria-haspopup][aria-expanded="true"], [role="combobox"][aria-expanded="true"]') !== null

/** Whether the focused element keeps Escape for itself (keepsEscape), followed through focus changes. */
function useFocusKeepsEscape() {
  const [keeps, setKeeps] = useState(false)
  useEffect(() => {
    const update = () => setKeeps(keepsEscape(document.activeElement))
    update()
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', update)
    return () => { document.removeEventListener('focusin', update); document.removeEventListener('focusout', update) }
  }, [])
  return keeps
}

function GlobalCommands({ back, onSwitchCompany, onHelp }: { back?: () => void; onSwitchCompany?: () => void; onHelp: () => void }) {
  // A disabled command leaves the key to the browser, so a text field keeps its own Escape; the run-time check covers a
  // key pressed before the focus change has re-rendered, and popups that do not move focus.
  const fieldKeepsEscape = useFocusKeepsEscape()
  useAppCommand('help.keyboard', onHelp)
  useAppCommand('nav.back', () => { if (!keepsEscape(document.activeElement) && !popupOpen()) back?.() }, { enabled: back !== undefined && !fieldKeepsEscape })
  useAppCommand('company.switch', () => onSwitchCompany?.(), { enabled: onSwitchCompany !== undefined })
  return null
}
