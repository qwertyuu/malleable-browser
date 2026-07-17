import { createServer, type IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { PageInspector } from './page-inspector.js'
import type { Adaptations } from './adaptations.js'
import { DynamicTools, type DynamicToolDef, type ParamSpec } from './dynamic-tools.js'

type Log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, data?: unknown) => void

export interface PageToolsDeps {
  inspector: PageInspector
  workspace: string
  adaptations: Adaptations
  /** URL of the page currently shown, for host resolution. */
  currentUrl: () => string
  /** Reload the visible page and wait for load (so injected edits are visible). */
  reloadCurrent: () => Promise<void>
  log: Log
}

export interface PageToolsHandle {
  url: string
  token: string
  close: () => void
}

const jsonResult = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }]
})

/** Register one agent-authored tool (runs as page-JS) on a live server. */
function registerDynamic(
  server: McpServer,
  def: DynamicToolDef,
  inspector: PageInspector,
  log: Log
): RegisteredTool {
  return server.registerTool(
    def.name,
    { description: def.description, inputSchema: DynamicTools.toZodShape(def.inputSchema) },
    async (args: Record<string, unknown>) => {
      log('info', 'tool.dynamic', { name: def.name, args })
      return jsonResult(await inspector.runJsWithArgs(def.code, args))
    }
  )
}

/**
 * Build a fresh MCP server: static page tools, the meta-tools that let the agent
 * scaffold new tools at runtime, and any dynamic tools already on disk.
 */
async function buildServer(deps: PageToolsDeps, dynamic: DynamicTools): Promise<McpServer> {
  const { inspector, adaptations, currentUrl, reloadCurrent, log } = deps
  const server = new McpServer({ name: 'malleable-page', version: '0.1.0' })
  // name -> live registration, so define/remove can update in place.
  const registered = new Map<string, RegisteredTool>()

  // Resolve the target host for an adaptation tool (defaults to current page).
  const resolveHost = (host?: string): string => {
    const h = host ?? adaptations.slugFor(currentUrl())
    if (!h) throw new Error('No host: load a page or pass an explicit host')
    return h
  }
  const isCurrent = (host: string): boolean => adaptations.slugFor(currentUrl()) === host

  // ---- Static page tools ----
  server.registerTool(
    'dom_query',
    {
      description: 'Query the live page DOM by CSS selector.',
      inputSchema: {
        selector: z.string(),
        all: z.boolean().optional(),
        limit: z.number().optional()
      }
    },
    async ({ selector, all, limit }) =>
      jsonResult(await inspector.domQuery(selector, all ?? false, limit ?? 10))
  )
  server.registerTool(
    'run_js',
    {
      description: 'Run JS in the live page and return the result (use `return`).',
      inputSchema: { code: z.string() }
    },
    async ({ code }) => jsonResult(await inspector.runJs(code))
  )
  server.registerTool(
    'get_console',
    { description: 'Recent page console messages.', inputSchema: { limit: z.number().optional() } },
    async ({ limit }) => jsonResult(inspector.getConsole(limit ?? 50))
  )
  server.registerTool(
    'get_network',
    { description: 'Recent page network requests.', inputSchema: { limit: z.number().optional() } },
    async ({ limit }) => jsonResult(inspector.getNetwork(limit ?? 50))
  )
  server.registerTool(
    'screenshot',
    { description: 'PNG screenshot of the page so you can SEE it.', inputSchema: {} },
    async () => ({
      content: [{ type: 'image' as const, data: await inspector.screenshot(), mimeType: 'image/png' }]
    })
  )
  server.registerTool(
    'fetch_image',
    { description: 'Download an image by URL and view it (multimodal).', inputSchema: { url: z.string() } },
    async ({ url }) => {
      try {
        const { data, mimeType } = await inspector.fetchImage(url)
        return { content: [{ type: 'image' as const, data, mimeType }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text' as const, text: String((err as any)?.message ?? err) }] }
      }
    }
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
        'Create (or replace) a NEW tool that becomes available immediately. The tool body runs as JavaScript in the live page with an `args` object in scope; use `return` to produce output. This is how you extend your own capabilities into a reusable harness over this site.',
      inputSchema: {
        name: z.string().describe('lowercase name, e.g. extract_products'),
        description: z.string().describe('what the tool does + when to use it'),
        inputSchema: z
          .record(z.string(), paramSpec)
          .describe('param name -> {type, description?, required?}'),
        code: z.string().describe('JS body; has `args`; use return to produce a value')
      }
    },
    async ({ name, description, inputSchema, code }) => {
      try {
        dynamic.validateName(name)
        const def: DynamicToolDef = {
          name,
          description,
          inputSchema: (inputSchema ?? {}) as Record<string, ParamSpec>,
          code,
          createdAt: Date.now()
        }
        await dynamic.save(def)
        registered.get(name)?.remove()
        registered.set(name, registerDynamic(server, def, inspector, log))
        server.sendToolListChanged()
        log('info', 'tool.define', { name })
        return jsonResult({ ok: true, name, message: `Tool "${name}" is now available.` })
      } catch (err) {
        return { isError: true, content: [{ type: 'text' as const, text: String((err as any)?.message ?? err) }] }
      }
    }
  )

  server.registerTool(
    'remove_tool',
    { description: 'Delete a previously defined dynamic tool.', inputSchema: { name: z.string() } },
    async ({ name }) => {
      registered.get(name)?.remove()
      registered.delete(name)
      await dynamic.remove(name)
      server.sendToolListChanged()
      log('info', 'tool.remove', { name })
      return jsonResult({ ok: true, removed: name })
    }
  )

  server.registerTool(
    'list_tools',
    { description: 'List the dynamic tools you have defined.', inputSchema: {} },
    async () =>
      jsonResult(
        (await dynamic.list()).map((d) => ({
          name: d.name,
          description: d.description,
          params: d.inputSchema
        }))
      )
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
        if (isCurrent(h)) await reloadCurrent()
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
      if (isCurrent(h)) await reloadCurrent()
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
      if (isCurrent(h)) await reloadCurrent()
      return jsonResult({ ok: true, deleted: id })
    }
  )

  // ---- Load persisted dynamic tools ----
  for (const def of await dynamic.list()) {
    try {
      registered.set(def.name, registerDynamic(server, def, inspector, log))
    } catch (err) {
      log('warn', 'tool.load.error', { name: def.name, err: String((err as any)?.message ?? err) })
    }
  }

  return server
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
          transport.onclose = () => {
            if (transport!.sessionId) transports.delete(transport!.sessionId)
          }
          const server = await buildServer(deps, dynamic)
          await server.connect(transport)
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

  return { url, token, close: () => httpServer.close() }
}
