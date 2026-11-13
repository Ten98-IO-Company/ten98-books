export class ApiError extends Error { status = 0 }

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e
    throw new ApiError('Network error. Check your connection, then try again.')
  }
  const text = await res.text()
  let data: unknown = null
  if (text !== '') { try { data = JSON.parse(text) } catch { if (res.ok) throw new ApiError('The server response could not be confirmed. Check saved data before retrying.') } }
  if (!res.ok) {
    const d = data as { error?: unknown; message?: unknown } | null
    const fromBody = d !== null ? (typeof d.error === 'string' ? d.error : typeof d.message === 'string' ? d.message : '') : ''
    const err = new ApiError(fromBody !== '' ? fromBody : res.status === 401 ? 'Your session has expired. Sign in again.' : `Request failed with status ${res.status}.`)
    err.status = res.status
    throw err
  }
  return data as T
}

export function errMsg(e: unknown): string {
  return e instanceof Error && e.name !== 'AbortError' ? e.message : 'Something went wrong. Try again.'
}
