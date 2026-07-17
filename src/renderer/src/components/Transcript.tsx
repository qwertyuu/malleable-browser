import { useEffect, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AdaptUpdate } from '../../../shared/ipc'

const TOOL_ICON: Record<string, string> = {
  read: '📖',
  edit: '✏️',
  delete: '🗑️',
  move: '↪',
  search: '🔎',
  execute: '⚙️',
  think: '💭',
  fetch: '🌐',
  switch_mode: '🔀',
  other: '•'
}

const STATUS_ICON: Record<string, string> = {
  pending: '◦',
  in_progress: '◐',
  completed: '✓',
  failed: '✗'
}

function pretty(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** Split an MCP tool title (mcp__server__name) into a server + friendly name. */
function toolLabel(title?: string, id?: string): { name: string; server?: string } {
  const raw = title ?? id ?? 'tool'
  const m = /^mcp__(.+?)__(.+)$/.exec(raw)
  if (m) return { server: m[1], name: m[2] }
  return { name: raw }
}

/** A one-line preview of tool arguments for the summary row. */
function argPreview(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const parts = Object.entries(raw as Record<string, unknown>).map(([k, v]) => {
    let s =
      typeof v === 'string'
        ? JSON.stringify(v)
        : Array.isArray(v)
          ? `[${v.length}]`
          : typeof v === 'object'
            ? '{…}'
            : String(v)
    if (s.length > 40) s = s.slice(0, 40) + '…'
    return `${k}=${s}`
  })
  const joined = parts.join(', ')
  return joined.length > 90 ? joined.slice(0, 90) + '…' : joined
}

/** The "under the hood" transcript: messages, thinking, and expandable tool calls. */
export default function Transcript({ updates }: { updates: AdaptUpdate[] }) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [updates])

  return (
    <div className="transcript" data-testid="adapt-log">
      {updates.length === 0 && (
        <div className="hint">
          Ask Claude to change <strong>this web page</strong> — e.g.{' '}
          <em>“give this site a clean dark reading mode”</em>,{' '}
          <em>“hide the sidebar and ads”</em>, or{' '}
          <em>“add a floating table of contents”</em>. Changes are saved per site and
          re-applied every visit.
        </div>
      )}
      {updates.map((u, i) => (
        <Row key={u.toolId ?? i} u={u} />
      ))}
      <div ref={endRef} />
    </div>
  )
}

function Row({ u }: { u: AdaptUpdate }) {
  switch (u.kind) {
    case 'user':
      return <div className="row user">{u.text}</div>
    case 'agent':
      return (
        <div className="row agent md">
          <Markdown remarkPlugins={[remarkGfm]}>{u.text ?? ''}</Markdown>
        </div>
      )
    case 'thought':
      return (
        <details className="row thought">
          <summary>
            <span className="thought-tag">💭 thinking</span>
            <span className="thought-preview">{firstLine(u.text)}</span>
          </summary>
          <div className="thought-body">{u.text}</div>
        </details>
      )
    case 'tool':
    case 'tool_update':
      return <ToolRow u={u} />
    case 'plan':
      return (
        <details className="row plan">
          <summary>🗒 {u.text ?? 'Plan'}</summary>
          <pre className="raw">{pretty(u.rawOutput)}</pre>
        </details>
      )
    case 'error':
      return <div className="row error">{u.text}</div>
    default:
      return <div className="row info">{u.text}</div>
  }
}

function ToolRow({ u }: { u: AdaptUpdate }) {
  const icon = TOOL_ICON[u.toolKind ?? 'other'] ?? '•'
  const statusIcon = STATUS_ICON[u.status ?? ''] ?? '◦'
  const { name, server } = toolLabel(u.toolTitle, u.toolId)
  const args = argPreview(u.rawInput)
  const hasDetail =
    u.rawInput != null || u.rawOutput != null || (u.content && u.content.length > 0)

  return (
    <details className={`row tool ${u.status ?? ''}`} open={u.status === 'failed'}>
      <summary>
        <span className="tool-icon">{icon}</span>
        <span className="tool-name">{name}</span>
        {server && <span className="tool-badge">{server}</span>}
        {args && <span className="tool-args">{args}</span>}
        <span className={`tool-status-icon status-${u.status ?? 'pending'}`}>{statusIcon}</span>
      </summary>
      {u.locations && u.locations.length > 0 && (
        <div className="tool-locs">{u.locations.join(', ')}</div>
      )}
      {hasDetail && (
        <div className="tool-detail">
          {u.rawInput != null && (
            <>
              <div className="detail-label">input</div>
              <pre className="raw">{pretty(u.rawInput)}</pre>
            </>
          )}
          {u.content && (
            <>
              <div className="detail-label">output</div>
              <pre className="raw">{u.content}</pre>
            </>
          )}
          {u.rawOutput != null && !u.content && (
            <>
              <div className="detail-label">output</div>
              <pre className="raw">{pretty(u.rawOutput)}</pre>
            </>
          )}
        </div>
      )}
    </details>
  )
}

function firstLine(text?: string): string {
  if (!text) return ''
  const line = text.split('\n')[0]
  return line.length > 80 ? line.slice(0, 80) + '…' : line
}
