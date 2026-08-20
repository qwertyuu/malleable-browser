import type { Session } from 'electron'

type Log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, data?: unknown) => void

/**
 * Let bubble-member pages reach the bubble server, and only them.
 *
 * A site sending `Content-Security-Policy: connect-src 'self'` blocks page JS
 * from fetching localhost at all — and locked-down enterprise portals, exactly
 * the systems this feature exists for, routinely do. So for hosts that are in a
 * bubble we append the bubble server's origin to the directives that would
 * otherwise refuse it.
 *
 * This is deliberately narrow, and worth being precise about:
 *   - Only hosts in a bubble are touched. Everything else keeps its CSP verbatim.
 *   - Only `connect-src`/`default-src` are touched, and only by APPENDING one
 *     exact origin. `script-src`, `frame-src`, `style-src` and the rest are left
 *     alone, so this cannot enable inline script or third-party code.
 *   - It grants the page the ability to talk to one localhost port. It grants no
 *     reach toward Node, the filesystem, or the browser — unlike a preload.
 *
 * Report-only headers are rewritten the same way so a site's own CSP telemetry
 * doesn't fill with violations the user deliberately allowed.
 */
export function installCspRelaxation(deps: {
  session: Session
  /** Bubble server origin, e.g. http://127.0.0.1:53311 */
  endpoint: string
  /** Whether this hostname belongs to any bubble. */
  isBubbleHost: (hostname: string) => boolean
  log: Log
}): void {
  const { session, endpoint, isBubbleHost, log } = deps

  session.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders
    if (!headers) {
      callback({})
      return
    }
    let hostname: string
    try {
      hostname = new URL(details.url).hostname
    } catch {
      callback({})
      return
    }
    if (!hostname || !isBubbleHost(hostname)) {
      callback({})
      return
    }

    let touched = false
    const out: Record<string, string[]> = {}
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase()
      if (
        lower !== 'content-security-policy' &&
        lower !== 'content-security-policy-report-only'
      ) {
        out[name] = value as string[]
        continue
      }
      out[name] = (value as string[]).map((policy) => {
        const next = relaxPolicy(policy, endpoint)
        if (next !== policy) touched = true
        return next
      })
    }
    if (touched) log('info', 'csp.relaxed', { host: hostname })
    callback({ responseHeaders: out })
  })
}

/**
 * Append `endpoint` to whichever connect-governing directive applies. If a
 * policy has `connect-src`, only that is widened. If it has only `default-src`,
 * a `connect-src` is DERIVED from it and widened, so the original default-src
 * keeps governing every other resource type untouched.
 */
function relaxPolicy(policy: string, endpoint: string): string {
  const parts = policy
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
  const nameOf = (p: string): string => p.split(/\s+/)[0].toLowerCase()

  const connectIdx = parts.findIndex((p) => nameOf(p) === 'connect-src')
  if (connectIdx >= 0) {
    if (parts[connectIdx].includes(endpoint)) return policy
    parts[connectIdx] = `${parts[connectIdx]} ${endpoint}`
    return parts.join('; ')
  }

  const defaultIdx = parts.findIndex((p) => nameOf(p) === 'default-src')
  if (defaultIdx >= 0) {
    const sources = parts[defaultIdx].split(/\s+/).slice(1).join(' ')
    parts.push(`connect-src ${sources} ${endpoint}`.trim())
    return parts.join('; ')
  }

  // No directive governs connect — the policy never restricted it. Leave it be.
  return policy
}

/** Exported for testing the directive rewriting in isolation. */
export const __relaxPolicyForTest = relaxPolicy
