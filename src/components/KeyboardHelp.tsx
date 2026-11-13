import { DescriptionList, Dialog, Heading, Inline, KeyHint, mergeKeymaps, Stack, Text } from '@ten98/ui'
import { commandContexts, commandIds, commands, contextTitles } from '../lib/commands'
import { keymaps, keymapTitles, type KeymapName } from '../lib/keymaps'

/** Every command in the registry with its keys in the active keymap, grouped by context. */
export function KeyboardHelp({ open, onOpenChange, keymap }: { open: boolean; onOpenChange: (open: boolean) => void; keymap: KeymapName }) {
  const bound = mergeKeymaps(keymaps[keymap])
  return <Dialog open={open} onOpenChange={onOpenChange} size='wide' title='Keyboard shortcuts'
    description={`${keymapTitles[keymap]} keys are active. You can switch keymaps on your Account page.`}>
    <Stack gap={6}>
      {commandContexts.map(context => <Stack key={context} gap={2}>
        <Heading level={3} size='sm'>{contextTitles[context]}</Heading>
        {context === 'company-home' && <Text size='sm' tone='muted'>These keys work while the company menu has focus.</Text>}
        {(context === 'list' || context === 'entry') && <Text size='sm' tone='muted'>Reserved for screens that are not built yet.</Text>}
        <DescriptionList columns={2} items={commandIds.filter(id => commands[id].context === context).map(id => ({
          key: id, term: commands[id].title,
          description: <Inline gap={1}>{(bound[id] ?? []).map(chord => <KeyHint key={chord} chord={chord} />)}</Inline>,
        }))} />
      </Stack>)}
    </Stack>
  </Dialog>
}
