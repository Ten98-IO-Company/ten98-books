/**
 * The header every answer of the application's own API carries, on every status. An answer without it was made by
 * something in front of the application (a proxy or gateway), so a screen must not read it as the application's
 * refusal of what it sent. Shared by the server's dispatcher (handleApi) and the browser client.
 */
export const appMarkerHeader = 'X-Ten98-App'
export const appMarkerValue = 'books'
