import { createPanel } from '@agentgrid/sdk'
import type { PanelClient, WireDragEndedPayload, WireDragSpawnRequestPayload } from '@agentgrid/sdk'
import { associatePanesByWires, readBoardState, writeBoardState } from './board-state'
import { byId, setSaveStatus } from './dom'
import { DEFAULT_API_URL, WHEEL_EXTENSION_ID, errorMessage, isNodeType, surfaceIdFor } from './types'
import type { NodeConfig, NodeType, PaneEntry, WireKind, WireSummary } from './types'
import { WheelApi } from './wheel-api'
import type { TableColumnRef, TableData } from './wheel-api'
import { wheelOutputTypes, wheelInputTypes, wheelTargetTypes, wheelWireAllowed, wheelWireTypes } from './wire-matrix'

type NodeView = {
  id: string
  type: NodeType
  name: string
  config: NodeConfig
  wires: WireSummary[]
  uncommitted?: boolean
}

type BoardEntry = PaneEntry & { projectId: string | null }
type SelectOption = { value: string; label: string }
type AgentAction = 'start' | 'restart' | 'clear'

const HARNESS_OPTIONS: SelectOption[] = [
  { value: '', label: '(default)' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'grok', label: 'Grok' },
  { value: 'devin', label: 'Devin' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'antigravity', label: 'Antigravity' },
]

const NODE_TYPE_LABELS: Record<NodeType, string> = {
  agent: 'Agent',
  ctx: 'Context',
  table: 'Table',
  endpoint: 'Endpoint',
  script: 'Script',
  mcp: 'MCP Server',
  vault: 'Vault',
  chest: 'Chest',
  tool: 'Tool',
}

const SURFACE_TO_NODE_TYPE: Record<string, NodeType> = {
  'wheel-agent': 'agent',
  'wheel-ctx': 'ctx',
  'wheel-table': 'table',
  'wheel-endpoint': 'endpoint',
  'wheel-script': 'script',
  'wheel-mcp': 'mcp',
  'wheel-vault': 'vault',
  'wheel-chest': 'chest',
  'wheel-tool': 'tool',
}

const BOARD_ENTRY_TIMEOUT_MS = 15000
const BOARD_ENTRY_POLL_MS = 150
const BOARD_ENTRY_VERBOSE_ATTEMPTS = 3
const AGENT_LOG_POLL_MS = 3000
const AGENT_STATUS_POLL_MS = 10000
const SAVED_STATUS_CLEAR_MS = 2000
const WIRE_PICKER_DISMISS_DELAY_MS = 50
const SPAWN_GRID_SCALE = 300
const SPAWN_GRID_OFFSET = 100

const $card = byId('node-card')
const $loading = byId('loading')

let panel!: PanelClient
let paneApi: WheelApi | null = null
let nodeData: NodeView | null = null
let activeProjectId: string | null = null
let myPaneId: string | null = null
let myNodeType: NodeType | null = null
let agentLogCursor = 0
let agentLogTimer: ReturnType<typeof setInterval> | null = null
let statusPollTimer: ReturnType<typeof setInterval> | null = null

start()

async function start(): Promise<void> {
  console.log('[wheel:node-pane] initNodePane starting')

  try {
    panel = await createPanel()
    listenForCanvasEvents()
    await initNodePane()
  } catch (err) {
    console.error('[wheel:node-pane] initNodePane error:', err)
    showLoadError(errorMessage(err))
  }
}

async function initNodePane(): Promise<void> {
  const [apiUrl, apiToken] = await Promise.all([panel.secrets.get('apiUrl'), panel.secrets.get('apiToken')])
  const { paneId, surfaceId } = panel.description
  const autoCreatableType = SURFACE_TO_NODE_TYPE[surfaceId]

  myPaneId = paneId
  console.log('[wheel:node-pane] desc:', JSON.stringify(panel.description))

  if (!paneId) {
    $loading.textContent = 'No pane identity.'
    return
  }

  if (apiToken) {
    paneApi = new WheelApi(apiUrl || DEFAULT_API_URL, apiToken)
  }

  console.log('[wheel:node-pane] calling waitForBoardEntry, paneId:', paneId)
  let entry = await waitForBoardEntry(paneId)
  console.log('[wheel:node-pane] waitForBoardEntry returned:', entry ? JSON.stringify({ nodeId: entry.nodeId, nodeType: entry.nodeType, projectId: entry.projectId }) : 'null')

  if (!entry && autoCreatableType) {
    const isUserSpawned = await checkUserSpawned()

    console.log('[wheel:node-pane] no entry, isUserSpawned:', isUserSpawned)

    if (isUserSpawned) {
      entry = await autoCreateNode(paneId, autoCreatableType)
      console.log('[wheel:node-pane] autoCreateNode returned:', entry ? 'ok' : 'null')
    }
  }

  if (!entry && autoCreatableType) {
    console.log('[wheel:node-pane] FAIL: no entry after all attempts, paneApi:', !!paneApi)
    $loading.textContent = paneApi ? 'Failed to create node on Wheel.' : 'Configure Wheel API in extension settings.'
    return
  }

  if (!entry) {
    $loading.textContent = paneApi ? 'Node not found.' : 'Configure Wheel API in extension settings.'
    return
  }

  activeProjectId = entry.projectId
  myNodeType = entry.nodeType
  nodeData = {
    id: entry.nodeId,
    type: entry.nodeType,
    name: entry.nodeName,
    config: entry.nodeConfig || {},
    wires: entry.wires || [],
  }

  if (entry.nodeName) {
    panel.canvas.update({ paneId, customTitle: entry.nodeName }).catch(() => {})
  }

  renderNode(nodeData)
  renderSockets(entry.nodeType)

  if (paneApi && entry.projectId && entry.nodeType === 'agent') {
    pollAgentStatus(entry.projectId, entry.nodeId)
  }
}

function showLoadError(message: string): void {
  const looksLikeNetworkFailure = message.includes('fetch') || message.includes('network') || message.includes('Failed')

  $loading.textContent = looksLikeNetworkFailure ? 'Connection error. Configure Wheel API in extension settings.' : message
}

async function checkUserSpawned(): Promise<boolean> {
  const board = await readBoardState(panel.secrets).catch(() => null)

  if (!board) {
    console.log('[wheel:node-pane] checkUserSpawned: no boardState → true')
    return true
  }

  console.log('[wheel:node-pane] checkUserSpawned: projectId:', board.projectId, 'spawning:', board.spawning, 'paneToNode keys:', Object.keys(board.paneToNode))

  return !board.projectId || !board.spawning
}

async function autoCreateNode(paneId: string, nodeType: NodeType): Promise<BoardEntry | null> {
  if (!paneApi) return null

  const board = await readBoardState(panel.secrets).catch(() => null)

  if (!board?.projectId) return null

  const name = nextAvailableName(nodeType, Object.values(board.paneToNode).map(e => e.nodeName))
  const node = await paneApi.createNode(board.projectId, {
    name, type: nodeType, position: { x: 0, y: 0 }, config: {},
  }).catch((err: unknown) => {
    console.error('[wheel:node-pane] autoCreateNode API failed:', err)
    return null
  })

  if (!node?.id) return null

  const entry: PaneEntry = {
    nodeId: node.id,
    nodeType,
    nodeName: node.name || name,
    nodeConfig: node.config || {},
    wires: [],
  }

  board.paneToNode[paneId] = entry
  board.nodesById[node.id] = node

  await writeBoardState(panel.secrets, board)
  await panel.canvas.update({ paneId, customTitle: entry.nodeName }).catch(() => {})
  console.log('[wheel:node-pane] autoCreateNode created', nodeType, node.id, 'for pane', paneId)

  return { ...entry, projectId: board.projectId }
}

function nextAvailableName(nodeType: NodeType, takenNames: string[]): string {
  const existingNames = new Set(takenNames.filter(Boolean))
  const separator = nodeType === 'table' ? '_' : '-'
  let counter = 1

  while (existingNames.has(`${nodeType}${separator}${counter}`)) counter++

  return `${nodeType}${separator}${counter}`
}

async function waitForBoardEntry(paneId: string): Promise<BoardEntry | null> {
  const deadline = Date.now() + BOARD_ENTRY_TIMEOUT_MS
  let attempt = 0

  while (Date.now() < deadline) {
    attempt++

    const board = await readBoardState(panel.secrets).catch((err: unknown) => {
      console.log('[wheel:node-pane] waitForBoardEntry secrets.get failed attempt', attempt, errorMessage(err))
      return null
    })

    if (!board) {
      if (attempt <= BOARD_ENTRY_VERBOSE_ATTEMPTS) console.log('[wheel:node-pane] waitForBoardEntry attempt', attempt, 'no boardState value')
      await sleep(BOARD_ENTRY_POLL_MS)
      continue
    }

    const entry = board.paneToNode[paneId]
    const closedNodes = board.closedNodes || {}
    const closedKeys = Object.keys(closedNodes)

    if (attempt <= BOARD_ENTRY_VERBOSE_ATTEMPTS || entry) {
      console.log('[wheel:node-pane] waitForBoardEntry attempt', attempt,
        'spawning:', board.spawning,
        'projectId:', board.projectId,
        'myPaneId:', paneId,
        'paneToNode keys:', Object.keys(board.paneToNode),
        'found:', !!entry,
        'closedNodes:', closedKeys)
    }

    if (entry) return { ...entry, projectId: board.projectId }

    const closedNodeId = closedKeys[0]
    const closedEntry = closedNodeId ? closedNodes[closedNodeId] : undefined

    if (!board.spawning && closedNodeId && closedEntry && board.projectId) {
      console.log('[wheel:node-pane] recovering from closedNodes:', closedNodeId, closedEntry.nodeName)

      const recovered: PaneEntry = {
        nodeId: closedNodeId,
        nodeType: closedEntry.nodeType,
        nodeName: closedEntry.nodeName,
        nodeConfig: closedEntry.nodeConfig,
        wires: closedEntry.wires || [],
      }

      board.paneToNode[paneId] = recovered
      delete closedNodes[closedNodeId]
      if (Object.keys(closedNodes).length === 0) delete board.closedNodes

      await writeBoardState(panel.secrets, board)

      return { ...recovered, projectId: board.projectId }
    }

    if (!board.spawning) {
      console.log('[wheel:node-pane] waitForBoardEntry giving up: spawning=false, no entry for', paneId)
      return null
    }

    await sleep(BOARD_ENTRY_POLL_MS)
  }

  console.log('[wheel:node-pane] waitForBoardEntry timed out after', attempt, 'attempts')
  return null
}

function renderNode(node: NodeView): void {
  $card.textContent = ''

  renderHeader(node)

  if (node.type === 'agent') {
    renderAgentStatusRow()
    appendSeparator()
    renderAgentConfig(node)
    appendSeparator()
    renderAgentRuntime()
  }

  if (node.wires.length > 0) {
    appendSeparator()
    renderWires(node)
  }

  if (node.type !== 'agent') {
    renderNonAgentConfig(node)
  }

  if (node.type === 'table') {
    appendSeparator()
    renderTableRuntime()
  } else if (node.type === 'vault') {
    appendSeparator()
    renderVaultRuntime()
  } else if (node.type === 'chest') {
    appendSeparator()
    renderChestRuntime()
  } else if (node.type === 'tool') {
    appendSeparator()
    renderToolRuntime(node)
  }
}

function renderHeader(node: NodeView): void {
  const header = document.createElement('div')
  const badge = document.createElement('span')
  const name = document.createElement('span')

  header.className = 'node-header'
  badge.className = `type-badge ${node.type}`
  badge.textContent = node.type
  name.className = 'node-name'
  name.textContent = node.name
  header.appendChild(badge)
  header.appendChild(name)

  if (node.uncommitted) {
    const tag = document.createElement('span')

    tag.className = 'uncommitted-badge'
    tag.textContent = 'uncommitted'
    header.appendChild(tag)
  }

  $card.appendChild(header)
}

function renderAgentStatusRow(): void {
  const row = document.createElement('div')
  const dot = document.createElement('span')
  const label = document.createElement('span')
  const actions = document.createElement('div')

  row.className = 'status-row'
  row.id = 'status-row'
  dot.className = 'status-dot stopped'
  dot.id = 'status-dot'
  label.id = 'status-label'
  label.textContent = 'Stopped'
  actions.className = 'status-actions'

  actions.appendChild(createButton('Start', 'btn-sm primary', () => agentAction('start')))
  actions.appendChild(createButton('Restart', 'btn-sm', () => agentAction('restart')))
  actions.appendChild(createButton('Clear', 'btn-sm danger', () => agentAction('clear')))

  row.appendChild(dot)
  row.appendChild(label)
  row.appendChild(actions)
  $card.appendChild(row)
}

function renderAgentConfig(node: NodeView): void {
  const cfg = node.config
  const harnessGroup = createFieldGroup('Harness')
  const harnessSelect = document.createElement('select')
  const modelGroup = createFieldGroup('Model')
  const modelInput = document.createElement('input')
  const promptGroup = createFieldGroup('System prompt')
  const promptArea = document.createElement('textarea')
  const saveRow = document.createElement('div')
  const saveStatus = document.createElement('span')
  const saveBtn = createButton('Save', 'btn-sm primary', () => saveAgentConfig())

  harnessSelect.className = 'field-select'
  harnessSelect.id = 'field-harness'
  for (const option of HARNESS_OPTIONS) {
    const element = document.createElement('option')

    element.value = option.value
    element.textContent = option.label
    if (option.value === (cfg.harness || '')) element.selected = true
    harnessSelect.appendChild(element)
  }
  harnessGroup.appendChild(harnessSelect)
  $card.appendChild(harnessGroup)

  modelInput.className = 'field-input'
  modelInput.id = 'field-model'
  modelInput.type = 'text'
  modelInput.value = cfg.model || ''
  modelInput.placeholder = 'Leave empty for harness default'
  modelGroup.appendChild(modelInput)
  modelGroup.appendChild(createFieldHint('Leave empty for the harness default.'))
  $card.appendChild(modelGroup)

  promptArea.className = 'field-textarea'
  promptArea.id = 'field-system-prompt'
  promptArea.rows = 4
  promptArea.value = cfg.system_prompt || ''
  promptArea.placeholder = 'Instructions for this agent...'
  promptGroup.appendChild(promptArea)
  promptGroup.appendChild(createFieldHint('Applied on start and again after every context clear.'))
  $card.appendChild(promptGroup)

  saveRow.className = 'save-row'
  saveStatus.className = 'save-status'
  saveStatus.id = 'save-status'
  saveBtn.id = 'save-btn'
  saveRow.appendChild(saveStatus)
  saveRow.appendChild(saveBtn)
  $card.appendChild(saveRow)

  appendSeparator()

  renderToggle(
    'start-with-project',
    'Start with the project',
    'Comes up automatically whenever the container starts.',
    !!cfg.run_on_startup,
  )

  renderToggle(
    'clear-context',
    'Clear context after each turn',
    'Resets the conversation after each message cycle.',
    !!cfg.ephemeral_context,
  )
}

function renderToggle(id: string, label: string, description: string, checked: boolean): void {
  const row = document.createElement('div')
  const toggle = document.createElement('label')
  const input = document.createElement('input')
  const slider = document.createElement('span')
  const text = document.createElement('div')
  const labelEl = document.createElement('span')
  const desc = document.createElement('span')

  row.className = 'toggle-row'
  toggle.className = 'toggle-switch'
  input.type = 'checkbox'
  input.id = `toggle-${id}`
  input.checked = checked
  input.addEventListener('change', () => saveAgentConfig())
  slider.className = 'toggle-slider'
  text.className = 'toggle-text'
  labelEl.className = 'toggle-label'
  labelEl.textContent = label
  desc.className = 'toggle-desc'
  desc.textContent = description

  toggle.appendChild(input)
  toggle.appendChild(slider)
  text.appendChild(labelEl)
  text.appendChild(desc)
  row.appendChild(toggle)
  row.appendChild(text)
  $card.appendChild(row)
}

function renderWires(node: NodeView): void {
  const wiresRow = document.createElement('div')

  wiresRow.className = 'wires-row'

  for (const wire of node.wires) {
    const wireSpan = document.createElement('span')
    const arrow = wire.direction === 'outgoing' ? ' → ' : ' ← '

    wireSpan.className = `wire-${wire.type}`
    wireSpan.textContent = wire.type

    wiresRow.appendChild(wireSpan)
    wiresRow.appendChild(document.createTextNode(arrow + wire.peerName))
    wiresRow.appendChild(document.createTextNode(' · '))
  }

  $card.appendChild(wiresRow)
}

function renderNonAgentConfig(node: NodeView): void {
  const keys = Object.keys(node.config).filter(key => {
    const value = node.config[key]

    return value !== '' && value !== null && value !== undefined
  })

  if (keys.length === 0) return

  const preview = document.createElement('div')

  preview.className = 'config-preview'
  preview.textContent = keys.join(', ')
  $card.appendChild(preview)
}

function renderAgentRuntime(): void {
  const section = createRuntimeSection('Transcript')
  const log = document.createElement('div')
  const inputRow = document.createElement('div')
  const textarea = document.createElement('textarea')
  const sendBtn = createButton('Send', 'btn-sm primary', () => sendAgentMessage(textarea))

  log.className = 'msg-log'
  log.id = 'agent-log'
  section.appendChild(log)

  inputRow.className = 'msg-input-row'
  textarea.placeholder = 'Send a message...'
  textarea.rows = 1
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendAgentMessage(textarea)
    }
  })
  sendBtn.id = 'agent-send-btn'
  inputRow.appendChild(textarea)
  inputRow.appendChild(sendBtn)

  section.appendChild(inputRow)
  $card.appendChild(section)

  startAgentLogPoll()
}

async function sendAgentMessage(textarea: HTMLTextAreaElement): Promise<void> {
  const body = textarea.value.trim()

  if (!body || !paneApi || !activeProjectId || !nodeData) return

  const sendBtn = document.getElementById('agent-send-btn') as HTMLButtonElement | null

  if (sendBtn) sendBtn.disabled = true
  textarea.disabled = true

  try {
    await paneApi.sendToAgent(activeProjectId, nodeData.id, body)
    textarea.value = ''
    pollAgentLog()
  } catch (err) {
    appendLogEntry('agent-log', errorMessage(err), 'log-stderr')
  } finally {
    textarea.disabled = false
    if (sendBtn) sendBtn.disabled = false
    textarea.focus()
  }
}

function startAgentLogPoll(): void {
  if (agentLogTimer) clearInterval(agentLogTimer)

  agentLogCursor = 0
  pollAgentLog()
  agentLogTimer = setInterval(pollAgentLog, AGENT_LOG_POLL_MS)
}

async function pollAgentLog(): Promise<void> {
  if (!paneApi || !activeProjectId || !nodeData) return

  try {
    const result = await paneApi.agentLog(activeProjectId, nodeData.id, { since: agentLogCursor })
    const entries = Array.isArray(result) ? result : (result?.entries || [])

    if (!document.getElementById('agent-log')) return

    for (const entry of entries) {
      const seq = entry.seq ?? entry.id ?? 0

      if (seq > agentLogCursor) agentLogCursor = seq

      appendLogEntry('agent-log', entry.line || entry.text || JSON.stringify(entry), logEntryClass(entry.stream || ''))
    }
  } catch {
    return
  }
}

function logEntryClass(stream: string): string {
  if (stream === 'stderr') return 'log-entry log-stderr'
  if (stream === 'transcript' || stream === 'stdout') return 'log-entry log-out'

  return 'log-entry log-system'
}

function appendLogEntry(containerId: string, text: string, className: string): void {
  const container = document.getElementById(containerId)

  if (!container) return

  const line = document.createElement('div')

  line.className = className || 'log-entry'
  line.textContent = text
  container.appendChild(line)
  container.scrollTop = container.scrollHeight
}

function renderTableRuntime(): void {
  const section = createRuntimeSection('Data')
  const viewer = document.createElement('div')
  const sqlRow = document.createElement('div')
  const sqlInput = document.createElement('input')
  const errEl = document.createElement('div')

  viewer.className = 'table-viewer'
  viewer.id = 'table-viewer'
  section.appendChild(viewer)

  sqlRow.className = 'sql-row'
  sqlInput.type = 'text'
  sqlInput.placeholder = 'SELECT * FROM ...'
  sqlInput.id = 'sql-input'
  sqlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSqlQuery()
  })
  sqlRow.appendChild(sqlInput)
  sqlRow.appendChild(createButton('Run', 'btn-sm primary', runSqlQuery))
  sqlRow.appendChild(createButton('Rows', 'btn-sm', loadTableRows))
  section.appendChild(sqlRow)

  errEl.className = 'runtime-error'
  errEl.id = 'table-error'
  errEl.hidden = true
  section.appendChild(errEl)

  $card.appendChild(section)
  loadTableRows()
}

async function loadTableRows(): Promise<void> {
  if (!paneApi || !activeProjectId || !nodeData) return

  const api = paneApi
  const projectId = activeProjectId
  const nodeId = nodeData.id

  await showTableResult(() => api.tableRows(projectId, nodeId, 50, 0))
}

async function runSqlQuery(): Promise<void> {
  const sqlInput = document.getElementById('sql-input') as HTMLInputElement | null

  if (!sqlInput || !paneApi || !activeProjectId || !nodeData) return

  const sql = sqlInput.value.trim()

  if (!sql) return

  const api = paneApi
  const projectId = activeProjectId
  const nodeId = nodeData.id

  await showTableResult(() => api.queryTable(projectId, nodeId, sql))
}

async function showTableResult(fetchTable: () => Promise<TableData>): Promise<void> {
  const errEl = document.getElementById('table-error')

  if (errEl) errEl.hidden = true

  try {
    renderTableData(await fetchTable())
  } catch (err) {
    if (errEl) {
      errEl.textContent = errorMessage(err)
      errEl.hidden = false
    }
  }
}

function renderTableData(result: TableData): void {
  const viewer = document.getElementById('table-viewer')

  if (!viewer) return

  viewer.textContent = ''

  const columns = result?.columns || []
  const rows = result?.rows || []

  if (columns.length === 0 && rows.length === 0) {
    const empty = document.createElement('div')

    empty.className = 'empty-table'
    empty.textContent = 'No data.'
    viewer.appendChild(empty)
    return
  }

  const table = document.createElement('table')
  const thead = document.createElement('thead')
  const headerRow = document.createElement('tr')
  const tbody = document.createElement('tbody')

  for (const column of columns) {
    const th = document.createElement('th')

    th.textContent = columnName(column)
    headerRow.appendChild(th)
  }
  thead.appendChild(headerRow)
  table.appendChild(thead)

  for (const row of rows) {
    const tr = document.createElement('tr')
    const values = Array.isArray(row) ? row : columns.map(column => row[columnName(column)])

    for (const value of values) {
      const td = document.createElement('td')
      const text = value === null ? 'NULL' : String(value)

      td.textContent = text
      td.title = text
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  viewer.appendChild(table)
}

function columnName(column: TableColumnRef): string {
  return typeof column === 'string' ? column : (column.name || String(column))
}

function renderVaultRuntime(): void {
  const section = createRuntimeSection('Write Secret')
  const row = document.createElement('div')
  const keyInput = document.createElement('input')
  const valInput = document.createElement('input')
  const status = document.createElement('div')

  row.className = 'vault-row'
  keyInput.type = 'text'
  keyInput.placeholder = 'Key'
  keyInput.id = 'vault-key'
  valInput.type = 'password'
  valInput.placeholder = 'Value'
  valInput.id = 'vault-value'
  row.appendChild(keyInput)
  row.appendChild(valInput)
  row.appendChild(createButton('Save', 'btn-sm primary', saveVaultSecret))
  section.appendChild(row)

  status.id = 'vault-status'
  status.className = 'save-status'
  section.appendChild(status)

  $card.appendChild(section)
}

async function saveVaultSecret(): Promise<void> {
  const keyEl = document.getElementById('vault-key') as HTMLInputElement | null
  const valEl = document.getElementById('vault-value') as HTMLInputElement | null
  const statusEl = document.getElementById('vault-status')

  if (!keyEl || !valEl || !paneApi || !activeProjectId || !nodeData) return

  const key = keyEl.value.trim()

  if (!key) return

  try {
    await paneApi.putSecret(activeProjectId, nodeData.id, key, valEl.value)
    setSaveStatus(statusEl, 'ok', 'Saved')
    keyEl.value = ''
    valEl.value = ''
    setTimeout(() => { if (statusEl) statusEl.textContent = '' }, SAVED_STATUS_CLEAR_MS)
  } catch (err) {
    setSaveStatus(statusEl, 'err', errorMessage(err))
  }
}

function renderChestRuntime(): void {
  const section = document.createElement('div')
  const headerRow = document.createElement('div')
  const label = document.createElement('div')
  const list = document.createElement('ul')

  section.className = 'runtime-section'
  headerRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between;'
  label.className = 'section-label'
  label.textContent = 'Files'
  headerRow.appendChild(label)
  headerRow.appendChild(createButton('↻', 'btn-sm', loadChestFiles))
  section.appendChild(headerRow)

  list.className = 'file-list'
  list.id = 'chest-files'
  section.appendChild(list)

  $card.appendChild(section)
  loadChestFiles()
}

async function loadChestFiles(): Promise<void> {
  if (!paneApi || !activeProjectId || !nodeData) return

  const list = document.getElementById('chest-files')

  if (!list) return

  list.textContent = ''

  try {
    const result = await paneApi.chestLs(activeProjectId, nodeData.id)
    const files = Array.isArray(result) ? result : (result?.files || result?.keys || [])

    for (const file of files) {
      const li = document.createElement('li')

      li.textContent = typeof file === 'string' ? file : (file.key || file.name || JSON.stringify(file))
      list.appendChild(li)
    }
  } catch {
    return
  }
}

function renderToolRuntime(node: NodeView): void {
  const section = createRuntimeSection('Operations')
  const ops = node.config.operations || []

  if (ops.length === 0) {
    const empty = document.createElement('div')

    empty.style.cssText = 'color: #555; font-size: 11px;'
    empty.textContent = 'No operations imported.'
    section.appendChild(empty)
    $card.appendChild(section)
    return
  }

  const list = document.createElement('div')

  list.className = 'op-list'

  for (const op of ops) {
    const item = document.createElement('div')
    const method = document.createElement('span')
    const name = document.createElement('span')

    item.className = 'op-item'
    method.className = `op-method ${(op.method || 'get').toLowerCase()}`
    method.textContent = op.method || 'GET'
    name.textContent = op.operation_id || op.name || op.path || '(unnamed)'
    item.appendChild(method)
    item.appendChild(name)
    list.appendChild(item)
  }

  section.appendChild(list)
  $card.appendChild(section)
}

function createRuntimeSection(labelText: string): HTMLDivElement {
  const section = document.createElement('div')
  const label = document.createElement('div')

  section.className = 'runtime-section'
  label.className = 'section-label'
  label.textContent = labelText
  section.appendChild(label)

  return section
}

function appendSeparator(): void {
  const hr = document.createElement('hr')

  hr.className = 'separator'
  $card.appendChild(hr)
}

function createFieldGroup(labelText: string): HTMLDivElement {
  const group = document.createElement('div')
  const label = document.createElement('div')

  group.className = 'field-group'
  label.className = 'field-label'
  label.textContent = labelText
  group.appendChild(label)

  return group
}

function createFieldHint(text: string): HTMLDivElement {
  const hint = document.createElement('div')

  hint.className = 'field-hint'
  hint.textContent = text

  return hint
}

function createButton(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')

  btn.className = className
  btn.textContent = text
  btn.addEventListener('click', onClick)

  return btn
}

async function agentAction(action: AgentAction): Promise<void> {
  if (!paneApi || !activeProjectId || !nodeData) return

  const api = paneApi
  const projectId = activeProjectId
  const nodeId = nodeData.id

  try {
    if (action === 'start') {
      await api.startAgent(projectId, nodeId)
      updateStatus('running')
    } else if (action === 'restart') {
      await api.stopAgent(projectId, nodeId).catch(() => {})
      await api.startAgent(projectId, nodeId)
      updateStatus('running')
    } else {
      await api.stopAgent(projectId, nodeId).catch(() => {})
      updateStatus('stopped')
    }
  } catch (err) {
    setSaveStatus(document.getElementById('save-status'), 'err', errorMessage(err))
  }
}

async function saveAgentConfig(): Promise<void> {
  if (!paneApi || !activeProjectId || !nodeData) return

  const statusEl = document.getElementById('save-status')
  const saveBtn = document.getElementById('save-btn') as HTMLButtonElement | null
  const config: NodeConfig = {
    ...nodeData.config,
    harness: inputValue('field-harness') || undefined,
    model: inputValue('field-model') || undefined,
    system_prompt: inputValue('field-system-prompt') || undefined,
    run_on_startup: inputChecked('toggle-start-with-project'),
    ephemeral_context: inputChecked('toggle-clear-context'),
  }

  if (saveBtn) saveBtn.disabled = true
  setSaveStatus(statusEl, '', 'Saving...')

  try {
    await paneApi.patchNode(activeProjectId, nodeData.id, { config })
    nodeData.config = config

    setSaveStatus(statusEl, 'ok', 'Saved')
    setTimeout(() => { if (statusEl) statusEl.textContent = '' }, SAVED_STATUS_CLEAR_MS)
  } catch (err) {
    setSaveStatus(statusEl, 'err', errorMessage(err))
  } finally {
    if (saveBtn) saveBtn.disabled = false
  }
}

function inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value || ''
}

function inputChecked(id: string): boolean {
  return (document.getElementById(id) as HTMLInputElement | null)?.checked || false
}

function updateStatus(status: string): void {
  const dot = document.getElementById('status-dot')
  const label = document.getElementById('status-label')

  if (!dot || !label) return

  dot.className = 'status-dot'

  if (status === 'running') {
    dot.classList.add('running')
    label.textContent = 'Running'
  } else if (status === 'idle') {
    dot.classList.add('idle')
    label.textContent = 'Idle'
  } else if (status === 'error' || status === 'rate_limited') {
    dot.classList.add('error')
    label.textContent = status
  } else {
    dot.classList.add('stopped')
    label.textContent = 'Stopped'
  }
}

function pollAgentStatus(projectId: string, nodeId: string): void {
  if (statusPollTimer) clearInterval(statusPollTimer)

  const check = async () => {
    if (!paneApi) return

    try {
      const log = await paneApi.agentLog(projectId, nodeId, { since: 0 })
      const entries = Array.isArray(log) ? log : (log.entries || [])

      if (entries.length > 0) updateStatus('running')
    } catch {
      return
    }
  }

  check()
  statusPollTimer = setInterval(check, AGENT_STATUS_POLL_MS)
}

function listenForCanvasEvents(): void {
  panel.rpc.on('canvas.workerStatusChange', (payload) => {
    const { status } = (payload || {}) as { status?: string }

    if (status) updateStatus(status)
  })

  panel.events.on('canvas.wireDragStarted', ({ fromPaneId, fromNodeType }) => {
    if (fromPaneId !== myPaneId) highlightValidSockets(fromNodeType)
  })

  panel.events.on('canvas.wireDragEnded', (payload) => {
    clearSocketHighlights()
    handleWireDragEnded(payload)
  })

  panel.events.on('canvas.wireDragCancelled', () => {
    clearSocketHighlights()
  })

  panel.events.on('canvas.wireDragSpawnRequest', (payload) => {
    handleWireDragSpawnRequest(payload)
  })
}

function renderSockets(nodeType: NodeType): void {
  document.querySelector('.socket-container')?.remove()

  const container = document.createElement('div')

  container.className = 'socket-container'

  placeSockets(container, wheelOutputTypes(nodeType), 'output', (dot) => {
    dot.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      panel.canvas.startWireDrag({
        nodeId: nodeData?.id || '',
        nodeType,
        side: 'output',
        compatibleTargets: compatibleTargetsForOutput(nodeType),
      })
    })
  })

  placeSockets(container, wheelInputTypes(nodeType), 'input', (dot) => {
    dot.addEventListener('mouseup', (e) => {
      e.preventDefault()
      e.stopPropagation()
      panel.canvas.endWireDrag({ nodeId: nodeData?.id || '', nodeType })
    })
  })

  document.body.appendChild(container)
}

function placeSockets(container: HTMLElement, wireTypes: WireKind[], side: 'input' | 'output', bindDrag: (dot: HTMLDivElement) => void): void {
  const spacing = wireTypes.length > 0 ? 100 / (wireTypes.length + 1) : 0

  wireTypes.forEach((wireType, index) => {
    const dot = document.createElement('div')

    dot.className = `socket-dot ${wireType}`
    dot.dataset.side = side
    dot.dataset.wireType = wireType
    dot.style[side === 'output' ? 'right' : 'left'] = '-5px'
    dot.style.top = `${spacing * (index + 1)}%`
    dot.title = `${wireType} (${side})`
    bindDrag(dot)

    container.appendChild(dot)
  })
}

function compatibleTargetsForOutput(fromNodeType: NodeType): Array<{ nodeType: string; label: string; surfaceId: string }> {
  return [...wheelTargetTypes(fromNodeType)].map(targetType => ({
    nodeType: targetType,
    label: NODE_TYPE_LABELS[targetType] || targetType,
    surfaceId: surfaceIdFor(targetType),
  }))
}

function highlightValidSockets(fromNodeType: string): void {
  for (const socket of document.querySelectorAll<HTMLElement>('.socket-dot[data-side="input"]')) {
    const isValid = myNodeType !== null && wheelWireAllowed(fromNodeType, socket.dataset.wireType || '', myNodeType)

    socket.classList.toggle('valid-target', isValid)
    socket.classList.toggle('dimmed', !isValid)
  }
}

function clearSocketHighlights(): void {
  for (const socket of document.querySelectorAll('.socket-dot')) {
    socket.classList.remove('valid-target', 'dimmed')
  }
}

async function handleWireDragEnded(payload: WireDragEndedPayload): Promise<void> {
  const { fromPaneId, fromNodeId, toNodeId, fromNodeType, toNodeType } = payload
  const isOriginator = myPaneId === fromPaneId

  if (!isOriginator || !paneApi || !activeProjectId) return

  const types = wheelWireTypes(fromNodeType, toNodeType)
  const [firstType] = types

  if (!firstType) return

  if (types.length === 1) {
    await createWireAndSync(fromNodeId, toNodeId, firstType)
    return
  }

  showWireTypePicker(types, (selectedType) => createWireAndSync(fromNodeId, toNodeId, selectedType))
}

async function createWireAndSync(fromNodeId: string, toNodeId: string, wireType: WireKind): Promise<void> {
  if (!paneApi || !activeProjectId) return

  try {
    await paneApi.createWire(activeProjectId, fromNodeId, toNodeId, wireType)
    await syncWireConnections()
  } catch (err) {
    console.error('[wheel:node-pane] createWire failed:', err)
  }
}

async function syncWireConnections(): Promise<void> {
  if (!paneApi || !activeProjectId) return

  try {
    const board = await readBoardState(panel.secrets)

    if (!board) return

    const apiBoard = await paneApi.getBoard(activeProjectId)

    await associatePanesByWires(panel.canvas, board.paneToNode, apiBoard.wires || [])
  } catch {
    return
  }
}

function showWireTypePicker(types: WireKind[], onSelect: (wireType: WireKind) => void): void {
  removeWireTypePicker()

  const picker = document.createElement('div')
  const dismissPicker = (e: MouseEvent) => {
    if (!picker.contains(e.target as Node)) removeWireTypePicker()
  }

  picker.className = 'wire-type-picker'
  picker.id = 'wire-type-picker'
  picker.style.left = '50%'
  picker.style.top = '50%'
  picker.style.transform = 'translate(-50%, -50%)'

  for (const wireType of types) {
    const btn = document.createElement('button')

    btn.className = wireType
    btn.textContent = wireType.charAt(0).toUpperCase() + wireType.slice(1)
    btn.addEventListener('click', () => {
      removeWireTypePicker()
      onSelect(wireType)
    })
    picker.appendChild(btn)
  }

  document.body.appendChild(picker)

  setTimeout(() => {
    document.addEventListener('mousedown', dismissPicker, { once: true })
  }, WIRE_PICKER_DISMISS_DELAY_MS)
}

function removeWireTypePicker(): void {
  document.getElementById('wire-type-picker')?.remove()
}

async function handleWireDragSpawnRequest(payload: WireDragSpawnRequestPayload): Promise<void> {
  const { fromPaneId, fromNodeId, fromNodeType, targetNodeType, targetSurfaceId, x, y } = payload

  if (fromPaneId !== myPaneId || !paneApi || !activeProjectId || !isNodeType(targetNodeType)) return

  try {
    const nodeName = `${targetNodeType}-${Date.now().toString(36).slice(-4)}`
    const gridPos = {
      x: Math.round((x - SPAWN_GRID_OFFSET) / SPAWN_GRID_SCALE * 10) / 10,
      y: Math.round((y - SPAWN_GRID_OFFSET) / SPAWN_GRID_SCALE * 10) / 10,
    }
    const newNode = await paneApi.createNode(activeProjectId, { name: nodeName, type: targetNodeType, position: gridPos })

    if (!newNode?.id) return

    const { paneId } = await panel.canvas.spawn({
      kind: 'note',
      title: newNode.name || nodeName,
      extensionId: WHEEL_EXTENSION_ID,
      surfaceId: targetSurfaceId,
      x,
      y,
    })

    if (!paneId) return

    const board = await readBoardState(panel.secrets).catch(() => null)

    if (!board) return

    board.paneToNode[paneId] = {
      nodeId: newNode.id,
      nodeType: targetNodeType,
      nodeName: newNode.name || nodeName,
      nodeConfig: newNode.config || {},
      wires: [],
    }
    board.nodesById[newNode.id] = newNode

    await writeBoardState(panel.secrets, board)

    const firstWireType = wheelWireTypes(fromNodeType, targetNodeType)[0]

    if (firstWireType) {
      await createWireAndSync(fromNodeId, newNode.id, firstWireType)
    }
  } catch (err) {
    console.error('[wheel:node-pane] wireDragSpawnRequest failed:', err)
  }
}

async function handleSelfRemoved(): Promise<void> {
  if (!nodeData || !myPaneId) return

  try {
    const { paneId } = await panel.canvas.spawn({
      kind: 'note',
      title: nodeData.name,
      extensionId: WHEEL_EXTENSION_ID,
      surfaceId: surfaceIdFor(nodeData.type),
    })

    if (paneId) {
      await migrateBoardEntry(myPaneId, paneId)
    }
  } catch {
    return
  }
}

async function migrateBoardEntry(oldPaneId: string, newPaneId: string): Promise<void> {
  try {
    const board = await readBoardState(panel.secrets)
    const entry = board?.paneToNode[oldPaneId]

    if (!board || !entry) return

    board.paneToNode[newPaneId] = entry
    delete board.paneToNode[oldPaneId]

    await writeBoardState(panel.secrets, board)
  } catch {
    return
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
