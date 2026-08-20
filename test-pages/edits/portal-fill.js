// FILL edit — belongs on portal.localhost, in the "Timesheets" bubble.
//
// Watches the bubble for timesheet rows the tracker put there and offers a button
// that enters them into this portal's form. The mapping is the real work: this
// site wants project CODES, MM/DD/YYYY dates and H:MM durations, none of which
// match the tracker's names, ISO dates and decimal hours.
if (!mal) return

// Tracker project name -> this portal's project code.
const CODE = {
  'Website Redesign': 'WR-2024',
  'Mobile App': 'MOB-2024',
  'Internal Tools': 'INT-2024',
  'Client Support': 'SUP-2024'
}

const toUsDate = (isoDate) => {
  const [y, m, d] = isoDate.split('-')
  return m && d && y ? `${m}/${d}/${y}` : ''
}

const toHm = (hours) => {
  const mins = Math.round(Number(hours) * 60)
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`
}

/** Entries already in this portal's ledger, so a re-run doesn't double-enter. */
const alreadyEntered = () =>
  new Set(
    [...document.querySelectorAll('tr.ledger-entry')].map(
      (tr) => `${tr.dataset.date}|${tr.dataset.code}`
    )
  )

/** Drive the site's own form for one row, honouring its validation. */
function submitRow(row) {
  const code = CODE[row.project]
  if (!code) return { ok: false, why: `no code for project "${row.project}"` }

  const set = (id, value) => {
    const el = document.getElementById(id)
    el.value = value
    // Real events, so a framework-driven form would notice too.
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  set('wDate', toUsDate(row.date))
  set('pCode', code)
  set('dur', toHm(row.hours))
  set('desc', row.note || 'Work performed')

  document.getElementById('entry').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true })
  )
  const err = document.getElementById('err').textContent.trim()
  return err ? { ok: false, why: err } : { ok: true }
}

// ---- The panel ----
const panel = document.createElement('div')
panel.style.cssText =
  'position:fixed;right:16px;bottom:16px;z-index:9999;width:250px;background:#fff;' +
  'border:1px solid #b0bec5;border-radius:4px;box-shadow:0 4px 14px #0003;' +
  'font:12px Verdana,sans-serif;padding:12px'
const title = document.createElement('div')
title.style.cssText = 'font-weight:700;margin-bottom:6px;color:#b71c1c'
title.textContent = '✦ ' + mal.bubble.name
const info = document.createElement('div')
info.style.cssText = 'color:#546e7a;margin-bottom:9px;line-height:1.45'
const btn = document.createElement('button')
btn.style.cssText =
  'width:100%;font:inherit;padding:6px;background:#b71c1c;color:#fff;border:none;' +
  'border-radius:2px;cursor:pointer'
const out = document.createElement('div')
out.style.cssText = 'margin-top:8px;color:#546e7a;line-height:1.45'
panel.append(title, info, btn, out)
document.body.appendChild(panel)

let sheet = null

function render() {
  if (!sheet || !sheet.rows?.length) {
    info.textContent = 'No timesheet in the bubble yet. Fill one in the tracker.'
    btn.style.display = 'none'
    return
  }
  const done = alreadyEntered()
  const pending = sheet.rows.filter((r) => !done.has(`${toUsDate(r.date)}|${CODE[r.project]}`))
  const total = sheet.rows.reduce((a, r) => a + Number(r.hours), 0)
  info.textContent = `Week of ${sheet.week} — ${sheet.rows.length} rows, ${
    Math.round(total * 100) / 100
  } h. ${pending.length} not yet entered.`
  btn.style.display = pending.length ? 'block' : 'none'
  btn.textContent = `Fill ${pending.length} ${pending.length === 1 ? 'entry' : 'entries'}`
}

btn.addEventListener('click', () => {
  const done = alreadyEntered()
  const pending = sheet.rows.filter((r) => !done.has(`${toUsDate(r.date)}|${CODE[r.project]}`))
  const failed = []
  let ok = 0
  for (const row of pending) {
    const res = submitRow(row)
    if (res.ok) ok++
    else failed.push(`${row.date}: ${res.why}`)
  }
  out.textContent = `Entered ${ok}/${pending.length}.` + (failed.length ? ' ' + failed.join('; ') : '')
  render()
  // Let the rest of the bubble know this destination is done.
  void mal.bus.publish('filled', { host: location.host, entered: ok, failed: failed.length })
})

// Live: the panel updates the moment the tracker writes, with no reload.
mal.state.watch('timesheet', (v) => {
  sheet = v
  render()
})

void mal.state
  .get('timesheet')
  .then((v) => {
    sheet = v
    render()
  })
  .catch((e) => {
    info.textContent = 'Could not reach the bubble: ' + e.message
  })
