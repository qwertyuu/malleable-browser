import type { BubbleGroup } from '../bubble-groups'

interface Props {
  group: BubbleGroup
  onOpenMenu: (bubbleId: string) => void
}

/**
 * The colored label heading a bubble's tabs, like a browser tab-group chip.
 * Drawn even with no tab open or with a single site (dashed), so every bubble
 * stays visible.
 */
export default function BubbleChip({ group, onOpenMenu }: Props) {
  const { bubble, color, tabs, sharing } = group
  const empty = tabs.length === 0
  // Filled only once the bubble really groups something: 2+ sites, one open.
  const dormant = empty || !sharing
  return (
    <button
      className={`bubble-chip ${dormant ? 'dormant' : ''}`}
      style={{ ['--bubble-color' as string]: color }}
      title={`${bubble.name}\n${bubble.hosts.join('\n') || 'No sites yet'}`}
      onClick={() => onOpenMenu(bubble.id)}
      data-testid="bubble-chip"
    >
      <span className="bubble-chip-name">{bubble.name}</span>
      <span className="bubble-chip-count">
        {empty ? `${bubble.hosts.length} site${bubble.hosts.length === 1 ? '' : 's'}` : tabs.length}
      </span>
    </button>
  )
}
