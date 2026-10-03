import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockProvider } from './providers/mock.mjs'
import { createMiniCpmOProvider } from './providers/minicpm_o.mjs'
import {
  extractEventNamesFromInstructions,
  extractQueryFromInstructions,
  looksLikeEventRecognition,
  splitEventQueries,
  toQwenText,
} from './protocols/qwen-compatible.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--config') args.config = argv[++index]
    else if (item === '--host') args.host = argv[++index]
    else if (item === '--port') args.port = Number(argv[++index])
    else if (item === '--provider') args.provider = argv[++index]
  }
  return args
}

function loadConfig() {
  const args = parseArgs(process.argv.slice(2))
  const defaultPath = resolve(rootDir, 'config/server.json')
  const examplePath = resolve(rootDir, 'config/server.example.json')
  const configPath = resolve(args.config || process.env.LLM_SERVER_CONFIG || (existsSync(defaultPath) ? defaultPath : examplePath))
  const fileConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
  return {
    host: args.host || process.env.LLM_SERVER_HOST || fileConfig.host || '127.0.0.1',
    port: Number(args.port || process.env.LLM_SERVER_PORT || fileConfig.port || 8765),
    provider: args.provider || process.env.LLM_SERVER_PROVIDER || fileConfig.provider || 'mock',
    apiKey: process.env.LLM_SERVER_API_KEY ?? fileConfig.apiKey ?? '',
    defaultMode: fileConfig.defaultMode || 'video',
    mock: fileConfig.mock || {},
    minicpmO: {
      ...(fileConfig.minicpmO || {}),
      endpoint: process.env.MINICPM_O_ENDPOINT || fileConfig.minicpmO?.endpoint,
      apiKey: process.env.MINICPM_O_API_KEY ?? fileConfig.minicpmO?.apiKey,
      model: process.env.MINICPM_O_MODEL || fileConfig.minicpmO?.model,
    },
  }
}

function createProvider(config) {
  if (config.provider === 'minicpm-o' || config.provider === 'minicpm_o') {
    return createMiniCpmOProvider(config.minicpmO)
  }
  return createMockProvider(config.mock)
}

const config = loadConfig()
const provider = createProvider(config)

const server = createServer((req, res) => {
  if (req.url?.startsWith('/health')) {
    writeJson(res, 200, {
      ok: true,
      provider: provider.name,
      model: config.minicpmO?.model || '',
      client_model_name: config.minicpmO?.model || '',
      preset: config.preset || null,
      endpoint: publicRealtimeEndpoint(req),
    })
    return
  }
  writeJson(res, 200, {
    name: 'local-full-duplex-llm-server',
    provider: provider.name,
    model: config.minicpmO?.model || '',
    client_model_name: config.minicpmO?.model || '',
    realtime: `/v1/realtime?mode=${config.defaultMode}`,
  })
})

function publicRealtimeEndpoint(req) {
  const forwardedHost = Array.isArray(req.headers['x-forwarded-host'])
    ? req.headers['x-forwarded-host'][0]
    : req.headers['x-forwarded-host']
  const forwardedProto = Array.isArray(req.headers['x-forwarded-proto'])
    ? req.headers['x-forwarded-proto'][0]
    : req.headers['x-forwarded-proto']
  const host = forwardedHost || req.headers.host || `${config.host}:${config.port}`
  const proto = forwardedProto === 'https' ? 'wss' : 'ws'
  return `${proto}://${host}/v1/realtime?mode=${config.defaultMode}`
}

server.on('upgrade', (req, socket) => {
  try {
    const target = new URL(req.url || '/', `http://${req.headers.host || `${config.host}:${config.port}`}`)
    if (target.pathname !== '/v1/realtime') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    if (!isAuthorized(req, target)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    )
    attachConnection(socket, { mode: target.searchParams.get('mode') || config.defaultMode })
  } catch (error) {
    socket.destroy(error)
  }
})

server.listen(config.port, config.host, () => {
  console.log(`llm-server listening on ws://${config.host}:${config.port}/v1/realtime?mode=${config.defaultMode}`)
  console.log(`provider: ${provider.name}`)
})

function writeJson(res, status, data) {
  const body = `${JSON.stringify(data, null, 2)}\n`
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function isAuthorized(req, target) {
  if (!config.apiKey) return true
  const auth = String(req.headers.authorization || '')
  return auth === `Bearer ${config.apiKey}` || target.searchParams.get('api_key') === config.apiKey
}

function attachConnection(socket, initialState) {
  const state = {
    id: randomUUID(),
    mode: initialState.mode,
    instructions: '',
    query: '',
    imageBase64: '',
    eventRecognition: false,
    semanticWindowMs: 10000,
  }
  let buffer = Buffer.alloc(0)
  sendJson(socket, { type: 'session.created', session: { id: state.id, provider: provider.name } })

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    const parsed = readFrames(buffer)
    buffer = parsed.rest
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x8) {
        socket.end()
        return
      }
      if (frame.opcode === 0x9) {
        sendFrame(socket, frame.payload, 0x0a)
        continue
      }
      if (frame.opcode !== 0x1) continue
      handleMessage(socket, state, frame.payload.toString('utf8')).catch((error) => {
        sendJson(socket, { type: 'error', error: { message: error instanceof Error ? error.message : String(error) } })
      })
    }
  })
}

async function handleMessage(socket, state, text) {
  const message = JSON.parse(text)
  if (message.type === 'frame') {
    await handleNativeFrame(socket, state, message)
    return
  }
  if (message.type === 'session.update') {
    const session = message.session || {}
    state.instructions = String(session.instructions || '')
    state.query = extractQueryFromInstructions(state.instructions) || state.query
    state.eventRecognition = looksLikeEventRecognition(state.instructions, state.query)
    state.semanticWindowMs = extractSemanticWindowMs(state.instructions)
    sendJson(socket, { type: 'session.updated', session: { id: state.id } })
    return
  }
  if (message.type === 'input_image_buffer.append') {
    state.imageBase64 = String(message.image || message.image_base64 || '').replace(/^data:image\/\w+;base64,/, '')
    return
  }
  if (message.type === 'response.create') {
    await handleQwenResponse(socket, state)
  }
}

async function handleNativeFrame(socket, state, message) {
  const startedAt = Date.now()
  const query = String(message.query || state.query || '').trim()
  const options = message.options || {}
  const eventNames = splitEventQueries(query)
  const result = await provider.recognizeFrame({
    mode: state.mode,
    query,
    eventNames,
    eventRecognition: Boolean(options.event_recognition ?? options.eventRecognition ?? eventNames.length > 1),
    semanticWindowMs: Number(options.semantic_window_ms || options.semanticWindowMs || state.semanticWindowMs || 10000),
    imageBase64: String(message.image_base64 || message.imageBase64 || '').replace(/^data:image\/\w+;base64,/, ''),
  })
  sendJson(socket, {
    type: 'result',
    events: result.events || [],
    bbox: result.bbox ?? null,
    latency_ms: Date.now() - startedAt,
    raw_output: result.rawOutput,
  })
}

async function handleQwenResponse(socket, state) {
  const query = state.query || extractQueryFromInstructions(state.instructions)
  const eventNames = extractEventNamesFromInstructions(state.instructions)
  const result = await provider.recognizeFrame({
    mode: state.mode,
    query,
    eventNames: eventNames.length ? eventNames : splitEventQueries(query),
    eventRecognition: state.eventRecognition,
    semanticWindowMs: state.semanticWindowMs,
    imageBase64: state.imageBase64,
    instructions: state.instructions,
  })
  const output = toQwenText(result)
  sendJson(socket, { type: 'response.text.delta', delta: output })
  sendJson(socket, { type: 'response.text.done', text: output })
  sendJson(socket, {
    type: 'response.done',
    response: { output: [{ content: [{ type: 'text', text: output }] }] },
  })
}

function extractSemanticWindowMs(instructions) {
  const seconds = String(instructions || '').match(/最近约\s*(\d+)\s*秒/)
  return seconds ? Number(seconds[1]) * 1000 : 10000
}

function readFrames(buffer) {
  const frames = []
  let offset = 0
  while (buffer.length - offset >= 2) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const opcode = first & 0x0f
    const masked = Boolean(second & 0x80)
    let length = second & 0x7f
    let headerLength = 2
    if (length === 126) {
      if (buffer.length - offset < 4) break
      length = buffer.readUInt16BE(offset + 2)
      headerLength = 4
    } else if (length === 127) {
      if (buffer.length - offset < 10) break
      length = Number(buffer.readBigUInt64BE(offset + 2))
      headerLength = 10
    }
    const maskLength = masked ? 4 : 0
    const payloadOffset = offset + headerLength + maskLength
    const nextOffset = payloadOffset + length
    if (buffer.length < nextOffset) break
    let payload = buffer.slice(payloadOffset, nextOffset)
    if (masked) {
      const mask = buffer.slice(offset + headerLength, offset + headerLength + 4)
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]))
    }
    frames.push({ opcode, payload })
    offset = nextOffset
  }
  return { frames, rest: buffer.slice(offset) }
}

function sendJson(socket, data) {
  sendFrame(socket, Buffer.from(JSON.stringify(data), 'utf8'), 0x1)
}

function sendFrame(socket, payload, opcode) {
  const length = payload.length
  const header = length < 126 ? Buffer.alloc(2) : length <= 0xffff ? Buffer.alloc(4) : Buffer.alloc(10)
  header[0] = 0x80 | opcode
  if (length < 126) {
    header[1] = length
  } else if (length <= 0xffff) {
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  socket.write(Buffer.concat([header, payload]))
}
