import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Adaptations } from './adaptations.js'
import { collectEnabledBundle, collectBubbleBundle, wrapEditJs, TIER_REASON } from './edit-bundle.js'
import {
  buildIsolatedBridge,
  buildMainShim,
  buildServiceWorker,
  wrapExportedEdit,
  exportCaveats
} from './bubble-export.js'
import type { Bubbles } from './bubbles.js'
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


/**
 * Package a whole BUBBLE as one MV3 extension: every host it spans, and the
 * plumbing that gives its edits a working `mal` outside this browser.
 *
 * Cross-site edits are extension-only by design — a userscript has no background
 * context to relay through. Tier-3 edits (hidden tabs, raw CDP, the agent) are
 * excluded outright and named in the report, since nothing here can express them.
 */
export async function publishBubbleAsExtension(
  adaptations: Adaptations,
  bubbles: Bubbles,
  workspaceRoot: string,
  bubbleId: string
): Promise<PublishResult> {
  if (!/^[a-zA-Z0-9._-]+$/.test(bubbleId)) {
    return { ok: false, error: `Invalid bubble id: ${bubbleId}.` }
  }
  const bundle = await collectBubbleBundle(adaptations, bubbles, bubbleId)
  if (!bundle) {
    return { ok: false, error: `No enabled edits with content in bubble "${bubbleId}".` }
  }
  const { bubble, slices, names, excluded, maxTier } = bundle
  for (const h of bubble.hosts) {
    if (!/^[a-zA-Z0-9.-]+$/.test(h)) return { ok: false, error: `Invalid host in bubble: ${h}.` }
  }

  const needsBridge = maxTier >= 1
  const files: { name: string; data: string }[] = []
  const contentScripts: Record<string, unknown>[] = []

  if (needsBridge) {
    files.push({ name: 'mal-bridge-iso.js', data: buildIsolatedBridge(bubble.id) })
    files.push({
      name: 'mal-shim.js',
      data: buildMainShim(bubble.id, bubble.name, bubble.hosts)
    })
    files.push({ name: 'sw.js', data: buildServiceWorker(bubble.id, bubble.hosts) })
  }

  for (const slice of slices) {
    const match = `*://${slice.host}/*`
    if (slice.css) {
      const cssFile = `css/${slice.host}.css`
      files.push({ name: cssFile, data: slice.css })
      contentScripts.push({ matches: [match], run_at: 'document_end', css: [cssFile] })
    }
    if (slice.jsEdits.length) {
      // The isolated half must exist before MAIN-world code tries to talk to it.
      if (needsBridge) {
        contentScripts.push({
          matches: [match],
          run_at: 'document_start',
          js: ['mal-bridge-iso.js'],
          world: 'ISOLATED'
        })
      }
      const mainJs: string[] = []
      if (needsBridge) mainJs.push('mal-shim.js')
      for (const e of slice.jsEdits) {
        const f = `js/${slice.host}.${e.id}.js`
        // Bubble members get the shim-aware wrapper; plain edits keep the simple one.
        files.push({
          name: f,
          data: e.tier >= 1 ? wrapExportedEdit(e) : wrapEditJs(e.name, e.code)
        })
        mainJs.push(f)
      }
      contentScripts.push({
        matches: [match],
        run_at: 'document_end',
        js: mainJs,
        // MAIN mirrors how the browser injects edits (executeJavaScript).
        world: 'MAIN'
      })
    }
  }

  const manifest: Record<string, unknown> = {
    manifest_version: 3,
    name: `${bubble.name} — Malleable bubble`.slice(0, 75),
    version: '1.0.0',
    description: `Published from Malleable Browser: ${names.join(', ')}`.slice(0, 132),
    content_scripts: contentScripts
  }
  if (needsBridge) {
    manifest.background = { service_worker: 'sw.js' }
    // storage for bubble state; tabs for mal.tabs.list/ensure.
    manifest.permissions = maxTier >= 2 ? ['storage', 'tabs'] : ['storage']
    manifest.host_permissions = bubble.hosts.map((h) => `*://${h}/*`)
  }

  const dir = join(workspaceRoot, 'published', `bubble-${bubble.id}`)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(join(dir, 'js'), { recursive: true })
  await fs.mkdir(join(dir, 'css'), { recursive: true })
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  for (const f of files) await fs.writeFile(join(dir, f.name), f.data, 'utf8')

  const zipEntries = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    ...files.map((f) => ({ name: f.name, data: Buffer.from(f.data, 'utf8') }))
  ]
  const zipPath = join(workspaceRoot, 'published', `bubble-${bubble.id}.zip`)
  await fs.writeFile(zipPath, buildZip(zipEntries))

  return {
    ok: true,
    zipPath,
    dir,
    report: {
      // Every edit that shipped, including CSS-only ones (which have no jsEdit).
      included: names
        .filter((n) => !excluded.some((x) => x.name === n))
        .map((n) => {
          const js = slices.flatMap((sl) => sl.jsEdits.map((e) => ({ ...e, h: sl.host }))).find((e) => e.name === n)
          return {
            host: js?.h ?? (slices.find((sl) => sl.css)?.host ?? bubble.hosts[0]),
            name: n,
            tier: js?.tier ?? (0 as const)
          }
        }),
      excluded: excluded.map((e) => ({
        host: e.host,
        name: e.name,
        tier: e.tier,
        reason: e.reason
      })),
      caveats: exportCaveats(bundle)
    }
  }
}
