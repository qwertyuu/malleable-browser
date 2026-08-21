import type { Adaptations } from './adaptations.js'
import type { Bubbles } from './bubbles.js'
import type { Bubble, EditTier } from '../shared/ipc.js'

export interface JsEdit {
  id: string
  name: string
  code: string
  /** Host this edit belongs to — needed once a bundle spans several. */
  host: string
  tier: EditTier
}

/**
 * What an edit needs from its environment, and therefore where it can run.
 *
 *   0  CSS / self-contained JS      — exports to a userscript AND an extension
 *   1  mal.state / mal.bus          — extension only (needs a background relay)
 *   2  mal.tabs / mal.onPush        — extension only, and degraded: an extension
 *                                     can open tabs but not orchestrate a push
 *   3  hidden tabs, CDP, the agent  — Malleable only, not exportable at all
 *
 * Determined from bubble membership plus a source scan, so an edit that merely
 * mentions `mal` without being in a bubble is still tier 0 (its `mal` is null).
 */
export function classifyEdit(code: string, bubble: Bubble | null): EditTier {
  if (!bubble) return 0
  if (/\bmal\s*\.\s*spawn\b/.test(code)) return 3
  if (/\bmal\s*\.\s*(tabs|onPush)\b/.test(code)) return 2
  if (/\bmal\s*\.\s*(state|bus)\b/.test(code)) return 1
  return 0
}

export const TIER_REASON: Record<EditTier, string> = {
  0: 'self-contained',
  1: 'shares bubble state — needs a background relay, so extension only',
  2: 'drives other tabs — extension only, and push orchestration has no equivalent',
  3: 'needs hidden tabs / raw CDP / the agent — no export target can express this'
}

export interface EditBundle {
  /** Concatenated CSS from every enabled edit with content, '' if none. CSS is
   *  safe to concatenate — a broken rule can't break sibling rules. */
  css: string
  /** Each enabled edit's raw JS, kept SEPARATE (not concatenated) so a syntax
   *  error in one edit can't take down every other edit sharing the artifact. */
  jsEdits: JsEdit[]
  /** Names of the edits included, for descriptions. */
  names: string[]
}

/** Gather a host's currently-ENABLED edits' CSS/JS, ready for export. */
export async function collectEnabledBundle(
  adaptations: Adaptations,
  host: string
): Promise<EditBundle | null> {
  const edits = (await adaptations.listForHost(host)).filter(
    (e) => e.enabled && (e.hasCss || e.hasJs)
  )
  if (edits.length === 0) return null

  const cssParts: string[] = []
  const jsEdits: JsEdit[] = []
  for (const e of edits) {
    const full = await adaptations.getEdit(host, e.id)
    if (!full) continue
    if (full.css.trim()) {
      // Guard against a name containing "*/" from prematurely closing the comment.
      const safeName = full.name.replace(/\*\//g, '* /')
      cssParts.push(`/* ${safeName} */\n${full.css.trim()}`)
    }
    if (full.js.trim()) {
      jsEdits.push({
        id: full.id,
        name: full.name,
        code: full.js.trim(),
        host,
        tier: 0
      })
    }
  }

  return { css: cssParts.join('\n\n'), jsEdits, names: edits.map((e) => e.name) }
}

/** One host's slice of a bundle, so a multi-host artifact can scope per site. */
export interface HostSlice {
  host: string
  css: string
  jsEdits: JsEdit[]
}

export interface BubbleBundle {
  bubble: Bubble
  slices: HostSlice[]
  names: string[]
  /** Edits left out, with the reason — surfaced in the UI, never silent. */
  excluded: { host: string; id: string; name: string; tier: EditTier; reason: string }[]
  /** Highest tier actually included, which decides what the artifact must do. */
  maxTier: EditTier
}

/**
 * Gather every enabled edit across a bubble's hosts, classified by tier, with
 * tier-3 edits excluded because no export target can express them.
 */
export async function collectBubbleBundle(
  adaptations: Adaptations,
  bubbles: Bubbles,
  bubbleId: string
): Promise<BubbleBundle | null> {
  const bubble = await bubbles.get(bubbleId)
  if (!bubble) return null

  const slices: HostSlice[] = []
  const names: string[] = []
  const excluded: BubbleBundle['excluded'] = []
  let maxTier: EditTier = 0

  for (const host of bubble.hosts) {
    const cssParts: string[] = []
    const jsEdits: JsEdit[] = []
    for (const e of await adaptations.listForHost(host)) {
      if (!e.enabled || (!e.hasCss && !e.hasJs)) continue
      const full = await adaptations.getEdit(host, e.id)
      if (!full) continue

      // Only edits actually IN this bubble get its capabilities; others on the
      // same host are ordinary tier-0 edits and still belong in the artifact.
      const owner = await bubbles.bubbleForEdit(host, e.id)
      const inThis = owner?.id === bubble.id
      const tier = classifyEdit(full.js, inThis ? bubble : null)

      if (tier === 3) {
        excluded.push({ host, id: full.id, name: full.name, tier, reason: TIER_REASON[3] })
        continue
      }
      names.push(full.name)
      if (full.css.trim()) {
        cssParts.push(`/* ${full.name.replace(/\*\//g, '* /')} */\n${full.css.trim()}`)
      }
      if (full.js.trim()) {
        jsEdits.push({ id: full.id, name: full.name, code: full.js.trim(), host, tier })
      }
      if (tier > maxTier) maxTier = tier
    }
    if (cssParts.length || jsEdits.length) {
      slices.push({ host, css: cssParts.join('\n\n'), jsEdits })
    }
  }

  if (!slices.length) return null
  return { bubble, slices, names, excluded, maxTier }
}

/**
 * Wrap one edit's JS as a standalone, guarded script body: `name` is embedded
 * via JSON.stringify so any character (quotes, backticks, newlines) in an
 * edit's name can never break out of the generated source.
 */
export function wrapEditJs(name: string, code: string): string {
  return `try {\n${code}\n} catch (e) { console.error(${JSON.stringify(`[${name}]`)}, e) }`
}
