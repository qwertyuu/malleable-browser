import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { WebContents } from 'electron'
import { WebSocketServer, type WebSocket } from 'ws'

export interface CdpBridgeHandle {
  url: string
  allowedDomains: string[]
  close: () => void
}

/** What the relay needs to know about a tab: its id and its live webContents. */
export interface CdpTarget {
  id: string
  wc: WebContents
}

// CDP domains reasoned about and safe to hand over wholesale: DOM inspection/
// mutation, JS evaluation, navigation/lifecycle, synthetic input, styling,
// console logs, perf metrics, and read-only network (matches what
// PageInspector already captures internally).
const ALLOWED_DOMAINS = ['DOM', 'Runtime', 'Page', 'Input', 'CSS', 'Log', 'Performance', 'Network'] as const
const ALLOWED_DOMAIN_SET = new Set<string>(ALLOWED_DOMAINS)

// Deliberately never forwarded, even though their domain (or a same-named
// sibling) might otherwise be allowed: Target/Browser let a client pivot to
// other views (the app's own chrome); Storage/cookie methods dump site data
// wholesale; Fetch/interception mocks live traffic; Emulation/Security spoof
// device/geo/certs. Each is a real capability class beyond "drive this one
// page" and deserves its own explicit decision later, not a default grant.
const BLOCKED_METHODS = new Set([
  'Network.setRequestInterception',
  'Network.getCookies',
  'Network.getAllCookies',
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Network.clearBrowserCookies',
  'Network.clearBrowserCache'
])

function isAllowed(method: string): boolean {
  const domain = method.slice(0, method.indexOf('.'))
  return ALLOWED_DOMAIN_SET.has(domain) && !BLOCKED_METHODS.has(method)
}

interface CdpRequest {
  id: number
  method: string
  params?: unknown
}

/**
 * Scoped, raw CDP-over-WebSocket relay for content tabs — the general escape
 * hatch for automation the built-in MCP tools don't cover.
 *
 * Each WebSocket connection is pinned to exactly ONE tab, chosen by a `?tab=`
 * ref at connect time and never changeable afterwards. That keeps the original
 * single-target guarantee intact now that sibling tabs exist: a client can drive
 * the tab it asked for and cannot pivot, because Target/Browser stay blocked and
 * there is no in-band way to retarget. Events are tagged with `tabId` and fan
 * out only to the clients pinned to that tab.
 *
 * Reuses the debugger session PageInspector already attaches (page-inspector.ts
 * owns the one `wc.debugger.attach()` call per tab); this only adds a second
 * `'message'` listener, which `wc.debugger` (a plain EventEmitter) supports fine
 * alongside PageInspector's own. Never forwards Target/Browser/Storage/
 * Emulation/Security/Fetch — see BLOCKED_METHODS / ALLOWED_DOMAINS above.
 */
export async function startCdpBridge(
  resolveTab: (ref?: string) => CdpTarget | undefined
): Promise<CdpBridgeHandle> {
  const token = randomUUID()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  // One listener per tab, and the set of clients pinned to it. Replaces the old
  // one-shot latch, which would never have re-bound to a second tab.
  const wired = new WeakSet<WebContents>()
  const clients = new Map<WebContents, Set<WebSocket>>()

  const ensureListener = (target: CdpTarget): void => {
    const { id, wc } = target
    if (wired.has(wc)) return
    wired.add(wc)
    wc.debugger.on('message', (_event, method, params) => {
      const frame = JSON.stringify({ tabId: id, method, params })
      for (const ws of clients.get(wc) ?? []) {
        if (ws.readyState === ws.OPEN) ws.send(frame)
      }
    })
    wc.once('destroyed', () => clients.delete(wc))
  }

  wss.on('connection', (ws: WebSocket, req) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (reqUrl.searchParams.get('token') !== token) {
      ws.close(4001, 'Unauthorized')
      return
    }
    // Resolved once, at connect time. `tab` accepts a tab id or a host.
    const target = resolveTab(reqUrl.searchParams.get('tab') ?? undefined)
    if (!target) {
      ws.close(4004, 'No such tab')
      return
    }
    const wc = target.wc
    ensureListener(target)
    let set = clients.get(wc)
    if (!set) {
      set = new Set()
      clients.set(wc, set)
    }
    set.add(ws)
    ws.on('close', () => set!.delete(ws))

    ws.on('message', async (raw) => {
      let req: CdpRequest
      try {
        req = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!isAllowed(req.method)) {
        ws.send(
          JSON.stringify({
            id: req.id,
            error: { message: `Domain not permitted on this scoped session: ${req.method}` }
          })
        )
        return
      }
      try {
        const result = await wc.debugger.sendCommand(req.method, req.params)
        ws.send(JSON.stringify({ id: req.id, result }))
      } catch (err) {
        ws.send(JSON.stringify({ id: req.id, error: { message: String((err as any)?.message ?? err) } }))
      }
    })
  })

  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const { port } = wss.address() as AddressInfo
  const url = `ws://127.0.0.1:${port}/cdp?token=${token}`

  return { url, allowedDomains: [...ALLOWED_DOMAINS], close: () => wss.close() }
}
