import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Bubbles } from './bubbles.js'

type Log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, data?: unknown) => void

export interface BubbleServerHandle {
  url: string
  token: string
  close: () => void
}

/** SSE subscriber, pinned to one bubble for its lifetime. */
interface Watcher {
  bubbleId: string
  res: ServerResponse
}

const MAX_BODY = 2 * 1024 * 1024
const MAX_STATE_BYTES = 4 * 1024 * 1024

/**
 * The bubble server: a localhost HTTP endpoint that adaptations talk to with
 * plain `fetch` / `EventSource`.
 *
 * Why a server and not something exposed on `window`: page JS already has a
 * channel to localhost, so nothing new has to be injected into the page world.
 * The page sandbox is untouched — this adds no reach from a page toward Node,
 * only a socket the page could already have opened.
 *
 * Authorization is the `Origin` header, which the browser sets and page JS cannot
 * forge: a request is served only if its origin's host is a member of the bubble
 * it names. So bubble membership IS the CORS allowlist, and "nothing leaves the
 * bubble" is enforced in one place. A bearer token is also required, because
 * Origin is forgeable by non-browser processes on the same machine.
 *
 * Endpoints (all under a random-token'd base URL):
 *   GET  /state?bubble=<id>              -> { key: value, ... }
 *   PUT  /state?bubble=<id>&key=<k>      -> body is the JSON value; notifies watchers
 *   POST /publish?bubble=<id>&ch=<c>     -> ephemeral fan-out, no persistence
 *   GET  /watch?bubble=<id>              -> SSE: {type:'state'|'bus', key|ch, value}
 */
export async function startBubbleServer(deps: {
  workspace: string
  bubbles: Bubbles
  log: Log
}): Promise<BubbleServerHandle> {
  const { workspace, bubbles, log } = deps
  const token = randomUUID()
  const dir = join(workspace, '.malleable', 'surface')
  const watchers = new Set<Watcher>()
  // Written through to disk, cached in memory so reads never hit the filesystem.
  const cache = new Map<string, Record<string, unknown>>()

  const fileFor = (bubbleId: string): string => join(dir, `${bubbleId}.json`)

  const loadState = async (bubbleId: string): Promise<Record<string, unknown>> => {
    const hit = cache.get(bubbleId)
    if (hit) return hit
    let data: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(await fs.readFile(fileFor(bubbleId), 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed
    } catch {
      // No state yet, or unreadable — start empty rather than failing the request.
    }
    cache.set(bubbleId, data)
    return data
  }

  const saveState = async (bubbleId: string, data: Record<string, unknown>): Promise<void> => {
    cache.set(bubbleId, data)
    await fs.mkdir(dir, { recursive: true })
    // Write-then-rename so a crash mid-write can't truncate existing state.
    const tmp = `${fileFor(bubbleId)}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, fileFor(bubbleId))
  }

  const notify = (bubbleId: string, payload: unknown): void => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`
    for (const w of watchers) {
      if (w.bubbleId !== bubbleId) continue
      try {
        w.res.write(frame)
      } catch {
        watchers.delete(w)
      }
    }
  }

  /**
   * Is this request allowed to touch this bubble? Requires the bearer token AND
   * an Origin whose host is a member. Returns the allowed origin to echo back,
   * or null to reject.
   */
  const authorize = async (
    req: IncomingMessage,
    bubbleId: string,
    queryToken: string | null
  ): Promise<{ origin: string } | null> => {
    // EventSource can't set headers, so /watch passes the token as a query param.
    const viaHeader = (req.headers.authorization ?? '') === `Bearer ${token}`
    if (!viaHeader && queryToken !== token) return null
    const origin = req.headers.origin
    if (!origin) return null
    let host: string
    try {
      host = new URL(origin).hostname
    } catch {
      return null
    }
    const bubble = await bubbles.get(bubbleId)
    if (!bubble || !bubble.hosts.includes(host)) return null
    return { origin }
  }

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let n = 0
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => {
        n += c.length
        if (n > MAX_BODY) {
          reject(new Error('Body too large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const send = (res: ServerResponse, status: number, body: unknown, origin?: string): void => {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
    if (origin) {
      headers['access-control-allow-origin'] = origin
      headers.vary = 'Origin'
    }
    res.writeHead(status, headers)
    res.end(JSON.stringify(body))
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const bubbleId = url.searchParams.get('bubble') ?? ''

      // CORS preflight. Answered only for genuine members, so a non-member origin
      // is refused by the browser before the real request is ever sent.
      if (req.method === 'OPTIONS') {
        const origin = req.headers.origin
        let ok = false
        if (origin && bubbleId) {
          try {
            const b = await bubbles.get(bubbleId)
            ok = !!b && b.hosts.includes(new URL(origin).hostname)
          } catch {
            ok = false
          }
        }
        if (!ok || !origin) {
          res.writeHead(403).end()
          return
        }
        res.writeHead(204, {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-max-age': '600',
          vary: 'Origin'
        }).end()
        return
      }

      const auth = await authorize(req, bubbleId, url.searchParams.get('token'))
      if (!auth) {
        log('warn', 'bubble.denied', {
          bubble: bubbleId,
          origin: req.headers.origin ?? null,
          path: url.pathname
        })
        send(res, 403, { error: 'Not a member of this bubble' })
        return
      }

      // ---- SSE: live change stream for one bubble ----
      if (req.method === 'GET' && url.pathname === '/watch') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'access-control-allow-origin': auth.origin,
          vary: 'Origin'
        })
        res.write(': connected\n\n')
        const w: Watcher = { bubbleId, res }
        watchers.add(w)
        // Keep intermediaries and idle sockets from dropping the stream.
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n')
          } catch {
            clearInterval(ping)
            watchers.delete(w)
          }
        }, 25_000)
        req.on('close', () => {
          clearInterval(ping)
          watchers.delete(w)
        })
        return
      }

      if (url.pathname === '/state') {
        if (req.method === 'GET') {
          send(res, 200, await loadState(bubbleId), auth.origin)
          return
        }
        if (req.method === 'PUT') {
          const key = url.searchParams.get('key')
          if (!key) {
            send(res, 400, { error: 'Missing key' }, auth.origin)
            return
          }
          const raw = await readBody(req)
          let value: unknown
          try {
            value = raw ? JSON.parse(raw) : null
          } catch {
            send(res, 400, { error: 'Body must be JSON' }, auth.origin)
            return
          }
          const data = { ...(await loadState(bubbleId)) }
          if (value === null) delete data[key]
          else data[key] = value
          if (Buffer.byteLength(JSON.stringify(data)) > MAX_STATE_BYTES) {
            send(res, 413, { error: 'Bubble state too large' }, auth.origin)
            return
          }
          await saveState(bubbleId, data)
          notify(bubbleId, { type: 'state', key, value })
          log('info', 'bubble.state.set', { bubble: bubbleId, key, origin: auth.origin })
          send(res, 200, { ok: true }, auth.origin)
          return
        }
      }

      // ---- Ephemeral fan-out: never persisted, for live reactions ----
      if (req.method === 'POST' && url.pathname === '/publish') {
        const ch = url.searchParams.get('ch')
        if (!ch) {
          send(res, 400, { error: 'Missing ch' }, auth.origin)
          return
        }
        const raw = await readBody(req)
        let value: unknown
        try {
          value = raw ? JSON.parse(raw) : null
        } catch {
          send(res, 400, { error: 'Body must be JSON' }, auth.origin)
          return
        }
        notify(bubbleId, { type: 'bus', ch, value })
        send(res, 200, { ok: true }, auth.origin)
        return
      }

      send(res, 404, { error: 'No such endpoint' }, auth.origin)
    } catch (err) {
      log('error', 'bubble.server.error', { err: String((err as Error)?.message ?? err) })
      try {
        send(res, 500, { error: 'Internal error' })
      } catch {
        // Response already partly written (e.g. an SSE stream) — nothing to do.
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`
  log('info', 'bubble.server.start', { url })

  return {
    url,
    token,
    close: () => {
      for (const w of watchers) {
        try {
          w.res.end()
        } catch {
          // Already closed.
        }
      }
      watchers.clear()
      server.close()
    }
  }
}
