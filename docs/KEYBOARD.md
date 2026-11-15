# Keyboard commands

The command registry of D-05. Ids are a shared contract owned by the coordinator: screens register them with `useCommand` from `@ten98/ui` (through `useAppCommand` in `src/components/KeyboardShell.tsx`), keymaps bind them, and the keyboard help and the action bar list them. Source of truth: `src/lib/commands.ts` and `src/lib/keymaps.ts`; `tests/keyboard.test.ts` keeps them, and the parity table below, consistent.

`classic` is the default keymap (D-05 as amended): the keys desktop accountants already use, including accepting a screen from inside a text field. `web-safe` is a user choice on the Account page. Saved choices are kept; a user who has not chosen gets `classic` and a prompt on the company home that blocks nothing.

**Menu letters changed on 2026-11-14, in both keymaps**: new master `C`, edit a master `A`, chart of accounts `H`, day book `K` (before: `N`, `E`, `C`, `D`). Classic follows the desktop letters, and web-safe took the same set so that there is one set of letters to learn. That stays within web-safe's rule, because the letters act only while a company menu has focus.

## Contexts

A command belongs to one context. Contexts nest, and while an inner context is active and binds a key, it wins over an outer one (the registry's scope rule).

| Context | Active | Scope |
|---|---|---|
| Everywhere (`global`) | Every signed-in page | the application scope |
| Company menu (`company-home`) | Only while a company menu has focus (the home menu and the go-to lists) | `ShortcutScope activation='focus'` |
| Lists (`list`) | While a list screen is mounted | a mounted `ShortcutScope` (the masters screens) |
| Entry screens (`entry`) | While an entry screen is mounted | a mounted `ShortcutScope` (the masters forms) |
| Reports (`report`) | While a report screen is mounted | a mounted `ShortcutScope` (`src/components/reports/`) |
| A dialog | While focus is inside it | `DialogKeys` in `KeyboardShell.tsx`: a modal scope with Ctrl+Q to close and, where the dialog applies something, the accept keys |

Intended overlaps: Escape and (classic) Ctrl+Q on entry and list screens are their own cancel, not `nav.back` and `nav.quit`; a report registers its own `nav.go-to`, so the period carries over to the next report.

## Commands and keys

| Id | Title | Context | Web-safe | Classic |
|---|---|---|---|---|
| `help.keyboard` | Show keyboard shortcuts | Everywhere | `Ctrl+/` | `F1`, `Ctrl+/` |
| `nav.back` | Go back one level | Everywhere | `Escape` | `Escape` |
| `nav.quit` | Leave this screen | Everywhere | (none) | `Ctrl+Q` |
| `company.switch` | Change company | Everywhere | `Alt+K` | `F3` |
| `nav.go-to` | Go to a screen (Escape comes back) | Everywhere | `Alt+G` | `Alt+G` |
| `nav.switch-to` | Switch to a screen (Escape goes to the menu) | Everywhere | (none) | `Ctrl+G` |
| `menu.next` | Highlight the next item | Company menu | `ArrowDown` | `ArrowDown` |
| `menu.previous` | Highlight the previous item | Company menu | `ArrowUp` | `ArrowUp` |
| `menu.first` | Highlight the first item | Company menu | `Home` | `Home` |
| `menu.last` | Highlight the last item | Company menu | `End` | `End` |
| `menu.open` | Open the highlighted item | Company menu | `Enter` | `Enter` |
| `home.new-master` | New master | Company menu | `C` | `C` |
| `home.edit-master` | Edit a master | Company menu | `A` | `A` |
| `home.chart-of-accounts` | Chart of accounts | Company menu | `H` | `H` |
| `home.vouchers` | Vouchers | Company menu | `V` | `V` |
| `home.day-book` | Day book | Company menu | `K` | `K` |
| `home.balance-sheet` | Balance sheet | Company menu | `B` | `B` |
| `home.profit-and-loss` | Profit and loss | Company menu | `P` | `P` |
| `home.trial-balance` | Trial balance | Company menu | `T` | `T` |
| `home.ledger` | Ledger | Company menu | `L` | `L` |
| `home.cost-centres` | Cost categories and centres | Company menu | `E` | `E` |
| `report.open.group-summary` | Group summary | Company menu | `G` | `G` |
| `report.open.cost-category-summary` | Cost category summary | Company menu | `Y` | `Y` |
| `report.open.cost-centre-breakup` | Cost centre break-up | Company menu | `U` | `U` |
| `list.next` | Highlight the next row | Lists | `ArrowDown` | `ArrowDown` |
| `list.previous` | Highlight the previous row | Lists | `ArrowUp` | `ArrowUp` |
| `list.first` | Highlight the first row | Lists | `Home` | `Home` |
| `list.last` | Highlight the last row | Lists | `End` | `End` |
| `list.open` | Open the highlighted row | Lists | `Enter` | `Enter` |
| `list.create` | Create | Lists | `Alt+C` | `Alt+C` |
| `list.delete` | Delete the selected item | Lists | `Alt+X` | `Alt+D` |
| `list.history` | Show the history of the selected item | Lists | `Alt+Y` | `Alt+H` |
| `list.cancel` | Clear the filter, then go back | Lists | `Escape` | `Escape` |
| `list.move` | Move the selected cost centre | Lists | `Alt+Q` | `Alt+Q` |
| `list.switch` | Switch cost centres on or off | Lists | `Alt+N` | `Alt+N` |
| `entry.accept` | Save | Entry screens | `Ctrl+Enter` | `Ctrl+A`, `Ctrl+Enter` |
| `entry.cancel` | Leave without saving | Entry screens | `Escape` | `Escape`, `Ctrl+Q` |
| `entry.next-field` | Next field | Entry screens | `Enter` | `Enter` |
| `entry.create-master` | Create a master here | Entry screens | `Alt+C` | `Alt+C` |
| `entry.delete` | Delete this entry | Entry screens | `Alt+X` | `Alt+D` |
| `entry.history` | Show the history of this entry | Entry screens | `Alt+Y` | `Alt+H` |
| `entry.voucher.contra` | Switch to a contra voucher | Entry screens | `Alt+O` | `F4` |
| `entry.voucher.payment` | Switch to a payment voucher | Entry screens | `Alt+P` | `F5` |
| `entry.voucher.receipt` | Switch to a receipt voucher | Entry screens | `Alt+I` | `F6` |
| `entry.voucher.journal` | Switch to a journal voucher | Entry screens | `Alt+J` | `F7` |
| `entry.voucher.sales` | Switch to a sales voucher | Entry screens | `Alt+L` | `F8` |
| `entry.voucher.purchase` | Switch to a purchase voucher | Entry screens | `Alt+U` | `F9` |
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
| `report.export` | Export as CSV | Reports | `Alt+O` | `Ctrl+E` |
| `report.print` | Print | Reports | `Alt+I` | `Ctrl+P` |

`Ctrl` is `Ctrl` on every platform here (the keymaps do not use `Mod`), and `Alt` is Option on Apple keyboards. The `entry.voucher.*` commands are reserved for the voucher screens; nothing registers them yet. Web-safe report letters come from inside each word (Period, More, expOrt, prInt).

## Parity with desktop accounting keys

The classic key of every command, compared with the private shortcut catalogue (D-05 parity audit, D-11: the key paths are kept, the wording is ours). **same**: the catalogue's key for the same action in the same context. **alternate**: differs for a stated browser reason. **ours**: no counterpart in the catalogue. Counts: 43 same, 0 alternate, 16 ours, over 59 commands.

How the catalogue's button bars map to keys, as the analyst established by pressing: the bars never print the modifier; a bottom-bar button that acts on the row or record (create a master, delete, void, and on the day book duplicate, insert and add) is an Alt chord; accept, quit and the side-bar letter buttons are Ctrl chords; a bare letter never runs a button. So list create and delete are `Alt+C` and `Alt+D`, entry delete is `Alt+D`, and the reserved remove and restore line keys are `Alt+R` and `Alt+U`. On the catalogue's lists a bare letter jumps to the next row starting with it; our lists do not do that yet (not built). Every catalogue key that has a command here could be kept, because each is one a browser tab receives; the alternates are all for features still to come (next section).

| Id | Context | Classic | Parity | Note |
|---|---|---|---|---|
| `help.keyboard` | Everywhere | `F1`, `Ctrl+/` | same | F1 opens help; Ctrl+/ is an extra key of ours. |
| `nav.back` | Everywhere | `Escape` | same | A text field keeps Escape for itself, and a dialog closes on it. |
| `nav.quit` | Everywhere | `Ctrl+Q` | same | Leaves one level without asking, also from inside a text field. At the company menu it does nothing, as there is nothing above it. Firefox on Linux quits on Ctrl+Q before the page sees it. |
| `company.switch` | Everywhere | `F3` | same |  |
| `nav.go-to` | Everywhere | `Alt+G` | same | Opens a screen on top of this one: Escape there comes back here. |
| `nav.switch-to` | Everywhere | `Ctrl+G` | same | Opens a screen in place of this one: Escape there goes to the company menu. |
| `menu.next` | Company menu | `ArrowDown` | same |  |
| `menu.previous` | Company menu | `ArrowUp` | same |  |
| `menu.first` | Company menu | `Home` | same |  |
| `menu.last` | Company menu | `End` | ours |  |
| `menu.open` | Company menu | `Enter` | same |  |
| `home.new-master` | Company menu | `C` | same |  |
| `home.edit-master` | Company menu | `A` | same |  |
| `home.chart-of-accounts` | Company menu | `H` | same |  |
| `home.vouchers` | Company menu | `V` | same |  |
| `home.day-book` | Company menu | `K` | same |  |
| `home.balance-sheet` | Company menu | `B` | same |  |
| `home.profit-and-loss` | Company menu | `P` | same |  |
| `home.trial-balance` | Company menu | `T` | ours | One menu deeper in the catalogue, with no letter recorded. |
| `home.ledger` | Company menu | `L` | ours | One menu deeper in the catalogue, with no letter recorded. |
| `home.cost-centres` | Company menu | `E` | ours | In the catalogue the cost centres are reached through the list of masters, with no letter recorded. |
| `list.create` | Lists | `Alt+C` | same | Creates a master of the highlighted row's kind, under its group. |
| `list.delete` | Lists | `Alt+D` | same | Asks first; a built-in row has no delete. |
| `entry.accept` | Entry screens | `Ctrl+A`, `Ctrl+Enter` | same | Accepts the whole screen from anywhere, including inside a field; Ctrl+Enter is an extra key of ours. |
| `entry.cancel` | Entry screens | `Escape`, `Ctrl+Q` | same | Unlike the catalogue, both keys ask first when something was typed. |
| `entry.next-field` | Entry screens | `Enter` | same |  |
| `entry.create-master` | Entry screens | `Alt+C` | same |  |
| `entry.delete` | Entry screens | `Alt+D` | same | Alt, like every key on the bottom bar that acts on the record. |
| `entry.voucher.contra` | Entry screens | `F4` | same |  |
| `entry.voucher.payment` | Entry screens | `F5` | same |  |
| `entry.voucher.receipt` | Entry screens | `F6` | same |  |
| `entry.voucher.journal` | Entry screens | `F7` | same |  |
| `entry.voucher.sales` | Entry screens | `F8` | same |  |
| `entry.voucher.purchase` | Entry screens | `F9` | same |  |
| `report.next` | Reports | `ArrowDown` | same |  |
| `report.previous` | Reports | `ArrowUp` | same |  |
| `report.page-down` | Reports | `PageDown` | ours |  |
| `report.page-up` | Reports | `PageUp` | ours |  |
| `report.first` | Reports | `Home` | same |  |
| `report.last` | Reports | `End` | ours |  |
| `report.drill` | Reports | `Enter` | same |  |
| `report.period` | Reports | `F2` | same | The date, on the balance sheet. |
| `report.detail` | Reports | `Alt+F5` | same |  |
| `report.zero-lines` | Reports | `Alt+N` | ours | A configuration setting in the catalogue, not a key. |
| `report.export` | Reports | `Ctrl+E` | same |  |
| `report.print` | Reports | `Ctrl+P` | same |  |
| `report.open.group-summary` | Company menu | `G` | ours |  |
| `report.open.cost-category-summary` | Company menu | `Y` | ours | The catalogue reaches its cost reports through go-to by name, with no menu letter recorded. |
| `report.open.cost-centre-breakup` | Company menu | `U` | ours | As the cost category summary. Opens a list of centres to choose from, where the catalogue asks for the centre first. |
| `list.next` | Lists | `ArrowDown` | same | The catalogue's lists also jump to the next row starting with a typed letter; that is not built here. |
| `list.previous` | Lists | `ArrowUp` | same |  |
| `list.first` | Lists | `Home` | same |  |
| `list.last` | Lists | `End` | ours |  |
| `list.open` | Lists | `Enter` | same | Opens the highlighted row for alteration. |
| `list.history` | Lists | `Alt+H` | ours | No history view in the catalogue. Alt+H, because Alt+Y is reserved for the data menu. |
| `list.cancel` | Lists | `Escape` | same | Escape only: Ctrl+Q leaves the list at once through nav.quit. |
| `entry.history` | Entry screens | `Alt+H` | ours | As the list history. |
| `list.move` | Lists | `Alt+Q` | ours | The catalogue moves a centre by altering its category and parent; this opens that alteration on the category. |
| `list.switch` | Lists | `Alt+N` | ours | The catalogue switches the feature on its features screen (F11, which a tab cannot receive; Ctrl+F11 is reserved for that screen as a whole). |

### Reserved keys

Catalogue keys whose feature does not exist yet (`classicReserved` in `src/lib/keymaps.ts`), described in our own words for what the later feature will do. No command may take them in their context, and a global reservation holds in every context except where the catalogue itself reuses the key (F2 is the period on a report; Ctrl+E and Ctrl+P export and print a report). 27 groups, 74 keys. Where the catalogue's key is one a browser tab never receives, the reserved key is the proposed alternate and the last column gives the catalogue key and the reason.

In classic every reserved key with Ctrl, Alt or Meta, and every reserved function key, is **claimed**, except the copy and editing chords, Ctrl+A and Ctrl+F (see "Copying and editing are never taken" below): the registry takes it from the browser and runs nothing (`ReservedKeys` in `KeyboardShell.tsx`, mounted in each context's scope), so a key an accountant expects never opens the browser's history, bookmarks, address bar or print dialog. Single letters and Space are reserved but not claimed: they type or act on the focused control, and the registry runs single printable keys only in a focused menu. The messaging key comes from the observation notes of the shell's share menu, not from the shortcut catalogue itself.

| Context | Purpose | Reserved | Catalogue key a tab cannot take |
|---|---|---|---|
| Everywhere | Set the date that new entries start from | `F2` |  |
| Everywhere | Open a calculator beside the screen | `Alt+=` | `Ctrl+N`: Ctrl+N opens a new browser window; a page never receives it. |
| Everywhere | Turn optional accounting features on or off | `Ctrl+F11` | `F11`: F11 switches the browser to full screen; a page never receives it. |
| Everywhere | Choose what the screen shows | `F12` |  |
| Everywhere | Pick from every company on the installation, or put the open company aside | `Alt+F3`, `Ctrl+F3` |  |
| Everywhere | Menus for the company, data housekeeping, bringing data in, sending data out, sharing and printing | `Alt+K`, `Alt+Y`, `Alt+O`, `Alt+E`, `Alt+M`, `Alt+P` |  |
| Everywhere | Print or export what is on the screen | `Ctrl+P`, `Ctrl+E` |  |
| Everywhere | Exchange-rate tools | `Alt+Z` |  |
| Everywhere | Search everything recorded in the company | `Alt+F` |  |
| Everywhere | E-mail what is on the screen | `Ctrl+M` |  |
| Everywhere | Send what is on the screen through a chat service | `Alt+W` | `Ctrl+Alt+W`: Windows reports Ctrl+Alt as AltGr, which types characters, so the registry does not run commands on it there. |
| Company menu | Menu letters for banking tools, a stock overview, ratio analysis, the full list of reports, an overview page and signing out | `N`, `S`, `R`, `D`, `O`, `Q` |  |
| Lists | Mark a row; hide a row from the view and bring it back | `Space`, `Alt+R`, `Alt+U` |  |
| Lists | List views and settings: another grouping, other kinds of master, valuation settings, other layouts, exception lists, saved layouts and filters | `F5`, `F10`, `Ctrl+B`, `Ctrl+H`, `Ctrl+J`, `Ctrl+L`, `Ctrl+F` |  |
| Entry screens | Pick another voucher type from the full list | `F10` |  |
| Entry screens | Switch to the voucher types for returns, stock moves, stock counts and customer orders | `Alt+F5`, `Alt+F6`, `Alt+F7`, `Ctrl+F7`, `Ctrl+F8` |  |
| Entry screens | Change the entry layout, add details, mark the entry provisional, reuse a skipped number, fill from an earlier entry, open reports about it | `Ctrl+H`, `Ctrl+I`, `Ctrl+L`, `Ctrl+U`, `Ctrl+F`, `Ctrl+O` |  |
| Entry screens | Take a line out of the entry and put it back | `Alt+R`, `Alt+U` |  |
| Entry screens | Mark the entry as dated in the future | `Alt+T` | `Ctrl+T`: Ctrl+T opens a new browser tab; a page never receives it. |
| Entry screens | Close an order before everything on it has been delivered | `Alt+L` | `Ctrl+W`: Ctrl+W closes the browser tab; a page never receives it. |
| Reports | Other ways to see the report: by group, by month, at another valuation, by stock group, with profit, with orders; on the cost reports another centre or group, and group-wise or ledger-wise | `F4`, `F5`, `F6`, `F7`, `F8`, `F9` |  |
| Reports | Valuation settings, other layouts, exception lists, saved layouts and filters | `Ctrl+B`, `Ctrl+H`, `Ctrl+J`, `Ctrl+L`, `Ctrl+F` |  |
| Reports | Add, change and remove comparison columns | `Ctrl+C`, `Ctrl+A`, `Ctrl+D` |  |
| Reports | Add comparison columns automatically | `Alt+J` | `Ctrl+N`: Ctrl+N opens a new browser window; a page never receives it. |
| Reports | Mark a line; hide a line from the view and bring it back | `Space`, `Alt+R`, `Alt+U` |  |
| Reports | On a day book row: void it, delete it, copy it, insert an entry before it, add one after it | `Alt+X`, `Alt+D`, `Alt+2`, `Alt+I`, `Alt+A` |  |
| Reports | Save a tax return | `Alt+B` |  |

The reservations bind classic only; web-safe keeps its own rules. `Alt+2` is taken by Linux browsers for the second tab; the day book will need an alternate there when that row action is built.

## Keys that act the same on every screen

In classic, these keys do the same thing from the company menu, a list, an entry form, a report and the alter list's search field, and from inside a text field where the catalogue does so (`tests/keyboard.test.ts`, "global keys behave the same…" and "focus targets…"):

- **Help, F1**: the keyboard help, from anywhere outside a dialog.
- **Change company, F3**: the company list, from anywhere outside a dialog, fields included.
- **Go to, Alt+G, and switch to, Ctrl+G**: the same list of the masters, vouchers and reports, opened by letter or Enter (`GoToDialog` in `KeyboardShell.tsx`; on a report, its own list, which carries the period over). Its title says which one is open. Go to stacks: Escape on the screen it opened returns to the screen it was opened from. Switch to replaces: the company menu takes the place of the screen it was opened from and the new screen opens on top, so Escape there lands on the company menu. Both go through `useOpenScreen`, and Escape and Ctrl+Q pick their target with `backSource` (`src/lib/commands.ts`):
  - On a report level drilled into after the go-to, they take the report's own back first, one level up. A level that shares the screen's path, such as a group inside the group summary, counts too. A period change, a page turn or a view switch on a level keeps it the same level (`reportLevel`).
  - On the screen the go-to opened, they take the go-to return. A return belongs to that screen's history entry: a form opened from it and closed again, a drill-down and back, the browser's back and forward, all come back to that entry and find the return. The return leads back in history to the entry the go-to was opened from.
  - Otherwise they take the screen's own back, else the shell's.
  - Go-tos nest: each Escape unwinds one.
  - A return is used once. It goes when its history entry is overwritten (a new screen opened after going back past it) or replaced by another screen (`afterHistory`), so reaching the same screen again another way goes back the usual way. A go-to to the screen already shown (the same path, whatever its address says: another highlight, period or subject) opens it in place on the same history entry and leaves no return, so the returns already held there still apply; another subject of the same report therefore replaces the one shown instead of stacking over it.
  - Go-to returns and the report drill trail live in the page's memory only. A reload, or the same address opened in a new tab, has neither: Escape then falls back to the screen's own logical parent, such as a group to its parent group or statement, and from a top screen to the company menu.
  - Web-safe has go-to only (Ctrl+G is the browser's find-next).
- **Back, Escape**: one level up. A text field, select or combobox keeps Escape (the field's own meaning; entry screens and the alter list handle it themselves), and a dialog closes on it.
- **Leave, Ctrl+Q**: one level up without asking, also from inside a text field, in one press (the alter list included: its Escape ladder is Escape's alone); on an entry screen it is the screen's own cancel, which asks first when something was typed; in any dialog it closes the dialog as Escape does.
- **Accept, Ctrl+A**: on an entry screen, from any field, button or lookup; in the period dialog it applies the period. Elsewhere there is nothing to accept and the key keeps its browser meaning (select all).
- **Period, F2**: on a report, the period (or the date). Elsewhere F2 is reserved for changing the working date, which does not exist yet.
- **Calculator**: reserved (`Alt+=`, as Ctrl+N cannot be taken).
- **Kept from the browser**: in classic, a key that belongs to a switched-off command (delete on a built-in row, Ctrl+Enter for a viewer) or to a reserved feature is still taken from the browser and does nothing (`disabledClaims` and `reservedClaims`), and so are the chords an accountant presses by habit whose browser action would disrupt the work (`habitChords`: Ctrl+P, Ctrl+D, Ctrl+H, Ctrl+E, Ctrl+B, Ctrl+J, Ctrl+L, Ctrl+U, Ctrl+R, F5, F10, F12, Alt+D and the browser's Alt menu letters), application-wide, with any command still taking its key first. Every dialog (`DialogKeys`: help, go-to, change company, the report's period and go-to, every confirmation) closes on Ctrl+Q, opens the help on F1, and claims every other classic key, because a dialog cuts off the scopes around it. Escape, Enter, the arrows, Tab and letters are never claimed. Web-safe claims nothing.
- **Copying and editing are never taken**: Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z are never claimed on any screen, in any dialog or on any focus target, so figures can be copied out of every list, every report (the day book included) and every field, the period dialog's dates included. Ctrl+A is never claimed where no accept command is running: it selects on reports, lists, the menus and dialogs that apply nothing, and accepts only on entry screens (D-05) and in a dialog that applies something (the period dialog). Ctrl+F is not claimed either, so the browser's find works on a long report until a find feature exists. Some of these keys stay reserved for a later meaning (the report's column keys); a command that takes one later must yield to the browser over a selection or in an editable field. The rule is `neverClaimed` and `claimable` in `src/lib/keymaps.ts`, which every claim goes through. (Before this, classic blocked copying in every list, every report and every dialog, not only in the alter list's search field.)

## Masters screens

The chart of accounts, the cost categories and centres list, the create and alter forms and the history views register the list and entry commands. The bar above each page shows the ones that apply right now: a command that does not apply (delete on a built-in row, anything that changes data for a viewer) is off and leaves the bar.

- **In classic, Ctrl+A accepts and does not select all.** It saves from anywhere in a form, including inside a text field (owner decision). In web-safe, accept is `Ctrl+Enter` only and `Ctrl+A` selects the text of the field as usual. In classic, `Ctrl+Q` leaves an entry screen like Escape; `Y` and `N` answer the Save panel (yes and keep editing).
- **Where the keys lead.** Company menu: `H` opens the chart of accounts, `C` the choice of what to create, `A` the alter list. Chart: arrows and Enter alter a row; `Alt+C` creates under the highlighted group; Escape returns to the company menu. Alter list (`/masters/edit`): a search field has focus; typing (or pasting, dictating) filters, Up, Down and Enter run from the field while Home and End keep moving its caret, Escape clears the filter and then moves to the list, where Escape goes back; Ctrl+Q leaves at once. Forms: Enter moves through the fields in a fixed order, Enter on the last field shows a Save panel with Save focused (Enter saves, Escape keeps editing), and after a create the form clears for the next entry with the group kept. A lookup with its list open keeps Enter for picking a row: type to filter, `ArrowDown` to the row, Enter to pick it, Enter again to move on. A lookup never keeps free text: Enter on typed text with no row highlighted, leaving the field, or a save picks the one choice the text names (typing cre picks Cr, and Enter then moves on), and any other text is an error on that field.
- **One Escape command at a time.** `entry.cancel` is always enabled on an entry screen: the registry lets a scope keep a key whose command it has disabled, so a command switched off by focus would leave Escape dead on buttons, the Save panel and a viewer's screen. The shell's `nav.back` shares the key but sits outside the entry scope, and the action bar lists only the innermost command for a shared key (`barCommands` in `src/lib/commands.ts`), so it shows "Leave without saving" alone. Escape on the Save panel closes it and returns focus to the last field. The history screen has no entry commands: Escape (and in classic Ctrl+Q, `nav.quit`) goes back to the row it was opened from. The stock combobox keeps every Escape to itself, even with its list closed, so `LookupField` hands a closed lookup's Escape to `entry.cancel`; with the list open the first Escape closes the list. Every chord the active keymap binds to `entry.accept` (read from the registry: `Ctrl+Enter` in web-safe, `Ctrl+A` and `Ctrl+Enter` in classic) does the same with a lookup list open: it picks the highlighted row, or with none settles the typed text (an error on that field, or the single match), then accepts once (`lookupKeyAction` in `src/lib/masters.ts`). The choice list under Create comes back on the last thing created.
- **Typed work is never lost by leaving.** `useLeaveGuard` (`src/components/masters/entry.tsx`) asks "Leave without saving?" before any route change away from a form with typed changes (go-to, switch-to, the company switcher, a link, the browser's back), and the browser warns before a reload or closing the tab. Escape, Ctrl+Q and the Leave button ask before they navigate (`guard.leave`), so the address does not change while the question is open; the browser's own back changes the address first, because the browser moves it before any page code runs, and "Keep editing" puts it back. After a save or a delete the form leaves without asking (`guard.pass`). Every entry screen guards itself this way, and a test checks that each screen rendering `EntryScope` does.
- **Lookups are text fields.** Every field of the forms is a text field or a lookup (Dr/Cr, nature and the gross-profit flag are lookups too), because the registry leaves Enter on selects and checkboxes to the element. The movement and entry commands `entry.next-field`, `entry.accept` and `entry.cancel` are registered with `allowInTextInput`, so they run from inside a field; `entry.cancel` does nothing while a lookup's list is open or a dialog is up.

### Cost categories and centres

Screens for the company's cost categories and cost centres (rules and routes: [LEDGER.md](LEDGER.md), "Cost categories and cost centres"). They reuse the masters components, so everything above (Enter-advance, one Escape owner, the leave guard, lookups that never keep free text, the Save panel) holds here too.

- **Where they are.** Company menu letter `E` (and the go-to and switch-to lists) opens `/masters/cost-centres`. Create (`C`) offers Cost category and Cost centre after Group and Ledger, and the alter list (`A`) finds them by name beside groups and ledgers. Forms are at `/masters/new/cost-category`, `/masters/new/cost-centre`, `/masters/edit/cost-category/<id>`, `/masters/edit/cost-centre/<id>`, with history at `/masters/history/cost-category/<id>` and `/masters/history/cost-centre/<id>`.
- **The list.** One row per category (a Built-in badge on the general category, its two allocation settings in words), each followed by its centres as a tree. A centre whose parent was left in another category after a move is listed at the top of its own category and says where its parent is, as the server allows that state. Arrows, Home, End and Enter move and alter. `Alt+C` (`list.create`) makes a centre: on a category row in that category, on a centre row beside it (same category and parent), and the form starts on the category. A category is made from the Create list or the button above. `Alt+D` in classic and `Alt+X` in web-safe delete the highlighted row after asking; the built-in category has no delete, and a row in use is not blocked by the page: the server's refusal is shown as it is said, in an alert that is announced, and focus stays on the row. `Alt+H` and `Alt+Y` open the history. `Alt+Q` (`list.move`, a centre) opens the alteration with the cursor on the category, which is where a move starts; Enter on a row starts on the name instead.
- **The company switch.** Cost centres are off by default for a company. While off, the list says so and that vouchers do not ask for them yet; categories and centres can still be set up. An owner or admin has the switch (`Alt+N`, `list.switch`, or the button): on at once, off after a question, since new allocations are then dropped while saved ones stay and the reports still count them. Everyone else is told to ask one. The server refuses any other role as not found, and the screen words that as it does for every write.
- **Category form.** Name, name in a second language, then two Yes/No lookups: used on income and expense ledgers (Yes for a new category) and used on balance-sheet ledgers (No). They mean that the centres of the category may be allocated on those ledgers. The server stores both and does not check them against voucher lines; the form says so. A name another category has is an error on Name.
- **Centre form.** Fields in the order of the reference: category, name, second-language name, what it sits under. The Under lookup offers the top level and the centres of the chosen category, never the centre itself or anything below it. Choosing a parent puts the centre in that parent's category; choosing another category drops a parent that is not in it (the parent a centre already has stays, which the server allows). Names are shared by all categories, so the same name in another category is refused on the Name field. Vouchers already saved keep the category they were saved with when a centre is moved; reports follow the centre (the form says so).
- **The ledger form** asks "Takes cost centres" after the group and before the opening balance (the observation notes do not record the exact position; this is the place the group-dependent ledger settings have). Left alone on a new ledger it follows the group, as the server does: income and expense groups take cost centres, others do not; the field shows the value in force and says what the default is for the chosen group, and when the company has the feature off that vouchers do not ask yet. The profit and loss ledger takes none, and the field is locked there. An altered ledger always shows and sends its own value. The ledger history lists a change of the setting.
- **Typed answers.** On every lookup of the masters forms (the Yes/No ones, groups, categories, centres, natures, Dr and Cr), typing a choice (`yes`, `no`, the start of a name) and pressing Enter picks it and moves on, and so does Enter on text that names the choice already held, so Enter is never needed twice. A value the combobox reports is taken whenever it is an enabled option's, including a picked row whose value equals what was typed (type `no`, `ArrowDown`, Enter, or a click on the row, picks No). Names are matched the way the database compares them, under the name match key (`nameMatchKey` in `src/lib/names.ts`, the twin of the database key described in [LEDGER.md](LEDGER.md)): case, spaces and `- . / , ( ) + * ; = ~ ? { } &` do not matter and an underscore does, so `znm1`, `z nm.1` and `Z-NM 1` all name the same choice and `z_nm` does not; text made only of ignored characters counts as empty. The list shows the choices whose name holds the typed text anywhere, in their own order; Enter on typed text with no row highlighted takes one enabled choice, in this order: the name whose key equals the text (a built-in choice such as Primary or Top level wins over a user's name with the same key), the one name or word (words split at spaces and the ignored characters too) that starts with it, then the one name that holds it anywhere, which is what the list shows; if several fit it says so, if none it says it is not one of the choices, and a choice a rule disables is never taken (it answers with its reason, also when its name is the exact text). This order is ours and provisional: the reference notes record only that differently spelled text left a single match, not whether names match from the start or anywhere, so it is to be observed. A pick is always the choice's own value, never the typed text. A name the server refuses as a duplicate (`duplicate_name`) shows its message on the Name field of the create and alter forms, keeping every typed value, with the cursor on that field; editing the name clears the message. The decisions are pure functions in `src/lib/lookup-entry.ts`, applied by `useEntryLookups`, which the group, ledger, cost category and cost centre forms all use.
- **Viewers** see the list and every form read-only with Back focused, no Create, Delete, Move or Switch, and the server's refusal is worded as for any write if one is forced.
- **Not here.** Cost allocation on voucher lines (the voucher entry screen), and creating a category from inside the lookup of the centre form (`entry.create-master` is registered on every entry screen switched off: there is nothing to create in place yet, and classic keeps its chord, `Alt+C`, from the browser).

## Reports

Report screens (`src/routes/app/c.$companyId.reports*.tsx`, with their frame in `src/components/reports/`) mount the `report` context. The highlighted line is the table's current row and holds focus, so the table's own Up, Down, Home, End and Enter act on the focused row, and the commands do the same from anywhere else on the page. Escape stays `nav.back`: on a report it goes back one drill-down level (`useBackOverride` in `KeyboardShell.tsx`) and highlights the line it left from, and from a statement it returns to the company menu. Go to (`Alt+G`) and, in classic, switch to (`Ctrl+G`) open the report's own list of reports, a `KeyboardMenu`, so the company-menu letters open a report there and `G` the group summary; go to stacks and switch to replaces, as everywhere. In the period dialog the date fields keep the arrow keys, Enter or classic `Ctrl+A` applies the period, and Escape or classic `Ctrl+Q` closes the dialog without leaving the report. In classic, `Ctrl+E` exports and `Ctrl+P` prints the report on screen, taking those keys from the browser while a report is open.

**Cost reports.** The cost category summary (menu letter `Y`) and the cost centre break-up (`U`) are on the company menu, in the go-to and switch-to lists and in the report's own list, under Cost centres; the catalogue opens them through go-to by name, which our list does by letter. They use the keys of every report: arrows, Enter to drill, Escape back, the period (`F2` in classic, `Alt+P` in web-safe), export (`Ctrl+E`, `Alt+O`) and print (`Ctrl+P`, `Alt+I`). Enter on a centre of the summary opens that centre's break-up (the catalogue opens a centre summary there, which is not built); in the break-up, Enter on a sub-centre opens its break-up and on a ledger the ledger's vouchers for the period. Opened without a centre, the break-up lists the centres: typing narrows the list and Enter opens the highlighted one. The catalogue's other keys on these reports are reserved in classic and not built: `F4` another centre (summary) or group (break-up), `F5` group-wise or ledger-wise, `F6` the monthly view, and `F12` the report settings. When the company has cost centres switched off, both screens say so with the masters screen's notice and still show what was saved. Viewers read them like every report.

## Rules the tests enforce

- Both keymaps bind every command; web-safe leaves the classic-only ones (`classicOnly`: `nav.quit`) unbound. Classic is the default.
- No two commands share a key in one context, in either keymap; no classic command takes a key reserved in its context or a global reservation, except the listed overlap (`reservedShadows`).
- Single printable keys appear only in the company menus, which take them only while they have focus (WCAG 2.1.4).
- Web-safe binds no function key, nothing in `browserReservedChords` (`src/lib/keymaps.ts`, with the reason for each group) and nothing the `@ten98/ui` `reservedChord` table lists, on Windows/Linux or Apple.
- Classic binds no key a page can never receive (`reservedChord` kind `reserved`), and every reserved key is one a page can receive; a catalogue key it cannot names its reason and alternate.
- Every command has a parity entry, and this document's parity table shows each with that status.
- Classic claims every reserved key with a modifier or a function key in its context, the habit chords application-wide, and the keys of a switched-off command; a dialog claims every classic key it does not run itself; web-safe claims nothing; Escape, Enter, arrows and letters are never claimed; the copy and editing chords, Ctrl+A where nothing accepts, and Ctrl+F are never claimed.
- Every component that renders `EntryScope` uses `useLeaveGuard`.

## Behaviour

- Escape goes back one level: from any company page to the company menu, where the item last opened in this tab is highlighted again and focus returns to the menu. The menu is the top level, so Escape there does nothing; elsewhere outside a company it keeps its native meaning.
- Escape never leaves a page while a text field, select, editable region or combobox has focus, or while a dialog, popover or popup is open: those keep Escape for themselves. This is an app-side guard (`keepsEscape` in `src/lib/commands.ts`, used in `KeyboardShell.tsx`) because the `@ten98/ui` 0.37.0 resolver runs Escape commands from text fields; delete it once the engine keeps Escape with editable targets. Ctrl+Q (`nav.quit`) is a separate command so that it is not caught by this guard.
- The company menu keeps `role="menu"` with an active descendant rather than links with roving focus: a focused link is a control, and the registry leaves arrows and Enter on controls to the element, so the arrows would need a second, local key handler. A badge above the menu says whether its letter keys are live; each item carries its key in `aria-keyshortcuts`, not in its name.
- The action bar above each page lists the enabled commands registered there, except movement keys and menu letters (`bar: false`). Its buttons, the menu items and the forms' Save and Delete buttons carry their keys in `aria-keyshortcuts` (`ariaKeyShortcuts` in `src/lib/commands.ts`).
- The keymap is stored per user (`user_keymap`, `GET`/`PUT /api/account/keymap`); without a saved row the server answers `classic`, not chosen.

## Open

- Cross-browser key reachability (D-05) is not settled. The `@ten98/ui` 0.37.0 reachability matrix covers F1–F10, F12, Enter, Escape, Ctrl+A, Ctrl+Enter, Ctrl+S, Ctrl+P, Alt+C, Alt+D, Alt+E, Alt+F, Alt+G and Ctrl+K in Chromium, Firefox and WebKit at the page level. Not yet measured in any engine: `Ctrl+Q`, `Ctrl+G`, `Ctrl+E`, `Ctrl+D`, `Alt+R`, `Ctrl+/`, `Alt+F5`, `Alt+H`, `Alt+N`, `Alt+Q`, `Alt+K`, `Alt+X`, `Alt+Y`, `Alt+O`, `Alt+P`, `Alt+I`, `Alt+J`, `Alt+L`, `Alt+U`, `Alt+M`, `PageUp`, `PageDown`, `Home`, `End` and the menu letters; not measured anywhere at the browser-window level, where the browser could take the key before the page: `F1`, `F3`, `F5`, `F6`, `Ctrl+A`, `Ctrl+D`, `Ctrl+E`, `Ctrl+G`, `Ctrl+P`, `Ctrl+Q`. The keymap-parity branch drove classic in one Chromium-based browser only.
- `Ctrl+Alt` chords: on Windows the registry treats Ctrl+Alt as AltGr and does not run a command on it, so a catalogue key such as Ctrl+Alt+W cannot be delivered; the reserved alternate is `Alt+W`. Whether to deliver Ctrl+Alt chords where no AltGr layout is active is an engine question.
- A lookup with its list open ignores Ctrl+Q (the list closes on Escape).
- Platforms, with the per-platform chords of the next `@ten98/ui` release: on macOS plain F1 to F12 act as media and display keys unless Fn is held or the keyboard setting is changed, and Ctrl+F3, Ctrl+F7 and Ctrl+F8 are system shortcuts there; Firefox on Linux quits on Ctrl+Q before the page sees it. None of these can be fixed from the page.
- Menu letters on non-Latin keyboard layouts: an Arabic layout sends a different character for the same physical key, so the letters do nothing there; the arrows and Enter still work. This needs the engine to match unmodified printable keys by physical key as it already does for modified ones; requested from the design system, no local workaround.
- A switch-to that the leave guard holds back ("Keep editing") is not cancelled: the router settles its first step only with the next completed navigation, and if that navigation reaches the company menu, the switch-to's target then opens unexpectedly. Found in review on `dev`; not fixed yet.
- Lists do not jump to the next row starting with a typed letter, as the catalogue's lists do (not built).
- Coming back to the menu highlights the last item only when it was opened from the menu. Arriving any other way (sidebar, address bar, reload) highlights the first item.
- Apple platforms: the web-safe `Alt+letter` chords for lists and entry screens (`Alt+C`, `Alt+X`, `Alt+Y`, `Alt+Q`, `Alt+N`, `Alt+O`, `Alt+P`, `Alt+I`, `Alt+J`, `Alt+L`, `Alt+U`) and the classic `Alt+C`, `Alt+D`, `Alt+H`, `Alt+Q`, `Alt+N` and `Alt+G` are Option+letter on macOS, which types characters and starts dead keys, so binding them takes those characters away from text fields. An Apple overlay waits on per-platform keymap entries in the registry, requested from the design system; the app does not detect the platform itself. They stay unverified on Apple until then.
- `@ten98/ui` gaps noticed: `Dialog` has no initial-focus target, so dialogs open with focus on their close button; the go-to and report dialogs move focus to their list after two animation frames (`useFocusOnOpen` in `src/components/reports/ReportScreen.tsx`), the company picker needs one Tab.
