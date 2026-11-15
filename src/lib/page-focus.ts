/**
 * Focus after a full load of a signed-in page (docs/KEYBOARD.md, "Behaviour"): a page that puts focus on its own first
 * place (a form's first field, a menu, a list, a report's row) keeps it; otherwise the page's heading takes it once it is
 * on the page, so focus is never left on the page body. The decision is pure; `focusHeadingAfterLoad` applies it.
 */

type Focusable = { focus: () => void; tabIndex: number; hasAttribute: (name: string) => boolean }
type Container = { querySelector: (selector: string) => Focusable | null }

/** The heading to focus: the page's first h1 in its main area, else its first lower heading; null when there is none yet. */
export function pageHeading(main: Container | null): Focusable | null {
  return main?.querySelector('h1') ?? main?.querySelector('h2, h3') ?? null
}

/** Whether the heading should take focus: only while nothing else has it (the body, or no element at all). */
export const headingTakesFocus = (active: unknown, body: unknown): boolean => active === null || active === body

/**
 * Watches the page after a full load and focuses the main area's heading whenever focus is on the body and a heading is
 * there: once the page has drawn it, and again if loading later drops focus (a form remounted with its data). A page
 * that puts focus somewhere itself keeps it. Stops at the first key or pointer press, or after `timeout` milliseconds;
 * returns the function that stops it early.
 */
export function focusHeadingAfterLoad(doc: Document, { main = 'main', timeout = 10000 } = {}): () => void {
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
    if (!headingTakesFocus(doc.activeElement, doc.body)) return
    const heading = pageHeading(doc.querySelector(main))
    if (!heading) return
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1
    heading.focus()
  }
  doc.addEventListener('keydown', stop, true)
  doc.addEventListener('pointerdown', stop, true)
  observer.observe(doc.body, { childList: true, subtree: true })
  attempt()
  return stop
}
