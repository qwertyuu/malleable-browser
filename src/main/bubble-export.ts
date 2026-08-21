import type { BubbleBundle, JsEdit } from './edit-bundle.js'

/**
 * Code generation for exporting a bubble as a Chrome MV3 extension.
 *
 * The browser backs `mal` with a localhost server, which a shipped extension
 * obviously can't include. So the exported artifact reimplements the same API on
 * MV3 primitives, and three constraints shape the result:
 *
 *  1. A MAIN-world content script CANNOT call `chrome.runtime.*` — those APIs
 *     only exist in the isolated world. Edits run in MAIN (matching the app's
 *     executeJavaScript semantics), so every message has to hop
 *     MAIN → window.postMessage → ISOLATED → chrome.runtime → service worker.
 *  2. The MV3 service worker is killed after ~30s idle, so it may route but must
 *     hold no state. State lives in chrome.storage.local.
 *  3. `chrome.storage.onChanged` fires in every context, which is what makes
 *     live cross-tab updates work at all — it replaces the SSE stream.
 */

/** Isolated-world half of the bridge: the only context that can reach chrome.*. */
export function buildIsolatedBridge(bubbleId: string): string {
  return `// Isolated-world bridge. Required, not optional: the MAIN-world edit code
// cannot call chrome.runtime.* at all, so this is the only side that can.
(function () {
  var NS = ${JSON.stringify('mal:' + bubbleId)}
  var KEY = ${JSON.stringify('malbubble:' + bubbleId)}

  function reply(id, ok, value, error) {
    window.postMessage({ __malReply: id, ok: ok, value: value, error: error }, '*')
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return
    var m = ev.data
    if (!m || m.__malNs !== NS) return
    var id = m.id
    try {
      if (m.op === 'get') {
        chrome.storage.local.get(KEY, function (r) {
          reply(id, true, (r[KEY] || {}))
        })
      } else if (m.op === 'set') {
        chrome.storage.local.get(KEY, function (r) {
          var data = r[KEY] || {}
          if (m.value === null || m.value === undefined) delete data[m.key]
          else data[m.key] = m.value
          var patch = {}
          patch[KEY] = data
          chrome.storage.local.set(patch, function () { reply(id, true, { ok: true }) })
        })
      } else if (m.op === 'publish') {
        // Ephemeral: relayed through the worker, never stored.
        chrome.runtime.sendMessage({ ns: NS, kind: 'publish', ch: m.ch, value: m.value },
          function () { reply(id, true, { ok: true }) })
      } else if (m.op === 'tabs') {
        chrome.runtime.sendMessage({ ns: NS, kind: 'tabs' }, function (r) {
          reply(id, true, (r && r.tabs) || [])
        })
      } else if (m.op === 'ensure') {
        chrome.runtime.sendMessage({ ns: NS, kind: 'ensure', host: m.host }, function (r) {
          reply(id, true, r || { ok: false })
        })
      } else {
        reply(id, false, null, 'unknown op ' + m.op)
      }
    } catch (e) {
      reply(id, false, null, String((e && e.message) || e))
    }
  })

  // State changes: chrome.storage.onChanged fires in EVERY context, which is what
  // replaces the browser's SSE stream and makes live updates work.
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes[KEY]) return
    var oldV = changes[KEY].oldValue || {}
    var newV = changes[KEY].newValue || {}
    var keys = {}
    Object.keys(oldV).concat(Object.keys(newV)).forEach(function (k) { keys[k] = 1 })
    Object.keys(keys).forEach(function (k) {
      if (JSON.stringify(oldV[k]) === JSON.stringify(newV[k])) return
      window.postMessage({ __malEvent: 'state', ns: NS, key: k, value: newV[k] }, '*')
    })
  })

  // Ephemeral fan-out arrives from the worker.
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.ns !== NS || msg.kind !== 'bus') return
    window.postMessage({ __malEvent: 'bus', ns: NS, ch: msg.ch, value: msg.value }, '*')
  })
})()
`
}

/** MAIN-world shim: same `mal` surface, over postMessage instead of fetch. */
export function buildMainShim(bubbleId: string, bubbleName: string, hosts: string[]): string {
  return `// MAIN-world shim. Presents the same \`mal\` API the Malleable Browser injects,
// but over window.postMessage to the isolated-world bridge, since this context
// has no access to chrome.* APIs.
(function () {
  var NS = ${JSON.stringify('mal:' + bubbleId)}
  var seq = 0
  var waiting = {}
  var handlers = { state: {}, bus: {} }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return
    var m = ev.data
    if (!m) return
    if (m.__malReply != null && waiting[m.__malReply]) {
      var w = waiting[m.__malReply]
      delete waiting[m.__malReply]
      if (m.ok) w.resolve(m.value)
      else w.reject(new Error(m.error || 'bubble error'))
      return
    }
    if (m.__malEvent && m.ns === NS) {
      var map = m.__malEvent === 'state' ? handlers.state : handlers.bus
      var key = m.__malEvent === 'state' ? m.key : m.ch
      var list = (map[key] || []).concat(map['*'] || [])
      for (var i = 0; i < list.length; i++) {
        try { list[i](m.value, key) } catch (e) { console.error('[mal watcher]', e) }
      }
    }
  })

  function call(op, extra) {
    var id = ++seq
    var msg = { __malNs: NS, id: id, op: op }
    for (var k in extra) msg[k] = extra[k]
    return new Promise(function (resolve, reject) {
      waiting[id] = { resolve: resolve, reject: reject }
      window.postMessage(msg, '*')
      setTimeout(function () {
        if (waiting[id]) { delete waiting[id]; reject(new Error('bubble timeout')) }
      }, 10000)
    })
  }

  var API = {
    bubble: { id: ${JSON.stringify(bubbleId)}, name: ${JSON.stringify(bubbleName)}, hosts: ${JSON.stringify(hosts)} },
    state: {
      all: function () { return call('get') },
      get: function (k) { return call('get').then(function (s) { return s[k] }) },
      set: function (k, v) { return call('set', { key: k, value: v === undefined ? null : v }) },
      remove: function (k) { return call('set', { key: k, value: null }) },
      watch: function (k, fn) {
        (handlers.state[k] = handlers.state[k] || []).push(fn)
        return function () {
          handlers.state[k] = (handlers.state[k] || []).filter(function (f) { return f !== fn })
        }
      }
    },
    bus: {
      publish: function (ch, v) { return call('publish', { ch: ch, value: v === undefined ? null : v }) },
      subscribe: function (ch, fn) {
        (handlers.bus[ch] = handlers.bus[ch] || []).push(fn)
        return function () {
          handlers.bus[ch] = (handlers.bus[ch] || []).filter(function (f) { return f !== fn })
        }
      }
    },
    tabs: {
      list: function () { return call('tabs') },
      ensure: function (host) { return call('ensure', { host: host }) }
    }
  }

  // onPush has NO driver in an extension: nothing plays the part the browser's
  // push orchestrator plays. The handler is still registered so a manual write to
  // __push works, but there is no "push to all" action out here.
  API.onPush = function (fn) {
    return API.state.watch('__push', function (v) {
      if (!v || !v.id) return
      var host = location.hostname
      Promise.resolve()
        .then(function () { return fn(v) })
        .then(function (r) {
          r = r || {}
          return API.state.set('__result:' + host, {
            id: v.id, ok: r.ok !== false, entered: r.entered || 0,
            failed: r.failed || 0, message: r.message
          })
        })
        .catch(function (e) {
          return API.state.set('__result:' + host, {
            id: v.id, ok: false, entered: 0, failed: 0, message: String((e && e.message) || e)
          })
        })
    })
  }

  window.__malBubble = API
})()
`
}

/** Service worker: routes ephemeral messages and tab requests. Holds no state. */
export function buildServiceWorker(bubbleId: string, hosts: string[]): string {
  return `// MV3 service worker. Terminated after ~30s idle, so it ROUTES but holds no
// state — persistent state lives in chrome.storage.local, written by the
// isolated-world bridge and observed via chrome.storage.onChanged.
var NS = ${JSON.stringify('mal:' + bubbleId)}
var HOSTS = ${JSON.stringify(hosts)}

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  if (!msg || msg.ns !== NS) return

  if (msg.kind === 'publish') {
    // Fan out to every bubble tab except the sender.
    chrome.tabs.query({}, function (tabs) {
      tabs.forEach(function (t) {
        if (!t.id || (sender.tab && t.id === sender.tab.id)) return
        var h = ''
        try { h = new URL(t.url || '').hostname } catch (e) { return }
        if (HOSTS.indexOf(h) === -1) return
        chrome.tabs.sendMessage(t.id, { ns: NS, kind: 'bus', ch: msg.ch, value: msg.value }, function () {
          void chrome.runtime.lastError
        })
      })
      respond({ ok: true })
    })
    return true
  }

  if (msg.kind === 'tabs') {
    chrome.tabs.query({}, function (tabs) {
      respond({
        tabs: tabs
          .map(function (t) {
            var h = ''
            try { h = new URL(t.url || '').hostname } catch (e) { h = '' }
            return { id: String(t.id), host: h, title: t.title || '', hidden: false, active: !!t.active }
          })
          .filter(function (t) { return HOSTS.indexOf(t.host) !== -1 })
      })
    })
    return true
  }

  if (msg.kind === 'ensure') {
    if (HOSTS.indexOf(msg.host) === -1) { respond({ ok: false }); return }
    chrome.tabs.query({}, function (tabs) {
      var found = tabs.find(function (t) {
        try { return new URL(t.url || '').hostname === msg.host } catch (e) { return false }
      })
      if (found && found.id) {
        chrome.tabs.update(found.id, { active: true }, function () { respond({ ok: true, tab: String(found.id) }) })
      } else {
        chrome.tabs.create({ url: 'https://' + msg.host + '/', active: false }, function (t) {
          respond({ ok: true, tab: t && t.id ? String(t.id) : null })
        })
      }
    })
    return true
  }
})
`
}

/**
 * The edits' own JS, wrapped so `mal` resolves to the exported shim. Waits for
 * the shim to appear rather than assuming file order, since MV3 gives no
 * ordering guarantee across worlds.
 */
export function wrapExportedEdit(edit: JsEdit): string {
  return `(function () {
  function run(mal) {
    try {
${edit.code}
    } catch (e) {
      console.error(${JSON.stringify(`[${edit.name}]`)}, e)
    }
  }
  // The MAIN-world shim is a separate file; don't assume it ran first.
  if (window.__malBubble) return run(window.__malBubble)
  var tries = 0
  var t = setInterval(function () {
    if (window.__malBubble || ++tries > 100) {
      clearInterval(t)
      run(window.__malBubble || null)
    }
  }, 20)
})()
`
}

/** Caveats to report, so the gap between app and export is never discovered late. */
export function exportCaveats(bundle: BubbleBundle): string[] {
  const out: string[] = []
  if (bundle.maxTier >= 1) {
    out.push(
      'Bubble state is chrome.storage.local, not the app’s bubble server: it is ' +
        'scoped to this extension and does not share data with Malleable Browser.'
    )
    out.push(
      'Membership is enforced by the manifest’s match patterns rather than an Origin ' +
        'check, so any script on a matched page can reach the shim.'
    )
  }
  if (bundle.maxTier >= 2) {
    out.push(
      'push_bubble has no equivalent: mal.onPush handlers are registered but nothing ' +
        'drives them, since the orchestrator lives in the browser.'
    )
    out.push('mal.tabs.ensure can open or focus a tab, but never a hidden worker tab.')
  }
  return out
}
