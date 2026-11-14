import { Badge, Inline, Text } from '@ten98/ui'
import type { ReactNode } from 'react'
import { useCompany } from '../../lib/app-context'
import { formatAmount, formatBalance } from '../../lib/reports'

const zero = /^-?0(\.0+)?$/

/**
 * Report cells. Amounts arrive as exact decimal strings (D-07) and are only formatted here, never computed: grouping and
 * the company's decimal places (2 or 3), right-aligned through numeric columns. A left-to-right span keeps an amount and its Dr or Cr
 * reading in order inside a right-to-left document.
 */
export function Amount({ value, blankZero = false, strong = false }: { value: string | null | undefined; blankZero?: boolean; strong?: boolean }) {
  const { currencyMinorUnits } = useCompany()
  if (value === null || value === undefined || (blankZero && zero.test(value))) return <Text as='span' numeric />
  return <Text as='span' dir='ltr' numeric weight={strong ? 'semibold' : 'regular'}>{formatAmount(value, currencyMinorUnits)}</Text>
}

/** A signed balance as "1,250.00 Dr" or "300.00 Cr". */
export function Balance({ value, strong = false }: { value: string; strong?: boolean }) {
  const { currencyMinorUnits } = useCompany()
  return <Text as='span' dir='ltr' numeric weight={strong ? 'semibold' : 'regular'}>{formatBalance(value, currencyMinorUnits)}</Text>
}

/** A line's name, indented by its level in the group hierarchy (em spaces, so the indent follows the text direction). */
export function Particulars({ label, depth = 0, strong = false, muted = false, extra }: { label: string; depth?: number; strong?: boolean; muted?: boolean; extra?: ReactNode }) {
  return <Inline gap={2} align='center' wrap>
    <Text as='span' weight={strong ? 'semibold' : 'regular'} tone={muted ? 'muted' : 'default'}>{' '.repeat(depth)}{label}</Text>
    {extra}
  </Inline>
}

/** Status marks for vouchers that are listed but do not count. */
export function VoucherMarks({ status, postDated }: { status: string; postDated?: boolean }) {
  return <>
    {status === 'cancelled' && <Badge tone='danger'>Cancelled</Badge>}
    {status === 'optional' && <Badge tone='warning'>Optional</Badge>}
    {postDated && <Badge tone='info'>Post-dated</Badge>}
  </>
}

/** The totals a statement must balance on, side by side, with whether they agree (compared as exact strings). */
export function TotalsSummary({ items }: { items: readonly (readonly [label: string, value: string])[] }) {
  const agree = items.every(([, value]) => value === items[0]?.[1])
  return <Inline gap={3} wrap align='center'>
    {items.map(([label, value]) => <Text key={label} as='span' size='sm'>{label} <Amount value={value} strong /></Text>)}
    <Badge tone={agree ? 'success' : 'warning'}>{agree ? 'Totals agree' : 'Totals differ'}</Badge>
  </Inline>
}

/** An intentionally empty cell. The table reads null as "not available"; in a report an empty cell means nothing to show. */
export const Blank = () => <Text as='span' />
