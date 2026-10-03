import { splitEventQueries } from '../protocols/qwen-compatible.mjs'

function buildPrompt(request) {
  const eventNames = request.eventNames?.length ? request.eventNames : splitEventQueries(request.query)
  if (request.eventRecognition || eventNames.length > 1) {
    const eventList = eventNames.map((name, index) => `${index + 1}. ${name}`).join('\n')
    return [
      '你是实时视频事件判断模型。',
      '用户会用英文分号 ; 分隔多个事件，你必须逐个事件独立判断。',
      `当前事件列表：\n${eventList}`,
      `请结合最近约 ${Math.round((request.semanticWindowMs || 10000) / 1000)} 秒连续视频帧和会话上下文，分别判断每个事件是否已经发生或正在发生。`,
      '必须为每个事件返回一项，name 必须和事件列表完全一致。',
      '只返回严格 JSON，不要解释，不要 Markdown。',
      '格式：{"events":[{"name":"事件文字","current_frame_occurred":false,"event_occurred":false,"reason":"简短原因"}]}',
    ].join('\n')
  }
  return [
    '你是实时视频目标定位模型。',
    `当前 query：${request.query}`,
    '只返回严格 JSON，不要解释，不要 Markdown。',
    '格式必须为 {"bbox":[x,y,w,h]} 或 {"bbox":null}。',
    'bbox 使用 scale1000 坐标，x/y 为左上角，w/h 是宽度和高度，范围均为 0 到 1000。',
  ].join('\n')
}

function maxTokensFor(request) {
  const eventCount = (request.eventNames?.length ? request.eventNames : splitEventQueries(request.query)).length
  if (request.eventRecognition || eventCount > 1) return Math.max(64, Math.min(160, eventCount * 64))
  return 64
}

function parseJsonObject(text) {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim()
  const compact = cleaned.replace(/\s/g, '')
  if (/^\?{16,}$/.test(compact)) {
    throw new Error('模型返回连续问号，通常表示服务器端 GGUF/mmproj/runtime 组合异常，或视觉模板不兼容。请确认主模型和 mmproj 来自同一预设，并使用单 slot、大上下文启动。')
  }
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1))
    throw new Error(`模型未返回有效 JSON：${cleaned.slice(0, 500)}`)
  }
}

function fallbackResult(request, rawText, reason) {
  const eventNames = request.eventNames?.length ? request.eventNames : splitEventQueries(request.query)
  if (request.eventRecognition || eventNames.length > 1) {
    return {
      events: eventNames.map((name) => ({
        name,
        current_frame_occurred: false,
        event_occurred: false,
        reason,
      })),
      bbox: null,
      rawOutput: rawText,
    }
  }
  return {
    bbox: null,
    reason,
    rawOutput: rawText,
  }
}

async function runtimeError(response) {
  const body = await response.text()
  let message = body
  try {
    message = JSON.parse(body).error?.message || body
  } catch {
    // keep raw body
  }
  if (/failed to process mtmd chunk|failed to decode image|failed to find a memory slot/i.test(message)) {
    return `视觉 chunk 处理失败：${message}。这通常是 llama-server 的 KV slot/上下文不足，或主模型与 mmproj 不匹配；建议使用 --parallel 1、增大 --ctx-size，并确认 mmproj 来自同一模型预设。`
  }
  return `MiniCPM-o runtime HTTP ${response.status}: ${body}`
}

export function createMiniCpmOProvider(config = {}) {
  const endpoint = config.endpoint || 'http://127.0.0.1:8080/v1/chat/completions'
  const model = config.model || 'MiniCPM-o-4.5'
  const apiKey = config.apiKey || ''
  return {
    name: 'minicpm-o',
    async recognizeFrame(request) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: maxTokensFor(request),
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: buildPrompt(request) },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${request.imageBase64 || ''}`,
                  },
                },
              ],
            },
          ],
        }),
      })
      if (!response.ok) {
        const reason = await runtimeError(response)
        return fallbackResult(request, '', reason)
      }
      const payload = await response.json()
      const text = payload.choices?.[0]?.message?.content || payload.text || ''
      try {
        return parseJsonObject(text)
      } catch (error) {
        return fallbackResult(request, String(text), error instanceof Error ? error.message : '模型未返回有效 JSON')
      }
    },
  }
}
