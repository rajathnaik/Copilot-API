import { contextBridge, ipcRenderer } from 'electron'
import type { ConnectorAPI } from '../src/types/connector'

const api: ConnectorAPI = {
  status: (harness) => ipcRenderer.invoke('connector:status', harness),
  revealKey: (harness) => ipcRenderer.invoke('connector:reveal-key', harness),
  discover: (input) => ipcRenderer.invoke('connector:discover', input),
  connect: (input) => ipcRenderer.invoke('connector:connect', input),
  repair: (input) => ipcRenderer.invoke('connector:repair', input),
  refresh: (harness) => ipcRenderer.invoke('connector:refresh', harness),
  undo: (harness) => ipcRenderer.invoke('connector:undo', harness),
  selectExecutable: (harness) =>
    ipcRenderer.invoke('connector:select-executable', harness),
  resetExecutable: (harness) =>
    ipcRenderer.invoke('connector:reset-executable', harness),
  openInstallGuide: (harness) =>
    ipcRenderer.invoke('connector:open-install-guide', harness),
}

contextBridge.exposeInMainWorld('connectorAPI', api)
