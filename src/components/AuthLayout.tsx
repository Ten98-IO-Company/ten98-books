import { AuthStory } from '@ten98/ui'

/** The side panel supplied once to every authentication screen through the root AuthFrameProvider. */
export const authStory = <AuthStory label='Books' eyebrow='Accounting for GCC businesses' title='Double-entry books for every' emphasis='company.'
  lead='Keep each company’s books, financial year and base currency separate.' footnote='Company access is by invitation.'
  channels={[{ icon: 'book', label: 'Books' }, { icon: 'building', label: 'Companies' }, { icon: 'users', label: 'Team' }]} />
