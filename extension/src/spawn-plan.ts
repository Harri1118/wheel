import type { GridPosition, NodeType, WheelBoard, WheelNode, WheelWire, WireKind } from './types'

export type CanvasPosition = { x: number; y: number }
export type NodesById = Record<string, WheelNode>

export type WorkerSpec = {
  wheelNodeId: string
  wheelName: string
  role: 'builder'
  prompt: string
  position: CanvasPosition
  harness: string
}

export type NoteSpec = {
  wheelNodeId: string
  wheelName: string
  wheelType: NodeType
  title: string
  body: string
  position: CanvasPosition
}

export type NodeMapEntry = { type: 'worker'; name: string } | { type: 'note'; name: string; nodeType: NodeType }
export type WireDescription = { from: string; to: string; type: WireKind; fromId: string; toId: string }

export type SpawnPlan = {
  projectId: string
  workers: WorkerSpec[]
  notes: NoteSpec[]
  wires: WireDescription[]
  nodeMap: Record<string, NodeMapEntry>
  agentCount: number
  noteCount: number
  wireCount: number
}

export function wheelToCanvas(pos: GridPosition, scale: number, offsetX: number, offsetY: number): CanvasPosition {
  return {
    x: Math.round(pos.x * scale + offsetX),
    y: Math.round(pos.y * scale + offsetY),
  }
}

export function buildSpawnPlan(board: WheelBoard, projectId: string, scale: number, offsetX: number, offsetY: number): SpawnPlan {
  const nodes = board.nodes || []
  const wires = board.wires || []
  const nodesById = indexNodes(nodes)
  const workers: WorkerSpec[] = []
  const notes: NoteSpec[] = []
  const nodeMap: Record<string, NodeMapEntry> = {}

  for (const node of nodes) {
    const canvasPos = wheelToCanvas(node.position || { x: 0, y: 0 }, scale, offsetX, offsetY)

    if (node.type === 'agent') {
      const relevantWires = wires.filter(w => w.from === node.id || w.to === node.id)

      workers.push({
        wheelNodeId: node.id,
        wheelName: node.name,
        role: 'builder',
        prompt: buildAgentPrompt(node, relevantWires, nodesById, projectId),
        position: canvasPos,
        harness: node.config?.harness || 'claude',
      })
      nodeMap[node.id] = { type: 'worker', name: node.name }
    } else {
      notes.push({
        wheelNodeId: node.id,
        wheelName: node.name,
        wheelType: node.type,
        title: `${node.name} (${node.type})`,
        body: buildNoteBody(node),
        position: canvasPos,
      })
      nodeMap[node.id] = { type: 'note', name: node.name, nodeType: node.type }
    }
  }

  const wireDescriptions = wires.map(w => ({
    from: nodesById[w.from]?.name || w.from,
    to: nodesById[w.to]?.name || w.to,
    type: w.type,
    fromId: w.from,
    toId: w.to,
  }))

  return {
    projectId,
    workers,
    notes,
    wires: wireDescriptions,
    nodeMap,
    agentCount: workers.length,
    noteCount: notes.length,
    wireCount: wires.length,
  }
}

export function buildAgentPrompt(node: WheelNode, wires: WheelWire[], nodesById: NodesById, projectId: string): string {
  const cfg = node.config || {}
  const parts: string[] = []

  parts.push(`You are "${node.name}", a Wheel agent running on the "${projectId}" project.`)

  if (cfg.system_prompt) {
    parts.push('')
    parts.push('## System Prompt (from Wheel config)')
    parts.push(cfg.system_prompt)
  }

  const wireLines = describeWires(node, wires, nodesById)

  if (wireLines.length > 0) {
    parts.push('')
    parts.push('## Wires')
    parts.push('Your connections on the Wheel board:')
    parts.push(...wireLines)
  }

  const readableNodes = peersOf(wires, nodesById, w => w.type === 'read' && w.from === node.id, 'to')
  const writableNodes = peersOf(wires, nodesById, w => w.type === 'write' && w.from === node.id, 'to')
  const sendTargets = peersOf(wires, nodesById, w => w.type === 'send' && w.from === node.id, 'to')
  const receiveFrom = peersOf(wires, nodesById, w => w.type === 'send' && w.to === node.id, 'from')
  const hasToolAccess = readableNodes.length > 0 || writableNodes.length > 0 || sendTargets.length > 0 || receiveFrom.length > 0

  if (!hasToolAccess) return parts.join('\n')

  parts.push('')
  parts.push('## Available Wheel Tools')
  parts.push(`Project ID: ${projectId}`)
  parts.push(`Your node ID: ${node.id}`)

  for (const n of readableNodes) {
    if (n.type === 'table') {
      parts.push(`- wheel_query_table / wheel_table_rows with nodeId="${n.id}" to read from table "${n.name}"`)
    } else if (n.type === 'ctx') {
      parts.push(`- Context node "${n.name}" (${n.id}) is readable via the board`)
    } else if (n.type === 'chest') {
      parts.push(`- wheel_chest_ls with nodeId="${n.id}" to browse chest "${n.name}"`)
    }
  }

  for (const n of writableNodes) {
    if (n.type === 'table') {
      parts.push(`- wheel_query_table with nodeId="${n.id}" to write to table "${n.name}"`)
    } else if (n.type === 'vault') {
      parts.push(`- wheel_put_secret with nodeId="${n.id}" to write secrets to vault "${n.name}"`)
    }
  }

  for (const n of sendTargets) {
    parts.push(`- wheel_send_to_agent with nodeId="${n.id}" to send messages to agent "${n.name}"`)
  }

  if (receiveFrom.length > 0) {
    const names = receiveFrom.map(n => `"${n.name}"`).join(', ')

    parts.push(`- You can receive messages from: ${names}. Messages arrive via wheel_poll_messages.`)
  }

  return parts.join('\n')
}

export function buildNoteBody(node: WheelNode): string {
  const lines = [`**Type:** ${node.type}`, `**ID:** ${node.id}`]
  const cfg = node.config || {}

  switch (node.type) {
    case 'ctx':
      if (cfg.markdown) lines.push('', '---', '', cfg.markdown)
      break
    case 'table':
      if (cfg.columns) lines.push('', `**Columns:** ${cfg.columns.map(c => c.name).join(', ')}`)
      break
    case 'endpoint':
      lines.push(`**Method:** ${cfg.method || 'POST'}`, `**Path:** ${cfg.path || '/hook'}`)
      break
    case 'script':
      lines.push(`**Language:** ${cfg.language || 'python'}`)
      if (typeof cfg.source === 'string' && cfg.source) lines.push('', '```', cfg.source.slice(0, 500), '```')
      break
    case 'mcp':
      lines.push(`**Transport:** ${cfg.transport || 'stdio'}`)
      if (cfg.command) lines.push(`**Command:** ${cfg.command}`)
      break
    case 'vault':
      if (cfg.keys?.length) lines.push(`**Keys:** ${cfg.keys.join(', ')}`)
      break
    case 'chest':
      lines.push('Blob storage node')
      break
    case 'tool':
      if (cfg.base_url) lines.push(`**Base URL:** ${cfg.base_url}`)
      if (cfg.operations?.length) lines.push(`**Operations:** ${cfg.operations.map(o => o.id || o.name).join(', ')}`)
      break
  }

  return lines.join('\n')
}

export function describeWires(node: WheelNode, wires: WheelWire[], nodesById: NodesById): string[] {
  const lines: string[] = []

  for (const w of wires) {
    const isFrom = w.from === node.id
    const peer = nodesById[isFrom ? w.to : w.from]

    if (!peer) continue

    const dir = isFrom ? 'outgoing' : 'incoming'

    lines.push(`  - ${dir} ${w.type} wire ${isFrom ? 'to' : 'from'} "${peer.name}" (${peer.type})`)
  }

  return lines
}

export function indexNodes(nodes: WheelNode[]): NodesById {
  const nodesById: NodesById = {}

  for (const n of nodes) nodesById[n.id] = n

  return nodesById
}

function peersOf(wires: WheelWire[], nodesById: NodesById, matches: (wire: WheelWire) => boolean, peerEnd: 'from' | 'to'): WheelNode[] {
  return wires
    .filter(matches)
    .map(w => nodesById[w[peerEnd]])
    .filter((peer): peer is WheelNode => Boolean(peer))
}
