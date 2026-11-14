import type { Keymap } from '@ten98/ui'
import type { CommandContext, CommandId } from './commands.ts'

/**
 * The two keymaps of D-05, keyed by command id (commands.ts). Chords use the `@ten98/ui` shortcut syntax. Both keymaps
 * bind every command except `classicOnly`; tests/keyboard.test.ts checks that, and that no two commands share a key in
 * one context, nor a key `classicReserved` holds for a feature still to come.
 *
 * - classic: the default (D-05 as amended). The keys desktop accountants already use, from the private shortcut
 *   catalogue: `classicParity` records, per command, whether the key is the same, a stated alternate or our own. Some of
 *   these keys normally belong to the browser (F1 help, F3 find, Ctrl+P print, Ctrl+E, Ctrl+G, Ctrl+D); the page
 *   receives them and the registry cancels the browser action. Keys a page can never receive (Ctrl+N, Ctrl+T, F11) are
 *   never bound: the reserved list names their alternate.
 * - web-safe: a user choice. No function keys, nothing in `browserReservedChords` below, and no single printable key
 *   outside the focused company menu (WCAG 2.1.4).
 */
export const keymapNames = ['classic', 'web-safe'] as const
export type KeymapName = (typeof keymapNames)[number]
export const defaultKeymap: KeymapName = 'classic'

export const keymapTitles: Record<KeymapName, string> = { classic: 'Classic', 'web-safe': 'Web-safe' }
export const keymapDescriptions: Record<KeymapName, string> = {
  classic: 'The function keys and Ctrl or Alt chords of desktop accounting software, including Ctrl+A to accept from inside a field. While this application is open they take over some browser keys, such as F1 help, F3 find and Ctrl+P print.',
  'web-safe': 'Keys that leave every browser and operating system shortcut alone, for people who use those shortcuts more than accounting function keys.',
}

export const isKeymapName = (value: unknown): value is KeymapName => keymapNames.includes(value as KeymapName)

type AppKeymap = Readonly<Record<CommandId, string | readonly string[]>> & Keymap

/** Commands only classic binds; web-safe leaves their keys alone (an empty list unbinds). */
export const classicOnly: readonly CommandId[] = [
  // Ctrl+Q quits Firefox on Linux before a page sees it, and web-safe already goes back with Escape.
  'nav.quit',
]

/**
 * The classic create and delete keys of a masters list, awaiting the analyst: the catalogue's list bar may mean Ctrl+D
 * and C (or Ctrl+C) instead. Changing either is this one line; the parity rows say "unconfirmed" until then, and the
 * candidates are reserved in the list context meanwhile.
 */
const unconfirmedListKeys = { create: 'Alt+C', delete: 'Alt+D' } as const

/** Keys both keymaps share: movement, opening, the menu letters, Enter and Escape. */
const shared = {
  'nav.back': 'Escape',
  'nav.go-to': 'Alt+G',
  'menu.next': 'ArrowDown',
  'menu.previous': 'ArrowUp',
  'menu.first': 'Home',
  'menu.last': 'End',
  'menu.open': 'Enter',
  // Menu letters: single printable keys, live only while a company menu has focus.
  'home.new-master': 'C',
  'home.edit-master': 'A',
  'home.chart-of-accounts': 'H',
  'home.vouchers': 'V',
  'home.day-book': 'K',
  'home.balance-sheet': 'B',
  'home.profit-and-loss': 'P',
  'home.trial-balance': 'T',
  'home.ledger': 'L',
  'report.open.group-summary': 'G',
  'list.next': 'ArrowDown',
  'list.previous': 'ArrowUp',
  'list.first': 'Home',
  'list.last': 'End',
  'list.open': 'Enter',
  'list.cancel': 'Escape',
  'entry.cancel': 'Escape',
  'entry.next-field': 'Enter',
  'entry.create-master': 'Alt+C',
  'report.next': 'ArrowDown',
  'report.previous': 'ArrowUp',
  'report.page-down': 'PageDown',
  'report.page-up': 'PageUp',
  'report.first': 'Home',
  'report.last': 'End',
  'report.drill': 'Enter',
  'report.zero-lines': 'Alt+N',
} as const

export const keymaps: Record<KeymapName, AppKeymap> = {
  classic: {
    ...shared,
    'help.keyboard': ['F1', 'Ctrl+/'],
    'nav.quit': 'Ctrl+Q',
    'nav.go-to': ['Alt+G', 'Ctrl+G'],
    'company.switch': 'F3',
    'list.create': unconfirmedListKeys.create,
    'list.delete': unconfirmedListKeys.delete,
    'list.history': 'Alt+H',
    'entry.accept': ['Ctrl+A', 'Ctrl+Enter'],
    'entry.cancel': ['Escape', 'Ctrl+Q'],
    'entry.delete': 'Ctrl+D',
    'entry.history': 'Alt+H',
    'entry.voucher.contra': 'F4',
    'entry.voucher.payment': 'F5',
    'entry.voucher.receipt': 'F6',
    'entry.voucher.journal': 'F7',
    'entry.voucher.sales': 'F8',
    'entry.voucher.purchase': 'F9',
    'report.period': 'F2',
    'report.detail': 'Alt+F5',
    'report.export': 'Ctrl+E',
    'report.print': 'Ctrl+P',
  },
  'web-safe': {
    ...shared,
    'help.keyboard': 'Ctrl+/',
    'nav.quit': [],
    'company.switch': 'Alt+K',
    'list.create': 'Alt+C',
    'list.delete': 'Alt+X',
    'list.history': 'Alt+Y',
    'entry.accept': 'Ctrl+Enter',
    'entry.delete': 'Alt+X',
    'entry.history': 'Alt+Y',
    // Letters taken from inside each word, as in "cOntra" and "receIpt".
    'entry.voucher.contra': 'Alt+O',
    'entry.voucher.payment': 'Alt+P',
    'entry.voucher.receipt': 'Alt+I',
    'entry.voucher.journal': 'Alt+J',
    'entry.voucher.sales': 'Alt+L',
    'entry.voucher.purchase': 'Alt+U',
    // Reports: Period, More detail, expOrt, prInt.
    'report.period': 'Alt+P',
    'report.detail': 'Alt+M',
    'report.export': 'Alt+O',
    'report.print': 'Alt+I',
  },
}

/**
 * How each classic key compares with the private shortcut catalogue (the D-05 parity audit): `same` is the catalogue's
 * key for the same action in the same context, `alternate` differs for a stated browser reason, `ours` has no
 * counterpart there. The notes are our own words; docs/KEYBOARD.md shows this table and a test keeps the two in step.
 */
export type Parity = { readonly status: 'same' | 'alternate' | 'ours' | 'unconfirmed'; readonly note?: string }
export const classicParity: Record<CommandId, Parity> = {
  'help.keyboard': { status: 'same', note: 'F1 opens help; Ctrl+/ is an extra key of ours.' },
  'nav.back': { status: 'same', note: 'A text field keeps Escape for itself, and a dialog closes on it.' },
  'nav.quit': { status: 'same', note: 'Leaves one level without asking, also from inside a text field. At the company menu it does nothing, as there is nothing above it. Firefox on Linux quits on Ctrl+Q before the page sees it.' },
  'company.switch': { status: 'same' },
  'nav.go-to': { status: 'same', note: 'Alt+G and Ctrl+G open the same go-to list here.' },
  'menu.next': { status: 'same' },
  'menu.previous': { status: 'same' },
  'menu.first': { status: 'same' },
  'menu.last': { status: 'ours' },
  'menu.open': { status: 'same' },
  'home.new-master': { status: 'same' },
  'home.edit-master': { status: 'same' },
  'home.chart-of-accounts': { status: 'same' },
  'home.vouchers': { status: 'same' },
  'home.day-book': { status: 'same' },
  'home.balance-sheet': { status: 'same' },
  'home.profit-and-loss': { status: 'same' },
  'home.trial-balance': { status: 'ours', note: 'One menu deeper in the catalogue, with no letter recorded.' },
  'home.ledger': { status: 'ours', note: 'One menu deeper in the catalogue, with no letter recorded.' },
  'report.open.group-summary': { status: 'ours' },
  'list.next': { status: 'same' },
  'list.previous': { status: 'same' },
  'list.first': { status: 'same' },
  'list.last': { status: 'ours' },
  'list.open': { status: 'same', note: 'Opens the highlighted row for alteration.' },
  'list.create': { status: 'unconfirmed', note: 'Alt+C is the catalogue\'s create-from-a-lookup key during entry; on a masters list the catalogue may mean C or Ctrl+C. Awaiting the analyst; C and Ctrl+C are reserved meanwhile.' },
  'list.delete': { status: 'unconfirmed', note: 'Alt+D deletes a day book row in the catalogue; on a masters list it may mean Ctrl+D. Awaiting the analyst; Ctrl+D is reserved meanwhile.' },
  'list.history': { status: 'ours', note: 'No history view in the catalogue. Alt+H, because Alt+Y is reserved for the data menu.' },
  'list.cancel': { status: 'same', note: 'Escape only: Ctrl+Q leaves the list at once through nav.quit.' },
  'entry.accept': { status: 'same', note: 'Accepts the whole screen from anywhere, including inside a field; Ctrl+Enter is an extra key of ours.' },
  'entry.cancel': { status: 'same', note: 'Unlike the catalogue, both keys ask first when something was typed.' },
  'entry.next-field': { status: 'same' },
  'entry.create-master': { status: 'same' },
  'entry.delete': { status: 'same' },
  'entry.history': { status: 'ours', note: 'As the list history.' },
  'entry.voucher.contra': { status: 'same' },
  'entry.voucher.payment': { status: 'same' },
  'entry.voucher.receipt': { status: 'same' },
  'entry.voucher.journal': { status: 'same' },
  'entry.voucher.sales': { status: 'same' },
  'entry.voucher.purchase': { status: 'same' },
  'report.next': { status: 'same' },
  'report.previous': { status: 'same' },
  'report.page-down': { status: 'ours' },
  'report.page-up': { status: 'ours' },
  'report.first': { status: 'same' },
  'report.last': { status: 'ours' },
  'report.drill': { status: 'same' },
  'report.period': { status: 'same', note: 'The date, on the balance sheet.' },
  'report.detail': { status: 'same' },
  'report.zero-lines': { status: 'ours', note: 'A configuration setting in the catalogue, not a key.' },
  'report.export': { status: 'same' },
  'report.print': { status: 'same' },
}

/**
 * Catalogue keys whose feature does not exist yet, held so no command takes them first. `keys` is what classic will
 * bind; when the catalogue's key is one a browser tab cannot receive, it is named in `catalogueKey` with the reason, and
 * `keys` holds the proposed alternate.
 */
export type ReservedKey = { readonly context: CommandContext; readonly purpose: string; readonly keys: readonly string[]; readonly catalogueKey?: string; readonly reason?: string }
export const classicReserved: readonly ReservedKey[] = [
  { context: 'global', purpose: 'Set the date that new entries start from', keys: ['F2'] },
  { context: 'global', purpose: 'Open a calculator beside the screen', keys: ['Alt+='], catalogueKey: 'Ctrl+N', reason: 'Ctrl+N opens a new browser window; a page never receives it.' },
  { context: 'global', purpose: 'Turn optional accounting features on or off', keys: ['Ctrl+F11'], catalogueKey: 'F11', reason: 'F11 switches the browser to full screen; a page never receives it.' },
  { context: 'global', purpose: 'Choose what the screen shows', keys: ['F12'] },
  { context: 'global', purpose: 'Pick from every company on the installation, or put the open company aside', keys: ['Alt+F3', 'Ctrl+F3'] },
  { context: 'global', purpose: 'Menus for the company, data housekeeping, bringing data in, sending data out, sharing and printing', keys: ['Alt+K', 'Alt+Y', 'Alt+O', 'Alt+E', 'Alt+M', 'Alt+P'] },
  { context: 'global', purpose: 'Print or export what is on the screen', keys: ['Ctrl+P', 'Ctrl+E'] },
  { context: 'global', purpose: 'Exchange-rate tools', keys: ['Alt+Z'] },
  { context: 'global', purpose: 'Search everything recorded in the company', keys: ['Alt+F'] },
  { context: 'global', purpose: 'E-mail what is on the screen', keys: ['Ctrl+M'] },
  { context: 'global', purpose: 'Send what is on the screen through a chat service', keys: ['Alt+W'], catalogueKey: 'Ctrl+Alt+W', reason: 'Windows reports Ctrl+Alt as AltGr, which types characters, so the registry does not run commands on it there.' },
  { context: 'company-home', purpose: 'Menu letters for banking tools, a stock overview, ratio analysis, the full list of reports, an overview page and signing out', keys: ['N', 'S', 'R', 'D', 'O', 'Q'] },
  { context: 'list', purpose: 'Mark a row; hide a row from the view and bring it back', keys: ['Space', 'Ctrl+R', 'Ctrl+U'] },
  { context: 'list', purpose: 'Candidate create and delete keys, until the analyst confirms which the list uses', keys: ['C', 'Ctrl+C', 'Ctrl+D'] },
  { context: 'list', purpose: 'List views and settings: another grouping, other kinds of master, valuation settings, other layouts, exception lists, saved layouts and filters', keys: ['F5', 'F10', 'Ctrl+B', 'Ctrl+H', 'Ctrl+J', 'Ctrl+L', 'Ctrl+F'] },
  { context: 'entry', purpose: 'Pick another voucher type from the full list', keys: ['F10'] },
  { context: 'entry', purpose: 'Switch to the voucher types for returns, stock moves, stock counts and customer orders', keys: ['Alt+F5', 'Alt+F6', 'Alt+F7', 'Ctrl+F7', 'Ctrl+F8'] },
  { context: 'entry', purpose: 'Change the entry layout, add details, mark the entry provisional, reuse a skipped number, fill from an earlier entry, open reports about it', keys: ['Ctrl+H', 'Ctrl+I', 'Ctrl+L', 'Ctrl+U', 'Ctrl+F', 'Ctrl+O'] },
  { context: 'entry', purpose: 'Take a line out of the entry', keys: ['Ctrl+R'] },
  { context: 'entry', purpose: 'Mark the entry as dated in the future', keys: ['Alt+T'], catalogueKey: 'Ctrl+T', reason: 'Ctrl+T opens a new browser tab; a page never receives it.' },
  { context: 'entry', purpose: 'Close an order before everything on it has been delivered', keys: ['Alt+L'], catalogueKey: 'Ctrl+W', reason: 'Ctrl+W closes the browser tab; a page never receives it.' },
  { context: 'report', purpose: 'Other ways to see the report: by group, by month, at another valuation, by stock group, with profit, with orders', keys: ['F4', 'F5', 'F6', 'F7', 'F8', 'F9'] },
  { context: 'report', purpose: 'Valuation settings, other layouts, exception lists, saved layouts and filters', keys: ['Ctrl+B', 'Ctrl+H', 'Ctrl+J', 'Ctrl+L', 'Ctrl+F'] },
  { context: 'report', purpose: 'Add, change and remove comparison columns', keys: ['Ctrl+C', 'Ctrl+A', 'Ctrl+D'] },
  { context: 'report', purpose: 'Add comparison columns automatically', keys: ['Alt+U'], catalogueKey: 'Ctrl+N', reason: 'Ctrl+N opens a new browser window; a page never receives it.' },
  { context: 'report', purpose: 'Mark a line; hide a line from the view and bring it back', keys: ['Space', 'Ctrl+R', 'Ctrl+U'] },
  { context: 'report', purpose: 'On a day book row: void it, delete it, copy it, insert an entry before it, add one after it', keys: ['Alt+X', 'Alt+D', 'Alt+2', 'Alt+I', 'Alt+A'] },
  { context: 'report', purpose: 'Save a tax return', keys: ['Alt+B'] },
]

/** Inner-context commands that take a global reserved key on purpose, as the catalogue does: F2 is the period on a report. */
export const reservedShadows: readonly string[] = ['report.period on F2', 'report.export on Ctrl+E', 'report.print on Ctrl+P']

const chordsOf = (name: KeymapName, id: CommandId): readonly string[] => { const keys = keymaps[name][id]; return typeof keys === 'string' ? [keys] : keys }

/**
 * Whether classic takes a chord from the browser even with nothing to run: chords with Ctrl, Alt or Meta, and function
 * keys. Escape, Enter, arrows, Tab and letters are never taken this way, so fields and controls keep them.
 */
export const claimable = (chord: string): boolean => /(^|\+)F\d+$/.test(chord) || /(^|\+)(Ctrl|Alt|Meta)\+/.test(chord)

/** The reserved keys of a context that classic claims (default prevented, nothing run); none in web-safe. */
export function reservedClaims(name: KeymapName, context: CommandContext): string[] {
  if (name !== 'classic') return []
  return [...new Set(classicReserved.filter(entry => entry.context === context).flatMap(entry => entry.keys).filter(claimable))]
}

/** The keys of a switched-off command that classic still claims in its context, so the browser does not act on them. */
export const disabledClaims = (name: KeymapName, id: CommandId): string[] => name === 'classic' ? chordsOf(name, id).filter(claimable) : []

/**
 * Every classic chord a dialog takes from the browser: the keys of all commands and all reserved keys, less the ones the
 * dialog runs itself (`own`). A dialog cuts off the outer scopes, so without this the browser would act on them there.
 */
export function dialogClaims(name: KeymapName, own: readonly CommandId[]): string[] {
  if (name !== 'classic') return []
  const ownKeys = new Set(own.flatMap(id => chordsOf(name, id)))
  const every = [...(Object.keys(keymaps.classic) as CommandId[]).flatMap(id => chordsOf(name, id)), ...classicReserved.flatMap(entry => entry.keys)]
  return [...new Set(every.filter(chord => claimable(chord) && !ownKeys.has(chord)))]
}

const functionKeys = Array.from({ length: 12 }, (_, index) => `F${index + 1}`)
const digits = Array.from({ length: 9 }, (_, index) => String(index + 1))

/**
 * Keys web-safe never binds, with the reason. It extends the `@ten98/ui` `reservedChord` table (which the tests also
 * apply) with keys that table does not list. Sources are browser and operating-system documentation, not measurement;
 * the cross-browser reachability test of D-05 is still open.
 */
export const browserReservedChords: readonly { readonly reason: string; readonly chords: readonly string[] }[] = [
  { reason: 'Function keys: browsers use F1, F3, F5, F6, F7, F10, F11 and F12; macOS assigns others to the desktop, and many laptops send media keys unless Fn is held.', chords: functionKeys },
  { reason: 'Open, close or switch windows and tabs; a page never receives them.', chords: ['Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+T', 'Ctrl+Shift+T', 'Ctrl+W', 'Ctrl+Shift+W', 'Ctrl+F4', 'Alt+F4', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+PageUp', 'Ctrl+PageDown'] },
  { reason: 'Select a tab by position (Ctrl on Windows and macOS, Alt in Linux browsers).', chords: digits.flatMap(digit => [`Ctrl+${digit}`, `Alt+${digit}`]) },
  { reason: 'Find, reload, address bar, save, open, print, browser panels, page source and zoom.', chords: ['Ctrl+F', 'Ctrl+G', 'Ctrl+Shift+G', 'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+L', 'Ctrl+E', 'Ctrl+K', 'Alt+D', 'Ctrl+S', 'Ctrl+O', 'Ctrl+P', 'Ctrl+H', 'Ctrl+J', 'Ctrl+D', 'Ctrl+U', 'Ctrl+=', 'Ctrl+-', 'Ctrl+0'] },
  { reason: 'Developer tools, private windows, quitting, profiles, tab search, screenshots and browser panels.', chords: ['Ctrl+Shift+I', 'Ctrl+Shift+J', 'Ctrl+Shift+C', 'Ctrl+Shift+K', 'Ctrl+Shift+E', 'Ctrl+Shift+P', 'Ctrl+Shift+Q', 'Ctrl+Shift+M', 'Ctrl+Shift+A', 'Ctrl+Shift+B', 'Ctrl+Shift+O', 'Ctrl+Shift+Y', 'Ctrl+Shift+H', 'Ctrl+Shift+D', 'Ctrl+Shift+S', 'Ctrl+Shift+Delete'] },
  { reason: 'Open the browser menu or the menu bar on Windows and Linux.', chords: ['Alt+F', 'Alt+E', 'Alt+V', 'Alt+S', 'Alt+B', 'Alt+T', 'Alt+H'] },
  { reason: 'Back, forward and home page.', chords: ['Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+Home'] },
  { reason: 'Operating-system window menu, app switching and start menu.', chords: ['Alt+Space', 'Alt+Tab', 'Alt+Escape', 'Ctrl+Escape'] },
  { reason: 'Global hotkeys of common graphics-driver overlays, which take them before any window does.', chords: ['Alt+Z', 'Alt+R', 'Alt+F1', 'Alt+F9'] },
]
