import { useCallback, useEffect, useState } from 'react'
import type { HostAdaptations, EditContent, ToolLibrary, ToolSummary } from '../../../shared/ipc'

interface Props {
  visible: boolean
  busy: boolean
  onAskAgent: (host: string, text: string) => void
}

const EMPTY_TOOLS: ToolLibrary = { global: [], sites: {} }

/** The library: per-site named edits + the agent's scaffolded tools (global & site). */
export default function LibraryView({ visible, busy, onAskAgent }: Props) {
  const [hosts, setHosts] = useState<HostAdaptations[]>([])
  const [tools, setTools] = useState<ToolLibrary>(EMPTY_TOOLS)
  const [editing, setEditing] = useState<EditContent | null>(null)
  const [dirty, setDirty] = useState(false)
  const [ask, setAsk] = useState('')

  const refresh = useCallback(async () => {
    const [h, t] = await Promise.all([window.api.listAdaptations(), window.api.listTools()])
    setHosts(h)
    setTools(t)
  }, [])

  useEffect(() => {
    if (visible) void refresh()
  }, [visible, refresh])

  const open = useCallback(async (host: string, id: string) => {
    const e = await window.api.getEdit(host, id)
    if (e) {
      setEditing(e)
      setDirty(false)
      setAsk('')
    }
  }, [])

  const save = useCallback(async () => {
    if (!editing) return
    await window.api.saveEdit(editing.host, {
      id: editing.id,
      name: editing.name,
      kind: editing.kind,
      css: editing.css,
      js: editing.js
    })
    setDirty(false)
    await refresh()
  }, [editing, refresh])

  // ---- Editor view (edits) ----
  if (editing) {
    const patch = (p: Partial<EditContent>): void => {
      setEditing({ ...editing, ...p })
      setDirty(true)
    }
    return (
      <div className="library editor">
        <div className="editor-bar">
          <button className="link-btn" onClick={() => setEditing(null)}>
            ‹ Library
          </button>
          <span className="editor-host">{editing.host}</span>
          <button className="send-btn" onClick={save} disabled={!dirty}>
            Save
          </button>
        </div>
        <div className="edit-meta-row">
          <input
            className="ask-input"
            value={editing.name}
            placeholder="Edit name"
            onChange={(e) => patch({ name: e.target.value })}
          />
          <select
            className="field-select"
            value={editing.kind}
            onChange={(e) => patch({ kind: e.target.value })}
          >
            {['theme', 'layout', 'functionality', 'cleanup', 'other'].map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <label className="editor-label">overlay.css</label>
        <textarea
          className="code-area"
          spellCheck={false}
          value={editing.css}
          onChange={(e) => patch({ css: e.target.value })}
        />
        <label className="editor-label">overlay.js</label>
        <textarea
          className="code-area"
          spellCheck={false}
          value={editing.js}
          onChange={(e) => patch({ js: e.target.value })}
        />
        <label className="editor-label">Ask the agent to change this edit</label>
        <div className="ask-agent">
          <input
            className="ask-input"
            placeholder={`e.g. tweak "${editing.name}"…`}
            value={ask}
            disabled={busy}
            onChange={(e) => setAsk(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ask.trim() && !busy) {
                onAskAgent(editing.host, `In edit "${editing.name}" (id ${editing.id}): ${ask.trim()}`)
                setAsk('')
              }
            }}
          />
          <button
            className="send-btn"
            disabled={!ask.trim() || busy}
            onClick={() => {
              onAskAgent(editing.host, `In edit "${editing.name}" (id ${editing.id}): ${ask.trim()}`)
              setAsk('')
            }}
          >
            Ask
          </button>
        </div>
      </div>
    )
  }

  // ---- List view ----
  const hostsWithEdits = new Map(hosts.map((h) => [h.host, h]))
  const allHosts = Array.from(
    new Set([...hosts.map((h) => h.host), ...Object.keys(tools.sites)])
  ).sort()
  const empty = allHosts.length === 0 && tools.global.length === 0

  return (
    <div className="library">
      <div className="library-head">
        <span>
          {allHosts.length} site{allHosts.length === 1 ? '' : 's'}
        </span>
        <button className="link-btn" onClick={refresh}>
          Refresh
        </button>
      </div>

      {empty && (
        <div className="hint">
          Nothing yet. Reshape a page or let the agent build a tool from the Adapt tab.
        </div>
      )}

      {tools.global.length > 0 && (
        <div className="lib-host-group">
          <div className="lib-host-name" style={{ cursor: 'default' }}>
            ⦿ Global tools
          </div>
          {tools.global.map((t) => (
            <ToolRow key={t.name} tool={t} onDeleted={refresh} />
          ))}
        </div>
      )}

      {allHosts.map((host) => {
        const h = hostsWithEdits.get(host)
        const siteTools = tools.sites[host] ?? []
        return (
          <div className="lib-host-group" key={host}>
            <button
              className="lib-host-name"
              title={`Open ${host}`}
              onClick={() => window.api.navigate(`https://${host}/`)}
            >
              {host} <span className="visit-arrow">↗</span>
            </button>
            {h?.edits.map((e) => (
              <div className={`lib-row ${e.enabled ? '' : 'disabled'}`} key={e.id}>
                <label className="switch" title={e.enabled ? 'Enabled' : 'Disabled'}>
                  <input
                    type="checkbox"
                    checked={e.enabled}
                    onChange={async (ev) => {
                      await window.api.setEditEnabled(host, e.id, ev.target.checked)
                      await refresh()
                    }}
                  />
                  <span className="slider" />
                </label>
                <div className="lib-main" onClick={() => open(host, e.id)}>
                  <div className="lib-edit-name">
                    {e.name} <span className={`kind-badge kind-${e.kind}`}>{e.kind}</span>
                  </div>
                  <div className="lib-meta">
                    {e.hasCss && <span className="chip">css</span>}
                    {e.hasJs && <span className="chip">js</span>}
                    <span className="lib-bytes">{formatBytes(e.bytes)}</span>
                  </div>
                </div>
                <button className="link-btn" onClick={() => open(host, e.id)}>
                  Edit
                </button>
                <button
                  className="link-btn danger"
                  onClick={async () => {
                    await window.api.deleteEdit(host, e.id)
                    await refresh()
                  }}
                >
                  Delete
                </button>
              </div>
            ))}
            {siteTools.map((t) => (
              <ToolRow key={t.name} tool={t} onDeleted={refresh} />
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** A scaffolded tool: expandable to show params + code, with delete. */
function ToolRow({ tool, onDeleted }: { tool: ToolSummary; onDeleted: () => void }) {
  const params = Object.entries(tool.params ?? {})
  return (
    <details className="lib-tool">
      <summary>
        <span className="tool-cog">⚙</span>
        <span className="lib-tool-name">{tool.name}</span>
        <span className="tool-badge">tool</span>
        {params.length > 0 && <span className="lib-tool-params">{params.length}p</span>}
        <button
          className="link-btn danger"
          onClick={async (e) => {
            e.preventDefault()
            await window.api.deleteTool(tool.name, tool.scope, tool.host)
            onDeleted()
          }}
        >
          Delete
        </button>
      </summary>
      <div className="lib-tool-body">
        {tool.description && <p className="lib-tool-desc">{tool.description}</p>}
        {params.length > 0 && (
          <ul className="lib-tool-plist">
            {params.map(([k, p]) => (
              <li key={k}>
                <code>{k}</code>: {p.type}
                {p.required ? ' (required)' : ''}
                {p.description ? ` — ${p.description}` : ''}
              </li>
            ))}
          </ul>
        )}
        <pre className="raw">{tool.code}</pre>
      </div>
    </details>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}
