import type { TabInfo } from '../../../shared/ipc'

interface Props {
  tabs: TabInfo[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

/** Favicon-less label: the page title, falling back to the host, then the URL. */
function label(t: TabInfo): string {
  return t.title.trim() || t.origin || t.url || 'New tab'
}

/**
 * The tab strip. Hidden worker tabs are deliberately absent — main only sends
 * visible ones, since a strip entry you can't focus would just be confusing.
 */
export default function TabStrip(props: Props) {
  const { tabs, activeId } = props
  return (
    <div className="tab-strip" data-testid="tab-strip">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === activeId ? 'active' : ''}`}
          onClick={() => props.onSelect(t.id)}
          onAuxClick={(e) => {
            // Middle-click closes, as everywhere else.
            if (e.button === 1) {
              e.preventDefault()
              props.onClose(t.id)
            }
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
      ))}
      <button className="tab-new" onClick={props.onNew} title="New tab" data-testid="new-tab">
        +
      </button>
    </div>
  )
}
