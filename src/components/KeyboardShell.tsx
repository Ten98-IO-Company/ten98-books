import { Dialog, ShortcutProvider, ShortcutScope, useCommand, useCommandKeys } from '@ten98/ui'
import { useNavigate, useParams, useRouter, useRouterState } from '@tanstack/react-router'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, errMsg } from '../lib/api'
import { ariaKeyShortcuts, backSource, commandOf, commands, contextTitles, keepsEscape, type CommandContext, type CommandId, type GoToReturn } from '../lib/commands'
import { claimSplit, defaultKeymap, dialogClaims, disabledClaims, keymaps, reservedClaims, type KeymapName } from '../lib/keymaps'
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
/** True while focus is in an editable element or text is selected: claims then leave the editing chords alone (claimSplit). */
const EditingContext = createContext(false)
/** How a screen is opened from the go-to list: stacked over this one (go-to) or in its place (switch-to). */
export type ScreenMode = 'go-to' | 'switch-to'
type OpenScreen = (mode: ScreenMode, to: string, params: { companyId: string }, search?: Record<string, unknown>) => Promise<void>
const OpenScreenContext = createContext<OpenScreen | null>(null)

/** Opens a screen as go-to or switch-to, so that Escape there leads where that mode says (backSource in commands.ts). */
export function useOpenScreen(): OpenScreen {
  const open = useContext(OpenScreenContext)
  if (!open) throw new Error('useOpenScreen is only available inside KeyboardShell.')
  return open
}

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
  const editingNow = useContext(EditingContext)
  const claim = enabled ? [] : disabledClaims(keymap, id)
  // A switched-off accept is still the accept key (D-05), so its Ctrl+A is claimed even in a field.
  const { always, editing } = claimSplit(claim, id === 'entry.accept' ? claim : [])
  useCommand(always.length ? { id: `claim.${id}`, label: command.title, run: nothing, keys: always }
    : { id, label: label ?? command.title, group: contextTitles[command.context], run, enabled, repeat, allowInTextInput })
  useCommand({ id: `claim.${id}.editing`, label: command.title, run: nothing, keys: editing, enabled: !editingNow })
}

const nothing = () => undefined

/**
 * Registers a claim (keys taken from the browser, nothing run) under an id outside the registry. The clipboard and
 * editing chords among `keys` go into a second claim that is switched off while focus is editable or text is selected,
 * and a switched-off command leaves its key to the browser (claimSplit).
 */
function useClaim(id: string, label: string, keys: readonly string[], accept: readonly string[] = []) {
  const editingNow = useContext(EditingContext)
  const { always, editing } = claimSplit(keys, accept)
  useCommand({ id, label, run: nothing, keys: always })
  useCommand({ id: `${id}.editing`, label, run: nothing, keys: editing, enabled: !editingNow })
}

/** Whether focus is in an editable element (keepsEscape's test) or the page has a text selection, followed live. */
function useEditingTarget() {
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    const update = () => setEditing(keepsEscape(document.activeElement) || (document.getSelection()?.toString() ?? '') !== '')
    update()
    for (const type of ['focusin', 'focusout', 'selectionchange']) document.addEventListener(type, update)
    return () => { for (const type of ['focusin', 'focusout', 'selectionchange']) document.removeEventListener(type, update) }
  }, [])
  return editing
}

/** A command's current keys as an `aria-keyshortcuts` value, for the button that runs it. */
export const useAriaKeys = (id: CommandId) => ariaKeyShortcuts(useCommandKeys(id))

/**
 * Claims the reserved keys of a context (src/lib/keymaps.ts `classicReserved`) in classic, so a key an accountant
 * expects never triggers a browser action before its feature exists. Mount it inside the context's ShortcutScope.
 */
export function ReservedKeys({ context }: { context: CommandContext }) {
  useClaim(`reserved.${context}`, 'Reserved for a later feature', reservedClaims(useContext(KeyboardContext)?.keymap ?? defaultKeymap, context))
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
  const [goToMode, setGoToMode] = useState<ScreenMode | null>(null)
  const [backOverride, setBackOverride] = useState<{ run: () => void } | null>(null)
  const [goToReturn, setGoToReturn] = useState<GoToReturn | null>(null)
  const router = useRouter()
  const navigate = useNavigate()
  const path = useRouterState({ select: state => state.location.pathname })

  // Go-to pushes the screen and remembers where it came from; switch-to puts the company menu in place of this screen
  // and pushes the new one on top, so the ordinary back from there (history, a report's fallback, the shell's) ends at
  // the menu. A navigation the leave guard keeps from happening leaves everything as it was.
  const openScreen = useCallback<OpenScreen>(async (mode, to, params, search) => {
    const from = router.state.location.href
    if (mode === 'go-to') {
      await navigate({ to, params, search } as never)
      if (router.state.location.href !== from) setGoToReturn({ from, to: router.state.location.pathname })
      return
    }
    const home = `/app/c/${params.companyId}`
    await navigate({ to: '/app/c/$companyId', params, replace: true } as never)
    if (router.state.location.pathname.toLowerCase().replace(/\/$/, '') !== home) return
    setGoToReturn(null)
    await navigate({ to, params, search } as never)
  }, [router, navigate])
  const source = backSource(path, goToReturn, backOverride !== null, back !== undefined)
  const backNow = source === 'go-to' ? () => void navigate({ href: goToReturn!.from }) : source === 'screen' ? backOverride!.run : source === 'shell' ? back : undefined

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
  const editing = useEditingTarget()

  return <KeyboardContext value={state}><EditingContext value={editing}><BackOverrideContext value={setBackOverride}><OpenScreenContext value={openScreen}>
    <ShortcutProvider keymaps={keymaps} keymap={keymap}>
      <GlobalCommands back={backNow} onSwitchCompany={onSwitchCompany} onHelp={openHelp} onOpenList={setGoToMode} />
      <ReservedKeys context='global' />
      {children}
      <KeyboardHelp open={helpOpen} onOpenChange={setHelpOpen} keymap={keymap} />
      <GoToDialog mode={goToMode} onClose={() => setGoToMode(null)} />
    </ShortcutProvider>
  </OpenScreenContext></BackOverrideContext></EditingContext></KeyboardContext>
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

function GlobalCommands({ back, onSwitchCompany, onHelp, onOpenList }: { back?: () => void; onSwitchCompany?: () => void; onHelp: () => void; onOpenList: (mode: ScreenMode) => void }) {
  const inCompany = useOpenCompanyId() !== undefined
  // A disabled command leaves the key to the browser, so a text field keeps its own Escape; the run-time check covers a
  // key pressed before the focus change has re-rendered, and popups that do not move focus.
  const fieldKeepsEscape = useFocusKeepsEscape()
  useAppCommand('help.keyboard', onHelp)
  useAppCommand('nav.back', () => { if (!keepsEscape(document.activeElement) && !popupOpen()) back?.() }, { enabled: back !== undefined && !fieldKeepsEscape })
  // Ctrl+Q: the same target as Escape, but a text field does not keep it, so it leaves from inside a field too.
  useAppCommand('nav.quit', () => { if (!popupOpen()) back?.() }, { enabled: back !== undefined })
  useAppCommand('company.switch', () => onSwitchCompany?.(), { enabled: onSwitchCompany !== undefined })
  // A report registers its own go-to and switch-to in its scope, which win there (the period carries over).
  useAppCommand('nav.go-to', () => onOpenList('go-to'), { enabled: inCompany })
  useAppCommand('nav.switch-to', () => onOpenList('switch-to'), { enabled: inCompany })
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
  useClaim('claim.dialog', 'Kept from the browser in a dialog', keys)
  return null
}

/** What the go-to list says about where Escape will lead, in each mode. */
export const screenModeText: Record<ScreenMode, { title: string; description: string }> = {
  'go-to': { title: 'Go to', description: 'Opens over this screen: Escape there brings you back here.' },
  'switch-to': { title: 'Switch to', description: 'Opens in place of this screen: Escape there goes to the company menu.' },
}

/** The go-to list from any company screen: the masters, vouchers and reports, each opened by its menu letter or Enter. */
function GoToDialog({ mode, onClose }: { mode: ScreenMode | null; onClose: () => void }) {
  const companyId = useOpenCompanyId()
  const openScreen = useOpenScreen()
  const canWrite = useCanWrite()
  const open = mode !== null
  // The mode stays readable after the dialog closes, for the navigation it starts.
  const shown = useRef<ScreenMode>('go-to')
  if (mode) shown.current = mode
  const [active, setActive] = useState<CommandId>('home.chart-of-accounts')
  const [focusRequest, setFocusRequest] = useState<number>()
  useFocusOnOpen(open, () => setFocusRequest(value => (value ?? 0) + 1))
  if (!companyId) return null
  const go = (to: string) => { const how = shown.current; onClose(); void openScreen(how, to, { companyId }) }
  const item = (command: CommandId, to: string) => ({ command, label: commands[command].title, open: () => go(to) })
  const groups: KeyboardMenuGroup[] = [
    { id: 'masters', label: 'Masters', items: [
      ...canWrite ? [item('home.new-master', '/app/c/$companyId/masters/new'), item('home.edit-master', '/app/c/$companyId/masters/edit')] : [],
      item('home.chart-of-accounts', '/app/c/$companyId/masters/chart-of-accounts'),
    ] },
    { id: 'transactions', label: 'Transactions', items: [item('home.vouchers', '/app/c/$companyId/vouchers')] },
    ...reportMenuGroups(report => go(reportRoutes[report])),
  ]
  const text = screenModeText[shown.current]
  return <DialogKeys name={text.title} open={open}>
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }} title={text.title} description={`${text.description} Use the arrow keys and Enter, or press a letter.`}>
      {open && <KeyboardMenu label={text.title} groups={groups} active={active} onActiveChange={setActive} focusRequest={focusRequest} />}
    </Dialog>
  </DialogKeys>
}
