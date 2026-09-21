// Spawn plan builder — pure functions, no DOM or panel dependencies.
// Given a Wheel board, produces a structured plan that the calling
// AgentGrid agent uses to spawn workers and note panes.

function wheelToCanvas(pos, scale, offsetX, offsetY) {
  return {
    x: Math.round(pos.x * scale + offsetX),
    y: Math.round(pos.y * scale + offsetY),
  }
}

function describeWires(node, wires, nodesById) {
  const lines = []
  for (const w of wires) {
    const isFrom = w.from === node.id
    const peerId = isFrom ? w.to : w.from
    const peer = nodesById[peerId]
    if (!peer) continue
    const dir = isFrom ? 'outgoing' : 'incoming'
    lines.push(`  - ${dir} ${w.type} wire ${isFrom ? 'to' : 'from'} "${peer.name}" (${peer.type})`)
  }
  return lines
}

function buildAgentPrompt(node, wires, nodesById, projectId) {
  const cfg = node.config || {}
  const parts = []

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

  const readableNodes = wires
    .filter(w => w.type === 'read' && w.from === node.id)
    .map(w => nodesById[w.to])
    .filter(Boolean)

  const writableNodes = wires
    .filter(w => w.type === 'write' && w.from === node.id)
    .map(w => nodesById[w.to])
    .filter(Boolean)

  const sendTargets = wires
    .filter(w => w.type === 'send' && w.from === node.id)
    .map(w => nodesById[w.to])
    .filter(Boolean)

  const receiveFrom = wires
    .filter(w => w.type === 'send' && w.to === node.id)
    .map(w => nodesById[w.from])
    .filter(Boolean)

  if (readableNodes.length > 0 || writableNodes.length > 0 || sendTargets.length > 0 || receiveFrom.length > 0) {
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
  }

  return parts.join('\n')
}

function buildNoteBody(node) {
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
      if (cfg.source) lines.push('', '```', cfg.source.slice(0, 500), '```')
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

function buildSpawnPlan(board, projectId, scale, offsetX, offsetY) {
  const nodes = board.nodes || []
  const wires = board.wires || []
  const nodesById = {}
  for (const n of nodes) nodesById[n.id] = n

  const workers = []
  const notes = []
  const nodeMap = {}

  for (const node of nodes) {
    const canvasPos = wheelToCanvas(node.position || { x: 0, y: 0 }, scale, offsetX, offsetY)

    if (node.type === 'agent') {
      const relevantWires = wires.filter(w => w.from === node.id || w.to === node.id)
      const systemPrompt = buildAgentPrompt(node, relevantWires, nodesById, projectId)
      const cfg = node.config || {}

      workers.push({
        wheelNodeId: node.id,
        wheelName: node.name,
        role: 'builder',
        prompt: systemPrompt,
        position: canvasPos,
        harness: cfg.harness || 'claude',
      })
      nodeMap[node.id] = { type: 'worker', name: node.name }
    } else {
      const body = buildNoteBody(node)
      notes.push({
        wheelNodeId: node.id,
        wheelName: node.name,
        wheelType: node.type,
        title: `${node.name} (${node.type})`,
        body,
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { wheelToCanvas, buildAgentPrompt, buildNoteBody, buildSpawnPlan, describeWires }
}
