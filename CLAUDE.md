# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron desktop browser where **web pages are malleable**: the user asks an
agent to reshape a site, the agent inspects the live page and writes CSS/JS
"edits" that the browser injects and persists per origin. The browser is itself a
custom **[Agent Client Protocol](https://agentclientprotocol.com) (ACP) client**
driving Claude via the `@agentclientprotocol/claude-agent-acp` adapter over stdio.

`README.md` is the primary design doc — read it for the full architecture, safety
model, and the agent's MCP tool table. This file covers what's not there.

## Commands

```bash
npm run dev        # electron-vite dev: HMR chrome + live page injection
npm run build      # production build to out/
npm run start      # preview the production build
npm run typecheck  # tsc --noEmit across tsconfig.node.json (main/preload) + tsconfig.web.json (renderer)
```

There is **no test suite and no linter** — `typecheck` is the only automated
gate. Run it before considering a change done.

If `npm run dev` fails with `Error: Electron uninstall`, the Electron binary
didn't download: run `node node_modules/electron/install.js`, then retry.

Requires a Claude login (same credentials as the Claude Code CLI / macOS
keychain, or `ANTHROPIC_API_KEY`).

## Three-process shape

electron-vite builds three separate bundles (`electron.vite.config.ts`); each is
a distinct execution context and they only communicate through the typed IPC
contract:

- **main/** — Node/Electron main process. Owns the window, the sandboxed
  `WebContentsView` that renders the page, the ACP client subprocess, the
  in-process MCP server, and all filesystem/git work.
- **preload/index.ts** — the *only* bridge the renderer can call. Exposes a
  `contextBridge` API mirroring `src/shared/ipc.ts`. If you add an IPC channel,
  it must be wired in three places: `shared/ipc.ts`, `preload/index.ts`, and a
  handler in `main/index.ts`.
- **renderer/** — React chrome (address bar + Adapt/Library/Settings panels).
  Never touches Node; it drives everything via the preload API.

`src/shared/ipc.ts` is the single source of truth for both IPC channel names
(`IPC` = renderer→main invoke, `EVT` = main→renderer events) and every payload
type. It is dependency-free so both the Node and browser bundles can import it.
Start here when tracing any feature end-to-end.

## The workspace (agent's sandbox)

All user artifacts live **outside the app source** in a git-backed workspace —
default `app.getPath('userData')/workspace`, override with `MALLEABLE_WORKSPACE`.
This is also the agent's ACP `cwd`, which is the core safety boundary: the agent
literally cannot read or edit the browser's own code. Layout: `adaptations/<host>/<editId>/`
(meta.json + overlay.css/js), `tools/*.json` (agent-scaffolded tools),
`.malleable/sessions.json`, `logs/`, `persona.md`, `.git`.

Note: `settings.json` (which ACP agent to run) lives in `userData` directly, NOT
in the workspace — see `app-settings.ts`.

## Key subsystems in main/

- **acp-client.ts** — spawns the ACP agent subprocess and speaks the protocol
  (sessions, prompts, permission requests, config options, `loadSession` resume).
  All sessions multiplex over one connection; events are tagged with `sessionId`
  and the renderer routes them. A blank `agentCommand` uses the bundled Claude
  adapter; anything else (e.g. `gemini --experimental-acp`) is tokenized and run.
- **page-tools-server.ts** — in-process MCP server (localhost-only, bearer-token
  gated) handed to each session. Exposes the agent's live page tools (`dom_query`,
  `run_js`, `screenshot`, `save_adaptation`, `define_tool`, …). Stateful so it can
  push `tools/list_changed` and let the agent use a just-scaffolded tool same-turn.
- **page-inspector.ts** — backs those tools against the live `WebContentsView`.
- **adaptations.ts** — per-site edit library CRUD + the injector (applies enabled
  edits on page load via `insertCSS` + guarded `executeJavaScript`) + prompt
  construction.
- **checkpoint.ts** — git checkpoint per *changing* turn; revert is
  `git reset --hard HEAD~1`. A plain question commits nothing.
- **dynamic-tools.ts** — registry for agent-scaffolded tools (`tools/*.json`).

## Export/publish subsystem (not in README)

Enabled edits for a host can be exported so they work outside this browser:

- **edit-bundle.ts** — `collectEnabledBundle()` gathers a host's enabled edits.
  Important invariant: **CSS is concatenated** (a broken rule can't break siblings)
  but **each edit's JS is kept separate and individually try/catch-wrapped**
  (`wrapEditJs`) so one syntax error can't take down the others. Names are
  embedded via `JSON.stringify` to avoid injection.
- **publish-extension.ts** — packages the bundle as an unpacked Chrome extension
  (+ a `.zip` via **zip.ts**, a dependency-free ZIP writer).
- **publish-userscript.ts** — emits a `.user.js`.
- **serve-file.ts** — serves the generated file over a random localhost
  port/path for a short TTL, so opening it in the OS browser lets a userscript
  manager (Tampermonkey/Violentmonkey) auto-detect and offer to install it —
  which a bare `file://` open usually can't do.

## Conventions

- ESM throughout (`"type": "module"`); intra-project imports use explicit `.js`
  extensions even for `.ts` sources (e.g. `import { X } from './foo.js'`).
- `electron.vite.config.ts` externalizes node_modules for main/preload so the ACP
  library and adapter stay resolvable on disk at runtime (`require.resolve`). Do
  not bundle them in.
