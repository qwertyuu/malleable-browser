import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { EditMeta, EditSummary, HostAdaptations, EditContent } from '../shared/ipc.js'

/**
 * Per-site content adaptations, as a LIBRARY of independently-toggleable named
 * edits. Each host can have many edits (a theme, an ad-cleanup, an API harness…),
 * each enabled/disabled on its own. The browser injects all enabled edits for the
 * current origin on every visit; the *page* is what's malleable, never the chrome.
 *
 *   adaptations/<host>/<editId>/meta.json   { id, name, kind, enabled, ... }
 *   adaptations/<host>/<editId>/overlay.css
 *   adaptations/<host>/<editId>/overlay.js
 */
export class Adaptations {
  private readonly root: string

  constructor(projectRoot: string) {
    this.root = join(projectRoot, 'adaptations')
  }

  /** Stable, human-readable folder name for a page's origin (its hostname). */
  slugFor(url: string): string | null {
    try {
      const host = new URL(url).hostname
      return host ? host.replace(/[^a-zA-Z0-9.-]/g, '-') : null
    } catch {
      return null
    }
  }

  private hostDir(host: string): string {
    return join(this.root, host)
  }
  private editDir(host: string, id: string): string {
    return join(this.hostDir(host), id)
  }
  idFor(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    return slug || 'edit'
  }
  relDirForEdit(host: string, id: string): string {
    return `adaptations/${host}/${id}`
  }

  /** One-time migration of the old single-overlay layout into an "imported" edit. */
  async migrate(): Promise<void> {
    let hosts: string[]
    try {
      hosts = (await fs.readdir(this.root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return
    }
    for (const host of hosts) {
      const looseCss = join(this.hostDir(host), 'overlay.css')
      const looseJs = join(this.hostDir(host), 'overlay.js')
      const css = await fs.readFile(looseCss, 'utf8').catch(() => null)
      const js = await fs.readFile(looseJs, 'utf8').catch(() => null)
      if (css == null && js == null) continue
      await this.saveEdit(host, { name: 'Imported', kind: 'other', css: css ?? '', js: js ?? '' })
      await fs.rm(looseCss, { force: true })
      await fs.rm(looseJs, { force: true })
    }
  }

  private async readMeta(host: string, id: string): Promise<EditMeta | null> {
    try {
      const m = JSON.parse(await fs.readFile(join(this.editDir(host, id), 'meta.json'), 'utf8'))
      return { enabled: true, kind: 'other', ...m, id }
    } catch {
      return null
    }
  }

  private async readFiles(host: string, id: string): Promise<{ css: string; js: string }> {
    const dir = this.editDir(host, id)
    const css = await fs.readFile(join(dir, 'overlay.css'), 'utf8').catch(() => '')
    const js = await fs.readFile(join(dir, 'overlay.js'), 'utf8').catch(() => '')
    return { css, js }
  }

  /** Edit metadata for one host (sorted oldest first). */
  async listForHost(host: string): Promise<EditSummary[]> {
    let ids: string[]
    try {
      ids = (await fs.readdir(this.hostDir(host), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return []
    }
    const out: EditSummary[] = []
    for (const id of ids) {
      const meta = await this.readMeta(host, id)
      if (!meta) continue
      const { css, js } = await this.readFiles(host, id)
      out.push({
        ...meta,
        hasCss: css.trim().length > 0,
        hasJs: js.trim().length > 0,
        bytes: Buffer.byteLength(css) + Buffer.byteLength(js)
      })
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** The whole library, grouped by host. */
  async listAll(): Promise<HostAdaptations[]> {
    let hosts: string[]
    try {
      hosts = (await fs.readdir(this.root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return []
    }
    const out: HostAdaptations[] = []
    for (const host of hosts.sort()) {
      const edits = await this.listForHost(host)
      if (edits.length) out.push({ host, edits })
    }
    return out
  }

  async getEdit(host: string, id: string): Promise<EditContent | null> {
    const meta = await this.readMeta(host, id)
    if (!meta) return null
    const { css, js } = await this.readFiles(host, id)
    return { host, css, js, ...meta }
  }

  /** Create or update a named edit. If `id` is omitted, derives one from the name. */
  async saveEdit(
    host: string,
    edit: { id?: string; name: string; kind?: string; css?: string; js?: string; enabled?: boolean }
  ): Promise<EditMeta> {
    const id = edit.id ?? this.idFor(edit.name)
    const dir = this.editDir(host, id)
    await fs.mkdir(dir, { recursive: true })
    const existing = await this.readMeta(host, id)
    const now = Date.now()
    const meta: EditMeta = {
      id,
      name: edit.name,
      kind: edit.kind ?? existing?.kind ?? 'other',
      enabled: edit.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    await fs.writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
    if (edit.css != null) await fs.writeFile(join(dir, 'overlay.css'), edit.css, 'utf8')
    if (edit.js != null) await fs.writeFile(join(dir, 'overlay.js'), edit.js, 'utf8')
    return meta
  }

  async setEnabled(host: string, id: string, enabled: boolean): Promise<void> {
    const meta = await this.readMeta(host, id)
    if (!meta) return
    await fs.writeFile(
      join(this.editDir(host, id), 'meta.json'),
      JSON.stringify({ ...meta, enabled, updatedAt: Date.now() }, null, 2),
      'utf8'
    )
  }

  async deleteEdit(host: string, id: string): Promise<void> {
    await fs.rm(this.editDir(host, id), { recursive: true, force: true })
  }

  /** Remove ALL edits for a host (reset site). */
  async clearHost(host: string): Promise<void> {
    await fs.rm(this.hostDir(host), { recursive: true, force: true })
  }

  /** Does this host have at least one enabled edit with content? (nav badge) */
  async hasEnabled(host: string): Promise<boolean> {
    for (const e of await this.listForHost(host)) {
      if (e.enabled && (e.hasCss || e.hasJs)) return true
    }
    return false
  }

  /** Inject every enabled edit for `url`'s origin into a live page. */
  async apply(wc: WebContents, url: string): Promise<void> {
    const host = this.slugFor(url)
    if (!host) return
    for (const e of await this.listForHost(host)) {
      if (!e.enabled) continue
      const { css, js } = await this.readFiles(host, e.id)
      if (css.trim()) await wc.insertCSS(css).catch(() => {})
      if (js.trim()) {
        const wrapped = `(function(){try{\n${js}\n}catch(e){console.error('[malleable ${e.id}]', e)}})()`
        await wc.executeJavaScript(wrapped, true).catch(() => {})
      }
    }
  }

  /** Build the prompt that steers Claude to manage this site's edit library. */
  buildPrompt(args: {
    url: string
    title: string
    host: string
    edits: EditSummary[]
    request: string
    /** Persona/aura prepended to color the agent's voice. */
    persona?: string
    /** Whether the target host is the page currently on screen. */
    live?: boolean
  }): string {
    const existing = args.edits.length
      ? args.edits
          .map((e) => `  - ${e.id} · "${e.name}" [${e.kind}] ${e.enabled ? '(on)' : '(off)'}`)
          .join('\n')
      : '  (none yet)'
    return [
      ...(args.persona ? [args.persona, '', '— — —', ''] : []),
      'You are the page-adaptation engine for a "malleable browser". The user is',
      'viewing a web page and wants to change how it LOOKS or BEHAVES. You adapt the',
      'PAGE — never the browser\'s own source code.',
      '',
      'A site can have MANY independent named edits (a theme, an ad-cleanup, an API',
      'harness…), each toggled on/off separately. Manage them with your MCP tools:',
      '  save_adaptation({ name, kind, css?, js?, id? }) — create OR update an edit',
      '     (kind: theme | layout | functionality | cleanup | other). Omit id to',
      '     create; pass an existing id to update. Applies immediately so you can',
      '     screenshot to verify.',
      '  list_adaptations() / get_adaptation({id}) / set_adaptation_enabled({id,enabled})',
      '     / delete_adaptation({id}) — browse and manage the library.',
      '',
      'Give each edit a SHORT, clear name and the right kind. Keep separate concerns',
      'in separate edits (e.g. one "Dark theme" [theme] and one "Hide ads" [cleanup])',
      'rather than one giant edit — the user toggles them individually.',
      '',
      args.live === false
        ? `NOTE: "${args.host}" is NOT the page currently on screen. Pass host:"${args.host}" to the adaptation tools. Live page tools reflect the current page, which may differ — prefer editing existing edits by id.`
        : 'Inspect the LIVE page first with dom_query / run_js / screenshot / get_console / get_network (no HTML is included here). Verify selectors against the real DOM and screenshot after saving to confirm. CSS for looks; JS only for behavior; keep overlay JS idempotent.',
      '',
      `Current page: ${args.title} — ${args.url}`,
      `Host: ${args.host}`,
      'Existing edits for this host:',
      existing,
      '',
      `User request: ${args.request}`
    ].join('\n')
  }
}
