import { useEffect, useState } from 'react'
import type { NavState } from '../../../shared/ipc'

interface Props {
  nav: NavState
  panelOpen: boolean
  safeMode: boolean
  onTogglePanel: () => void
  onToggleSafeMode: () => void
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
}

/**
 * The browser chrome (toolbar + address bar). This is the primary surface Claude
 * reshapes on the fly — editing this file live re-renders it via HMR.
 */
export default function Chrome(props: Props) {
  const { nav, panelOpen } = props
  const [draft, setDraft] = useState('')

  // Reflect real navigation into the address bar unless the user is editing it.
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(nav.url)
  }, [nav.url, editing])

  return (
    <header className="toolbar" data-testid="toolbar">
      <div className="nav-buttons">
        <button
          className="icon-btn"
          onClick={props.onBack}
          disabled={!nav.canGoBack}
          title="Back"
        >
          ‹
        </button>
        <button
          className="icon-btn"
          onClick={props.onForward}
          disabled={!nav.canGoForward}
          title="Forward"
        >
          ›
        </button>
        <button className="icon-btn" onClick={props.onReload} title="Reload">
          {nav.isLoading ? '×' : '⟳'}
        </button>
      </div>

      <form
        className="address-form"
        onSubmit={(e) => {
          e.preventDefault()
          setEditing(false)
          props.onNavigate(draft)
        }}
      >
        <input
          className="address-input"
          data-testid="address-input"
          value={draft}
          placeholder="Search or enter address"
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />
      </form>

      <button
        className={`safe-btn ${props.safeMode ? 'active' : ''}`}
        data-testid="toggle-safe-mode"
        onClick={props.onToggleSafeMode}
        title={
          props.safeMode
            ? 'Safe mode is on: no CDP debugger, stock Chrome user agent, no adaptations injected. Click to turn off.'
            : 'Safe mode: browse this page like stock Chrome (no CDP debugger, real Chrome user agent, no adaptations). Use it for sites — banks, mostly — that block automated browsers.'
        }
      >
        🛡 {props.safeMode ? 'Safe' : 'Safe mode'}
      </button>

      <button
        className={`adapt-btn ${panelOpen ? 'active' : ''}`}
        data-testid="toggle-adapt"
        onClick={props.onTogglePanel}
        title="Toggle the Adapt panel"
      >
        ✦ Adapt
      </button>
    </header>
  )
}
