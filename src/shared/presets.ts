import type { ModelPreset } from './types'

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'qwen25-vl-3b-q4',
    name: 'Qwen2.5-VL 3B Q4_K_M',
    providerLabel: '轻量，推荐先试',
    hf: 'ggml-org/Qwen2.5-VL-3B-Instruct-GGUF',
    quant: 'Q4_K_M',
    model: 'ggml-org/Qwen2.5-VL-3B-Instruct-GGUF:Q4_K_M',
    ctxSize: 2048,
    notes: '本地可用性优先，适合低频摄像头抽帧验证。',
  },
  {
    id: 'qwen25-vl-7b-q3',
    name: 'Qwen2.5-VL 7B Q3_K_M',
    providerLabel: '能力/速度折中',
    hf: 'ggml-org/Qwen2.5-VL-7B-Instruct-GGUF',
    quant: 'Q3_K_M',
    model: 'ggml-org/Qwen2.5-VL-7B-Instruct-GGUF:Q3_K_M',
    ctxSize: 2048,
    notes: '比 3B 更稳，量化更轻，适合 48GB Mac 优先评估。',
  },
  {
    id: 'qwen25-vl-7b-q4',
    name: 'Qwen2.5-VL 7B Q4_K_M',
    providerLabel: '效果优先',
    hf: 'ggml-org/Qwen2.5-VL-7B-Instruct-GGUF',
    quant: 'Q4_K_M',
    model: 'ggml-org/Qwen2.5-VL-7B-Instruct-GGUF:Q4_K_M',
    ctxSize: 2048,
    notes: '效果更好但更吃资源，建议降低抽帧频率。',
  },
  {
    id: 'minicpm-o45-q4',
    name: 'MiniCPM-o 4.5 Q4_K_M',
    providerLabel: 'Omni，较重',
    hf: 'openbmb/MiniCPM-o-4_5-gguf',
    quant: 'Q4_K_M',
    model: 'openbmb/MiniCPM-o-4_5-gguf:Q4_K_M',
    ctxSize: 2048,
    notes: '完整 omni 路线，当前机器可能较吃力。',
  },
]
