import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { Readable, Writable } from 'node:stream'
import { dirname, join, resolve as resolvePath, relative, isAbsolute } from 'node:path'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type Stream
} from '@agentclientprotocol/sdk'
import type * as schema from '@agentclientprotocol/sdk'
import type {
  AdaptUpdate,
  AcpStatus,
  PermissionRequestDTO,
  AgentConfig,
  ConfigOptionDTO,
  Activity
} from '../shared/ipc.js'

const require = createRequire(import.meta.url)

/** Split a command line into argv, honoring simple single/double quotes. */
function tokenizeCommand(cmd: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** GUI apps launch with a bare PATH; add common locations so `gemini`/`npx` resolve. */
function augmentedPath(): string {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')]
  return [process.env.PATH ?? '', ...extra].filter(Boolean).join(':')
}

/** Resolve the claude-agent-acp stdio entry point from node_modules. */
function resolveAdapterBin(): string {
  // Resolve via package.json to avoid subpath "exports" restrictions, then join the bin.
  const pkgJson = require.resolve('@agentclientprotocol/claude-agent-acp/package.json')
  return join(dirname(pkgJson), 'dist', 'index.js')
}

function envArrayToObject(env?: schema.EnvVariable[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const { name, value } of env ?? []) out[name] = value
  return out
}

function textOf(content: unknown): string | undefined {
  if (content && typeof content === 'object' && (content as any).type === 'text') {
    return String((content as any).text ?? '')
  }
  return undefined
}

/** Flatten ACP ToolCallContent[] (text / diffs / terminal) into display text. */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined
  const parts: string[] = []
  for (const c of content as any[]) {
    if (c?.type === 'content') {
      const t = textOf(c.content)
      if (t) parts.push(t)
    } else if (c?.type === 'diff') {
      const path = c.path ?? ''
      parts.push(`--- ${path}\n${c.newText ?? ''}`)
    } else if (c?.type === 'terminal') {
      parts.push(`[terminal ${c.terminalId ?? ''}]`)
    }
  }
  const joined = parts.join('\n').trim()
  return joined.length ? joined : undefined
}

function locationsOf(update: any): string[] | undefined {
  const locs = update?.locations
  if (Array.isArray(locs)) {
    return locs.map((l: any) => l?.path).filter((p: unknown): p is string => typeof p === 'string')
  }
  return undefined
}

/** A locally-run terminal backing the ACP `terminal/*` methods. */
class Terminal {
  private child: ChildProcessWithoutNullStreams
  private chunks: Buffer[] = []
  private byteLen = 0
  private truncated = false
  private exitCode: number | null = null
  private signal: string | null = null
  private exited = false
  private waiters: Array<() => void> = []

  constructor(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly byteLimit: number
  ) {
    this.child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false
    }) as ChildProcessWithoutNullStreams
    this.child.stdout.on('data', (b: Buffer) => this.append(b))
    this.child.stderr.on('data', (b: Buffer) => this.append(b))
    this.child.on('exit', (code, sig) => {
      this.exitCode = code
      this.signal = sig
      this.exited = true
      this.waiters.splice(0).forEach((w) => w())
    })
    this.child.on('error', (err) => {
      this.append(Buffer.from(`\n[terminal error] ${String(err)}\n`))
      this.exited = true
      this.waiters.splice(0).forEach((w) => w())
    })
  }

  private append(b: Buffer): void {
    this.chunks.push(b)
    this.byteLen += b.length
    while (this.byteLen > this.byteLimit && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.byteLen -= dropped.length
      this.truncated = true
    }
  }

  output(): { output: string; truncated: boolean; exitStatus: schema.TerminalExitStatus | null } {
    return {
      output: Buffer.concat(this.chunks).toString('utf8'),
      truncated: this.truncated,
      exitStatus: this.exited ? { exitCode: this.exitCode, signal: this.signal } : null
    }
  }

  async waitForExit(): Promise<schema.TerminalExitStatus> {
    if (!this.exited) await new Promise<void>((r) => this.waiters.push(r))
    return { exitCode: this.exitCode, signal: this.signal }
  }

  kill(): void {
    if (!this.exited) this.child.kill('SIGTERM')
  }
}

export interface AcpCallbacks {
  onUpdate: (u: AdaptUpdate) => void
  onStatus: (s: AcpStatus) => void
  /** Present a permission request to the user; resolve with the chosen optionId, or null to cancel. */
  onPermission: (req: PermissionRequestDTO) => Promise<string | null>
  /** Agent config (models, permission mode) discovered / updated. */
  onConfig: (c: AgentConfig) => void
  /** Live "what is the agent doing" signal. */
  onActivity: (a: Activity) => void
  /** A session became active (created or loaded), so main can track it. */
  onSession: (info: { id: string; reason: 'initial' | 'reset' | 'load' }) => void
  /** Structured session logging (to file + CLI). */
  log: (level: 'debug' | 'info' | 'warn' | 'error', event: string, data?: unknown) => void
}

/** Session updates that are logged but NOT shown as transcript rows (too noisy). */
const QUIET_UPDATES = new Set([
  'usage_update',
  'session_info_update',
  'available_commands_update',
  'plan_update',
  'plan_removed'
])

function sumTokens(usage: any): number | undefined {
  if (!usage) return undefined
  const t = usage.totalTokens ?? usage.total_tokens
  if (typeof t === 'number') return t
  const sum =
    (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cachedReadTokens ?? 0)
  return sum || undefined
}

/** Extract the select-type config options (model, mode, …) for the UI. */
function toConfigOptions(raw: unknown): ConfigOptionDTO[] {
  if (!Array.isArray(raw)) return []
  const out: ConfigOptionDTO[] = []
  for (const o of raw as any[]) {
    if (o?.type !== 'select' || !Array.isArray(o.options)) continue
    out.push({
      id: o.id,
      name: o.name,
      description: o.description ?? undefined,
      category: o.category ?? undefined,
      currentValue: o.currentValue,
      options: o.options.map((v: any) => ({
        value: v.value,
        name: v.name,
        description: v.description ?? undefined
      }))
    })
  }
  return out
}

/**
 * Embeds the claude-code-acp agent as a stdio subprocess and speaks ACP to it.
 * This IS the "malleable browser" client: prompts flow to Claude, and Claude's
 * file edits land in `projectRoot` (the app's own repo) via the fs handlers.
 */
export class AcpClient {
  private conn: ClientSideConnection | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  private sessionId: string | null = null
  private terminals = new Map<string, Terminal>()
  private agentInfo: { name?: string; version?: string } = {}
  private activityState: Activity['state'] = 'idle'
  private turnTokens = 0
  /** User's config choices (model/mode/…), re-applied to new sessions. */
  private savedConfig: Record<string, string> = {}
  /** MCP servers (page-inspection tools) handed to every session. */
  private mcpServers: unknown[] = []
  /** Custom agent command line; empty = the bundled Claude adapter. */
  private agentCommand = ''

  setMcpServers(servers: unknown[]): void {
    this.mcpServers = servers
  }

  setAgentCommand(cmd: string): void {
    this.agentCommand = cmd.trim()
  }

  constructor(
    private readonly projectRoot: string,
    private readonly cb: AcpCallbacks
  ) {}

  /**
   * Defense-in-depth path guard for fs calls that ARE routed through the client.
   * Note: claude-agent-acp's own Write/Edit tools write directly to disk and do
   * NOT pass through this handler — the real gate for those is the permission
   * dialog (requestPermission) plus the git checkpoint/revert safety net.
   */
  private assertInProject(path: string): string {
    const abs = isAbsolute(path) ? path : resolvePath(this.projectRoot, path)
    const rel = relative(this.projectRoot, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Refused: path escapes project root: ${path}`)
    }
    return abs
  }

  async start(): Promise<void> {
    this.cb.onStatus({ state: 'starting' })

    // Resolve how to spawn the agent: a custom command, or the bundled adapter.
    let command: string
    let args: string[]
    let env: NodeJS.ProcessEnv
    if (this.agentCommand) {
      const argv = tokenizeCommand(this.agentCommand)
      if (argv.length === 0) {
        this.cb.onStatus({ state: 'error', detail: 'Empty agent command' })
        return
      }
      command = argv[0]
      args = argv.slice(1)
      env = { ...process.env, PATH: augmentedPath() }
      this.cb.log('info', 'adapter.spawn.custom', { command, args })
    } else {
      try {
        command = process.execPath
        args = [resolveAdapterBin()]
        env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        this.cb.log('info', 'adapter.spawn', { bin: args[0] })
      } catch (err) {
        this.cb.onStatus({ state: 'error', detail: `Adapter not found: ${String(err)}` })
        return
      }
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, args, {
        cwd: this.projectRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      }) as ChildProcessWithoutNullStreams
    } catch (err) {
      this.cb.onStatus({ state: 'error', detail: `Could not launch agent: ${String((err as any)?.message ?? err)}` })
      return
    }
    this.child = child
    child.on('error', (err) => {
      this.cb.log('error', 'adapter.spawn.error', String((err as any)?.message ?? err))
      this.cb.onStatus({ state: 'error', detail: `Agent failed to launch: ${String((err as any)?.message ?? err)}` })
    })

    child.stderr.on('data', (b: Buffer) => {
      // Adapter diagnostics (incl. auth guidance) — log + surface to the terminal.
      const text = b.toString()
      this.cb.log('debug', 'adapter.stderr', text.trimEnd())
      process.stderr.write(`[claude-agent-acp] ${b}`)
    })
    child.on('exit', (code) => {
      this.cb.log('warn', 'adapter.exit', { code })
      this.cb.onStatus({ state: 'stopped', detail: `adapter exited (${code})` })
    })

    const input = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    const output = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>
    const stream: Stream = ndJsonStream(output, input)

    this.conn = new ClientSideConnection(() => this.buildClient(), stream)

    try {
      const init = await this.conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true
        }
      })

      this.agentInfo = {
        name: (init.agentInfo as any)?.name,
        version: (init.agentInfo as any)?.version
      }

      this.cb.log('info', 'initialize.ok', {
        protocolVersion: init.protocolVersion,
        agent: this.agentInfo,
        authMethods: (init.authMethods ?? []).length
      })

      await this.createSession('initial')
      this.cb.onStatus({ state: 'ready', detail: `protocol v${init.protocolVersion}` })
    } catch (err) {
      const msg = String((err as any)?.message ?? err)
      // A missing/!valid credential typically surfaces here as an auth error.
      const authish = /auth/i.test(msg)
      this.cb.log('error', 'initialize.error', msg)
      this.cb.onStatus({
        state: authish ? 'auth_required' : 'error',
        detail: authish
          ? 'Agent authentication required — log in to it (e.g. `claude login` / `codex login`) or set its API key, then restart the agent.'
          : msg
      })
    }
  }

  /**
   * Create a fresh ACP session on the existing adapter connection. Cheap (no
   * subprocess restart), so "New session" is instant. The user's model/mode
   * choices are re-applied so a new session doesn't reset them.
   */
  private async createSession(reason: 'initial' | 'reset'): Promise<string | null> {
    if (!this.conn) return null
    const session = await this.conn.newSession({
      cwd: this.projectRoot,
      mcpServers: this.mcpServers as any
    })
    this.sessionId = session.sessionId
    this.turnTokens = 0
    this.activityState = 'idle'
    const applied = await this.reapplyConfig(session.configOptions)
    this.emitConfig(applied)
    this.cb.log('info', reason === 'initial' ? 'session.new' : 'session.reset', {
      sessionId: session.sessionId,
      modes: (session.modes as any)?.availableModes?.map((m: any) => m.id),
      configOptions: (applied as any[] | undefined)?.map((o) => o.id)
    })
    this.cb.onSession({ id: session.sessionId, reason })
    return session.sessionId
  }

  /** Start a brand-new coding session (clears the agent's conversation context). */
  async newSession(): Promise<{ ok: boolean; error?: string }> {
    if (!this.conn) return { ok: false, error: 'ACP not connected' }
    try {
      await this.createSession('reset')
      this.cb.onActivity({ state: 'idle' })
      return { ok: true }
    } catch (err) {
      const msg = String((err as any)?.message ?? err)
      this.cb.log('error', 'session.reset.error', msg)
      return { ok: false, error: msg }
    }
  }

  /**
   * Resume a past session by id. The adapter replays its history as
   * session/update notifications, so the transcript rebuilds itself.
   */
  async loadSession(id: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.conn) return { ok: false, error: 'ACP not connected' }
    try {
      this.turnTokens = 0
      this.activityState = 'idle'
      const res = await this.conn.loadSession({
        sessionId: id,
        cwd: this.projectRoot,
        mcpServers: this.mcpServers as any
      })
      this.sessionId = id
      // Only re-emit config if the load response carried options.
      const opts = (res as any)?.configOptions
      if (Array.isArray(opts)) this.emitConfig(await this.reapplyConfig(opts))
      this.cb.onSession({ id, reason: 'load' })
      this.cb.onActivity({ state: 'idle' })
      this.cb.log('info', 'session.load', { id })
      return { ok: true }
    } catch (err) {
      const msg = String((err as any)?.message ?? err)
      this.cb.log('error', 'session.load.error', { id, msg })
      return { ok: false, error: msg }
    }
  }

  /** Re-apply remembered config choices to a freshly-created session. */
  private async reapplyConfig(raw: unknown): Promise<unknown> {
    if (!Array.isArray(raw) || !this.conn || !this.sessionId) return raw
    for (const opt of raw as any[]) {
      const want = this.savedConfig[opt.id]
      const exists = opt.options?.some?.((o: any) => o.value === want)
      if (want != null && want !== opt.currentValue && exists) {
        try {
          await this.conn.setSessionConfigOption({
            sessionId: this.sessionId,
            configId: opt.id,
            value: want
          } as any)
          opt.currentValue = want
        } catch (err) {
          this.cb.log('warn', 'session.reapplyConfig.error', {
            id: opt.id,
            err: String((err as any)?.message ?? err)
          })
        }
      }
    }
    return raw
  }

  private emitConfig(rawOptions: unknown): void {
    this.cb.onConfig({
      agentName: this.agentInfo.name,
      agentVersion: this.agentInfo.version,
      options: toConfigOptions(rawOptions)
    })
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    this.savedConfig[configId] = value
    if (!this.conn || !this.sessionId) return
    try {
      await this.conn.setSessionConfigOption({
        sessionId: this.sessionId,
        configId,
        value
      } as any)
    } catch (err) {
      this.cb.onUpdate({
        kind: 'error',
        text: `Could not set ${configId}: ${String((err as any)?.message ?? err)}`
      })
    }
  }

  async prompt(text: string): Promise<{ stopReason?: string; error?: string }> {
    if (!this.conn || !this.sessionId) {
      return { error: 'ACP session not ready' }
    }
    this.turnTokens = 0
    this.setActivity('thinking')
    const t0 = Date.now()
    this.cb.log('info', 'prompt.start', { chars: text.length, preview: text.slice(0, 200) })
    try {
      const res = await this.conn.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }]
      })
      this.cb.log('info', 'prompt.done', {
        stopReason: res.stopReason,
        ms: Date.now() - t0,
        tokens: this.turnTokens
      })
      return { stopReason: res.stopReason }
    } catch (err) {
      const msg = String((err as any)?.message ?? err)
      this.cb.log('error', 'prompt.error', { msg, ms: Date.now() - t0 })
      return { error: msg }
    } finally {
      this.setActivity('idle')
    }
  }

  private setActivity(state: Activity['state'], detail?: string): void {
    this.activityState = state
    this.cb.onActivity({ state, detail, tokens: this.turnTokens || undefined })
  }

  async cancel(): Promise<void> {
    if (this.conn && this.sessionId) {
      await this.conn.cancel({ sessionId: this.sessionId }).catch(() => {})
    }
  }

  stop(): void {
    for (const t of this.terminals.values()) t.kill()
    this.terminals.clear()
    this.child?.kill('SIGTERM')
    this.child = null
    this.conn = null
    this.sessionId = null
  }

  private buildClient(): Client {
    const cb = this.cb
    return {
      sessionUpdate: async (params: schema.SessionNotification): Promise<void> => {
        const update = params.update as any
        const type = update?.sessionUpdate
        this.logUpdate(update)

        // Keep config (model/mode) in sync when the agent reports a change.
        if (type === 'config_option_update') {
          this.emitConfig(update.configOptions)
          return
        }
        // usage_update: fold token counts into the activity indicator, no row.
        if (type === 'usage_update') {
          const t = sumTokens(update.usage ?? update)
          if (t != null) this.turnTokens = t
          this.setActivity(this.activityState)
          return
        }
        // Other chatter is logged but kept out of the transcript.
        if (QUIET_UPDATES.has(type)) return

        this.emitActivityFor(update)
        cb.onUpdate(this.normalize(update))
      },

      requestPermission: async (
        params: schema.RequestPermissionRequest
      ): Promise<schema.RequestPermissionResponse> => {
        const tc: any = params.toolCall
        const req: PermissionRequestDTO = {
          requestId: randomUUID(),
          title: tc?.title ?? tc?.rawInput?.description ?? 'Allow tool call?',
          toolKind: tc?.kind ?? undefined,
          locations: Array.isArray(tc?.locations)
            ? tc.locations.map((l: any) => l?.path).filter(Boolean)
            : undefined,
          options: params.options.map((o) => ({
            optionId: o.optionId,
            name: o.name,
            kind: o.kind
          }))
        }
        this.cb.log('info', 'permission.request', {
          title: req.title,
          kind: req.toolKind,
          options: req.options.map((o) => o.optionId)
        })
        // The turn blocks here until the user answers — a common cause of
        // "stuck thinking". The log makes that explicit.
        const chosen = await cb.onPermission(req)
        this.cb.log('info', 'permission.response', { chosen: chosen ?? 'cancelled' })
        if (!chosen) return { outcome: { outcome: 'cancelled' } }
        return { outcome: { outcome: 'selected', optionId: chosen } }
      },

      readTextFile: async (
        params: schema.ReadTextFileRequest
      ): Promise<schema.ReadTextFileResponse> => {
        const abs = this.assertInProject(params.path)
        let content = await fs.readFile(abs, 'utf8')
        if (params.line != null || params.limit != null) {
          const lines = content.split('\n')
          const start = Math.max(0, (params.line ?? 1) - 1)
          const end = params.limit != null ? start + params.limit : lines.length
          content = lines.slice(start, end).join('\n')
        }
        return { content }
      },

      writeTextFile: async (
        params: schema.WriteTextFileRequest
      ): Promise<schema.WriteTextFileResponse> => {
        const abs = this.assertInProject(params.path)
        await fs.mkdir(dirname(abs), { recursive: true })
        await fs.writeFile(abs, params.content, 'utf8')
        return {}
      },

      createTerminal: async (
        params: schema.CreateTerminalRequest
      ): Promise<schema.CreateTerminalResponse> => {
        const terminalId = randomUUID()
        const term = new Terminal(
          params.command,
          params.args ?? [],
          params.cwd ?? this.projectRoot,
          envArrayToObject(params.env),
          params.outputByteLimit ?? 1_000_000
        )
        this.terminals.set(terminalId, term)
        return { terminalId }
      },

      terminalOutput: async (
        params: schema.TerminalOutputRequest
      ): Promise<schema.TerminalOutputResponse> => {
        const term = this.terminals.get(params.terminalId)
        if (!term) throw new Error(`Unknown terminal ${params.terminalId}`)
        return term.output()
      },

      waitForTerminalExit: async (
        params: schema.WaitForTerminalExitRequest
      ): Promise<schema.WaitForTerminalExitResponse> => {
        const term = this.terminals.get(params.terminalId)
        if (!term) throw new Error(`Unknown terminal ${params.terminalId}`)
        return term.waitForExit()
      },

      releaseTerminal: async (
        params: schema.ReleaseTerminalRequest
      ): Promise<schema.ReleaseTerminalResponse> => {
        const term = this.terminals.get(params.terminalId)
        term?.kill()
        this.terminals.delete(params.terminalId)
        return {}
      },

      killTerminal: async (
        params: schema.KillTerminalRequest
      ): Promise<schema.KillTerminalResponse> => {
        this.terminals.get(params.terminalId)?.kill()
        return {}
      }
    }
  }

  /** Drive the live activity indicator from streaming updates. */
  private emitActivityFor(update: any): void {
    switch (update?.sessionUpdate) {
      case 'agent_thought_chunk':
        this.setActivity('thinking')
        break
      case 'agent_message_chunk':
        this.setActivity('responding')
        break
      case 'tool_call':
      case 'tool_call_update':
        this.setActivity('tool', update.title ?? update.kind ?? 'tool')
        break
    }
  }

  /** Concise per-update log line (full text is large, so summarize). */
  private logUpdate(update: any): void {
    const type = update?.sessionUpdate
    switch (type) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
      case 'user_message_chunk':
        this.cb.log('debug', `update.${type}`, { chars: textOf(update.content)?.length ?? 0 })
        break
      case 'tool_call':
      case 'tool_call_update':
        this.cb.log('info', `update.${type}`, {
          id: update.toolCallId,
          kind: update.kind,
          title: update.title,
          status: update.status,
          locations: locationsOf(update)
        })
        break
      case 'usage_update':
        this.cb.log('debug', 'update.usage_update', update.usage ?? update)
        break
      default:
        this.cb.log('debug', `update.${type}`)
    }
  }

  /** Turn an ACP session/update payload into a render-friendly AdaptUpdate. */
  private normalize(update: any): AdaptUpdate {
    switch (update?.sessionUpdate) {
      case 'user_message_chunk':
        return { kind: 'user', text: textOf(update.content) }
      case 'agent_message_chunk':
        return { kind: 'agent', text: textOf(update.content) }
      case 'agent_thought_chunk':
        return { kind: 'thought', text: textOf(update.content) }
      case 'tool_call':
        return {
          kind: 'tool',
          toolId: update.toolCallId,
          toolTitle: update.title,
          toolKind: update.kind,
          status: update.status,
          locations: locationsOf(update),
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          content: contentText(update.content)
        }
      case 'tool_call_update':
        return {
          kind: 'tool_update',
          toolId: update.toolCallId,
          toolTitle: update.title,
          toolKind: update.kind,
          status: update.status,
          locations: locationsOf(update),
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          content: contentText(update.content)
        }
      case 'plan':
        return { kind: 'plan', text: 'Updated plan', rawOutput: update.entries }
      case 'available_commands_update':
        return { kind: 'info', text: 'Commands updated' }
      case 'current_mode_update':
        return { kind: 'info', text: `Mode: ${update.currentModeId ?? ''}` }
      default:
        return { kind: 'info', text: update?.sessionUpdate ?? 'update' }
    }
  }
}
