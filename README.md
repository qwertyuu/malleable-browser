# Malleable Browser

A desktop browser where **the web pages are malleable** — reshape any site on the
fly by asking an agent. Open a page, describe what you want —
*"give this site a clean dark reading mode and hide the ads"* — and the agent
inspects the live page and writes a CSS/JS **edit** that the browser injects.
Edits are saved **per site** as a library of named, individually-toggleable pieces
and re-applied automatically on every visit.

Under the hood it's a custom **[Agent Client Protocol](https://agentclientprotocol.com)
(ACP) client** — the same protocol Zed uses to talk to coding agents — except the
client is a *browser*, driving [Claude](https://www.anthropic.com/claude) via the
`claude-agent-acp` adapter.

> Status: **proof of concept / research prototype.** It works end-to-end and is
> fun, but see [Limitations](#limitations) before relying on it.

---

## What it can do

- **Reshape any page** — the agent writes per-site overlays (CSS for looks, JS for
  behavior) that persist and re-apply per origin.
- **Multiple named edits per site** — a "Dark theme" (theme), "Hide ads" (cleanup)
  and "Extract API" (functionality) can coexist and be toggled independently, by
  you or the agent.
- **A real window into the page** — the agent has live tools: query the DOM, run
  JS, read console + network, take **screenshots it can actually see**, and fetch
  images (multimodal).
- **Emergent capability** — the agent can *scaffold its own tools at runtime*
  (`define_tool`), building a durable harness over a site.
- **Sessions** — start fresh contexts or switch between past ones (resumed via ACP
  `loadSession`); persisted across restarts.
- **Model / permission control** — pick the model (Opus, Sonnet, Haiku, …) and
  permission mode from the Settings tab.
- **Swappable agent** — because it's an ACP *client*, Settings → **Agent command**
  can point it at any ACP agent (blank = the bundled Claude adapter; e.g.
  `gemini --experimental-acp`). Applying restarts the agent. Some features (the
  page-tools MCP server, session resume) depend on optional ACP capabilities the
  bundled adapter supports; other agents may vary.
- **A persona** — the agent has an editable character (`persona.md`; ships as
  "Mu", a calm/zen voice).
- **Full transparency** — the panel streams thinking, tool calls (with args +
  results), and markdown replies; every turn is written to a session logfile.

---

## Architecture

```
Renderer (React + Vite)              Main process (Node)                Workspace (userData, git repo)
┌──────────────────────────┐  IPC   ┌──────────────────────────────┐   adaptations/<host>/<editId>/
│ Chrome: address bar      │◀──────▶│ ACP client ── stdio ──▶ claude│     meta.json + overlay.css/js
│ Adapt · Library · Settings│        │              -agent-acp (agent)│   tools/<name>.json  (scaffolded)
│ Tab strip + WebContentsViews◀─ inject┤ in-process MCP server ◀───────┼── agent tools operate here
└──────────────────────────┘        │ injector (insertCSS/execJS)   │   sessions, logs, persona.md
                                     └──────────────────────────────┘
```

**The malleability loop**

1. You type a request in the **Adapt** panel.
2. Main sends the agent only the page **URL + title** (no HTML dump) plus the list
   of existing edits, and prepends the persona.
3. The agent **inspects the live page** with its MCP tools (`dom_query`, `run_js`,
   `screenshot`, …), then calls **`save_adaptation`** to create/update a named
   edit. The tool writes the edit and reloads the page so the agent can screenshot
   to verify.
4. On every page load, the **injector** applies all *enabled* edits for that
   origin (`webContents.insertCSS` + guarded `executeJavaScript` on `dom-ready`).
5. Main commits a git **checkpoint** in the workspace — but only if the turn
   actually changed something (a plain question commits nothing and doesn't
   reload).

**Why the agent can't wreck the browser:** the agent's ACP working directory is
the **workspace** (see below), not the app source. It literally cannot read or
write the browser's own code.

---

## Project layout

```
src/
  main/                     # Electron main process (Node)
    index.ts                #   window, IPC, wiring
    tabs.ts                 #   TabManager: sandboxed WebContentsViews, one per tab
    acp-client.ts           #   embeds claude-agent-acp, speaks ACP, sessions
    adaptations.ts          #   per-site edit library (CRUD + injector + prompt)
    bubbles.ts              #   bubble membership (groups of sites that may share)
    bubble-server.ts        #   localhost endpoint edits reach via fetch/EventSource
    mal-shim.ts             #   the `mal` handle handed to a bubble-member edit
    csp.ts                  #   widen connect-src for bubble hosts only
    page-inspector.ts       #   DOM/JS/console/network/screenshot backing tools
    page-tools-server.ts    #   in-process MCP server exposing the agent's tools
    cdp-bridge.ts           #   scoped raw CDP-over-WebSocket relay for the page
    dynamic-tools.ts        #   registry for agent-scaffolded tools (tools/*.json)
    sessions.ts             #   session list persistence
    checkpoint.ts           #   git checkpoint / revert in the workspace
    logger.ts               #   per-run session logfile
    persona.ts              #   default persona + persona.md loader
  preload/index.ts          # contextBridge — the only surface the UI can call
  renderer/                 # React chrome (Vite)
    src/App.tsx             #   state + IPC subscriptions
    src/components/         #   Chrome, AdaptPanel, Transcript, LibraryView, SettingsView
  shared/ipc.ts             # typed IPC channel + payload contract (both sides)
```

Build config is [electron-vite](https://electron-vite.org) (`electron.vite.config.ts`):
`main` and `preload` are bundled for Node (deps externalized); `renderer` is a
normal Vite React app.

---

## The workspace

All user artifacts live **outside the app**, in a git-backed workspace:

- Default: `app.getPath('userData')/workspace`
  (macOS: `~/Library/Application Support/malleable-browser/workspace`).
- Override with the `MALLEABLE_WORKSPACE` env var.
- Contents: `adaptations/` (the edit library), `tools/` (agent-scaffolded tools),
  `live/<host>/{network,console}.jsonl` (mirrored, grep/tail-able page history —
  gitignored, since captured headers/bodies can carry auth tokens/cookies),
  `.malleable/sessions.json`, `.malleable/cdp.json` (the raw CDP endpoint, see
  below), `logs/`, `persona.md`, and a `.git` repo used for checkpoints. It is
  created and `git init`'d on first launch.

The workspace is also the agent's ACP `cwd`, so edits/tools it writes land here.

---

## Requirements

- **Node 20+** and **npm**.
- A **Claude login**: the `claude-agent-acp` adapter uses the same credentials as
  the Claude Code CLI (macOS keychain / `claude login`), or an `ANTHROPIC_API_KEY`
  environment variable. If you're already logged into Claude Code, nothing else is
  needed.

## Run

```bash
npm install
npm run dev
```

> **First install may not download the Electron binary** in some sandboxes. If you
> see `Error: Electron uninstall`, run `node node_modules/electron/install.js`,
> then `npm run dev` again.

Then browse to a site and, in the **Adapt** panel, try:

> give this site a clean dark reading mode and hide the sidebar and ads

Watch the agent inspect the page and save an edit; the page reloads with it
applied. Revisit later and it re-applies. Manage edits in the **Library** tab;
pick a model in **Settings**.

## Scripts

- `npm run dev` — dev with HMR (chrome) + live injection (pages)
- `npm run build` — production build to `out/`
- `npm run start` — preview the production build
- `npm run typecheck` — TypeScript across main/preload and renderer

---

## The agent's tools (MCP)

Exposed by an in-process, **localhost-only, bearer-token-gated** MCP server
(`page-tools-server.ts`), handed to each session via `newSession({ mcpServers })`:

| Tool | Purpose |
|------|---------|
| `dom_query` | Query the live DOM by CSS selector |
| `run_js` | Execute JS in the page, return the result |
| `get_console` / `get_network` | Recent console messages / network requests |
| `screenshot` | PNG of the page as image content the model can see |
| `fetch_image` | Download an image by URL and view it |
| `list_tabs` | What's open (id, url, title, host, which is active) |
| `open_tab` / `close_tab` / `focus_tab` | Manage tabs |
| `save_adaptation` | Create/update a named edit (applies immediately) |
| `list_adaptations` / `get_adaptation` | Browse the site's edit library |
| `set_adaptation_enabled` / `delete_adaptation` | Toggle / remove an edit |
| `define_tool` / `list_tools` / `remove_tool` | Scaffold new tools at runtime |
| `list_bubbles` / `save_bubble` / `set_edit_bubble` | Let sites share data (see Bubbles) |

Every live page tool takes an optional **`tab`** ref — a tab id, a host, or a
URL/title substring; omitted means the focused tab. So `dom_query` and friends are
tab-addressable without the agent having to focus a tab first.

Scaffolded tools run as page-JS with an `args` object; the server is stateful so
it can push `tools/list_changed` and the agent can use a new tool the same turn.
They also get a reserved `tab` param, and a *site*-scoped tool defaults to a tab
showing **its own** host rather than whatever happens to be focused.

## Bubbles: letting sites share data

Edits are trapped on their own host by default — an edit on one site can't see
another. That's fine for restyling a page, and useless for the job people
actually have: *the same data must be entered into three to five unrelated
systems.* Timesheets, mostly.

A **bubble** is a named group of sites whose edits may exchange data with each
other, and with nothing outside:

```
bubbles/<id>.json    { id, name, hosts: [...], edits: [{host, editId}] }
```

Two invariants carry the whole authorization story:

- A **host** may belong to many bubbles.
- An **edit** belongs to exactly **one** bubble (or none).

The second is the load-bearing one — an edit in two bubbles would be a bridge
between them, which is exactly what the model prevents. So default-deny is
structural rather than a policy check: an edit in no bubble has no cross-site
reach at all. When a page's host is in two bubbles, each edit on that page gets a
handle to *its own* bubble; same page, two isolated spaces.

**The user is asked exactly once** — when a bubble gains sites. Never per call.

### How an edit reaches its bubble

A bubble-member edit's JS receives a `mal` argument (`null` when the edit is in no
bubble, so always guard):

```js
if (!mal) return
await mal.state.set('timesheet', { week, rows })   // shared, persisted JSON
mal.state.watch('timesheet', render)               // fires live, no reload
mal.bus.publish('filled', { host })                // ephemeral fan-out
mal.bubble.hosts                                   // who's in here
```

Under it is a **localhost bubble server** (`bubble-server.ts`) that edits reach
with plain `fetch`/`EventSource`. Deliberately *not* a preload: page JS already
has a channel to localhost, so this adds **no** reach from a page toward Node, and
the page sandbox is untouched. `mal` is passed as the edit wrapper's *argument*,
never a global, so it isn't visible to the site's own scripts.

Authorization is the **`Origin` header**, which the browser sets and page JS
cannot forge: a request is served only if its origin's host is a member of the
bubble it names. Bubble membership *is* the CORS allowlist. A bearer token is also
required, but only to keep non-browser local processes out — a page script that
stole the token would gain nothing, since it can only ever reach bubbles its own
origin already belongs to.

The honest limit: membership is granted to the **origin**, not to the specific
edit. Any script on a member page — including the site's own — can reach that
bubble's state. The bubble is the blast radius, which is why it should hold only
the sites a feature actually needs.

### Beyond the tool menu: a raw CDP escape hatch

The tools above are a curated vocabulary — good for the common cases, but any
fixed menu can only do what it was written to do. For anything else, the agent
has the same kind of generic reach into the page any other automation would:

- **`.malleable/cdp.json`** — a scoped Chrome DevTools Protocol WebSocket for the
  live pages (`cdp-bridge.ts`). Append `&tab=<tabId|host>` to pin a connection to
  one tab (omitted = the focused one); the choice is made at connect time and
  can't be changed in-band, so a session still can't pivot. Connect with any
  CDP-speaking approach (a few lines of `ws` + JSON-RPC, `chrome-remote-interface`
  in target-scoped mode) instead of being limited to `dom_query`/`run_js`. Only an
  allow-listed set of domains is forwarded — `DOM`, `Runtime`, `Page`, `Input`,
  `CSS`, `Log`, `Performance`, and read-only `Network` — see Safety model below.
- **`live/<host>/{network,console}.jsonl`** — the same history `get_network`/
  `get_console` expose, mirrored to plain append-only files so it's `grep`/
  `tail`-able like any other file instead of only reachable through a tool call.

Both are discoverable as ordinary facts about the workspace, not a special API.

---

## Safety model

- Web pages render in a **sandboxed** `WebContentsView` (`contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`) — page JS can't reach Node/fs/IPC.
- The agent's `cwd` is the **workspace**, so it can't touch the app's own source.
- The MCP server binds to `127.0.0.1` and requires a per-run bearer token.
- Sensitive agent actions surface a **permission dialog** (ACP
  `session/request_permission`); the permission mode is selectable in Settings.
  Note `claude-agent-acp`'s own Write/Edit tools write straight to disk, so the
  permission prompt + git checkpoint — not the client fs handler — are the real
  gate.
- Injected overlay JS is wrapped in a guarded IIFE so a bad edit can't break a
  page. Its bubble handle is the IIFE's *argument*, so it never lands on `window`.
- **Bubble membership is the authorization boundary**, enforced by the `Origin`
  header at the bubble server. One consent when a bubble gains sites; none at call
  time. Deleting a bubble revokes everything it granted at once.
- For bubble hosts only, `connect-src`/`default-src` are widened by one exact
  origin so a locked-down site can reach the bubble server (`csp.ts`). Nothing
  else is touched — `script-src` and friends are left verbatim, so this can't
  enable inline or third-party script. It lets the page talk to one localhost
  port; it grants no reach toward Node or the filesystem.
- The raw CDP bridge (`cdp-bridge.ts`) is a **single-target relay**: each
  connection is pinned at connect time to exactly one content `WebContentsView`
  and never a browser-wide debugging port, so it can't be used to pivot to a
  sibling tab or to the app's own chrome/renderer. It also
  **allow-lists domains**: `Target`/`Browser` (other targets), `Storage`
  (cookie/site-data dumping), `Fetch` (traffic interception/mocking), and
  `Emulation`/`Security` (device/geo/cert spoofing) are all rejected — real
  capability classes beyond "drive this one page," deliberately not granted by
  default. The page's own sandbox is unaffected either way: this only widens
  what the *agent* can do from the host side, same direction as `run_js` today.
- Every changing turn is **git-checkpointed** in the workspace; **↺ Revert** does
  `git reset --hard HEAD~1`, **Reset site** deletes a host's edits.

---

## Limitations

Honest about where it's rough:

- **No automatic verification loop** — the agent is prompted to screenshot and
  check its work, but there's no enforced "did the edit actually work?" gate, and
  overlays can silently break when a site's markup changes.
- **Revert is coarse** — `git reset --hard HEAD~1` on the workspace; if you
  hand-edit workspace files between turns, a revert can discard them.
- **Screenshots of background tabs** may come back blank — a tab that isn't
  focused isn't necessarily producing frames. `focus_tab` then retry.
- **Trust model is "you on your machine"** — the agent has broad power (page JS,
  file writes in the workspace, terminal, runtime tool creation) gated mainly by
  permission prompts. Not hardened for untrusted use.

## License

No license yet — add one before treating this as open source.

---

## Mock systems for testing

`test-pages/` holds two deliberately mismatched fake systems for exercising
cross-site work without pointing the browser at anything credentialed:

```bash
npm run test-pages   # then open the two URLs it prints
```

- **`tracker.localhost`** — a source timesheet: ISO dates, project *names*,
  decimal hours, whole week visible at once.
- **`portal.localhost`** — a destination form: `MM/DD/YYYY`, project *codes*,
  `H:MM` durations, one entry at a time, strict validation and a double-entry
  guard.

To install the worked example — an extract edit on the tracker, a fill edit on the
portal, and the bubble joining them:

```bash
npm run seed-example   # writes the edits + bubble into the workspace
npm run test-pages     # serve the two sites
npm run dev            # restart to pick up the bubble
```

Fill in the tracker, switch to the portal: a **Fill** button appears with your
hours, mapping ISO dates to `MM/DD/YYYY`, project names to codes, and decimal
hours to `H:MM`. Editing the tracker updates the portal panel live, no reload.

They're served on one port with Host-header routing rather than two ports,
because `slugFor` is `new URL(url).hostname` and ignores the port — two ports on
`127.0.0.1` would collapse to a single host slug. `*.localhost` resolves to
loopback natively (RFC 6761), so no `/etc/hosts` entry is needed.
