import { readAuthFragment, type AuthFragment } from './auth-messages.ts'

/** The part of `window` the start page uses for capabilities carried in the address fragment. */
export type FragmentWindow = {
  location: { hash: string; pathname: string; search: string }
  history: { state: unknown; replaceState: (state: unknown, unused: string, url: string) => void }
  addEventListener: (type: 'hashchange', listener: () => void) => void
  removeEventListener: (type: 'hashchange', listener: () => void) => void
}

/**
 * Reads the capability in the address fragment (an invitation or a password reset) and removes the fragment from the
 * address before anything else runs, so the token is in no request, history entry or later copy of the address.
 */
export function takeAuthFragment(win: FragmentWindow): AuthFragment | null {
  const fragment = readAuthFragment(win.location.hash)
  if (win.location.hash) win.history.replaceState(win.history.state, '', win.location.pathname + win.location.search)
  return fragment
}

/**
 * Calls `onFragment` for each capability a later fragment change brings: a link opened while the start page is already
 * loaded changes only the fragment, so the page does not load again. Returns the function that stops listening.
 */
export function watchAuthFragment(win: FragmentWindow, onFragment: (fragment: AuthFragment) => void): () => void {
  const listener = () => { const fragment = takeAuthFragment(win); if (fragment) onFragment(fragment) }
  win.addEventListener('hashchange', listener)
  return () => win.removeEventListener('hashchange', listener)
}
