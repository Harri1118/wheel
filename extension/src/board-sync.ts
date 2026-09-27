import type { PanelClient } from '@agentgrid/sdk'
import { summarizeWires } from './board-state'
import { buildAgentPrompt, buildNoteBody, wheelToCanvas } from './spawn-plan'
import type { CanvasPosition, NodesById } from './spawn-plan'
import type { GridPosition, NodeConfig, NodeType, WheelBoard, WheelNode, WheelWire, WireSummary } from './types'
import type { AgentLogEntry, WheelApi } from './wheel-api'
import type { BoardChangedPayload, NodeStatePayload } from './wheel-events'

export type BoardSyncHost = Pick<PanelClient, 'canvas' | 'state'>
export type NodePaneLink = { paneId: string; type: 'worker' | 'note' }
export type PaneNodeLink = { nodeId: string; nodeType: NodeType }
export type SpawnError = { nodeId: string; name: string; error: string }
export type SpawnResult = { spawned: number; failed: number; errors: SpawnError[] }
export type NodeWithWires = WheelNode & { wires: WireSummary[] }

type TopologyConnections = { out: string[]; in: string[] }
type PersistedSync = {
  projectId: string | null
  nodeToPane: Array<[string, NodePaneLink]>
  paneToNode: Array<[string, PaneNodeLink]>
  topologyPaneId: string | null
}

const GRID_SCALE = 120
const GRID_OFFSET = 100
const DEFAULT_LOG_POLL_MS = 5000

export class BoardSync {
  nodeToPane = new Map<string, NodePaneLink>()
  paneToNode = new Map<string, PaneNodeLink>()
  projectId: string | null = null
  nodesById: NodesById = {}
  wires: WheelWire[] = []
  topologyPaneId: string | null = null
  peerCount = 0
  onPeerCountChange: ((count: number) => void) | null = null
  onAgentLog: ((nodeId: string, paneId: string, entries: AgentLogEntry[]) => void) | null = null
  onAgentStatusChange: ((nodeId: string, paneId: string, status: string) => void) | null = null
  private logPollers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(private host: BoardSyncHost) {}

  async openProject(api: WheelApi, projectId: string, scale = GRID_SCALE, offsetX = GRID_OFFSET, offsetY = GRID_OFFSET): Promise<SpawnResult> {
    this.projectId = projectId
    const board = await api.getBoard(projectId)

    return this.spawnBoard(board, scale, offsetX, offsetY)
  }

  async spawnBoard(board: WheelBoard, scale: number, offsetX: number, offsetY: number): Promise<SpawnResult> {
    const nodes = board.nodes || []
    const results: SpawnResult = { spawned: 0, failed: 0, errors: [] }

    this.wires = board.wires || []
    this.nodesById = {}
    for (const n of nodes) this.nodesById[n.id] = n

    for (const node of nodes) {
      const pos = wheelToCanvas(node.position || { x: 0, y: 0 }, scale, offsetX, offsetY)

      try {
        await this.spawnPaneForNode(node, pos)
        results.spawned++
      } catch (err) {
        results.failed++
        results.errors.push({ nodeId: node.id, name: node.name, error: err instanceof Error ? err.message : String(err) })
      }
    }

    await this.spawnTopologyNote()
    this.persistState()

    return results
  }

  async spawnWorkerForNode(node: WheelNode, position?: CanvasPosition): Promise<{ paneId: string }> {
    const relevantWires = this.wires.filter(w => w.from === node.id || w.to === node.id)
    const prompt = buildAgentPrompt(node, relevantWires, this.nodesById, this.projectId ?? '')
    const result = await this.host.canvas.spawn({
      kind: 'note',
      title: `${node.name} (agent)`,
      body: prompt,
      x: position?.x,
      y: position?.y,
    })

    this.linkPane(node, result?.paneId, 'worker')

    return result
  }

  async spawnNoteForNode(node: WheelNode, position?: CanvasPosition): Promise<{ paneId: string }> {
    const result = await this.host.canvas.spawn({
      kind: 'note',
      title: `${node.name} (${node.type})`,
      body: buildNoteBody(node),
      x: position?.x,
      y: position?.y,
    })

    this.linkPane(node, result?.paneId, 'note')

    return result
  }

  async spawnTopologyNote(): Promise<void> {
    if (this.wires.length === 0) return

    try {
      const result = await this.host.canvas.spawn({
        kind: 'note',
        title: 'Wheel Topology',
        body: this.buildTopologyBody(),
      })

      this.topologyPaneId = result?.paneId || null
    } catch {
      return
    }
  }

  buildTopologyBody(): string {
    const lines = [`**Project:** ${this.projectId}`, '']
    const connectionsByName = new Map<string, TopologyConnections>()

    for (const w of this.wires) {
      const fromNode = this.nodesById[w.from]
      const toNode = this.nodesById[w.to]

      if (!fromNode || !toNode) continue

      const fromConnections = connectionsFor(connectionsByName, fromNode.name)
      const toConnections = connectionsFor(connectionsByName, toNode.name)

      fromConnections.out.push(`  → ${w.type} → **${toNode.name}** (${toNode.type})`)
      toConnections.in.push(`  ← ${w.type} ← **${fromNode.name}** (${fromNode.type})`)
    }

    for (const [name, connections] of connectionsByName) {
      lines.push(`### ${name}`, ...connections.out, ...connections.in, '')
    }

    return lines.join('\n')
  }

  startAgentLogPolling(api: WheelApi, nodeId: string, intervalMs = DEFAULT_LOG_POLL_MS): void {
    const entry = this.nodeToPane.get(nodeId)

    if (!entry || entry.type !== 'worker') return
    if (this.logPollers.has(nodeId)) return

    let since = 0
    const timer = setInterval(async () => {
      if (!this.projectId) {
        this.stopAgentLogPolling(nodeId)
        return
      }

      try {
        const log = await api.agentLog(this.projectId, nodeId, { since })
        const entries = Array.isArray(log) ? log : (log.entries || [])
        const newest = entries[entries.length - 1]

        if (!newest) return

        since = newest.seq || newest.id || since
        this.onAgentLog?.(nodeId, entry.paneId, entries)
      } catch {
        return
      }
    }, intervalMs)

    this.logPollers.set(nodeId, timer)
  }

  stopAgentLogPolling(nodeId: string): void {
    const timer = this.logPollers.get(nodeId)

    if (!timer) return

    clearInterval(timer)
    this.logPollers.delete(nodeId)
  }

  stopAllLogPolling(): void {
    for (const timer of this.logPollers.values()) clearInterval(timer)
    this.logPollers.clear()
  }

  handleWorkerComplete(paneId: string, response: string): { nodeId: string; response: string } | null {
    const entry = this.paneToNode.get(paneId)

    if (!entry || entry.nodeType !== 'agent') return null

    return { nodeId: entry.nodeId, response }
  }

  agentNodeIds(): string[] {
    return [...this.nodeToPane]
      .filter(([, entry]) => entry.type === 'worker')
      .map(([nodeId]) => nodeId)
  }

  handleNodeState(payload: NodeStatePayload): void {
    const nodeId = payload.node_id || payload.nodeId

    if (!nodeId) return

    const entry = this.nodeToPane.get(nodeId)

    if (!entry) return

    if (payload.status && entry.type === 'worker') {
      this.onAgentStatusChange?.(nodeId, entry.paneId, payload.status)
    }

    if (payload.position) {
      const pos = defaultCanvasPosition(payload.position)

      this.host.canvas.move([{ paneId: entry.paneId, x: pos.x, y: pos.y }]).catch(() => {})
    }
  }

  async handleBoardChanged(payload: BoardChangedPayload): Promise<void> {
    const changes = payload.changes || payload

    if (!changes) return

    for (const node of changes.added ?? []) {
      this.nodesById[node.id] = node

      await this.spawnPaneForNode(node, defaultCanvasPosition(node.position)).catch(() => {})
    }

    for (const nodeId of changes.removed ?? []) {
      const entry = this.nodeToPane.get(nodeId)

      if (!entry) continue

      this.host.canvas.kill(entry.paneId).catch(() => {})
      this.nodeToPane.delete(nodeId)
      this.paneToNode.delete(entry.paneId)
      delete this.nodesById[nodeId]
    }

    if (changes.wires) {
      this.wires = changes.wires
    }

    this.persistState()
  }

  async handleLagged(api: WheelApi): Promise<void> {
    if (!this.projectId) return

    await this.reconcileBoard(await api.getBoard(this.projectId))
  }

  async reconcileBoard(board: WheelBoard): Promise<void> {
    const nodes = board.nodes || []
    const currentNodeIds = new Set(nodes.map(n => n.id))

    for (const [nodeId, entry] of this.nodeToPane) {
      if (currentNodeIds.has(nodeId)) continue

      this.host.canvas.kill(entry.paneId).catch(() => {})
      this.nodeToPane.delete(nodeId)
      this.paneToNode.delete(entry.paneId)
    }

    for (const node of nodes) {
      this.nodesById[node.id] = node

      if (!this.nodeToPane.has(node.id)) {
        await this.spawnPaneForNode(node, defaultCanvasPosition(node.position)).catch(() => {})
      }
    }

    this.wires = board.wires || []
    this.persistState()
  }

  handlePaneMoved(paneId: string, x: number, y: number): { nodeId: string; position: GridPosition } | null {
    const entry = this.paneToNode.get(paneId)

    if (!entry) return null

    return {
      nodeId: entry.nodeId,
      position: canvasToWheel({ x, y }, GRID_SCALE, GRID_OFFSET, GRID_OFFSET),
    }
  }

  handlePaneClose(paneId: string): PaneNodeLink | null {
    if (paneId === this.topologyPaneId) {
      this.topologyPaneId = null
      return null
    }

    const entry = this.paneToNode.get(paneId)

    if (!entry) return null

    this.paneToNode.delete(paneId)
    this.nodeToPane.delete(entry.nodeId)

    return entry
  }

  handlePeerCount(count: number): void {
    this.peerCount = count
    this.onPeerCountChange?.(count)
  }

  async createNode(api: WheelApi, name: string, type: NodeType, position?: CanvasPosition): Promise<WheelNode> {
    if (!this.projectId) throw new Error('No project open')

    const wheelPos = position ? canvasToWheel(position, GRID_SCALE, GRID_OFFSET, GRID_OFFSET) : { x: 0, y: 0 }

    return api.createNode(this.projectId, { name, type, position: wheelPos, config: defaultNodeConfig(type) })
  }

  paneIdForNode(nodeId: string): string | null {
    return this.nodeToPane.get(nodeId)?.paneId || null
  }

  nodeIdForPane(paneId: string): string | null {
    return this.paneToNode.get(paneId)?.nodeId || null
  }

  nodeForPane(paneId: string): NodeWithWires | null {
    const entry = this.paneToNode.get(paneId)
    const node = entry ? this.nodesById[entry.nodeId] : undefined

    if (!node) return null

    return { ...node, wires: summarizeWires(node.id, this.wires, this.nodesById) }
  }

  persistState(): void {
    const state: PersistedSync = {
      projectId: this.projectId,
      nodeToPane: [...this.nodeToPane],
      paneToNode: [...this.paneToNode],
      topologyPaneId: this.topologyPaneId,
    }

    try {
      this.host.state.persist(state)
    } catch {
      return
    }
  }

  async restoreState(): Promise<boolean> {
    try {
      const state = await this.host.state.load<PersistedSync>()

      if (!state) return false

      this.projectId = state.projectId || null
      this.topologyPaneId = state.topologyPaneId || null

      if (state.nodeToPane) this.nodeToPane = new Map(state.nodeToPane)
      if (state.paneToNode) this.paneToNode = new Map(state.paneToNode)

      return this.projectId !== null
    } catch {
      return false
    }
  }

  get mappedNodeCount(): number {
    return this.nodeToPane.size
  }

  get activeProjectId(): string | null {
    return this.projectId
  }

  private spawnPaneForNode(node: WheelNode, position: CanvasPosition): Promise<{ paneId: string }> {
    return node.type === 'agent' ? this.spawnWorkerForNode(node, position) : this.spawnNoteForNode(node, position)
  }

  private linkPane(node: WheelNode, paneId: string | undefined, type: NodePaneLink['type']): void {
    if (!paneId) return

    this.nodeToPane.set(node.id, { paneId, type })
    this.paneToNode.set(paneId, { nodeId: node.id, nodeType: node.type })
  }
}

export function canvasToWheel(canvasPos: CanvasPosition, scale: number, offsetX: number, offsetY: number): GridPosition {
  return {
    x: Math.round((canvasPos.x - offsetX) / scale),
    y: Math.round((canvasPos.y - offsetY) / scale),
  }
}

export function defaultNodeConfig(type: NodeType): NodeConfig {
  switch (type) {
    case 'agent':
      return { harness: 'claude', system_prompt: '', run_on_startup: false, ephemeral_context: false }
    case 'ctx':
      return { markdown: '' }
    case 'table':
      return { columns: [{ name: 'value', type: 'text' }] }
    case 'endpoint':
      return { method: 'POST', path: '/hook', response_mode: 'ack' }
    case 'script':
      return { language: 'python', source: "print('hello from wheel')\n", timeout_secs: 60 }
    case 'mcp':
      return { transport: 'stdio', command: '' }
    case 'vault':
      return { keys: [] }
    case 'chest':
      return {}
    case 'tool':
      return { kind: 'http', base_url: '', operations: [], source: { format: 'manual', imported_at: new Date().toISOString(), raw: '' } }
  }
}

function connectionsFor(connectionsByName: Map<string, TopologyConnections>, name: string): TopologyConnections {
  const connections = connectionsByName.get(name) ?? { out: [], in: [] }

  connectionsByName.set(name, connections)

  return connections
}

function defaultCanvasPosition(position: GridPosition | undefined): CanvasPosition {
  return wheelToCanvas(position || { x: 0, y: 0 }, GRID_SCALE, GRID_OFFSET, GRID_OFFSET)
}
