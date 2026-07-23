import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Adaptations } from './adaptations.js'
import { collectEnabledBundle, wrapEditJs } from './edit-bundle.js'
import { buildZip } from './zip.js'
import type { PublishResult } from '../shared/ipc.js'

/**
 * Package a site's currently-ENABLED edits into a standalone Chrome (MV3)
 * extension: one content script scoped to that host, bundling every enabled
 * edit's CSS/JS. Nothing is fetched remotely — the mod is baked in at publish
 * time — so the result is store-review-friendly, unlike a Tampermonkey-style
 * loader that pulls code at runtime. Each edit gets its OWN js file (listed
 * separately in the manifest) so a syntax error in one edit can't take the
 * others down with it — MV3 loads/runs each listed file independently.
 */
export async function publishHostAsExtension(
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
  const { css, jsEdits, names: editNames } = bundle
  const names = editNames.join(', ')
  const jsFiles = jsEdits.map((e) => `overlay-${e.id}.js`)

  const contentScript: Record<string, unknown> = {
    matches: [`*://${host}/*`],
    run_at: 'document_end'
  }
  if (css) contentScript.css = ['overlay.css']
  if (jsFiles.length) {
    contentScript.js = jsFiles
    // Runs in the page's own JS context (matches how the browser's injector
    // uses executeJavaScript), not the isolated world content scripts get by
    // default — needed for edits that touch the page's own globals/functions.
    contentScript.world = 'MAIN'
  }

  const manifest = {
    manifest_version: 3,
    name: `${host} — Malleable mod`.slice(0, 75),
    version: '1.0.0',
    description: `Published from Malleable Browser: ${names}`.slice(0, 132),
    content_scripts: [contentScript]
  }

  const dir = join(workspaceRoot, 'published', host)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  if (css) await fs.writeFile(join(dir, 'overlay.css'), css, 'utf8')
  else await fs.rm(join(dir, 'overlay.css'), { force: true })

  // Clear out any previously-published per-edit js files before writing the
  // current set, so a since-deleted edit doesn't leave a stale file behind.
  const existing = await fs.readdir(dir).catch(() => [] as string[])
  await Promise.all(
    existing
      .filter((f) => /^overlay-.+\.js$/.test(f) && !jsFiles.includes(f))
      .map((f) => fs.rm(join(dir, f), { force: true }))
  )
  for (const e of jsEdits) {
    await fs.writeFile(join(dir, `overlay-${e.id}.js`), wrapEditJs(e.name, e.code), 'utf8')
  }

  const zipEntries = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }
  ]
  if (css) zipEntries.push({ name: 'overlay.css', data: Buffer.from(css, 'utf8') })
  for (const e of jsEdits) {
    zipEntries.push({
      name: `overlay-${e.id}.js`,
      data: Buffer.from(wrapEditJs(e.name, e.code), 'utf8')
    })
  }

  const zipPath = join(workspaceRoot, 'published', `${host}.zip`)
  await fs.writeFile(zipPath, buildZip(zipEntries))

  return { ok: true, zipPath, dir }
}
