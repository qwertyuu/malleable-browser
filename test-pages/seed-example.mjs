// Install the worked timesheet example into the app's workspace:
// the extract/fill edit pair plus the bubble that lets them talk.
//
//   npm run seed-example
//
// Then: npm run test-pages, and open the two sites in the browser.
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// Mirrors main/index.ts: MALLEABLE_WORKSPACE, else userData/workspace.
function defaultWorkspace() {
  if (process.env.MALLEABLE_WORKSPACE) return process.env.MALLEABLE_WORKSPACE
  const app = 'malleable-browser'
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', app, 'workspace')
  if (process.platform === 'win32')
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), app, 'workspace')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), app, 'workspace')
}

const WS = process.argv[2] ?? defaultWorkspace()

const EDITS = [
  {
    host: 'tracker.localhost',
    id: 'extract-hours',
    name: 'Extract hours',
    kind: 'functionality',
    file: 'tracker-extract.js'
  },
  {
    host: 'portal.localhost',
    id: 'fill-portal',
    name: 'Fill from Malleable',
    kind: 'functionality',
    file: 'portal-fill.js'
  }
]

const now = Date.now()

for (const e of EDITS) {
  const dir = join(WS, 'adaptations', e.host, e.id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'overlay.js'), await readFile(join(HERE, 'edits', e.file), 'utf8'))
  await writeFile(
    join(dir, 'meta.json'),
    JSON.stringify(
      { id: e.id, name: e.name, kind: e.kind, enabled: true, createdAt: now, updatedAt: now },
      null,
      2
    )
  )
  console.log(`edit  ${e.host}/${e.id}`)
}

// The bubble. Written directly rather than through the consent flow, since
// seeding IS the user explicitly asking for it.
await mkdir(join(WS, 'bubbles'), { recursive: true })
await writeFile(
  join(WS, 'bubbles', 'timesheets.json'),
  JSON.stringify(
    {
      id: 'timesheets',
      name: 'Timesheets',
      hosts: ['tracker.localhost', 'portal.localhost'],
      edits: EDITS.map((e) => ({ host: e.host, editId: e.id })),
      createdAt: now,
      updatedAt: now
    },
    null,
    2
  )
)
console.log('bubble  timesheets (tracker.localhost, portal.localhost)')
console.log(`\nworkspace: ${WS}`)
console.log('\nNext:\n  npm run test-pages     # serve the two mock systems')
console.log('  npm run dev            # restart so the bubble is picked up')
console.log('  → open http://tracker.localhost:4310/ and http://portal.localhost:4310/')
