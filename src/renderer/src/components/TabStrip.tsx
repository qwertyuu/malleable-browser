import type { Bubble, TabInfo } from '../../../shared/ipc'
import { groupTabsByBubble } from '../bubble-groups'
import BubbleChip from './BubbleChip'
import TabItem from './TabItem'

interface Props {
  tabs: TabInfo[]
  bubbles: Bubble[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Right-click: main shows the native tab menu (start/join a bubble). */
  onContextMenu: (id: string) => void
  onNew: () => void
  /** Click on a bubble chip: main shows that bubble's menu. */
  onBubbleMenu: (bubbleId: string) => void
  /** Start a bubble from the active tab's site. */
  onNewBubble: () => void
}

/**
 * The tab strip, grouped by bubble: each bubble is a colored chip followed by
 * the tabs showing its sites, then the tabs in no bubble. Hidden worker tabs
 * are deliberately absent: main only sends visible ones, since a strip entry
 * you can't focus would just be confusing.
 */
export default function TabStrip(props: Props) {
  const { groups, loose, memberships } = groupTabsByBubble(props.tabs, props.bubbles)
  const activeTab = props.tabs.find((t) => t.id === props.activeId)

  const renderTab = (t: TabInfo) => (
    <TabItem
      key={t.id}
      tab={t}
      active={t.id === props.activeId}
      bubbleColors={memberships[t.id] ?? []}
      onSelect={props.onSelect}
      onClose={props.onClose}
      onContextMenu={props.onContextMenu}
    />
  )

  return (
    <div className="tab-strip" data-testid="tab-strip">
      {groups.map((g) => (
        <div
          key={g.bubble.id}
          className={`bubble-group ${g.sharing ? 'sharing' : ''}`}
          style={{ ['--bubble-color' as string]: g.color }}
          data-testid="bubble-group"
        >
          <BubbleChip group={g} onOpenMenu={props.onBubbleMenu} />
          {g.tabs.map(renderTab)}
        </div>
      ))}
      {loose.map(renderTab)}
      <button className="tab-new" onClick={props.onNew} title="New tab" data-testid="new-tab">
        +
      </button>
      <button
        className="tab-new tab-new-bubble"
        onClick={props.onNewBubble}
        disabled={!activeTab?.origin}
        title={
          activeTab?.origin
            ? `New bubble with the current tab (${activeTab.origin})`
            : 'Open a site to start a bubble with it'
        }
        data-testid="new-bubble"
      >
        ◎+
      </button>
    </div>
  )
}
