import { net, type WebContents } from 'electron'

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
}

const MAX_BUFFER = 300

/**
 * Gives the agent a window into the live page: DOM queries, live JS, console and
 * network logs, screenshots, and image downloads. Backed directly by the
 * embedded WebContentsView (main-process access), exposed to the agent as MCP
 * tools (see page-tools-server.ts).
 */
export class PageInspector {
  private consoleBuf: ConsoleEntry[] = []
  private networkBuf: NetworkEntry[] = []

  constructor(private readonly getWc: () => WebContents | undefined) {}

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
      this.push(this.consoleBuf, { level, message, ts: Date.now() })
    })

    // Network: request metadata (no bodies) via the session's webRequest hooks.
    const wr = wc.session.webRequest
    wr.onCompleted((d) => {
      this.push(this.networkBuf, {
        method: d.method,
        url: d.url,
        status: d.statusCode,
        type: d.resourceType,
        ts: Date.now()
      })
    })
    wr.onErrorOccurred((d) => {
      this.push(this.networkBuf, {
        method: d.method,
        url: d.url,
        type: d.resourceType,
        error: d.error,
        ts: Date.now()
      })
    })

    // Reset buffers on a real (main-frame, non-in-page) navigation.
    wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        this.consoleBuf = []
        this.networkBuf = []
      }
    })
  }

  private push<T>(buf: T[], entry: T): void {
    buf.push(entry)
    if (buf.length > MAX_BUFFER) buf.shift()
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

  getNetwork(limit: number): NetworkEntry[] {
    return this.networkBuf.slice(-limit)
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
