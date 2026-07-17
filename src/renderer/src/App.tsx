import { useCallback, useEffect, useRef, useState } from 'react'
import Chrome from './components/Chrome'
import AdaptPanel from './components/AdaptPanel'
import type {
  NavState,
  AdaptUpdate,
  AcpStatus,
  PermissionRequestDTO,
  Activity,
  AgentConfig,
  SessionList
} from '../../shared/ipc'

export type Tab = 'adapt' | 'library' | 'settings'

const DEFAULT_NAV: NavState = {
  url: '',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  title: '',
  origin: '',
  adapted: false
}

export default function App() {
  const [nav, setNav] = useState<NavState>(DEFAULT_NAV)
  const [panelOpen, setPanelOpen] = useState(true)
  const [updates, setUpdates] = useState<AdaptUpdate[]>([])
  const [status, setStatus] = useState<AcpStatus>({ state: 'starting' })
  const [permission, setPermission] = useState<PermissionRequestDTO | null>(null)
  const [busy, setBusy] = useState(false)
  const [activity, setActivity] = useState<Activity>({ state: 'idle' })
  const [config, setConfig] = useState<AgentConfig | null>(null)
  const [sessions, setSessions] = useState<SessionList>({ sessions: [], currentId: null })
  const [tab, setTab] = useState<Tab>('adapt')

  const slotRef = useRef<HTMLDivElement>(null)

  // Keep the native WebContentsView aligned with the on-screen content slot.
  const reportBounds = useCallback(() => {
    const el = slotRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    window.api.setContentBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
  }, [])

  useEffect(() => {
    const el = slotRef.current
    if (!el) return
    const ro = new ResizeObserver(() => reportBounds())
    ro.observe(el)
    window.addEventListener('resize', reportBounds)
    reportBounds()
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', reportBounds)
    }
  }, [reportBounds])

  // Re-align whenever the panel opens/closes (content slot changes width).
  useEffect(() => {
    const id = requestAnimationFrame(reportBounds)
    return () => cancelAnimationFrame(id)
  }, [panelOpen, reportBounds])

  // Subscribe to main-process events.
  useEffect(() => {
    const offNav = window.api.onNavState(setNav)
    const offStatus = window.api.onAcpStatus(setStatus)
    const offPerm = window.api.onPermissionRequest(setPermission)
    const offUpdate = window.api.onAdaptUpdate((u) => {
      setUpdates((prev) => mergeUpdate(prev, u))
    })
    const offActivity = window.api.onActivity(setActivity)
    const offConfig = window.api.onAgentConfig(setConfig)
    const offSessions = window.api.onSessions(setSessions)
    const offClear = window.api.onClearTranscript(() => setUpdates([]))
    void window.api.listSessions().then(setSessions)
    return () => {
      offNav()
      offStatus()
      offPerm()
      offUpdate()
      offActivity()
      offConfig()
      offSessions()
      offClear()
    }
  }, [])

  const sendAdapt = useCallback(async (text: string) => {
    setUpdates((prev) => [...prev, { kind: 'user', text }])
    setBusy(true)
    const res = await window.api.adapt(text)
    setBusy(false)
    if (res.error) {
      setUpdates((prev) => [...prev, { kind: 'error', text: res.error }])
    } else {
      setUpdates((prev) => [
        ...prev,
        {
          kind: 'info',
          text: `Done (${res.stopReason ?? 'ok'})${res.checkpoint ? ` · checkpoint ${res.checkpoint}` : ''}`
        }
      ])
    }
  }, [])

  const newSession = useCallback(async () => {
    const res = await window.api.newSession()
    setUpdates(res.ok ? [] : [{ kind: 'error', text: `New session failed: ${res.error ?? ''}` }])
    setBusy(false)
  }, [])

  const switchSession = useCallback(async (id: string) => {
    setUpdates([])
    setBusy(false)
    const res = await window.api.switchSession(id)
    if (!res.ok) setUpdates([{ kind: 'error', text: `Could not load session: ${res.error ?? ''}` }])
  }, [])

  // Ask the agent to edit a saved site's overlay (from the Library).
  const adaptHost = useCallback(async (host: string, text: string) => {
    setTab('adapt')
    setUpdates((prev) => [...prev, { kind: 'user', text: `[${host}] ${text}` }])
    setBusy(true)
    const res = await window.api.adaptHost(host, text)
    setBusy(false)
    setUpdates((prev) => [
      ...prev,
      res.error
        ? { kind: 'error', text: res.error }
        : { kind: 'info', text: `Done (${res.stopReason ?? 'ok'})` }
    ])
  }, [])

  // Cmd/Ctrl+Shift+N starts a fresh coding session.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void newSession()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newSession])

  const answerPermission = useCallback(
    (optionId: string | null) => {
      if (permission) window.api.respondPermission(permission.requestId, optionId)
      setPermission(null)
    },
    [permission]
  )

  return (
    <div className="app">
      <Chrome
        nav={nav}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((v) => !v)}
        onNavigate={(url) => window.api.navigate(url)}
        onBack={() => window.api.goBack()}
        onForward={() => window.api.goForward()}
        onReload={() => window.api.reload()}
      />
      <div className="body">
        <div className="content-slot" ref={slotRef} data-testid="content-slot" />
        {panelOpen && (
          <AdaptPanel
            status={status}
            activity={activity}
            config={config}
            updates={updates}
            busy={busy}
            permission={permission}
            origin={nav.origin}
            adapted={nav.adapted}
            tab={tab}
            onTab={setTab}
            sessions={sessions}
            onSwitchSession={switchSession}
            onAdaptHost={adaptHost}
            onSend={sendAdapt}
            onCancel={() => window.api.cancelAdapt()}
            onNewSession={newSession}
            onAnswerPermission={answerPermission}
            onSetConfigOption={(configId, value) => {
              // Optimistic: reflect the choice immediately; agent confirms via config update.
              setConfig((prev) =>
                prev
                  ? {
                      ...prev,
                      options: prev.options.map((o) =>
                        o.id === configId ? { ...o, currentValue: value } : o
                      )
                    }
                  : prev
              )
              window.api.setConfigOption(configId, value)
            }}
            onResetSite={async () => {
              await window.api.resetSite()
              setUpdates((prev) => [
                ...prev,
                { kind: 'info', text: `Reset adaptations for ${nav.origin || 'this site'}` }
              ])
            }}
            onRevert={async () => {
              const info = await window.api.revertLast()
              setUpdates((prev) => [
                ...prev,
                {
                  kind: 'info',
                  text: info ? `Reverted to ${info.sha} — ${info.subject}` : 'Nothing to revert'
                }
              ])
            }}
          />
        )}
      </div>
    </div>
  )
}

// Streaming text chunks of the same kind are coalesced into one bubble, and all
// updates for a given tool call collapse into a single, progressively-filled row.
function mergeUpdate(prev: AdaptUpdate[], u: AdaptUpdate): AdaptUpdate[] {
  // Coalesce streaming agent/thought text.
  const streamy = u.kind === 'agent' || u.kind === 'thought'
  const last = prev[prev.length - 1]
  if (streamy && last && last.kind === u.kind && u.text) {
    const copy = prev.slice(0, -1)
    copy.push({ ...last, text: (last.text ?? '') + u.text })
    return copy
  }

  // Merge every tool_call / tool_call_update for the same tool into one row.
  if ((u.kind === 'tool' || u.kind === 'tool_update') && u.toolId) {
    const idx = prev.findIndex((p) => p.toolId === u.toolId)
    if (idx >= 0) {
      const copy = prev.slice()
      const cur = copy[idx]
      copy[idx] = {
        ...cur,
        kind: 'tool',
        toolTitle: u.toolTitle ?? cur.toolTitle,
        toolKind: u.toolKind ?? cur.toolKind,
        status: u.status ?? cur.status,
        locations: u.locations ?? cur.locations,
        rawInput: u.rawInput ?? cur.rawInput,
        rawOutput: u.rawOutput ?? cur.rawOutput,
        content: u.content ?? cur.content
      }
      return copy
    }
    return [...prev, { ...u, kind: 'tool' }]
  }

  return [...prev, u]
}
