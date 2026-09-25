// Shared IPC contract between main and renderer. Kept dependency-free so it can be
// imported from both the Node side (main/preload) and the browser side (renderer).

/** Renderer -> main (invoke/handle). */
export const IPC = {
  // Navigation of the embedded web pages. Each takes an optional tabId; omitted
  // means "the active tab", which is what the address bar always sends.
  navigate: 'browser:navigate',
  goBack: 'browser:goBack',
  goForward: 'browser:goForward',
  reload: 'browser:reload',
  setContentBounds: 'browser:setContentBounds',
  setSafeMode: 'browser:setSafeMode',
  clearSiteData: 'browser:clearSiteData',

  // Tabs.
  newTab: 'browser:newTab',
  closeTab: 'browser:closeTab',
  focusTab: 'browser:focusTab',
  /** Right-click on a tab: main pops the native tab menu (bubble actions). */
  showTabMenu: 'browser:showTabMenu',
  /** Click on a bubble chip in the strip: main pops that bubble's menu. */
  showBubbleMenu: 'bubble:showMenu',
  /** Start a bubble from a tab's site (omitted tabId = the active tab). */
  startBubbleFromTab: 'bubble:startFromTab',
  /** A chrome modal is open: hide the page view, which would paint over it. */
  setPageObscured: 'browser:setPageObscured',

  // The malleability loop.
  adaptPrompt: 'acp:prompt',
  adaptHost: 'acp:adaptHost',
  adaptCancel: 'acp:cancel',
  newSession: 'acp:newSession',
  switchSession: 'acp:switchSession',
  listSessions: 'acp:listSessions',
  permissionResponse: 'acp:permissionResponse',

  // Agent configuration (models, permission mode).
  setConfigOption: 'acp:setConfigOption',

  // App settings (which ACP agent to run).
  getAppSettings: 'app:getSettings',
  setAgentCommand: 'app:setAgentCommand',

  // Per-site content adaptations + library (multiple named edits per host).
  resetSite: 'adapt:resetSite',
  listAdaptations: 'lib:list',
  getEdit: 'lib:getEdit',
  saveEdit: 'lib:saveEdit',
  setEditEnabled: 'lib:setEditEnabled',
  deleteEdit: 'lib:deleteEdit',
  publishHost: 'lib:publishHost',
  publishUserscript: 'lib:publishUserscript',
  openInTampermonkey: 'lib:openInTampermonkey',

  // Bubbles: groups of sites whose edits may exchange data.
  listBubbles: 'bubble:list',
  saveBubble: 'bubble:save',
  deleteBubble: 'bubble:delete',
  setEditBubble: 'bubble:setEdit',
  pushBubble: 'bubble:push',
  publishBubble: 'bubble:publish',
  bubbleConsentResponse: 'bubble:consentResponse',

  // Agent-scaffolded tools (global + per-site).
  listTools: 'lib:listTools',
  deleteTool: 'lib:deleteTool',

  // Checkpoint / revert (safety net).
  revertLast: 'checkpoint:revertLast',
  listCheckpoints: 'checkpoint:list',

  // Diagnostics.
  getLogPath: 'debug:getLogPath',

  // Open a URL in the OS default browser (for docs links, not the content view).
  openExternal: 'app:openExternal'
} as const

/** Main -> renderer (send/on). */
export const EVT = {
  /**
   * The full tab set + which one is active. The address bar renders the active
   * entry, so there is no separate "current page" channel to fall out of sync.
   */
  tabsState: 'browser:tabsState',
  adaptUpdate: 'acp:update',
  permissionRequest: 'acp:permissionRequest',
  acpStatus: 'acp:status',
  agentConfig: 'acp:config',
  /** Turn-level activity: what the agent is doing right now. */
  activity: 'acp:activity',
  /** The session list / current session changed. */
  sessions: 'acp:sessions',
  /** Ask the renderer to clear the transcript (e.g. before a session switch). */
  clearTranscript: 'acp:clearTranscript',
  /** The bubble list changed. */
  bubbles: 'bubble:list',
  /** A bubble wants to gain sites — the one consent point in the model. */
  bubbleConsentRequest: 'bubble:consentRequest'
} as const

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface NavState {
  url: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  title: string
  /** Origin hostname of the current page, if any. */
  origin: string
  /** Whether this origin has saved content adaptations. */
  adapted: boolean
}

/**
 * One tab, as the renderer and the agent see it. `NavState` is this same shape
 * minus the identity fields, kept separate so the address bar keeps working off a
 * single "current page" subscription.
 */
export interface TabInfo {
  id: string
  url: string
  title: string
  /** Origin hostname, if any. */
  origin: string
  /** Whether this origin has saved content adaptations. */
  adapted: boolean
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Worker tabs: alive and scriptable, but not in the strip. */
  hidden: boolean
  safeMode: boolean
}

export interface TabsState {
  tabs: TabInfo[]
  activeId: string | null
}

/** One edit, addressed by its host + id. */
export interface BubbleEditRef {
  host: string
  editId: string
}

/**
 * A bubble: a named group of sites whose edits may exchange data with each other
 * and nothing outside. A host may be in many bubbles; an edit in exactly one.
 */
export interface Bubble {
  id: string
  name: string
  /** Adaptation host slugs. Also the CORS allowlist for the bubble server. */
  hosts: string[]
  edits: BubbleEditRef[]
  createdAt: number
  updatedAt: number
}

/**
 * What an edit needs from its environment, and so where it can run.
 * 0 = self-contained · 1 = bubble state/bus · 2 = drives tabs · 3 = Malleable only.
 */
export type EditTier = 0 | 1 | 2 | 3

/** What made it into an export and what didn't — never a silent truncation. */
export interface PublishReport {
  included: { host: string; name: string; tier: EditTier }[]
  excluded: { host: string; name: string; tier: EditTier; reason: string }[]
  /** Capabilities the artifact approximates rather than reproduces exactly. */
  caveats: string[]
}

/** Outcome of pushing a bubble's data to every destination site in it. */
export interface BubblePushResult {
  ok: boolean
  /** Total entries the destinations reported creating. */
  entered?: number
  error?: string
  results: {
    host: string
    ok: boolean
    entered: number
    failed: number
    message?: string
  }[]
}

/** Asked before a bubble gains sites — the one consent point in the model. */
export interface BubbleConsentRequest {
  requestId: string
  /** Bubble name, existing or proposed. */
  name: string
  /** Sites being added by this request. */
  adding: string[]
  /** Sites already in the bubble, if it exists. */
  existing: string[]
}

/** A normalized, render-friendly view of an ACP session/update notification. */
export interface AdaptUpdate {
  kind:
    | 'user'
    | 'agent'
    | 'thought'
    | 'tool'
    | 'tool_update'
    | 'plan'
    | 'error'
    | 'info'
  text?: string
  toolId?: string
  toolTitle?: string
  toolKind?: string
  status?: string
  /** Files touched by a tool call, when reported. */
  locations?: string[]
  /** Raw tool input (arguments), for the expandable "under the hood" view. */
  rawInput?: unknown
  /** Raw tool output, for the expandable view. */
  rawOutput?: unknown
  /** Human-readable tool content (text/diffs), extracted for display. */
  content?: string
}

/** What the agent is doing right now, for a live activity indicator. */
export interface Activity {
  state: 'idle' | 'thinking' | 'responding' | 'tool'
  detail?: string
  /** Cumulative tokens for the current turn, from usage_update. */
  tokens?: number
}

/**
 * Session updates and activity are multiplexed: every session runs concurrently
 * on the one agent connection, so each event is tagged with the session it
 * belongs to and the renderer routes it into that session's transcript.
 */
export interface AdaptUpdateEvent {
  sessionId: string
  update: AdaptUpdate
}
export interface ActivityEvent {
  sessionId: string
  activity: Activity
}

/** Result of creating a brand-new coding session. */
export interface NewSessionResult {
  ok: boolean
  id?: string
  error?: string
}

/** Result of switching to (and, if needed, resuming) a session. */
export interface SwitchSessionResult {
  ok: boolean
  error?: string
  /** True if the session was already live in memory (no reload needed). */
  alreadyLive?: boolean
}

export interface SelectOptionDTO {
  value: string
  name: string
  description?: string
}

/** A settable agent config option (e.g. model, permission mode). */
export interface ConfigOptionDTO {
  id: string
  name: string
  description?: string
  category?: string
  currentValue: string
  options: SelectOptionDTO[]
}

export interface AgentConfig {
  agentName?: string
  agentVersion?: string
  options: ConfigOptionDTO[]
}

/** Persisted app settings. */
export interface AppSettingsData {
  /**
   * Command to launch the ACP agent. Empty = the bundled Claude adapter
   * (claude-agent-acp). Otherwise a command line, e.g. "gemini --experimental-acp".
   */
  agentCommand: string
}

/** One named, independently-toggleable edit for a site. */
export interface EditMeta {
  id: string
  name: string
  /** Free-form category, e.g. 'theme' | 'layout' | 'functionality' | 'cleanup'. */
  kind: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface EditSummary extends EditMeta {
  hasCss: boolean
  hasJs: boolean
  bytes: number
}

/** All edits for one host, for the library view. */
export interface HostAdaptations {
  host: string
  edits: EditSummary[]
}

export interface EditContent extends EditMeta {
  host: string
  css: string
  js: string
}

/** Result of packaging a host's enabled edits for export/sharing. */
export interface PublishResult {
  ok: boolean
  /** Path to the generated .zip (extension export). */
  zipPath?: string
  /** Path to the unpacked extension folder (extension export). */
  dir?: string
  /** Path to the generated .user.js (userscript export). */
  filePath?: string
  /** What was included/excluded and why. Surfaced in the Library. */
  report?: PublishReport
  error?: string
}

/** Suggested categories (free-form; agent may use others). */
export const EDIT_KINDS = ['theme', 'layout', 'functionality', 'cleanup', 'other'] as const

/** A scaffolded MCP tool, for the library view. */
export interface ToolParamDTO {
  type: string
  description?: string
  required?: boolean
}
export interface ToolSummary {
  name: string
  description: string
  scope: 'global' | 'site'
  host?: string
  params: Record<string, ToolParamDTO>
  code: string
}
export interface ToolLibrary {
  global: ToolSummary[]
  /** host -> its site tools */
  sites: Record<string, ToolSummary[]>
}

export interface PermissionOptionDTO {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export interface PermissionRequestDTO {
  requestId: string
  /** The session whose turn is blocked on this request (for multiplexed threads). */
  sessionId?: string
  title: string
  toolKind?: string
  locations?: string[]
  options: PermissionOptionDTO[]
}

export interface AdaptResult {
  ok: boolean
  stopReason?: string
  error?: string
  /** Short sha of the checkpoint commit taken before the turn, if any. */
  checkpoint?: string
}

export interface AcpStatus {
  state: 'starting' | 'ready' | 'auth_required' | 'error' | 'stopped'
  detail?: string
}

export interface CheckpointInfo {
  sha: string
  subject: string
}

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
}

export interface SessionList {
  sessions: SessionMeta[]
  currentId: string | null
}
