import { net, type WebContents } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface ConsoleEntry {
  level: string
  message: string
  ts: number
}

export interface NetworkEntry {
  method: string
  url: string
  status?: number
  type?: string
  error?: string
  ts: number
  durationMs?: number
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  requestBody?: string
  responseBody?: string
  bodyTruncated?: boolean
}

export interface NetworkFilter {
  urlContains?: string
  type?: string
  method?: string
  status?: number
}

interface PendingRequest {
  method: string
  url: string
  type?: string
  ts: number
  cdpStart: number
  requestHeaders?: Record<string, string>
  requestBody?: string
  status?: number
  responseHeaders?: Record<string, string>
}

const MAX_BUFFER = 300
const NETWORK_MAX_BUFFER = 400
const MAX_BODY_LEN = 20_000
const MAX_BODY_FETCH_BYTES = 256 * 1024
// Resource types whose bodies aren't useful to capture (binary/streaming).
const SKIP_BODY_TYPES = new Set(['Image', 'Media', 'Font', 'WebSocket'])

/**
 * Gives the agent a window into the live page: DOM queries, live JS, console and
 * network logs, screenshots, and image downloads. Backed directly by the
 * embedded WebContentsView (main-process access), exposed to the agent as MCP
 * tools (see page-tools-server.ts).
 */
export class PageInspector {
  private consoleBuf: ConsoleEntry[] = []
  private networkBuf: NetworkEntry[] = []
  private pending = new Map<string, PendingRequest>()
  // Off by default: attaching a CDP debugger session is a well-known automation
  // fingerprint that bot/fraud detection (banks, mainly) checks for. Only turn on
  // when the agent is actually asked to work on the page (see setCaptureEnabled),
  // not for ordinary browsing.
  private captureEnabled = false

  constructor(
    private readonly getWc: () => WebContents | undefined,
    /** Current page's origin slug (mirrors Adaptations.slugFor), for live-log paths. */
    private readonly getHost: () => string | null,
    private readonly workspace: string
  ) {}

  /**
   * Best-effort mirror of a captured entry to <workspace>/live/<host>/<kind>.jsonl
   * so the agent's own Bash/grep/node can treat page history as an ordinary,
   * tail-able file instead of something only reachable via get_network/get_console.
   */
  private async appendLive(kind: 'network' | 'console', entry: unknown): Promise<void> {
    const host = this.getHost()
    if (!host) return
    try {
      const dir = join(this.workspace, 'live', host)
      await fs.mkdir(dir, { recursive: true })
      await fs.appendFile(join(dir, `${kind}.jsonl`), JSON.stringify(entry) + '\n', 'utf8')
    } catch {
      // Best-effort mirror; the in-memory ring buffers remain the source of truth.
    }
  }

  /** Wire console + network capture onto the content view's web contents. */
  attach(wc: WebContents): void {
    // Console messages. Electron changed this event's shape across versions;
    // handle both the object form and the legacy positional form.
    wc.on('console-message', (...args: any[]) => {
      const a0 = args[0]
      let level = 'log'
      let message = ''
      if (a0 && typeof a0 === 'object' && 'message' in a0) {
        level = String(a0.level ?? 'log')
        message = String(a0.message ?? '')
      } else {
        level = ['verbose', 'info', 'warning', 'error'][a0 as number] ?? String(a0)
        message = String(args[1] ?? '')
      }
      const entry: ConsoleEntry = { level, message, ts: Date.now() }
      this.push(this.consoleBuf, entry)
      void this.appendLive('console', entry)
    })

    this.wireNetworkDebugger(wc)

    // Reset the console log on a real (main-frame, non-in-page) navigation; the
    // network log is a ring buffer that persists across reloads so the agent can
    // still see what led up to the current page.
    wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        this.consoleBuf = []
      }
    })
  }

  /**
   * Register the CDP message handling once for this WebContents' lifetime, then
   * attach (unless capture is currently disabled — see setCaptureEnabled). Split
   * from the attach call itself so Safe Mode can detach/reattach later without
   * re-registering listeners.
   */
  private wireNetworkDebugger(wc: WebContents): void {
    wc.debugger.on('message', (_event, method, params: any) => {
      switch (method) {
        case 'Network.requestWillBeSent': {
          const req = params.request
          this.pending.set(params.requestId, {
            method: req.method,
            url: req.url,
            type: params.type,
            ts: Date.now(),
            cdpStart: params.timestamp,
            requestHeaders: req.headers,
            requestBody: typeof req.postData === 'string' ? this.truncate(req.postData) : undefined
          })
          break
        }
        case 'Network.responseReceived': {
          const p = this.pending.get(params.requestId)
          if (p) {
            p.status = params.response.status
            p.responseHeaders = params.response.headers
            p.type = params.type ?? p.type
          }
          break
        }
        case 'Network.loadingFinished': {
          void this.finishRequest(wc, params.requestId, params.timestamp, params.encodedDataLength ?? 0)
          break
        }
        case 'Network.loadingFailed': {
          const p = this.pending.get(params.requestId)
          if (p) {
            this.pending.delete(params.requestId)
            const entry: NetworkEntry = {
              method: p.method,
              url: p.url,
              type: p.type,
              ts: p.ts,
              durationMs: Math.round((params.timestamp - p.cdpStart) * 1000),
              requestHeaders: p.requestHeaders,
              requestBody: p.requestBody,
              error: params.errorText
            }
            this.push(this.networkBuf, entry, NETWORK_MAX_BUFFER)
            void this.appendLive('network', entry)
          }
          break
        }
      }
    })

    wc.once('destroyed', () => {
      try {
        wc.debugger.detach()
      } catch {
        // already detached
      }
    })

    if (this.captureEnabled) this.attachDebugger(wc)
  }

  /** Attach the CDP session and enable network capture. No-op if already attached. */
  private attachDebugger(wc: WebContents): void {
    try {
      wc.debugger.attach('1.3')
    } catch {
      // Already attached (e.g. real DevTools open on this view) — no network capture.
      return
    }
    wc.debugger.sendCommand('Network.enable').catch(() => {})
  }

  /**
   * Toggle CDP debugger capture on/off. Called with `true` right when the agent
   * starts an Adapt turn (so its network/console tools have something to read),
   * and with `false` by Safe Mode to force it off regardless — an attached
   * DevTools protocol session is a common automation fingerprint that bot/fraud
   * detection (e.g. on banking sites) checks for.
   */
  setCaptureEnabled(wc: WebContents | undefined, enabled: boolean): void {
    this.captureEnabled = enabled
    if (!wc) return
    if (enabled) {
      if (!wc.debugger.isAttached()) this.attachDebugger(wc)
    } else if (wc.debugger.isAttached()) {
      try {
        wc.debugger.detach()
      } catch {
        // already detached
      }
    }
  }

  /** Finalize a completed request: fetch its body (if capturable) and log it. */
  private async finishRequest(
    wc: WebContents,
    requestId: string,
    endTs: number,
    encodedDataLength: number
  ): Promise<void> {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)

    let responseBody: string | undefined
    let bodyTruncated = encodedDataLength >= MAX_BODY_FETCH_BYTES
    if (p.type && !SKIP_BODY_TYPES.has(p.type) && !bodyTruncated) {
      try {
        const body = await wc.debugger.sendCommand('Network.getResponseBody', { requestId })
        if (body && typeof body.body === 'string' && !body.base64Encoded) {
          bodyTruncated = body.body.length > MAX_BODY_LEN
          responseBody = this.truncate(body.body)
        }
      } catch {
        // Body unavailable (redirect, cache, opaque response, etc.) — skip it.
      }
    }

    const entry: NetworkEntry = {
      method: p.method,
      url: p.url,
      status: p.status,
      type: p.type,
      ts: p.ts,
      durationMs: Math.round((endTs - p.cdpStart) * 1000),
      requestHeaders: p.requestHeaders,
      responseHeaders: p.responseHeaders,
      requestBody: p.requestBody,
      responseBody,
      bodyTruncated: bodyTruncated || undefined
    }
    this.push(this.networkBuf, entry, NETWORK_MAX_BUFFER)
    void this.appendLive('network', entry)
  }

  private truncate(s: string): string {
    return s.length > MAX_BODY_LEN ? s.slice(0, MAX_BODY_LEN) + '…' : s
  }

  private push<T>(buf: T[], entry: T, max = MAX_BUFFER): void {
    buf.push(entry)
    if (buf.length > max) buf.shift()
  }

  private async evaluate<T>(expr: string): Promise<T> {
    const wc = this.getWc()
    if (!wc) throw new Error('No page loaded')
    return wc.executeJavaScript(expr, false) as Promise<T>
  }

  /** Query the DOM by CSS selector; returns element details. */
  async domQuery(selector: string, all: boolean, limit: number): Promise<unknown> {
    const expr = `(function(){
      try {
        var nodes = document.querySelectorAll(${JSON.stringify(selector)});
        var els = Array.prototype.slice.call(nodes, 0, ${all ? Math.max(1, limit) : 1});
        return {
          count: nodes.length,
          matches: els.map(function(el){
            var attrs = {};
            for (var i=0;i<el.attributes.length;i++){ attrs[el.attributes[i].name] = el.attributes[i].value; }
            var oh = el.outerHTML || '';
            if (oh.length > 2000) oh = oh.slice(0,2000) + '…';
            var tx = (el.textContent || '').replace(/\\s+/g,' ').trim();
            if (tx.length > 300) tx = tx.slice(0,300) + '…';
            var r = el.getBoundingClientRect();
            return { tag: el.tagName.toLowerCase(), id: el.id||undefined, class: el.className||undefined,
                     text: tx, attributes: attrs, rect: {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
                     outerHTML: oh };
          })
        };
      } catch(e){ return { __error: String(e) }; }
    })()`
    return this.evaluate(expr)
  }

  /** Run arbitrary JS in the page (use `return` to produce a value). */
  async runJs(code: string): Promise<unknown> {
    const expr = `(async function(){
      try {
        var __r = await (async function(){ ${code} \n})();
        return { ok: true, result: (typeof __r === 'undefined' ? null : JSON.parse(JSON.stringify(__r))) };
      } catch(e){ return { ok: false, error: String((e && e.stack) || e) }; }
    })()`
    return this.evaluate(expr)
  }

  /** Run an agent-authored tool body in the page with an `args` object in scope. */
  async runJsWithArgs(code: string, args: unknown): Promise<unknown> {
    const expr = `(async function(){
      var args = ${JSON.stringify(args ?? {})};
      try {
        var __r = await (async function(){ ${code} \n})();
        return { ok: true, result: (typeof __r === 'undefined' ? null : JSON.parse(JSON.stringify(__r))) };
      } catch(e){ return { ok: false, error: String((e && e.stack) || e) }; }
    })()`
    return this.evaluate(expr)
  }

  getConsole(limit: number): ConsoleEntry[] {
    return this.consoleBuf.slice(-limit)
  }

  getNetwork(limit: number, filter?: NetworkFilter): NetworkEntry[] {
    let entries = this.networkBuf
    if (filter) {
      const urlContains = filter.urlContains?.toLowerCase()
      entries = entries.filter((e) => {
        if (urlContains && !e.url.toLowerCase().includes(urlContains)) return false
        if (filter.type && e.type !== filter.type) return false
        if (filter.method && e.method.toUpperCase() !== filter.method.toUpperCase()) return false
        if (filter.status !== undefined && e.status !== filter.status) return false
        return true
      })
    }
    return entries.slice(-limit)
  }

  /** PNG screenshot of the visible page, as base64. */
  async screenshot(): Promise<string> {
    const wc = this.getWc()
    if (!wc) throw new Error('No page loaded')
    const img = await wc.capturePage()
    return img.toPNG().toString('base64')
  }

  /** Download an image by URL; returns base64 + mime type. */
  async fetchImage(url: string): Promise<{ data: string; mimeType: string }> {
    const resp = await net.fetch(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`)
    const mimeType = resp.headers.get('content-type') ?? 'application/octet-stream'
    if (!mimeType.startsWith('image/')) {
      throw new Error(`Not an image (content-type: ${mimeType})`)
    }
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length > 8 * 1024 * 1024) throw new Error('Image too large (>8MB)')
    return { data: buf.toString('base64'), mimeType }
  }
}
