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
  'list.create': 'Alt+C',
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
    'list.delete': 'Alt+D',
    'list.history': 'Alt+H',
    'list.cancel': ['Escape', 'Ctrl+Q'],
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
export type Parity = { readonly status: 'same' | 'alternate' | 'ours'; readonly note?: string }
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
  'list.create': { status: 'same', note: 'Alt+C creates from a list. The catalogue\'s masters list also advertises a bare C, which D-05 keeps to focused menus (WCAG 2.1.4).' },
  'list.delete': { status: 'same', note: 'Deletes the highlighted row after a confirmation.' },
  'list.history': { status: 'ours', note: 'No history view in the catalogue. Alt+H, because Alt+Y is reserved for the data menu.' },
  'list.cancel': { status: 'same' },
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
  { context: 'global', purpose: 'Change the working date', keys: ['F2'] },
  { context: 'global', purpose: 'Calculator', keys: ['Alt+='], catalogueKey: 'Ctrl+N', reason: 'Ctrl+N opens a new browser window; a page never receives it.' },
  { context: 'global', purpose: 'Company features', keys: ['Ctrl+F11'], catalogueKey: 'F11', reason: 'F11 switches the browser to full screen; a page never receives it.' },
  { context: 'global', purpose: 'Configure the screen', keys: ['F12'] },
  { context: 'global', purpose: 'Open a company from the list of all companies; close the company', keys: ['Alt+F3', 'Ctrl+F3'] },
  { context: 'global', purpose: 'Menus: company, data, import, export, sharing, printing', keys: ['Alt+K', 'Alt+Y', 'Alt+O', 'Alt+E', 'Alt+M', 'Alt+P'] },
  { context: 'global', purpose: 'Currency exchange menu', keys: ['Alt+Z'] },
  { context: 'global', purpose: 'Find in masters and transactions', keys: ['Alt+F'] },
  { context: 'global', purpose: 'Send the screen by e-mail', keys: ['Ctrl+M'] },
  { context: 'global', purpose: 'Send the screen through a messaging service', keys: ['Alt+W'], catalogueKey: 'Ctrl+Alt+W', reason: 'Windows reports Ctrl+Alt as AltGr, which types characters, so the registry does not run commands on it there.' },
  { context: 'company-home', purpose: 'Menu letters: banking, stock summary, ratios, more reports, dashboard, quit', keys: ['N', 'S', 'R', 'D', 'O', 'Q'] },
  { context: 'list', purpose: 'Select the row; remove and restore a line', keys: ['Space', 'Ctrl+R', 'Ctrl+U'] },
  { context: 'entry', purpose: 'Choose the voucher type from a list', keys: ['F10'] },
  { context: 'entry', purpose: 'Debit note, credit note, stock journal, physical stock, sales order', keys: ['Alt+F5', 'Alt+F6', 'Alt+F7', 'Ctrl+F7', 'Ctrl+F8'] },
  { context: 'entry', purpose: 'Voucher mode, more details, optional voucher, unused numbers, autofill, related reports', keys: ['Ctrl+H', 'Ctrl+I', 'Ctrl+L', 'Ctrl+U', 'Ctrl+F', 'Ctrl+O'] },
  { context: 'entry', purpose: 'Post-dated voucher', keys: ['Alt+T'], catalogueKey: 'Ctrl+T', reason: 'Ctrl+T opens a new browser tab; a page never receives it.' },
  { context: 'report', purpose: 'Report views: grouping, monthly, valuation, stock group, profit, orders', keys: ['F4', 'F5', 'F6', 'F7', 'F8', 'F9'] },
  { context: 'report', purpose: 'Basis of values, views, exception reports, saved views, filter', keys: ['Ctrl+B', 'Ctrl+H', 'Ctrl+J', 'Ctrl+L', 'Ctrl+F'] },
  { context: 'report', purpose: 'Add, alter and delete a column', keys: ['Ctrl+C', 'Ctrl+A', 'Ctrl+D'] },
  { context: 'report', purpose: 'Automatic columns', keys: ['Alt+U'], catalogueKey: 'Ctrl+N', reason: 'Ctrl+N opens a new browser window; a page never receives it.' },
  { context: 'report', purpose: 'Select the line; remove and restore a line', keys: ['Space', 'Ctrl+R', 'Ctrl+U'] },
  { context: 'report', purpose: 'Day book rows: cancel, delete, duplicate, insert, add', keys: ['Alt+X', 'Alt+D', 'Alt+2', 'Alt+I', 'Alt+A'] },
  { context: 'report', purpose: 'Save a tax return', keys: ['Alt+B'] },
]

/** Inner-context commands that take a global reserved key on purpose, as the catalogue does: F2 is the period on a report. */
export const reservedShadows: readonly string[] = ['report.period on F2']

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
