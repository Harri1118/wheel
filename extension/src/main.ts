import { createPanel } from '@agentgrid/sdk'
import type { PanelClient } from '@agentgrid/sdk'
import { BoardSync, defaultNodeConfig } from './board-sync'
import { byId } from './dom'
import { DEFAULT_API_URL, NODE_TYPES, WHEEL_EXTENSION_ID, errorMessage, isNodeType } from './types'
import type { GridPosition, NodeConfig, NodeType, WireKind } from './types'
import { WheelApi } from './wheel-api'
import type { ImportToolFormat, NodePatch } from './wheel-api'
import { WheelEventSource } from './wheel-events'
import type { ConnectionStatus } from './wheel-events'

type ProjectInput = { projectId: string }
type NodeRef = ProjectInput & { nodeId: string }
type WireInput = ProjectInput & { from: string; to: string; type: WireKind }

type ToolInputs = {
  wheel_list_projects: Record<string, never>
  wheel_get_project: ProjectInput
  wheel_create_project: { name: string }
  wheel_start_project: ProjectInput
  wheel_stop_project: ProjectInput
  wheel_get_board: ProjectInput
  wheel_create_node: ProjectInput & { name: string; type: NodeType; position: GridPosition; config?: NodeConfig }
  wheel_patch_node: NodeRef & NodePatch
  wheel_delete_node: NodeRef
  wheel_create_wire: WireInput
  wheel_delete_wire: WireInput
  wheel_start_agent: NodeRef
  wheel_stop_agent: NodeRef
  wheel_send_to_agent: NodeRef & { body: string }
  wheel_agent_log: NodeRef & { since?: number; stream?: string }
  wheel_query_table: NodeRef & { sql: string }
  wheel_table_rows: NodeRef & { limit?: number; offset?: number }
  wheel_put_secret: NodeRef & { key: string; value: string }
  wheel_apply_board: ProjectInput & { board: unknown; dryRun?: boolean }
  wheel_import_tool: ProjectInput & { raw: string; format?: ImportToolFormat }
  wheel_call_tool: NodeRef & { op: string; args: unknown; dryRun?: boolean }
  wheel_messages: ProjectInput
  wheel_chest_ls: NodeRef & { prefix?: string }
  wheel_open_project: ProjectInput & { scale?: number; offsetX?: number; offsetY?: number }
  wheel_poll_messages: ProjectInput & { since?: number }
}

type ToolName = keyof ToolInputs
type ToolHandlers = { [K in ToolName]: (api: WheelApi, input: ToolInputs[K]) => unknown }
type CallLogEntry = { toolName: string; ok: boolean; detail: string; time: Date }
type PaneMovedPayload = { paneId: string; x: number; y: number }
type PaneClosePayload = { paneId: string }
type WorkerCompletePayload = { paneId: string; response?: string; error?: unknown }
type WorkerStatusPayload = { paneId: string; status?: string }

const TOOL_HANDLERS: ToolHandlers = {
  wheel_list_projects: (api) => api.listProjects(),
  wheel_get_project: (api, { projectId }) => api.getProject(projectId),
  wheel_create_project: (api, { name }) => api.createProject(name),
  wheel_start_project: (api, { projectId }) => api.startProject(projectId),
  wheel_stop_project: (api, { projectId }) => api.stopProject(projectId),
  wheel_get_board: (api, { projectId }) => api.getBoard(projectId),
  wheel_create_node: (api, { projectId, name, type, position, config }) =>
    api.createNode(projectId, { name, type, position, config: config || defaultNodeConfig(type) || {} }),
  wheel_patch_node: (api, { projectId, nodeId, name, position, config }) => {
    const patch: NodePatch = {}

    if (name !== undefined) patch.name = name
    if (position !== undefined) patch.position = position
    if (config !== undefined) patch.config = config

    return api.patchNode(projectId, nodeId, patch)
  },
  wheel_delete_node: (api, { projectId, nodeId }) => api.deleteNode(projectId, nodeId),
  wheel_create_wire: (api, { projectId, from, to, type }) => api.createWire(projectId, from, to, type),
  wheel_delete_wire: (api, { projectId, from, to, type }) => api.deleteWire(projectId, from, to, type),
  wheel_start_agent: (api, { projectId, nodeId }) => api.startAgent(projectId, nodeId),
  wheel_stop_agent: (api, { projectId, nodeId }) => api.stopAgent(projectId, nodeId),
  wheel_send_to_agent: (api, { projectId, nodeId, body }) => api.sendToAgent(projectId, nodeId, body),
  wheel_agent_log: (api, { projectId, nodeId, since, stream }) => api.agentLog(projectId, nodeId, { since, stream }),
  wheel_query_table: (api, { projectId, nodeId, sql }) => api.queryTable(projectId, nodeId, sql),
  wheel_table_rows: (api, { projectId, nodeId, limit, offset }) => api.tableRows(projectId, nodeId, limit, offset),
  wheel_put_secret: (api, { projectId, nodeId, key, value }) => api.putSecret(projectId, nodeId, key, value),
  wheel_apply_board: (api, { projectId, board, dryRun }) => api.applyBoard(projectId, board, dryRun || false),
  wheel_import_tool: (api, { projectId, raw, format }) => api.importTool(projectId, raw, format),
  wheel_call_tool: (api, { projectId, nodeId, op, args, dryRun }) => api.callTool(projectId, nodeId, op, args, dryRun || false),
  wheel_messages: (api, { projectId }) => api.messages(projectId),
  wheel_chest_ls: (api, { projectId, nodeId, prefix }) => api.chestLs(projectId, nodeId, prefix),
  wheel_open_project: (api, { projectId, scale, offsetX, offsetY }) => openProjectOnCanvas(api, projectId, scale, offsetX, offsetY),
  wheel_poll_messages: async (api, { projectId, since }) => {
    const response = await api.messages(projectId)
    const all = Array.isArray(response) ? response : (response.messages || [])
    const cursor = since || 0
    const fresh = all.filter(m => (m.seq || m.id || 0) > cursor)
    const nextCursor = fresh.length > 0 ? Math.max(...fresh.map(m => m.seq || m.id || 0)) : cursor

    return { messages: fresh, cursor: nextCursor }
  },
}

const NOT_CONFIGURED_MESSAGE = 'Wheel API not configured. Open the Wheel pane and enter your API URL and token.'
const NODE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/
const SPAWN_COMMAND_PREFIX = 'wheel.spawn.'
const MAX_LOG = 50
const MAX_GENERATED_NAME_INDEX = 100

const $setup = byId('setup')
const $status = byId('status')
const $dot = byId('dot')
const $statusLabel = byId('status-label')
const $apiUrlDisplay = byId('api-url-display')
const $projectCount = byId('project-count')
const $setupError = byId('setup-error')
const $inputUrl = byId<HTMLInputElement>('input-url')
const $inputEmail = byId<HTMLInputElement>('input-email')
const $inputPassword = byId<HTMLInputElement>('input-password')
const $inputToken = byId<HTMLInputElement>('input-token')
const $tokenSection = byId('token-section')
const $projectsSection = byId('projects-section')
const $projectList = byId('project-list')
const $syncStatus = byId('sync-status')
const $syncDot = byId('sync-dot')
const $syncLabel = byId('sync-label')
const $syncDetail = byId('sync-detail')
const $callLog = byId('call-log')
const $btnSignin = byId<HTMLButtonElement>('btn-signin')

const callHistory: CallLogEntry[] = []

let panel!: PanelClient
let api: WheelApi | null = null
let boardSync!: BoardSync
let eventSource: WheelEventSource | null = null

start()

async function start(): Promise<void> {
  panel = await createPanel()
  boardSync = new BoardSync(panel)

  listenForTools()
  listenForCanvasEvents()
  $btnSignin.addEventListener('click', signIn)
  byId('btn-toggle-token').addEventListener('click', () => { $tokenSection.hidden = !$tokenSection.hidden })
  byId('btn-save-token').addEventListener('click', saveToken)
  byId('btn-configure').addEventListener('click', () => showSetup(api?.apiUrl || ''))

  const restored = await boardSync.restoreState()

  try {
    const [url, token] = await Promise.all([panel.secrets.get('apiUrl'), panel.secrets.get('apiToken')])

    if (!url || !token) {
      showSetup(url || DEFAULT_API_URL)
      return
    }

    api = new WheelApi(url, token)
    await showStatus(api)

    const restoredProjectId = boardSync.activeProjectId

    if (restored && restoredProjectId) {
      subscribeToCanvasEvents()
      connectEventStream(api, restoredProjectId)
      updateSyncStatus()
    }
  } catch {
    showSetup('')
  }
}

function listenForTools(): void {
  for (const toolName of Object.keys(TOOL_HANDLERS) as ToolName[]) {
    panel.tools.onInvoke(toolName, (input) => runTool(toolName, input))
  }

  panel.events.on('tool', ({ callId, toolName }) => {
    if (toolName in TOOL_HANDLERS) return

    panel.tools.settle(callId, { error: `Unknown tool: ${toolName}` })
    logCall(toolName, false, 'unknown tool')
  })
}

async function runTool(toolName: ToolName, input: Record<string, unknown>): Promise<unknown> {
  if (!api) {
    logCall(toolName, false, 'not configured')
    throw new Error(NOT_CONFIGURED_MESSAGE)
  }

  const handler = TOOL_HANDLERS[toolName] as (api: WheelApi, input: Record<string, unknown>) => unknown

  try {
    const result = await handler(api, input || {})

    logCall(toolName, true, '')

    return result
  } catch (err) {
    logCall(toolName, false, errorMessage(err))
    throw err
  }
}

async function openProjectOnCanvas(wheelApi: WheelApi, projectId: string, scale?: number, offsetX?: number, offsetY?: number) {
  eventSource?.disconnect()
  eventSource = null
  boardSync.stopAllLogPolling()

  const result = await boardSync.openProject(wheelApi, projectId, scale || 120, offsetX || 100, offsetY || 100)

  subscribeToCanvasEvents()
  connectEventStream(wheelApi, projectId)
  startAgentLogPollers(wheelApi)
  updateSyncStatus()

  return { ...result, projectId, syncing: true }
}

function startAgentLogPollers(wheelApi: WheelApi): void {
  for (const nodeId of boardSync.agentNodeIds()) {
    boardSync.startAgentLogPolling(wheelApi, nodeId)
  }

  boardSync.onAgentLog = (nodeId, _paneId, entries) => {
    logCall(`agent-log:${nodeId}`, true, `${entries.length} entries`)
  }

  boardSync.onAgentStatusChange = (nodeId, _paneId, status) => {
    logCall(`agent-status:${nodeId}`, true, status)
  }
}

function connectEventStream(wheelApi: WheelApi, projectId: string): void {
  eventSource = new WheelEventSource(wheelApi, projectId, {
    onConnectionChange: (status) => {
      updateSyncConnection(status)

      if (status === 'connected' && boardSync.activeProjectId) {
        reconcileOnReconnect(wheelApi)
      }
    },
    onNodeState: (payload) => boardSync.handleNodeState(payload),
    onBoardChanged: (payload) => boardSync.handleBoardChanged(payload),
    onLagged: () => boardSync.handleLagged(wheelApi),
    onPeers: (payload) => {
      const count = payload.count ?? payload.peers?.length ?? 0

      boardSync.handlePeerCount(count)
      updatePeerCount(count)
    },
    onMessage: (payload) => {
      if (boardSync.activeProjectId && payload.node_id && boardSync.nodeToPane.has(payload.node_id)) {
        logCall(`ws:message:${payload.node_id}`, true, '')
      }
    },
    onLog: (payload) => {
      const entry = payload.node_id ? boardSync.nodeToPane.get(payload.node_id) : undefined

      if (payload.node_id && entry) {
        boardSync.onAgentLog?.(payload.node_id, entry.paneId, [payload])
      }
    },
    onWireDenied: (payload) => {
      logCall('ws:wire-denied', false, `${payload.from} → ${payload.to} (${payload.type})`)
    },
  })

  eventSource.connect()
}

async function reconcileOnReconnect(wheelApi: WheelApi): Promise<void> {
  const projectId = boardSync.activeProjectId

  if (!projectId) return

  try {
    await boardSync.reconcileBoard(await wheelApi.getBoard(projectId))
    updateSyncStatus()
  } catch {
    return
  }
}

function subscribeToCanvasEvents(): void {
  panel.rpc.request('canvas.subscribe', {
    events: ['canvas.paneMoved', 'canvas.paneClose', 'canvas.workerComplete', 'canvas.workerStatusChange'],
  }).catch(() => {})
}

function listenForCanvasEvents(): void {
  panel.rpc.on('canvas.paneMoved', (payload) => {
    const { paneId, x, y } = payload as PaneMovedPayload
    const move = boardSync.handlePaneMoved(paneId, x, y)
    const projectId = boardSync.activeProjectId

    if (move && projectId && api) {
      api.patchNode(projectId, move.nodeId, { position: move.position }).catch(() => {})
    }
  })

  panel.rpc.on('canvas.paneClose', (payload) => {
    const closed = boardSync.handlePaneClose((payload as PaneClosePayload).paneId)
    const projectId = boardSync.activeProjectId

    if (closed && projectId && api) {
      boardSync.stopAgentLogPolling(closed.nodeId)
      api.deleteNode(projectId, closed.nodeId).catch(() => {})
      updateSyncStatus()
    }
  })

  panel.rpc.on('canvas.workerComplete', (payload) => {
    const { paneId, response, error } = payload as WorkerCompletePayload
    const relay = response ? boardSync.handleWorkerComplete(paneId, response) : null
    const projectId = boardSync.activeProjectId

    if (relay && projectId && api && !error) {
      api.sendToAgent(projectId, relay.nodeId, relay.response).catch(() => {})
    }
  })

  panel.rpc.on('canvas.workerStatusChange', (payload) => {
    const { paneId, status } = payload as WorkerStatusPayload
    const entry = boardSync.paneToNode.get(paneId)
    const projectId = boardSync.activeProjectId

    if (entry?.nodeType === 'agent' && projectId && api && status === 'running') {
      api.startAgent(projectId, entry.nodeId).catch(() => {})
    }
  })

  panel.events.on('command', ({ commandId }) => {
    if (commandId === 'wheel.addNode') {
      showNodeCreationDialog()
    }

    if (commandId?.startsWith(SPAWN_COMMAND_PREFIX)) {
      handleSpawnCommand(commandId)
    }
  })
}

function showNodeCreationDialog(): void {
  if (!boardSync.activeProjectId || !api) return

  const wheelApi = api

  document.getElementById('node-dialog')?.remove()

  const dialog = document.createElement('div')
  const box = document.createElement('div')
  const heading = document.createElement('h3')
  const nameLabel = document.createElement('label')
  const nameInput = document.createElement('input')
  const typeLabel = document.createElement('label')
  const typeSelect = document.createElement('select')
  const actions = document.createElement('div')
  const cancelBtn = document.createElement('button')
  const createBtn = document.createElement('button')
  const errorEl = document.createElement('p')
  const showError = (message: string) => {
    errorEl.textContent = message
    errorEl.hidden = false
  }

  dialog.id = 'node-dialog'
  dialog.className = 'dialog-overlay'
  box.className = 'dialog'
  heading.textContent = 'Add Wheel Node'

  nameLabel.textContent = 'Name'
  nameInput.id = 'node-name'
  nameInput.type = 'text'
  nameInput.placeholder = 'my-node'
  nameLabel.appendChild(nameInput)

  typeLabel.textContent = 'Type'
  typeSelect.id = 'node-type'
  for (const nodeType of NODE_TYPES) {
    const option = document.createElement('option')

    option.value = nodeType
    option.textContent = nodeType.charAt(0).toUpperCase() + nodeType.slice(1)
    typeSelect.appendChild(option)
  }
  typeLabel.appendChild(typeSelect)

  actions.className = 'dialog-actions'
  cancelBtn.className = 'link'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.addEventListener('click', () => dialog.remove())
  createBtn.textContent = 'Create'
  errorEl.className = 'error'
  errorEl.hidden = true

  createBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim()
    const type = typeSelect.value

    if (!name) {
      showError('Name is required')
      return
    }

    if (!NODE_NAME_PATTERN.test(name)) {
      showError('Name must be lowercase alphanumeric with dashes/underscores')
      return
    }

    if (!isNodeType(type)) return

    try {
      await boardSync.createNode(wheelApi, name, type)
      dialog.remove()
    } catch (err) {
      showError(errorMessage(err))
    }
  })

  actions.appendChild(cancelBtn)
  actions.appendChild(createBtn)
  box.appendChild(heading)
  box.appendChild(nameLabel)
  box.appendChild(typeLabel)
  box.appendChild(actions)
  box.appendChild(errorEl)
  dialog.appendChild(box)
  document.body.appendChild(dialog)
}

async function handleSpawnCommand(commandId: string): Promise<void> {
  const nodeType = commandId.replace(SPAWN_COMMAND_PREFIX, '')

  if (!isNodeType(nodeType)) return

  const projectId = boardSync.activeProjectId

  if (!projectId || !api) {
    logCall(commandId, false, 'no project open')
    return
  }

  try {
    const name = generateNodeName(nodeType)
    const paneKind = nodeType === 'agent' ? 'worker' : 'note'
    const node = await api.createNode(projectId, {
      name,
      type: nodeType,
      position: { x: 0, y: 0 },
      config: defaultNodeConfig(nodeType),
    })
    const { paneId } = await panel.canvas.spawn({
      kind: paneKind,
      title: name,
      extensionId: WHEEL_EXTENSION_ID,
      surfaceId: 'wheel-node',
    })

    if (paneId && node?.id) {
      boardSync.nodeToPane.set(node.id, { paneId, type: paneKind })
      boardSync.paneToNode.set(paneId, { nodeId: node.id, nodeType })
      boardSync.nodesById[node.id] = node
      boardSync.persistState()
      updateSyncStatus()
    }

    logCall(commandId, true, name)
  } catch (err) {
    logCall(commandId, false, errorMessage(err))
  }
}

function generateNodeName(nodeType: NodeType): string {
  const existingNames = new Set<string>()

  for (const entry of boardSync.paneToNode.values()) {
    const name = boardSync.nodesById[entry.nodeId]?.name

    if (name) existingNames.add(name)
  }

  for (let i = 1; i <= MAX_GENERATED_NAME_INDEX; i++) {
    const candidate = `${nodeType}-${i}`

    if (!existingNames.has(candidate)) return candidate
  }

  return `${nodeType}-${Date.now()}`
}

function logCall(toolName: string, ok: boolean, detail: string): void {
  callHistory.unshift({ toolName, ok, detail, time: new Date() })
  if (callHistory.length > MAX_LOG) callHistory.length = MAX_LOG
  renderLog()
}

function renderLog(): void {
  $callLog.textContent = ''

  for (const entry of callHistory) {
    const li = document.createElement('li')
    const timeSpan = document.createElement('span')
    const nameSpan = document.createElement('span')
    const statusSpan = document.createElement('span')
    const resultSpan = document.createElement('span')

    timeSpan.textContent = entry.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' '
    nameSpan.className = 'tool-name'
    nameSpan.textContent = entry.toolName
    statusSpan.textContent = ' '
    resultSpan.className = entry.ok ? 'ok' : 'fail'
    resultSpan.textContent = entry.ok ? 'ok' : entry.detail

    li.appendChild(timeSpan)
    li.appendChild(nameSpan)
    li.appendChild(statusSpan)
    li.appendChild(resultSpan)
    $callLog.appendChild(li)
  }
}

function showSetup(url: string): void {
  $setup.hidden = false
  $status.hidden = true
  $inputUrl.value = url
  $inputEmail.value = ''
  $inputPassword.value = ''
  $inputToken.value = ''
  $tokenSection.hidden = true
  $setupError.hidden = true
}

async function showStatus(wheelApi: WheelApi): Promise<void> {
  $setup.hidden = true
  $status.hidden = false
  $apiUrlDisplay.textContent = wheelApi.apiUrl
  $dot.className = 'dot'
  $statusLabel.textContent = 'Checking...'
  $projectCount.textContent = ''

  try {
    const projects = await wheelApi.listProjects()

    $dot.className = 'dot ok'
    $statusLabel.textContent = 'Connected'
    $projectCount.textContent = `${projects.length} project${projects.length === 1 ? '' : 's'}`
    renderProjectList(wheelApi, projects)
  } catch (err) {
    $dot.className = 'dot err'
    $statusLabel.textContent = 'Error'
    $projectCount.textContent = errorMessage(err)
    $projectsSection.hidden = true
  }
}

function renderProjectList(wheelApi: WheelApi, projects: Array<{ id: string; name?: string }>): void {
  $projectsSection.hidden = false
  $projectList.textContent = ''

  for (const project of projects) {
    const li = document.createElement('li')
    const nameSpan = document.createElement('span')
    const openBtn = document.createElement('button')

    li.className = 'project-item'
    nameSpan.className = 'project-name'
    nameSpan.textContent = project.name || project.id
    openBtn.className = 'btn-small'
    openBtn.textContent = 'Open on Canvas'
    openBtn.addEventListener('click', () => handleOpenProject(wheelApi, project.id))

    li.appendChild(nameSpan)
    li.appendChild(openBtn)
    $projectList.appendChild(li)
  }
}

async function handleOpenProject(wheelApi: WheelApi, projectId: string): Promise<void> {
  try {
    showSyncOpening()
    await openProjectOnCanvas(wheelApi, projectId)
  } catch (err) {
    showSyncError(errorMessage(err))
  }
}

function showSyncOpening(): void {
  $syncStatus.hidden = false
  $syncDot.className = 'dot'
  $syncLabel.textContent = 'Opening board...'
  $syncDetail.textContent = ''
}

function showSyncError(detail: string): void {
  $syncStatus.hidden = false
  $syncDot.className = 'dot err'
  $syncLabel.textContent = 'Sync error'
  $syncDetail.textContent = detail
}

function updateSyncStatus(): void {
  if (!boardSync.activeProjectId) {
    $syncStatus.hidden = true
    return
  }

  $syncStatus.hidden = false
  $syncDot.className = 'dot ok'
  $syncLabel.textContent = 'Synced'
  $syncDetail.textContent = describeNodeCount(boardSync.mappedNodeCount)
}

function updateSyncConnection(wsStatus: ConnectionStatus): void {
  if ($syncStatus.hidden) return

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

function updatePeerCount(count: number): void {
  const peerText = count > 0 ? ` · ${count} peer${count === 1 ? '' : 's'}` : ''

  $syncDetail.textContent = describeNodeCount(boardSync.mappedNodeCount || 0) + peerText
}

function describeNodeCount(nodeCount: number): string {
  return `${nodeCount} node${nodeCount === 1 ? '' : 's'} on canvas`
}

function validateUrl(): string | null {
  const url = $inputUrl.value.trim() || DEFAULT_API_URL

  try {
    new URL(url)
  } catch {
    showSetupError('Invalid URL')
    return null
  }

  $setupError.hidden = true

  return url
}

async function signIn(): Promise<void> {
  const url = validateUrl()

  if (!url) return

  const email = $inputEmail.value.trim()
  const password = $inputPassword.value

  if (!email || !password) {
    showSetupError('Email and password are required')
    return
  }

  $btnSignin.disabled = true
  $btnSignin.textContent = 'Signing in...'
  $setupError.hidden = true

  try {
    const unauthenticatedApi = new WheelApi(url, '')
    const session = await unauthenticatedApi.login(email, password)
    const created = await unauthenticatedApi.createToken(session.token, 'AgentGrid')

    await panel.secrets.set('apiUrl', url)
    await panel.secrets.set('apiToken', created.token)
    api = new WheelApi(url, created.token)
    await showStatus(api)
  } catch (err) {
    showSetupError(errorMessage(err))
  } finally {
    $btnSignin.disabled = false
    $btnSignin.textContent = 'Sign in'
  }
}

async function saveToken(): Promise<void> {
  const url = validateUrl()

  if (!url) return

  const token = $inputToken.value.trim()

  try {
    await panel.secrets.set('apiUrl', url)
    if (token) await panel.secrets.set('apiToken', token)
    api = new WheelApi(url, token)
    await showStatus(api)
  } catch (err) {
    showSetupError(errorMessage(err))
  }
}

function showSetupError(message: string): void {
  $setupError.textContent = message
  $setupError.hidden = false
}
