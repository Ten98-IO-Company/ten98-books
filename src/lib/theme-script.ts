import { createThemeScript } from '@ten98/ui'

/**
 * The head script that applies the cached theme before the first paint (`createThemeScript` of `@ten98/ui`), run only while
 * `<html>` has no theme yet. The router appends head scripts again on client navigations; by then `useTheme` has set the
 * attribute from the account, and the package's script alone would write the cached value over it, or `system` when storage
 * is blocked, for a few milliseconds. The server-rendered markup has no `data-theme`, so the first load still runs it.
 */
export const themeScript = `if(!document.documentElement.dataset.theme){${createThemeScript()}}`
