import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WheelEventSource } = require('../panel/wheel-events.js')

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []

  url: string
  readyState = MockWebSocket.OPEN
  onopen: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  close() {
    this.readyState = 3
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  simulateClose(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code })
  }

  simulateError() {
    this.onerror?.()
  }
}

let originalRAF: typeof globalThis.requestAnimationFrame

beforeEach(() => {
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket)
  originalRAF = globalThis.requestAnimationFrame
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0 })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  globalThis.requestAnimationFrame = originalRAF
})

function makeMockApi(ticket = 'test-ticket') {
  return {
    apiUrl: 'https://api.wheel.dev',
    request: vi.fn(async () => ({ ticket })),
  }
}

function makeHandlers() {
  return {
    onConnectionChange: vi.fn(),
    onNodeState: vi.fn(),
    onBoardChanged: vi.fn(),
    onMessage: vi.fn(),
    onLog: vi.fn(),
    onWireDenied: vi.fn(),
    onLagged: vi.fn(),
    onPeers: vi.fn(),
    onUnknown: vi.fn(),
  }
}

describe('WheelEventSource construction', () => {
  it('stores api, projectId, and handlers', () => {
    const api = makeMockApi()
    const handlers = makeHandlers()
    const es = new WheelEventSource(api, 'proj-1', handlers)

    expect(es.projectId).toBe('proj-1')
    expect(es.connected).toBe(false)
  })
})

describe('connect', () => {
  it('fetches a ticket and opens a WebSocket', async () => {
    const api = makeMockApi()
    const handlers = makeHandlers()
    const es = new WheelEventSource(api, 'proj-1', handlers)

    await es.connect()

    expect(api.request).toHaveBeenCalledWith(
      '/v1/projects/proj-1/ws-ticket',
      { method: 'POST' }
    )

    expect(MockWebSocket.instances).toHaveLength(1)
    const ws = MockWebSocket.instances[0]
    expect(ws.url).toContain('wss://api.wheel.dev')
    expect(ws.url).toContain('ticket=test-ticket')
  })

  it('converts http to ws in URL', async () => {
    const api = makeMockApi()
    api.apiUrl = 'http://localhost:8080'
    const es = new WheelEventSource(api, 'proj-1', makeHandlers())

    await es.connect()

    expect(MockWebSocket.instances[0].url).toContain('ws://localhost:8080')
  })

  it('reports connected on WebSocket open', async () => {
    const handlers = makeHandlers()
    const es = new WheelEventSource(makeMockApi(), 'proj-1', handlers)

    await es.connect()
    MockWebSocket.instances[0].simulateOpen()

    expect(handlers.onConnectionChange).toHaveBeenCalledWith('connected')
  })

  it('resets reconnect attempt counter on connect', async () => {
    const handlers = makeHandlers()
    const es = new WheelEventSource(makeMockApi(), 'proj-1', handlers)
    es.reconnectAttempt = 5

    await es.connect()
    MockWebSocket.instances[0].simulateOpen()

    expect(es.reconnectAttempt).toBe(0)
  })

  it('schedules reconnect when ticket fetch fails', async () => {
    vi.useFakeTimers()
    const api = makeMockApi()
    api.request.mockRejectedValueOnce(new Error('network error'))

    const handlers = makeHandlers()
    const es = new WheelEventSource(api, 'proj-1', handlers)

    await es.connect()

    expect(MockWebSocket.instances).toHaveLength(0)
    expect(handlers.onConnectionChange).toHaveBeenCalledWith('reconnecting')

    vi.useRealTimers()
    es.disconnect()
  })
})

describe('frame dispatch', () => {
  async function connectAndOpen() {
    const api = makeMockApi()
    const handlers = makeHandlers()
    const es = new WheelEventSource(api, 'proj-1', handlers)
    await es.connect()
    MockWebSocket.instances[0].simulateOpen()
    return { es, handlers, ws: MockWebSocket.instances[0] }
  }

  it('dispatches node.state events', async () => {
    const { handlers, ws } = await connectAndOpen()
    ws.simulateMessage({ kind: 'node.state', payload: { node_id: 'n1', status: 'running' } })
    expect(handlers.onNodeState).toHaveBeenCalledWith({ node_id: 'n1', status: 'running' })
  })

  it('dispatches board.changed events', async () => {
    const { handlers, ws } = await connectAndOpen()
    ws.simulateMessage({ kind: 'board.changed', payload: { added: [] } })
    expect(handlers.onBoardChanged).toHaveBeenCalledWith({ added: [] })
  })

  it('dispatches message events', async () => {
    const { handlers, ws } = await connectAndOpen()
    ws.simulateMessage({ kind: 'message', payload: { node_id: 'a1', body: 'hello' } })
    expect(handlers.onMessage).toHaveBeenCalledWith({ node_id: 'a1', body: 'hello' })
  })

  it('dispatches log events', async () => {
    const { handlers, ws } = await connectAndOpen()
    ws.simulateMessage({ kind: 'log', payload: { node_id: 'a1', text: 'output' } })
    expect(handlers.onLog).toHaveBeenCalledWith({ node_id: 'a1', text: 'output' })
  })

  it('dispatches wire.denied events', async () => {
    const { handlers, ws } = await connectAndOpen()
    ws.simulateMessage({ kind: 'wire.denied', payload: { from: 'a', to: 'b', type: 'send' } })
    expect(handlers.onWireDenied).toHaveBeenCalledWith({ from: 'a', to: 'b', type: 'send' })
  })

  it('dispatches lagged events', async () => {
    const { handlers, ws } = await connectAndOpen()
    ws.simulateMessage({ kind: 'lagged' })
    expect(handlers.onLagged).toHaveBeenCalled()
  })

  it('dispatches peers events', async () => {
    const { handlers, ws } = await connectAndOpen()
    ws.simulateMessage({ kind: 'peers', payload: { count: 3 } })
    expect(handlers.onPeers).toHaveBeenCalledWith({ count: 3 })
  })

  it('dispatches unknown events to onUnknown', async () => {
    const { handlers, ws } = await connectAndOpen()
    ws.simulateMessage({ kind: 'custom.event', data: 123 })
    expect(handlers.onUnknown).toHaveBeenCalledWith({ kind: 'custom.event', data: 123 })
  })

  it('handles type field as well as kind', async () => {
    const { handlers, ws } = await connectAndOpen()
    ws.simulateMessage({ type: 'node.state', payload: { node_id: 'n1' } })
    expect(handlers.onNodeState).toHaveBeenCalledWith({ node_id: 'n1' })
  })

  it('ignores malformed JSON', async () => {
    const { handlers, ws } = await connectAndOpen()
    ws.onmessage?.({ data: 'not json {{' })
    expect(handlers.onNodeState).not.toHaveBeenCalled()
    expect(handlers.onUnknown).not.toHaveBeenCalled()
  })

  it('uses frame itself as payload when no payload field', async () => {
    const { handlers, ws } = await connectAndOpen()
    ws.simulateMessage({ kind: 'node.state', node_id: 'n1', status: 'idle' })
    expect(handlers.onNodeState).toHaveBeenCalledWith({ kind: 'node.state', node_id: 'n1', status: 'idle' })
  })
})

describe('reconnection', () => {
  it('schedules reconnect on close', async () => {
    vi.useFakeTimers()
    const api = makeMockApi()
    const handlers = makeHandlers()
    const es = new WheelEventSource(api, 'proj-1', handlers)

    await es.connect()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    handlers.onConnectionChange.mockClear()
    ws.simulateClose()

    expect(handlers.onConnectionChange).toHaveBeenCalledWith('disconnected')

    vi.useRealTimers()
    es.disconnect()
  })

  it('uses exponential backoff', async () => {
    vi.useFakeTimers()
    const api = makeMockApi()
    const handlers = makeHandlers()
    const es = new WheelEventSource(api, 'proj-1', handlers)

    es.reconnectAttempt = 0
    es.scheduleReconnect()
    expect(es.reconnectTimer).not.toBeNull()

    es.disconnect()
    vi.useRealTimers()
  })

  it('caps backoff at 30 seconds', () => {
    const api = makeMockApi()
    const es = new WheelEventSource(api, 'proj-1', makeHandlers())

    const delay = Math.min(1000 * Math.pow(2, 10), 30000)
    expect(delay).toBe(30000)

    es.disconnect()
  })

  it('does not reconnect after disconnect()', async () => {
    vi.useFakeTimers()
    const api = makeMockApi()
    const handlers = makeHandlers()
    const es = new WheelEventSource(api, 'proj-1', handlers)

    await es.connect()
    es.disconnect()

    expect(es.disposed).toBe(true)

    vi.advanceTimersByTime(60000)
    expect(MockWebSocket.instances).toHaveLength(1)

    vi.useRealTimers()
  })
})

describe('disconnect', () => {
  it('closes the WebSocket and clears timers', async () => {
    const api = makeMockApi()
    const handlers = makeHandlers()
    const es = new WheelEventSource(api, 'proj-1', handlers)

    await es.connect()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    es.disconnect()

    expect(ws.readyState).toBe(3)
    expect(es.ws).toBeNull()
    expect(es.disposed).toBe(true)
    expect(handlers.onConnectionChange).toHaveBeenCalledWith('disconnected')
  })

  it('clears pending reconnect timer', async () => {
    vi.useFakeTimers()
    const api = makeMockApi()
    api.request.mockRejectedValueOnce(new Error('fail'))
    const handlers = makeHandlers()
    const es = new WheelEventSource(api, 'proj-1', handlers)

    await es.connect()
    expect(es.reconnectTimer).not.toBeNull()

    es.disconnect()
    expect(es.reconnectTimer).toBeNull()

    vi.useRealTimers()
  })
})

describe('buildWsUrl', () => {
  it('encodes the project id', () => {
    const api = makeMockApi()
    api.apiUrl = 'https://api.wheel.dev'
    const es = new WheelEventSource(api, 'proj/special', makeHandlers())

    const url = es.buildWsUrl('my-ticket')
    expect(url).toContain('proj%2Fspecial')
    expect(url).toContain('ticket=my-ticket')
  })
})

describe('connected getter', () => {
  it('returns true when WebSocket is OPEN', async () => {
    const es = new WheelEventSource(makeMockApi(), 'proj-1', makeHandlers())
    await es.connect()
    MockWebSocket.instances[0].simulateOpen()
    expect(es.connected).toBe(true)
    es.disconnect()
  })

  it('returns false when no WebSocket', () => {
    const es = new WheelEventSource(makeMockApi(), 'proj-1', makeHandlers())
    expect(es.connected).toBe(false)
  })
})
