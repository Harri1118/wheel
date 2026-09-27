import type { GridPosition, WheelNode, WheelWire } from './types'
import type { AgentLogEntry, WheelApi } from './wheel-api'

export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting'
export type NodeStatePayload = { node_id?: string; nodeId?: string; status?: string; position?: GridPosition }
export type BoardChanges = { added?: WheelNode[]; removed?: string[]; wires?: WheelWire[] }
export type BoardChangedPayload = BoardChanges & { changes?: BoardChanges }
export type NodeMessagePayload = { node_id?: string }
export type LogPayload = AgentLogEntry & { node_id?: string }
export type WireDeniedPayload = { from?: string; to?: string; type?: string }
export type PeersPayload = { count?: number; peers?: unknown[] }
export type EventFrame = { kind?: string; type?: string; payload?: unknown }

export type WheelEventHandlers = {
  onConnectionChange?: (status: ConnectionStatus) => void
  onNodeState?: (payload: NodeStatePayload) => void
  onBoardChanged?: (payload: BoardChangedPayload) => void
  onMessage?: (payload: NodeMessagePayload) => void
  onLog?: (payload: LogPayload) => void
  onWireDenied?: (payload: WireDeniedPayload) => void
  onLagged?: () => void
  onPeers?: (payload: PeersPayload) => void
  onUnknown?: (frame: EventFrame) => void
}

type TicketApi = Pick<WheelApi, 'apiUrl' | 'request'>
type TicketResponse = { ticket?: string } | null

const MAX_RECONNECT_DELAY_MS = 30000
const BASE_RECONNECT_DELAY_MS = 1000

export class WheelEventSource {
  readonly api: TicketApi
  readonly projectId: string
  readonly handlers: WheelEventHandlers
  private ws: WebSocket | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private pendingFrames: EventFrame[] = []
  private flushScheduled = false

  constructor(api: TicketApi, projectId: string, handlers: WheelEventHandlers) {
    this.api = api
    this.projectId = projectId
    this.handlers = handlers
  }

  async connect(): Promise<void> {
    if (this.disposed) return

    const ticket = await this.fetchTicket()

    if (!ticket) {
      this.scheduleReconnect()
      return
    }

    const ws = new WebSocket(this.buildWsUrl(ticket))

    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempt = 0
      this.handlers.onConnectionChange?.('connected')
    }

    ws.onmessage = (event: MessageEvent) => {
      this.handleFrame(event.data)
    }

    ws.onclose = () => {
      this.ws = null
      this.handlers.onConnectionChange?.('disconnected')

      if (!this.disposed) {
        this.scheduleReconnect()
      }
    }

    ws.onerror = () => {}
  }

  disconnect(): void {
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

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private async fetchTicket(): Promise<string | null> {
    try {
      const result = await this.api.request<TicketResponse>(
        `/v1/projects/${encodeURIComponent(this.projectId)}/ws-ticket`,
        { method: 'POST' }
      )

      return result?.ticket || null
    } catch {
      return null
    }
  }

  private buildWsUrl(ticket: string): string {
    const base = this.api.apiUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:')

    return `${base}/v1/projects/${encodeURIComponent(this.projectId)}/engine/v1/events?ticket=${encodeURIComponent(ticket)}`
  }

  private handleFrame(raw: string): void {
    let frame: EventFrame

    try {
      frame = JSON.parse(raw) as EventFrame
    } catch {
      return
    }

    this.pendingFrames.push(frame)

    if (!this.flushScheduled) {
      this.flushScheduled = true
      requestAnimationFrame(() => this.flushFrames())
    }
  }

  private flushFrames(): void {
    this.flushScheduled = false

    for (const frame of this.pendingFrames.splice(0)) {
      this.dispatchFrame(frame)
    }
  }

  private dispatchFrame(frame: EventFrame): void {
    const payload = frame.payload || frame

    switch (frame.kind || frame.type) {
      case 'node.state':
        this.handlers.onNodeState?.(payload as NodeStatePayload)
        break
      case 'board.changed':
        this.handlers.onBoardChanged?.(payload as BoardChangedPayload)
        break
      case 'message':
        this.handlers.onMessage?.(payload as NodeMessagePayload)
        break
      case 'log':
        this.handlers.onLog?.(payload as LogPayload)
        break
      case 'wire.denied':
        this.handlers.onWireDenied?.(payload as WireDeniedPayload)
        break
      case 'lagged':
        this.handlers.onLagged?.()
        break
      case 'peers':
        this.handlers.onPeers?.(payload as PeersPayload)
        break
      default:
        this.handlers.onUnknown?.(frame)
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return

    const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempt), MAX_RECONNECT_DELAY_MS)

    this.reconnectAttempt++
    this.handlers.onConnectionChange?.('reconnecting')

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}
