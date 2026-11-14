import { useApp } from '../../lib/app-context'

/**
 * Whether the user's role in the company being viewed may change its books: undefined while the shell is still loading
 * the companies and roles, true for owner, admin and editor, false for a viewer. The server decides every write; this
 * only shapes what the screens offer.
 */
export function useCanWrite(): boolean | undefined {
  const { current } = useApp()
  return current === undefined ? undefined : current.role !== 'viewer'
}
