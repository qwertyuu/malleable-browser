import { createServer, type IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { PageInspector } from './page-inspector.js'
import type { Adaptations } from './adaptations.js'
import type { Bubbles } from './bubbles.js'
import { DynamicTools, type DynamicToolDef, type ParamSpec } from './dynamic-tools.js'

type Log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, data?: unknown) => void

/** One open tab, as the agent sees it via list_tabs. */
export interface TabSummary {
  id: string
  url: string
  title: string
  host: string
  hidden: boolean
  active: boolean
}

export interface PageToolsDeps {
  workspace: string
  adaptations: Adaptations
  /**
   * Resolve a tab reference to its inspector. `ref` is a tab id, a host, or a
   * URL/title substring; undefined means the active tab. Every live page tool
   * goes through this, which is what makes them tab-addressable.
   */
  resolveInspector: (ref?: string) => PageInspector | undefined
  /** URL of a tab (default: the active one), for host resolution. */
  currentUrl: (ref?: string) => string
  /** Reload a tab and wait for load (so injected edits are visible). */
  reloadCurrent: (ref?: string) => Promise<void>
  /** Reload every tab showing this host and wait — after an edit changes. */
  reloadHost: (host: string) => Promise<void>
  bubbles: Bubbles
  /**
   * Create/extend a bubble. Resolves false if the user declined the consent
   * prompt, which is the ONE gate in the bubble model.
   */
  saveBubble: (input: { id?: string; name: string; hosts: string[] }) => Promise<
    { ok: true; id: string } | { ok: false; error: string }
  >
  /** Move an edit into a bubble, or out of all of them when null. */
  setEditBubble: (host: string, editId: string, bubbleId: string | null) => Promise<void>
  /** Drive every destination in a bubble from one action. */
  pushBubble: (
    id: string,
    opts: { sourceHost?: string; hidden?: boolean }
  ) => Promise<unknown>
  listTabs: () => TabSummary[]
  openTab: (url: string, opts?: { background?: boolean; hidden?: boolean }) => string
  closeTab: (ref?: string) => boolean
  focusTab: (ref?: string) => boolean
  log: Log
}

export interface PageToolsHandle {
  url: string
  token: string
  close: () => void
  /** Re-scope site tools on all live sessions when the page host changes. */
  syncSiteTools: (host: string | null) => void
  /** Re-sync all tools with disk on all live sessions (after library edits). */
  refreshTools: () => void
}

const jsonResult = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }]
})

/**
 * Register one agent-authored tool (runs as page-JS) on a live server.
 *
 * Every dynamic tool gets a reserved `tab` param (unless the author already
 * declared one). A site-scoped tool defaults to a tab showing ITS host rather
 * than whatever is focused — it was scaffolded as a harness for that site, so
 * running it against an unrelated page would just fail confusingly.
 */
function registerDynamic(
  server: McpServer,
  def: DynamicToolDef,
  resolveInspector: (ref?: string) => PageInspector | undefined,
  log: Log
): RegisteredTool {
  const shape = DynamicTools.toZodShape(def.inputSchema)
  if (!('tab' in shape)) {
    shape.tab = z.string().optional().describe('tab id or host (default: this tool\'s site, else active tab)')
  }
  return server.registerTool(
    def.name,
    { description: def.description, inputSchema: shape },
    async (args: Record<string, unknown>) => {
      const { tab, ...rest } = args as { tab?: string } & Record<string, unknown>
      log('info', 'tool.dynamic', { name: def.name, tab, args: rest })
      const ref = tab ?? (def.scope === 'site' ? def.host : undefined)
      const inspector = resolveInspector(ref) ?? resolveInspector()
      if (!inspector) throw new Error('No tab available to run this tool in')
      return jsonResult(await inspector.runJsWithArgs(def.code, rest))
    }
  )
}

/**
 * Build a fresh MCP server: static page tools, the meta-tools that let the agent
 * scaffold new tools at runtime, and any dynamic tools already on disk.
 */
interface BuiltServer {
  server: McpServer
  /** Re-sync the site-scoped tools to a given host (called on navigation). */
  reconcile: (host: string | null) => Promise<void>
  /** Re-sync both global and site tools with disk (after library edits). */
  reloadAll: () => Promise<void>
}

async function buildServer(deps: PageToolsDeps, dynamic: DynamicTools): Promise<BuiltServer> {
  const { adaptations, resolveInspector, currentUrl, reloadCurrent, reloadHost, log } = deps
  const { listTabs, openTab, closeTab, focusTab } = deps
  const { bubbles, saveBubble, setEditBubble, pushBubble } = deps
  const server = new McpServer({ name: 'malleable-page', version: '0.1.0' })
  // name -> live registration. Global tools are always present; site tools track
  // the current host and are swapped as you navigate.
  const registered = new Map<string, RegisteredTool>()
  const siteRegistered = new Map<string, RegisteredTool>()
  let currentSiteHost: string | null = null

  /**
   * The inspector for a tab reference, or a clear error. `tab` is optional on
   * every live page tool, so the default (active tab) preserves the pre-tabs
   * behaviour of every existing call.
   */
  const insp = (tab?: string): PageInspector => {
    const i = resolveInspector(tab)
    if (!i) throw new Error(tab ? `No tab matches "${tab}" — use list_tabs to see what's open` : 'No page loaded')
    return i
  }

  const hostNow = (): string | null => adaptations.slugFor(currentUrl())

  // Resolve the target host for an adaptation tool (defaults to current page).
  const resolveHost = (host?: string): string => {
    const h = host ?? hostNow()
    if (!h) throw new Error('No host: load a page or pass an explicit host')
    return h
  }

  // Swap the site-scoped tool set to `host`, firing tools/list_changed if it changed.
  const reconcileSiteTools = async (host: string | null): Promise<void> => {
    const before = new Set(siteRegistered.keys())
    for (const t of siteRegistered.values()) t.remove()
    siteRegistered.clear()
    if (host) {
      for (const def of await dynamic.listSite(host)) {
        try {
          siteRegistered.set(def.name, registerDynamic(server, def, resolveInspector, log))
        } catch (err) {
          log('warn', 'tool.load.error', { name: def.name, err: String((err as any)?.message ?? err) })
        }
      }
    }
    currentSiteHost = host
    const after = new Set(siteRegistered.keys())
    const changed = before.size !== after.size || [...after].some((n) => !before.has(n))
    if (changed) server.sendToolListChanged()
  }

  // Re-sync global tools with disk (add new, drop deleted). Used after library edits.
  const reconcileGlobalTools = async (): Promise<void> => {
    const disk = new Map((await dynamic.listGlobal()).map((d) => [d.name, d]))
    let changed = false
    for (const [name, t] of registered) {
      if (!disk.has(name)) {
        t.remove()
        registered.delete(name)
        changed = true
      }
    }
    for (const [name, def] of disk) {
      if (!registered.has(name)) {
        registered.set(name, registerDynamic(server, def, resolveInspector, log))
        changed = true
      }
    }
    if (changed) server.sendToolListChanged()
  }

  const reloadAll = async (): Promise<void> => {
    await reconcileGlobalTools()
    await reconcileSiteTools(hostNow())
  }

  // ---- Static page tools ----
  server.registerTool(
    'dom_query',
    {
      description: 'Query the live page DOM by CSS selector.',
      inputSchema: {
        selector: z.string(),
        all: z.boolean().optional(),
        limit: z.number().optional(),
        tab: z.string().optional().describe('tab id or host (default: the active tab)')
      }
    },
    async ({ selector, all, limit, tab }) =>
      jsonResult(await insp(tab).domQuery(selector, all ?? false, limit ?? 10))
  )
  server.registerTool(
    'run_js',
    {
      description: 'Run JS in the live page and return the result (use `return`).',
      inputSchema: {
        code: z.string(),
        tab: z.string().optional().describe('tab id or host (default: the active tab)')
      }
    },
    async ({ code, tab }) => jsonResult(await insp(tab).runJs(code))
  )
  server.registerTool(
    'get_console',
    {
      description: 'Recent page console messages.',
      inputSchema: {
        limit: z.number().optional(),
        tab: z.string().optional().describe('tab id or host (default: the active tab)')
      }
    },
    async ({ limit, tab }) => jsonResult(insp(tab).getConsole(limit ?? 50))
  )
  server.registerTool(
    'get_network',
    {
      description:
        'Recent page network requests, with full headers/bodies/timing (persists across reloads). ' +
        'Filter to cut through noisy hosts: urlContains matches the URL substring (case-insensitive), ' +
        'type matches the resource type (e.g. XHR, Fetch, Document, Script, Image), method matches the ' +
        'HTTP verb, status matches the exact response status code.',
      inputSchema: {
        limit: z.number().optional(),
        urlContains: z.string().optional(),
        type: z.string().optional(),
        method: z.string().optional(),
        status: z.number().optional(),
        tab: z.string().optional().describe('tab id or host (default: the active tab)')
      }
    },
    async ({ limit, urlContains, type, method, status, tab }) =>
      jsonResult(insp(tab).getNetwork(limit ?? 50, { urlContains, type, method, status }))
  )
  server.registerTool(
    'screenshot',
    {
      description:
        'PNG screenshot of the page so you can SEE it. Most reliable on the focused ' +
        'tab: a background tab may not be producing frames, so if the image comes ' +
        'back blank, focus_tab first and retry.',
      inputSchema: {
        tab: z.string().optional().describe('tab id or host (default: the active tab)')
      }
    },
    async ({ tab }) => ({
      content: [{ type: 'image' as const, data: await insp(tab).screenshot(), mimeType: 'image/png' }]
    })
  )
  server.registerTool(
    'fetch_image',
    { description: 'Download an image by URL and view it (multimodal).', inputSchema: { url: z.string() } },
    async ({ url }) => {
      try {
        const { data, mimeType } = await insp().fetchImage(url)
        return { content: [{ type: 'image' as const, data, mimeType }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text' as const, text: String((err as any)?.message ?? err) }] }
      }
    }
  )

  // ---- Tabs ----
  // Everything above takes an optional `tab`; these let the agent see and shape
  // what there is to target. Refs are resolved leniently (id, host, substring),
  // because the agent reasons about sites, not ids.
  server.registerTool(
    'list_tabs',
    {
      description:
        'List open tabs (id, url, title, host, which is active). Every page tool takes a `tab` ref ' +
        'matching a tab id or host, so start here when working across sites.',
      inputSchema: {}
    },
    async () => jsonResult(listTabs())
  )
  server.registerTool(
    'open_tab',
    {
      description: 'Open a URL in a new tab and return its tab id.',
      inputSchema: {
        url: z.string(),
        background: z.boolean().optional().describe('open without stealing focus (default: false)')
      }
    },
    async ({ url, background }) => {
      const id = openTab(url, { background })
      log('info', 'tool.open_tab', { url, id, background: background ?? false })
      return jsonResult({ ok: true, tab: id, url })
    }
  )
  server.registerTool(
    'close_tab',
    {
      description: 'Close a tab by id or host.',
      inputSchema: { tab: z.string().describe('tab id or host') }
    },
    async ({ tab }) => jsonResult({ ok: closeTab(tab) })
  )
  server.registerTool(
    'focus_tab',
    {
      description:
        'Bring a tab to the front. Not needed just to inspect or screenshot it — ' +
        'every page tool works on background tabs.',
      inputSchema: { tab: z.string().describe('tab id or host') }
    },
    async ({ tab }) => jsonResult({ ok: focusTab(tab) })
  )

  // ---- Bubbles: cross-site data exchange ----
  server.registerTool(
    'list_bubbles',
    {
      description:
        'List bubbles: named groups of sites whose edits may exchange data with each ' +
        'other and nothing outside. Shows each bubble\'s sites and member edits.',
      inputSchema: {}
    },
    async () => jsonResult(await bubbles.list())
  )
  server.registerTool(
    'save_bubble',
    {
      description:
        'Create a bubble (or add sites to one). Adding sites asks the USER to confirm — ' +
        'the single consent point in the model, so it is not automatic. Once approved, ' +
        'edits you put in the bubble can exchange data across those sites with no ' +
        'further prompting. Use this BEFORE writing cross-site edits.',
      inputSchema: {
        name: z.string().describe('short human name, e.g. "Timesheets"'),
        hosts: z.array(z.string()).describe('hostnames that may exchange data'),
        id: z.string().optional().describe('existing bubble id, to extend it')
      }
    },
    async ({ name, hosts, id }) => {
      const res = await saveBubble({ id, name, hosts })
      if (!res.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Bubble not saved: ${res.error}. The user must approve the sites before edits can share data.`
            }
          ]
        }
      }
      return jsonResult({ ok: true, bubble: res.id })
    }
  )
  server.registerTool(
    'set_edit_bubble',
    {
      description:
        'Put an edit INTO a bubble (or pass bubble:null to take it out). An edit gets ' +
        'its `mal` handle only once it is in a bubble. An edit belongs to exactly one ' +
        'bubble; to share logic across two features, write two edits.',
      inputSchema: {
        id: z.string().describe('edit id'),
        bubble: z.string().nullable().describe('bubble id, or null to remove'),
        host: z.string().optional().describe('defaults to the focused page')
      }
    },
    async ({ id, bubble, host }) => {
      const h = resolveHost(host)
      await setEditBubble(h, id, bubble)
      await reloadHost(h)
      return jsonResult({ ok: true, host: h, edit: id, bubble })
    }
  )

  server.registerTool(
    'push_bubble',
    {
      description:
        'Send the bubble\'s current data to EVERY destination site in it, in one action. ' +
        'Opens or focuses a tab per destination, then each destination\'s own edit runs ' +
        'its fill routine and reports back. Requires each destination to have an edit ' +
        'using mal.onPush(...). Returns per-site counts.',
      inputSchema: {
        bubble: z.string().describe('bubble id'),
        sourceHost: z.string().optional().describe('skip this host (where the data came from)'),
        hidden: z
          .boolean()
          .optional()
          .describe('drive destinations in hidden worker tabs, closed afterwards')
      }
    },
    async ({ bubble, sourceHost, hidden }) =>
      jsonResult(await pushBubble(bubble, { sourceHost, hidden }))
  )

  // ---- Meta-tools: let the agent grow its own toolset ----
  const paramSpec = z.object({
    type: z.enum(['string', 'number', 'boolean']),
    description: z.string().optional(),
    required: z.boolean().optional()
  })

  server.registerTool(
    'define_tool',
    {
      description:
        'Create (or replace) a NEW tool that becomes available immediately. The tool body runs as JavaScript in the live page with an `args` object in scope; use `return` to produce output. Scope "site" (default) makes it a durable harness for the current host, loaded only there; "global" makes it available everywhere.',
      inputSchema: {
        name: z.string().describe('lowercase name, e.g. extract_products'),
        description: z.string().describe('what the tool does + when to use it'),
        inputSchema: z
          .record(z.string(), paramSpec)
          .describe('param name -> {type, description?, required?}'),
        code: z.string().describe('JS body; has `args`; use return to produce a value'),
        scope: z.enum(['site', 'global']).optional().describe('default: site (current host)')
      }
    },
    async ({ name, description, inputSchema, code, scope }) => {
      try {
        dynamic.validateName(name)
        const isSite = (scope ?? 'site') === 'site'
        const host = isSite ? resolveHost() : undefined
        const def: DynamicToolDef = {
          name,
          description,
          inputSchema: (inputSchema ?? {}) as Record<string, ParamSpec>,
          code,
          createdAt: Date.now(),
          scope: isSite ? 'site' : 'global',
          host
        }
        await dynamic.save(def)
        if (isSite) {
          // Register live only if it's for the host currently on screen.
          if (host === currentSiteHost) {
            siteRegistered.get(name)?.remove()
            siteRegistered.set(name, registerDynamic(server, def, resolveInspector, log))
          }
        } else {
          registered.get(name)?.remove()
          registered.set(name, registerDynamic(server, def, resolveInspector, log))
        }
        server.sendToolListChanged()
        log('info', 'tool.define', { name, scope: def.scope, host })
        return jsonResult({
          ok: true,
          name,
          scope: def.scope,
          host,
          message: `Tool "${name}" (${def.scope}) is now available.`
        })
      } catch (err) {
        return { isError: true, content: [{ type: 'text' as const, text: String((err as any)?.message ?? err) }] }
      }
    }
  )

  server.registerTool(
    'remove_tool',
    {
      description: 'Delete a dynamic tool. Defaults to the current site scope; pass scope:"global" to remove a global one.',
      inputSchema: {
        name: z.string(),
        scope: z.enum(['site', 'global']).optional()
      }
    },
    async ({ name, scope }) => {
      const isSite = (scope ?? (siteRegistered.has(name) ? 'site' : 'global')) === 'site'
      if (isSite) {
        siteRegistered.get(name)?.remove()
        siteRegistered.delete(name)
        await dynamic.remove(name, 'site', currentSiteHost ?? undefined)
      } else {
        registered.get(name)?.remove()
        registered.delete(name)
        await dynamic.remove(name, 'global')
      }
      server.sendToolListChanged()
      log('info', 'tool.remove', { name, scope: isSite ? 'site' : 'global' })
      return jsonResult({ ok: true, removed: name, scope: isSite ? 'site' : 'global' })
    }
  )

  server.registerTool(
    'list_tools',
    { description: 'List your dynamic tools: the global ones and this site\'s ones.', inputSchema: {} },
    async () => {
      const globals = (await dynamic.listGlobal()).map((d) => ({
        name: d.name,
        scope: 'global',
        description: d.description,
        params: d.inputSchema
      }))
      const site = currentSiteHost
        ? (await dynamic.listSite(currentSiteHost)).map((d) => ({
            name: d.name,
            scope: `site:${currentSiteHost}`,
            description: d.description,
            params: d.inputSchema
          }))
        : []
      return jsonResult([...globals, ...site])
    }
  )

  // ---- Adaptation library: many named, toggleable edits per site ----
  server.registerTool(
    'save_adaptation',
    {
      description:
        'Create OR update a named page edit for this site. Omit id to create a new edit; pass an existing id to update one. Applies immediately to the live page so you can screenshot to verify. Keep separate concerns in separate edits.',
      inputSchema: {
        name: z.string().describe('short human name, e.g. "Dark theme"'),
        kind: z
          .enum(['theme', 'layout', 'functionality', 'cleanup', 'other'])
          .optional()
          .describe('category (default: other)'),
        css: z.string().optional().describe('CSS injected into the page'),
        js: z.string().optional().describe('JS run in the page (idempotent; plain DOM)'),
        id: z.string().optional().describe('existing edit id to update'),
        host: z.string().optional().describe('target host (default: current page)')
      }
    },
    async ({ name, kind, css, js, id, host }) => {
      try {
        const h = resolveHost(host)
        const meta = await adaptations.saveEdit(h, { id, name, kind, css, js })
        log('info', 'adaptation.save', { host: h, id: meta.id, name, kind: meta.kind })
        await reloadHost(h)
        return jsonResult({ ok: true, host: h, ...meta })
      } catch (err) {
        return { isError: true, content: [{ type: 'text' as const, text: String((err as any)?.message ?? err) }] }
      }
    }
  )
  server.registerTool(
    'list_adaptations',
    {
      description: 'List the named edits saved for a site (default: current).',
      inputSchema: { host: z.string().optional() }
    },
    async ({ host }) => jsonResult(await adaptations.listForHost(resolveHost(host)))
  )
  server.registerTool(
    'get_adaptation',
    {
      description: 'Get one edit (its css/js/meta) by id.',
      inputSchema: { id: z.string(), host: z.string().optional() }
    },
    async ({ id, host }) => jsonResult(await adaptations.getEdit(resolveHost(host), id))
  )
  server.registerTool(
    'set_adaptation_enabled',
    {
      description: 'Enable or disable a named edit.',
      inputSchema: { id: z.string(), enabled: z.boolean(), host: z.string().optional() }
    },
    async ({ id, enabled, host }) => {
      const h = resolveHost(host)
      await adaptations.setEnabled(h, id, enabled)
      log('info', 'adaptation.toggle', { host: h, id, enabled })
      await reloadHost(h)
      return jsonResult({ ok: true, id, enabled })
    }
  )
  server.registerTool(
    'delete_adaptation',
    {
      description: 'Delete a named edit permanently.',
      inputSchema: { id: z.string(), host: z.string().optional() }
    },
    async ({ id, host }) => {
      const h = resolveHost(host)
      await adaptations.deleteEdit(h, id)
      log('info', 'adaptation.delete', { host: h, id })
      await reloadHost(h)
      return jsonResult({ ok: true, deleted: id })
    }
  )

  // ---- Load persisted dynamic tools ----
  // Global tools are always registered; site tools track the current host.
  for (const def of await dynamic.listGlobal()) {
    try {
      registered.set(def.name, registerDynamic(server, def, resolveInspector, log))
    } catch (err) {
      log('warn', 'tool.load.error', { name: def.name, err: String((err as any)?.message ?? err) })
    }
  }
  await reconcileSiteTools(hostNow())

  return { server, reconcile: reconcileSiteTools, reloadAll }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

/**
 * In-process MCP server over HTTP (localhost, bearer-token gated), stateful so it
 * can push `tools/list_changed` when the agent scaffolds new tools mid-session.
 */
export async function startPageToolsServer(deps: PageToolsDeps): Promise<PageToolsHandle> {
  const { workspace, log } = deps
  const token = randomUUID()
  const dynamic = new DynamicTools(workspace)
  const transports = new Map<string, StreamableHTTPServerTransport>()
  // Live servers, so navigation/library edits can re-scope their tools.
  const servers = new Set<BuiltServer>()
  let lastHost: string | null = null

  const httpServer = createServer(async (req, res) => {
    if (!req.url || !req.url.startsWith('/mcp')) return void res.writeHead(404).end()
    if (req.headers['authorization'] !== `Bearer ${token}`) return void res.writeHead(401).end()

    const sid = req.headers['mcp-session-id'] as string | undefined
    try {
      if (req.method === 'POST') {
        const body = await readBody(req)
        let transport = sid ? transports.get(sid) : undefined
        if (!transport) {
          if (!isInitializeRequest(body)) {
            res.writeHead(400).end('Missing or invalid session')
            return
          }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport!)
            }
          })
          const built = await buildServer(deps, dynamic)
          servers.add(built)
          transport.onclose = () => {
            if (transport!.sessionId) transports.delete(transport!.sessionId)
            servers.delete(built)
          }
          await built.server.connect(transport)
        }
        await transport.handleRequest(req, res, body)
      } else {
        // GET (SSE for notifications) / DELETE (close)
        const transport = sid ? transports.get(sid) : undefined
        if (!transport) return void res.writeHead(400).end('Missing session')
        await transport.handleRequest(req, res)
      }
    } catch (err) {
      log('error', 'mcp.request.error', String((err as any)?.message ?? err))
      if (!res.headersSent) res.writeHead(500).end()
    }
  })

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const port = (httpServer.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}/mcp`
  log('info', 'mcp.server.start', { url })

  const syncSiteTools = (host: string | null): void => {
    if (host === lastHost) return
    lastHost = host
    for (const b of servers) void b.reconcile(host)
  }
  const refreshTools = (): void => {
    for (const b of servers) void b.reloadAll()
  }

  return { url, token, close: () => httpServer.close(), syncSiteTools, refreshTools }
}
