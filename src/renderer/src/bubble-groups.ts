import type { Bubble, TabInfo } from '../../shared/ipc'

/** One bubble as the tab strip draws it: a chip, then its open tabs. */
export interface BubbleGroup {
  bubble: Bubble
  color: string
  tabs: TabInfo[]
  /**
   * At least two sites, so data can actually flow. A one-site bubble shares
   * nothing yet and is not drawn as a group.
   */
  sharing: boolean
}

export interface GroupedTabs {
  groups: BubbleGroup[]
  /** Tabs whose site is in no bubble. */
  loose: TabInfo[]
  /** Colors of every sharing bubble a tab's site belongs to, keyed by tab id. */
  memberships: Record<string, string[]>
}

/** Distinct hues that read on the dark chrome. */
const BUBBLE_PALETTE = ['#7c6cff', '#4ec9a5', '#e0b050', '#e06c75', '#56b6f0', '#c678dd', '#98c379']

/** Stable per bubble id, so a bubble keeps its color across renders and restarts. */
export function colorForBubble(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return BUBBLE_PALETTE[Math.abs(hash) % BUBBLE_PALETTE.length]
}

/**
 * Lay tabs out by bubble. A site may be in several bubbles, but a tab can only
 * sit in one group: it goes under the OLDEST sharing bubble holding its site
 * (the list arrives sorted by createdAt), falling back to a one-site bubble,
 * and `memberships` carries the other sharing bubbles as dots.
 * Every bubble gets a group, even with no tab open, so bubbles stay visible.
 */
export function groupTabsByBubble(tabs: TabInfo[], bubbles: Bubble[]): GroupedTabs {
  const groups = bubbles.map((b) => ({
    bubble: b,
    color: colorForBubble(b.id),
    tabs: [] as TabInfo[],
    sharing: b.hosts.length >= 2
  }))
  const loose: TabInfo[] = []
  const memberships: Record<string, string[]> = {}
  for (const t of tabs) {
    const owning = groups.filter((g) => t.origin && g.bubble.hosts.includes(t.origin))
    const sharing = owning.filter((g) => g.sharing)
    memberships[t.id] = sharing.map((g) => g.color)
    const home = sharing[0] ?? owning[0]
    if (home) home.tabs.push(t)
    else loose.push(t)
  }
  return { groups, loose, memberships }
}
