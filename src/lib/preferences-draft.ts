/** The account preferences as the page edits them (account-preferences.ts has the saved shape and the wire schema). */
export type PreferencesDraft = { name: string; timeZone: string; locale: string; theme: string }

/** Whether two drafts hold the same preferences. */
export const sameDraft = (a: PreferencesDraft, b: PreferencesDraft): boolean => a.name === b.name && a.timeZone === b.timeZone && a.locale === b.locale && a.theme === b.theme

/**
 * Whether the page has unsaved preferences: the leave guard asks before leaving and the browser warns before a reload
 * only while this is true. Nothing is unsaved while either side is still loading, and nothing right after a save, when
 * the draft is the saved values again.
 */
export const preferencesChanged = (draft: PreferencesDraft | null, saved: PreferencesDraft | null): boolean => !!draft && !!saved && !sameDraft(draft, saved)
