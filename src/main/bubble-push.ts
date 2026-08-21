import type { Bubble, BubblePushResult } from '../shared/ipc.js'

type Log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, data?: unknown) => void

/** Reserved bubble state keys. The `__` prefix marks the push protocol. */
export const PUSH_KEY = '__push'
export const resultKey = (host: string): string => `__result:${host}`

const DEFAULT_TIMEOUT = 20_000
const POLL_MS = 250

export interface PushDeps {
  setState: (bubbleId: string, key: string, value: unknown) => Promise<void>
  getState: (bubbleId: string, key: string) => Promise<unknown>
  /** Open or focus a tab for a host and resolve once its edits are injected. */
  ensureTab: (host: string, hidden: boolean) => Promise<string | null>
  closeTab: (tabId: string) => void
  log: Log
}

/**
 * Push-to-all: one action drives every destination in a bubble.
 *
 * The mechanism is deliberately NOT cross-tab code execution. Main opens (or
 * focuses) a tab per destination and writes a single `__push` request into the
 * bubble's state. Each destination's OWN fill edit is already watching that key,
 * so it runs its own routine and writes back `__result:<host>`. Main just waits
 * and collects.
 *
 * That factoring matters for two reasons. It needs no new privilege — nothing can
 * run code in another site's page. And the edit that knows how to drive a given
 * form is the one that drives it, which is where that knowledge belongs anyway.
 */
export async function pushBubble(
  bubble: Bubble,
  args: { sourceHost?: string; hidden?: boolean; timeoutMs?: number },
  deps: PushDeps
): Promise<BubblePushResult> {
  const { setState, getState, ensureTab, closeTab, log } = deps
  const hidden = args.hidden === true
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT

  // Destinations are every bubble host except the one the data came from.
  const destinations = bubble.hosts.filter((h) => h !== args.sourceHost)
  if (!destinations.length) {
    return { ok: false, error: 'No destination sites in this bubble', results: [] }
  }

  const pushId = `${Date.now()}-${Math.round(Math.random() * 1e6)}`
  // Clear prior answers so a stale result can't be mistaken for a fresh one.
  for (const h of destinations) await setState(bubble.id, resultKey(h), null)

  const opened: string[] = []
  const unreachable: string[] = []
  for (const host of destinations) {
    const tabId = await ensureTab(host, hidden)
    if (tabId) opened.push(tabId)
    else unreachable.push(host)
  }

  await setState(bubble.id, PUSH_KEY, { id: pushId, at: Date.now(), hosts: destinations })
  log('info', 'bubble.push', { bubble: bubble.id, destinations, hidden, pushId })

  // Wait for each destination's own edit to answer.
  const pending = new Set(destinations.filter((h) => !unreachable.includes(h)))
  const results: BubblePushResult['results'] = []
  const deadline = Date.now() + timeoutMs
  while (pending.size && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    for (const host of [...pending]) {
      const raw = (await getState(bubble.id, resultKey(host))) as
        | { id?: string; ok?: boolean; entered?: number; failed?: number; message?: string }
        | undefined
      if (!raw || raw.id !== pushId) continue
      pending.delete(host)
      results.push({
        host,
        ok: raw.ok !== false,
        entered: Number(raw.entered ?? 0),
        failed: Number(raw.failed ?? 0),
        message: raw.message
      })
    }
  }

  // Anything still pending either has no fill edit, or its edit ignores pushes.
  for (const host of pending) {
    results.push({
      host,
      ok: false,
      entered: 0,
      failed: 0,
      message: 'No response — this site may have no edit that handles pushes'
    })
  }
  for (const host of unreachable) {
    results.push({ host, ok: false, entered: 0, failed: 0, message: 'Could not open a tab' })
  }

  // Hidden worker tabs are ours; never leave them lying around.
  if (hidden) for (const id of opened) closeTab(id)

  await setState(bubble.id, PUSH_KEY, null)
  const entered = results.reduce((a, r) => a + r.entered, 0)
  log('info', 'bubble.push.done', { bubble: bubble.id, entered, results })
  return { ok: results.some((r) => r.ok), entered, results }
}
