// EXTRACT edit — belongs on tracker.localhost, in the "Timesheets" bubble.
//
// Reads the week's rows out of the tracker and writes them to the bubble, where
// every other site in the bubble can read them. Writes on load and again whenever
// the tracker fires its own save event, so the bubble is never stale.
//
// `mal` is null when this edit isn't in a bubble — always guard.
if (!mal) return

const weekOf = () => document.getElementById('week-id')?.dataset.week || 'current'

// The tracker mirrors normalized values onto data-* attributes, so read those
// rather than reverse-engineering the inputs.
const readRows = () =>
  [...document.querySelectorAll('tr.entry')]
    .map((tr) => ({
      date: tr.dataset.date || '',
      project: tr.dataset.project || '',
      hours: Number(tr.dataset.hours || 0),
      note: tr.dataset.note || ''
    }))
    .filter((r) => r.date && r.hours > 0)

let lastSent = ''

async function push(reason) {
  const payload = { week: weekOf(), rows: readRows(), source: location.host, at: Date.now() }
  // Skip no-op writes so watchers on other sites don't churn.
  const sig = JSON.stringify(payload.rows)
  if (sig === lastSent) return
  lastSent = sig
  try {
    await mal.state.set('timesheet', payload)
    console.log('[timesheet] pushed', payload.rows.length, 'rows to bubble (' + reason + ')')
  } catch (e) {
    console.error('[timesheet] push failed', e)
  }
}

// The tracker emits this on save; far better than polling the DOM.
document.addEventListener('timesheet:saved', () => void push('saved'))

// Also catch inline edits that never get an explicit save.
let t = null
document.addEventListener('input', () => {
  clearTimeout(t)
  t = setTimeout(() => void push('edited'), 800)
})

void push('load')

// A small status chip, so it's visible that the bubble is receiving data.
const chip = document.createElement('div')
chip.style.cssText =
  'position:fixed;right:14px;bottom:14px;z-index:9999;background:#17324d;color:#fff;' +
  'font:12px -apple-system,sans-serif;padding:6px 10px;border-radius:14px;opacity:.9'
chip.textContent = '✦ ' + mal.bubble.name
chip.title = 'Sharing with: ' + mal.bubble.hosts.join(', ')
document.body.appendChild(chip)
