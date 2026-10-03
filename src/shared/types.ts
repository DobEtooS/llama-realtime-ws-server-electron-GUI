export type ModelPreset = {
  id: string
  name: string
  providerLabel: string
  hf: string
  quant: string
  model: string
  mmprojFile?: string
  modelscope?: {
    repo: string
    modelFile: string
    mmprojFile?: string
  }
  ctxSize: number
  notes: string
}

export type ManagerSettings = {
  modelMode: 'preset' | 'local'
  modelSource: 'huggingface' | 'hf-mirror' | 'modelscope'
  llamaPath: string
  nodePath: string
  llmServerDir: string
  runtimeHost: string
  runtimePort: number
  adapterPort: number
  modelEndpoint: string
  localModelPath: string
  localMmprojPath: string
  selectedPresetId: string
}

export type ManagedProcess = {
  running: boolean
  pid?: number
  command?: string
  startedAt?: string
}

export type RuntimeStatus = {
  platform: NodeJS.Platform
  arch: string
  llamaPath: string
  llamaInstalled: boolean
  installHint: string
  runtime: ManagedProcess
  adapter: ManagedProcess
  runtimeHealth: 'unknown' | 'ok' | 'failed'
  adapterHealth: 'unknown' | 'ok' | 'failed'
  downloadedPresetIds: string[]
  activeTask: string
  logs: string[]
}

export type AppState = {
  presets: ModelPreset[]
  settings: ManagerSettings
  status: RuntimeStatus
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string }

export type IpcEventMap = {
  'manager:state': AppState
}
