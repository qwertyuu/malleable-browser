import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  EVT,
  type Rect,
  type NavState,
  type AdaptUpdate,
  type AdaptResult,
  type AcpStatus,
  type PermissionRequestDTO,
  type CheckpointInfo,
  type AgentConfig,
  type AppSettingsData,
  type Activity,
  type HostAdaptations,
  type EditContent,
  type EditMeta,
  type SessionList
} from '../shared/ipc.js'

/** Minimal, explicit surface exposed to the trusted chrome renderer. */
const api = {
  // Browsing (embedded WebContentsView).
  navigate: (url: string): Promise<void> => ipcRenderer.invoke(IPC.navigate, url),
  goBack: (): Promise<void> => ipcRenderer.invoke(IPC.goBack),
  goForward: (): Promise<void> => ipcRenderer.invoke(IPC.goForward),
  reload: (): Promise<void> => ipcRenderer.invoke(IPC.reload),
  setContentBounds: (r: Rect): Promise<void> => ipcRenderer.invoke(IPC.setContentBounds, r),
  onNavState: (cb: (s: NavState) => void) => subscribe(EVT.navState, cb),

  // Malleability loop.
  adapt: (text: string): Promise<AdaptResult> => ipcRenderer.invoke(IPC.adaptPrompt, text),
  cancelAdapt: (): Promise<void> => ipcRenderer.invoke(IPC.adaptCancel),
  adaptHost: (host: string, text: string): Promise<AdaptResult> =>
    ipcRenderer.invoke(IPC.adaptHost, host, text),
  newSession: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.newSession),
  switchSession: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.switchSession, id),
  listSessions: (): Promise<SessionList> => ipcRenderer.invoke(IPC.listSessions),
  onSessions: (cb: (list: SessionList) => void) => subscribe(EVT.sessions, cb),
  onClearTranscript: (cb: () => void) => subscribe(EVT.clearTranscript, cb),
  onAdaptUpdate: (cb: (u: AdaptUpdate) => void) => subscribe(EVT.adaptUpdate, cb),
  onAcpStatus: (cb: (s: AcpStatus) => void) => subscribe(EVT.acpStatus, cb),

  // Live activity + agent config (models, permission mode).
  onActivity: (cb: (a: Activity) => void) => subscribe(EVT.activity, cb),
  onAgentConfig: (cb: (c: AgentConfig) => void) => subscribe(EVT.agentConfig, cb),
  setConfigOption: (configId: string, value: string): Promise<void> =>
    ipcRenderer.invoke(IPC.setConfigOption, configId, value),

  // App settings (which ACP agent to run).
  getAppSettings: (): Promise<AppSettingsData> => ipcRenderer.invoke(IPC.getAppSettings),
  setAgentCommand: (agentCommand: string): Promise<AppSettingsData> =>
    ipcRenderer.invoke(IPC.setAgentCommand, agentCommand),

  // Per-site content adaptations + library.
  resetSite: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.resetSite),
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

  // Permission prompts.
  onPermissionRequest: (cb: (r: PermissionRequestDTO) => void) =>
    subscribe(EVT.permissionRequest, cb),
  respondPermission: (requestId: string, optionId: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC.permissionResponse, requestId, optionId),

  // Checkpoints / revert.
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
