import { contextBridge, ipcRenderer } from 'electron'
import type { ModelBridgeAPI } from '../src/types'

const api: ModelBridgeAPI = {
  status: () => ipcRenderer.invoke('modelbridge:status'),
  addSource: (input) => ipcRenderer.invoke('modelbridge:add-source', input),
  shareSource: (sourceId, shared) =>
    ipcRenderer.invoke('modelbridge:share-source', { sourceId, shared }),
  localKey: () => ipcRenderer.invoke('modelbridge:local-key'),
  remoteKey: () => ipcRenderer.invoke('modelbridge:remote-key'),
  loginTunnel: () => ipcRenderer.invoke('modelbridge:tunnel-login'),
  startSharing: () => ipcRenderer.invoke('modelbridge:sharing-start'),
  stopSharing: () => ipcRenderer.invoke('modelbridge:sharing-stop'),
  loginCopilot: (label, shared) =>
    ipcRenderer.invoke('modelbridge:copilot-login', { label, shared }),
  cancelCopilotLogin: () => ipcRenderer.invoke('modelbridge:copilot-cancel'),
  refreshSource: (sourceId) =>
    ipcRenderer.invoke('modelbridge:refresh-source', sourceId),
  codexStatus: () => ipcRenderer.invoke('modelbridge:codex-status'),
  discoverCodex: () => ipcRenderer.invoke('modelbridge:codex-discover'),
  selectCodex: () => ipcRenderer.invoke('modelbridge:codex-select'),
  previewCodex: (label, modelId) =>
    ipcRenderer.invoke('modelbridge:codex-preview', { label, modelId }),
  previewCodexRevision: (id) =>
    ipcRenderer.invoke('modelbridge:codex-revision', id),
  previewCodexRestore: () => ipcRenderer.invoke('modelbridge:codex-restore'),
  applyCodex: (id) => ipcRenderer.invoke('modelbridge:codex-apply', id),
  reconcileCodex: () => ipcRenderer.invoke('modelbridge:codex-reconcile'),
  openLogin: (url) => ipcRenderer.invoke('modelbridge:open-login', url),
}
contextBridge.exposeInMainWorld('modelbridge', api)
