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

const IDLE: Activity = { state: 'idle' }

export default function App() {
  const [nav, setNav] = useState<NavState>(DEFAULT_NAV)
  const [panelOpen, setPanelOpen] = useState(true)
  const [status, setStatus] = useState<AcpStatus>({ state: 'starting' })
  const [config, setConfig] = useState<AgentConfig | null>(null)
  const [sessions, setSessions] = useState<SessionList>({ sessions: [], currentId: null })
  const [tab, setTab] = useState<Tab>('adapt')

  // Threads run concurrently, so all per-session state is keyed by session id and
  // the UI just renders whichever thread (`currentId`) is in view. Switching is a
  // pure local view change — no reload, no shared mutable "current" to clobber.
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [transcripts, setTranscripts] = useState<Record<string, AdaptUpdate[]>>({})
  const [busyMap, setBusyMap] = useState<Record<string, boolean>>({})
  const [activityMap, setActivityMap] = useState<Record<string, Activity>>({})
  // Concurrent turns can each raise a permission prompt; queue them, show one at a time.
  const [permissions, setPermissions] = useState<PermissionRequestDTO[]>([])

  const updates = currentId ? (transcripts[currentId] ?? []) : []
  const busy = currentId ? (busyMap[currentId] ?? false) : false
  const activity = currentId ? (activityMap[currentId] ?? IDLE) : IDLE
  const permission = permissions[0] ?? null
  const busySessions = Object.keys(busyMap).filter((id) => busyMap[id])

  /** Append one update to a specific session's transcript (coalescing streams/tools). */
  const appendTo = useCallback((sid: string, u: AdaptUpdate) => {
    setTranscripts((prev) => ({ ...prev, [sid]: mergeUpdate(prev[sid] ?? [], u) }))
  }, [])

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

  // Subscribe to main-process events. Session-scoped events (updates, activity)
  // are routed into their session's slice by id, so a background thread keeps
  // filling its own transcript while you look at another.
  useEffect(() => {
    const offNav = window.api.onNavState(setNav)
    const offStatus = window.api.onAcpStatus(setStatus)
    const offPerm = window.api.onPermissionRequest((r) => {
      setPermissions((prev) => [...prev, r])
      // Bring the blocked thread into view so the prompt has context.
      if (r.sessionId) setCurrentId(r.sessionId)
    })
    const offUpdate = window.api.onAdaptUpdate(({ sessionId, update }) => {
      setTranscripts((prev) => ({ ...prev, [sessionId]: mergeUpdate(prev[sessionId] ?? [], update) }))
    })
    const offActivity = window.api.onActivity(({ sessionId, activity }) => {
      setActivityMap((prev) => ({ ...prev, [sessionId]: activity }))
    })
    const offConfig = window.api.onAgentConfig(setConfig)
    const offSessions = window.api.onSessions((list) => {
      setSessions(list)
      // Keep the current view if that session still exists; otherwise (e.g. after
      // an agent restart) adopt whatever session the main process now considers current.
      setCurrentId((cur) => (cur && list.sessions.some((s) => s.id === cur) ? cur : list.currentId))
    })
    const offClear = window.api.onClearTranscript(() => {
      // Agent restarted — every session died; drop all thread state.
      setTranscripts({})
      setBusyMap({})
      setActivityMap({})
      setPermissions([])
    })
    void window.api.listSessions().then((list) => {
      setSessions(list)
      setCurrentId(list.currentId)
    })
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

  const sendAdapt = useCallback(
    async (text: string) => {
      const sid = currentId
      if (!sid) return
      appendTo(sid, { kind: 'user', text })
      setBusyMap((prev) => ({ ...prev, [sid]: true }))
      const res = await window.api.adapt(sid, text)
      setBusyMap((prev) => ({ ...prev, [sid]: false }))
      appendTo(
        sid,
        res.error
          ? { kind: 'error', text: res.error }
          : {
              kind: 'info',
              text: `Done (${res.stopReason ?? 'ok'})${res.checkpoint ? ` · checkpoint ${res.checkpoint}` : ''}`
            }
      )
    },
    [currentId, appendTo]
  )

  const newSession = useCallback(async () => {
    const res = await window.api.newSession()
    if (res.ok && res.id) setCurrentId(res.id)
    else if (currentId) appendTo(currentId, { kind: 'error', text: `New session failed: ${res.error ?? ''}` })
  }, [currentId, appendTo])

  const switchSession = useCallback(
    async (id: string) => {
      setCurrentId(id) // instant view change; the session is (or becomes) live in main
      const res = await window.api.switchSession(id)
      if (!res.ok) appendTo(id, { kind: 'error', text: `Could not load session: ${res.error ?? ''}` })
    },
    [appendTo]
  )

  // Ask the agent to edit a saved site's overlay (from the Library).
  const adaptHost = useCallback(
    async (host: string, text: string) => {
      const sid = currentId
      if (!sid) return
      setTab('adapt')
      appendTo(sid, { kind: 'user', text: `[${host}] ${text}` })
      setBusyMap((prev) => ({ ...prev, [sid]: true }))
      const res = await window.api.adaptHost(sid, host, text)
      setBusyMap((prev) => ({ ...prev, [sid]: false }))
      appendTo(
        sid,
        res.error
          ? { kind: 'error', text: res.error }
          : { kind: 'info', text: `Done (${res.stopReason ?? 'ok'})` }
      )
    },
    [currentId, appendTo]
  )

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

  const answerPermission = useCallback((optionId: string | null) => {
    setPermissions((prev) => {
      const [head, ...rest] = prev
      if (head) window.api.respondPermission(head.requestId, optionId)
      return rest
    })
  }, [])

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
            currentId={currentId}
            busySessions={busySessions}
            onSwitchSession={switchSession}
            onAdaptHost={adaptHost}
            onSend={sendAdapt}
            onCancel={() => currentId && window.api.cancelAdapt(currentId)}
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
              if (currentId)
                appendTo(currentId, {
                  kind: 'info',
                  text: `Reset adaptations for ${nav.origin || 'this site'}`
                })
            }}
            onRevert={async () => {
              const info = await window.api.revertLast()
              if (currentId)
                appendTo(currentId, {
                  kind: 'info',
                  text: info ? `Reverted to ${info.sha} — ${info.subject}` : 'Nothing to revert'
                })
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
