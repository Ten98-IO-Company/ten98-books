import type { Keymap } from '@ten98/ui'
import type { CommandId } from './commands.ts'

/**
 * The two keymaps of D-05, keyed by command id (commands.ts). Chords use the `@ten98/ui` shortcut syntax. Both keymaps
 * bind every command; tests/keyboard.test.ts checks that, and that no two commands share a key in one context.
 *
 * - classic: function keys and Alt/Ctrl chords that accountants bring from desktop accounting software, wherever a
 *   browser tab can still receive them. Some of these keys normally belong to the browser (F1 help, F3 find, F5 reload,
 *   F6 address bar, Alt+D address bar); the page receives them and the registry cancels the browser action, which is why
 *   classic is opt-in. Keys a page can never receive (Ctrl+N, Ctrl+T, Ctrl+W, Alt+F4, F11) are never used.
 * - web-safe: the default. No function keys, nothing in `browserReservedChords` below, and no single printable key
 *   outside the focused company menu (WCAG 2.1.4).
 */
export const keymapNames = ['classic', 'web-safe'] as const
export type KeymapName = (typeof keymapNames)[number]
export const defaultKeymap: KeymapName = 'web-safe'

export const keymapTitles: Record<KeymapName, string> = { classic: 'Classic', 'web-safe': 'Web-safe' }
export const keymapDescriptions: Record<KeymapName, string> = {
  classic: 'Function keys and Alt or Ctrl chords, as in desktop accounting software. Some replace browser keys such as F1 help, F3 find and F5 reload while this application is open.',
  'web-safe': 'Keys that leave every browser and operating system shortcut alone. Recommended unless you rely on function keys.',
}

export const isKeymapName = (value: unknown): value is KeymapName => keymapNames.includes(value as KeymapName)

type AppKeymap = Readonly<Record<CommandId, string | readonly string[]>> & Keymap

/** Keys both keymaps share: movement and opening in the company menu, Enter and Escape on entry screens. */
const shared = {
  'nav.back': 'Escape',
  'menu.next': 'ArrowDown',
  'menu.previous': 'ArrowUp',
  'menu.first': 'Home',
  'menu.last': 'End',
  'menu.open': 'Enter',
  // Menu letters: single printable keys, live only while the company menu has focus.
  'home.new-master': 'N',
  'home.edit-master': 'E',
  'home.chart-of-accounts': 'C',
  'home.vouchers': 'V',
  'home.day-book': 'D',
  'home.balance-sheet': 'B',
  'home.profit-and-loss': 'P',
  'home.trial-balance': 'T',
  'home.ledger': 'L',
  'list.create': 'Alt+C',
  'entry.cancel': 'Escape',
  'entry.next-field': 'Enter',
  'entry.create-master': 'Alt+C',
} as const

export const keymaps: Record<KeymapName, AppKeymap> = {
  classic: {
    ...shared,
    'help.keyboard': ['F1', 'Ctrl+/'],
    'company.switch': 'F3',
    'list.delete': 'Alt+D',
    'entry.accept': ['Ctrl+A', 'Ctrl+Enter'],
    'entry.delete': 'Alt+D',
    'entry.voucher.contra': 'F4',
    'entry.voucher.payment': 'F5',
    'entry.voucher.receipt': 'F6',
    'entry.voucher.journal': 'F7',
    'entry.voucher.sales': 'F8',
    'entry.voucher.purchase': 'F9',
  },
  'web-safe': {
    ...shared,
    'help.keyboard': 'Ctrl+/',
    'company.switch': 'Alt+K',
    'list.delete': 'Alt+X',
    'entry.accept': 'Ctrl+Enter',
    'entry.delete': 'Alt+X',
    // Letters taken from inside each word, as in "cOntra" and "receIpt".
    'entry.voucher.contra': 'Alt+O',
    'entry.voucher.payment': 'Alt+P',
    'entry.voucher.receipt': 'Alt+I',
    'entry.voucher.journal': 'Alt+J',
    'entry.voucher.sales': 'Alt+L',
    'entry.voucher.purchase': 'Alt+U',
  },
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
