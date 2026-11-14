# Keyboard commands

The command registry of D-05. Ids are a shared contract owned by the coordinator: screens register them with `useCommand` from `@ten98/ui` (through `useAppCommand` in `src/components/KeyboardShell.tsx`), keymaps bind them, and the keyboard help and the action bar list them. This table is a proposal from the keyboard-shell branch until the coordinator accepts it. Source of truth: `src/lib/commands.ts` and `src/lib/keymaps.ts`; `tests/keyboard.test.ts` keeps them consistent.

## Contexts

A command belongs to one context. Contexts nest, and while an inner context is active and binds a key, it wins over an outer one (the registry's scope rule).

| Context | Active | Scope |
|---|---|---|
| Everywhere (`global`) | Every signed-in page | the application scope |
| Company menu (`company-home`) | Only while the company menu has focus | `ShortcutScope activation='focus'` |
| Lists (`list`) | While a list screen is mounted | a mounted `ShortcutScope` (no screen yet) |
| Entry screens (`entry`) | While an entry screen is mounted | a mounted `ShortcutScope` (no screen yet) |

The one intended overlap: Escape on an entry screen is `entry.cancel`, not `nav.back`.

## Commands and keys

| Id | Title | Context | Web-safe | Classic |
|---|---|---|---|---|
| `help.keyboard` | Show keyboard shortcuts | Everywhere | `Ctrl+/` | `F1`, `Ctrl+/` |
| `nav.back` | Go back one level | Everywhere | `Escape` | `Escape` |
| `company.switch` | Choose another company | Everywhere | `Alt+K` | `F3` |
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

`Ctrl` is `Ctrl` on every platform here (the keymaps do not use `Mod`), and `Alt` is Option on Apple keyboards. `list.*` and `entry.*` are reserved for the masters, vouchers and reports screens; nothing registers them yet.

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
- Apple platforms: the web-safe `Alt+letter` chords for lists and entry screens (`Alt+C`, `Alt+X`, `Alt+O`, `Alt+P`, `Alt+I`, `Alt+J`, `Alt+L`, `Alt+U`) are Option+letter on macOS, which types characters and starts dead keys, so binding them would take those characters away from text fields. An Apple overlay waits on a registry change: `@ten98/ui` 0.37.0 has one keymap for every platform (only `Mod` varies), and per-platform keymap entries have been requested from the design system; the app does not detect the platform itself. No list or entry screen registers these chords yet, so nothing is affected today. They stay unverified on Apple until the overlay and the cross-browser reachability test exist.
- `@ten98/ui` gaps noticed: `Dialog` has no initial-focus target, so the company picker opens with focus on its close button (one Tab reaches the list).
