// Board sync bridge — translates between Wheel board state and AgentGrid
// canvas panes. Maintains a bidirectional node↔pane map and handles both
// initial board spawn and live event relay.

// eslint-disable-next-line no-unused-vars
class BoardSync {
  constructor(sendRequest) {
    this.sendRequest = sendRequest
    this.nodeToPane = new Map()
    this.paneToNode = new Map()
    this.projectId = null
    this.nodesById = {}
    this.wires = []
    this.topologyPaneId = null
    this.peerCount = 0
    this.onPeerCountChange = null
  }

  async openProject(api, projectId, scale = 120, offsetX = 100, offsetY = 100) {
    this.projectId = projectId
    const board = await api.getBoard(projectId)

    return this.spawnBoard(board, scale, offsetX, offsetY)
  }

  async spawnBoard(board, scale, offsetX, offsetY) {
    const nodes = board.nodes || []
    this.wires = board.wires || []
    this.nodesById = {}
    for (const n of nodes) this.nodesById[n.id] = n

    const results = { spawned: 0, failed: 0, errors: [] }

    for (const node of nodes) {
      const pos = wheelToCanvas(node.position || { x: 0, y: 0 }, scale, offsetX, offsetY)

      try {
        if (node.type === 'agent') {
          await this.spawnWorkerForNode(node, pos)
        } else {
          await this.spawnNoteForNode(node, pos)
        }
        results.spawned++
      } catch (err) {
        results.failed++
        results.errors.push({ nodeId: node.id, name: node.name, error: err.message })
      }
    }

    await this.spawnTopologyNote()
    await this.persistState()

    return results
  }

  async spawnWorkerForNode(node, position) {
    const relevantWires = this.wires.filter(w => w.from === node.id || w.to === node.id)
    const prompt = buildAgentPrompt(node, relevantWires, this.nodesById, this.projectId)
    const cfg = node.config || {}

    const result = await this.sendRequest('canvas.spawnWorker', {
      role: 'builder',
      prompt,
      harness: cfg.harness || 'claude',
      position,
    })

    if (result?.paneId) {
      this.nodeToPane.set(node.id, { paneId: result.paneId, type: 'worker' })
      this.paneToNode.set(result.paneId, { nodeId: node.id, nodeType: node.type })
    }

    return result
  }

  async spawnNoteForNode(node, position) {
    const body = buildNoteBody(node)

    const result = await this.sendRequest('canvas.spawnNote', {
      title: `${node.name} (${node.type})`,
      body,
      position,
    })

    if (result?.paneId) {
      this.nodeToPane.set(node.id, { paneId: result.paneId, type: 'note' })
      this.paneToNode.set(result.paneId, { nodeId: node.id, nodeType: node.type })
    }

    return result
  }

  // -- Phase 4.1: wire topology note --

  async spawnTopologyNote() {
    if (this.wires.length === 0) return

    const body = this.buildTopologyBody()

    try {
      const result = await this.sendRequest('canvas.spawnNote', {
        title: 'Wheel Topology',
        body,
        color: 'blue',
      })
      this.topologyPaneId = result?.paneId || null
    } catch {
      // topology note is non-essential
    }
  }

  buildTopologyBody() {
    const lines = [`**Project:** ${this.projectId}`, '']

    const byNode = new Map()

    for (const w of this.wires) {
      const fromNode = this.nodesById[w.from]
      const toNode = this.nodesById[w.to]
      if (!fromNode || !toNode) continue

      const fromKey = fromNode.name
      const toKey = toNode.name

      if (!byNode.has(fromKey)) byNode.set(fromKey, { out: [], in: [] })
      if (!byNode.has(toKey)) byNode.set(toKey, { out: [], in: [] })

      byNode.get(fromKey).out.push({ type: w.type, target: toKey, targetType: toNode.type })
      byNode.get(toKey).in.push({ type: w.type, source: fromKey, sourceType: fromNode.type })
    }

    for (const [name, connections] of byNode) {
      lines.push(`### ${name}`)

      for (const c of connections.out) {
        lines.push(`  → ${c.type} → **${c.target}** (${c.targetType})`)
      }
      for (const c of connections.in) {
        lines.push(`  ← ${c.type} ← **${c.source}** (${c.sourceType})`)
      }

      lines.push('')
    }

    return lines.join('\n')
  }

  // -- Phase 2.4: agent transcript relay --

  startAgentLogPolling(api, nodeId, intervalMs = 5000) {
    const entry = this.nodeToPane.get(nodeId)
    if (!entry || entry.type !== 'worker') return

    if (this._logPollers?.has(nodeId)) return
    if (!this._logPollers) this._logPollers = new Map()

    let since = 0
    const timer = setInterval(async () => {
      if (!this.projectId) { this.stopAgentLogPolling(nodeId); return }

      try {
        const log = await api.agentLog(this.projectId, nodeId, { since })
        const entries = Array.isArray(log) ? log : (log.entries || [])
        if (entries.length === 0) return

        since = entries[entries.length - 1].seq || entries[entries.length - 1].id || since
        this.onAgentLog?.(nodeId, entry.paneId, entries)
      } catch {
        // poll failure is non-fatal
      }
    }, intervalMs)

    this._logPollers.set(nodeId, timer)
  }

  stopAgentLogPolling(nodeId) {
    const timer = this._logPollers?.get(nodeId)
    if (timer) { clearInterval(timer); this._logPollers.delete(nodeId) }
  }

  stopAllLogPolling() {
    if (!this._logPollers) return
    for (const timer of this._logPollers.values()) clearInterval(timer)
    this._logPollers.clear()
  }

  // -- Phase 3.3: worker actions → Wheel agent actions --

  handleWorkerComplete(paneId, response) {
    const entry = this.paneToNode.get(paneId)
    if (!entry || entry.nodeType !== 'agent') return null

    return { nodeId: entry.nodeId, response }
  }

  agentNodeIds() {
    const ids = []
    for (const [nodeId, entry] of this.nodeToPane) {
      if (entry.type === 'worker') ids.push(nodeId)
    }
    return ids
  }

  // -- event handlers --

  handleNodeState(payload) {
    const nodeId = payload.node_id || payload.nodeId
    if (!nodeId) return

    const entry = this.nodeToPane.get(nodeId)
    if (!entry) return

    if (payload.status && entry.type === 'worker') {
      this.onAgentStatusChange?.(nodeId, entry.paneId, payload.status)
    }

    if (payload.position) {
      const pos = wheelToCanvas(payload.position, 120, 100, 100)
      this.sendRequest('canvas.movePanes', { moves: [{ paneId: entry.paneId, x: pos.x, y: pos.y }] })
        .catch(() => {})
    }
  }

  async handleBoardChanged(payload) {
    const changes = payload.changes || payload
    if (!changes) return

    if (changes.added) {
      for (const node of changes.added) {
        this.nodesById[node.id] = node
        const pos = wheelToCanvas(node.position || { x: 0, y: 0 }, 120, 100, 100)

        try {
          if (node.type === 'agent') {
            await this.spawnWorkerForNode(node, pos)
          } else {
            await this.spawnNoteForNode(node, pos)
          }
        } catch {
          // peer-added node failed to spawn — not fatal
        }
      }
    }

    if (changes.removed) {
      for (const nodeId of changes.removed) {
        const entry = this.nodeToPane.get(nodeId)
        if (!entry) continue

        this.sendRequest('canvas.killPane', { paneId: entry.paneId }).catch(() => {})
        this.nodeToPane.delete(nodeId)
        this.paneToNode.delete(entry.paneId)
        delete this.nodesById[nodeId]
      }
    }

    if (changes.wires) {
      this.wires = changes.wires
    }

    await this.persistState()
  }

  async handleLagged(api) {
    if (!this.projectId) return

    const board = await api.getBoard(this.projectId)
    await this.reconcileBoard(board)
  }

  async reconcileBoard(board) {
    const currentNodeIds = new Set((board.nodes || []).map(n => n.id))

    for (const [nodeId, entry] of this.nodeToPane) {
      if (!currentNodeIds.has(nodeId)) {
        this.sendRequest('canvas.killPane', { paneId: entry.paneId }).catch(() => {})
        this.nodeToPane.delete(nodeId)
        this.paneToNode.delete(entry.paneId)
      }
    }

    for (const node of (board.nodes || [])) {
      this.nodesById[node.id] = node

      if (!this.nodeToPane.has(node.id)) {
        const pos = wheelToCanvas(node.position || { x: 0, y: 0 }, 120, 100, 100)

        try {
          if (node.type === 'agent') {
            await this.spawnWorkerForNode(node, pos)
          } else {
            await this.spawnNoteForNode(node, pos)
          }
        } catch {
          // reconciliation spawn failed — not fatal
        }
      }
    }

    this.wires = board.wires || []
    await this.persistState()
  }

  // -- Phase 3: canvas → Wheel relay --

  handlePaneMoved(paneId, x, y) {
    const entry = this.paneToNode.get(paneId)
    if (!entry) return null

    return {
      nodeId: entry.nodeId,
      position: canvasToWheel({ x, y }, 120, 100, 100),
    }
  }

  handlePaneClose(paneId) {
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

  // -- Phase 5.1: peer tracking --

  handlePeerCount(count) {
    this.peerCount = count
    this.onPeerCountChange?.(count)
  }

  // -- node creation (Phase 3.4) --

  async createNode(api, name, type, position) {
    if (!this.projectId) throw new Error('No project open')

    const nodeConfig = {
      agent: { harness: 'claude', system_prompt: '', run_on_startup: false, ephemeral_context: false },
      ctx: { markdown: '' },
      table: { columns: [{ name: 'value', type: 'text' }] },
      endpoint: { method: 'POST', path: '/hook', response_mode: 'ack' },
      script: { language: 'python', source: "print('hello from wheel')\n", timeout_secs: 60 },
      mcp: { transport: 'stdio', command: '' },
      vault: { keys: [] },
      chest: {},
      tool: { kind: 'http', base_url: '', operations: [], source: { format: 'manual', imported_at: new Date().toISOString(), raw: '' } },
    }

    const config = nodeConfig[type] || {}
    const wheelPos = position
      ? canvasToWheel(position, 120, 100, 100)
      : { x: 0, y: 0 }

    return api.createNode(this.projectId, {
      name,
      type,
      position: wheelPos,
      config,
    })
  }

  // -- lookups --

  paneIdForNode(nodeId) {
    return this.nodeToPane.get(nodeId)?.paneId || null
  }

  nodeIdForPane(paneId) {
    return this.paneToNode.get(paneId)?.nodeId || null
  }

  nodeForPane(paneId) {
    const entry = this.paneToNode.get(paneId)
    if (!entry) return null

    const node = this.nodesById[entry.nodeId]
    if (!node) return null

    const nodeWires = this.wires.filter(w => w.from === node.id || w.to === node.id)

    return {
      ...node,
      wires: nodeWires.map(w => ({
        type: w.type,
        direction: w.from === node.id ? 'outgoing' : 'incoming',
        peerName: (this.nodesById[w.from === node.id ? w.to : w.from] || {}).name || 'unknown',
        peerType: (this.nodesById[w.from === node.id ? w.to : w.from] || {}).type || 'unknown',
      })),
    }
  }

  // -- persistence --

  async persistState() {
    const state = {
      projectId: this.projectId,
      nodeToPane: [...this.nodeToPane],
      paneToNode: [...this.paneToNode],
      topologyPaneId: this.topologyPaneId,
    }

    this.sendRequest('pane.persistState', { data: state }).catch(() => {})
  }

  async restoreState() {
    try {
      const state = await this.sendRequest('pane.loadState')
      if (!state?.data) return false

      this.projectId = state.data.projectId || null
      this.topologyPaneId = state.data.topologyPaneId || null

      if (state.data.nodeToPane) {
        this.nodeToPane = new Map(state.data.nodeToPane)
      }
      if (state.data.paneToNode) {
        this.paneToNode = new Map(state.data.paneToNode)
      }

      return this.projectId !== null
    } catch {
      return false
    }
  }

  get mappedNodeCount() {
    return this.nodeToPane.size
  }

  get activeProjectId() {
    return this.projectId
  }
}

function canvasToWheel(canvasPos, scale, offsetX, offsetY) {
  return {
    x: Math.round((canvasPos.x - offsetX) / scale),
    y: Math.round((canvasPos.y - offsetY) / scale),
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BoardSync, canvasToWheel }
}
