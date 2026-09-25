import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { promises as fsp } from 'node:fs'
import { AcpClient } from './acp-client.js'
import { Checkpoints } from './checkpoint.js'
import { Adaptations } from './adaptations.js'
import { Bubbles } from './bubbles.js'
import { startBubbleServer, type BubbleServerHandle } from './bubble-server.js'
import { pushBubble } from './bubble-push.js'
import { installCspRelaxation } from './csp.js'
import { publishHostAsExtension, publishBubbleAsExtension } from './publish-extension.js'
import { publishHostAsUserscript } from './publish-userscript.js'
import { SessionStore } from './sessions.js'
import { Logger } from './logger.js'
import { TabManager, type TabRecord } from './tabs.js'
import { showTabContextMenu, showBubbleChipMenu } from './tab-menu.js'
import { startPageToolsServer, type PageToolsHandle } from './page-tools-server.js'
import { startCdpBridge, type CdpBridgeHandle } from './cdp-bridge.js'
import { DynamicTools } from './dynamic-tools.js'
import { loadPersona, seedPersona } from './persona.js'
import { AppSettings } from './app-settings.js'
import {
  IPC,
  EVT,
  type Rect,
  type TabInfo,
  type TabsState,
  type Bubble,
  type BubbleConsentRequest,
  type AdaptResult,
  type PermissionRequestDTO
} from '../shared/ipc.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// User artifacts (overlays, scaffolded tools, sessions, logs, checkpoints) live in
// a WORKSPACE outside the app source. This is also the agent's ACP cwd, so the
// agent physically cannot reach or edit the browser's own code.
const WORKSPACE = process.env.MALLEABLE_WORKSPACE ?? join(app.getPath('userData'), 'workspace')
const DEFAULT_URL = 'https://example.com'
// Tampermonkey's official Chrome Web Store extension id (stable/well-known).
const TAMPERMONKEY_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo'

let win: BrowserWindow | null = null
let acp: AcpClient | null = null
// Safe Mode: strip the browser's automation fingerprint (CDP debugger attached,
// Electron-flavored user agent, injected adaptations) for sites — banks, mostly —
// whose bot/fraud detection blocks anything that doesn't look like stock Chrome.
// Per-tab (TabRecord.safeMode): one bank tab shouldn't de-fingerprint every page.
let defaultUserAgent = ''
let safeUserAgent = ''
const checkpoints = new Checkpoints(WORKSPACE)
const adaptations = new Adaptations(WORKSPACE)
const bubbles = new Bubbles(WORKSPACE)
const dynamicTools = new DynamicTools(WORKSPACE)
const sessions = new SessionStore(WORKSPACE)
const logger = new Logger(join(WORKSPACE, 'logs'))
const tabs = new TabManager({
  workspace: WORKSPACE,
  slugFor: (url) => adaptations.slugFor(url),
  defaultUrl: DEFAULT_URL,
  hooks: {
    onNav: () => void emitTabs(),
    onDomReady: (tab) => {
      // Inject this origin's saved adaptations into every page load. Early
      // (dom-ready) so styles apply before paint; JS is guarded inside apply().
      // Skipped in Safe Mode, which aims to look exactly like stock Chrome.
      if (tab.safeMode) return
      const wc = tab.view.webContents
      void adaptations.apply(wc, wc.getURL(), malContext())
    },
    onTabsChanged: () => void emitTabs()
  }
})
const appSettings = new AppSettings(join(app.getPath('userData'), 'settings.json'))
let pageTools: PageToolsHandle | null = null
let bubbleServer: BubbleServerHandle | null = null
// Hosts that belong to at least one bubble. Kept as a plain synchronous set
// because the CSP header hook runs on every response and cannot await disk.
const bubbleHosts = new Set<string>()
let cdpBridge: CdpBridgeHandle | null = null

/** Create the workspace and make it a git repo so checkpoints/revert work. */
async function ensureWorkspace(): Promise<void> {
  await fsp.mkdir(WORKSPACE, { recursive: true })
  await fsp.mkdir(join(WORKSPACE, 'adaptations'), { recursive: true })
  await fsp.mkdir(join(WORKSPACE, 'tools'), { recursive: true })
  // Bubble membership is a durable artifact and IS checkpointed; the state the
  // bubble server holds is churning runtime data and lives under .malleable/.
  await fsp.mkdir(join(WORKSPACE, 'bubbles'), { recursive: true })
  // live/ holds raw captured network+console history (headers/bodies can carry
  // auth tokens/cookies) — kept out of checkpoints, same treatment as logs/.
  await fsp.writeFile(join(WORKSPACE, '.gitignore'), 'logs/\n.malleable/\nlive/\n', 'utf8').catch(() => {})
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
// Same pattern for bubble consent: the ONE gate in the bubble model. Asked when a
// bubble gains sites, never per call, so approving a bubble once is the whole
// grant — and declining leaves the bubble exactly as it was.
const pendingConsents = new Map<string, (allow: boolean) => void>()

function askBubbleConsent(
  id: string | undefined,
  name: string,
  adding: string[]
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const requestId = randomUUID()
    const req: BubbleConsentRequest = { requestId, name, adding, existing: [] }
    pendingConsents.set(requestId, resolve)
    void (async () => {
      const existing = id ? await bubbles.get(id) : null
      sendToChrome(EVT.bubbleConsentRequest, { ...req, existing: existing?.hosts ?? [] })
    })()
  })
}

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

async function describeTab(tab: TabRecord): Promise<TabInfo> {
  const wc = tab.view.webContents
  if (wc.isDestroyed()) {
    return {
      id: tab.id, url: '', title: '', origin: '', adapted: false,
      isLoading: false, canGoBack: false, canGoForward: false,
      hidden: tab.hidden, safeMode: tab.safeMode
    }
  }
  const url = wc.getURL()
  const slug = adaptations.slugFor(url)
  return {
    id: tab.id,
    url,
    title: wc.getTitle(),
    origin: slug ?? '',
    adapted: slug ? await adaptations.hasEnabled(slug) : false,
    isLoading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    hidden: tab.hidden,
    safeMode: tab.safeMode
  }
}

/**
 * Push the whole tab set. TabInfo is a superset of the old single-page NavState,
 * so the address bar just reads the active entry — one channel, one computation,
 * no way for the strip and the address bar to disagree.
 */
async function emitTabs(): Promise<void> {
  const infos = await Promise.all(tabs.visible().map(describeTab))
  const activeId = tabs.activeId
  const state: TabsState = { tabs: infos, activeId }
  // Re-scope the agent's site tools to the page it's focused on.
  pageTools?.syncSiteTools(infos.find((t) => t.id === activeId)?.origin || null)
  sendToChrome(EVT.tabsState, state)
}

/** Reload one tab and wait for load — used after the agent saves an edit. */
async function reloadTab(tab: TabRecord | undefined): Promise<void> {
  const wc = tab?.view.webContents
  if (!wc || wc.isDestroyed()) return
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

/** Reload the tab the agent is working on (its `tab` arg, else the active one). */
async function reloadCurrent(ref?: string): Promise<void> {
  await reloadTab(tabs.resolve(ref))
}

/**
 * Reload EVERY tab showing the edited host, not just the focused one — with
 * multiple tabs open the same site can be on screen more than once.
 */
function reapplyForHost(host: string): void {
  for (const t of tabs.forHost(host)) {
    if (!t.view.webContents.isDestroyed()) t.view.webContents.reload()
  }
}

/** Same, but await every reload — the agent needs the edit visible before it looks. */
async function reloadHost(host: string): Promise<void> {
  await Promise.all(tabs.forHost(host).map((t) => reloadTab(t)))
}

/**
 * Strip this app's "<name>/<version>" and "Electron/<version>" tokens out of the
 * default UA, leaving the stock Chromium identity (same real engine, just no
 * automation-tool giveaway) that Safe Mode presents to the page.
 */
function deriveSafeUserAgent(ua: string): string {
  return ua.replace(/\s*\S+\/[\d.]+(?=\s+Chrome\/)/, '').replace(/\s*Electron\/[\d.]+/, '')
}

/**
 * Bubble wiring handed to the injector. Undefined until the bubble server is up,
 * in which case edits get `mal === null` and simply have no cross-tab reach.
 */
function malContext(): { endpoint: string; token: string; bubbleFor: (h: string, e: string) => Promise<Bubble | null> } | undefined {
  if (!bubbleServer) return undefined
  return {
    endpoint: bubbleServer.url,
    token: bubbleServer.token,
    bubbleFor: (host, editId) => bubbles.bubbleForEdit(host, editId)
  }
}

/**
 * Open (or focus) a tab for `host` and resolve only once its edits are injected —
 * a push that lands before the destination's fill edit exists would be missed.
 * Hidden worker tabs are never attached to the window.
 */
async function ensureTabForHost(host: string, hidden = false): Promise<string | null> {
  const open = tabs.forHost(host).find((t) => t.hidden === hidden) ?? tabs.forHost(host)[0]
  if (open) {
    if (!open.hidden && !hidden) tabs.focus(open.id)
    return open.id
  }
  if (hiddenTabCount() >= MAX_HIDDEN_TABS) {
    logger.log('warn', 'bubble.hidden.capped', { host, cap: MAX_HIDDEN_TABS })
    return null
  }
  const rec = tabs.create({ url: `https://${host}/`, background: true, hidden })
  const wc = rec.view.webContents
  await new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve()
    }
    // dom-ready is when the injector runs; give it a beat to finish applying.
    wc.once('dom-ready', () => setTimeout(finish, 400))
    setTimeout(finish, 12_000)
  })
  return rec.id
}

const MAX_HIDDEN_TABS = 4
const hiddenTabCount = (): number => tabs.list().filter((t) => t.hidden).length

/** Refresh the CSP allowlist + notify the renderer after any bubble change. */
async function refreshBubbles(): Promise<void> {
  const all = await bubbles.list()
  bubbleHosts.clear()
  for (const b of all) for (const h of b.hosts) bubbleHosts.add(h)
  sendToChrome(EVT.bubbles, all)
}

/**
 * The one path that creates or grows a bubble: consent for any new host, then
 * save and re-run every member page. Resolves null when the user declines;
 * throws when the save breaks the one-bubble-per-edit invariant.
 */
async function saveBubbleWithConsent(input: {
  id?: string
  name: string
  hosts: string[]
}): Promise<Bubble | null> {
  const added = await bubbles.hostsAddedBy(input.id, input.hosts)
  if (added.length && !(await askBubbleConsent(input.id, input.name, added))) return null
  const b = await bubbles.save(input)
  await refreshBubbles()
  // Membership changes what gets injected, so re-run every member page.
  for (const h of b.hosts) reapplyForHost(h)
  logger.log('info', 'bubble.save', { id: b.id, hosts: b.hosts })
  return b
}

/** Log a failed chrome-initiated bubble change (menus are fire-and-forget). */
function logBubbleMenuError(err: unknown): void {
  logger.log('warn', 'bubbleMenu.error', { err: String((err as Error)?.message ?? err) })
}

/** A new bubble holding only `host`, named after it. */
function startBubbleForHost(host: string): void {
  void bubbles
    .availableName(host)
    .then((name) => saveBubbleWithConsent({ name, hosts: [host] }))
    .catch(logBubbleMenuError)
}

function addHostToBubble(b: Bubble, host: string): void {
  void saveBubbleWithConsent({ id: b.id, name: b.name, hosts: [...b.hosts, host] }).catch(
    logBubbleMenuError
  )
}

/** Open a background tab for each member site that isn't showing anywhere. */
function openMissingBubbleSites(b: Bubble): void {
  for (const h of b.hosts) {
    if (tabs.forHost(h).some((t) => !t.hidden)) continue
    tabs.create({ url: `https://${h}/`, background: true })
  }
}

/** Right-click on a tab: start a bubble from its site, or add it to one. */
async function openTabContextMenu(tabId: string): Promise<void> {
  const tab = tabs.get(tabId)
  if (!win || !tab) return
  showTabContextMenu({
    win,
    host: tabs.hostOf(tab),
    bubbles: await bubbles.list(),
    startBubble: startBubbleForHost,
    addToBubble: addHostToBubble
  })
}

/** Click on a bubble chip: act on that bubble relative to the active tab. */
async function openBubbleChipMenu(bubbleId: string): Promise<void> {
  const b = await bubbles.get(bubbleId)
  if (!win || !b) return
  const active = tabs.active()
  showBubbleChipMenu({
    win,
    bubble: b,
    activeHost: active ? tabs.hostOf(active) : null,
    missingHosts: b.hosts.filter((h) => !tabs.forHost(h).some((t) => !t.hidden)),
    addActiveTab: (host) => addHostToBubble(b, host),
    openMissingSites: () => openMissingBubbleSites(b)
  })
}

/** Lightweight page identity. The agent pulls DOM/console/etc. via its tools. */
async function capturePage(tab: TabRecord | undefined): Promise<{ url: string; title: string } | null> {
  const wc = tab?.view.webContents
  if (!wc || wc.isDestroyed()) return null
  try {
    return await wc.executeJavaScript(
      `({ url: location.href, title: document.title })`
    )
  } catch {
    return null
  }
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
    tabs.destroyAll()
    win = null
  })

  tabs.attachWindow(win)

  // Load the React chrome (dev server in `dev`, built file otherwise).
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // The first tab. Its webContents supplies the UA pair Safe Mode toggles between.
  const first = tabs.create({})
  defaultUserAgent = first.view.webContents.userAgent
  safeUserAgent = deriveSafeUserAgent(defaultUserAgent)
}

function wireIpc(): void {
  ipcMain.handle(IPC.navigate, (_e, url: string, tabId?: string) => {
    tabs.resolve(tabId)?.view.webContents.loadURL(normalizeUrl(url)).catch(() => {})
  })
  ipcMain.handle(IPC.goBack, (_e, tabId?: string) => {
    const wc = tabs.resolve(tabId)?.view.webContents
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  })
  ipcMain.handle(IPC.goForward, (_e, tabId?: string) => {
    const wc = tabs.resolve(tabId)?.view.webContents
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  })
  ipcMain.handle(IPC.reload, (_e, tabId?: string) => tabs.resolve(tabId)?.view.webContents.reload())

  // One content rect for all tabs; TabManager toggles which one is visible.
  ipcMain.handle(IPC.setContentBounds, (_e, r: Rect) => tabs.setBounds(r))

  // ---- Tabs ----
  ipcMain.handle(IPC.newTab, (_e, url?: string) => {
    tabs.create({ url: url ? normalizeUrl(url) : undefined })
  })
  ipcMain.handle(IPC.closeTab, (_e, tabId: string) => {
    tabs.close(tabId)
  })
  ipcMain.handle(IPC.focusTab, (_e, tabId: string) => {
    tabs.focus(tabId)
  })
  ipcMain.handle(IPC.showTabMenu, (_e, tabId: string) => openTabContextMenu(tabId))
  ipcMain.handle(IPC.showBubbleMenu, (_e, bubbleId: string) => openBubbleChipMenu(bubbleId))
  ipcMain.handle(IPC.startBubbleFromTab, (_e, tabId?: string) => {
    const tab = tabId ? tabs.get(tabId) : tabs.active()
    const host = tab ? tabs.hostOf(tab) : null
    if (host) startBubbleForHost(host)
  })
  ipcMain.handle(IPC.setPageObscured, (_e, obscured: boolean) => {
    tabs.setObscured(obscured)
  })

  // Safe Mode: drop the automation fingerprint for the current page (CDP debugger,
  // Electron UA, adaptations) and reload so the site sees a stock-Chrome identity.
  // Turning it off doesn't force the debugger back on — that only happens lazily
  // when the agent is actually asked to work on a page (see adaptPrompt/adaptHost).
  ipcMain.handle(IPC.setSafeMode, (_e, enabled: boolean, tabId?: string) => {
    const tab = tabs.resolve(tabId)
    if (!tab) return { ok: false, enabled: false }
    tab.safeMode = enabled
    const wc = tab.view.webContents
    if (!wc.isDestroyed()) {
      if (enabled) tab.inspector.setCaptureEnabled(wc, false)
      wc.setUserAgent(enabled ? safeUserAgent : defaultUserAgent)
      wc.reload()
    }
    logger.log('info', 'safeMode.set', { tab: tab.id, enabled })
    void emitTabs()
    return { ok: true, enabled }
  })

  // Clear cookies + localStorage/indexedDB/cache for the current page's origin and
  // reload. Ordinary "clear site data" hygiene — useful when a site's own state
  // (e.g. a bot-detection risk cookie) got stuck in a bad state and needs a clean
  // slate, the same way clearing cookies in any browser would.
  ipcMain.handle(IPC.clearSiteData, async (_e, tabId?: string) => {
    const wc = tabs.resolve(tabId)?.view.webContents
    const url = wc?.getURL()
    if (!wc || !url) return { ok: false }
    const ses = wc.session
    const cookies = await ses.cookies.get({ url })
    await Promise.all(cookies.map((c) => ses.cookies.remove(url, c.name).catch(() => {})))
    await ses.clearStorageData({ origin: new URL(url).origin }).catch(() => {})
    wc.reload()
    logger.log('info', 'clearSiteData', { url })
    return { ok: true }
  })

  // ---- The malleability loop: adapt the CURRENT PAGE ----
  ipcMain.handle(IPC.adaptPrompt, async (_e, sessionId: string, text: string): Promise<AdaptResult> => {
    if (!acp) return { ok: false, error: 'ACP not started' }
    const tab = tabs.active()
    const page = await capturePage(tab)
    if (!page || !tab) return { ok: false, error: 'No page loaded to adapt' }
    const slug = adaptations.slugFor(page.url)
    if (!slug) return { ok: false, error: 'This page has no adaptable origin' }

    // Turn on CDP network/console capture now that the agent is actually about to
    // work on this page (Safe Mode overrides this and keeps it off regardless).
    if (!tab.safeMode) tab.inspector.setCaptureEnabled(tab.view.webContents, true)

    const statusBefore = await checkpoints.status()
    if (sessionId) {
      await sessions.setTitleIfDefault(sessionId, text)
      sendToChrome(EVT.sessions, sessions.list())
    }
    logger.log('info', 'adapt.request', { sessionId, host: slug, url: page.url, request: text })
    // The agent inspects the live page and manages named edits via its MCP tools
    // (save_adaptation etc.), which apply immediately. Main just checkpoints after.
    const prompt = adaptations.buildPrompt({
      url: page.url,
      title: page.title,
      host: slug,
      edits: await adaptations.listForHost(slug),
      request: text,
      persona: await loadPersona(WORKSPACE),
      tabs: tabs.list().map((t) => ({
        id: t.id,
        host: tabs.hostOf(t) ?? '',
        title: t.view.webContents.isDestroyed() ? '' : t.view.webContents.getTitle(),
        active: t.id === tabs.activeId
      })),
      bubbles: await bubbles.bubblesForHost(slug)
    })
    const res = await acp.prompt(sessionId, prompt)

    const treeChanged = (await checkpoints.status()) !== statusBefore
    const checkpoint = treeChanged
      ? ((await checkpoints.commitArtifacts(`${slug}: ${text.slice(0, 60)}`)) ?? undefined)
      : undefined
    void emitTabs()
    logger.log('info', 'adapt.result', { host: slug, ok: !res.error, treeChanged, checkpoint })
    return { ok: !res.error, stopReason: res.stopReason, error: res.error, checkpoint }
  })
  ipcMain.handle(IPC.adaptCancel, async (_e, sessionId: string) => acp?.cancel(sessionId))
  ipcMain.handle(IPC.newSession, async () => (acp ? acp.newSession() : { ok: false }))

  // Ask the agent to manage a saved site's edits from the library (may be off-page).
  ipcMain.handle(
    IPC.adaptHost,
    async (_e, sessionId: string, host: string, text: string): Promise<AdaptResult> => {
      if (!acp) return { ok: false, error: 'ACP not started' }
      // Same lazy capture-on as adaptPrompt — only instrument the page once the
      // agent is actually asked to work on it.
      // Prefer a tab already showing this host over whatever happens to be focused.
      const hostTab = tabs.forHost(host)[0] ?? tabs.active()
      if (hostTab && !hostTab.safeMode) {
        hostTab.inspector.setCaptureEnabled(hostTab.view.webContents, true)
      }
      const statusBefore = await checkpoints.status()
      if (sessionId) {
        await sessions.setTitleIfDefault(sessionId, text)
        sendToChrome(EVT.sessions, sessions.list())
      }
      logger.log('info', 'adapt.host', { sessionId, host, request: text })
      const onCurrent = hostTab ? tabs.hostOf(hostTab) === host : false
      const prompt = adaptations.buildPrompt({
        url: onCurrent && hostTab ? tabs.urlOf(hostTab) : `https://${host}/`,
        title: host,
        host,
        edits: await adaptations.listForHost(host),
        request: text,
        persona: await loadPersona(WORKSPACE),
        live: onCurrent,
        tabs: tabs.list().map((t) => ({
          id: t.id,
          host: tabs.hostOf(t) ?? '',
          title: t.view.webContents.isDestroyed() ? '' : t.view.webContents.getTitle(),
          active: t.id === tabs.activeId
        })),
        bubbles: await bubbles.bubblesForHost(host)
      })
      const res = await acp.prompt(sessionId, prompt)
      const treeChanged = (await checkpoints.status()) !== statusBefore
      const checkpoint = treeChanged
        ? ((await checkpoints.commitArtifacts(`${host}: ${text.slice(0, 60)}`)) ?? undefined)
        : undefined
      void emitTabs()
      logger.log('info', 'adapt.host.result', { host, ok: !res.error, treeChanged, checkpoint })
      return { ok: !res.error, stopReason: res.stopReason, error: res.error, checkpoint }
    }
  )

  // ---- Session switching ----
  // Threads are multiplexed: all sessions stay live at once, so switching is a
  // pure view change in the renderer. We only reach into the agent to resume a
  // session that isn't live yet (e.g. one persisted from a previous run) — and
  // loadSession is a no-op if it already is, so switching mid-turn is safe.
  ipcMain.handle(IPC.listSessions, () => sessions.list())
  ipcMain.handle(IPC.switchSession, async (_e, id: string) => {
    if (!acp) return { ok: false, error: 'ACP not started' }
    const res = acp.isLive(id) ? { ok: true, alreadyLive: true } : await acp.loadSession(id)
    if (res.ok) {
      sessions.setCurrent(id)
      sendToChrome(EVT.sessions, sessions.list())
    }
    return res
  })

  // Takes an explicit host now that "the current page" is ambiguous; the renderer
  // passes the active tab's origin, and omitting it still falls back to that.
  ipcMain.handle(IPC.resetSite, async (_e, host?: string) => {
    const slug = host || (() => {
      const t = tabs.active()
      return t ? tabs.hostOf(t) : null
    })()
    if (!slug) return { ok: false }
    await adaptations.clearHost(slug)
    reapplyForHost(slug)
    void emitTabs()
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
      reapplyForHost(host)
      void emitTabs()
      return meta
    }
  )
  ipcMain.handle(IPC.setEditEnabled, async (_e, host: string, id: string, enabled: boolean) => {
    await adaptations.setEnabled(host, id, enabled)
    reapplyForHost(host)
    void emitTabs()
  })
  ipcMain.handle(IPC.deleteEdit, async (_e, host: string, id: string) => {
    await adaptations.deleteEdit(host, id)
    await bubbles.forgetEdit(host, id)
    await refreshBubbles()
    reapplyForHost(host)
    void emitTabs()
  })
  ipcMain.handle(IPC.publishHost, async (_e, host: string) => {
    try {
      const result = await publishHostAsExtension(adaptations, WORKSPACE, host)
      if (result.ok && result.zipPath) shell.showItemInFolder(result.zipPath)
      return result
    } catch (err) {
      logger.log('error', 'publish.extension.error', { host, err: String((err as any)?.message ?? err) })
      throw err
    }
  })
  ipcMain.handle(IPC.publishBubble, async (_e, id: string) => {
    try {
      const result = await publishBubbleAsExtension(adaptations, bubbles, WORKSPACE, id)
      if (result.ok && result.zipPath) shell.showItemInFolder(result.zipPath)
      return result
    } catch (err) {
      logger.log('error', 'publish.bubble.error', { id, err: String((err as any)?.message ?? err) })
      throw err
    }
  })
  ipcMain.handle(IPC.publishUserscript, async (_e, host: string) => {
    try {
      const result = await publishHostAsUserscript(adaptations, WORKSPACE, host, bubbles)
      if (result.ok && result.filePath) shell.showItemInFolder(result.filePath)
      return result
    } catch (err) {
      logger.log('error', 'publish.userscript.error', { host, err: String((err as any)?.message ?? err) })
      throw err
    }
  })
  ipcMain.handle(IPC.openInTampermonkey, async (_e, host: string) => {
    try {
      const result = await publishHostAsUserscript(adaptations, WORKSPACE, host, bubbles)
      if (!result.ok || !result.filePath) return result
      // Reveal the file so it's ready to drag onto Tampermonkey's dashboard tab
      // (its own supported install method — doesn't trip Chrome's "apps,
      // extensions, and user scripts can't be added from this website" block,
      // since the drop target is the extension's own already-trusted UI).
      shell.showItemInFolder(result.filePath)
      // Best-effort: chrome-extension:// isn't a registered OS protocol, so
      // this may not resolve on every platform/setup — it's a bonus, not the
      // primary path, so failures are swallowed.
      shell
        .openExternal(`chrome-extension://${TAMPERMONKEY_ID}/options.html#nav=utils`)
        .catch((err) => {
          logger.log('warn', 'publish.tampermonkey.openExternal.error', { host, err: String(err) })
        })
      return result
    } catch (err) {
      logger.log('error', 'publish.tampermonkey.error', { host, err: String((err as any)?.message ?? err) })
      throw err
    }
  })

  // ---- Bubbles ----
  ipcMain.handle(IPC.listBubbles, () => bubbles.list())
  ipcMain.handle(
    IPC.saveBubble,
    async (_e, input: { id?: string; name: string; hosts: string[] }) => {
      const b = await saveBubbleWithConsent(input)
      return b ? { ok: true, bubble: b } : { ok: false, error: 'Declined' }
    }
  )
  ipcMain.handle(IPC.deleteBubble, async (_e, id: string) => {
    const b = await bubbles.get(id)
    await bubbles.remove(id)
    await refreshBubbles()
    for (const h of b?.hosts ?? []) reapplyForHost(h)
    logger.log('info', 'bubble.delete', { id })
    return { ok: true }
  })
  // Move one edit into a bubble, or out of every bubble when bubbleId is null.
  ipcMain.handle(
    IPC.setEditBubble,
    async (_e, host: string, editId: string, bubbleId: string | null) => {
      await bubbles.forgetEdit(host, editId)
      if (bubbleId) await bubbles.addEdit(bubbleId, { host, editId })
      await refreshBubbles()
      reapplyForHost(host)
      return { ok: true }
    }
  )
  // One action drives every destination in the bubble. No cross-tab code
  // execution: main writes a push request, each destination's own edit answers.
  ipcMain.handle(
    IPC.pushBubble,
    async (_e, id: string, opts?: { sourceHost?: string; hidden?: boolean }) => {
      const bubble = await bubbles.get(id)
      if (!bubble) return { ok: false, error: 'No such bubble', results: [] }
      if (!bubbleServer) return { ok: false, error: 'Bubble server not running', results: [] }
      return pushBubble(bubble, opts ?? {}, {
        setState: (b, k, v) => bubbleServer!.setState(b, k, v),
        getState: (b, k) => bubbleServer!.getState(b, k),
        ensureTab: ensureTabForHost,
        closeTab: (tabId) => void tabs.close(tabId),
        log: (l, ev, d) => logger.log(l, ev, d)
      })
    }
  )
  ipcMain.handle(IPC.bubbleConsentResponse, (_e, requestId: string, allow: boolean) => {
    pendingConsents.get(requestId)?.(allow)
    pendingConsents.delete(requestId)
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
    onUpdate: (sessionId, u) => sendToChrome(EVT.adaptUpdate, { sessionId, update: u }),
    onStatus: (s) => sendToChrome(EVT.acpStatus, s),
    onConfig: (c) => sendToChrome(EVT.agentConfig, c),
    onActivity: (sessionId, a) => sendToChrome(EVT.activity, { sessionId, activity: a }),
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
      resolveInspector: (ref) => tabs.resolve(ref)?.inspector,
      workspace: WORKSPACE,
      adaptations,
      currentUrl: (ref) => {
        const t = tabs.resolve(ref)
        return t ? tabs.urlOf(t) : ''
      },
      listTabs: () => tabs.list().map((t) => ({ id: t.id, url: tabs.urlOf(t), title: t.view.webContents.isDestroyed() ? '' : t.view.webContents.getTitle(), host: tabs.hostOf(t) ?? '', hidden: t.hidden, active: t.id === tabs.activeId })),
      openTab: (url, opts) => tabs.create({ url, background: opts?.background, hidden: opts?.hidden }).id,
      closeTab: (ref) => { const t = tabs.resolve(ref); return t ? tabs.close(t.id) : false },
      focusTab: (ref) => { const t = tabs.resolve(ref); return t ? tabs.focus(t.id) : false },
      reloadCurrent,
      reloadHost,
      bubbles,
      saveBubble: async (input) => {
        try {
          const b = await saveBubbleWithConsent(input)
          if (!b) return { ok: false as const, error: 'the user declined' }
          return { ok: true as const, id: b.id }
        } catch (err) {
          return { ok: false as const, error: String((err as Error)?.message ?? err) }
        }
      },
      pushBubble: async (id, opts) => {
        const b = await bubbles.get(id)
        if (!b) return { ok: false, error: 'No such bubble', results: [] }
        if (!bubbleServer) return { ok: false, error: 'Bubble server not running', results: [] }
        return pushBubble(b, opts, {
          setState: (bid, k, v) => bubbleServer!.setState(bid, k, v),
          getState: (bid, k) => bubbleServer!.getState(bid, k),
          ensureTab: ensureTabForHost,
          closeTab: (tabId) => void tabs.close(tabId),
          log: (l, ev, d) => logger.log(l, ev, d)
        })
      },
      setEditBubble: async (host, editId, bubbleId) => {
        await bubbles.forgetEdit(host, editId)
        if (bubbleId) await bubbles.addEdit(bubbleId, { host, editId })
        await refreshBubbles()
      },
      log: (l, e, d) => logger.log(l, e, d)
    })
  } catch (err) {
    logger.log('error', 'mcp.server.failed', String((err as any)?.message ?? err))
  }
  // The bubble server: the localhost endpoint bubble-member edits talk to with
  // plain fetch/EventSource. Deliberately NOT a preload — page JS already has a
  // channel to localhost, so this adds no reach from a page toward Node.
  try {
    bubbleServer = await startBubbleServer({
      workspace: WORKSPACE,
      bubbles,
      // Only tabs whose host is in the bubble are ever revealed to a member.
      listBubbleTabs: (hosts) =>
        tabs
          .list()
          .filter((t) => hosts.includes(tabs.hostOf(t) ?? ''))
          .map((t) => ({
            id: t.id,
            host: tabs.hostOf(t) ?? '',
            title: t.view.webContents.isDestroyed() ? '' : t.view.webContents.getTitle(),
            hidden: t.hidden,
            active: t.id === tabs.activeId
          })),
      ensureTab: (host) => ensureTabForHost(host, false),
      log: (l, e, d) => logger.log(l, e, d)
    })
    await refreshBubbles()
    // Locked-down portals often send `connect-src 'self'`, which would refuse the
    // bubble server outright. Widen that ONE directive, for bubble hosts only.
    installCspRelaxation({
      session: session.defaultSession,
      endpoint: bubbleServer.url,
      isBubbleHost: (h) => bubbleHosts.has(h),
      log: (l, e, d) => logger.log(l, e, d)
    })
    await fsp.mkdir(join(WORKSPACE, '.malleable'), { recursive: true })
    await fsp.writeFile(
      join(WORKSPACE, '.malleable', 'bubbles.json'),
      JSON.stringify(
        {
          endpoint: bubbleServer.url,
          token: bubbleServer.token,
          note:
            'Bubble server for cross-site edits. Authorization is the Origin header ' +
            '(browser-set, unforgeable from page JS): a request is served only if its ' +
            "origin's host is a member of the bubble it names, so bubble membership IS " +
            'the CORS allowlist. The bearer token additionally keeps non-browser local ' +
            'processes out. GET /state?bubble=<id> · PUT /state?bubble=<id>&key=<k> · ' +
            'POST /publish?bubble=<id>&ch=<c> · GET /watch?bubble=<id>&token=<t> (SSE). ' +
            'State persists in .malleable/surface/<bubbleId>.json. Membership lives in ' +
            'bubbles/<id>.json — a host may be in many bubbles, an edit in exactly one.'
        },
        null,
        2
      ),
      'utf8'
    )
  } catch (err) {
    logger.log('error', 'bubble.server.failed', String((err as any)?.message ?? err))
  }

  // Raw CDP escape hatch for automation beyond the built-in MCP tools — see
  // cdp-bridge.ts. Published as a plain workspace fact, not a tool call.
  try {
    cdpBridge = await startCdpBridge((ref) => {
      const t = tabs.resolve(ref)
      const wc = t?.view.webContents
      return t && wc && !wc.isDestroyed() ? { id: t.id, wc } : undefined
    })
    await fsp.mkdir(join(WORKSPACE, '.malleable'), { recursive: true })
    await fsp.writeFile(
      join(WORKSPACE, '.malleable', 'cdp.json'),
      JSON.stringify(
        {
          wsUrl: cdpBridge.url,
          allowedDomains: cdpBridge.allowedDomains,
          note:
            'Raw CDP relay for content tabs. Append &tab=<tabId|host> to pin a connection to one tab ' +
            '(omitted = the active tab); the choice is made at connect time and cannot be changed in-band, ' +
            'so a session still cannot pivot — Target/Browser are rejected, as are Storage/Emulation/' +
            'Security/Fetch. Events carry a tabId field. Use list_tabs to see what is open. Connect with ' +
            'any CDP-speaking approach (a small ws + JSON-RPC script, chrome-remote-interface in ' +
            'target-scoped mode) for automation the built-in MCP tools (dom_query, run_js, ...) do not ' +
            'cover. See live/<host>/{network,console}.jsonl for grep/tail-able page history.'
        },
        null,
        2
      ),
      'utf8'
    )
  } catch (err) {
    logger.log('error', 'cdp.bridge.failed', String((err as any)?.message ?? err))
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
  cdpBridge?.close()
  bubbleServer?.close()
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
