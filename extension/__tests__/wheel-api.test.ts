import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// wheel-api.js exports via CJS tail so we can require it directly.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WheelApi } = require('../panel/wheel-api.js')

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

function url(callIndex = 0): string {
  return (fetchMock.mock.calls[callIndex] as [string])[0]
}

function method(callIndex = 0): string {
  return ((fetchMock.mock.calls[callIndex] as [string, RequestInit])[1]?.method) ?? 'GET'
}

function headers(callIndex = 0): Record<string, string> {
  return (fetchMock.mock.calls[callIndex] as [string, RequestInit])[1]?.headers as Record<string, string>
}

function body(callIndex = 0): unknown {
  const raw = (fetchMock.mock.calls[callIndex] as [string, RequestInit])[1]?.body as string
  return raw ? JSON.parse(raw) : undefined
}

describe('WheelApi construction', () => {
  it('strips trailing slashes from the URL', () => {
    const api = new WheelApi('https://api.wheel.dev///', 'tok')
    expect(api.apiUrl).toBe('https://api.wheel.dev')
  })

  it('stores the token', () => {
    const api = new WheelApi('https://api.wheel.dev', 'wht_abc')
    expect(api.apiToken).toBe('wht_abc')
  })
})

describe('request headers', () => {
  it('sends x-auth-token on every request', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'wht_secret')
    await api.listProjects()
    expect(headers()['x-auth-token']).toBe('wht_secret')
  })

  it('sends content-type for requests with a body', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.createProject('test')
    expect(headers()['content-type']).toBe('application/json')
  })

  it('sends x-project-id for project-scoped requests', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.getBoard('proj-1')
    expect(headers()['x-project-id']).toBe('proj-1')
  })
})

describe('project endpoints', () => {
  it('GET /v1/projects', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.listProjects()
    expect(url()).toBe('https://api.wheel.dev/v1/projects')
    expect(method()).toBe('GET')
  })

  it('GET /v1/projects/:id', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.getProject('abc')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/abc')
  })

  it('POST /v1/projects', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.createProject('my-project')
    expect(url()).toBe('https://api.wheel.dev/v1/projects')
    expect(method()).toBe('POST')
    expect(body()).toEqual({ name: 'my-project' })
  })

  it('POST /v1/projects/:id/start', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.startProject('p1')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/start')
    expect(method()).toBe('POST')
  })

  it('POST /v1/projects/:id/stop', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.stopProject('p1')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/stop')
    expect(method()).toBe('POST')
  })
})

describe('board + node endpoints', () => {
  it('GET board', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.getBoard('p1')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/board')
  })

  it('POST create node', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    const input = { name: 'my-agent', type: 'agent', position: { x: 0, y: 0 }, config: {} }
    await api.createNode('p1', input)
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/nodes')
    expect(method()).toBe('POST')
    expect(body()).toEqual(input)
  })

  it('PATCH node', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.patchNode('p1', 'n1', { name: 'renamed' })
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/nodes/n1')
    expect(method()).toBe('PATCH')
    expect(body()).toEqual({ name: 'renamed' })
  })

  it('DELETE node', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.deleteNode('p1', 'n1')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/nodes/n1')
    expect(method()).toBe('DELETE')
  })
})

describe('wire endpoints', () => {
  it('POST create wire', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.createWire('p1', 'a', 'b', 'read')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/wires')
    expect(method()).toBe('POST')
    expect(body()).toEqual({ from: 'a', to: 'b', type: 'read' })
  })

  it('DELETE wire', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.deleteWire('p1', 'a', 'b', 'send')
    expect(method()).toBe('DELETE')
    expect(body()).toEqual({ from: 'a', to: 'b', type: 'send' })
  })
})

describe('agent endpoints', () => {
  it('POST start agent', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.startAgent('p1', 'a1')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/agents/a1/start')
    expect(method()).toBe('POST')
  })

  it('POST stop agent', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.stopAgent('p1', 'a1')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/agents/a1/stop')
  })

  it('POST send to agent', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.sendToAgent('p1', 'a1', 'hello')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/agents/a1/send')
    expect(body()).toEqual({ body: 'hello' })
  })

  it('GET agent log with since and stream', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.agentLog('p1', 'a1', { since: 42, stream: 'stderr' })
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/agents/a1/log?since=42&stream=stderr')
  })

  it('GET agent log without params', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.agentLog('p1', 'a1')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/agents/a1/log')
  })
})

describe('table endpoints', () => {
  it('POST query', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.queryTable('p1', 't1', 'SELECT * FROM value')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/tables/t1/query')
    expect(body()).toEqual({ sql: 'SELECT * FROM value' })
  })

  it('GET rows with pagination', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.tableRows('p1', 't1', 10, 20)
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/tables/t1/rows?limit=10&offset=20')
  })
})

describe('vault endpoint', () => {
  it('PUT secret', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.putSecret('p1', 'v1', 'API_KEY', 'sk-123')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/vault/v1/API_KEY')
    expect(method()).toBe('PUT')
    expect(body()).toEqual({ value: 'sk-123' })
  })
})

describe('tool endpoints', () => {
  it('POST import tool', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.importTool('p1', '{"openapi":"3.0"}', 'openapi')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/tools/import')
    expect(body()).toEqual({ raw: '{"openapi":"3.0"}', format: 'openapi' })
  })

  it('POST call tool', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.callTool('p1', 't1', 'getUser', { id: '5' }, false)
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/tools/t1/call')
    expect(body()).toEqual({ op: 'getUser', args: { id: '5' }, dry_run: false })
  })
})

describe('chest endpoint', () => {
  it('GET ls with prefix', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.chestLs('p1', 'c1', 'uploads/')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/chests/c1/ls?prefix=uploads%2F')
  })
})

describe('messages endpoint', () => {
  it('GET messages', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.messages('p1')
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p1/engine/v1/messages')
  })
})

describe('error handling', () => {
  it('throws on non-ok response with error message from body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Node not found' } }), { status: 404 })
    )
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await expect(api.getBoard('p1')).rejects.toThrow('Node not found')
  })

  it('throws generic message when body has no error field', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 500 }))
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await expect(api.getBoard('p1')).rejects.toThrow('HTTP 500')
  })

  it('handles string error field', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
    )
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await expect(api.getBoard('p1')).rejects.toThrow('forbidden')
  })
})

describe('URL encoding', () => {
  it('encodes path segments', async () => {
    const api = new WheelApi('https://api.wheel.dev', 'tok')
    await api.patchNode('p/1', 'n/../x', { name: 'safe' })
    expect(url()).toBe('https://api.wheel.dev/v1/projects/p%2F1/engine/v1/nodes/n%2F..%2Fx')
  })
})
