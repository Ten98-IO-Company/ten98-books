import { Field, FormGrid, Input, Stack, Text } from '@ten98/ui'
import { LookupField } from '../masters/LookupField'
import { longDate } from '../../lib/reports'
import { entryDateLabel, type LedgerOption } from '../../lib/voucher-entry'

/**
 * The voucher's header fields: the date (reached with the date key, not a stop on the way through) and, in single
 * entry, the Account with its current balance under it. Each field carries `data-voucher-field` so the screen can move
 * focus to it by name.
 */
export function VoucherHeader({ date, dateText, dateError, onDateText, account, accountOptions, accountError, onAccount, onAccountTyped, onSkipAccount, accountBalance, accountNegative, locked }: {
  date: string
  /** The date field's text while it is open (focused), or null to show the date with its weekday. */
  dateText: string | null
  dateError?: string
  onDateText: (text: string | null) => void
  /** Null in double entry: there is no Account. */
  account: string | null
  accountOptions: readonly LedgerOption[]
  accountError?: string
  onAccount: (ledgerId: string) => void
  onAccountTyped: (text: string, advance: boolean) => 'picked' | 'error' | 'unchanged'
  /** Down on the empty Account (observed): to the first line without choosing one. */
  onSkipAccount: () => void
  accountBalance: string | null
  accountNegative: boolean
  locked: boolean
}) {
  return <FormGrid>
    <Stack data-voucher-field='date'>
      <Field label='Date' error={dateError} description={dateText === null ? 'Change it with the date key, from any field or line.' : 'Day first: 9, 10-8, 12 sep or 15-10-2026. Enter takes it, Escape clears it, a second Escape keeps the date.'}>
        <Input value={dateText ?? entryDateLabel(date)} readOnly={locked} dir='ltr' autoComplete='off' tabIndex={dateText === null ? -1 : 0}
          onFocus={event => { if (dateText === null && !locked) { onDateText(longDate(date)); window.setTimeout(() => event.target.select(), 0) } }}
          onChange={event => onDateText(event.target.value)} />
      </Field>
    </Stack>
    {account !== null && <Stack data-voucher-field='account' gap={1} onKeyDownCapture={event => {
      // Taken before the lookup opens its list on Down: only an empty Account skips (entry.skip-account).
      const input = event.target
      if (!(input instanceof HTMLInputElement) || event.key !== 'ArrowDown' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || input.value !== '') return
      event.preventDefault(); event.stopPropagation(); onSkipAccount()
    }}>
      <LookupField label='Account' options={accountOptions} value={account} disabled={locked} error={accountError} required
        description='Cash and bank ledgers. Down on an empty Account goes to the first line.' placeholder='Choose a cash or bank ledger…' emptyMessage='No cash or bank ledger matches.'
        onValueChange={onAccount} onTypedEnter={onAccountTyped} />
      {accountBalance !== null && <Text size='sm' tone={accountNegative ? 'danger' : 'muted'} aria-live='polite'>Current balance <Text as='span' dir='ltr'>{accountBalance}</Text></Text>}
    </Stack>}
  </FormGrid>
}
