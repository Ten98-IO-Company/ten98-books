# Keyboard commands

The command registry of D-05. Ids are a shared contract owned by the coordinator: screens register them with `useCommand` from `@ten98/ui` (through `useAppCommand` in `src/components/KeyboardShell.tsx`), keymaps bind them, and the keyboard help and the action bar list them. This table is a proposal from the keyboard-shell branch until the coordinator accepts it. Source of truth: `src/lib/commands.ts` and `src/lib/keymaps.ts`; `tests/keyboard.test.ts` keeps them consistent.

## Contexts

A command belongs to one context. Contexts nest, and while an inner context is active and binds a key, it wins over an outer one (the registry's scope rule).

| Context | Active | Scope |
|---|---|---|
| Everywhere (`global`) | Every signed-in page | the application scope |
| Company menu (`company-home`) | Only while the company menu has focus | `ShortcutScope activation='focus'` |
| Lists (`list`) | While a list screen is mounted | a mounted `ShortcutScope` (the masters screens) |
| Entry screens (`entry`) | While an entry screen is mounted | a mounted `ShortcutScope` (the masters forms) |

The one intended overlap: Escape on an entry screen is `entry.cancel`, not `nav.back`.

## Commands and keys

| Id | Title | Context | Web-safe | Classic |
|---|---|---|---|---|
| `help.keyboard` | Show keyboard shortcuts | Everywhere | `Ctrl+/` | `F1`, `Ctrl+/` |
| `nav.back` | Go back one level | Everywhere | `Escape` | `Escape` |
| `company.switch` | Change company: lists every company you belong to (each is its own workspace) with Create company | Everywhere | `Alt+K` | `F3` |
| `menu.next` | Highlight the next item | Company menu | `ArrowDown` | `ArrowDown` |
| `menu.previous` | Highlight the previous item | Company menu | `ArrowUp` | `ArrowUp` |
| `menu.first` | Highlight the first item | Company menu | `Home` | `Home` |
| `menu.last` | Highlight the last item | Company menu | `End` | `End` |
| `menu.open` | Open the highlighted item | Company menu | `Enter` | `Enter` |
| `home.new-master` | New master | Company menu | `N` | `N` |
| `home.edit-master` | Edit a master | Company menu | `E` | `E` |
| `home.chart-of-accounts` | Chart of accounts | Company menu | `C` | `C` |
| `home.vouchers` | Vouchers | Company menu | `V` | `V` |
| `home.day-book` | Day book | Company menu | `D` | `D` |
| `home.balance-sheet` | Balance sheet | Company menu | `B` | `B` |
| `home.profit-and-loss` | Profit and loss | Company menu | `P` | `P` |
| `home.trial-balance` | Trial balance | Company menu | `T` | `T` |
| `home.ledger` | Ledger | Company menu | `L` | `L` |
| `list.create` | Create | Lists | `Alt+C` | `Alt+C` |
| `list.delete` | Delete the selected item | Lists | `Alt+X` | `Alt+D` |
| `entry.accept` | Save | Entry screens | `Ctrl+Enter` | `Ctrl+A`, `Ctrl+Enter` |
| `entry.cancel` | Leave without saving | Entry screens | `Escape` | `Escape` |
| `entry.next-field` | Next field | Entry screens | `Enter` | `Enter` |
| `entry.create-master` | Create a master here | Entry screens | `Alt+C` | `Alt+C` |
| `entry.delete` | Delete this entry | Entry screens | `Alt+X` | `Alt+D` |
| `entry.voucher.contra` | Switch to a contra voucher | Entry screens | `Alt+O` | `F4` |
| `entry.voucher.payment` | Switch to a payment voucher | Entry screens | `Alt+P` | `F5` |
| `entry.voucher.receipt` | Switch to a receipt voucher | Entry screens | `Alt+I` | `F6` |
| `entry.voucher.journal` | Switch to a journal voucher | Entry screens | `Alt+J` | `F7` |
| `entry.voucher.sales` | Switch to a sales voucher | Entry screens | `Alt+L` | `F8` |
| `entry.voucher.purchase` | Switch to a purchase voucher | Entry screens | `Alt+U` | `F9` |

`Ctrl` is `Ctrl` on every platform here (the keymaps do not use `Mod`), and `Alt` is Option on Apple keyboards. `list.*` and `entry.*` are used by the masters screens (next section); the vouchers and reports screens register them as they arrive.

## Masters screens

The chart of accounts, the create and alter forms and the history view register these commands (ids owned by the coordinator, defined in `src/lib/commands.ts`). The bar above each page shows the ones that apply right now: a command that does not apply (delete on a built-in row, anything that changes data for a viewer) is off and leaves the bar.

| Id | Title | Context | Web-safe | Classic |
|---|---|---|---|---|
| `list.next`, `list.previous` | Highlight the next or previous row | Lists | `ArrowDown`, `ArrowUp` | same |
| `list.first`, `list.last` | Highlight the first or last row | Lists | `Home`, `End` | same |
| `list.open` | Open the highlighted row (alter it) | Lists | `Enter` | `Enter` |
| `list.create` | Create (opens the choice of group or ledger) | Lists | `Alt+C` | `Alt+C` |
| `list.delete` | Delete the highlighted row, after a confirmation | Lists | `Alt+X` | `Alt+D` |
| `list.history` | Show the history of the highlighted row | Lists | `Alt+Y` | `Alt+Y` |
| `list.cancel` | Alter list only: clear the filter, then move to the list, then go back | Lists | `Escape` | `Escape`, `Ctrl+Q` |
| `entry.next-field` | Next field; after the last field, ask to save | Entry screens | `Enter` | `Enter` |
| `entry.accept` | Save from anywhere in the form, at once and without the Save panel | Entry screens | `Ctrl+Enter` | `Ctrl+A`, `Ctrl+Enter` |
| `entry.cancel` | Keep editing (while saving is being confirmed), otherwise leave one level; asks first when something was typed | Entry screens | `Escape` | `Escape`, `Ctrl+Q` |
| `entry.delete` | Delete this group or ledger, after a confirmation | Entry screens | `Alt+X` | `Alt+D` |
| `entry.history` | Show the history of this group or ledger | Entry screens | `Alt+Y` | `Alt+Y` |

- **In `classic`, Ctrl+A accepts and does not select all.** It saves from anywhere in a form, including inside a text field, the way the accept key of desktop accounting software does (owner decision). In `web-safe`, accept is `Ctrl+Enter` only and `Ctrl+A` selects the text of the field as usual. In `classic`, `Ctrl+Q` leaves an entry screen like Escape; `Y` and `N` answer the Save panel (yes and keep editing).
- **Where the keys lead.** Company menu: `C` opens the chart of accounts, `N` the choice of what to create, `E` the alter list. Chart: arrows and Enter alter a row; `Alt+C` creates under the highlighted group; Escape returns to the company menu. Alter list (`/masters/edit`): a search field has focus; typing (or pasting, dictating) filters, Up, Down and Enter run from the field while Home and End keep moving its caret, Escape clears the filter and then moves to the list, where Escape goes back. Forms: Enter moves through the fields in a fixed order, Enter on the last field shows a Save panel with Save focused (Enter saves, Escape keeps editing), and after a create the form clears for the next entry with the group kept. A lookup with its list open keeps Enter for picking a row: type to filter, `ArrowDown` to the row, Enter to pick it, Enter again to move on. A lookup never keeps free text: Enter on typed text with no row highlighted, leaving the field, or a save picks the one choice the text names (typing cre picks Cr, and Enter then moves on), and any other text is an error on that field.
- **One Escape command at a time.** `entry.cancel` is always enabled on an entry screen: the registry lets a scope keep a key whose command it has disabled, so a command switched off by focus would leave Escape dead on buttons, the Save panel and a viewer's screen. The shell's `nav.back` shares the key but sits outside the entry scope, and the action bar lists only the innermost command for a shared key (`barCommands` in `src/lib/commands.ts`), so it shows "Leave without saving" alone. Escape on the Save panel closes it and returns focus to the last field. The history screen has no entry commands: Escape (and in `classic` Ctrl+Q, which is also bound to `nav.back`) goes back to the row it was opened from. The stock combobox keeps every Escape to itself, even with its list closed, so `LookupField` hands a closed lookup's Escape to `entry.cancel`; with the list open the first Escape closes the list. Every chord the active keymap binds to `entry.accept` (read from the registry: `Ctrl+Enter` in web-safe, `Ctrl+A` and `Ctrl+Enter` in classic) does the same with a lookup list open: it picks the highlighted row, or with none settles the typed text (an error on that field, or the single match), then accepts once (`lookupKeyAction` in `src/lib/masters.ts`). The choice list under Create comes back on the last thing created.
- **Lookups are text fields.** Every field of the forms is a text field or a lookup (Dr/Cr, nature and the gross-profit flag are lookups too), because the registry leaves Enter on selects and checkboxes to the element. The movement and entry commands `entry.next-field`, `entry.accept` and `entry.cancel` are registered with `allowInTextInput`, so they run from inside a field; `entry.cancel` does nothing while a lookup's list is open or a dialog is up.
- **Classic keys without a source in the observation notes:** `list.history` and `entry.history` (`Alt+Y`) have no recorded key; the screens here also keep `Alt+C` and `Alt+D` for create and delete on lists, where the desktop product uses the single letters `C` and `D` that D-05 allows only in the company menu.
- **Unverified here:** `Alt+Y` and `Ctrl+Q` (not in the `@ten98/ui` 0.37.0 reachability matrix; Option+Y types a character on Apple keyboards, like the other web-safe `Alt+letter` chords above). Menu letters on non-Latin layouts and the platform overlay stay as listed under Open.

## Reports

Report screens (`src/routes/app/c.$companyId.reports*.tsx`, with their frame in `src/components/reports/`) mount the `report` context (titled Reports) as a mounted `ShortcutScope`. The highlighted line is the table's current row and holds focus, so the table's own Up, Down, Home, End and Enter act on the focused row, and the commands below do the same from anywhere else on the page. Escape stays `nav.back`: on a report it goes back one drill-down level (`useBackOverride` in `KeyboardShell.tsx`) and highlights the line it left from, and from a statement it returns to the company menu. The "open another report" dialog is a `KeyboardMenu`, so while it has focus the company-menu letters open a report there, and `G` opens the group summary.

| Id | Title | Context | Web-safe | Classic |
|---|---|---|---|---|
| `report.next` | Highlight the next line | Reports | `ArrowDown` | `ArrowDown` |
| `report.previous` | Highlight the previous line | Reports | `ArrowUp` | `ArrowUp` |
| `report.page-down` | Move one page down (ten lines; past the last line of a register, its next page) | Reports | `PageDown` | `PageDown` |
| `report.page-up` | Move one page up | Reports | `PageUp` | `PageUp` |
| `report.first` | Highlight the first line | Reports | `Home` | `Home` |
| `report.last` | Highlight the last line | Reports | `End` | `End` |
| `report.drill` | Open the highlighted line | Reports | `Enter` | `Enter` |
| `report.period` | Change the period (the date, on the balance sheet) | Reports | `Alt+P` | `F2` |
| `report.detail` | Show more or less detail | Reports | `Alt+M` | `Alt+F5` |
| `report.zero-lines` | Show or hide lines without amounts | Reports | `Alt+N` | `Alt+N` |
| `report.export` | Export as CSV | Reports | `Alt+O` | `Alt+E` |
| `report.print` | Print | Reports | `Alt+I` | `Alt+P` |
| `report.go-to` | Open another report | Reports | `Alt+G` | `Alt+G` |
| `report.open.group-summary` | Group summary (a menu letter) | Company menu | `G` | `G` |

Web-safe letters follow the existing convention of a letter from inside the word (Period, More, expOrt, prInt). Classic keeps the conventional period, detail, export and print keys of desktop accounting software (D-11); `Alt+E` opens the browser menu bar on Windows and Linux, and the registry takes it while a report is open. None of these keys is measured by the cross-browser reachability test yet (see Open); they were driven in one Chromium-based browser. In the period dialog the date fields keep the arrow keys, Enter applies the period and Escape closes the dialog without leaving the report.

## Rules the tests enforce

- Both keymaps bind every command, and no two commands share a key in one context.
- Single printable keys appear only in the company menu, which takes them only while it has focus (WCAG 2.1.4).
- Web-safe binds no function key, nothing in `browserReservedChords` (`src/lib/keymaps.ts`, with the reason for each group) and nothing the `@ten98/ui` `reservedChord` table lists, on Windows/Linux or Apple.
- Classic binds no key a page can never receive (`reservedChord` kind `reserved`). It does take some keys browsers use themselves: F1 (help), F3 (find), F5 and F6 on entry screens only, Alt+D (address bar). The registry cancels the browser action while it runs the command.

## Behaviour

- Escape goes back one level: from any company page to the company menu, where the item last opened in this tab is highlighted again and focus returns to the menu. The menu is the top level, so Escape there does nothing; elsewhere outside a company it keeps its native meaning.
- Escape never leaves a page while a text field, select, editable region or combobox has focus, or while a dialog, popover or popup is open: those keep Escape for themselves. This is an app-side guard (`keepsEscape` in `src/lib/commands.ts`, used in `KeyboardShell.tsx`) because the `@ten98/ui` 0.37.0 resolver runs Escape commands from text fields; delete it once the engine keeps Escape with editable targets.
- The company menu keeps `role="menu"` with an active descendant rather than links with roving focus: a focused link is a control, and the registry leaves arrows and Enter on controls to the element, so the arrows would need a second, local key handler. A badge above the menu says whether its letter keys are live; each item carries its key in `aria-keyshortcuts`, not in its name.
- The action bar above each page lists the enabled commands registered there, except movement keys and menu letters (`bar: false`).
- A new user gets web-safe and a non-blocking prompt on the company home; the choice is stored per user (`user_keymap`, `GET`/`PUT /api/account/keymap`).

## Open

- Cross-browser key reachability (D-05) is not settled for this keymap. The `@ten98/ui` 0.37.0 reachability matrix covers F1–F10, F12, Enter, Escape, Ctrl+A, Ctrl+Enter, Ctrl+S, Ctrl+P, Alt+C, Alt+D, Alt+E, Alt+F, Alt+G and Ctrl+K in Chromium, Firefox and WebKit at the page level. Not yet measured in any engine: `Ctrl+/`, `Alt+K`, `Alt+X`, `Alt+O`, `Alt+P`, `Alt+I`, `Alt+J`, `Alt+L`, `Alt+U`, `Home`, `End` and the menu letters; not measured anywhere at the browser-window level (where the browser could take the key before the page): `F1`, `F3`, `F5`, `F6`, `Alt+D`, `Ctrl+A`. The keyboard-shell branch drove the home menu in one Chromium-based browser only.
- Menu letters on non-Latin keyboard layouts: an Arabic layout sends a different character for the same physical key, so the letters do nothing there; the arrows and Enter still work. This needs the engine to match unmodified printable keys by physical key as it already does for modified ones; requested from the design system, no local workaround.
- Coming back to the menu highlights the last item only when it was opened from the menu. Arriving any other way (sidebar, address bar, reload) highlights the first item.
- Apple platforms: the web-safe `Alt+letter` chords for lists and entry screens (`Alt+C`, `Alt+X`, `Alt+O`, `Alt+P`, `Alt+I`, `Alt+J`, `Alt+L`, `Alt+U`) are Option+letter on macOS, which types characters and starts dead keys, so binding them would take those characters away from text fields. An Apple overlay waits on a registry change: `@ten98/ui` 0.37.0 has one keymap for every platform (only `Mod` varies), and per-platform keymap entries have been requested from the design system; the app does not detect the platform itself. The masters screens now register `Alt+C`, `Alt+X` and `Alt+Y`, so on Apple keyboards these take Option+letter characters (such as a dead key) away from their text fields until the overlay exists. They stay unverified on Apple until the overlay and the cross-browser reachability test exist.
- `@ten98/ui` gaps noticed: `Dialog` has no initial-focus target, so the company picker opens with focus on its close button (one Tab reaches the list).
