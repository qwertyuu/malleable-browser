import { useEffect, useState } from 'react'
import type { AgentConfig, AcpStatus } from '../../../shared/ipc'

interface Props {
  config: AgentConfig | null
  status: AcpStatus
  onSetOption: (configId: string, value: string) => void
}

/** A few known ACP agents as starting points; the full registry link is below.
 *  Commands are examples — install the agent separately and check its docs. */
const AGENT_PRESETS: { label: string; command: string }[] = [
  { label: 'Bundled — Claude (claude-agent-acp)', command: '' },
  { label: 'Codex CLI (OpenAI)', command: 'npx -y @agentclientprotocol/codex-acp' },
  { label: 'Gemini CLI', command: 'gemini --experimental-acp' },
  { label: 'Qwen Code', command: 'qwen --experimental-acp' },
  { label: 'Custom…', command: '__custom__' }
]

/** Dev settings: pick the agent, model, permission mode, and see the connection. */
export default function SettingsView({ config, status, onSetOption }: Props) {
  const [logPath, setLogPath] = useState('')
  const [agentCmd, setAgentCmd] = useState('')
  const [savedCmd, setSavedCmd] = useState('')
  useEffect(() => {
    void window.api.getLogPath().then(setLogPath)
    void window.api.getAppSettings().then((s) => {
      setAgentCmd(s.agentCommand)
      setSavedCmd(s.agentCommand)
    })
  }, [])

  const applyAgent = (): void => {
    void window.api.setAgentCommand(agentCmd.trim()).then((s) => setSavedCmd(s.agentCommand))
  }

  return (
    <div className="settings">
      <section className="settings-section">
        <h3>Agent</h3>
        <div className="kv">
          <span className="k">Adapter</span>
          <span className="v">
            {config?.agentName ?? 'claude-agent-acp'}
            {config?.agentVersion ? ` v${config.agentVersion}` : ''}
          </span>
        </div>
        <div className="kv">
          <span className="k">Connection</span>
          <span className={`v status-${status.state}`}>
            {status.state}
            {status.detail ? ` · ${status.detail}` : ''}
          </span>
        </div>
        <label className="field" style={{ marginTop: 10 }}>
          <span className="field-label">Agent command</span>
          <span className="field-desc">
            Which ACP agent to run. Leave blank for the bundled Claude adapter.
            Install the agent separately, then choose or type its ACP command.
            Applying restarts the agent.
          </span>
          <select
            className="field-select"
            value={AGENT_PRESETS.some((p) => p.command === agentCmd) ? agentCmd : '__custom__'}
            onChange={(e) => {
              if (e.target.value !== '__custom__') setAgentCmd(e.target.value)
            }}
          >
            {AGENT_PRESETS.map((p) => (
              <option key={p.label} value={p.command}>
                {p.label}
              </option>
            ))}
          </select>
          <div className="ask-agent" style={{ marginTop: 6 }}>
            <input
              className="ask-input"
              placeholder="(bundled claude-agent-acp)"
              value={agentCmd}
              spellCheck={false}
              onChange={(e) => setAgentCmd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyAgent()
              }}
            />
            <button className="send-btn" onClick={applyAgent} disabled={agentCmd.trim() === savedCmd.trim()}>
              Apply
            </button>
          </div>
          <button
            className="link-btn"
            style={{ marginTop: 4, textAlign: 'left' }}
            onClick={() => window.api.openExternal('https://agentclientprotocol.com/get-started/agents')}
          >
            Browse all ACP agents ↗
          </button>
        </label>
      </section>

      <section className="settings-section">
        <h3>Debug</h3>
        <div className="field">
          <span className="field-label">Session log</span>
          <span className="field-desc">Full ACP traffic for this run. Tail it to debug:</span>
          <code className="logpath" title={logPath}>{logPath || '…'}</code>
          <button
            className="link-btn"
            disabled={!logPath}
            onClick={() => navigator.clipboard?.writeText(`tail -f "${logPath}"`)}
          >
            Copy “tail -f” command
          </button>
        </div>
      </section>

      {config && config.options.length > 0 ? (
        <section className="settings-section">
          <h3>Session</h3>
          {config.options.map((opt) => (
            <label className="field" key={opt.id}>
              <span className="field-label">{opt.name}</span>
              {opt.description && <span className="field-desc">{opt.description}</span>}
              <select
                className="field-select"
                value={opt.currentValue}
                onChange={(e) => onSetOption(opt.id, e.target.value)}
              >
                {opt.options.map((o) => (
                  <option key={o.value} value={o.value} title={o.description}>
                    {o.name}
                  </option>
                ))}
              </select>
              {currentDesc(opt) && <span className="field-hint">{currentDesc(opt)}</span>}
            </label>
          ))}
        </section>
      ) : (
        <section className="settings-section">
          <p className="hint">Agent options appear here once the session is ready.</p>
        </section>
      )}
    </div>
  )
}

function currentDesc(opt: AgentConfig['options'][number]): string | undefined {
  return opt.options.find((o) => o.value === opt.currentValue)?.description
}
