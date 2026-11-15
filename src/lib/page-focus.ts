/**
 * Focus after a full load of a signed-in page (docs/KEYBOARD.md, "Behaviour"): never the page body. A page that puts
 * focus on its own first place (a form's first field, a menu, a list, a report's row) keeps it; otherwise its heading
 * takes it, else a loading state that is shown, else the main area itself (labelled, and focusable without being a tab
 * stop). The decision is pure (`afterLoadTarget`); `focusHeadingAfterLoad` applies it.
 */

type Focusable = { focus: () => void; tabIndex: number; hasAttribute: (name: string) => boolean }
type Container = { querySelector: (selector: string) => Focusable | null }

/** The heading to focus: the page's first h1 in its main area, else its first lower heading; null when there is none yet. */
export function pageHeading(main: Container | null): Focusable | null {
  return main?.querySelector('h1') ?? main?.querySelector('h2, h3') ?? null
}

/** Focuses the first h1 inside `holder` (a state screen as it is attached), making it focusable first; true when it did. */
export function focusFirstHeading(holder: Container | null): boolean {
  const heading = holder?.querySelector('h1') ?? null
  if (!heading) return false
  heading.tabIndex = -1
  heading.focus()
  return true
}

/** Whether the heading should take focus: only while nothing else has it (the body, or no element at all). */
export const headingTakesFocus = (active: unknown, body: unknown): boolean => active === null || active === body

/**
 * Where focus goes now, or null to leave it: nothing while the page has put focus somewhere itself; otherwise the main
 * area's heading, else its loading state (`[data-loading-state]`), else the main area. Focus this rule put on a loading
 * state or on the main area moves on to the heading once the page shows one.
 */
export function afterLoadTarget(active: unknown, body: unknown, main: (Container & Focusable) | null): Focusable | null {
  if (!main) return null
  const loading = main.querySelector('[data-loading-state]')
  const ours = active === main || (loading !== null && active === loading)
  if (!headingTakesFocus(active, body) && !ours) return null
  const target = pageHeading(main) ?? loading ?? main
  return target === active ? null : target
}

/**
 * Applies `afterLoadTarget` from the first render of a full load until the first key or pointer press, or `timeout`
 * milliseconds: at once, and again whenever the page changes (it is drawn, a loading state gives way, loading later drops
 * focus). Returns the function that stops it early.
 */
export function focusHeadingAfterLoad(doc: Document, { main = 'main', timeout = 15000 } = {}): () => void {
  let stopped = false
  const observer = new MutationObserver(() => attempt())
  const timer = setTimeout(() => stop(), timeout)
  function stop() {
    if (stopped) return
    stopped = true
    observer.disconnect()
    clearTimeout(timer)
    doc.removeEventListener('keydown', stop, true)
    doc.removeEventListener('pointerdown', stop, true)
  }
  function attempt() {
    if (stopped) return
    const target = afterLoadTarget(doc.activeElement, doc.body, doc.querySelector(main) as never)
    if (!target) return
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1
    target.focus()
  }
  doc.addEventListener('keydown', stop, true)
  doc.addEventListener('pointerdown', stop, true)
  observer.observe(doc.body, { childList: true, subtree: true })
  attempt()
  return stop
}
