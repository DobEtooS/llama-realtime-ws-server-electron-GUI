import { normalizeBbox, splitEventQueries } from '../protocols/qwen-compatible.mjs'

export function createMockProvider(config = {}) {
  const defaultOccurred = Boolean(config.eventOccurred)
  return {
    name: 'mock',
    async recognizeFrame(request) {
      const eventNames = request.eventNames?.length ? request.eventNames : splitEventQueries(request.query)
      if (request.eventRecognition || eventNames.length > 1) {
        return {
          events: eventNames.map((name) => ({
            name,
            current_frame_occurred: defaultOccurred,
            event_occurred: defaultOccurred,
            reason: defaultOccurred
              ? `mock provider 已按配置标记“${name}”发生`
              : `mock provider 已收到画面，但尚未接入视觉模型，默认不判定“${name}”发生`,
          })),
          bbox: null,
        }
      }
      return {
        events: [],
        bbox: normalizeBbox(config.bbox) || null,
        reason: 'mock provider 已收到画面，默认返回 bbox null',
      }
    },
  }
}
