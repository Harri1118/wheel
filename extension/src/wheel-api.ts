import type { NodeConfig, NodeType, GridPosition, WheelBoard, WheelNode, WheelProject, WheelWire, WireKind } from './types'

export type ApiRequestOptions = {
  method?: string
  body?: unknown
  projectId?: string
  expect?: 'void'
}

export type AuthTokenResponse = { token: string }
export type NodeInput = { name: string; type: NodeType; position?: GridPosition; config?: NodeConfig }
export type NodePatch = { name?: string; position?: GridPosition; config?: NodeConfig }
export type AgentLogOptions = { since?: number; stream?: string }
export type AgentLogEntry = { seq?: number; id?: number; stream?: string; line?: string; text?: string; body?: string }
export type AgentLogResponse = AgentLogEntry[] | { entries?: AgentLogEntry[] }
export type TableColumnRef = string | { name: string }
export type TableData = { columns?: TableColumnRef[]; rows?: Array<unknown[] | Record<string, unknown>> }
export type WheelMessage = { seq?: number; id?: number; node_id?: string; [key: string]: unknown }
export type MessagesResponse = WheelMessage[] | { messages?: WheelMessage[] }
export type ChestFile = string | { key?: string; name?: string }
export type ChestListing = ChestFile[] | { files?: ChestFile[]; keys?: ChestFile[] }
export type ImportToolFormat = 'openapi' | 'swagger2' | 'postman' | 'insomnia'
export type BuilderTurnRequest = { mode: string; turns: Array<{ role: string; text: string }> }

type ErrorBody = { error?: { message?: string } | string; message?: unknown; errors?: unknown }

export class WheelApi {
  readonly apiUrl: string
  readonly apiToken: string

  constructor(apiUrl: string, apiToken: string) {
    this.apiUrl = apiUrl.replace(/\/+$/, '')
    this.apiToken = apiToken
  }

  async request<T = unknown>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {}

    if (this.apiToken) headers['x-auth-token'] = this.apiToken
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    if (opts.projectId) headers['x-project-id'] = opts.projectId

    const res = await fetch(`${this.apiUrl}${path}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })

    if (!res.ok) {
      throw new Error(await readDetailedErrorMessage(res))
    }

    if (res.status === 204 || opts.expect === 'void') return undefined as T

    return res.json() as Promise<T>
  }

  engine(projectId: string, ...segments: string[]): string {
    return `/v1/projects/${encodeURIComponent(projectId)}/engine/v1/${segments.map(encodeURIComponent).join('/')}`
  }

  login(email: string, password: string): Promise<AuthTokenResponse> {
    return this.postWithExplicitAuth('/v1/auth/login', { email, password }, {})
  }

  createToken(sessionToken: string, name: string): Promise<AuthTokenResponse> {
    return this.postWithExplicitAuth('/v1/auth/tokens', { name }, { 'x-auth-token': sessionToken })
  }

  listProjects(): Promise<WheelProject[]> {
    return this.request('/v1/projects')
  }

  getProject(projectId: string): Promise<WheelProject> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}`, { projectId })
  }

  createProject(name: string): Promise<WheelProject> {
    return this.request('/v1/projects', { method: 'POST', body: { name } })
  }

  startProject(projectId: string): Promise<unknown> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/start`, { method: 'POST', projectId })
  }

  stopProject(projectId: string): Promise<unknown> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/stop`, { method: 'POST', projectId })
  }

  async getBoard(projectId: string): Promise<WheelBoard> {
    const result = await this.request<WheelBoard>(this.engine(projectId, 'board'), { projectId })

    console.log('[wheel:api] getBoard raw response:', JSON.stringify(result))

    return result
  }

  createNode(projectId: string, input: NodeInput): Promise<WheelNode> {
    return this.request(this.engine(projectId, 'nodes'), { method: 'POST', body: input, projectId })
  }

  patchNode(projectId: string, nodeId: string, patch: NodePatch): Promise<WheelNode> {
    return this.request(this.engine(projectId, 'nodes', nodeId), { method: 'PATCH', body: patch, projectId })
  }

  deleteNode(projectId: string, nodeId: string): Promise<void> {
    return this.request(this.engine(projectId, 'nodes', nodeId), { method: 'DELETE', projectId, expect: 'void' })
  }

  createWire(projectId: string, from: string, to: string, type: WireKind): Promise<WheelWire> {
    return this.request(this.engine(projectId, 'wires'), { method: 'POST', body: { from, to, type }, projectId })
  }

  deleteWire(projectId: string, from: string, to: string, type: WireKind): Promise<void> {
    return this.request(this.engine(projectId, 'wires'), { method: 'DELETE', body: { from, to, type }, projectId, expect: 'void' })
  }

  startAgent(projectId: string, nodeId: string): Promise<unknown> {
    return this.request(this.engine(projectId, 'agents', nodeId, 'start'), { method: 'POST', projectId })
  }

  stopAgent(projectId: string, nodeId: string): Promise<unknown> {
    return this.request(this.engine(projectId, 'agents', nodeId, 'stop'), { method: 'POST', projectId })
  }

  sendToAgent(projectId: string, nodeId: string, body: string): Promise<unknown> {
    return this.request(this.engine(projectId, 'agents', nodeId, 'send'), { method: 'POST', body: { body }, projectId })
  }

  agentLog(projectId: string, nodeId: string, opts: AgentLogOptions = {}): Promise<AgentLogResponse> {
    const query = new URLSearchParams()

    if (opts.since !== undefined) query.set('since', String(opts.since))
    if (opts.stream) query.set('stream', opts.stream)

    const queryString = query.toString()
    const path = this.engine(projectId, 'agents', nodeId, 'log') + (queryString ? `?${queryString}` : '')

    return this.request(path, { projectId })
  }

  queryTable(projectId: string, nodeId: string, sql: string): Promise<TableData> {
    return this.request(this.engine(projectId, 'tables', nodeId, 'query'), { method: 'POST', body: { sql }, projectId })
  }

  tableRows(projectId: string, nodeId: string, limit = 50, offset = 0): Promise<TableData> {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) })

    return this.request(this.engine(projectId, 'tables', nodeId, 'rows') + `?${query}`, { projectId })
  }

  putSecret(projectId: string, nodeId: string, key: string, value: string): Promise<void> {
    return this.request(this.engine(projectId, 'vault', nodeId, key), { method: 'PUT', body: { value }, projectId, expect: 'void' })
  }

  async applyBoard(projectId: string, board: unknown, dryRun = false): Promise<unknown> {
    const res = await fetch(`${this.apiUrl}${this.engine(projectId, 'board', 'apply')}`, {
      method: 'POST',
      headers: this.projectHeaders(projectId),
      body: JSON.stringify({ board, dry_run: dryRun }),
    })

    return res.json()
  }

  importTool(projectId: string, raw: string, format?: ImportToolFormat): Promise<unknown> {
    const body: { raw: string; format?: ImportToolFormat } = { raw }

    if (format) body.format = format

    return this.request(this.engine(projectId, 'tools', 'import'), { method: 'POST', body, projectId })
  }

  callTool(projectId: string, nodeId: string, op: string, args: unknown, dryRun = false): Promise<unknown> {
    return this.request(this.engine(projectId, 'tools', nodeId, 'call'), {
      method: 'POST',
      body: { op, args, dry_run: dryRun },
      projectId,
    })
  }

  messages(projectId: string): Promise<MessagesResponse> {
    return this.request(this.engine(projectId, 'messages'), { projectId })
  }

  chestLs(projectId: string, nodeId: string, prefix = ''): Promise<ChestListing> {
    const query = new URLSearchParams({ prefix })

    return this.request(this.engine(projectId, 'chests', nodeId, 'ls') + `?${query}`, { projectId })
  }

  async builderTurn(projectId: string, request: BuilderTurnRequest): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(`${this.apiUrl}/v1/projects/${encodeURIComponent(projectId)}/builder/turns`, {
      method: 'POST',
      headers: this.projectHeaders(projectId),
      body: JSON.stringify(request),
    })

    if (!res.ok) {
      throw new Error(await readErrorMessage(res))
    }

    const contentType = res.headers.get('content-type') || ''

    if (!contentType.includes('text/event-stream') || !res.body) {
      throw new Error('Builder did not return a stream')
    }

    return res.body
  }

  private async postWithExplicitAuth<T>(path: string, body: unknown, authHeaders: Record<string, string>): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      throw new Error(await readErrorMessage(res))
    }

    return res.json() as Promise<T>
  }

  private projectHeaders(projectId: string): Record<string, string> {
    return {
      'x-auth-token': this.apiToken,
      'x-project-id': projectId,
      'content-type': 'application/json',
    }
  }
}

async function readDetailedErrorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()

    console.log('[wheel:api] error response body:', JSON.stringify(body))

    return detailedMessageFrom(body, res.status)
  } catch {
    return `HTTP ${res.status}`
  }
}

function detailedMessageFrom(body: unknown, status: number): string {
  if (typeof body === 'string') return body

  const errorBody = (body ?? {}) as ErrorBody

  if (typeof errorBody.error === 'object' && errorBody.error?.message) return errorBody.error.message
  if (typeof errorBody.error === 'string') return errorBody.error
  if (typeof errorBody.message === 'string') return errorBody.message
  if (errorBody.errors) return JSON.stringify(errorBody.errors)

  return `HTTP ${status}: ${JSON.stringify(body)}`
}

async function readErrorMessage(res: Response): Promise<string> {
  const statusMessage = `HTTP ${res.status}`

  try {
    const body = (await res.json()) as ErrorBody | null

    if (typeof body?.error === 'object' && body.error?.message) return body.error.message
    if (typeof body?.error === 'string') return body.error

    return statusMessage
  } catch {
    return statusMessage
  }
}
