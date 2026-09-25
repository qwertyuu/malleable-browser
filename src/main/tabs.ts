import { BrowserWindow, WebContentsView } from 'electron'
import { PageInspector } from './page-inspector.js'
import type { Rect } from '../shared/ipc.js'

/**
 * One browser tab: a sandboxed WebContentsView plus its OWN PageInspector.
 *
 * The inspector is per-tab rather than shared because its console/network ring
 * buffers and its `pending` map (keyed by bare CDP requestId) would otherwise
 * collide the moment a second view attached a debugger session.
 */
export interface TabRecord {
  readonly id: string
  readonly view: WebContentsView
  readonly inspector: PageInspector
  /** Worker tabs are never attached to the window — they render off-screen. */
  readonly hidden: boolean
  /** Safe Mode is per-tab: one bank tab shouldn't de-fingerprint every other page. */
  safeMode: boolean
  readonly createdAt: number
}

export interface TabHooks {
  /** Nav state for this tab changed (url/title/loading/history). */
  onNav: (tab: TabRecord) => void
  /** Page hit dom-ready — the injector's cue. */
  onDomReady: (tab: TabRecord) => void
  /** The set of tabs or the active tab changed. */
  onTabsChanged: () => void
}

export interface TabManagerDeps {
  workspace: string
  /** Mirrors Adaptations.slugFor — kept as a dep so this file stays storage-free. */
  slugFor: (url: string) => string | null
  defaultUrl: string
  hooks: TabHooks
}

/** Viewport given to hidden worker tabs, which get no bounds from the renderer. */
const HIDDEN_BOUNDS: Rect = { x: 0, y: 0, width: 1280, height: 900 }

export class TabManager {
  private readonly tabs = new Map<string, TabRecord>()

  private win: BrowserWindow | null = null
  private activeIdValue: string | null = null
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private counter = 0
  /** A chrome modal is up: the page view would paint over it, so hide it. */
  private obscured = false

  constructor(private readonly deps: TabManagerDeps) {}

  attachWindow(win: BrowserWindow): void {
    this.win = win
  }

  get activeId(): string | null {
    return this.activeIdValue
  }

  active(): TabRecord | undefined {
    return this.activeIdValue ? this.tabs.get(this.activeIdValue) : undefined
  }

  get(id: string): TabRecord | undefined {
    return this.tabs.get(id)
  }

  /** Insertion-ordered, which is also the order the tab strip renders. */
  list(): TabRecord[] {
    return [...this.tabs.values()]
  }

  /** Visible tabs only — what the strip shows and what bounds apply to. */
  visible(): TabRecord[] {
    return this.list().filter((t) => !t.hidden)
  }

  urlOf(tab: TabRecord): string {
    if (tab.view.webContents.isDestroyed()) return ''
    return tab.view.webContents.getURL()
  }

  hostOf(tab: TabRecord): string | null {
    return this.deps.slugFor(this.urlOf(tab))
  }

  /** Every tab currently showing the given host slug. */
  forHost(host: string): TabRecord[] {
    return this.list().filter((t) => this.hostOf(t) === host)
  }

  /**
   * Resolve an agent-supplied tab reference. The agent thinks in hosts, not ids,
   * so accept either: an exact tab id, then a host match, then a URL substring.
   * Undefined/blank means the active tab, which keeps every existing call site
   * working unchanged.
   */
  resolve(ref?: string): TabRecord | undefined {
    const s = (ref ?? '').trim()
    if (!s) return this.active()
    const byId = this.tabs.get(s)
    if (byId) return byId
    const needle = s.toLowerCase()
    const tabs = this.list()
    return (
      tabs.find((t) => (this.hostOf(t) ?? '').toLowerCase() === needle) ??
      tabs.find((t) => (this.hostOf(t) ?? '').toLowerCase().includes(needle)) ??
      tabs.find((t) => this.urlOf(t).toLowerCase().includes(needle)) ??
      tabs.find((t) => t.view.webContents.getTitle().toLowerCase().includes(needle))
    )
  }

  create(opts: { url?: string; background?: boolean; hidden?: boolean } = {}): TabRecord {
    const hidden = opts.hidden === true
    const id = `t${++this.counter}`

    // Sandboxed view for arbitrary/untrusted web content: no Node access, so the
    // agent's file/terminal power (main process only) is unreachable from pages.
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })

    const rec: TabRecord = {
      id,
      view,
      inspector: new PageInspector(
        () => (view.webContents.isDestroyed() ? undefined : view.webContents),
        () => (view.webContents.isDestroyed() ? null : this.deps.slugFor(view.webContents.getURL())),
        this.deps.workspace
      ),
      hidden,
      safeMode: false,
      createdAt: Date.now()
    }
    this.tabs.set(id, rec)

    const wc = view.webContents
    const nav = (): void => this.deps.hooks.onNav(rec)
    wc.on('did-navigate', nav)
    wc.on('did-navigate-in-page', nav)
    wc.on('did-start-loading', nav)
    wc.on('did-stop-loading', nav)
    wc.on('page-title-updated', nav)
    wc.on('dom-ready', () => this.deps.hooks.onDomReady(rec))

    rec.inspector.attach(wc)

    // target=_blank / window.open becomes a real tab now that we have them.
    wc.setWindowOpenHandler(({ url }) => {
      this.create({ url, background: true })
      return { action: 'deny' }
    })

    if (hidden) {
      view.setBounds(HIDDEN_BOUNDS)
      view.setVisible(false)
    } else {
      this.win?.contentView.addChildView(view)
      if (!this.activeIdValue || opts.background !== true) this.activeIdValue = id
      this.applyLayout()
    }

    wc.loadURL(opts.url ?? this.deps.defaultUrl).catch(() => {})
    this.deps.hooks.onTabsChanged()
    return rec
  }

  focus(id: string): boolean {
    const rec = this.tabs.get(id)
    if (!rec || rec.hidden) return false
    if (this.activeIdValue === id) return true
    this.activeIdValue = id
    this.applyLayout()
    this.deps.hooks.onTabsChanged()
    return true
  }

  close(id: string): boolean {
    const rec = this.tabs.get(id)
    if (!rec) return false
    const order = this.visible().map((t) => t.id)
    const wasActive = this.activeIdValue === id

    this.tabs.delete(id)
    this.detach(rec)
    if (!rec.view.webContents.isDestroyed()) rec.view.webContents.close()

    if (wasActive) {
      // Prefer the tab to the right, then the left — standard browser behaviour.
      const i = order.indexOf(id)
      const next = order[i + 1] ?? order[i - 1] ?? null
      this.activeIdValue = next
    }
    // Never leave the window with an empty content area.
    if (this.visible().length === 0) {
      this.create({})
      return true
    }
    this.applyLayout()
    this.deps.hooks.onTabsChanged()
    return true
  }

  setBounds(r: Rect): void {
    this.bounds = {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.max(0, Math.round(r.width)),
      height: Math.max(0, Math.round(r.height))
    }
    this.applyLayout()
  }

  setObscured(obscured: boolean): void {
    if (this.obscured === obscured) return
    this.obscured = obscured
    this.applyLayout()
  }

  /**
   * All visible tabs stay attached and share the content rect; switching is a
   * visibility toggle (Electron 43 View.setVisible) rather than attach/detach
   * churn, so a background tab keeps its layout and repaints instantly on focus.
   */
  private applyLayout(): void {
    for (const t of this.tabs.values()) {
      if (t.hidden) continue
      t.view.setBounds(this.bounds)
      t.view.setVisible(!this.obscured && t.id === this.activeIdValue)
    }
  }

  destroyAll(): void {
    for (const t of this.tabs.values()) {
      this.detach(t)
      if (!t.view.webContents.isDestroyed()) t.view.webContents.close()
    }
    this.tabs.clear()
    this.activeIdValue = null
    // Called from win.on('closed'), so the window is already gone by definition.
    this.win = null
  }

  /** Detach from the window, tolerating a window that's already been destroyed. */
  private detach(rec: TabRecord): void {
    if (rec.hidden || !this.win) return
    try {
      this.win.contentView.removeChildView(rec.view)
    } catch {
      // Window torn down first — nothing left to detach from.
    }
  }
}
