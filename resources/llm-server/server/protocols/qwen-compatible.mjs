export function splitEventQueries(query) {
  return String(query || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function extractQueryFromInstructions(instructions) {
  const text = String(instructions || '')
  const currentQuery = text.match(/当前 query：(.+)/)
  if (currentQuery?.[1]) return currentQuery[1].trim()
  const eventBlock = text.match(/当前事件列表：\s*\n([\s\S]*?)(?:\n请结合|\n必须区分|\n本模式|$)/)
  if (!eventBlock?.[1]) return ''
  return extractEventNamesFromInstructions(text).join('; ')
}

export function extractEventNamesFromInstructions(instructions) {
  const text = String(instructions || '')
  const block = text.match(/当前事件列表：\s*\n([\s\S]*?)(?:\n请结合|\n必须区分|\n本模式|$)/)?.[1] || ''
  return block
    .split('\n')
    .map((line) => line.replace(/^\s*\d+[.)、]\s*/, '').trim())
    .filter(Boolean)
}

export function looksLikeEventRecognition(instructions, query) {
  const text = String(instructions || '')
  return text.includes('实时视频事件判断模型') || text.includes('current_frame_occurred') || splitEventQueries(query).length > 1
}

export function toQwenText(result) {
  if (Array.isArray(result.events)) {
    return JSON.stringify({
      events: result.events.map((event) => ({
        name: event.name,
        current_frame_occurred: Boolean(event.current_frame_occurred),
        event_occurred: Boolean(event.event_occurred),
        reason: event.reason || '',
      })),
    })
  }
  return JSON.stringify({ bbox: normalizeBbox(result.bbox) })
}

export function normalizeBbox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null
  const nums = value.map(Number)
  if (nums.some((item) => !Number.isFinite(item))) return null
  return nums.map((item) => Math.round(Math.max(0, Math.min(1000, item))))
}
