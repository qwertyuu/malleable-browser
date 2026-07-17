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
│ WebContentsView (page) ◀──┼── inject┤ in-process MCP server ◀───────┼── agent tools operate here
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
    index.ts                #   window, sandboxed WebContentsView, IPC, wiring
    acp-client.ts           #   embeds claude-agent-acp, speaks ACP, sessions
    adaptations.ts          #   per-site edit library (CRUD + injector + prompt)
    page-inspector.ts       #   DOM/JS/console/network/screenshot backing tools
    page-tools-server.ts    #   in-process MCP server exposing the agent's tools
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
  `.malleable/sessions.json`, `logs/`, `persona.md`, and a `.git` repo used for
  checkpoints. It is created and `git init`'d on first launch.

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
| `save_adaptation` | Create/update a named edit (applies immediately) |
| `list_adaptations` / `get_adaptation` | Browse the site's edit library |
| `set_adaptation_enabled` / `delete_adaptation` | Toggle / remove an edit |
| `define_tool` / `list_tools` / `remove_tool` | Scaffold new tools at runtime |

Scaffolded tools run as page-JS with an `args` object; the server is stateful so
it can push `tools/list_changed` and the agent can use a new tool the same turn.

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
  page.
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
- **Single page view** — no real multi-tab yet.
- **Trust model is "you on your machine"** — the agent has broad power (page JS,
  file writes in the workspace, terminal, runtime tool creation) gated mainly by
  permission prompts. Not hardened for untrusted use.

## License

No license yet — add one before treating this as open source.
