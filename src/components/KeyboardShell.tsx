import { Dialog, ShortcutProvider, ShortcutScope, useCommand, useCommandKeys } from '@ten98/ui'
import { useNavigate, useParams } from '@tanstack/react-router'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, errMsg } from '../lib/api'
import { ariaKeyShortcuts, commandOf, commands, contextTitles, keepsEscape, type CommandContext, type CommandId } from '../lib/commands'
import { defaultKeymap, dialogClaims, disabledClaims, keymaps, reservedClaims, type KeymapName } from '../lib/keymaps'
import { KeyboardHelp } from './KeyboardHelp'
import { KeyboardMenu, type KeyboardMenuGroup } from './KeyboardMenu'
import { useCanWrite } from './masters/useCanWrite'
import { reportMenuGroups, useFocusOnOpen } from './reports/ReportScreen'
import { reportRoutes } from './reports/navigation'

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
/** Sets or clears the page's own target for nav.back (useBackOverride). */
const BackOverrideContext = createContext<((target: { run: () => void } | null) => void) | null>(null)

export function useKeyboard(): KeyboardState {
  const state = useContext(KeyboardContext)
  if (!state) throw new Error('useKeyboard is only available inside KeyboardShell.')
  return state
}

/**
 * Registers a command from the registry (commands.ts) in the nearest ShortcutScope, with its title and context heading.
 * `allowInTextInput` lets it run while a text field has focus, for entry screens (Enter, accept, cancel) and for a list
 * that sits under its own search field.
 */
export function useAppCommand(id: CommandId, run: () => void, { enabled = true, repeat = false, allowInTextInput = false, label }: { enabled?: boolean; repeat?: boolean; allowInTextInput?: boolean; /** Wording for this screen when the registry title does not fit it. */ label?: string } = {}) {
  const command = commandOf(id)
  // In classic a switched-off command still keeps its keys from the browser: it registers as a do-nothing claim under an
  // id outside the registry, which the action bar and the help leave out (the registry runs nothing for a disabled one).
  const keymap = useContext(KeyboardContext)?.keymap ?? defaultKeymap
  const claim = enabled ? [] : disabledClaims(keymap, id)
  useCommand(claim.length ? { id: `claim.${id}`, label: command.title, run: nothing, keys: claim }
    : { id, label: label ?? command.title, group: contextTitles[command.context], run, enabled, repeat, allowInTextInput })
}

const nothing = () => undefined

/** A command's current keys as an `aria-keyshortcuts` value, for the button that runs it. */
export const useAriaKeys = (id: CommandId) => ariaKeyShortcuts(useCommandKeys(id))

/**
 * Claims the reserved keys of a context (src/lib/keymaps.ts `classicReserved`) in classic, so a key an accountant
 * expects never triggers a browser action before its feature exists. Mount it inside the context's ShortcutScope.
 */
export function ReservedKeys({ context }: { context: CommandContext }) {
  const keys = reservedClaims(useContext(KeyboardContext)?.keymap ?? defaultKeymap, context)
  useCommand({ id: `reserved.${context}`, label: 'Reserved for a later feature', run: nothing, keys })
  return null
}

/**
 * Makes nav.back (Escape) run `run` instead of the shell's default (the company menu) while the calling component is
 * mounted and `run` is defined: report screens go back one drill-down level. The Escape guards still apply.
 */
export function useBackOverride(run: (() => void) | undefined) {
  const set = useContext(BackOverrideContext)
  const latest = useRef(run)
  latest.current = run
  const defined = run !== undefined
  useEffect(() => {
    if (!set || !defined) return
    set({ run: () => latest.current?.() })
    return () => set(null)
  }, [set, defined])
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
  const [goToOpen, setGoToOpen] = useState(false)
  const [backOverride, setBackOverride] = useState<{ run: () => void } | null>(null)

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

  return <KeyboardContext value={state}><BackOverrideContext value={setBackOverride}>
    <ShortcutProvider keymaps={keymaps} keymap={keymap}>
      <GlobalCommands back={backOverride?.run ?? back} onSwitchCompany={onSwitchCompany} onHelp={openHelp} onGoTo={() => setGoToOpen(true)} />
      <ReservedKeys context='global' />
      {children}
      <KeyboardHelp open={helpOpen} onOpenChange={setHelpOpen} keymap={keymap} />
      <GoToDialog open={goToOpen} onOpenChange={setGoToOpen} />
    </ShortcutProvider>
  </BackOverrideContext></KeyboardContext>
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

/** The company open in the address, or undefined outside a company. */
const useOpenCompanyId = () => (useParams({ strict: false }) as { companyId?: string }).companyId?.toLowerCase()

function GlobalCommands({ back, onSwitchCompany, onHelp, onGoTo }: { back?: () => void; onSwitchCompany?: () => void; onHelp: () => void; onGoTo: () => void }) {
  // A disabled command leaves the key to the browser, so a text field keeps its own Escape; the run-time check covers a
  // key pressed before the focus change has re-rendered, and popups that do not move focus.
  const fieldKeepsEscape = useFocusKeepsEscape()
  useAppCommand('help.keyboard', onHelp)
  useAppCommand('nav.back', () => { if (!keepsEscape(document.activeElement) && !popupOpen()) back?.() }, { enabled: back !== undefined && !fieldKeepsEscape })
  // Ctrl+Q: the same target as Escape, but a text field does not keep it, so it leaves from inside a field too.
  useAppCommand('nav.quit', () => { if (!popupOpen()) back?.() }, { enabled: back !== undefined })
  useAppCommand('company.switch', () => onSwitchCompany?.(), { enabled: onSwitchCompany !== undefined })
  // A report registers its own nav.go-to in its scope, which wins there (the period carries over).
  useAppCommand('nav.go-to', onGoTo, { enabled: useOpenCompanyId() !== undefined })
  return null
}

/**
 * Gives a dialog the pop-up keys of desktop accounting software: Ctrl+Q (nav.quit) closes it as Escape does, F1 opens
 * the keyboard help, and with `onAccept` the accept keys (entry.accept, Ctrl+A in classic) apply it from anywhere in it,
 * fields included. A dialog's modal scope cuts off every outer scope, so in classic it also claims every other classic
 * key (`dialogClaims`) and the browser never acts on one there. Wrap the Dialog: the scope owns the keys while focus is
 * inside it. Every dialog of the application, the stock confirmations included, is wrapped this way.
 */
export function DialogKeys({ name, open, onAccept, children }: { name: string; open: boolean; onAccept?: () => void; children: ReactNode }) {
  // Registered only while open: the action bar lists every registered command, and a closed dialog offers nothing.
  return <ShortcutScope name={name} modal>{open && <DialogCommands onAccept={onAccept} />}{children}</ShortcutScope>
}

/** Closes the dialog that has focus through its own cancel handling, as Escape does (a busy or dirty dialog may ask first). */
const closeFocusedDialog = () => { document.activeElement?.closest('dialog')?.dispatchEvent(new Event('cancel', { cancelable: true })) }

function DialogCommands({ onAccept }: { onAccept?: () => void }) {
  const { keymap, openHelp } = useKeyboard()
  useAppCommand('nav.quit', closeFocusedDialog)
  useAppCommand('help.keyboard', openHelp)
  return <>
    {onAccept && <DialogAccept onAccept={onAccept} />}
    <DialogClaims keys={dialogClaims(keymap, onAccept ? ['nav.quit', 'help.keyboard', 'entry.accept'] : ['nav.quit', 'help.keyboard'])} />
  </>
}

function DialogAccept({ onAccept }: { onAccept: () => void }) {
  useAppCommand('entry.accept', onAccept, { allowInTextInput: true })
  return null
}

function DialogClaims({ keys }: { keys: readonly string[] }) {
  useCommand({ id: 'claim.dialog', label: 'Kept from the browser in a dialog', run: nothing, keys })
  return null
}

/** "Go to" from any company screen: the masters, vouchers and reports, each opened by its menu letter or Enter. */
function GoToDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const companyId = useOpenCompanyId()
  const navigate = useNavigate()
  const canWrite = useCanWrite()
  const [active, setActive] = useState<CommandId>('home.chart-of-accounts')
  const [focusRequest, setFocusRequest] = useState<number>()
  useFocusOnOpen(open, () => setFocusRequest(value => (value ?? 0) + 1))
  if (!companyId) return null
  const go = (to: string) => { onOpenChange(false); void navigate({ to, params: { companyId } } as never) }
  const item = (command: CommandId, to: string) => ({ command, label: commands[command].title, open: () => go(to) })
  const groups: KeyboardMenuGroup[] = [
    { id: 'masters', label: 'Masters', items: [
      ...canWrite ? [item('home.new-master', '/app/c/$companyId/masters/new'), item('home.edit-master', '/app/c/$companyId/masters/edit')] : [],
      item('home.chart-of-accounts', '/app/c/$companyId/masters/chart-of-accounts'),
    ] },
    { id: 'transactions', label: 'Transactions', items: [item('home.vouchers', '/app/c/$companyId/vouchers')] },
    ...reportMenuGroups(report => go(reportRoutes[report])),
  ]
  return <DialogKeys name='Go to' open={open}>
    <Dialog open={open} onOpenChange={onOpenChange} title='Go to' description='Use the arrow keys and Enter, or press a letter.'>
      {open && <KeyboardMenu label='Go to' groups={groups} active={active} onActiveChange={setActive} focusRequest={focusRequest} />}
    </Dialog>
  </DialogKeys>
}
