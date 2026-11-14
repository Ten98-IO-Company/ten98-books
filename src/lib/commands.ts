/**
 * The command registry (D-05): every keyboard command the application offers, with the context it runs in. Keymaps
 * (keymaps.ts) bind these ids to keys; screens register them with `useCommand` from `@ten98/ui` inside a
 * `ShortcutScope` for their context. The coordinator owns the ids (docs/KEYBOARD.md); a screen never invents one.
 *
 * Contexts, outermost first. An inner context that binds a key wins over an outer one while it is active:
 * - global: any signed-in page (the application scope).
 * - company-home: the company menu, only while it has focus, so its single letters never fire elsewhere (WCAG 2.1.4).
 * - list: a list or register screen.
 * - entry: a master or voucher entry screen.
 * - report: a report screen (statements, registers, drill-down levels).
 */
export const commandContexts = ['global', 'company-home', 'list', 'entry', 'report'] as const
export type CommandContext = (typeof commandContexts)[number]

export const contextTitles: Record<CommandContext, string> = {
  global: 'Everywhere',
  'company-home': 'Company menu',
  list: 'Lists',
  entry: 'Entry screens',
  report: 'Reports',
}

export interface CommandDefinition {
  readonly title: string
  readonly context: CommandContext
  /** False for keys that move rather than act, and for menu letters the menu shows itself: the action bar leaves them out. */
  readonly bar?: false
}

export const commands = {
  'help.keyboard': { title: 'Show keyboard shortcuts', context: 'global' },
  'nav.back': { title: 'Go back one level', context: 'global' },
  // Ctrl+Q in classic. A separate command from nav.back so that it still works from a text field, where the shell turns
  // nav.back off to leave Escape to the field (keepsEscape).
  'nav.quit': { title: 'Leave this screen', context: 'global' },
  'company.switch': { title: 'Change company', context: 'global' },
  // Two ways to open a screen from one list (the shell's dialog; a report registers its own, so the period carries over).
  // Go-to stacks: Escape on the opened screen returns here. Switch-to replaces: Escape there ends at the company menu.
  'nav.go-to': { title: 'Go to a screen (Escape comes back)', context: 'global' },
  'nav.switch-to': { title: 'Switch to a screen (Escape goes to the menu)', context: 'global' },

  'menu.next': { title: 'Highlight the next item', context: 'company-home', bar: false },
  'menu.previous': { title: 'Highlight the previous item', context: 'company-home', bar: false },
  'menu.first': { title: 'Highlight the first item', context: 'company-home', bar: false },
  'menu.last': { title: 'Highlight the last item', context: 'company-home', bar: false },
  'menu.open': { title: 'Open the highlighted item', context: 'company-home', bar: false },
  'home.new-master': { title: 'New master', context: 'company-home', bar: false },
  'home.edit-master': { title: 'Edit a master', context: 'company-home', bar: false },
  'home.chart-of-accounts': { title: 'Chart of accounts', context: 'company-home', bar: false },
  'home.vouchers': { title: 'Vouchers', context: 'company-home', bar: false },
  'home.day-book': { title: 'Day book', context: 'company-home', bar: false },
  'home.balance-sheet': { title: 'Balance sheet', context: 'company-home', bar: false },
  'home.profit-and-loss': { title: 'Profit and loss', context: 'company-home', bar: false },
  'home.trial-balance': { title: 'Trial balance', context: 'company-home', bar: false },
  'home.ledger': { title: 'Ledger', context: 'company-home', bar: false },
  'home.cost-centres': { title: 'Cost categories and centres', context: 'company-home', bar: false },

  'list.create': { title: 'Create', context: 'list' },
  'list.delete': { title: 'Delete the selected item', context: 'list' },

  'entry.accept': { title: 'Save', context: 'entry' },
  'entry.cancel': { title: 'Leave without saving', context: 'entry' },
  'entry.next-field': { title: 'Next field', context: 'entry', bar: false },
  'entry.create-master': { title: 'Create a master here', context: 'entry' },
  'entry.delete': { title: 'Delete this entry', context: 'entry' },
  'entry.voucher.contra': { title: 'Switch to a contra voucher', context: 'entry' },
  'entry.voucher.payment': { title: 'Switch to a payment voucher', context: 'entry' },
  'entry.voucher.receipt': { title: 'Switch to a receipt voucher', context: 'entry' },
  'entry.voucher.journal': { title: 'Switch to a journal voucher', context: 'entry' },
  'entry.voucher.sales': { title: 'Switch to a sales voucher', context: 'entry' },
  'entry.voucher.purchase': { title: 'Switch to a purchase voucher', context: 'entry' },

  // Reports (feat/reports). Escape goes back one report level through nav.back (KeyboardShell's useBackOverride).
  'report.next': { title: 'Highlight the next line', context: 'report', bar: false },
  'report.previous': { title: 'Highlight the previous line', context: 'report', bar: false },
  'report.page-down': { title: 'Move one page down', context: 'report', bar: false },
  'report.page-up': { title: 'Move one page up', context: 'report', bar: false },
  'report.first': { title: 'Highlight the first line', context: 'report', bar: false },
  'report.last': { title: 'Highlight the last line', context: 'report', bar: false },
  'report.drill': { title: 'Open the highlighted line', context: 'report' },
  'report.period': { title: 'Change the period', context: 'report' },
  'report.detail': { title: 'Show more or less detail', context: 'report' },
  'report.zero-lines': { title: 'Show or hide lines without amounts', context: 'report' },
  'report.export': { title: 'Export as CSV', context: 'report' },
  'report.print': { title: 'Print', context: 'report' },
  'report.open.group-summary': { title: 'Group summary', context: 'company-home', bar: false },
  'report.open.cost-category-summary': { title: 'Cost category summary', context: 'company-home', bar: false },
  'report.open.cost-centre-breakup': { title: 'Cost centre break-up', context: 'company-home', bar: false },

  // Masters screens: moving through and opening a list, and the history of one master.
  'list.next': { title: 'Highlight the next row', context: 'list', bar: false },
  'list.previous': { title: 'Highlight the previous row', context: 'list', bar: false },
  'list.first': { title: 'Highlight the first row', context: 'list', bar: false },
  'list.last': { title: 'Highlight the last row', context: 'list', bar: false },
  'list.open': { title: 'Open the highlighted row', context: 'list', bar: false },
  'list.history': { title: 'Show the history of the selected item', context: 'list' },
  'list.cancel': { title: 'Clear the filter, then go back', context: 'list' },
  'entry.history': { title: 'Show the history of this entry', context: 'entry' },

  // Cost categories and centres: moving a centre and switching the company feature are list actions of that screen.
  'list.move': { title: 'Move the selected cost centre', context: 'list' },
  'list.switch': { title: 'Switch cost centres on or off', context: 'list' },
} as const satisfies Record<string, CommandDefinition>

export type CommandId = keyof typeof commands
export const commandIds = Object.keys(commands) as CommandId[]

export function isCommandId(id: string): id is CommandId {
  return Object.hasOwn(commands, id)
}

/** The definition behind a command id, widened so optional fields read uniformly. */
export const commandOf = (id: CommandId): CommandDefinition => commands[id]

/**
 * The commands the action bar lists: enabled, not marked `bar: false`, once each, within `contexts` when given, and for
 * a key that two of them share only the one from the innermost context, which is the one the registry runs. So the bar
 * shows exactly one command per key (Escape on an entry screen is "Leave without saving", not also "Go back one level").
 */
export function barCommands<T extends { id: string; enabled: boolean; keys: readonly string[] }>(list: readonly T[], contexts?: readonly CommandContext[]): T[] {
  const seen = new Set<string>()
  const eligible = list.filter(command => {
    if (!command.enabled || !isCommandId(command.id) || seen.has(command.id)) return false
    const definition = commandOf(command.id)
    if (definition.bar === false || (contexts && !contexts.includes(definition.context))) return false
    seen.add(command.id)
    return true
  })
  const rank = (command: T) => commandContexts.indexOf(commandOf(command.id as CommandId).context)
  return eligible.filter(command => !eligible.some(other => other !== command && rank(other) > rank(command) && other.keys.some(key => command.keys.includes(key))))
}

/**
 * One go-to still open: the screen it opened (`to`, a path, compared without the search, which the period fill-in
 * rewrites on arrival), the address it was opened from (`from`) and the report trail's mark when it was opened (`mark`:
 * only drill-downs taken after it lead back towards it). `pending` while its navigation is under way.
 */
export type GoToReturn = { readonly from: string; readonly to: string; readonly mark: number; readonly pending?: boolean }

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
/** Whether the trail step of this level (its number, or null) was taken after the go-to's mark. */
const drilledFrom = (step: number | null, goTo: GoToReturn | undefined) => step !== null && (!goTo || step > goTo.mark)

/**
 * The go-to returns still open at `path`, innermost last; `step` is the number of the report trail step going back
 * from this level, or null. A return is spent once its screen is left, except into a drill-down taken from it after it
 * opened, which comes back to it; so the innermost returns are dropped while their screen is neither here nor drilled
 * into. A pending return is kept: its screen has not opened yet. Returns the same array when nothing is dropped.
 */
export function settleGoTos(stack: readonly GoToReturn[], path: string, step: number | null): readonly GoToReturn[] {
  let open = stack.length
  while (open > 0) {
    const goTo = stack[open - 1]
    if (goTo.pending || samePath(goTo.to, path) || drilledFrom(step, goTo)) break
    open--
  }
  return open === stack.length ? stack : stack.slice(0, open)
}

/**
 * Which back Escape (nav.back) and Ctrl+Q (nav.quit) take, given the settled returns: a level drilled into after the
 * innermost go-to goes up to the level it came from (the screen's own back); on the screen the innermost go-to opened,
 * back to where that go-to was opened from (go-to stacks, so the next one out applies there); otherwise the screen's own
 * back, else the shell's (the company menu). A switch-to leaves no return and puts the company menu under the screen it
 * opens, so its screen goes back the usual way, and that ends at the menu.
 */
export function backSource(path: string, stack: readonly GoToReturn[], { step, screen, shell }: { step: number | null; screen: boolean; shell: boolean }): 'go-to' | 'screen' | 'shell' | 'none' {
  const innermost = stack[stack.length - 1]
  if (screen && drilledFrom(step, innermost)) return 'screen'
  if (innermost && samePath(innermost.to, path)) return 'go-to'
  return screen ? 'screen' : shell ? 'shell' : 'none'
}

/** The `aria-keyshortcuts` value for registry chords: space-separated, with Ctrl written Control as ARIA requires. */
export const ariaKeyShortcuts = (keys: readonly string[]): string | undefined =>
  keys.length ? keys.map(chord => chord.split('+').map(part => part === 'Ctrl' ? 'Control' : part).join('+')).join(' ') : undefined

/** The parts of a focused element the Escape guard reads, so tests can pass plain objects. */
export interface FocusedElementLike {
  readonly tagName: string
  readonly isContentEditable?: boolean
  readonly type?: string
  getAttribute(name: string): string | null
}

const nonTextInputs = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'])
const editableRoles = new Set(['combobox', 'textbox', 'searchbox', 'spinbutton'])

/**
 * True when the focused element uses Escape itself (a text field, select, editable region or combobox), so `nav.back`
 * must leave the key alone. App-side guard: the `@ten98/ui` 0.37.0 resolver lets Escape run a command in a text field.
 * Delete it, and its use in KeyboardShell.tsx, once the engine keeps Escape with editable targets.
 */
export function keepsEscape(element: FocusedElementLike | null | undefined): boolean {
  if (!element) return false
  const tag = element.tagName.toLowerCase()
  if (tag === 'textarea' || tag === 'select' || element.isContentEditable === true) return true
  if (tag === 'input') return !nonTextInputs.has((element.type || 'text').toLowerCase())
  return editableRoles.has(element.getAttribute('role') ?? '')
}
