import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  EVT,
  type Rect,
  type TabsState,
  type Bubble,
  type BubblePushResult,
  type BubbleConsentRequest,
  type AdaptResult,
  type AcpStatus,
  type PermissionRequestDTO,
  type CheckpointInfo,
  type AgentConfig,
  type AppSettingsData,
  type HostAdaptations,
  type EditContent,
  type EditMeta,
  type PublishResult,
  type ToolLibrary,
  type SessionList,
  type AdaptUpdateEvent,
  type ActivityEvent,
  type NewSessionResult,
  type SwitchSessionResult
} from '../shared/ipc.js'

/** Minimal, explicit surface exposed to the trusted chrome renderer. */
const api = {
  // Browsing. `tabId` is optional everywhere — omitted means the active tab.
  navigate: (url: string, tabId?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.navigate, url, tabId),
  goBack: (tabId?: string): Promise<void> => ipcRenderer.invoke(IPC.goBack, tabId),
  goForward: (tabId?: string): Promise<void> => ipcRenderer.invoke(IPC.goForward, tabId),
  reload: (tabId?: string): Promise<void> => ipcRenderer.invoke(IPC.reload, tabId),
  setContentBounds: (r: Rect): Promise<void> => ipcRenderer.invoke(IPC.setContentBounds, r),
  setSafeMode: (enabled: boolean, tabId?: string): Promise<{ ok: boolean; enabled: boolean }> =>
    ipcRenderer.invoke(IPC.setSafeMode, enabled, tabId),
  clearSiteData: (tabId?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.clearSiteData, tabId),

  // Tabs.
  newTab: (url?: string): Promise<void> => ipcRenderer.invoke(IPC.newTab, url),
  closeTab: (tabId: string): Promise<void> => ipcRenderer.invoke(IPC.closeTab, tabId),
  focusTab: (tabId: string): Promise<void> => ipcRenderer.invoke(IPC.focusTab, tabId),
  onTabsState: (cb: (s: TabsState) => void) => subscribe(EVT.tabsState, cb),

  // Malleability loop. Prompts target an explicit session so a mid-turn thread
  // switch can never misroute the turn.
  adapt: (sessionId: string, text: string): Promise<AdaptResult> =>
    ipcRenderer.invoke(IPC.adaptPrompt, sessionId, text),
  cancelAdapt: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.adaptCancel, sessionId),
  adaptHost: (sessionId: string, host: string, text: string): Promise<AdaptResult> =>
    ipcRenderer.invoke(IPC.adaptHost, sessionId, host, text),
  newSession: (): Promise<NewSessionResult> => ipcRenderer.invoke(IPC.newSession),
  switchSession: (id: string): Promise<SwitchSessionResult> =>
    ipcRenderer.invoke(IPC.switchSession, id),
  listSessions: (): Promise<SessionList> => ipcRenderer.invoke(IPC.listSessions),
  onSessions: (cb: (list: SessionList) => void) => subscribe(EVT.sessions, cb),
  onClearTranscript: (cb: () => void) => subscribe(EVT.clearTranscript, cb),
  onAdaptUpdate: (cb: (e: AdaptUpdateEvent) => void) => subscribe(EVT.adaptUpdate, cb),
  onAcpStatus: (cb: (s: AcpStatus) => void) => subscribe(EVT.acpStatus, cb),

  // Live activity (per session) + agent config (models, permission mode).
  onActivity: (cb: (e: ActivityEvent) => void) => subscribe(EVT.activity, cb),
  onAgentConfig: (cb: (c: AgentConfig) => void) => subscribe(EVT.agentConfig, cb),
  setConfigOption: (configId: string, value: string): Promise<void> =>
    ipcRenderer.invoke(IPC.setConfigOption, configId, value),

  // App settings (which ACP agent to run).
  getAppSettings: (): Promise<AppSettingsData> => ipcRenderer.invoke(IPC.getAppSettings),
  setAgentCommand: (agentCommand: string): Promise<AppSettingsData> =>
    ipcRenderer.invoke(IPC.setAgentCommand, agentCommand),

  // Per-site content adaptations + library.
  resetSite: (host?: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.resetSite, host),
  listAdaptations: (): Promise<HostAdaptations[]> => ipcRenderer.invoke(IPC.listAdaptations),
  getEdit: (host: string, id: string): Promise<EditContent | null> =>
    ipcRenderer.invoke(IPC.getEdit, host, id),
  saveEdit: (
    host: string,
    edit: { id?: string; name: string; kind?: string; css?: string; js?: string }
  ): Promise<EditMeta> => ipcRenderer.invoke(IPC.saveEdit, host, edit),
  setEditEnabled: (host: string, id: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.setEditEnabled, host, id, enabled),
  deleteEdit: (host: string, id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deleteEdit, host, id),
  publishHost: (host: string): Promise<PublishResult> => ipcRenderer.invoke(IPC.publishHost, host),
  publishUserscript: (host: string): Promise<PublishResult> =>
    ipcRenderer.invoke(IPC.publishUserscript, host),
  openInTampermonkey: (host: string): Promise<PublishResult> =>
    ipcRenderer.invoke(IPC.openInTampermonkey, host),

  // Scaffolded tools.
  listTools: (): Promise<ToolLibrary> => ipcRenderer.invoke(IPC.listTools),
  deleteTool: (name: string, scope: 'global' | 'site', host?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deleteTool, name, scope, host),

  // Permission prompts.
  onPermissionRequest: (cb: (r: PermissionRequestDTO) => void) =>
    subscribe(EVT.permissionRequest, cb),
  respondPermission: (requestId: string, optionId: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC.permissionResponse, requestId, optionId),

  // Checkpoints / revert.
  // Bubbles: groups of sites whose edits may exchange data with each other.
  listBubbles: (): Promise<Bubble[]> => ipcRenderer.invoke(IPC.listBubbles),
  saveBubble: (input: {
    id?: string
    name: string
    hosts: string[]
  }): Promise<{ ok: boolean; bubble?: Bubble; error?: string }> =>
    ipcRenderer.invoke(IPC.saveBubble, input),
  deleteBubble: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.deleteBubble, id),
  setEditBubble: (host: string, editId: string, bubbleId: string | null): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.setEditBubble, host, editId, bubbleId),
  pushBubble: (
    id: string,
    opts?: { sourceHost?: string; hidden?: boolean }
  ): Promise<BubblePushResult> => ipcRenderer.invoke(IPC.pushBubble, id, opts),
  publishBubble: (id: string): Promise<PublishResult> =>
    ipcRenderer.invoke(IPC.publishBubble, id),
  respondBubbleConsent: (requestId: string, allow: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.bubbleConsentResponse, requestId, allow),
  onBubbles: (cb: (list: Bubble[]) => void) => subscribe(EVT.bubbles, cb),
  onBubbleConsentRequest: (cb: (r: BubbleConsentRequest) => void) =>
    subscribe(EVT.bubbleConsentRequest, cb),

  revertLast: (): Promise<CheckpointInfo | null> => ipcRenderer.invoke(IPC.revertLast),
  listCheckpoints: (): Promise<CheckpointInfo[]> => ipcRenderer.invoke(IPC.listCheckpoints),

  // Diagnostics.
  getLogPath: (): Promise<string> => ipcRenderer.invoke(IPC.getLogPath),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url)
}

/** Subscribe to a main->renderer event; returns an unsubscribe function. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
