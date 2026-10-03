import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, platform, arch } from 'node:os'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import Store from 'electron-store'
import { MODEL_PRESETS } from '../shared/presets'
import type { AppState, IpcResult, ManagedProcess, ManagerSettings, ModelPreset, RuntimeStatus } from '../shared/types'

type StoreShape = {
  settings: ManagerSettings
  downloadedPresetIds: string[]
}

const repoRoot = resolve(app.getAppPath(), '..')
const defaultLlmServerDir = resolve(repoRoot, 'llm-server')
const store = new Store<StoreShape>({
  defaults: {
    settings: {
      llamaPath: '',
      nodePath: 'node',
      llmServerDir: defaultLlmServerDir,
      runtimeHost: '127.0.0.1',
      runtimePort: 8080,
      adapterPort: 8765,
      selectedPresetId: MODEL_PRESETS[1].id,
    },
    downloadedPresetIds: [],
  },
})

let mainWindow: BrowserWindow | null = null
let runtimeProcess: ChildProcessWithoutNullStreams | null = null
let adapterProcess: ChildProcessWithoutNullStreams | null = null
let activeTask = ''
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
    llamaPath: settings.llamaPath || detectLlamaPath(),
    llmServerDir: settings.llmServerDir || defaultLlmServerDir,
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
  return {
    presets: MODEL_PRESETS,
    settings: { ...settings, llamaPath },
    status: {
      platform: platform(),
      arch: arch(),
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

function startRuntime(preset: ModelPreset = currentPreset(), mode: 'serve' | 'download' = 'serve') {
  if (runtimeProcess) throw new Error('模型 runtime 已在运行')
  const settings = getSettings()
  const command = selectedLlamaCommand()
  const args = [
    'serve',
    '-hf',
    preset.model,
    '--ctx-size',
    String(preset.ctxSize),
    '--host',
    settings.runtimeHost,
    '--port',
    String(settings.runtimePort),
  ]
  log(`${mode === 'download' ? '下载/预热' : '启动'}模型：${preset.name}`)
  runtimeProcess = spawnManaged(command, args)
  broadcastState()
  return runtimeProcess
}

async function downloadModel(input?: { presetId?: string }) {
  return runTask('下载模型', async () => {
    const preset = MODEL_PRESETS.find((item) => item.id === input?.presetId) || currentPreset()
    if (runtimeProcess) throw new Error('请先停止正在运行的模型 runtime')
    const child = startRuntime(preset, 'download')
    await waitForHealth(`http://127.0.0.1:${getSettings().runtimePort}/health`, 20 * 60_000)
    const downloaded = new Set(store.get('downloadedPresetIds') || [])
    downloaded.add(preset.id)
    store.set('downloadedPresetIds', [...downloaded])
    log(`模型已可启动：${preset.name}`)
    stopChild(child)
    runtimeProcess = null
  })
}

function writeAdapterConfig() {
  const settings = getSettings()
  const preset = currentPreset()
  ensureDir(join(settings.llmServerDir, 'config'))
  const configPath = join(settings.llmServerDir, 'config', 'server.json')
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        host: '127.0.0.1',
        port: settings.adapterPort,
        provider: 'minicpm-o',
        apiKey: '',
        defaultMode: 'video',
        minicpmO: {
          endpoint: `http://${settings.runtimeHost}:${settings.runtimePort}/v1/chat/completions`,
          apiKey: '',
          model: preset.model,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  log(`已写入 adapter 配置：${configPath}`)
}

function startAdapter() {
  if (adapterProcess) throw new Error('llm-server adapter 已在运行')
  const settings = getSettings()
  writeAdapterConfig()
  const adapterPath = join(settings.llmServerDir, 'server', 'adapter.mjs')
  if (!existsSync(adapterPath)) throw new Error(`找不到 adapter：${adapterPath}`)
  log('启动 llm-server adapter')
  adapterProcess = spawnManaged(settings.nodePath || 'node', ['server/adapter.mjs', '--port', String(settings.adapterPort)], {
    cwd: settings.llmServerDir,
    env: { LLM_SERVER_PROVIDER: 'minicpm-o' },
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
    if (!runtimeProcess) startRuntime(preset, 'serve')
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
  startRuntime()
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
