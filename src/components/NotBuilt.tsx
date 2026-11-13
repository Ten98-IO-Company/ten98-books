import { EmptyState } from '@ten98/ui'

/** An honest placeholder for a section whose feature is not built yet: it names the section and promises nothing else. */
export function NotBuilt({ icon, section, singular = false }: { icon: string; section: string; singular?: boolean }) {
  return <EmptyState icon={icon} title={`${section} ${singular ? 'is' : 'are'} not built yet`} description='This section is part of a later release. Nothing here records or changes your books.' />
}
