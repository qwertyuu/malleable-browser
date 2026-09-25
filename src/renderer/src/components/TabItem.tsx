import type { TabInfo } from '../../../shared/ipc'

interface Props {
  tab: TabInfo
  active: boolean
  /** Colors of every bubble this tab's site is in; extra ones show as dots. */
  bubbleColors: string[]
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onContextMenu: (id: string) => void
}

/** Favicon-less label: the page title, falling back to the host, then the URL. */
function label(t: TabInfo): string {
  return t.title.trim() || t.origin || t.url || 'New tab'
}

/** One entry in the tab strip. */
export default function TabItem({ tab: t, active, bubbleColors, ...props }: Props) {
  // The first color is the group the tab is drawn in; only the others need a dot.
  const extraBubbles = bubbleColors.slice(1)
  return (
    <div
      className={`tab ${active ? 'active' : ''}`}
      onClick={() => props.onSelect(t.id)}
      onAuxClick={(e) => {
        // Middle-click closes, as everywhere else.
        if (e.button === 1) {
          e.preventDefault()
          props.onClose(t.id)
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        props.onContextMenu(t.id)
      }}
      title={t.url}
      data-testid="tab"
    >
      {t.isLoading && <span className="tab-spinner" aria-hidden />}
      {t.adapted && !t.isLoading && (
        <span className="tab-badge" title="This site has adaptations">
          ✦
        </span>
      )}
      {t.safeMode && (
        <span className="tab-badge" title="Safe mode is on for this tab">
          🛡
        </span>
      )}
      <span className="tab-label">{label(t)}</span>
      {extraBubbles.map((c, i) => (
        <span key={i} className="tab-bubble-dot" style={{ background: c }} title="Also in another bubble" />
      ))}
      <button
        className="tab-close"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation()
          props.onClose(t.id)
        }}
      >
        ×
      </button>
    </div>
  )
}
