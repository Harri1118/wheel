import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// board-sync.js relies on spawn-plan.js globals (wheelToCanvas, buildAgentPrompt, buildNoteBody)
// being loaded first via <script> order in the browser. Populate them here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const spawnPlan = require('../panel/spawn-plan.js')
;(globalThis as Record<string, unknown>).wheelToCanvas = spawnPlan.wheelToCanvas
;(globalThis as Record<string, unknown>).buildAgentPrompt = spawnPlan.buildAgentPrompt
;(globalThis as Record<string, unknown>).buildNoteBody = spawnPlan.buildNoteBody

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BoardSync, canvasToWheel } = require('../panel/board-sync.js')

let sendRequest: ReturnType<typeof vi.fn>

beforeEach(() => {
  sendRequest = vi.fn(async () => ({}))
})

afterEach(() => vi.restoreAllMocks())

function makeBoardSync() {
  return new BoardSync(sendRequest)
}

function makeBoard(nodes: unknown[] = [], wires: unknown[] = []) {
  return { nodes, wires }
}

const agentNode = {
  id: 'a1', name: 'researcher', type: 'agent',
  position: { x: 0, y: 0 },
  config: { harness: 'claude', system_prompt: 'Research things' },
}

const ctxNode = {
  id: 'c1', name: 'docs', type: 'ctx',
  position: { x: 1, y: 0 },
  config: { markdown: '# Docs' },
}

const tableNode = {
  id: 't1', name: 'data', type: 'table',
  position: { x: 0, y: 1 },
  config: { columns: [{ name: 'value', type: 'text' }] },
}

describe('canvasToWheel', () => {
  it('inverts wheelToCanvas', () => {
    expect(canvasToWheel({ x: 340, y: 460 }, 120, 100, 100)).toEqual({ x: 2, y: 3 })
  })

  it('rounds to integers', () => {
    expect(canvasToWheel({ x: 101, y: 101 }, 120, 100, 100)).toEqual({ x: 0, y: 0 })
  })

  it('handles origin correctly', () => {
    expect(canvasToWheel({ x: 100, y: 100 }, 120, 100, 100)).toEqual({ x: 0, y: 0 })
  })
})

describe('BoardSync construction', () => {
  it('initializes with empty maps', () => {
    const sync = makeBoardSync()
    expect(sync.mappedNodeCount).toBe(0)
    expect(sync.activeProjectId).toBeNull()
  })
})

describe('spawnBoard', () => {
  it('spawns workers for agent nodes and notes for others', async () => {
    sendRequest.mockImplementation(async (method: string) => {
      if (method === 'canvas.spawnWorker') return { paneId: 'pane-w1' }
      if (method === 'canvas.spawnNote') return { paneId: 'pane-n1' }
      if (method === 'pane.persistState') return {}
      return {}
    })

    const sync = makeBoardSync()
    const board = makeBoard([agentNode, ctxNode])
    const result = await sync.spawnBoard(board, 120, 100, 100)

    expect(result.spawned).toBe(2)
    expect(result.failed).toBe(0)
  })

  it('records node-to-pane mappings', async () => {
    let paneCounter = 0
    sendRequest.mockImplementation(async (method: string) => {
      if (method === 'canvas.spawnWorker' || method === 'canvas.spawnNote') {
        return { paneId: `pane-${++paneCounter}` }
      }
      return {}
    })

    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([agentNode, ctxNode]), 120, 100, 100)

    expect(sync.mappedNodeCount).toBe(2)
    expect(sync.paneIdForNode('a1')).toBe('pane-1')
    expect(sync.paneIdForNode('c1')).toBe('pane-2')
    expect(sync.nodeIdForPane('pane-1')).toBe('a1')
    expect(sync.nodeIdForPane('pane-2')).toBe('c1')
  })

  it('counts failures without aborting', async () => {
    let callCount = 0
    sendRequest.mockImplementation(async (method: string) => {
      if (method === 'canvas.spawnWorker') throw new Error('spawn failed')
      if (method === 'canvas.spawnNote') {
        return { paneId: `pane-${++callCount}` }
      }
      return {}
    })

    const sync = makeBoardSync()
    const result = await sync.spawnBoard(makeBoard([agentNode, ctxNode]), 120, 100, 100)

    expect(result.spawned).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.errors[0].nodeId).toBe('a1')
  })

  it('spawns topology note when wires exist', async () => {
    sendRequest.mockImplementation(async (method: string) => {
      if (method === 'canvas.spawnWorker') return { paneId: 'pane-w' }
      if (method === 'canvas.spawnNote') return { paneId: 'pane-n' }
      return {}
    })

    const sync = makeBoardSync()
    const wires = [{ from: 'a1', to: 'c1', type: 'read' }]
    await sync.spawnBoard(makeBoard([agentNode, ctxNode], wires), 120, 100, 100)

    const topologyCalls = sendRequest.mock.calls.filter(
      (c: unknown[]) => c[0] === 'canvas.spawnNote' && (c[1] as { title: string })?.title === 'Wheel Topology'
    )
    expect(topologyCalls.length).toBe(1)
  })

  it('skips topology note when no wires', async () => {
    sendRequest.mockImplementation(async () => ({ paneId: 'pane-x' }))

    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([agentNode]), 120, 100, 100)

    const topologyCalls = sendRequest.mock.calls.filter(
      (c: unknown[]) => c[0] === 'canvas.spawnNote' && (c[1] as { title: string })?.title === 'Wheel Topology'
    )
    expect(topologyCalls.length).toBe(0)
  })
})

describe('handleNodeState', () => {
  it('ignores events for unknown nodes', () => {
    const sync = makeBoardSync()
    sync.handleNodeState({ nodeId: 'unknown', status: 'running' })
    // no error thrown
  })

  it('calls onAgentStatusChange for agent nodes', async () => {
    sendRequest.mockImplementation(async () => ({ paneId: 'pane-a' }))

    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([agentNode]), 120, 100, 100)

    const statusChanges: unknown[] = []
    sync.onAgentStatusChange = (nodeId: string, paneId: string, status: string) => {
      statusChanges.push({ nodeId, paneId, status })
    }

    sync.handleNodeState({ nodeId: 'a1', status: 'running' })
    expect(statusChanges).toEqual([{ nodeId: 'a1', paneId: 'pane-a', status: 'running' }])
  })

  it('moves pane on position change', async () => {
    sendRequest.mockImplementation(async () => ({ paneId: 'pane-a' }))

    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([agentNode]), 120, 100, 100)

    sync.handleNodeState({ nodeId: 'a1', position: { x: 5, y: 3 } })

    const moveCalls = sendRequest.mock.calls.filter(
      (c: unknown[]) => c[0] === 'canvas.movePanes'
    )
    expect(moveCalls.length).toBe(1)
  })
})

describe('handleBoardChanged', () => {
  it('spawns panes for added nodes', async () => {
    let counter = 0
    sendRequest.mockImplementation(async (method: string) => {
      if (method === 'canvas.spawnNote') return { paneId: `pane-${++counter}` }
      return {}
    })

    const sync = makeBoardSync()
    sync.projectId = 'proj-1'

    await sync.handleBoardChanged({
      changes: {
        added: [ctxNode],
      },
    })

    expect(sync.mappedNodeCount).toBe(1)
    expect(sync.paneIdForNode('c1')).toBe('pane-1')
  })

  it('removes panes for deleted nodes', async () => {
    sendRequest.mockImplementation(async () => ({ paneId: 'pane-a' }))

    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([agentNode]), 120, 100, 100)
    expect(sync.mappedNodeCount).toBeGreaterThanOrEqual(1)

    await sync.handleBoardChanged({
      changes: {
        removed: ['a1'],
      },
    })

    expect(sync.paneIdForNode('a1')).toBeNull()
    const killCalls = sendRequest.mock.calls.filter(
      (c: unknown[]) => c[0] === 'canvas.killPane'
    )
    expect(killCalls.length).toBe(1)
  })

  it('updates wires', async () => {
    const sync = makeBoardSync()
    sync.projectId = 'proj-1'

    const newWires = [{ from: 'a1', to: 'c1', type: 'read' }]
    await sync.handleBoardChanged({ changes: { wires: newWires } })

    expect(sync.wires).toEqual(newWires)
  })
})

describe('handlePaneMoved', () => {
  it('returns node id and converted position for known panes', async () => {
    sendRequest.mockImplementation(async () => ({ paneId: 'pane-a' }))

    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([agentNode]), 120, 100, 100)

    const result = sync.handlePaneMoved('pane-a', 340, 460)
    expect(result).not.toBeNull()
    expect(result.nodeId).toBe('a1')
    expect(result.position).toEqual({ x: 2, y: 3 })
  })

  it('returns null for unknown panes', () => {
    const sync = makeBoardSync()
    expect(sync.handlePaneMoved('unknown', 0, 0)).toBeNull()
  })
})

describe('handlePaneClose', () => {
  it('removes mapping and returns entry for known panes', async () => {
    sendRequest.mockImplementation(async () => ({ paneId: 'pane-a' }))

    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([agentNode]), 120, 100, 100)

    const entry = sync.handlePaneClose('pane-a')
    expect(entry).not.toBeNull()
    expect(entry.nodeId).toBe('a1')
    expect(sync.paneIdForNode('a1')).toBeNull()
  })

  it('returns null for topology pane', async () => {
    const sync = makeBoardSync()
    sync.topologyPaneId = 'pane-topo'

    const result = sync.handlePaneClose('pane-topo')
    expect(result).toBeNull()
    expect(sync.topologyPaneId).toBeNull()
  })

  it('returns null for unknown panes', () => {
    const sync = makeBoardSync()
    expect(sync.handlePaneClose('unknown')).toBeNull()
  })
})

describe('handleWorkerComplete', () => {
  it('returns nodeId and response for agent panes', async () => {
    sendRequest.mockImplementation(async () => ({ paneId: 'pane-a' }))

    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([agentNode]), 120, 100, 100)

    const result = sync.handleWorkerComplete('pane-a', 'done')
    expect(result).toEqual({ nodeId: 'a1', response: 'done' })
  })

  it('returns null for non-agent panes', async () => {
    sendRequest.mockImplementation(async () => ({ paneId: 'pane-n' }))

    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([ctxNode]), 120, 100, 100)

    expect(sync.handleWorkerComplete('pane-n', 'done')).toBeNull()
  })

  it('returns null for unknown panes', () => {
    const sync = makeBoardSync()
    expect(sync.handleWorkerComplete('unknown', 'done')).toBeNull()
  })
})

describe('handlePeerCount', () => {
  it('updates peer count and calls callback', () => {
    const sync = makeBoardSync()
    const changes: number[] = []
    sync.onPeerCountChange = (c: number) => changes.push(c)

    sync.handlePeerCount(3)
    expect(sync.peerCount).toBe(3)
    expect(changes).toEqual([3])
  })
})

describe('agentNodeIds', () => {
  it('returns only agent node ids', async () => {
    let counter = 0
    sendRequest.mockImplementation(async (method: string) => {
      if (method === 'canvas.spawnWorker' || method === 'canvas.spawnNote') {
        return { paneId: `pane-${++counter}` }
      }
      return {}
    })

    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([agentNode, ctxNode, tableNode]), 120, 100, 100)

    expect(sync.agentNodeIds()).toEqual(['a1'])
  })
})

describe('nodeForPane', () => {
  it('returns full node with wire info', async () => {
    let counter = 0
    sendRequest.mockImplementation(async (method: string) => {
      if (method === 'canvas.spawnWorker' || method === 'canvas.spawnNote') {
        return { paneId: `pane-${++counter}` }
      }
      return {}
    })

    const wires = [{ from: 'a1', to: 'c1', type: 'read' }]
    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([agentNode, ctxNode], wires), 120, 100, 100)

    const node = sync.nodeForPane('pane-1')
    expect(node).not.toBeNull()
    expect(node.id).toBe('a1')
    expect(node.name).toBe('researcher')
    expect(node.wires).toHaveLength(1)
    expect(node.wires[0].direction).toBe('outgoing')
    expect(node.wires[0].peerName).toBe('docs')
  })

  it('returns null for unknown panes', () => {
    const sync = makeBoardSync()
    expect(sync.nodeForPane('unknown')).toBeNull()
  })
})

describe('reconcileBoard', () => {
  it('removes panes for nodes no longer on the board', async () => {
    let counter = 0
    sendRequest.mockImplementation(async (method: string) => {
      if (method === 'canvas.spawnWorker' || method === 'canvas.spawnNote') {
        return { paneId: `pane-${++counter}` }
      }
      return {}
    })

    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([agentNode, ctxNode]), 120, 100, 100)
    expect(sync.mappedNodeCount).toBe(2)

    await sync.reconcileBoard(makeBoard([ctxNode]))

    expect(sync.paneIdForNode('a1')).toBeNull()
    expect(sync.paneIdForNode('c1')).not.toBeNull()
  })

  it('spawns panes for new nodes on the board', async () => {
    let counter = 0
    sendRequest.mockImplementation(async (method: string) => {
      if (method === 'canvas.spawnWorker' || method === 'canvas.spawnNote') {
        return { paneId: `pane-${++counter}` }
      }
      return {}
    })

    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([agentNode]), 120, 100, 100)

    await sync.reconcileBoard(makeBoard([agentNode, ctxNode]))

    expect(sync.paneIdForNode('c1')).not.toBeNull()
  })
})

describe('createNode', () => {
  it('calls api.createNode with correct config', async () => {
    const sync = makeBoardSync()
    sync.projectId = 'proj-1'

    const mockApi = {
      createNode: vi.fn(async () => ({ id: 'new-1', name: 'my-agent', type: 'agent' })),
    }

    const result = await sync.createNode(mockApi, 'my-agent', 'agent', { x: 200, y: 300 })

    expect(mockApi.createNode).toHaveBeenCalledWith('proj-1', {
      name: 'my-agent',
      type: 'agent',
      position: canvasToWheel({ x: 200, y: 300 }, 120, 100, 100),
      config: expect.objectContaining({ harness: 'claude' }),
    })
    expect(result.id).toBe('new-1')
  })

  it('throws when no project is open', async () => {
    const sync = makeBoardSync()
    const mockApi = { createNode: vi.fn() }

    await expect(sync.createNode(mockApi, 'test', 'ctx')).rejects.toThrow('No project open')
  })
})

describe('persistState and restoreState', () => {
  it('persists and restores state', async () => {
    let storedState: unknown = null
    sendRequest.mockImplementation(async (method: string, params?: { data?: unknown }) => {
      if (method === 'canvas.spawnWorker') return { paneId: 'pane-a' }
      if (method === 'canvas.spawnNote') return { paneId: 'pane-n' }
      if (method === 'pane.persistState') {
        storedState = params?.data
        return {}
      }
      if (method === 'pane.loadState') return { data: storedState }
      return {}
    })

    const sync = makeBoardSync()
    await sync.openProject(
      { getBoard: async () => makeBoard([agentNode]) },
      'proj-1', 120, 100, 100
    )

    const sync2 = makeBoardSync()
    const restored = await sync2.restoreState()

    expect(restored).toBe(true)
    expect(sync2.activeProjectId).toBe('proj-1')
  })
})

describe('buildTopologyBody', () => {
  it('renders wire connections grouped by node', async () => {
    sendRequest.mockImplementation(async () => ({ paneId: 'pane-x' }))

    const wires = [
      { from: 'a1', to: 'c1', type: 'read' },
      { from: 'a1', to: 't1', type: 'write' },
    ]
    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([agentNode, ctxNode, tableNode], wires), 120, 100, 100)

    const body = sync.buildTopologyBody()
    expect(body).toContain('### researcher')
    expect(body).toContain('### docs')
    expect(body).toContain('read')
    expect(body).toContain('write')
  })
})

describe('log polling', () => {
  it('starts and stops polling for agent nodes', async () => {
    vi.useFakeTimers()
    sendRequest.mockImplementation(async () => ({ paneId: 'pane-a' }))

    const sync = makeBoardSync()
    sync.projectId = 'proj-1'
    await sync.spawnBoard(makeBoard([agentNode]), 120, 100, 100)

    const mockApi = {
      agentLog: vi.fn(async () => []),
    }

    sync.startAgentLogPolling(mockApi, 'a1', 1000)

    await vi.advanceTimersByTimeAsync(3500)
    expect(mockApi.agentLog.mock.calls.length).toBeGreaterThanOrEqual(3)

    sync.stopAgentLogPolling('a1')
    const countAfterStop = mockApi.agentLog.mock.calls.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(mockApi.agentLog.mock.calls.length).toBe(countAfterStop)

    vi.useRealTimers()
  })

  it('does not start polling for non-agent nodes', async () => {
    sendRequest.mockImplementation(async () => ({ paneId: 'pane-n' }))

    const sync = makeBoardSync()
    await sync.spawnBoard(makeBoard([ctxNode]), 120, 100, 100)

    const mockApi = { agentLog: vi.fn() }
    sync.startAgentLogPolling(mockApi, 'c1')

    expect(mockApi.agentLog).not.toHaveBeenCalled()
  })

  it('stopAllLogPolling clears all timers', async () => {
    vi.useFakeTimers()
    sendRequest.mockImplementation(async () => ({ paneId: 'pane-a' }))

    const sync = makeBoardSync()
    sync.projectId = 'proj-1'
    await sync.spawnBoard(makeBoard([agentNode]), 120, 100, 100)

    const mockApi = { agentLog: vi.fn(async () => []) }
    sync.startAgentLogPolling(mockApi, 'a1', 1000)

    sync.stopAllLogPolling()
    const countAfterStop = mockApi.agentLog.mock.calls.length
    vi.advanceTimersByTime(5000)
    expect(mockApi.agentLog.mock.calls.length).toBe(countAfterStop)

    vi.useRealTimers()
  })
})
