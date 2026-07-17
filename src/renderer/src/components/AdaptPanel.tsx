import { useEffect, useState } from 'react'
import type {
  AdaptUpdate,
  AcpStatus,
  PermissionRequestDTO,
  Activity,
  AgentConfig,
  SessionList
} from '../../../shared/ipc'
import type { Tab } from '../App'
import Transcript from './Transcript'
import LibraryView from './LibraryView'
import SettingsView from './SettingsView'

interface Props {
  status: AcpStatus
  activity: Activity
  config: AgentConfig | null
  updates: AdaptUpdate[]
  busy: boolean
  permission: PermissionRequestDTO | null
  origin: string
  adapted: boolean
  tab: Tab
  onTab: (t: Tab) => void
  sessions: SessionList
  onSwitchSession: (id: string) => void
  onAdaptHost: (host: string, text: string) => void
  onSend: (text: string) => void
  onCancel: () => void
  onNewSession: () => void
  onAnswerPermission: (optionId: string | null) => void
  onResetSite: () => void
  onRevert: () => void
  onSetConfigOption: (configId: string, value: string) => void
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`
}

const ACTIVITY_LABEL: Record<Activity['state'], string> = {
  idle: '',
  thinking: 'Thinking…',
  responding: 'Writing…',
  tool: 'Running tool'
}

/** The dev-facing side panel: adapt the page, browse the library, tune the agent. */
export default function AdaptPanel(props: Props) {
  const { status, activity, config, updates, busy, permission, origin, adapted, tab, sessions } =
    props
  const [text, setText] = useState('')

  // Elapsed-time ticker so a long turn visibly progresses instead of looking hung.
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!busy) {
      setElapsed(0)
      return
    }
    const t0 = Date.now()
    const id = setInterval(() => setElapsed(Date.now() - t0), 250)
    return () => clearInterval(id)
  }, [busy])

  const submit = (): void => {
    const t = text.trim()
    if (!t || busy) return
    props.onSend(t)
    setText('')
  }

  const model = config?.options.find((o) => o.id === 'model')
  const currentModel = model?.options.find((o) => o.value === model.currentValue)?.name

  return (
    <aside className="adapt-panel" data-testid="adapt-panel">
      <div className="session-bar">
        <select
          className="session-select"
          data-testid="session-select"
          value={sessions.currentId ?? ''}
          onChange={(e) => props.onSwitchSession(e.target.value)}
          title="Switch coding session"
        >
          {sessions.sessions.length === 0 && <option value="">session…</option>}
          {sessions.sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button
          className="new-session-btn"
          onClick={props.onNewSession}
          title="New coding session (⇧⌘N) — clears context, keeps your model/mode"
          data-testid="new-session"
        >
          ＋ New
        </button>
        <span
          className={`status-dot status-${status.state}`}
          title={`${status.state}${status.detail ? ` · ${status.detail}` : ''}`}
        />
      </div>
      <div className="panel-header">
        <div className="tabs">
          {(['adapt', 'library', 'settings'] as Tab[]).map((t) => (
            <button
              key={t}
              className={`tab ${tab === t ? 'active' : ''}`}
              onClick={() => props.onTab(t)}
              data-testid={`tab-${t}`}
            >
              {t === 'adapt' ? 'Adapt' : t === 'library' ? 'Library' : 'Settings'}
            </button>
          ))}
        </div>
      </div>

      {/* Live activity + current model — always visible so you know what's happening. */}
      <div className="activity-bar">
        <span className={`activity ${activity.state !== 'idle' ? 'live' : ''}`}>
          {activity.state !== 'idle' && <span className="pulse" />}
          {activity.state === 'idle'
            ? status.state === 'ready'
              ? 'Idle'
              : status.state
            : `${ACTIVITY_LABEL[activity.state]}${activity.detail ? ` — ${activity.detail}` : ''}`}
        </span>
        {busy && <span className="metric" title="Elapsed">{(elapsed / 1000).toFixed(1)}s</span>}
        {activity.tokens != null && (
          <span className="metric" title="Tokens this turn">{formatTokens(activity.tokens)}</span>
        )}
        {currentModel && <span className="model-chip" title="Current model">{currentModel}</span>}
      </div>

      {status.state === 'auth_required' && <div className="auth-hint">{status.detail}</div>}

      {tab === 'adapt' && (
        <>
          <div className="site-bar">
            <span className="site-origin" title={origin}>
              {origin || 'no page'}
            </span>
            {adapted && (
              <span className="site-badge" title="This site has saved adaptations">
                adapted
              </span>
            )}
            <button
              className="reset-site-btn"
              onClick={props.onResetSite}
              disabled={!adapted}
              title="Remove this site's adaptations"
            >
              Reset site
            </button>
            <button className="reset-site-btn" onClick={props.onRevert} title="Undo last change (git)">
              ↺ Revert
            </button>
          </div>

          <Transcript updates={updates} />

          <div className="composer">
            <textarea
              className="composer-input"
              data-testid="adapt-input"
              value={text}
              placeholder="Describe how this page should look or behave…"
              disabled={status.state !== 'ready' && status.state !== 'stopped'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            <div className="composer-actions">
              {busy ? (
                <button className="send-btn cancel" onClick={props.onCancel}>
                  Stop
                </button>
              ) : (
                <button
                  className="send-btn"
                  data-testid="adapt-send"
                  onClick={submit}
                  disabled={!text.trim()}
                >
                  Adapt ⌘⏎
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {tab === 'library' && (
        <LibraryView visible={tab === 'library'} busy={busy} onAskAgent={props.onAdaptHost} />
      )}

      {tab === 'settings' && (
        <SettingsView config={config} status={status} onSetOption={props.onSetConfigOption} />
      )}

      {permission && (
        <div className="permission-overlay">
          <div className="permission-card" data-testid="permission-card">
            <div className="permission-title">{permission.title}</div>
            {permission.locations && permission.locations.length > 0 && (
              <div className="permission-locations">{permission.locations.join(', ')}</div>
            )}
            <div className="permission-options">
              {permission.options.map((o) => (
                <button
                  key={o.optionId}
                  className={`perm-opt ${o.kind.startsWith('allow') ? 'allow' : 'reject'}`}
                  onClick={() => props.onAnswerPermission(o.optionId)}
                >
                  {o.name}
                </button>
              ))}
              <button className="perm-opt" onClick={() => props.onAnswerPermission(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
