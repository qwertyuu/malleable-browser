import type { Adaptations } from './adaptations.js'

export interface JsEdit {
  id: string
  name: string
  code: string
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
    if (full.js.trim()) jsEdits.push({ id: full.id, name: full.name, code: full.js.trim() })
  }

  return { css: cssParts.join('\n\n'), jsEdits, names: edits.map((e) => e.name) }
}

/**
 * Wrap one edit's JS as a standalone, guarded script body: `name` is embedded
 * via JSON.stringify so any character (quotes, backticks, newlines) in an
 * edit's name can never break out of the generated source.
 */
export function wrapEditJs(name: string, code: string): string {
  return `try {\n${code}\n} catch (e) { console.error(${JSON.stringify(`[${name}]`)}, e) }`
}
