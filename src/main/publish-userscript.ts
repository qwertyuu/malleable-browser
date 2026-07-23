import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Adaptations } from './adaptations.js'
import { collectEnabledBundle, wrapEditJs } from './edit-bundle.js'
import type { PublishResult } from '../shared/ipc.js'

/**
 * Package a site's currently-ENABLED edits into a single, standard userscript
 * (`@grant none` so it runs unsandboxed in the page, like our own injector).
 * Anyone with Tampermonkey/Violentmonkey/Greasemonkey installs it by opening
 * the file — no zip, no "Load unpacked", trivial to email/AirDrop/Slack.
 *
 * Each edit's JS runs directly in the userscript's own top-level scope
 * (concatenated, not split into dynamically-created <script> elements): a
 * `@grant none` userscript is injected by the manager's own privileged
 * mechanism, which is exempt from the page's CSP — but any ADDITIONAL
 * `<script>` element created and inserted BY that code is ordinary DOM
 * manipulation and IS subject to the page's `script-src`. Sites with a
 * strict CSP (no `unsafe-inline`, no matching nonce — common on
 * security-conscious sites) silently block such nested script insertion, so
 * splitting edits into separate injected `<script>` tags looked like better
 * isolation but actually broke every edit's JS on those sites. One edit's
 * syntax error can again affect its siblings here, but that's the safer
 * trade-off since it only matters if an edit is genuinely malformed.
 */
export async function publishHostAsUserscript(
  adaptations: Adaptations,
  workspaceRoot: string,
  host: string
): Promise<PublishResult> {
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) {
    return { ok: false, error: `Invalid host: ${host}.` }
  }

  const bundle = await collectEnabledBundle(adaptations, host)
  if (!bundle) {
    return { ok: false, error: `No enabled edits with content for ${host}.` }
  }
  const { css, jsEdits, names } = bundle
  // Header lines are plain text, not JSON — strip newlines so a stray one in
  // an edit's name can't inject a bogus extra @directive into the block.
  const safeNames = names.map((n) => n.replace(/[\r\n]/g, ' ')).join(', ')

  const header = [
    '// ==UserScript==',
    `// @name         ${host} — Malleable mod`,
    '// @namespace    malleable-browser',
    '// @version      1.0.0',
    `// @description  Published from Malleable Browser: ${safeNames}`,
    `// @match        *://${host}/*`,
    '// @run-at       document-end',
    '// @grant        none',
    '// ==/UserScript==',
    ''
  ].join('\n')

  const jsBlocks = jsEdits.map((e) => wrapEditJs(e.name, e.code))

  const body = [
    '(function () {',
    ...(css
      ? [
          `  const css = ${JSON.stringify(css)}`,
          '  const style = document.createElement(\'style\')',
          '  style.textContent = css',
          '  document.documentElement.appendChild(style)',
          ''
        ]
      : []),
    ...(jsBlocks.length ? [jsBlocks.join('\n\n'), ''] : []),
    '})()',
    ''
  ].join('\n')

  const dir = join(workspaceRoot, 'published')
  await fs.mkdir(dir, { recursive: true })
  const filePath = join(dir, `${host}.user.js`)
  await fs.writeFile(filePath, header + body, 'utf8')

  return { ok: true, filePath }
}
