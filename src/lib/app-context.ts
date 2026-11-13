import { createContext, useContext } from 'react'
import type { Company } from './company'

export type Workspace = { id: string; name: string; role: 'owner' | 'admin' | 'editor' | 'viewer'; twoFactorLocked?: boolean }
export type Me = { user: { id: string; name: string; email: string }; instanceOperator: boolean; workspaces: Workspace[] }
export type CompanySummary = { id: string; name: string }

/** What the signed-in shell knows; child routes read it instead of refetching the account. */
export type AppState = {
  me: Me
  workspace: Workspace
  companies: CompanySummary[] | null
  reloadCompanies: () => Promise<void>
  /** The open company's workspace becomes the shell's workspace. */
  showWorkspace: (workspaceId: string) => void
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
