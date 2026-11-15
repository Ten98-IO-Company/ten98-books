/**
 * The page title in the signed-in shell's breadcrumb. A company page names its section once the company has books;
 * a company the person is locked out of by its two-factor rule says so (it is set up; its books stay closed until a
 * factor is on); a company without books says it is to be set up; the pages outside companies name themselves.
 */
export function shellPageTitle({ section, path, company }: {
  /** The open section's label, when a company with books is open. */
  section?: string
  path: string
  /** The company in the address, as the person's company list holds it. */
  company?: { company: unknown; twoFactorLocked: boolean }
}): string {
  if (section) return section
  if (path.startsWith('/app/account')) return 'Your account'
  if (path.startsWith('/app/team')) return 'Team'
  if (path.startsWith('/app/companies/new')) return 'Create company'
  if (company?.twoFactorLocked) return 'Two-factor authentication required'
  if (company) return 'Set up the company'
  return 'Companies'
}
