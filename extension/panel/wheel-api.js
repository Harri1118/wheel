// Wheel API client — thin fetch wrapper that mirrors web/src/lib/api.ts
// but talks directly to the Wheel API instead of through a Next.js proxy.

// eslint-disable-next-line no-unused-vars
class WheelApi {
  constructor(apiUrl, apiToken) {
    this.apiUrl = apiUrl.replace(/\/+$/, '')
    this.apiToken = apiToken
  }

  async request(path, opts = {}) {
    const headers = {}
    if (this.apiToken) headers['x-auth-token'] = this.apiToken
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    if (opts.projectId) headers['x-project-id'] = opts.projectId

    const res = await fetch(`${this.apiUrl}${path}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })

    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const body = await res.json()
        if (body?.error?.message) msg = body.error.message
        else if (body?.error) msg = typeof body.error === 'string' ? body.error : msg
      } catch { /* keep default */ }
      throw new Error(msg)
    }

    if (res.status === 204 || opts.expect === 'void') return undefined
    return res.json()
  }

  engine(projectId, ...segments) {
    return `/v1/projects/${encodeURIComponent(projectId)}/engine/v1/${segments.map(encodeURIComponent).join('/')}`
  }

  // -- auth --

  async login(email, password) {
    const res = await fetch(`${this.apiUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })

    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const body = await res.json()
        if (body?.error?.message) msg = body.error.message
      } catch { /* keep default */ }
      throw new Error(msg)
    }

    return res.json()
  }

  async createToken(sessionToken, name) {
    const res = await fetch(`${this.apiUrl}/v1/auth/tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': sessionToken,
      },
      body: JSON.stringify({ name }),
    })

    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const body = await res.json()
        if (body?.error?.message) msg = body.error.message
      } catch { /* keep default */ }
      throw new Error(msg)
    }

    return res.json()
  }

  // -- projects --

  listProjects() {
    return this.request('/v1/projects')
  }

  getProject(projectId) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}`, { projectId })
  }

  createProject(name) {
    return this.request('/v1/projects', { method: 'POST', body: { name } })
  }

  startProject(projectId) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/start`, { method: 'POST', projectId })
  }

  stopProject(projectId) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/stop`, { method: 'POST', projectId })
  }

  // -- board --

  getBoard(projectId) {
    return this.request(this.engine(projectId, 'board'), { projectId })
  }

  // -- nodes --

  createNode(projectId, input) {
    return this.request(this.engine(projectId, 'nodes'), { method: 'POST', body: input, projectId })
  }

  patchNode(projectId, nodeId, patch) {
    return this.request(this.engine(projectId, 'nodes', nodeId), { method: 'PATCH', body: patch, projectId })
  }

  deleteNode(projectId, nodeId) {
    return this.request(this.engine(projectId, 'nodes', nodeId), { method: 'DELETE', projectId, expect: 'void' })
  }

  // -- wires --

  createWire(projectId, from, to, type) {
    return this.request(this.engine(projectId, 'wires'), { method: 'POST', body: { from, to, type }, projectId })
  }

  deleteWire(projectId, from, to, type) {
    return this.request(this.engine(projectId, 'wires'), { method: 'DELETE', body: { from, to, type }, projectId, expect: 'void' })
  }

  // -- agents --

  startAgent(projectId, nodeId) {
    return this.request(this.engine(projectId, 'agents', nodeId, 'start'), { method: 'POST', projectId })
  }

  stopAgent(projectId, nodeId) {
    return this.request(this.engine(projectId, 'agents', nodeId, 'stop'), { method: 'POST', projectId })
  }

  sendToAgent(projectId, nodeId, body) {
    return this.request(this.engine(projectId, 'agents', nodeId, 'send'), { method: 'POST', body: { body }, projectId })
  }

  agentLog(projectId, nodeId, opts = {}) {
    const q = new URLSearchParams()
    if (opts.since !== undefined) q.set('since', String(opts.since))
    if (opts.stream) q.set('stream', opts.stream)
    const qs = q.toString()
    const path = this.engine(projectId, 'agents', nodeId, 'log') + (qs ? `?${qs}` : '')
    return this.request(path, { projectId })
  }

  // -- tables --

  queryTable(projectId, nodeId, sql) {
    return this.request(this.engine(projectId, 'tables', nodeId, 'query'), { method: 'POST', body: { sql }, projectId })
  }

  tableRows(projectId, nodeId, limit = 50, offset = 0) {
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    return this.request(this.engine(projectId, 'tables', nodeId, 'rows') + `?${q}`, { projectId })
  }

  // -- vault --

  putSecret(projectId, nodeId, key, value) {
    return this.request(this.engine(projectId, 'vault', nodeId, key), { method: 'PUT', body: { value }, projectId, expect: 'void' })
  }

  // -- board apply --

  async applyBoard(projectId, board, dryRun = false) {
    const res = await fetch(`${this.apiUrl}${this.engine(projectId, 'board', 'apply')}`, {
      method: 'POST',
      headers: {
        'x-auth-token': this.apiToken,
        'x-project-id': projectId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ board, dry_run: dryRun }),
    })
    return res.json()
  }

  // -- tools --

  importTool(projectId, raw, format) {
    const body = { raw }
    if (format) body.format = format
    return this.request(this.engine(projectId, 'tools', 'import'), { method: 'POST', body, projectId })
  }

  callTool(projectId, nodeId, op, args, dryRun = false) {
    return this.request(this.engine(projectId, 'tools', nodeId, 'call'), {
      method: 'POST',
      body: { op, args, dry_run: dryRun },
      projectId,
    })
  }

  // -- messages --

  messages(projectId) {
    return this.request(this.engine(projectId, 'messages'), { projectId })
  }

  // -- chest --

  chestLs(projectId, nodeId, prefix = '') {
    const q = new URLSearchParams({ prefix })
    return this.request(this.engine(projectId, 'chests', nodeId, 'ls') + `?${q}`, { projectId })
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { WheelApi }
