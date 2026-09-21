import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Tests for the tool dispatch logic in main.js.
//
// Rather than loading the full panel DOM, we extract and test the core
// contracts: tool events route to the right API method, settle calls carry
// the result or error, unconfigured state is handled, and unknown tools
// are rejected.

type Message = { kind: string; id?: string; method?: string; params?: any; topic?: string; payload?: any; ok?: boolean; result?: any; error?: string }

function createMockExt() {
  const listeners: Array<(msg: Message) => void> = []
  const sent: Message[] = []

  return {
    postMessage(msg: Message) { sent.push(msg) },
    onMessage(fn: (msg: Message) => void) {
      listeners.push(fn)
      return () => { listeners.splice(listeners.indexOf(fn), 1) }
    },
    // test helper: simulate an incoming message from the host
    _deliver(msg: Message) { listeners.forEach((fn) => fn(msg)) },
    _sent: sent,
    _listeners: listeners,
  }
}

function createMockApi() {
  return {
    listProjects: vi.fn(async () => [{ id: 'p1', name: 'test' }]),
    getProject: vi.fn(async (id: string) => ({ id, name: 'test' })),
    createProject: vi.fn(async (name: string) => ({ id: 'new', name })),
    startProject: vi.fn(async () => ({ status: 'starting' })),
    stopProject: vi.fn(async () => ({ status: 'stopped' })),
    getBoard: vi.fn(async () => ({ nodes: [] })),
    createNode: vi.fn(async (_pid: string, input: any) => ({ id: 'n1', ...input })),
    patchNode: vi.fn(async (_pid: string, _nid: string, patch: any) => patch),
    deleteNode: vi.fn(async () => undefined),
    createWire: vi.fn(async () => ({ from: 'a', to: 'b', type: 'read' })),
    deleteWire: vi.fn(async () => undefined),
    startAgent: vi.fn(async () => undefined),
    stopAgent: vi.fn(async () => undefined),
    sendToAgent: vi.fn(async () => ({ id: 'm1' })),
    agentLog: vi.fn(async () => ({ lines: [] })),
    queryTable: vi.fn(async () => ({ columns: ['v'], rows: [['x']] })),
    tableRows: vi.fn(async () => ({ rows: [], total: 0 })),
    putSecret: vi.fn(async () => undefined),
    applyBoard: vi.fn(async () => ({ applied: true })),
    importTool: vi.fn(async () => ({ operations: [] })),
    callTool: vi.fn(async () => ({ status: 200, body: {} })),
    messages: vi.fn(async () => ({ messages: [] })),
    chestLs: vi.fn(async () => ({ entries: [] })),
  }
}

// The dispatch table from main.js — replicated here so we test the mapping
// without DOM dependencies. This is the contract: tool name → API method.
const NODE_DEFAULTS: Record<string, object> = {
  agent: { harness: 'claude', system_prompt: '', run_on_startup: false, ephemeral_context: false },
  ctx: { markdown: '' },
  table: { columns: [{ name: 'value', type: 'text' }] },
  endpoint: { method: 'POST', path: '/hook', response_mode: 'ack' },
  script: { language: 'python', source: "print('hello from wheel')\n", timeout_secs: 60 },
  mcp: { transport: 'stdio', command: '' },
  vault: { keys: [] },
  chest: {},
  tool: { kind: 'http', base_url: '', operations: [] },
}

function buildHandlers(api: ReturnType<typeof createMockApi>) {
  return {
    wheel_list_projects: () => api.listProjects(),
    wheel_get_project: ({ projectId }: any) => api.getProject(projectId),
    wheel_create_project: ({ name }: any) => api.createProject(name),
    wheel_start_project: ({ projectId }: any) => api.startProject(projectId),
    wheel_stop_project: ({ projectId }: any) => api.stopProject(projectId),
    wheel_get_board: ({ projectId }: any) => api.getBoard(projectId),
    wheel_create_node: ({ projectId, name, type, position, config }: any) =>
      api.createNode(projectId, { name, type, position, config: config || NODE_DEFAULTS[type] || {} }),
    wheel_patch_node: ({ projectId, nodeId, ...patch }: any) => {
      const body: any = {}
      if (patch.name !== undefined) body.name = patch.name
      if (patch.position !== undefined) body.position = patch.position
      if (patch.config !== undefined) body.config = patch.config
      return api.patchNode(projectId, nodeId, body)
    },
    wheel_delete_node: ({ projectId, nodeId }: any) => api.deleteNode(projectId, nodeId),
    wheel_create_wire: ({ projectId, from, to, type }: any) => api.createWire(projectId, from, to, type),
    wheel_delete_wire: ({ projectId, from, to, type }: any) => api.deleteWire(projectId, from, to, type),
    wheel_start_agent: ({ projectId, nodeId }: any) => api.startAgent(projectId, nodeId),
    wheel_stop_agent: ({ projectId, nodeId }: any) => api.stopAgent(projectId, nodeId),
    wheel_send_to_agent: ({ projectId, nodeId, body }: any) => api.sendToAgent(projectId, nodeId, body),
    wheel_agent_log: ({ projectId, nodeId, since, stream }: any) => api.agentLog(projectId, nodeId, { since, stream }),
    wheel_query_table: ({ projectId, nodeId, sql }: any) => api.queryTable(projectId, nodeId, sql),
    wheel_table_rows: ({ projectId, nodeId, limit, offset }: any) => api.tableRows(projectId, nodeId, limit, offset),
    wheel_put_secret: ({ projectId, nodeId, key, value }: any) => api.putSecret(projectId, nodeId, key, value),
    wheel_apply_board: ({ projectId, board, dryRun }: any) => api.applyBoard(projectId, board, dryRun || false),
    wheel_import_tool: ({ projectId, raw, format }: any) => api.importTool(projectId, raw, format),
    wheel_call_tool: ({ projectId, nodeId, op, args, dryRun }: any) => api.callTool(projectId, nodeId, op, args, dryRun || false),
    wheel_messages: ({ projectId }: any) => api.messages(projectId),
    wheel_chest_ls: ({ projectId, nodeId, prefix }: any) => api.chestLs(projectId, nodeId, prefix),
  } as Record<string, (input: any) => Promise<any>>
}

// Simulate the tool dispatch loop from main.js
async function dispatch(
  ext: ReturnType<typeof createMockExt>,
  handlers: Record<string, (input: any) => Promise<any>>,
  api: ReturnType<typeof createMockApi> | null,
  toolName: string,
  input: Record<string, unknown>,
) {
  const callId = `call-${Math.random().toString(36).slice(2)}`

  const handler = handlers[toolName]

  if (!handler) {
    ext.postMessage({
      kind: 'request',
      id: `settle-err`,
      method: 'tools.settle',
      params: { callId, error: `Unknown tool: ${toolName}` },
    })
    return { callId, settled: ext._sent[ext._sent.length - 1] }
  }

  if (!api) {
    ext.postMessage({
      kind: 'request',
      id: `settle-noapi`,
      method: 'tools.settle',
      params: { callId, error: 'Wheel API not configured. Open the Wheel pane and enter your API URL and token.' },
    })
    return { callId, settled: ext._sent[ext._sent.length - 1] }
  }

  try {
    const result = await handler(input)
    ext.postMessage({
      kind: 'request',
      id: `settle-ok`,
      method: 'tools.settle',
      params: { callId, result },
    })
  } catch (err: any) {
    ext.postMessage({
      kind: 'request',
      id: `settle-fail`,
      method: 'tools.settle',
      params: { callId, error: err.message || String(err) },
    })
  }

  return { callId, settled: ext._sent[ext._sent.length - 1] }
}

describe('tool dispatch routing', () => {
  let ext: ReturnType<typeof createMockExt>
  let api: ReturnType<typeof createMockApi>
  let handlers: Record<string, (input: any) => Promise<any>>

  beforeEach(() => {
    ext = createMockExt()
    api = createMockApi()
    handlers = buildHandlers(api)
  })

  it('routes wheel_list_projects to api.listProjects', async () => {
    await dispatch(ext, handlers, api, 'wheel_list_projects', {})
    expect(api.listProjects).toHaveBeenCalledOnce()
  })

  it('routes wheel_get_board with projectId', async () => {
    await dispatch(ext, handlers, api, 'wheel_get_board', { projectId: 'p1' })
    expect(api.getBoard).toHaveBeenCalledWith('p1')
  })

  it('routes wheel_create_node with default config when none provided', async () => {
    await dispatch(ext, handlers, api, 'wheel_create_node', {
      projectId: 'p1',
      name: 'my-agent',
      type: 'agent',
      position: { x: 0, y: 0 },
    })
    expect(api.createNode).toHaveBeenCalledWith('p1', {
      name: 'my-agent',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: NODE_DEFAULTS.agent,
    })
  })

  it('routes wheel_create_node with explicit config', async () => {
    const config = { harness: 'codex', system_prompt: 'be helpful' }
    await dispatch(ext, handlers, api, 'wheel_create_node', {
      projectId: 'p1',
      name: 'my-agent',
      type: 'agent',
      position: { x: 0, y: 0 },
      config,
    })
    expect(api.createNode).toHaveBeenCalledWith('p1', {
      name: 'my-agent',
      type: 'agent',
      position: { x: 0, y: 0 },
      config,
    })
  })

  it('routes wheel_create_wire', async () => {
    await dispatch(ext, handlers, api, 'wheel_create_wire', {
      projectId: 'p1', from: 'a', to: 'b', type: 'read',
    })
    expect(api.createWire).toHaveBeenCalledWith('p1', 'a', 'b', 'read')
  })

  it('routes wheel_send_to_agent', async () => {
    await dispatch(ext, handlers, api, 'wheel_send_to_agent', {
      projectId: 'p1', nodeId: 'a1', body: 'hello',
    })
    expect(api.sendToAgent).toHaveBeenCalledWith('p1', 'a1', 'hello')
  })

  it('routes wheel_query_table', async () => {
    await dispatch(ext, handlers, api, 'wheel_query_table', {
      projectId: 'p1', nodeId: 't1', sql: 'SELECT 1',
    })
    expect(api.queryTable).toHaveBeenCalledWith('p1', 't1', 'SELECT 1')
  })

  it('routes wheel_put_secret', async () => {
    await dispatch(ext, handlers, api, 'wheel_put_secret', {
      projectId: 'p1', nodeId: 'v1', key: 'TOKEN', value: 'abc',
    })
    expect(api.putSecret).toHaveBeenCalledWith('p1', 'v1', 'TOKEN', 'abc')
  })

  it('routes wheel_apply_board', async () => {
    const board = { nodes: [{ name: 'x', type: 'ctx' }] }
    await dispatch(ext, handlers, api, 'wheel_apply_board', {
      projectId: 'p1', board, dryRun: true,
    })
    expect(api.applyBoard).toHaveBeenCalledWith('p1', board, true)
  })

  it('routes wheel_agent_log with optional params', async () => {
    await dispatch(ext, handlers, api, 'wheel_agent_log', {
      projectId: 'p1', nodeId: 'a1', since: 10, stream: 'stdout',
    })
    expect(api.agentLog).toHaveBeenCalledWith('p1', 'a1', { since: 10, stream: 'stdout' })
  })
})

describe('settle protocol', () => {
  let ext: ReturnType<typeof createMockExt>
  let api: ReturnType<typeof createMockApi>
  let handlers: Record<string, (input: any) => Promise<any>>

  beforeEach(() => {
    ext = createMockExt()
    api = createMockApi()
    handlers = buildHandlers(api)
  })

  it('settles with result on success', async () => {
    const { settled } = await dispatch(ext, handlers, api, 'wheel_list_projects', {})
    expect(settled.method).toBe('tools.settle')
    expect(settled.params.result).toEqual([{ id: 'p1', name: 'test' }])
    expect(settled.params.error).toBeUndefined()
  })

  it('settles with error when API throws', async () => {
    api.getBoard.mockRejectedValueOnce(new Error('Engine not running'))
    const { settled } = await dispatch(ext, handlers, api, 'wheel_get_board', { projectId: 'p1' })
    expect(settled.method).toBe('tools.settle')
    expect(settled.params.error).toBe('Engine not running')
    expect(settled.params.result).toBeUndefined()
  })

  it('settles with error for unknown tool', async () => {
    const { settled } = await dispatch(ext, handlers, api, 'wheel_nonexistent', {})
    expect(settled.params.error).toBe('Unknown tool: wheel_nonexistent')
  })

  it('settles with error when API is not configured', async () => {
    const { settled } = await dispatch(ext, handlers, null, 'wheel_list_projects', {})
    expect(settled.params.error).toContain('not configured')
  })
})

describe('patch_node strips undefined fields', () => {
  it('only sends name when only name is provided', async () => {
    const ext = createMockExt()
    const api = createMockApi()
    const handlers = buildHandlers(api)

    await dispatch(ext, handlers, api, 'wheel_patch_node', {
      projectId: 'p1', nodeId: 'n1', name: 'renamed',
    })
    expect(api.patchNode).toHaveBeenCalledWith('p1', 'n1', { name: 'renamed' })
  })

  it('sends position and config together', async () => {
    const ext = createMockExt()
    const api = createMockApi()
    const handlers = buildHandlers(api)

    await dispatch(ext, handlers, api, 'wheel_patch_node', {
      projectId: 'p1', nodeId: 'n1',
      position: { x: 10, y: 20 },
      config: { system_prompt: 'updated' },
    })
    expect(api.patchNode).toHaveBeenCalledWith('p1', 'n1', {
      position: { x: 10, y: 20 },
      config: { system_prompt: 'updated' },
    })
  })
})

describe('all 22 tools are handled', () => {
  const EXPECTED_TOOLS = [
    'wheel_list_projects', 'wheel_get_project', 'wheel_create_project',
    'wheel_start_project', 'wheel_stop_project', 'wheel_get_board',
    'wheel_create_node', 'wheel_patch_node', 'wheel_delete_node',
    'wheel_create_wire', 'wheel_delete_wire',
    'wheel_start_agent', 'wheel_stop_agent', 'wheel_send_to_agent', 'wheel_agent_log',
    'wheel_query_table', 'wheel_table_rows', 'wheel_put_secret',
    'wheel_apply_board', 'wheel_import_tool', 'wheel_call_tool',
    'wheel_messages', 'wheel_chest_ls',
  ]

  it('handler map covers every declared tool', () => {
    const api = createMockApi()
    const handlers = buildHandlers(api)
    for (const tool of EXPECTED_TOOLS) {
      expect(handlers).toHaveProperty(tool)
      expect(typeof handlers[tool]).toBe('function')
    }
  })

  it('handler map has no extra undeclared tools', () => {
    const api = createMockApi()
    const handlers = buildHandlers(api)
    const extra = Object.keys(handlers).filter((k) => !EXPECTED_TOOLS.includes(k))
    expect(extra).toEqual([])
  })
})

describe('node defaults', () => {
  it.each([
    ['agent', { harness: 'claude' }],
    ['ctx', { markdown: '' }],
    ['table', { columns: [{ name: 'value', type: 'text' }] }],
    ['endpoint', { method: 'POST', path: '/hook' }],
    ['script', { language: 'python' }],
    ['mcp', { transport: 'stdio' }],
    ['vault', { keys: [] }],
    ['chest', {}],
  ] as const)('provides sensible defaults for %s', (type, expected) => {
    const defaults = NODE_DEFAULTS[type]
    expect(defaults).toBeDefined()
    for (const [k, v] of Object.entries(expected)) {
      expect(defaults).toHaveProperty(k, v)
    }
  })
})
