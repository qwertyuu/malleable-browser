import { useCallback, useEffect, useState } from 'react'
import type { HostAdaptations, EditContent } from '../../../shared/ipc'

interface Props {
  visible: boolean
  busy: boolean
  onAskAgent: (host: string, text: string) => void
}

/** The adaptation library: every site's named edits, toggle/edit/delete by hand or agent. */
export default function LibraryView({ visible, busy, onAskAgent }: Props) {
  const [hosts, setHosts] = useState<HostAdaptations[]>([])
  const [editing, setEditing] = useState<EditContent | null>(null)
  const [dirty, setDirty] = useState(false)
  const [ask, setAsk] = useState('')

  const refresh = useCallback(async () => {
    setHosts(await window.api.listAdaptations())
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

  // ---- Editor view ----
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

  // ---- List view (grouped by host) ----
  return (
    <div className="library">
      <div className="library-head">
        <span>
          {hosts.length} adapted site{hosts.length === 1 ? '' : 's'}
        </span>
        <button className="link-btn" onClick={refresh}>
          Refresh
        </button>
      </div>
      {hosts.length === 0 && (
        <div className="hint">
          No adaptations yet. Reshape a page from the Adapt tab and its edits show up here.
        </div>
      )}
      {hosts.map((h) => (
        <div className="lib-host-group" key={h.host}>
          <button
            className="lib-host-name"
            title={`Open ${h.host}`}
            onClick={() => window.api.navigate(`https://${h.host}/`)}
          >
            {h.host} <span className="visit-arrow">↗</span>
          </button>
          {h.edits.map((e) => (
            <div className={`lib-row ${e.enabled ? '' : 'disabled'}`} key={e.id}>
              <label className="switch" title={e.enabled ? 'Enabled' : 'Disabled'}>
                <input
                  type="checkbox"
                  checked={e.enabled}
                  onChange={async (ev) => {
                    await window.api.setEditEnabled(h.host, e.id, ev.target.checked)
                    await refresh()
                  }}
                />
                <span className="slider" />
              </label>
              <div className="lib-main" onClick={() => open(h.host, e.id)}>
                <div className="lib-edit-name">
                  {e.name} <span className={`kind-badge kind-${e.kind}`}>{e.kind}</span>
                </div>
                <div className="lib-meta">
                  {e.hasCss && <span className="chip">css</span>}
                  {e.hasJs && <span className="chip">js</span>}
                  <span className="lib-bytes">{formatBytes(e.bytes)}</span>
                </div>
              </div>
              <button className="link-btn" onClick={() => open(h.host, e.id)}>
                Edit
              </button>
              <button
                className="link-btn danger"
                onClick={async () => {
                  await window.api.deleteEdit(h.host, e.id)
                  await refresh()
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}
