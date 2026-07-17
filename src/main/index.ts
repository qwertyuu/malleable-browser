import { app, BrowserWindow, WebContentsView, ipcMain, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { promises as fsp } from 'node:fs'
import { AcpClient } from './acp-client.js'
import { Checkpoints } from './checkpoint.js'
import { Adaptations } from './adaptations.js'
import { SessionStore } from './sessions.js'
import { Logger } from './logger.js'
import { PageInspector } from './page-inspector.js'
import { startPageToolsServer, type PageToolsHandle } from './page-tools-server.js'
import { DynamicTools } from './dynamic-tools.js'
import { loadPersona, seedPersona } from './persona.js'
import { AppSettings } from './app-settings.js'
import {
  IPC,
  EVT,
  type Rect,
  type NavState,
  type AdaptResult,
  type PermissionRequestDTO
} from '../shared/ipc.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// User artifacts (overlays, scaffolded tools, sessions, logs, checkpoints) live in
// a WORKSPACE outside the app source. This is also the agent's ACP cwd, so the
// agent physically cannot reach or edit the browser's own code.
const WORKSPACE = process.env.MALLEABLE_WORKSPACE ?? join(app.getPath('userData'), 'workspace')
const DEFAULT_URL = 'https://example.com'

let win: BrowserWindow | null = null
let contentView: WebContentsView | null = null
let acp: AcpClient | null = null
const checkpoints = new Checkpoints(WORKSPACE)
const adaptations = new Adaptations(WORKSPACE)
const dynamicTools = new DynamicTools(WORKSPACE)
const sessions = new SessionStore(WORKSPACE)
const logger = new Logger(join(WORKSPACE, 'logs'))
const pageInspector = new PageInspector(() => contentView?.webContents)
const appSettings = new AppSettings(join(app.getPath('userData'), 'settings.json'))
let pageTools: PageToolsHandle | null = null

/** Create the workspace and make it a git repo so checkpoints/revert work. */
async function ensureWorkspace(): Promise<void> {
  await fsp.mkdir(WORKSPACE, { recursive: true })
  await fsp.mkdir(join(WORKSPACE, 'adaptations'), { recursive: true })
  await fsp.mkdir(join(WORKSPACE, 'tools'), { recursive: true })
  await fsp.writeFile(join(WORKSPACE, '.gitignore'), 'logs/\n.malleable/\n', 'utf8').catch(() => {})
  await fsp.writeFile(
    join(WORKSPACE, 'README.md'),
    '# Malleable Browser workspace\n\nAgent-authored site overlays (`adaptations/`) and tools (`tools/`). Managed by the app.\n',
    'utf8'
  ).catch(() => {})
  await adaptations.migrate()
  await dynamicTools.migrate()
  await seedPersona(WORKSPACE)
  await checkpoints.ensureRepo()
  logger.log('info', 'workspace', { path: WORKSPACE })
  console.log(`[malleable] workspace → ${WORKSPACE}`)
}

// Pending permission requests keyed by requestId; resolved by the renderer.
const pendingPermissions = new Map<string, (optionId: string | null) => void>()

function sendToChrome(channel: string, payload: unknown): void {
  if (!win) return
  try {
    win.webContents.send(channel, payload)
  } catch {
    // Tool payloads carry arbitrary rawInput/rawOutput from the adapter that can
    // fail structured-clone; fall back to a JSON-safe copy so the row still shows.
    try {
      win.webContents.send(channel, JSON.parse(JSON.stringify(payload)))
    } catch (err) {
      logger.log('warn', 'ipc.send.failed', { channel, err: String((err as any)?.message ?? err) })
    }
  }
}

async function emitNavState(): Promise<void> {
  const wc = contentView?.webContents
  if (!wc) return
  const url = wc.getURL()
  const slug = adaptations.slugFor(url)
  const state: NavState = {
    url,
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    isLoading: wc.isLoading(),
    title: wc.getTitle(),
    origin: slug ?? '',
    adapted: slug ? await adaptations.hasEnabled(slug) : false
  }
  // Re-scope the agent's site tools to the page it's now on.
  pageTools?.syncSiteTools(slug ?? null)
  sendToChrome(EVT.navState, state)
}

/** Reload the visible page and wait for load — used after the agent saves an edit. */
async function reloadCurrent(): Promise<void> {
  const wc = contentView?.webContents
  if (!wc) return
  await new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      wc.off('did-finish-load', finish)
      resolve()
    }
    wc.once('did-finish-load', finish)
    wc.reload()
    setTimeout(finish, 8000)
  })
}

/** If the edited/toggled host is the one on screen, reload so changes take effect. */
function reapplyIfCurrent(host: string): void {
  const wc = contentView?.webContents
  if (wc && adaptations.slugFor(wc.getURL()) === host) wc.reload()
}

/** Lightweight page identity. The agent pulls DOM/console/etc. via its tools. */
async function capturePage(): Promise<{ url: string; title: string } | null> {
  const wc = contentView?.webContents
  if (!wc) return null
  try {
    return await wc.executeJavaScript(
      `({ url: location.href, title: document.title })`
    )
  } catch {
    return null
  }
}

function createContentView(): void {
  // Sandboxed view for arbitrary/untrusted web content. It has NO preload and no
  // Node access — Claude's file/terminal power lives in the main process only and
  // is unreachable from rendered pages.
  contentView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win!.contentView.addChildView(contentView)
  contentView.setBounds({ x: 0, y: 0, width: 0, height: 0 })

  const wc = contentView.webContents
  wc.on('did-navigate', () => void emitNavState())
  wc.on('did-navigate-in-page', () => void emitNavState())
  wc.on('did-start-loading', () => void emitNavState())
  wc.on('did-stop-loading', () => void emitNavState())
  wc.on('page-title-updated', () => void emitNavState())

  // Inject this origin's saved content adaptation into every page load. Early
  // (dom-ready) so styles apply before paint; JS is guarded inside apply().
  wc.on('dom-ready', () => void adaptations.apply(wc, wc.getURL()))

  // Wire console + network capture for the agent's page-inspection tools.
  pageInspector.attach(wc)

  // Open target=_blank / window.open in the same view rather than a native window.
  wc.setWindowOpenHandler(({ url }) => {
    wc.loadURL(url).catch(() => {})
    return { action: 'deny' }
  })

  wc.loadURL(DEFAULT_URL).catch(() => {})
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Malleable Browser',
    backgroundColor: '#1e1e28',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('closed', () => {
    win = null
    contentView = null
  })

  // Load the React chrome (dev server in `dev`, built file otherwise).
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  createContentView()
}

function wireIpc(): void {
  ipcMain.handle(IPC.navigate, (_e, url: string) => {
    contentView?.webContents.loadURL(normalizeUrl(url)).catch(() => {})
  })
  ipcMain.handle(IPC.goBack, () => {
    const wc = contentView?.webContents
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  })
  ipcMain.handle(IPC.goForward, () => {
    const wc = contentView?.webContents
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  })
  ipcMain.handle(IPC.reload, () => contentView?.webContents.reload())

  ipcMain.handle(IPC.setContentBounds, (_e, r: Rect) => {
    contentView?.setBounds({
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.max(0, Math.round(r.width)),
      height: Math.max(0, Math.round(r.height))
    })
  })

  // ---- The malleability loop: adapt the CURRENT PAGE ----
  ipcMain.handle(IPC.adaptPrompt, async (_e, text: string): Promise<AdaptResult> => {
    if (!acp) return { ok: false, error: 'ACP not started' }
    const page = await capturePage()
    if (!page) return { ok: false, error: 'No page loaded to adapt' }
    const slug = adaptations.slugFor(page.url)
    if (!slug) return { ok: false, error: 'This page has no adaptable origin' }

    const statusBefore = await checkpoints.status()
    if (sessions.currentId) {
      await sessions.setTitleIfDefault(sessions.currentId, text)
      sendToChrome(EVT.sessions, sessions.list())
    }
    logger.log('info', 'adapt.request', { host: slug, url: page.url, request: text })
    // The agent inspects the live page and manages named edits via its MCP tools
    // (save_adaptation etc.), which apply immediately. Main just checkpoints after.
    const prompt = adaptations.buildPrompt({
      url: page.url,
      title: page.title,
      host: slug,
      edits: await adaptations.listForHost(slug),
      request: text,
      persona: await loadPersona(WORKSPACE)
    })
    const res = await acp.prompt(prompt)

    const treeChanged = (await checkpoints.status()) !== statusBefore
    const checkpoint = treeChanged
      ? ((await checkpoints.commitArtifacts(`${slug}: ${text.slice(0, 60)}`)) ?? undefined)
      : undefined
    void emitNavState()
    logger.log('info', 'adapt.result', { host: slug, ok: !res.error, treeChanged, checkpoint })
    return { ok: !res.error, stopReason: res.stopReason, error: res.error, checkpoint }
  })
  ipcMain.handle(IPC.adaptCancel, async () => acp?.cancel())
  ipcMain.handle(IPC.newSession, async () => (acp ? acp.newSession() : { ok: false }))

  // Ask the agent to manage a saved site's edits from the library (may be off-page).
  ipcMain.handle(IPC.adaptHost, async (_e, host: string, text: string): Promise<AdaptResult> => {
    if (!acp) return { ok: false, error: 'ACP not started' }
    const statusBefore = await checkpoints.status()
    if (sessions.currentId) {
      await sessions.setTitleIfDefault(sessions.currentId, text)
      sendToChrome(EVT.sessions, sessions.list())
    }
    logger.log('info', 'adapt.host', { host, request: text })
    const onCurrent = adaptations.slugFor(contentView?.webContents.getURL() ?? '') === host
    const prompt = adaptations.buildPrompt({
      url: onCurrent ? (contentView?.webContents.getURL() ?? '') : `https://${host}/`,
      title: host,
      host,
      edits: await adaptations.listForHost(host),
      request: text,
      persona: await loadPersona(WORKSPACE),
      live: onCurrent
    })
    const res = await acp.prompt(prompt)
    const treeChanged = (await checkpoints.status()) !== statusBefore
    const checkpoint = treeChanged
      ? ((await checkpoints.commitArtifacts(`${host}: ${text.slice(0, 60)}`)) ?? undefined)
      : undefined
    void emitNavState()
    logger.log('info', 'adapt.host.result', { host, ok: !res.error, treeChanged, checkpoint })
    return { ok: !res.error, stopReason: res.stopReason, error: res.error, checkpoint }
  })

  // ---- Session switching ----
  ipcMain.handle(IPC.listSessions, () => sessions.list())
  ipcMain.handle(IPC.switchSession, async (_e, id: string) => {
    if (!acp) return { ok: false, error: 'ACP not started' }
    if (id === sessions.currentId) return { ok: true }
    // Clear the transcript first; loadSession replays the old history into it.
    sendToChrome(EVT.clearTranscript, null)
    const res = await acp.loadSession(id)
    if (res.ok) {
      sessions.setCurrent(id)
      sendToChrome(EVT.sessions, sessions.list())
    }
    return res
  })

  ipcMain.handle(IPC.resetSite, async () => {
    const wc = contentView?.webContents
    const slug = wc ? adaptations.slugFor(wc.getURL()) : null
    if (!slug) return { ok: false }
    await adaptations.clearHost(slug)
    wc?.reload()
    void emitNavState()
    return { ok: true }
  })

  // ---- Agent configuration (model / permission mode) ----
  ipcMain.handle(IPC.setConfigOption, async (_e, configId: string, value: string) => {
    await acp?.setConfigOption(configId, value)
  })

  // ---- App settings: which ACP agent to run ----
  ipcMain.handle(IPC.getAppSettings, () => appSettings.get())
  ipcMain.handle(IPC.setAgentCommand, async (_e, agentCommand: string) => {
    const data = await appSettings.set({ agentCommand })
    logger.log('info', 'settings.agentCommand', { agentCommand })
    restartAcp() // relaunch with the new agent
    return data
  })

  // ---- Adaptation library (multiple named edits per host) ----
  ipcMain.handle(IPC.listAdaptations, () => adaptations.listAll())
  ipcMain.handle(IPC.getEdit, (_e, host: string, id: string) => adaptations.getEdit(host, id))
  ipcMain.handle(
    IPC.saveEdit,
    async (_e, host: string, edit: { id?: string; name: string; kind?: string; css?: string; js?: string }) => {
      const meta = await adaptations.saveEdit(host, edit)
      reapplyIfCurrent(host)
      void emitNavState()
      return meta
    }
  )
  ipcMain.handle(IPC.setEditEnabled, async (_e, host: string, id: string, enabled: boolean) => {
    await adaptations.setEnabled(host, id, enabled)
    reapplyIfCurrent(host)
    void emitNavState()
  })
  ipcMain.handle(IPC.deleteEdit, async (_e, host: string, id: string) => {
    await adaptations.deleteEdit(host, id)
    reapplyIfCurrent(host)
    void emitNavState()
  })

  // ---- Scaffolded tools (global + per-site) ----
  ipcMain.handle(IPC.listTools, async () => {
    const toSummary = (d: {
      name: string
      description: string
      scope: 'global' | 'site'
      host?: string
      inputSchema: Record<string, unknown>
      code: string
    }): unknown => ({
      name: d.name,
      description: d.description,
      scope: d.scope,
      host: d.host,
      params: d.inputSchema,
      code: d.code
    })
    return {
      global: (await dynamicTools.listGlobal()).map(toSummary),
      sites: Object.fromEntries(
        Object.entries(await dynamicTools.listAllSites()).map(([host, tools]) => [
          host,
          tools.map(toSummary)
        ])
      )
    }
  })
  ipcMain.handle(
    IPC.deleteTool,
    async (_e, name: string, scope: 'global' | 'site', host?: string) => {
      await dynamicTools.remove(name, scope, host)
      pageTools?.refreshTools()
    }
  )

  ipcMain.handle(IPC.permissionResponse, (_e, requestId: string, optionId: string | null) => {
    pendingPermissions.get(requestId)?.(optionId)
    pendingPermissions.delete(requestId)
  })

  ipcMain.handle(IPC.revertLast, () => checkpoints.revertLast())
  ipcMain.handle(IPC.listCheckpoints, () => checkpoints.list())

  ipcMain.handle(IPC.getLogPath, () => logger.path)
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {})
  })
}

function normalizeUrl(input: string): string {
  const s = input.trim()
  if (/^https?:\/\//i.test(s) || /^(about|file|data):/i.test(s)) return s
  if (/^localhost(:\d+)?/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(s)) return `http://${s}`
  if (/\.\w{2,}(\/|$|:\d)/.test(s) && !s.includes(' ')) return `https://${s}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`
}

function mcpServersForSession(): unknown[] {
  if (!pageTools) return []
  return [
    {
      type: 'http',
      name: 'malleable-page',
      url: pageTools.url,
      headers: [{ name: 'Authorization', value: `Bearer ${pageTools.token}` }]
    }
  ]
}

function startAcp(): void {
  acp = new AcpClient(WORKSPACE, {
    onUpdate: (u) => sendToChrome(EVT.adaptUpdate, u),
    onStatus: (s) => sendToChrome(EVT.acpStatus, s),
    onConfig: (c) => sendToChrome(EVT.agentConfig, c),
    onActivity: (a) => sendToChrome(EVT.activity, a),
    onSession: async ({ id }) => {
      await sessions.add(id, 'New session', Date.now())
      sendToChrome(EVT.sessions, sessions.list())
    },
    log: (level, event, data) => logger.log(level, event, data),
    onPermission: (req: PermissionRequestDTO) =>
      new Promise<string | null>((resolve) => {
        pendingPermissions.set(req.requestId, resolve)
        sendToChrome(EVT.permissionRequest, req)
      })
  })
  acp.setMcpServers(mcpServersForSession())
  acp.setAgentCommand(appSettings.get().agentCommand)
  void acp.start()
}

/** Restart the agent subprocess (e.g. after changing the agent command). */
function restartAcp(): void {
  acp?.stop()
  sendToChrome(EVT.clearTranscript, null)
  startAcp()
}

app.whenReady().then(async () => {
  await ensureWorkspace()
  await appSettings.load()
  await sessions.load()
  wireIpc()
  createWindow()
  // Start the page-tools MCP server before the agent so the first session gets it.
  try {
    pageTools = await startPageToolsServer({
      inspector: pageInspector,
      workspace: WORKSPACE,
      adaptations,
      currentUrl: () => contentView?.webContents.getURL() ?? '',
      reloadCurrent,
      log: (l, e, d) => logger.log(l, e, d)
    })
  } catch (err) {
    logger.log('error', 'mcp.server.failed', String((err as any)?.message ?? err))
  }
  startAcp()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  acp?.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  acp?.stop()
  pageTools?.close()
  logger.close()
})

// Never let the trusted chrome navigate itself away to a remote origin.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (contents === win?.webContents && !url.startsWith('http://localhost') && !url.startsWith('file://')) {
      event.preventDefault()
      shell.openExternal(url).catch(() => {})
    }
  })
})
