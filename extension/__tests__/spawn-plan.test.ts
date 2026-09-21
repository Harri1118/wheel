import { describe, expect, it } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wheelToCanvas, buildAgentPrompt, buildNoteBody, buildSpawnPlan } = require('../panel/spawn-plan.js')

describe('wheelToCanvas', () => {
  it('scales and offsets position', () => {
    expect(wheelToCanvas({ x: 2, y: 3 }, 120, 100, 100)).toEqual({ x: 340, y: 460 })
  })

  it('uses default-like params', () => {
    expect(wheelToCanvas({ x: 0, y: 0 }, 120, 100, 100)).toEqual({ x: 100, y: 100 })
  })

  it('rounds to integers', () => {
    expect(wheelToCanvas({ x: 1, y: 1 }, 75, 10, 10)).toEqual({ x: 85, y: 85 })
  })
})

describe('buildAgentPrompt', () => {
  const baseNode = { id: 'a1', name: 'researcher', type: 'agent', config: {} }
  const projectId = 'proj-1'

  it('includes the agent name and project id', () => {
    const prompt = buildAgentPrompt(baseNode, [], {}, projectId)
    expect(prompt).toContain('"researcher"')
    expect(prompt).toContain('"proj-1"')
  })

  it('includes the system prompt from config', () => {
    const node = { ...baseNode, config: { system_prompt: 'You are a helpful researcher.' } }
    const prompt = buildAgentPrompt(node, [], {}, projectId)
    expect(prompt).toContain('You are a helpful researcher.')
    expect(prompt).toContain('## System Prompt')
  })

  it('omits system prompt section when empty', () => {
    const prompt = buildAgentPrompt(baseNode, [], {}, projectId)
    expect(prompt).not.toContain('## System Prompt')
  })

  it('describes wires to connected nodes', () => {
    const table = { id: 't1', name: 'memory', type: 'table' }
    const wires = [{ from: 'a1', to: 't1', type: 'read' }]
    const nodesById = { a1: baseNode, t1: table }
    const prompt = buildAgentPrompt(baseNode, wires, nodesById, projectId)
    expect(prompt).toContain('## Wires')
    expect(prompt).toContain('outgoing read wire to "memory" (table)')
  })

  it('lists available tools for readable tables', () => {
    const table = { id: 't1', name: 'logs', type: 'table' }
    const wires = [{ from: 'a1', to: 't1', type: 'read' }]
    const nodesById = { a1: baseNode, t1: table }
    const prompt = buildAgentPrompt(baseNode, wires, nodesById, projectId)
    expect(prompt).toContain('wheel_query_table')
    expect(prompt).toContain('nodeId="t1"')
  })

  it('lists send targets', () => {
    const other = { id: 'a2', name: 'writer', type: 'agent' }
    const wires = [{ from: 'a1', to: 'a2', type: 'send' }]
    const nodesById = { a1: baseNode, a2: other }
    const prompt = buildAgentPrompt(baseNode, wires, nodesById, projectId)
    expect(prompt).toContain('wheel_send_to_agent')
    expect(prompt).toContain('"writer"')
  })

  it('lists receive sources', () => {
    const other = { id: 'a2', name: 'dispatcher', type: 'agent' }
    const wires = [{ from: 'a2', to: 'a1', type: 'send' }]
    const nodesById = { a1: baseNode, a2: other }
    const prompt = buildAgentPrompt(baseNode, wires, nodesById, projectId)
    expect(prompt).toContain('receive messages from')
    expect(prompt).toContain('"dispatcher"')
  })

  it('lists writable vault', () => {
    const vault = { id: 'v1', name: 'secrets', type: 'vault' }
    const wires = [{ from: 'a1', to: 'v1', type: 'write' }]
    const nodesById = { a1: baseNode, v1: vault }
    const prompt = buildAgentPrompt(baseNode, wires, nodesById, projectId)
    expect(prompt).toContain('wheel_put_secret')
    expect(prompt).toContain('"secrets"')
  })

  it('lists readable chest', () => {
    const chest = { id: 'c1', name: 'uploads', type: 'chest' }
    const wires = [{ from: 'a1', to: 'c1', type: 'read' }]
    const nodesById = { a1: baseNode, c1: chest }
    const prompt = buildAgentPrompt(baseNode, wires, nodesById, projectId)
    expect(prompt).toContain('wheel_chest_ls')
  })
})

describe('buildNoteBody', () => {
  it('includes type and id for all nodes', () => {
    const body = buildNoteBody({ id: 'n1', name: 'foo', type: 'ctx', config: {} })
    expect(body).toContain('**Type:** ctx')
    expect(body).toContain('**ID:** n1')
  })

  it('includes markdown for ctx nodes', () => {
    const body = buildNoteBody({ id: 'n1', name: 'notes', type: 'ctx', config: { markdown: '# Hello' } })
    expect(body).toContain('# Hello')
  })

  it('includes columns for table nodes', () => {
    const body = buildNoteBody({
      id: 'n1', name: 'data', type: 'table',
      config: { columns: [{ name: 'id', type: 'int' }, { name: 'value', type: 'text' }] },
    })
    expect(body).toContain('id, value')
  })

  it('includes method and path for endpoint nodes', () => {
    const body = buildNoteBody({
      id: 'n1', name: 'hook', type: 'endpoint',
      config: { method: 'GET', path: '/status' },
    })
    expect(body).toContain('**Method:** GET')
    expect(body).toContain('**Path:** /status')
  })

  it('includes language for script nodes', () => {
    const body = buildNoteBody({
      id: 'n1', name: 'runner', type: 'script',
      config: { language: 'python', source: 'print(1)' },
    })
    expect(body).toContain('**Language:** python')
    expect(body).toContain('print(1)')
  })

  it('includes transport for mcp nodes', () => {
    const body = buildNoteBody({
      id: 'n1', name: 'srv', type: 'mcp',
      config: { transport: 'sse', command: 'node server.js' },
    })
    expect(body).toContain('**Transport:** sse')
    expect(body).toContain('**Command:** node server.js')
  })

  it('includes keys for vault nodes', () => {
    const body = buildNoteBody({
      id: 'n1', name: 'secrets', type: 'vault',
      config: { keys: ['API_KEY', 'DB_URL'] },
    })
    expect(body).toContain('API_KEY, DB_URL')
  })
})

describe('buildSpawnPlan', () => {
  const twoAgentBoard = {
    nodes: [
      { id: 'a1', name: 'researcher', type: 'agent', position: { x: 0, y: 0 }, config: { system_prompt: 'Research things' } },
      { id: 'a2', name: 'writer', type: 'agent', position: { x: 3, y: 0 }, config: { harness: 'codex' } },
      { id: 't1', name: 'memory', type: 'table', position: { x: 1, y: 2 }, config: { columns: [{ name: 'fact', type: 'text' }] } },
      { id: 'c1', name: 'docs', type: 'ctx', position: { x: 1, y: -1 }, config: { markdown: 'Background info' } },
    ],
    wires: [
      { from: 'a1', to: 't1', type: 'read' },
      { from: 'a1', to: 't1', type: 'write' },
      { from: 'a1', to: 'a2', type: 'send' },
      { from: 'a1', to: 'c1', type: 'read' },
    ],
  }

  it('separates agents into workers and non-agents into notes', () => {
    const plan = buildSpawnPlan(twoAgentBoard, 'proj-1', 120, 100, 100)
    expect(plan.agentCount).toBe(2)
    expect(plan.noteCount).toBe(2)
    expect(plan.workers.map((w: any) => w.wheelName)).toEqual(['researcher', 'writer'])
    expect(plan.notes.map((n: any) => n.wheelName)).toEqual(['memory', 'docs'])
  })

  it('maps positions correctly', () => {
    const plan = buildSpawnPlan(twoAgentBoard, 'proj-1', 120, 100, 100)
    const researcher = plan.workers[0]
    expect(researcher.position).toEqual({ x: 100, y: 100 })
    const writer = plan.workers[1]
    expect(writer.position).toEqual({ x: 460, y: 100 })
    const memory = plan.notes[0]
    expect(memory.position).toEqual({ x: 220, y: 340 })
  })

  it('uses harness from agent config', () => {
    const plan = buildSpawnPlan(twoAgentBoard, 'proj-1', 120, 100, 100)
    expect(plan.workers[0].harness).toBe('claude')
    expect(plan.workers[1].harness).toBe('codex')
  })

  it('generates system prompts with wire context', () => {
    const plan = buildSpawnPlan(twoAgentBoard, 'proj-1', 120, 100, 100)
    const prompt = plan.workers[0].prompt
    expect(prompt).toContain('Research things')
    expect(prompt).toContain('wheel_query_table')
    expect(prompt).toContain('wheel_send_to_agent')
    expect(prompt).toContain('"writer"')
  })

  it('includes wire descriptions', () => {
    const plan = buildSpawnPlan(twoAgentBoard, 'proj-1', 120, 100, 100)
    expect(plan.wireCount).toBe(4)
    expect(plan.wires[0]).toEqual({
      from: 'researcher', to: 'memory', type: 'read',
      fromId: 'a1', toId: 't1',
    })
  })

  it('builds nodeMap for all nodes', () => {
    const plan = buildSpawnPlan(twoAgentBoard, 'proj-1', 120, 100, 100)
    expect(plan.nodeMap['a1']).toEqual({ type: 'worker', name: 'researcher' })
    expect(plan.nodeMap['t1']).toEqual({ type: 'note', name: 'memory', nodeType: 'table' })
  })

  it('includes note bodies with node details', () => {
    const plan = buildSpawnPlan(twoAgentBoard, 'proj-1', 120, 100, 100)
    const memNote = plan.notes.find((n: any) => n.wheelName === 'memory')
    expect(memNote.body).toContain('**Columns:** fact')
    const ctxNote = plan.notes.find((n: any) => n.wheelName === 'docs')
    expect(ctxNote.body).toContain('Background info')
  })

  it('handles empty board', () => {
    const plan = buildSpawnPlan({ nodes: [], wires: [] }, 'proj-1', 120, 100, 100)
    expect(plan.workers).toEqual([])
    expect(plan.notes).toEqual([])
    expect(plan.wires).toEqual([])
    expect(plan.agentCount).toBe(0)
  })

  it('handles missing position gracefully', () => {
    const board = {
      nodes: [{ id: 'a1', name: 'solo', type: 'agent', config: {} }],
      wires: [],
    }
    const plan = buildSpawnPlan(board, 'proj-1', 120, 100, 100)
    expect(plan.workers[0].position).toEqual({ x: 100, y: 100 })
  })
})
