import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { dirname, join, resolve } from 'node:path'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, platform, arch } from 'node:os'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable } from 'node:stream'
import Store from 'electron-store'
import { MODEL_PRESETS } from '../shared/presets'
import type { AppState, HardwareStatus, IpcResult, ManagedProcess, ManagerSettings, ModelPreset, RuntimeStatus } from '../shared/types'

type StoreShape = {
  settings: ManagerSettings
  downloadedPresetIds: string[]
}

const repoRoot = resolve(app.getAppPath(), '..')
const bundledLlmServerDir = app.isPackaged ? join(process.resourcesPath, 'llm-server') : resolve(app.getAppPath(), 'resources', 'llm-server')
const legacyExternalLlmServerDir = resolve(repoRoot, 'llm-server')
const defaultLlmServerDir = bundledLlmServerDir
const store = new Store<StoreShape>({
  defaults: {
    settings: {
      modelMode: 'preset',
      modelSource: 'huggingface',
      hardwareMode: 'auto',
      manualBackend: 'auto',
      manualDeviceCount: 1,
      manualGpuLayersPreset: 'all',
      manualGpuLayers: 'all',
      manualDevices: '',
      manualSplitMode: '',
      manualTensorSplit: '',
      extraRuntimeArgs: '',
      llamaPath: '',
      nodePath: 'node',
      llmServerDir: defaultLlmServerDir,
      runtimeHost: '127.0.0.1',
      runtimePort: 8080,
      adapterPort: 8765,
      modelEndpoint: '',
      localModelPath: '',
      localMmprojPath: '',
      selectedPresetId: MODEL_PRESETS[1].id,
    },
    downloadedPresetIds: [],
  },
})

let mainWindow: BrowserWindow | null = null
let runtimeProcess: ChildProcessWithoutNullStreams | null = null
let adapterProcess: ChildProcessWithoutNullStreams | null = null
let activeTask = ''
let hardwareProbeCache: { command: string; detected: HardwareStatus; checkedAt: number } | null = null
const logs: string[] = []

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: 'llm-server 管理器',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopChild(runtimeProcess)
  stopChild(adapterProcess)
  if (process.platform !== 'darwin') app.quit()
})

function getSettings(): ManagerSettings {
  const settings = store.get('settings')
  return {
    ...settings,
    modelMode: settings.modelMode || 'preset',
    modelSource: settings.modelSource || (settings.modelEndpoint ? 'hf-mirror' : 'huggingface'),
    hardwareMode: settings.hardwareMode || 'auto',
    manualBackend: settings.manualBackend || 'auto',
    manualDeviceCount: Number(settings.manualDeviceCount || 1),
    manualGpuLayersPreset: settings.manualGpuLayersPreset || 'all',
    manualGpuLayers: settings.manualGpuLayers || 'all',
    manualDevices: settings.manualDevices || '',
    manualSplitMode: settings.manualSplitMode || '',
    manualTensorSplit: settings.manualTensorSplit || '',
    extraRuntimeArgs: settings.extraRuntimeArgs || '',
    llamaPath: settings.llamaPath || detectLlamaPath(),
    llmServerDir: defaultLlmServerDir,
    modelEndpoint: settings.modelEndpoint || '',
    localModelPath: settings.localModelPath || '',
    localMmprojPath: settings.localMmprojPath || '',
  }
}

function setSettings(input: Partial<ManagerSettings>) {
  store.set('settings', { ...getSettings(), ...input })
  broadcastState()
  return getState()
}

function detectLlamaPath() {
  const home = homedir()
  const candidates =
    process.platform === 'win32'
      ? [
          join(home, '.llama-app', 'llama.exe'),
          join(home, '.local', 'bin', 'llama.exe'),
          'llama',
          'llama-server',
        ]
      : [join(home, '.llama-app', 'llama'), join(home, '.local', 'bin', 'llama'), 'llama', 'llama-server']
  return candidates.find((candidate) => (candidate.includes('/') || candidate.includes('\\') ? existsSync(candidate) : commandExists(candidate))) || ''
}

function commandExists(command: string) {
  const checker = process.platform === 'win32' ? 'where' : 'command'
  const args = process.platform === 'win32' ? [command] : ['-v', command]
  return spawnSync(checker, args, { shell: process.platform !== 'win32', stdio: 'ignore' }).status === 0
}

function currentPreset() {
  const settings = getSettings()
  return MODEL_PRESETS.find((preset) => preset.id === settings.selectedPresetId) || MODEL_PRESETS[0]
}

function managedProcess(child: ChildProcessWithoutNullStreams | null): ManagedProcess {
  return child
    ? {
        running: !child.killed,
        pid: child.pid,
        startedAt: (child as any).__startedAt,
        command: (child as any).__command,
      }
    : { running: false }
}

function getState(): AppState {
  const settings = getSettings()
  const llamaPath = settings.llamaPath || detectLlamaPath()
  const hardware = resolveHardwareStatus(settings, llamaPath)
  return {
    presets: MODEL_PRESETS,
    settings: { ...settings, llamaPath },
    status: {
      platform: platform(),
      arch: arch(),
      hardware,
      llamaPath,
      llamaInstalled: Boolean(llamaPath && (llamaPath === 'llama' || llamaPath === 'llama-server' || existsSync(llamaPath))),
      installHint: installCommandHint(),
      runtime: managedProcess(runtimeProcess),
      adapter: managedProcess(adapterProcess),
      runtimeHealth: 'unknown',
      adapterHealth: 'unknown',
      downloadedPresetIds: store.get('downloadedPresetIds') || [],
      activeTask,
      logs: [...logs],
    },
  }
}

function installCommandHint() {
  if (process.platform === 'win32') return 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://llama.app/install.ps1 | iex"'
  return 'curl -LsSf https://llama.app/install.sh | sh'
}

function broadcastState() {
  mainWindow?.webContents.send('manager:state', getState())
}

function log(line: string) {
  const text = `[${new Date().toLocaleTimeString()}] ${line}`
  logs.push(text)
  if (logs.length > 800) logs.splice(0, logs.length - 800)
  broadcastState()
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true })
}

function spawnManaged(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    shell: false,
  })
  ;(child as any).__startedAt = new Date().toISOString()
  ;(child as any).__command = [command, ...args].join(' ')
  child.stdout.on('data', (data) => log(String(data).trimEnd()))
  child.stderr.on('data', (data) => log(String(data).trimEnd()))
  child.on('error', (error) => log(`进程启动失败：${error.message}`))
  child.on('exit', (code, signal) => {
    log(`进程退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`)
    if (child === runtimeProcess) runtimeProcess = null
    if (child === adapterProcess) adapterProcess = null
    broadcastState()
  })
  return child
}

function runTask(name: string, fn: () => Promise<unknown>) {
  if (activeTask) throw new Error(`已有任务正在执行：${activeTask}`)
  activeTask = name
  broadcastState()
  return fn()
    .finally(() => {
      activeTask = ''
      broadcastState()
    })
}

function installRuntime() {
  return runTask('安装 llama-app', async () => {
    log('开始安装 llama-app runtime')
    const child =
      process.platform === 'win32'
        ? spawnManaged('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://llama.app/install.ps1 | iex'])
        : spawnManaged('/bin/sh', ['-lc', 'curl -LsSf https://llama.app/install.sh | sh'])
    await waitForExit(child)
    const llamaPath = detectLlamaPath()
    if (llamaPath) setSettings({ llamaPath })
    log(llamaPath ? `检测到 llama：${llamaPath}` : '安装结束，但未自动检测到 llama，请手动填写路径')
  })
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  return new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`进程退出码 ${code}`))
    })
    child.once('error', reject)
  })
}

function selectedLlamaCommand() {
  const settings = getSettings()
  const command = settings.llamaPath || detectLlamaPath()
  if (!command) throw new Error('未找到 llama runtime，请先安装 llama-app 或填写自定义路径')
  return command
}

function resolveHardwareStatus(settings: ManagerSettings = getSettings(), command = settings.llamaPath || detectLlamaPath()): HardwareStatus {
  const detected = detectHardware(command)
  const mode = settings.hardwareMode || 'auto'
  const args = mode === 'manual' ? manualHardwareArgs(settings, detected) : smartHardwareArgs(detected)
  const backend = mode === 'manual' ? manualBackend(settings, detected) : detected.backend
  const deviceCount = mode === 'manual' ? manualDeviceCount(settings, backend, detected) : detected.deviceCount
  const label = backendLabel(backend)
  const deviceSummary = deviceCount > 0 ? `${deviceCount} 张/个设备` : '未识别到 GPU'
  return {
    ...detected,
    mode,
    backend,
    label,
    deviceCount,
    args,
    summary: `${mode === 'manual' ? '手动' : '智能'}：${label}，${deviceSummary}${args.length ? `，参数 ${args.join(' ')}` : '，不追加 GPU 参数'}`,
  }
}

function detectHardware(command: string): HardwareStatus {
  const fallback: HardwareStatus = {
    mode: 'auto',
    backend: process.platform === 'darwin' ? 'metal' : 'unknown',
    label: process.platform === 'darwin' ? 'Apple Metal' : '未知',
    deviceCount: process.platform === 'darwin' ? 1 : 0,
    devices: process.platform === 'darwin' ? ['Apple GPU'] : [],
    args: [],
    summary: '',
    raw: '',
  }
  if (!command) return fallback
  if (hardwareProbeCache?.command === command && Date.now() - hardwareProbeCache.checkedAt < 30_000) {
    return hardwareProbeCache.detected
  }
  try {
    const result = spawnSync(command, ['serve', '--list-devices'], {
      encoding: 'utf8',
      timeout: 8000,
      env: { ...process.env },
    })
    const raw = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
    if (!raw && process.platform === 'darwin') {
      hardwareProbeCache = { command, detected: fallback, checkedAt: Date.now() }
      return fallback
    }
    const devices = parseHardwareDevices(raw)
    const backend = inferBackend(raw, devices)
    const inferredCount = devices.length || (backend === 'metal' ? 1 : 0)
    const detected: HardwareStatus = {
      mode: 'auto',
      backend,
      label: backendLabel(backend),
      deviceCount: inferredCount,
      devices: devices.length ? devices : inferredCount ? [`${backendLabel(backend)} device`] : [],
      args: [],
      summary: '',
      raw,
    }
    hardwareProbeCache = { command, detected, checkedAt: Date.now() }
    return detected
  } catch {
    hardwareProbeCache = { command, detected: fallback, checkedAt: Date.now() }
    return fallback
  }
}

function parseHardwareDevices(raw: string) {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const cuda = new Map<string, string>()
  for (const line of lines) {
    const match = line.match(/\b(CUDA\d+)\b[:\s-]*(.*)/i)
    if (match) cuda.set(match[1].toUpperCase(), `${match[1].toUpperCase()}${match[2] ? ` ${match[2].trim()}` : ''}`)
  }
  if (cuda.size) return [...cuda.values()]
  const deviceLines = lines.filter((line) => /(device|gpu|metal|vulkan|sycl|hip|rocm)/i.test(line) && !/usage|help|available options/i.test(line))
  return [...new Set(deviceLines)]
}

function inferBackend(raw: string, devices: string[]): HardwareStatus['backend'] {
  const text = `${raw}\n${devices.join('\n')}`
  if (/cuda|cublas/i.test(text)) return 'cuda'
  if (/metal|apple/i.test(text) || process.platform === 'darwin') return 'metal'
  if (/vulkan/i.test(text)) return 'vulkan'
  if (/hip|rocm/i.test(text)) return 'cuda'
  if (/cpu/i.test(text)) return 'cpu'
  return 'unknown'
}

function backendLabel(backend: HardwareStatus['backend']) {
  if (backend === 'cuda') return 'CUDA'
  if (backend === 'metal') return 'Apple Metal'
  if (backend === 'vulkan') return 'Vulkan'
  if (backend === 'cpu') return 'CPU'
  return '未知后端'
}

function smartHardwareArgs(detected: HardwareStatus) {
  if (detected.backend === 'cpu' || detected.backend === 'unknown' || detected.deviceCount === 0) return []
  const args = ['--gpu-layers', 'all']
  const ids = hardwareDeviceIds(detected)
  if (detected.backend === 'cuda' && ids.length > 1) args.push('--device', ids.join(','), '--split-mode', 'layer')
  return args
}

function hardwareDeviceIds(detected: HardwareStatus) {
  if (detected.backend !== 'cuda') return []
  return detected.devices
    .map((device) => device.match(/\bCUDA\d+\b/i)?.[0]?.toUpperCase() || '')
    .filter(Boolean)
}

function manualBackend(settings: ManagerSettings, detected: HardwareStatus): HardwareStatus['backend'] {
  return settings.manualBackend === 'auto' ? detected.backend : settings.manualBackend
}

function manualHardwareArgs(settings: ManagerSettings, detected: HardwareStatus) {
  const backend = manualBackend(settings, detected)
  if (backend === 'cpu') return ['--gpu-layers', '0']
  const args: string[] = []
  const gpuLayers = manualGpuLayers(settings)
  if (gpuLayers) args.push('--gpu-layers', gpuLayers)
  const devices = manualDevices(settings, backend)
  if (devices) args.push('--device', devices)
  const splitMode = String(settings.manualSplitMode || '').trim()
  if (splitMode && splitMode !== 'auto') args.push('--split-mode', splitMode)
  else if (backend === 'cuda' && manualDeviceCount(settings, backend, detected) > 1) args.push('--split-mode', 'layer')
  const tensorSplit = String(settings.manualTensorSplit || '').trim()
  if (tensorSplit) args.push('--tensor-split', tensorSplit)
  return args
}

function manualDeviceCount(settings: ManagerSettings, backend: HardwareStatus['backend'], detected: HardwareStatus) {
  if (backend === 'cpu') return 0
  if (backend === 'metal') return 1
  const count = Math.round(Number(settings.manualDeviceCount || 1))
  if (Number.isFinite(count) && count > 0) return Math.min(16, count)
  return detected.deviceCount || 1
}

function manualGpuLayers(settings: ManagerSettings) {
  if (settings.manualGpuLayersPreset === 'none') return '0'
  if (settings.manualGpuLayersPreset === 'custom') return String(settings.manualGpuLayers || '').trim()
  return 'all'
}

function manualDevices(settings: ManagerSettings, backend: HardwareStatus['backend']) {
  const expertValue = String(settings.manualDevices || '').trim()
  if (expertValue) return expertValue
  const count = manualDeviceCount(settings, backend, {
    mode: 'auto',
    backend,
    label: '',
    deviceCount: 1,
    devices: [],
    args: [],
    summary: '',
    raw: '',
  })
  if (backend === 'cuda' && count > 1) return Array.from({ length: count }, (_item, index) => `CUDA${index}`).join(',')
  return ''
}

function splitExtraArgs(input: string) {
  const matches = String(input || '').match(/"[^"]*"|'[^']*'|\S+/g) || []
  return matches.map((item) => item.replace(/^(['"])(.*)\1$/, '$2'))
}

async function startRuntime(preset: ModelPreset = currentPreset(), mode: 'serve' | 'download' = 'serve') {
  if (runtimeProcess) throw new Error('模型 runtime 已在运行')
  const settings = getSettings()
  const command = selectedLlamaCommand()
  if (settings.modelMode === 'preset') await ensurePresetAssets(settings, preset)
  const args = runtimeArgs(settings, preset)
  const hardware = resolveHardwareStatus(settings, command)
  log(`硬件策略：${hardware.summary}`)
  if (preset.runtimeArgs?.length) log(`预设兼容参数：${preset.runtimeArgs.join(' ')}`)
  log(`${mode === 'download' ? '下载/预热' : '启动'}模型：${runtimeLabel(settings, preset)}`)
  runtimeProcess = spawnManaged(command, args, {
    env: modelDownloadEnv(settings),
  })
  broadcastState()
  return runtimeProcess
}

function runtimeArgs(settings: ManagerSettings, preset: ModelPreset) {
  const args =
    settings.modelMode === 'local'
      ? ['serve', '-m', settings.localModelPath]
      : settings.modelSource === 'modelscope'
        ? ['serve', '-m', modelscopeCachePath(preset, preset.modelscope?.modelFile || '')]
      : ['serve', '-hf', preset.model]
  if (settings.modelMode === 'local') {
    if (!settings.localModelPath) throw new Error('请先选择本地 GGUF 主模型文件')
    if (!existsSync(settings.localModelPath)) throw new Error(`本地模型文件不存在：${settings.localModelPath}`)
    if (settings.localMmprojPath) {
      if (!existsSync(settings.localMmprojPath)) throw new Error(`本地 mmproj 文件不存在：${settings.localMmprojPath}`)
      args.push('--mmproj', settings.localMmprojPath)
    }
  } else if (settings.modelSource === 'modelscope') {
    if (!preset.modelscope) throw new Error(`预设未配置 ModelScope 下载信息：${preset.name}`)
    if (!existsSync(modelscopeCachePath(preset, preset.modelscope.modelFile))) {
      throw new Error(`ModelScope 主模型文件不存在：${preset.modelscope.modelFile}`)
    }
    if (preset.modelscope.mmprojFile) {
      const mmprojPath = modelscopeCachePath(preset, preset.modelscope.mmprojFile)
      if (!existsSync(mmprojPath)) throw new Error(`ModelScope mmproj 文件不存在：${preset.modelscope.mmprojFile}`)
      args.push('--mmproj', mmprojPath)
    }
  } else if (preset.mmprojFile) {
    const mmprojPath = resolvePresetMmprojFile(settings, preset)
    if (mmprojPath) args.push('--mmproj', mmprojPath)
    else log(`未找到预设视觉投影缓存，将依赖 llama 自动加载：${preset.mmprojFile}`)
  }
  const hardware = resolveHardwareStatus(settings)
  args.push(...hardware.args)
  if (preset.runtimeArgs?.length) args.push(...preset.runtimeArgs)
  args.push('--ctx-size', String(preset.ctxSize), '--host', settings.runtimeHost, '--port', String(settings.runtimePort))
  args.push(...splitExtraArgs(settings.extraRuntimeArgs))
  return args
}

async function ensurePresetAssets(settings: ManagerSettings, preset: ModelPreset) {
  if (settings.modelSource === 'modelscope') {
    await ensureModelscopePreset(preset)
    return
  }
  await ensurePresetMmproj(settings, preset)
}

async function ensurePresetMmproj(settings: ManagerSettings, preset: ModelPreset) {
  if (!preset.mmprojFile) return
  if (resolvePresetMmprojFile(settings, preset)) return
  await ensureHfSidecarFile(settings, preset, preset.mmprojFile, '视觉投影')
  if (!resolvePresetMmprojFile(settings, preset)) {
    throw new Error(`视觉投影文件下载后仍未在缓存中找到：${preset.mmprojFile}`)
  }
}

async function ensureHfSidecarFile(settings: ManagerSettings, preset: ModelPreset, file: string, label: string) {
  const target = hfSidecarCachePath(preset, file)
  if (existsSync(target)) return
  log(`下载${label}文件：${file}`)
  await downloadFile(hfFileUrl(settings, preset.hf, file), target, `${preset.name} ${label}`)
}

function resolvePresetMmprojFile(settings: ManagerSettings, preset: ModelPreset) {
  if (!preset.mmprojFile) return ''
  const appCachePath = hfSidecarCachePath(preset, preset.mmprojFile)
  if (existsSync(appCachePath)) return appCachePath
  if (settings.modelSource === 'huggingface' || settings.modelSource === 'hf-mirror') {
    return resolveHfCacheFile(preset.hf, preset.mmprojFile)
  }
  return ''
}

function hfSidecarCachePath(preset: ModelPreset, file: string) {
  return join(app.getPath('userData'), 'models', 'hf-sidecars', preset.id, file)
}

function hfFileUrl(settings: ManagerSettings, repo: string, file: string) {
  const origin = settings.modelSource === 'hf-mirror' ? 'https://hf-mirror.com' : 'https://huggingface.co'
  const safeFile = file.split('/').map(encodeURIComponent).join('/')
  return `${origin}/${repo}/resolve/main/${safeFile}`
}

async function ensureModelscopePreset(preset: ModelPreset) {
  if (!preset.modelscope) throw new Error(`预设未配置 ModelScope 下载信息：${preset.name}`)
  await ensureModelscopeFile(preset, preset.modelscope.modelFile, '主模型')
  if (preset.modelscope.mmprojFile) await ensureModelscopeFile(preset, preset.modelscope.mmprojFile, '视觉投影')
}

async function ensureModelscopeFile(preset: ModelPreset, file: string, label: string) {
  const target = modelscopeCachePath(preset, file)
  if (existsSync(target)) return
  if (!preset.modelscope) throw new Error(`预设未配置 ModelScope 下载信息：${preset.name}`)
  const url = modelscopeFileUrl(preset.modelscope.repo, file)
  log(`从 ModelScope 下载${label}：${preset.modelscope.repo}/${file}`)
  await downloadFile(url, target, `${preset.name} ${label}`)
}

function modelscopeCachePath(preset: ModelPreset, file: string) {
  return join(app.getPath('userData'), 'models', 'modelscope', preset.id, file)
}

function modelscopeFileUrl(repo: string, file: string) {
  const url = new URL(`https://modelscope.cn/api/v1/models/${repo}/repo`)
  url.searchParams.set('Revision', 'master')
  url.searchParams.set('FilePath', file)
  return url.toString()
}

async function downloadFile(url: string, target: string, label: string) {
  ensureDir(dirname(target))
  const tmp = `${target}.tmp`
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`下载失败：${label} (${response.status})`)
  const total = Number(response.headers.get('content-length') || 0)
  let received = 0
  let nextProgressLog = 0
  await new Promise<void>((resolve, reject) => {
    const source = Readable.fromWeb(response.body as any)
    const file = createWriteStream(tmp)
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (!total) return
      const percent = Math.floor((received / total) * 100)
      if (percent >= nextProgressLog) {
        log(`${label} 下载进度 ${percent}%`)
        nextProgressLog = percent + 5
      }
    })
    source.on('error', reject)
    file.on('error', reject)
    file.on('finish', resolve)
    source.pipe(file)
  })
  renameSync(tmp, target)
  log(`${label} 下载完成：${target}`)
}

function resolveHfCacheFile(repo: string, file: string) {
  const cacheRoot = join(homedir(), '.cache', 'huggingface', 'hub', `models--${repo.replace('/', '--')}`)
  const refPath = join(cacheRoot, 'refs', 'main')
  if (existsSync(refPath)) {
    const revision = readFileSync(refPath, 'utf8').trim()
    const snapshotPath = join(cacheRoot, 'snapshots', revision, file)
    if (existsSync(snapshotPath)) return snapshotPath
  }
  const snapshotsDir = join(cacheRoot, 'snapshots')
  if (!existsSync(snapshotsDir)) return ''
  for (const revision of readdirSync(snapshotsDir)) {
    const snapshotPath = join(snapshotsDir, revision, file)
    if (existsSync(snapshotPath)) return snapshotPath
  }
  return ''
}

function runtimeLabel(settings: ManagerSettings, preset: ModelPreset) {
  return settings.modelMode === 'local' ? settings.localModelPath : preset.name
}

function modelDownloadEnv(settings: ManagerSettings) {
  const endpoint = settings.modelSource === 'hf-mirror' ? 'https://hf-mirror.com' : String(settings.modelEndpoint || '').trim()
  if (!endpoint) return {}
  return {
    MODEL_ENDPOINT: endpoint,
    HF_ENDPOINT: endpoint,
  }
}

async function downloadModel(input?: { presetId?: string }) {
  return runTask('下载模型', async () => {
    if (getSettings().modelMode === 'local') throw new Error('本地 GGUF 模式无需通过 GUI 下载，请先用 ModelScope 下载文件后选择路径')
    const preset = MODEL_PRESETS.find((item) => item.id === input?.presetId) || currentPreset()
    if (runtimeProcess) throw new Error('请先停止正在运行的模型 runtime')
    const child = await startRuntime(preset, 'download')
    await waitForHealth(`http://127.0.0.1:${getSettings().runtimePort}/health`, 20 * 60_000)
    const downloaded = new Set(store.get('downloadedPresetIds') || [])
    downloaded.add(preset.id)
    store.set('downloadedPresetIds', [...downloaded])
    log(`模型已可启动：${preset.name}`)
    stopChild(child)
    runtimeProcess = null
  })
}

function adapterConfigPath() {
  return join(app.getPath('userData'), 'llm-server', 'config', 'server.json')
}

function writeAdapterConfig() {
  const settings = getSettings()
  const preset = currentPreset()
  const modelName = settings.modelMode === 'local'
    ? settings.localModelPath.split(/[\\/]/).pop()?.replace(/\.gguf$/i, '') || 'local-gguf'
    : preset.clientModelName
  const configPath = adapterConfigPath()
  ensureDir(dirname(configPath))
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        host: '127.0.0.1',
        port: settings.adapterPort,
        provider: 'minicpm-o',
        apiKey: '',
        defaultMode: 'video',
        preset: settings.modelMode === 'preset'
          ? {
              id: preset.id,
              name: preset.name,
              clientModelName: preset.clientModelName,
            }
          : null,
        minicpmO: {
          endpoint: `http://${settings.runtimeHost}:${settings.runtimePort}/v1/chat/completions`,
          apiKey: '',
          model: modelName,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  log(`已写入 adapter 配置：${configPath}`)
  return configPath
}

function startAdapter() {
  if (adapterProcess) throw new Error('llm-server adapter 已在运行')
  const settings = getSettings()
  const configPath = writeAdapterConfig()
  const adapterDir = defaultLlmServerDir
  const adapterPath = join(adapterDir, 'server', 'adapter.mjs')
  if (!existsSync(adapterPath)) throw new Error(`找不到 adapter：${adapterPath}`)
  log('启动 llm-server adapter')
  const useElectronNode = app.isPackaged && (!settings.nodePath || settings.nodePath === 'node')
  adapterProcess = spawnManaged(useElectronNode ? process.execPath : settings.nodePath || 'node', [
    'server/adapter.mjs',
    '--config',
    configPath,
    '--port',
    String(settings.adapterPort),
  ], {
    cwd: adapterDir,
    env: {
      LLM_SERVER_PROVIDER: 'minicpm-o',
      ...(useElectronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  })
  broadcastState()
}

async function startAll() {
  return runTask('一键启动本地服务', async () => {
    const preset = currentPreset()
    if (!selectedRuntimeExists()) {
      log('未检测到 llama runtime，先自动安装 llama-app')
      const child =
        process.platform === 'win32'
          ? spawnManaged('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://llama.app/install.ps1 | iex'])
          : spawnManaged('/bin/sh', ['-lc', 'curl -LsSf https://llama.app/install.sh | sh'])
      await waitForExit(child)
      const llamaPath = detectLlamaPath()
      if (!llamaPath) throw new Error('llama-app 安装完成，但仍未检测到 llama 命令，请手动填写 runtime 路径')
      setSettings({ llamaPath })
    }
    if (!runtimeProcess) await startRuntime(preset, 'serve')
    await waitForHealth(`http://${getSettings().runtimeHost}:${getSettings().runtimePort}/health`, 20 * 60_000)
    if (!adapterProcess) startAdapter()
    await waitForHealth(`http://127.0.0.1:${getSettings().adapterPort}/health`, 30_000)
    log('本地服务已就绪')
  })
}

function selectedRuntimeExists() {
  const settings = getSettings()
  const command = settings.llamaPath || detectLlamaPath()
  if (!command) return false
  return command.includes('/') || command.includes('\\') ? existsSync(command) : commandExists(command)
}

function stopChild(child: ChildProcessWithoutNullStreams | null) {
  if (!child || child.killed) return
  child.kill('SIGTERM')
  setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL')
  }, 2500)
}

async function waitForHealth(url: string, timeoutMs: number) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`健康检查超时：${url}`)
}

async function checkHealth(): Promise<AppState> {
  const settings = getSettings()
  const state = getState()
  state.status.runtimeHealth = await isHealthy(`http://${settings.runtimeHost}:${settings.runtimePort}/health`)
  state.status.adapterHealth = await isHealthy(`http://127.0.0.1:${settings.adapterPort}/health`)
  return state
}

async function isHealthy(url: string): Promise<RuntimeStatus['runtimeHealth']> {
  try {
    const response = await fetch(url)
    return response.ok ? 'ok' : 'failed'
  } catch {
    return 'failed'
  }
}

async function choosePath(kind: 'file' | 'directory') {
  const result = await dialog.showOpenDialog({
    properties: kind === 'file' ? ['openFile'] : ['openDirectory'],
  })
  return result.canceled ? '' : result.filePaths[0] || ''
}

function stopRuntime() {
  stopChild(runtimeProcess)
  runtimeProcess = null
  broadcastState()
}

function stopAdapter() {
  stopChild(adapterProcess)
  adapterProcess = null
  broadcastState()
}

async function handle<T>(fn: () => T | Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`错误：${message}`)
    return { ok: false, message }
  }
}

ipcMain.handle('manager:getState', () => handle(() => getState()))
ipcMain.handle('manager:updateSettings', (_event, input: Partial<ManagerSettings>) => handle(() => setSettings(input || {})))
ipcMain.handle('manager:installRuntime', () => handle(() => installRuntime()))
ipcMain.handle('manager:downloadModel', (_event, input: { presetId?: string }) => handle(() => downloadModel(input || {})))
ipcMain.handle('manager:startRuntime', () => handle(() => {
  return startRuntime()
}))
ipcMain.handle('manager:stopRuntime', () => handle(() => stopRuntime()))
ipcMain.handle('manager:startAdapter', () => handle(() => {
  startAdapter()
}))
ipcMain.handle('manager:stopAdapter', () => handle(() => stopAdapter()))
ipcMain.handle('manager:startAll', () => handle(() => startAll()))
ipcMain.handle('manager:stopAll', () => handle(() => {
  stopRuntime()
  stopAdapter()
}))
ipcMain.handle('manager:checkHealth', () => handle(() => checkHealth()))
ipcMain.handle('manager:choosePath', (_event, kind: 'file' | 'directory') => handle(() => choosePath(kind)))
