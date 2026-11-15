import { Alert, AuthLayout, Button, Dialog, ShortcutProvider, ShortcutScope, Stack, Text, useCommand, useCommandKeys, type NavLinkComponent } from '@ten98/ui'
import { Link, useNavigate, useParams, useRouter, useRouterState } from '@tanstack/react-router'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, errMsg } from '../lib/api'
import { afterHistory, ariaKeyShortcuts, backSource, commandOf, commands, contextTitles, drilledFrom, heldReturn, type CommandContext, type CommandId, type GoToReturn, type HistoryMove } from '../lib/commands'
import { reportLevel } from '../lib/reports'
import { defaultKeymap, dialogClaims, disabledClaims, keymaps, reservedClaims, type KeymapName } from '../lib/keymaps'
import { KeyboardHelp } from './KeyboardHelp'
import { KeyboardMenu, type KeyboardMenuGroup } from './KeyboardMenu'
import { FocusMemoryContext, rememberFocusOutsideDialogs, type FocusMemory } from './masters/leave-guard'
import { useCanWrite } from './masters/useCanWrite'
import { reportMenuGroups } from './reports/ReportScreen'
import { reportRoutes, trailMark, trailStepOf } from './reports/navigation'

type KeymapSetting = { keymap: KeymapName; chosen: boolean }

/** The position of a history entry (TanStack history keeps it through replaces; 0 for an entry it did not write). */
const historyIndex = (state: unknown): number => (state as { __TSR_index?: number } | undefined)?.__TSR_index ?? 0

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
 * that sits under its own search field. `matchPhysicalKey` lets a letter key run it by its position when the keyboard
 * layout types another script there (an Arabic layout), for the menu letters.
 */
export function useAppCommand(id: CommandId, run: () => void, { enabled = true, repeat = false, allowInTextInput = false, matchPhysicalKey = false, label }: { enabled?: boolean; repeat?: boolean; allowInTextInput?: boolean; matchPhysicalKey?: boolean; /** Wording for this screen when the registry title does not fit it. */ label?: string } = {}) {
  const command = commandOf(id)
  // In classic a switched-off command still keeps its keys from the browser: it registers as a do-nothing claim under an
  // id outside the registry, which the action bar and the help leave out (the registry runs nothing for a disabled one).
  const keymap = useContext(KeyboardContext)?.keymap ?? defaultKeymap
  const claim = enabled ? [] : disabledClaims(keymap, id)
  useCommand(claim.length ? { id: `claim.${id}`, label: command.title, run: nothing, keys: claim }
    : { id, label: label ?? command.title, group: contextTitles[command.context], run, enabled, repeat, allowInTextInput, matchPhysicalKey })
}

const nothing = () => undefined

/** Registers a claim (keys taken from the browser, nothing run) under an id outside the registry; `claimable` decides the keys. */
function useClaim(id: string, label: string, keys: readonly string[]) {
  useCommand({ id, label, run: nothing, keys })
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
 * mounted and `run` is defined: report screens go back one drill-down level. A focused field or an open popup still
 * keeps Escape.
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
export function KeyboardShell({ userId, onUnauthorized, back, companyOpen = false, onSwitchCompany, children }: {
  userId: string
  onUnauthorized: () => void
  /** Goes back one level from the current page; undefined where Escape should keep its native meaning. */
  back?: () => void
  /** A company with books is open, so go-to and switch-to have screens to offer; false outside one and on a company that cannot be opened or is not set up. */
  companyOpen?: boolean
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
  const [goTos, setGoTos] = useState<readonly GoToReturn[]>([])
  const router = useRouter()
  const navigate = useNavigate()
  const path = useRouterState({ select: state => state.location.pathname })
  const href = useRouterState({ select: state => state.location.href })
  const index = useRouterState({ select: state => historyIndex(state.location.state) })
  const step = trailStepOf(href)
  const innermost = goTos[goTos.length - 1]
  // Set while Escape goes up the report trail from a level drilled into after the innermost go-to, so the push that
  // lands back on the go-to's screen carries its return onto the new entry (afterHistory).
  const trailBack = useRef(false)
  useEffect(() => router.history.subscribe(({ location, action }) => {
    const move: HistoryMove = { type: action.type, index: historyIndex(location.state), path: location.pathname, level: reportLevel(location.href), trailBack: trailBack.current }
    trailBack.current = false
    setGoTos(stack => afterHistory(stack, move))
  }), [router])

  // Go-to pushes the screen and remembers the entry it came from; its return is recorded before the navigation
  // (pending), so the push does not drop it. A go-to to the screen already shown replaces it in place and records
  // nothing. Switch-to puts the company menu in place of this screen and pushes the new one on top, so the ordinary
  // back from there (history, a report's fallback, the shell's) ends at the menu. A navigation the leave guard keeps
  // from happening leaves everything as it was.
  const openScreen = useCallback<OpenScreen>(async (mode, to, params, search) => {
    const from = router.state.location.href
    if (mode === 'go-to') {
      const target = router.buildLocation({ to, params, search } as never).pathname
      // The screen already shown (whatever its search: highlight, period, subject) is opened in place, on the same
      // history entry, so the returns held on that entry still apply there.
      if (target.toLowerCase() === router.state.location.pathname.toLowerCase()) { await navigate({ to, params, search, replace: true } as never); return }
      const entry: GoToReturn = { from, to: target, level: '', index: -1, fromIndex: historyIndex(router.history.location.state), mark: trailMark(), pending: true }
      // A go-to the leave guard held back never arrives: the router settles its navigation only with a later one, so
      // a pending return is dropped by the next go-to, and counts as arrived only on the screen it was opened for.
      setGoTos(stack => [...stack.filter(item => !item.pending), entry])
      await navigate({ to, params, search } as never)
      const here = router.history.location
      const arrived = router.state.location.href !== from && here.pathname.toLowerCase() === target.toLowerCase()
      const opened: GoToReturn = { ...entry, to: here.pathname, level: reportLevel(here.href), index: historyIndex(here.state), pending: undefined }
      setGoTos(stack => arrived ? stack.map(item => item === entry ? opened : item) : stack.filter(item => item !== entry))
      return
    }
    const home = `/app/c/${params.companyId}`
    await navigate({ to: '/app/c/$companyId', params, replace: true } as never)
    if (router.state.location.pathname.toLowerCase().replace(/\/$/, '') !== home) return
    setGoTos([])
    await navigate({ to, params, search } as never)
  }, [router, navigate])
  const source = backSource({ path, index, step }, goTos, { screen: backOverride !== null, shell: back !== undefined })
  // Using a return spends it and goes back in history to the very entry the go-to was opened from.
  const held = heldReturn({ path, index }, goTos)
  const backNow = source === 'go-to' && held ? () => { setGoTos(stack => stack.filter(item => item !== held)); router.history.go(held.fromIndex - index) }
    : source === 'screen' ? () => { trailBack.current = drilledFrom(step, innermost); backOverride!.run() }
    : source === 'shell' ? back : undefined

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

  // The last element focused outside a dialog, for "Keep editing" to return to (leave-guard.ts).
  const focusMemory = useRef<FocusMemory['current']>(null)
  useEffect(() => rememberFocusOutsideDialogs(document, focusMemory), [])

  return <KeyboardContext value={state}><BackOverrideContext value={setBackOverride}><OpenScreenContext value={openScreen}><FocusMemoryContext value={focusMemory}>
    <ShortcutProvider keymaps={keymaps} keymap={keymap}>
      <GlobalCommands back={backNow} companyOpen={companyOpen} onSwitchCompany={onSwitchCompany} onHelp={openHelp} onOpenList={setGoToMode} />
      <ReservedKeys context='global' />
      {children}
      <KeyboardHelp open={helpOpen} onOpenChange={setHelpOpen} keymap={keymap} />
      <GoToDialog mode={goToMode} onClose={() => setGoToMode(null)} />
    </ShortcutProvider>
  </FocusMemoryContext></OpenScreenContext></BackOverrideContext></KeyboardContext>
}

// An open dialog, popover or expanded popup owns Escape even when focus has moved outside it.
const popupOpen = () => document.querySelector('dialog[open], :popover-open, [aria-haspopup][aria-expanded="true"], [role="combobox"][aria-expanded="true"]') !== null

/** The company open in the address, or undefined outside a company. */
const useOpenCompanyId = () => (useParams({ strict: false }) as { companyId?: string }).companyId?.toLowerCase()

function GlobalCommands({ back, companyOpen, onSwitchCompany, onHelp, onOpenList }: { back?: () => void; companyOpen: boolean; onSwitchCompany?: () => void; onHelp: () => void; onOpenList: (mode: ScreenMode) => void }) {
  // Go-to and switch-to list a company's screens: off where no company with books is open, so the action bar does not offer them.
  const companyInAddress = useOpenCompanyId() !== undefined
  const inCompany = companyOpen && companyInAddress
  useAppCommand('help.keyboard', onHelp)
  // Not allowed in text input, so a text field, select or open popup keeps Escape (the registry's rule); the check here
  // covers a dialog or popover that is open while focus is outside it.
  useAppCommand('nav.back', () => { if (!popupOpen()) back?.() }, { enabled: back !== undefined })
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
  const menu = useRef<HTMLElement>(null)
  if (!companyId) return null
  const go = (to: string) => { const how = shown.current; onClose(); void openScreen(how, to, { companyId }) }
  const item = (command: CommandId, to: string) => ({ command, label: commands[command].title, open: () => go(to) })
  const groups: KeyboardMenuGroup[] = [
    { id: 'masters', label: 'Masters', items: [
      ...canWrite ? [item('home.new-master', '/app/c/$companyId/masters/new'), item('home.edit-master', '/app/c/$companyId/masters/edit')] : [],
      item('home.chart-of-accounts', '/app/c/$companyId/masters/chart-of-accounts'),
      item('home.cost-centres', '/app/c/$companyId/masters/cost-centres'),
    ] },
    { id: 'transactions', label: 'Transactions', items: [item('home.vouchers', '/app/c/$companyId/vouchers')] },
    ...reportMenuGroups(report => go(reportRoutes[report])),
  ]
  const text = screenModeText[shown.current]
  return <DialogKeys name={text.title} open={open}>
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }} title={text.title} description={`${text.description} Use the arrow keys and Enter, or press a letter.`} initialFocus={menu}>
      {open && <KeyboardMenu label={text.title} groups={groups} active={active} onActiveChange={setActive} menuRef={menu} />}
    </Dialog>
  </DialogKeys>
}

/** A design-system link (`href`) that navigates through the router instead of loading the page again. */
export const RouterLink: NavLinkComponent = ({ href, ...props }) => <Link to={href} {...props} />

/** The fixed text of the state screens: the same whatever the address, the session or the error. */
export const stateCopy = {
  notFound: { title: 'Page not found', message: 'This address does not open a page of the application.' },
  error: { title: 'This page could not be shown', message: 'Something went wrong while showing this page.' },
} as const

/**
 * A state screen (an address no route matches, a company that cannot be opened, a page that failed), inside the signed-in
 * shell or outside it. Its heading takes focus when it appears, so focus is never left on the page body. Inside the shell
 * it sits in the shell's main area (an unlabelled layout, so the page keeps one main landmark), and Escape (Ctrl+Q in
 * classic) and "Go to the start page" go to /app, which opens the last company used. Outside the shell it is the page's
 * main landmark and the start page is /. What it shows depends only on its props: an error's own text never reaches it.
 */
export function StateScreen({ state, title, message, onRetry }: { state: 'not-found' | 'error'; title: string; message: string; onRetry?: () => void }) {
  const inShell = useContext(KeyboardContext) !== null
  const start = inShell ? '/app' : '/'
  const navigate = useNavigate()
  const holder = useRef<HTMLElement>(null)
  useEffect(() => {
    const heading = holder.current?.querySelector<HTMLElement>('h1')
    if (heading) { heading.tabIndex = -1; heading.focus() }
  }, [])
  useBackOverride(() => void navigate({ to: start }))
  return <Stack ref={holder}>
    <AuthLayout label={inShell ? undefined : title} title={title} surface={inShell ? 'plain' : undefined} brand={inShell ? false : undefined} aside={inShell ? null : undefined}>
      <Stack gap={4}>
        {state === 'not-found' ? <Text role='status'>{message}</Text> : <Alert tone='danger' role='alert' title={message} />}
        {state === 'not-found' ? <Button href={start} component={RouterLink}>Go to the start page</Button>
          : onRetry && <Button onClick={onRetry}>Try again</Button>}
      </Stack>
    </AuthLayout>
  </Stack>
}

/** The router's not-found screen (an address no route matches), in or out of the shell. */
export function NotFoundScreen() {
  return <StateScreen state='not-found' {...stateCopy.notFound} />
}

/**
 * The router's error screen: a fixed message and "Try again" only; the error object is never read. Try again resets
 * the boundary (when the router gives one) and loads the page's data again.
 */
export function ErrorScreen({ reset }: { reset?: () => void }) {
  const router = useRouter()
  return <StateScreen state='error' {...stateCopy.error} onRetry={() => { reset?.(); void router.invalidate() }} />
}
