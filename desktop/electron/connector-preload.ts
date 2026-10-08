import { contextBridge, ipcRenderer } from 'electron'
import type { ConnectorAPI } from '../src/types/connector'

const api: ConnectorAPI = {
  status: () => ipcRenderer.invoke('connector:status'),
  discover: (input) => ipcRenderer.invoke('connector:discover', input),
  connect: (input) => ipcRenderer.invoke('connector:connect', input),
  refresh: () => ipcRenderer.invoke('connector:refresh'),
  undo: () => ipcRenderer.invoke('connector:undo'),
  selectCodex: () => ipcRenderer.invoke('connector:select-codex'),
}

contextBridge.exposeInMainWorld('connectorAPI', api)
