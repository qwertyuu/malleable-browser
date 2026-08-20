// Dependency-free static server for the mock timesheet pages.
//
// Why Host-header routing on ONE port instead of two ports: Adaptations.slugFor is
// `new URL(url).hostname`, which ignores the port. Two ports on 127.0.0.1 would
// collapse to the SAME host slug, so both pages would share one adaptation folder
// and the cross-tab scenario would have nothing to cross. Chromium resolves any
// *.localhost name to loopback (RFC 6761), so tracker.localhost and
// portal.localhost are distinct origins with no /etc/hosts entry needed.
//
//   node test-pages/serve.mjs [port]
//     http://tracker.localhost:<port>/   → tracker.html  (source system)
//     http://portal.localhost:<port>/    → portal.html   (destination system)
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] ?? 4310)

// Subdomain -> file. Add another entry to add another destination system.
const SITES = {
  tracker: 'tracker.html',
  portal: 'portal.html'
}

createServer(async (req, res) => {
  const host = (req.headers.host ?? '').split(':')[0].toLowerCase()
  const site = host.split('.')[0]
  const file = SITES[site]
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(
      `Unknown site "${host}".\n\nTry:\n` +
        Object.keys(SITES)
          .map((s) => `  http://${s}.localhost:${PORT}/`)
          .join('\n') +
        '\n'
    )
    return
  }
  try {
    const body = await readFile(join(HERE, file))
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(body)
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(String(err?.message ?? err))
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log('mock timesheet systems:')
  for (const s of Object.keys(SITES)) console.log(`  http://${s}.localhost:${PORT}/`)
})
