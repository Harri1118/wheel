// WebSocket client for Wheel's real-time event stream.
// Mirrors the reconnection and batching logic from web/src/lib/events.ts
// but adapted for the AgentGrid extension panel environment.

// eslint-disable-next-line no-unused-vars
class WheelEventSource {
  constructor(api, projectId, handlers) {
    this.api = api
    this.projectId = projectId
    this.handlers = handlers
    this.ws = null
    this.reconnectAttempt = 0
    this.reconnectTimer = null
    this.disposed = false
    this.pendingFrames = []
    this.flushScheduled = false
  }

  async connect() {
    if (this.disposed) return

    const ticket = await this.fetchTicket()

    if (!ticket) {
      this.scheduleReconnect()
      return
    }

    const wsUrl = this.buildWsUrl(ticket)
    this.ws = new WebSocket(wsUrl)

    this.ws.onopen = () => {
      this.reconnectAttempt = 0
      this.handlers.onConnectionChange?.('connected')
    }

    this.ws.onmessage = (event) => {
      this.handleFrame(event.data)
    }

    this.ws.onclose = (event) => {
      this.ws = null
      this.handlers.onConnectionChange?.('disconnected')

      if (!this.disposed) {
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = () => {
      // onclose fires after onerror — reconnection handled there
    }
  }

  async fetchTicket() {
    try {
      const result = await this.api.request(
        `/v1/projects/${encodeURIComponent(this.projectId)}/ws-ticket`,
        { method: 'POST' }
      )
      return result?.ticket || null
    } catch {
      return null
    }
  }

  buildWsUrl(ticket) {
    const base = this.api.apiUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:')
    return `${base}/v1/projects/${encodeURIComponent(this.projectId)}/engine/v1/events?ticket=${encodeURIComponent(ticket)}`
  }

  handleFrame(raw) {
    let frame
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }

    this.pendingFrames.push(frame)

    if (!this.flushScheduled) {
      this.flushScheduled = true
      requestAnimationFrame(() => this.flushFrames())
    }
  }

  flushFrames() {
    this.flushScheduled = false
    const batch = this.pendingFrames.splice(0)

    for (const frame of batch) {
      this.dispatchFrame(frame)
    }
  }

  dispatchFrame(frame) {
    const kind = frame.kind || frame.type

    switch (kind) {
      case 'node.state':
        this.handlers.onNodeState?.(frame.payload || frame)
        break
      case 'board.changed':
        this.handlers.onBoardChanged?.(frame.payload || frame)
        break
      case 'message':
        this.handlers.onMessage?.(frame.payload || frame)
        break
      case 'log':
        this.handlers.onLog?.(frame.payload || frame)
        break
      case 'wire.denied':
        this.handlers.onWireDenied?.(frame.payload || frame)
        break
      case 'lagged':
        this.handlers.onLagged?.()
        break
      case 'peers':
        this.handlers.onPeers?.(frame.payload || frame)
        break
      default:
        this.handlers.onUnknown?.(frame)
    }
  }

  scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30000)
    this.reconnectAttempt++
    this.handlers.onConnectionChange?.('reconnecting')

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  disconnect() {
    this.disposed = true

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }

    this.handlers.onConnectionChange?.('disconnected')
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WheelEventSource }
}
