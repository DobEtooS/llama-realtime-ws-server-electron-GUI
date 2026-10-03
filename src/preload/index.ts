import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, IpcResult, ManagerSettings } from '../shared/types'

const api = {
  getState: () => ipcRenderer.invoke('manager:getState') as Promise<IpcResult<AppState>>,
  updateSettings: (input: Partial<ManagerSettings>) => ipcRenderer.invoke('manager:updateSettings', input) as Promise<IpcResult<AppState>>,
  installRuntime: () => ipcRenderer.invoke('manager:installRuntime') as Promise<IpcResult<void>>,
  downloadModel: (presetId: string) => ipcRenderer.invoke('manager:downloadModel', { presetId }) as Promise<IpcResult<void>>,
  startRuntime: () => ipcRenderer.invoke('manager:startRuntime') as Promise<IpcResult<void>>,
  stopRuntime: () => ipcRenderer.invoke('manager:stopRuntime') as Promise<IpcResult<void>>,
  startAdapter: () => ipcRenderer.invoke('manager:startAdapter') as Promise<IpcResult<void>>,
  stopAdapter: () => ipcRenderer.invoke('manager:stopAdapter') as Promise<IpcResult<void>>,
  startAll: () => ipcRenderer.invoke('manager:startAll') as Promise<IpcResult<void>>,
  stopAll: () => ipcRenderer.invoke('manager:stopAll') as Promise<IpcResult<void>>,
  checkHealth: () => ipcRenderer.invoke('manager:checkHealth') as Promise<IpcResult<AppState>>,
  choosePath: (kind: 'file' | 'directory') => ipcRenderer.invoke('manager:choosePath', kind) as Promise<IpcResult<string>>,
  onState: (callback: (state: AppState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) => callback(state)
    ipcRenderer.on('manager:state', listener)
    return () => ipcRenderer.off('manager:state', listener)
  },
}

contextBridge.exposeInMainWorld('llmServerManager', api)

export type LlmServerManagerApi = typeof api
