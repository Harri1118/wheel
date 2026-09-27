import { createPanel } from '@agentgrid/sdk'
import type { PanelClient } from '@agentgrid/sdk'
import { associatePanesByWires, readBoardState, summarizeWires, writeBoardState } from './board-state'
import { byId, setSaveStatus } from './dom'
import { indexNodes } from './spawn-plan'
import { DEFAULT_API_URL, errorMessage } from './types'
import type { NodeConfig, NodeType, PaneEntry, SharedBoardState, TableColumn, WireKind, WireSummary } from './types'
import { WheelApi } from './wheel-api'
import { wheelTargetTypes, wheelWireTypes } from './wire-matrix'

type SelectOption = { value: string; label: string }

const HARNESS_OPTIONS: SelectOption[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'grok', label: 'Grok' },
  { value: 'devin', label: 'Devin' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'antigravity', label: 'Antigravity' },
]

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE']
const RESPONSE_MODES = ['ack', 'script']
const SCRIPT_LANGUAGES = ['ts', 'js', 'python']
const MCP_TRANSPORTS = ['stdio', 'http']
const COLUMN_TYPES = ['text', 'integer', 'real', 'blob', 'json']
const NO_PROJECT_MESSAGE = 'No Wheel project synced. Open a project from the Wheel Projects panel.'
const LOG_POLL_MS = 5000
const MAX_LOG_LINES = 100
const MAX_LOG_LINE_CHARS = 200
const SAVED_STATUS_CLEAR_MS = 2000

const $empty = byId('inspector-empty')
const $content = byId('inspector-content')

let panel!: PanelClient
let inspectorApi: WheelApi | null = null
let boardState: SharedBoardState | null = null
let logPollTimer: ReturnType<typeof setInterval> | null = null
let logCursor = 0
let currentNodeId: string | null = null

start()

async function start(): Promise<void> {
  try {
    panel = await createPanel()

    const [apiUrl, apiToken] = await Promise.all([panel.secrets.get('apiUrl'), panel.secrets.get('apiToken')])

    if (apiToken) {
      inspectorApi = new WheelApi(apiUrl || DEFAULT_API_URL, apiToken)
    }

    boardState = await readBoardState(panel.secrets)
  } catch {
    boardState = null
  }

  if (!boardState) {
    showEmpty(NO_PROJECT_MESSAGE)
    return
  }

  showEmpty('Project synced. Click a Wheel node on the canvas to inspect.')
  listenForCanvasEvents()
}

function listenForCanvasEvents(): void {
  panel.events.on('canvas.paneFocused', ({ paneId }) => {
    if (!paneId || !boardState) return

    reloadBoardState().then(async () => {
      const entry = boardState?.paneToNode[paneId]

      if (!entry) return

      await refreshEntryWires(entry)
      showNode(entry, paneId)
    })
  })

  panel.events.on('canvas.paneRemoved', ({ paneId }) => {
    if (!paneId) return

    reloadBoardState().then(() => {
      const activeEntries = Object.values(boardState?.paneToNode || {})

      if (activeEntries.length === 0) {
        showEmpty(NO_PROJECT_MESSAGE)
        return
      }

      if (currentNodeId && !activeEntries.some(e => e.nodeId === currentNodeId)) {
        showEmpty('Node removed.')
      }
    })
  })
}

function showEmpty(message: string): void {
  $empty.textContent = message || 'No Wheel node selected.'
  $empty.hidden = false
  $content.hidden = true
  stopLogPolling()
}

function showNode(entry: PaneEntry, paneId: string): void {
  const header = document.createElement('div')
  const badge = document.createElement('span')
  const name = document.createElement('span')

  $empty.hidden = true
  $content.hidden = false
  $content.textContent = ''
  currentNodeId = entry.nodeId

  header.className = 'node-header'
  badge.className = `node-type-badge ${entry.nodeType}`
  badge.textContent = entry.nodeType
  name.className = 'node-name'
  name.textContent = entry.nodeName
  header.appendChild(badge)
  header.appendChild(name)
  $content.appendChild(header)

  renderEditableConfig(entry)
  renderWiresSection(entry, paneId)

  if (entry.nodeType === 'agent') {
    renderAgentLog(entry)
  }
}

function renderEditableConfig(entry: PaneEntry): void {
  const cfg = entry.nodeConfig || {}
  const section = document.createElement('div')
  const saveRow = document.createElement('div')
  const status = document.createElement('span')
  const saveBtn = document.createElement('button')

  section.className = 'section'
  section.id = 'config-section'
  renderFieldsFor(entry.nodeType, section, cfg)

  saveRow.className = 'save-row'
  status.className = 'save-status'
  status.id = 'inspector-save-status'
  saveBtn.className = 'btn-sm primary'
  saveBtn.textContent = 'Save'
  saveBtn.id = 'inspector-save-btn'
  saveBtn.addEventListener('click', () => saveConfig(entry))

  saveRow.appendChild(status)
  saveRow.appendChild(saveBtn)
  section.appendChild(saveRow)
  $content.appendChild(section)
}

function renderFieldsFor(nodeType: NodeType, section: HTMLElement, cfg: NodeConfig): void {
  switch (nodeType) {
    case 'agent':
      appendSelect(section, 'harness', 'Harness', HARNESS_OPTIONS, cfg.harness || 'claude')
      appendInput(section, 'model', 'Model', cfg.model || '', 'Leave empty for harness default')
      appendTextarea(section, 'system_prompt', 'System Prompt', cfg.system_prompt || '', 'Instructions for this agent...')
      appendToggle(section, 'run_on_startup', 'Start with project', !!cfg.run_on_startup)
      appendToggle(section, 'ephemeral_context', 'Clear context after each turn', !!cfg.ephemeral_context)
      break
    case 'ctx':
      appendTextarea(section, 'markdown', 'Content (Markdown)', cfg.markdown || '', 'Context content...')
      break
    case 'table':
      renderTableFields(section, cfg)
      break
    case 'endpoint':
      appendSelect(section, 'method', 'Method', optionsFrom(HTTP_METHODS), (cfg.method || 'POST').toUpperCase())
      appendInput(section, 'path', 'Path', cfg.path || '/', '/path')
      appendSelect(section, 'response_mode', 'Response Mode', optionsFrom(RESPONSE_MODES), cfg.response_mode || 'ack')
      break
    case 'script':
      appendSelect(section, 'language', 'Language', optionsFrom(SCRIPT_LANGUAGES), cfg.language || 'ts')
      appendTextarea(section, 'source', 'Source', typeof cfg.source === 'string' ? cfg.source : '', 'Script source code...')
      break
    case 'mcp':
      renderMcpFields(section, cfg)
      break
    case 'vault':
      renderVaultFields(section, cfg)
      break
    case 'chest':
      break
    case 'tool':
      renderToolFields(section, cfg)
      break
  }
}

function renderTableFields(section: HTMLElement, cfg: NodeConfig): void {
  const columns = cfg.columns || []
  const container = document.createElement('div')

  section.appendChild(createFieldLabel(`Columns (${columns.length})`))

  container.id = 'table-columns'
  container.className = 'columns-list'
  columns.forEach((column, index) => appendColumnRow(container, column, index))
  section.appendChild(container)

  section.appendChild(createSmallButton('+ Column', 'btn-sm', () => {
    appendColumnRow(container, { name: '', type: 'text' }, container.children.length)
  }))
}

function appendColumnRow(container: HTMLElement, column: TableColumn, index: number): void {
  const row = document.createElement('div')
  const nameInput = document.createElement('input')
  const typeSelect = document.createElement('select')

  row.className = 'column-row'

  nameInput.className = 'field-input'
  nameInput.value = column.name || ''
  nameInput.placeholder = 'column name'
  nameInput.dataset.colIndex = String(index)
  nameInput.dataset.colField = 'name'
  row.appendChild(nameInput)

  typeSelect.className = 'field-select'
  typeSelect.dataset.colIndex = String(index)
  typeSelect.dataset.colField = 'type'
  for (const columnType of COLUMN_TYPES) {
    typeSelect.appendChild(createOption({ value: columnType, label: columnType }, column.type || 'text'))
  }
  row.appendChild(typeSelect)

  row.appendChild(createSmallButton('×', 'btn-sm danger', () => row.remove()))
  container.appendChild(row)
}

function renderMcpFields(section: HTMLElement, cfg: NodeConfig): void {
  const transport = cfg.transport || 'stdio'

  appendSelect(section, 'transport', 'Transport', optionsFrom(MCP_TRANSPORTS), transport)

  if (transport === 'stdio') {
    appendInput(section, 'command', 'Command', cfg.command || '', 'e.g. npx -y @modelcontextprotocol/server')
  } else {
    appendInput(section, 'url', 'URL', cfg.url || '', 'https://...')
  }
}

function renderVaultFields(section: HTMLElement, cfg: NodeConfig): void {
  const keys = cfg.keys || []
  const container = document.createElement('div')

  section.appendChild(createFieldLabel(`Secret Keys (${keys.length})`))

  container.id = 'vault-keys'
  for (const key of keys) appendVaultKeyRow(container, key)
  section.appendChild(container)

  section.appendChild(createSmallButton('+ Key', 'btn-sm', () => appendVaultKeyRow(container, '')))
}

function appendVaultKeyRow(container: HTMLElement, key: string): void {
  const row = document.createElement('div')
  const input = document.createElement('input')

  row.className = 'column-row'
  input.className = 'field-input vault-key-input'
  input.value = key
  input.placeholder = 'KEY_NAME'
  row.appendChild(input)
  row.appendChild(createSmallButton('×', 'btn-sm danger', () => row.remove()))
  container.appendChild(row)
}

function renderToolFields(section: HTMLElement, cfg: NodeConfig): void {
  section.appendChild(createFieldLabel('Tool nodes are configured via import. Use the Wheel API tool handler.'))

  if (cfg.base_url) {
    appendInput(section, 'base_url', 'Base URL', cfg.base_url, '')
  }
}

function appendInput(parent: HTMLElement, id: string, label: string, value: string, placeholder: string): void {
  const group = createFieldGroup(label)
  const input = document.createElement('input')

  input.className = 'field-input'
  input.id = `field-${id}`
  input.type = 'text'
  input.value = value
  if (placeholder) input.placeholder = placeholder
  group.appendChild(input)
  parent.appendChild(group)
}

function appendTextarea(parent: HTMLElement, id: string, label: string, value: string, placeholder: string): void {
  const group = createFieldGroup(label)
  const textarea = document.createElement('textarea')

  textarea.className = 'field-textarea'
  textarea.id = `field-${id}`
  textarea.value = value
  textarea.rows = 4
  if (placeholder) textarea.placeholder = placeholder
  group.appendChild(textarea)
  parent.appendChild(group)
}

function appendSelect(parent: HTMLElement, id: string, label: string, options: SelectOption[], selected: string): void {
  const group = createFieldGroup(label)
  const select = document.createElement('select')

  select.className = 'field-select'
  select.id = `field-${id}`
  for (const option of options) select.appendChild(createOption(option, selected))
  group.appendChild(select)
  parent.appendChild(group)
}

function appendToggle(parent: HTMLElement, id: string, label: string, checked: boolean): void {
  const row = document.createElement('div')
  const toggle = document.createElement('label')
  const input = document.createElement('input')
  const slider = document.createElement('span')
  const text = document.createElement('span')

  row.className = 'toggle-row'
  toggle.className = 'toggle-switch'
  input.type = 'checkbox'
  input.id = `field-${id}`
  input.checked = checked
  slider.className = 'toggle-slider'
  text.className = 'toggle-label'
  text.textContent = label

  toggle.appendChild(input)
  toggle.appendChild(slider)
  row.appendChild(toggle)
  row.appendChild(text)
  parent.appendChild(row)
}

function createFieldGroup(label: string): HTMLDivElement {
  const group = document.createElement('div')

  group.className = 'field-group'
  group.appendChild(createFieldLabel(label))

  return group
}

function createFieldLabel(text: string): HTMLDivElement {
  const label = document.createElement('div')

  label.className = 'field-label'
  label.textContent = text

  return label
}

function createOption(option: SelectOption, selected: string): HTMLOptionElement {
  const element = document.createElement('option')

  element.value = option.value
  element.textContent = option.label
  if (option.value === selected) element.selected = true

  return element
}

function createSmallButton(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')

  button.className = className
  button.textContent = text
  button.addEventListener('click', onClick)

  return button
}

function optionsFrom(values: string[]): SelectOption[] {
  return values.map(value => ({ value, label: value }))
}

async function saveConfig(entry: PaneEntry): Promise<void> {
  if (!inspectorApi || !boardState?.projectId) return

  const statusEl = document.getElementById('inspector-save-status')
  const saveBtn = document.getElementById('inspector-save-btn') as HTMLButtonElement | null

  if (saveBtn) saveBtn.disabled = true
  setSaveStatus(statusEl, '', 'Saving...')

  try {
    const config = collectConfig(entry.nodeType)

    await inspectorApi.patchNode(boardState.projectId, entry.nodeId, { config })

    entry.nodeConfig = config
    updateBoardStateEntry(entry)

    setSaveStatus(statusEl, 'ok', 'Saved')
    setTimeout(() => { if (statusEl) statusEl.textContent = '' }, SAVED_STATUS_CLEAR_MS)
  } catch (err) {
    setSaveStatus(statusEl, 'err', errorMessage(err))
  } finally {
    if (saveBtn) saveBtn.disabled = false
  }
}

function collectConfig(nodeType: NodeType): NodeConfig | undefined {
  switch (nodeType) {
    case 'agent':
      return {
        harness: fieldValue('harness') || 'claude',
        system_prompt: fieldValue('system_prompt'),
        model: fieldValue('model') || undefined,
        run_on_startup: fieldChecked('run_on_startup'),
        ephemeral_context: fieldChecked('ephemeral_context'),
      }
    case 'ctx':
      return { markdown: fieldValue('markdown') }
    case 'table':
      return { columns: collectTableColumns() }
    case 'endpoint':
      return {
        method: fieldValue('method') || 'POST',
        path: fieldValue('path') || '/',
        response_mode: fieldValue('response_mode') || 'ack',
      }
    case 'script':
      return {
        language: fieldValue('language') || 'ts',
        source: fieldValue('source') || '// empty',
      }
    case 'mcp':
      return fieldValue('transport') === 'http'
        ? { transport: 'http', url: fieldValue('url') || 'https://example.com' }
        : { transport: 'stdio', command: fieldValue('command') || 'echo' }
    case 'vault':
      return { keys: collectVaultKeys() }
    case 'chest':
      return {}
    case 'tool':
      return undefined
  }
}

function fieldValue(id: string): string {
  return (document.getElementById(`field-${id}`) as HTMLInputElement | null)?.value || ''
}

function fieldChecked(id: string): boolean {
  return (document.getElementById(`field-${id}`) as HTMLInputElement | null)?.checked || false
}

function collectTableColumns(): TableColumn[] {
  const container = document.getElementById('table-columns')
  const columns: TableColumn[] = []

  if (!container) return columns

  for (const row of Array.from(container.children)) {
    const nameInput = row.querySelector('input')
    const typeSelect = row.querySelector('select')

    if (nameInput?.value) {
      columns.push({ name: nameInput.value, type: typeSelect?.value || 'text' })
    }
  }

  return columns
}

function collectVaultKeys(): string[] {
  const container = document.getElementById('vault-keys')
  const keys: string[] = []

  if (!container) return keys

  for (const row of Array.from(container.children)) {
    const input = row.querySelector<HTMLInputElement>('.vault-key-input')

    if (input?.value) keys.push(input.value)
  }

  return keys
}

async function updateBoardStateEntry(entry: PaneEntry): Promise<void> {
  try {
    await reloadBoardState()

    if (!boardState) return

    for (const candidate of Object.values(boardState.paneToNode)) {
      if (candidate.nodeId === entry.nodeId) {
        candidate.nodeConfig = entry.nodeConfig
      }
    }

    await writeBoardState(panel.secrets, boardState)
  } catch {
    return
  }
}

function renderWiresSection(entry: PaneEntry, paneId: string): void {
  const section = document.createElement('div')
  const title = createFieldLabel('Wires')
  const wireList = document.createElement('div')

  section.className = 'section'
  section.id = 'wires-section'
  title.style.marginBottom = '4px'
  section.appendChild(title)

  wireList.id = 'wire-list'

  const wires = entry.wires || []

  if (wires.length === 0) {
    const empty = document.createElement('div')

    empty.className = 'wire-empty'
    empty.textContent = 'No wires.'
    wireList.appendChild(empty)
  }

  for (const wire of wires) {
    wireList.appendChild(createWireRow(entry, wire))
  }

  section.appendChild(wireList)

  const validTargets = wheelTargetTypes(entry.nodeType)
  const peers = Object.values(boardState?.paneToNode || {})
    .filter(e => e.nodeId !== entry.nodeId && validTargets.has(e.nodeType))

  if (peers.length === 0) {
    if (validTargets.size === 0) {
      const hint = document.createElement('div')

      hint.className = 'wire-empty'
      hint.textContent = `${entry.nodeType} nodes have no outgoing wires.`
      section.appendChild(hint)
    }

    $content.appendChild(section)
    return
  }

  section.appendChild(createAddWireRow(entry, paneId, peers))
  $content.appendChild(section)
}

function createWireRow(entry: PaneEntry, wire: WireSummary): HTMLDivElement {
  const row = document.createElement('div')
  const dir = document.createElement('span')
  const wireType = document.createElement('span')
  const peer = document.createElement('span')
  const removeBtn = createSmallButton('×', 'btn-sm danger wire-remove', () => removeWire(entry, wire, row))
  const isOutgoing = wire.direction === 'outgoing'

  row.className = 'wire-item'
  dir.className = 'wire-dir'
  dir.textContent = isOutgoing ? '→ ' : '← '
  wireType.className = `wire-type wire-type-${wire.type}`
  wireType.textContent = wire.type
  peer.className = 'wire-peer'
  peer.textContent = ` ${isOutgoing ? 'to' : 'from'} ${wire.peerName}`

  row.appendChild(dir)
  row.appendChild(wireType)
  row.appendChild(peer)
  row.appendChild(removeBtn)

  return row
}

function createAddWireRow(entry: PaneEntry, paneId: string, peers: PaneEntry[]): HTMLDivElement {
  const addRow = document.createElement('div')
  const peerSelect = document.createElement('select')
  const typeSelect = document.createElement('select')
  const refreshTypeOptions = () => fillWireTypeOptions(typeSelect, entry.nodeType, peerSelect.selectedOptions[0]?.dataset.nodeType)

  addRow.className = 'wire-add-row'

  peerSelect.className = 'field-select wire-peer-select'
  peerSelect.id = 'wire-peer-select'
  peerSelect.appendChild(createOption({ value: '', label: 'Target node...' }, ''))

  for (const peer of peers) {
    const option = createOption({ value: peer.nodeId, label: `${peer.nodeName} (${peer.nodeType})` }, '')

    option.dataset.nodeType = peer.nodeType
    peerSelect.appendChild(option)
  }

  typeSelect.className = 'field-select wire-type-select'
  typeSelect.id = 'wire-type-select'

  peerSelect.addEventListener('change', refreshTypeOptions)
  refreshTypeOptions()

  addRow.appendChild(peerSelect)
  addRow.appendChild(typeSelect)
  addRow.appendChild(createSmallButton('+ Wire', 'btn-sm primary', () => addWire(entry, paneId)))

  return addRow
}

function fillWireTypeOptions(typeSelect: HTMLSelectElement, fromType: NodeType, targetType: string | undefined): void {
  typeSelect.textContent = ''

  if (!targetType) {
    typeSelect.appendChild(createOption({ value: '', label: 'type...' }, ''))
    return
  }

  for (const wireType of wheelWireTypes(fromType, targetType)) {
    typeSelect.appendChild(createOption({ value: wireType, label: wireType }, ''))
  }
}

async function addWire(entry: PaneEntry, paneId: string): Promise<void> {
  if (!inspectorApi || !boardState?.projectId) return

  const peerNodeId = (document.getElementById('wire-peer-select') as HTMLSelectElement | null)?.value
  const wireType = (document.getElementById('wire-type-select') as HTMLSelectElement | null)?.value as WireKind | undefined

  if (!peerNodeId || !wireType) return

  try {
    await inspectorApi.createWire(boardState.projectId, entry.nodeId, peerNodeId, wireType)
    await reloadBoardState()
    await syncAllWireConnections()

    const stillOnBoard = Object.values(boardState?.paneToNode || {}).some(e => e.nodeId === entry.nodeId)

    if (stillOnBoard) {
      await refreshEntryWires(entry)
      showNode({ ...entry, wires: entry.wires }, paneId)
    }
  } catch (err) {
    setSaveStatus(document.getElementById('inspector-save-status'), 'err', errorMessage(err))
  }
}

async function removeWire(entry: PaneEntry, wire: WireSummary, row: HTMLElement): Promise<void> {
  if (!inspectorApi || !boardState?.projectId) return

  const peerNodeId = findNodeIdByName(wire.peerName)

  if (!peerNodeId) return

  const isOutgoing = wire.direction === 'outgoing'
  const fromId = isOutgoing ? entry.nodeId : peerNodeId
  const toId = isOutgoing ? peerNodeId : entry.nodeId

  try {
    await inspectorApi.deleteWire(boardState.projectId, fromId, toId, wire.type)
    row.remove()
    await reloadBoardState()
    await syncAllWireConnections()
  } catch (err) {
    setSaveStatus(document.getElementById('inspector-save-status'), 'err', errorMessage(err))
  }
}

function findNodeIdByName(name: string): string | null {
  return Object.values(boardState?.paneToNode || {}).find(e => e.nodeName === name)?.nodeId ?? null
}

async function refreshEntryWires(entry: PaneEntry): Promise<void> {
  if (!inspectorApi || !boardState?.projectId) return

  try {
    const apiBoard = await inspectorApi.getBoard(boardState.projectId)

    entry.wires = summarizeWires(entry.nodeId, apiBoard.wires || [], indexNodes(apiBoard.nodes || []))
  } catch {
    return
  }
}

async function syncAllWireConnections(): Promise<void> {
  if (!inspectorApi || !boardState?.projectId) return

  try {
    const apiBoard = await inspectorApi.getBoard(boardState.projectId)

    await associatePanesByWires(panel.canvas, boardState.paneToNode, apiBoard.wires || [])
  } catch {
    return
  }
}

function renderAgentLog(entry: PaneEntry): void {
  const section = document.createElement('div')
  const logContainer = document.createElement('div')

  section.className = 'section'
  section.appendChild(createFieldLabel('Agent Log'))

  logContainer.id = 'agent-log'
  logContainer.className = 'agent-log'
  section.appendChild(logContainer)

  $content.appendChild(section)
  startLogPolling(entry.nodeId)
}

function startLogPolling(nodeId: string): void {
  stopLogPolling()

  if (!inspectorApi || !boardState?.projectId) return

  logCursor = 0
  fetchAgentLog(nodeId)
  logPollTimer = setInterval(() => fetchAgentLog(nodeId), LOG_POLL_MS)
}

function stopLogPolling(): void {
  if (!logPollTimer) return

  clearInterval(logPollTimer)
  logPollTimer = null
}

async function fetchAgentLog(nodeId: string): Promise<void> {
  if (!inspectorApi || !boardState?.projectId) return

  try {
    const log = await inspectorApi.agentLog(boardState.projectId, nodeId, { since: logCursor })
    const entries = Array.isArray(log) ? log : (log.entries || [])
    const newest = entries[entries.length - 1]

    if (!newest) return

    logCursor = newest.seq || newest.id || logCursor

    const logContainer = document.getElementById('agent-log')

    if (!logContainer) return

    for (const logEntry of entries) {
      const line = document.createElement('div')
      const text = logEntry.text || logEntry.line || logEntry.body || JSON.stringify(logEntry)

      line.className = 'log-line'
      if ((logEntry.stream || 'stdout') === 'stderr') line.classList.add('log-stderr')
      line.textContent = text.length > MAX_LOG_LINE_CHARS ? text.slice(0, MAX_LOG_LINE_CHARS) + '...' : text
      logContainer.appendChild(line)
    }

    while (logContainer.children.length > MAX_LOG_LINES && logContainer.firstChild) {
      logContainer.removeChild(logContainer.firstChild)
    }

    logContainer.scrollTop = logContainer.scrollHeight
  } catch {
    return
  }
}

async function reloadBoardState(): Promise<void> {
  try {
    const latest = await readBoardState(panel.secrets)

    if (latest) boardState = latest
  } catch {
    return
  }
}
