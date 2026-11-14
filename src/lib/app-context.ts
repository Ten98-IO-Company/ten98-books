import { createContext, useContext } from 'react'
import type { Company, CompanySummary } from './company'

export type { CompanySummary }
export type Me = { user: { id: string; name: string; email: string }; instanceOperator: boolean }

/** What the signed-in shell knows; child routes read it instead of refetching the account. */
export type AppState = {
  me: Me
  /** Every company the user belongs to (GET /api/companies); null while loading. */
  companies: CompanySummary[] | null
  /** The company in the address, else the last one used in this browser that the user still belongs to, else the first. */
  current: CompanySummary | undefined
  /** Reads the companies and roles again; call it when a write the shell offered is refused as not found. */
  reloadCompanies: () => Promise<void>
  /** A request found the session gone. */
  unauthorized: () => void
}
export const AppContext = createContext<AppState | null>(null)
export function useApp(): AppState {
  const state = useContext(AppContext)
  if (!state) throw new Error('useApp is only available inside the signed-in shell.')
  return state
}

export const CompanyContext = createContext<Company | null>(null)
export function useCompany(): Company {
  const company = useContext(CompanyContext)
  if (!company) throw new Error('useCompany is only available inside a company route.')
  return company
}

const lastCompanyKey = (userId: string) => `books.last-company.${userId}`
/** The company last opened in this browser by this user: a convenience only, checked against the list before use. */
export function readLastCompany(userId: string): string | null {
  try { return localStorage.getItem(lastCompanyKey(userId)) } catch { return null }
}
export function rememberLastCompany(userId: string, companyId: string): void {
  try { localStorage.setItem(lastCompanyKey(userId), companyId) } catch { /* storage unavailable: nothing to remember */ }
}
