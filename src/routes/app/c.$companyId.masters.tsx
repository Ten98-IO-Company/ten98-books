import { createFileRoute, redirect } from '@tanstack/react-router'

/** The Masters section opens on the chart of accounts. */
export const Route = createFileRoute('/app/c/$companyId/masters')({
  beforeLoad: ({ params }) => { throw redirect({ to: '/app/c/$companyId/masters/chart-of-accounts', params, replace: true }) },
})
