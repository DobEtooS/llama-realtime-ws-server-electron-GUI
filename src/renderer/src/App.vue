<template>
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>llm-server 管理器</h1>
        <p>自动安装 runtime、下载模型、启动模型服务和 adapter。</p>
      </div>
      <div class="top-actions">
        <a-tag :color="healthColor(state?.status.runtimeHealth)">Runtime {{ healthLabel(state?.status.runtimeHealth) }}</a-tag>
        <a-tag :color="healthColor(state?.status.adapterHealth)">Adapter {{ healthLabel(state?.status.adapterHealth) }}</a-tag>
        <a-button @click="refresh">刷新</a-button>
        <a-button @click="checkHealth">健康检查</a-button>
      </div>
    </header>

    <section class="grid">
      <div class="left">
        <a-card title="模型预设" :bordered="false">
          <a-segmented
            v-model:value="draft.modelMode"
            class="mode-switch"
            :options="[
              { label: '预设在线下载', value: 'preset' },
              { label: '本地 GGUF 文件', value: 'local' },
            ]"
            block
            @change="saveSettings"
          />
          <template v-if="draft.modelMode === 'preset'">
            <div class="source-panel">
              <div class="field-label">预设下载来源</div>
              <a-segmented
                v-model:value="draft.modelSource"
                class="source-switch"
                :options="[
                  { label: 'Hugging Face', value: 'huggingface' },
                  { label: 'HF 镜像', value: 'hf-mirror' },
                  { label: 'ModelScope', value: 'modelscope' },
                ]"
                block
                @change="saveSettings"
              />
              <div class="hint">大陆网络优先选 ModelScope；HF 镜像会使用 https://hf-mirror.com。</div>
            </div>

            <a-radio-group v-model:value="draft.selectedPresetId" class="preset-list" @change="saveSettings">
              <label v-for="preset in state?.presets || []" :key="preset.id" class="preset-item">
                <a-radio :value="preset.id" />
                <div class="preset-body">
                  <div class="preset-head">
                    <strong>{{ preset.name }}</strong>
                    <a-tag>{{ preset.providerLabel }}</a-tag>
                    <a-tag v-if="downloadedSet.has(preset.id)" color="green">已下载/已验证</a-tag>
                  </div>
                  <div class="preset-meta">{{ preset.model }}</div>
                  <div class="preset-note">{{ preset.notes }}</div>
                </div>
              </label>
            </a-radio-group>
          </template>

          <div v-else class="local-panel">
            <div class="field-label">本地 GGUF 主模型</div>
            <a-input-group compact>
              <a-input
                v-model:value="draft.localModelPath"
                style="width: calc(100% - 88px)"
                placeholder="ModelScope 下载后的 .gguf 主模型文件"
              />
              <a-button @click="chooseLocalModel">选择</a-button>
            </a-input-group>
            <div class="field-label local-field">本地 mmproj 文件</div>
            <a-input-group compact>
              <a-input
                v-model:value="draft.localMmprojPath"
                style="width: calc(100% - 88px)"
                placeholder="图片/视频输入需要；纯文本模型可留空"
              />
              <a-button @click="chooseLocalMmproj">选择</a-button>
            </a-input-group>
            <div class="hint">mmproj 只对多模态输入必需；如果留空，本地模型只能处理文本请求。</div>
          </div>
        </a-card>

        <a-card title="一键操作" :bordered="false">
          <div class="action-grid">
            <a-button type="primary" size="large" :loading="busy" @click="startAll">
              一键启动本地服务
            </a-button>
            <a-button size="large" :loading="busy" @click="downloadSelected">
              下载/预热所选模型
            </a-button>
            <a-button danger size="large" @click="stopAll">停止全部</a-button>
          </div>
          <a-alert
            v-if="state?.status.activeTask"
            class="task-alert"
            type="info"
            show-icon
            :message="`正在执行：${state.status.activeTask}`"
          />
        </a-card>

        <a-card title="服务控制" :bordered="false">
          <div class="service-row">
            <div>
              <strong>模型 runtime</strong>
              <p>{{ processText(state?.status.runtime) }}</p>
            </div>
            <a-space>
              <a-button :disabled="state?.status.runtime.running" @click="startRuntime">启动模型</a-button>
              <a-button danger :disabled="!state?.status.runtime.running" @click="stopRuntime">停止</a-button>
            </a-space>
          </div>
          <a-divider />
          <div class="service-row">
            <div>
              <strong>llm-server adapter</strong>
              <p>{{ processText(state?.status.adapter) }}</p>
            </div>
            <a-space>
              <a-button :disabled="state?.status.adapter.running" @click="startAdapter">启动 adapter</a-button>
              <a-button danger :disabled="!state?.status.adapter.running" @click="stopAdapter">停止</a-button>
            </a-space>
          </div>
        </a-card>
      </div>

      <div class="right">
        <a-card title="Runtime 设置" :bordered="false">
          <a-form layout="vertical">
            <a-form-item label="llama 路径">
              <a-input-group compact>
                <a-input v-model:value="draft.llamaPath" style="width: calc(100% - 88px)" placeholder="自动检测或填写 llama/llama-server 路径" />
                <a-button @click="chooseLlama">选择</a-button>
              </a-input-group>
              <div class="hint">当前：{{ state?.status.llamaInstalled ? state.status.llamaPath : '未检测到' }}</div>
            </a-form-item>
            <a-form-item label="Node 路径">
              <a-input v-model:value="draft.nodePath" placeholder="node" @blur="saveSettings" />
            </a-form-item>
            <a-form-item label="llm-server 目录">
              <a-input-group compact>
                <a-input v-model:value="draft.llmServerDir" style="width: calc(100% - 88px)" />
                <a-button @click="chooseServerDir">选择</a-button>
              </a-input-group>
            </a-form-item>
            <a-row :gutter="12">
              <a-col :span="8">
                <a-form-item label="Runtime Host">
                  <a-input v-model:value="draft.runtimeHost" @blur="saveSettings" />
                </a-form-item>
              </a-col>
              <a-col :span="8">
                <a-form-item label="Runtime Port">
                  <a-input-number v-model:value="draft.runtimePort" :min="1" :max="65535" style="width: 100%" @blur="saveSettings" />
                </a-form-item>
              </a-col>
              <a-col :span="8">
                <a-form-item label="Adapter Port">
                  <a-input-number v-model:value="draft.adapterPort" :min="1" :max="65535" style="width: 100%" @blur="saveSettings" />
                </a-form-item>
              </a-col>
            </a-row>
            <a-space>
              <a-button type="primary" @click="saveSettings">保存设置</a-button>
              <a-button :loading="busy" @click="installRuntime">自动安装 llama-app</a-button>
            </a-space>
          </a-form>
          <a-alert class="install-hint" type="info" show-icon :message="`跨平台安装命令：${state?.status.installHint || ''}`" />
        </a-card>

        <a-card title="日志和下载进度" :bordered="false" class="log-card">
          <div class="progress-row">
            <a-progress :percent="progressPercent" :status="state?.status.activeTask ? 'active' : 'normal'" />
            <span>{{ progressText }}</span>
          </div>
          <pre ref="logRef" class="logs">{{ (state?.status.logs || []).join('\n') }}</pre>
        </a-card>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { AppState, IpcResult, ManagedProcess } from '@shared/types'

const state = ref<AppState | null>(null)
const logRef = ref<HTMLElement | null>(null)
const draft = reactive({
  modelMode: 'preset' as 'preset' | 'local',
  modelSource: 'huggingface' as 'huggingface' | 'hf-mirror' | 'modelscope',
  llamaPath: '',
  nodePath: 'node',
  llmServerDir: '',
  runtimeHost: '127.0.0.1',
  runtimePort: 8080,
  adapterPort: 8765,
  modelEndpoint: '',
  localModelPath: '',
  localMmprojPath: '',
  selectedPresetId: '',
})

const busy = computed(() => Boolean(state.value?.status.activeTask))
const downloadedSet = computed(() => new Set(state.value?.status.downloadedPresetIds || []))
const progressPercent = computed(() => extractProgress(state.value?.status.logs || []))
const progressText = computed(() => {
  if (!state.value?.status.activeTask) return '空闲'
  return progressPercent.value > 0 ? `检测到下载进度 ${progressPercent.value}%` : '运行中，实时日志见下方'
})

let unsubscribe: (() => void) | null = null

function applyState(next: AppState) {
  state.value = next
  Object.assign(draft, next.settings)
  nextTick(() => {
    if (logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight
  })
}

async function unwrap<T>(result: IpcResult<T>) {
  if (!result.ok) {
    message.error(result.message)
    throw new Error(result.message)
  }
  return result.data
}

async function refresh() {
  if (!window.llmServerManager) {
    message.error('preload 未加载，请重启 GUI')
    return
  }
  applyState(await unwrap(await window.llmServerManager.getState()))
}

async function saveSettings() {
  applyState(await unwrap(await window.llmServerManager.updateSettings({ ...draft })))
}

async function chooseLlama() {
  const path = await unwrap(await window.llmServerManager.choosePath('file'))
  if (!path) return
  draft.llamaPath = path
  await saveSettings()
}

async function chooseServerDir() {
  const path = await unwrap(await window.llmServerManager.choosePath('directory'))
  if (!path) return
  draft.llmServerDir = path
  await saveSettings()
}

async function chooseLocalModel() {
  const path = await unwrap(await window.llmServerManager.choosePath('file'))
  if (!path) return
  draft.localModelPath = path
  draft.modelMode = 'local'
  await saveSettings()
}

async function chooseLocalMmproj() {
  const path = await unwrap(await window.llmServerManager.choosePath('file'))
  if (!path) return
  draft.localMmprojPath = path
  draft.modelMode = 'local'
  await saveSettings()
}

async function installRuntime() {
  await unwrap(await window.llmServerManager.installRuntime())
  await refresh()
}

async function downloadSelected() {
  await saveSettings()
  await unwrap(await window.llmServerManager.downloadModel(draft.selectedPresetId))
  await refresh()
}

async function startRuntime() {
  await saveSettings()
  await unwrap(await window.llmServerManager.startRuntime())
}

async function stopRuntime() {
  await unwrap(await window.llmServerManager.stopRuntime())
}

async function startAdapter() {
  await saveSettings()
  await unwrap(await window.llmServerManager.startAdapter())
}

async function stopAdapter() {
  await unwrap(await window.llmServerManager.stopAdapter())
}

async function startAll() {
  await saveSettings()
  await unwrap(await window.llmServerManager.startAll())
}

async function stopAll() {
  await unwrap(await window.llmServerManager.stopAll())
}

async function checkHealth() {
  applyState(await unwrap(await window.llmServerManager.checkHealth()))
}

function healthColor(value?: string) {
  if (value === 'ok') return 'green'
  if (value === 'failed') return 'red'
  return 'default'
}

function healthLabel(value?: string) {
  if (value === 'ok') return '正常'
  if (value === 'failed') return '异常'
  return '未知'
}

function processText(process?: ManagedProcess) {
  if (!process?.running) return '未运行'
  return `运行中，PID ${process.pid || '-'}`
}

function extractProgress(lines: string[]) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/(\d{1,3})(?:\.\d+)?%/)
    if (!match) continue
    return Math.max(0, Math.min(100, Number(match[1])))
  }
  return 0
}

watch(
  () => state.value?.status.logs.length,
  () => nextTick(() => {
    if (logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight
  }),
)

onMounted(async () => {
  if (!window.llmServerManager) {
    message.error('preload 未加载：请重启 GUI，或检查主进程 preload 路径')
    return
  }
  unsubscribe = window.llmServerManager.onState(applyState)
  await refresh()
})

onBeforeUnmount(() => {
  unsubscribe?.()
})
</script>
