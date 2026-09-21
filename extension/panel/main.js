// Wheel extension panel — tool handler runtime + live board sync bridge.
//
// This panel receives tool call events from AgentGrid, forwards them to the
// Wheel API via WheelApi, and settles the results back. It also provides a
// config UI, project picker, and drives the board↔canvas sync via BoardSync
// and WheelEventSource.

const ext = window.agentGridExtension
let api = null
let reqId = 0
let boardSync = null
let eventSource = null

// -- host messaging helpers --

function sendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = `r-${++reqId}`
    const cleanup = ext.onMessage((msg) => {
      if (msg.kind !== 'response' || msg.id !== id) return
      cleanup()
      if (msg.ok) resolve(msg.result)
      else reject(new Error(msg.error))
    })
    ext.postMessage({ kind: 'request', id, method, params })
  })
}

function settle(callId, result) {
  ext.postMessage({
    kind: 'request',
    id: `settle-${++reqId}`,
    method: 'tools.settle',
    params: { callId, result },
  })
}

function settleError(callId, error) {
  ext.postMessage({
    kind: 'request',
    id: `settle-${++reqId}`,
    method: 'tools.settle',
    params: { callId, error: String(error) },
  })
}

// -- secrets --

async function loadSecrets() {
  const secrets = await sendRequest('secrets.list')
  const map = {}
  if (Array.isArray(secrets)) {
    for (const s of secrets) map[s.key] = s.value
  }
  return map
}

async function saveSecret(key, value) {
  await sendRequest('secrets.set', { key, value })
}

// -- node defaults (from wheel-core) --

const NODE_DEFAULTS = {
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

// -- tool dispatch --

const TOOL_HANDLERS = {
  wheel_list_projects: () =>
    api.listProjects(),

  wheel_get_project: ({ projectId }) =>
    api.getProject(projectId),

  wheel_create_project: ({ name }) =>
    api.createProject(name),

  wheel_start_project: ({ projectId }) =>
    api.startProject(projectId),

  wheel_stop_project: ({ projectId }) =>
    api.stopProject(projectId),

  wheel_get_board: ({ projectId }) =>
    api.getBoard(projectId),

  wheel_create_node: ({ projectId, name, type, position, config }) => {
    const nodeConfig = config || NODE_DEFAULTS[type] || {}
    return api.createNode(projectId, { name, type, position, config: nodeConfig })
  },

  wheel_patch_node: ({ projectId, nodeId, ...patch }) => {
    const body = {}
    if (patch.name !== undefined) body.name = patch.name
    if (patch.position !== undefined) body.position = patch.position
    if (patch.config !== undefined) body.config = patch.config
    return api.patchNode(projectId, nodeId, body)
  },

  wheel_delete_node: ({ projectId, nodeId }) =>
    api.deleteNode(projectId, nodeId),

  wheel_create_wire: ({ projectId, from, to, type }) =>
    api.createWire(projectId, from, to, type),

  wheel_delete_wire: ({ projectId, from, to, type }) =>
    api.deleteWire(projectId, from, to, type),

  wheel_start_agent: ({ projectId, nodeId }) =>
    api.startAgent(projectId, nodeId),

  wheel_stop_agent: ({ projectId, nodeId }) =>
    api.stopAgent(projectId, nodeId),

  wheel_send_to_agent: ({ projectId, nodeId, body }) =>
    api.sendToAgent(projectId, nodeId, body),

  wheel_agent_log: ({ projectId, nodeId, since, stream }) =>
    api.agentLog(projectId, nodeId, { since, stream }),

  wheel_query_table: ({ projectId, nodeId, sql }) =>
    api.queryTable(projectId, nodeId, sql),

  wheel_table_rows: ({ projectId, nodeId, limit, offset }) =>
    api.tableRows(projectId, nodeId, limit, offset),

  wheel_put_secret: ({ projectId, nodeId, key, value }) =>
    api.putSecret(projectId, nodeId, key, value),

  wheel_apply_board: ({ projectId, board, dryRun }) =>
    api.applyBoard(projectId, board, dryRun || false),

  wheel_import_tool: ({ projectId, raw, format }) =>
    api.importTool(projectId, raw, format),

  wheel_call_tool: ({ projectId, nodeId, op, args, dryRun }) =>
    api.callTool(projectId, nodeId, op, args, dryRun || false),

  wheel_messages: ({ projectId }) =>
    api.messages(projectId),

  wheel_chest_ls: ({ projectId, nodeId, prefix }) =>
    api.chestLs(projectId, nodeId, prefix),

  wheel_open_project: async ({ projectId, scale, offsetX, offsetY }) => {
    const result = await openProjectOnCanvas(projectId, scale, offsetX, offsetY)
    return result
  },

  wheel_poll_messages: async ({ projectId, since }) => {
    const msgs = await api.messages(projectId)
    const all = Array.isArray(msgs) ? msgs : (msgs.messages || [])
    const cursor = since || 0
    const fresh = all.filter(m => (m.seq || m.id || 0) > cursor)
    const nextCursor = fresh.length > 0
      ? Math.max(...fresh.map(m => m.seq || m.id || 0))
      : cursor
    return { messages: fresh, cursor: nextCursor }
  },
}

// -- board sync integration --

async function openProjectOnCanvas(projectId, scale, offsetX, offsetY) {
  if (!boardSync) {
    boardSync = new BoardSync(sendRequest)
  }

  if (eventSource) {
    eventSource.disconnect()
    eventSource = null
  }

  boardSync?.stopAllLogPolling()

  const result = await boardSync.openProject(
    api,
    projectId,
    scale || 120,
    offsetX || 100,
    offsetY || 100
  )

  subscribeToCanvasEvents()
  connectEventStream(projectId)
  startAgentLogPollers()
  updateSyncStatus()

  return {
    ...result,
    projectId,
    syncing: true,
  }
}

function startAgentLogPollers() {
  if (!boardSync || !api) return

  for (const nodeId of boardSync.agentNodeIds()) {
    boardSync.startAgentLogPolling(api, nodeId)
  }

  boardSync.onAgentLog = (nodeId, paneId, entries) => {
    logCall(`agent-log:${nodeId}`, true, `${entries.length} entries`)
  }

  boardSync.onAgentStatusChange = (nodeId, paneId, status) => {
    logCall(`agent-status:${nodeId}`, true, status)
  }
}

function connectEventStream(projectId) {
  eventSource = new WheelEventSource(api, projectId, {
    onConnectionChange: (status) => {
      updateSyncConnection(status)

      if (status === 'connected' && boardSync?.activeProjectId) {
        reconcileOnReconnect()
      }
    },

    onNodeState: (payload) => {
      boardSync?.handleNodeState(payload)
    },

    onBoardChanged: (payload) => {
      boardSync?.handleBoardChanged(payload)
    },

    onLagged: () => {
      boardSync?.handleLagged(api)
    },

    onPeers: (payload) => {
      const count = payload.count ?? payload.peers?.length ?? 0
      boardSync?.handlePeerCount(count)
      updatePeerCount(count)
    },

    onMessage: (payload) => {
      if (boardSync?.activeProjectId && payload.node_id) {
        const entry = boardSync.nodeToPane.get(payload.node_id)
        if (entry) {
          logCall(`ws:message:${payload.node_id}`, true, '')
        }
      }
    },

    onLog: (payload) => {
      if (boardSync && payload.node_id) {
        const entry = boardSync.nodeToPane.get(payload.node_id)
        if (entry) {
          boardSync.onAgentLog?.(payload.node_id, entry.paneId, [payload])
        }
      }
    },

    onWireDenied: (payload) => {
      logCall('ws:wire-denied', false, `${payload.from} → ${payload.to} (${payload.type})`)
    },
  })

  eventSource.connect()
}

async function reconcileOnReconnect() {
  try {
    const board = await api.getBoard(boardSync.activeProjectId)
    await boardSync.reconcileBoard(board)
    updateSyncStatus()
  } catch {
    // reconciliation failed — not fatal, will retry on next reconnect
  }
}

function subscribeToCanvasEvents() {
  sendRequest('canvas.subscribe', {
    events: ['canvas.paneMoved', 'canvas.paneClose', 'canvas.workerComplete', 'canvas.workerStatusChange'],
  }).catch(() => {})
}

// -- canvas event handling --

function listenForCanvasEvents() {
  ext.onMessage((msg) => {
    if (msg.kind !== 'event') return

    if (msg.topic === 'canvas.paneMoved' && boardSync) {
      const { paneId, x, y } = msg.payload
      const move = boardSync.handlePaneMoved(paneId, x, y)

      if (move && boardSync.activeProjectId) {
        api.patchNode(boardSync.activeProjectId, move.nodeId, {
          position: move.position,
        }).catch(() => {})
      }
    }

    if (msg.topic === 'canvas.paneClose' && boardSync) {
      const closed = boardSync.handlePaneClose(msg.payload.paneId)

      if (closed && boardSync.activeProjectId) {
        boardSync.stopAgentLogPolling(closed.nodeId)
        api.deleteNode(boardSync.activeProjectId, closed.nodeId).catch(() => {})
        updateSyncStatus()
      }
    }

    if (msg.topic === 'canvas.workerComplete' && boardSync) {
      const { paneId, response, error } = msg.payload
      const relay = boardSync.handleWorkerComplete(paneId, response)

      if (relay && boardSync.activeProjectId && response && !error) {
        api.sendToAgent(boardSync.activeProjectId, relay.nodeId, relay.response).catch(() => {})
      }
    }

    if (msg.topic === 'canvas.workerStatusChange' && boardSync) {
      const { paneId, status } = msg.payload
      const entry = boardSync.paneToNode.get(paneId)

      if (entry?.nodeType === 'agent' && boardSync.activeProjectId) {
        if (status === 'running') {
          api.startAgent(boardSync.activeProjectId, entry.nodeId).catch(() => {})
        }
      }
    }

    if (msg.topic === 'command' && msg.payload?.commandId === 'wheel.addNode') {
      showNodeCreationDialog()
    }
  })
}

// -- Phase 3.4: node creation dialog --

const NODE_TYPES = ['agent', 'ctx', 'table', 'endpoint', 'script', 'mcp', 'vault', 'chest', 'tool']

function showNodeCreationDialog() {
  if (!boardSync?.activeProjectId || !api) return

  const existing = document.getElementById('node-dialog')
  if (existing) existing.remove()

  const dialog = document.createElement('div')
  dialog.id = 'node-dialog'
  dialog.className = 'dialog-overlay'

  const box = document.createElement('div')
  box.className = 'dialog'

  const heading = document.createElement('h3')
  heading.textContent = 'Add Wheel Node'
  box.appendChild(heading)

  const nameLabel = document.createElement('label')
  nameLabel.textContent = 'Name'
  const nameInput = document.createElement('input')
  nameInput.id = 'node-name'
  nameInput.type = 'text'
  nameInput.placeholder = 'my-node'
  nameLabel.appendChild(nameInput)
  box.appendChild(nameLabel)

  const typeLabel = document.createElement('label')
  typeLabel.textContent = 'Type'
  const typeSelect = document.createElement('select')
  typeSelect.id = 'node-type'
  for (const t of NODE_TYPES) {
    const opt = document.createElement('option')
    opt.value = t
    opt.textContent = t.charAt(0).toUpperCase() + t.slice(1)
    typeSelect.appendChild(opt)
  }
  typeLabel.appendChild(typeSelect)
  box.appendChild(typeLabel)

  const actions = document.createElement('div')
  actions.className = 'dialog-actions'

  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'link'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.addEventListener('click', () => dialog.remove())

  const createBtn = document.createElement('button')
  createBtn.textContent = 'Create'

  const errorEl = document.createElement('p')
  errorEl.className = 'error'
  errorEl.hidden = true

  createBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim()
    const type = typeSelect.value

    if (!name) {
      errorEl.textContent = 'Name is required'
      errorEl.hidden = false
      return
    }

    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) {
      errorEl.textContent = 'Name must be lowercase alphanumeric with dashes/underscores'
      errorEl.hidden = false
      return
    }

    try {
      await boardSync.createNode(api, name, type)
      dialog.remove()
    } catch (err) {
      errorEl.textContent = err.message
      errorEl.hidden = false
    }
  })

  actions.appendChild(cancelBtn)
  actions.appendChild(createBtn)
  box.appendChild(actions)
  box.appendChild(errorEl)
  dialog.appendChild(box)
  document.body.appendChild(dialog)
}

// -- call log --

const MAX_LOG = 50
const callHistory = []

function logCall(toolName, ok, detail) {
  callHistory.unshift({ toolName, ok, detail, time: new Date() })
  if (callHistory.length > MAX_LOG) callHistory.length = MAX_LOG
  renderLog()
}

function renderLog() {
  const ul = document.getElementById('call-log')
  ul.textContent = ''
  for (const entry of callHistory) {
    const li = document.createElement('li')
    const ts = entry.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

    const timeSpan = document.createElement('span')
    timeSpan.textContent = ts + ' '
    li.appendChild(timeSpan)

    const nameSpan = document.createElement('span')
    nameSpan.className = 'tool-name'
    nameSpan.textContent = entry.toolName
    li.appendChild(nameSpan)

    const statusSpan = document.createElement('span')
    statusSpan.textContent = ' '
    li.appendChild(statusSpan)

    const resultSpan = document.createElement('span')
    resultSpan.className = entry.ok ? 'ok' : 'fail'
    resultSpan.textContent = entry.ok ? 'ok' : entry.detail
    li.appendChild(resultSpan)

    ul.appendChild(li)
  }
}

// -- tool event listener --

function listenForTools() {
  ext.onMessage(async (msg) => {
    if (msg.kind !== 'event' || msg.topic !== 'tool') return

    const { callId, toolName, input } = msg.payload
    const handler = TOOL_HANDLERS[toolName]

    if (!handler) {
      settleError(callId, `Unknown tool: ${toolName}`)
      logCall(toolName, false, 'unknown tool')
      return
    }

    if (!api) {
      settleError(callId, 'Wheel API not configured. Open the Wheel pane and enter your API URL and token.')
      logCall(toolName, false, 'not configured')
      return
    }

    try {
      const result = await handler(input || {})
      settle(callId, result)
      logCall(toolName, true, '')
    } catch (err) {
      settleError(callId, err.message || String(err))
      logCall(toolName, false, err.message || String(err))
    }
  })
}

// -- UI --

const $setup = document.getElementById('setup')
const $status = document.getElementById('status')
const $dot = document.getElementById('dot')
const $statusLabel = document.getElementById('status-label')
const $apiUrlDisplay = document.getElementById('api-url-display')
const $projectCount = document.getElementById('project-count')
const $setupError = document.getElementById('setup-error')
const $inputUrl = document.getElementById('input-url')
const $inputEmail = document.getElementById('input-email')
const $inputPassword = document.getElementById('input-password')
const $inputToken = document.getElementById('input-token')
const $tokenSection = document.getElementById('token-section')
const $projectsSection = document.getElementById('projects-section')
const $projectList = document.getElementById('project-list')
const $syncStatus = document.getElementById('sync-status')
const $syncDot = document.getElementById('sync-dot')
const $syncLabel = document.getElementById('sync-label')
const $syncDetail = document.getElementById('sync-detail')

function showSetup(urlVal) {
  $setup.hidden = false
  $status.hidden = true
  $inputUrl.value = urlVal || ''
  $inputEmail.value = ''
  $inputPassword.value = ''
  $inputToken.value = ''
  $tokenSection.hidden = true
  $setupError.hidden = true
}

async function showStatus() {
  $setup.hidden = true
  $status.hidden = false
  $apiUrlDisplay.textContent = api.apiUrl
  $dot.className = 'dot'
  $statusLabel.textContent = 'Checking...'
  $projectCount.textContent = ''

  try {
    const projects = await api.listProjects()
    $dot.className = 'dot ok'
    $statusLabel.textContent = 'Connected'
    $projectCount.textContent = `${projects.length} project${projects.length === 1 ? '' : 's'}`

    renderProjectList(projects)
  } catch (err) {
    $dot.className = 'dot err'
    $statusLabel.textContent = 'Error'
    $projectCount.textContent = err.message
    $projectsSection.hidden = true
  }
}

function renderProjectList(projects) {
  $projectsSection.hidden = false
  $projectList.textContent = ''

  for (const project of projects) {
    const li = document.createElement('li')
    li.className = 'project-item'

    const nameSpan = document.createElement('span')
    nameSpan.className = 'project-name'
    nameSpan.textContent = project.name || project.id

    const openBtn = document.createElement('button')
    openBtn.className = 'btn-small'
    openBtn.textContent = 'Open on Canvas'
    openBtn.addEventListener('click', () => handleOpenProject(project.id))

    li.appendChild(nameSpan)
    li.appendChild(openBtn)
    $projectList.appendChild(li)
  }
}

async function handleOpenProject(projectId) {
  try {
    updateSyncStatus('opening')
    await openProjectOnCanvas(projectId)
  } catch (err) {
    updateSyncStatus('error', err.message)
  }
}

function updateSyncStatus(status, detail) {
  $syncStatus.hidden = false

  if (status === 'opening') {
    $syncDot.className = 'dot'
    $syncLabel.textContent = 'Opening board...'
    $syncDetail.textContent = ''
    return
  }

  if (status === 'error') {
    $syncDot.className = 'dot err'
    $syncLabel.textContent = 'Sync error'
    $syncDetail.textContent = detail || ''
    return
  }

  if (!boardSync?.activeProjectId) {
    $syncStatus.hidden = true
    return
  }

  const nodeCount = boardSync.mappedNodeCount
  $syncDot.className = 'dot ok'
  $syncLabel.textContent = 'Synced'
  $syncDetail.textContent = `${nodeCount} node${nodeCount === 1 ? '' : 's'} on canvas`
}

function updateSyncConnection(wsStatus) {
  if (!$syncStatus || $syncStatus.hidden) return

  if (wsStatus === 'connected') {
    $syncDot.className = 'dot ok'
    $syncLabel.textContent = 'Live'
  } else if (wsStatus === 'reconnecting') {
    $syncDot.className = 'dot'
    $syncLabel.textContent = 'Reconnecting...'
  } else {
    $syncDot.className = 'dot err'
    $syncLabel.textContent = 'Disconnected'
  }
}

function updatePeerCount(count) {
  if (!$syncDetail) return
  const nodeCount = boardSync?.mappedNodeCount || 0
  const peerText = count > 0 ? ` · ${count} peer${count === 1 ? '' : 's'}` : ''
  $syncDetail.textContent = `${nodeCount} node${nodeCount === 1 ? '' : 's'} on canvas${peerText}`
}

function validateUrl() {
  const url = $inputUrl.value.trim()

  if (!url) {
    $setupError.textContent = 'API URL is required'
    $setupError.hidden = false
    return null
  }

  try {
    new URL(url)
  } catch {
    $setupError.textContent = 'Invalid URL'
    $setupError.hidden = false
    return null
  }

  $setupError.hidden = true
  return url
}

document.getElementById('btn-signin').addEventListener('click', async () => {
  const url = validateUrl()
  if (!url) return

  const email = $inputEmail.value.trim()
  const password = $inputPassword.value

  if (!email || !password) {
    $setupError.textContent = 'Email and password are required'
    $setupError.hidden = false
    return
  }

  const btn = document.getElementById('btn-signin')
  btn.disabled = true
  btn.textContent = 'Signing in...'
  $setupError.hidden = true

  try {
    const tempApi = new WheelApi(url, '')
    const session = await tempApi.login(email, password)
    const created = await tempApi.createToken(session.token, 'AgentGrid')

    await saveSecret('apiUrl', url)
    await saveSecret('apiToken', created.token)
    api = new WheelApi(url, created.token)
    await showStatus()
  } catch (err) {
    $setupError.textContent = err.message
    $setupError.hidden = false
  } finally {
    btn.disabled = false
    btn.textContent = 'Sign in'
  }
})

document.getElementById('btn-toggle-token').addEventListener('click', () => {
  $tokenSection.hidden = !$tokenSection.hidden
})

document.getElementById('btn-save-token').addEventListener('click', async () => {
  const url = validateUrl()
  if (!url) return

  const token = $inputToken.value.trim()

  try {
    await saveSecret('apiUrl', url)
    if (token) await saveSecret('apiToken', token)
    api = new WheelApi(url, token)
    await showStatus()
  } catch (err) {
    $setupError.textContent = err.message
    $setupError.hidden = false
  }
})

document.getElementById('btn-configure').addEventListener('click', () => {
  showSetup(api?.apiUrl || '')
})

// -- init --

async function init() {
  boardSync = new BoardSync(sendRequest)
  listenForTools()
  listenForCanvasEvents()

  const restored = await boardSync.restoreState()

  try {
    const secrets = await loadSecrets()
    const url = secrets.apiUrl
    const token = secrets.apiToken

    const effectiveUrl = url || 'https://wheel-api-production-28d3.up.railway.app'

    if (url && token) {
      api = new WheelApi(url, token)
      await showStatus()

      if (restored && boardSync.activeProjectId) {
        subscribeToCanvasEvents()
        connectEventStream(boardSync.activeProjectId)
        updateSyncStatus()
      }
    } else {
      showSetup(effectiveUrl)
    }
  } catch {
    showSetup('')
  }
}

init()
