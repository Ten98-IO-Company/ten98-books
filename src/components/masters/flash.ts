/**
 * One message that survives a change of screen: an alter screen saves, goes back to its list, and the list announces
 * what was saved. Read once, then gone.
 */
let pending = ''
export const setFlash = (message: string) => { pending = message }
export function takeFlash(): string {
  const message = pending
  pending = ''
  return message
}

/** What was created last per company in this tab (`group` or `ledger`), so the choice list comes back on it. */
const lastChoice = new Map<string, string>()
export const rememberChoice = (companyId: string, choice: string) => { lastChoice.set(companyId, choice) }
export const rememberedChoice = (companyId: string): string => lastChoice.get(companyId) ?? 'group'

/** The group chosen last per company in this tab, so a new entry starts where the previous one ended. */
const lastGroup = new Map<string, string>()
export const rememberGroup = (companyId: string, groupId: string) => { lastGroup.set(companyId, groupId) }
export const rememberedGroup = (companyId: string): string | undefined => lastGroup.get(companyId)

/** The cost category chosen last per company in this tab, so a new cost centre starts in it. */
const lastCostCategory = new Map<string, string>()
export const rememberCostCategory = (companyId: string, categoryId: string) => { lastCostCategory.set(companyId, categoryId) }
export const rememberedCostCategory = (companyId: string): string | undefined => lastCostCategory.get(companyId)
