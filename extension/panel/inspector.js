const ext = window.agentGridExtension
let inspectorReqId = 0
let inspectorApi = null
let logPollTimer = null
let logCursor = 0
let currentNodeId = null
let boardState = null

function inspectorSendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = `insp-${++inspectorReqId}`
    const cleanup = ext.onMessage((msg) => {
      if (msg.kind !== 'response' || msg.id !== id) return
      cleanup()
      if (msg.ok) resolve(msg.result)
      else reject(new Error(msg.error))
    })
    ext.postMessage({ kind: 'request', id, method, params })
  })
}

const $empty = document.getElementById('inspector-empty')
const $content = document.getElementById('inspector-content')

function showEmpty(message) {
  $empty.textContent = message || 'No Wheel node selected.'
  $empty.hidden = false
  $content.hidden = true
  stopLogPolling()
}

function showNode(entry, paneId) {
  $empty.hidden = true
  $content.hidden = false
  $content.textContent = ''

  currentNodeId = entry.nodeId

  const header = document.createElement('div')
  header.className = 'node-header'

  const badge = document.createElement('span')
  badge.className = `node-type-badge ${entry.nodeType}`
  badge.textContent = entry.nodeType
  header.appendChild(badge)

  const name = document.createElement('span')
  name.className = 'node-name'
  name.textContent = entry.nodeName
  header.appendChild(name)

  $content.appendChild(header)

  renderEditableConfig(entry)
  renderWiresSection(entry, paneId)

  if (entry.nodeType === 'agent') {
    renderAgentLog(entry)
  }
}

// ---- Editable config fields per node type ----

const HARNESS_OPTIONS = [
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

function renderEditableConfig(entry) {
  const cfg = entry.nodeConfig || {}
  const section = document.createElement('div')
  section.className = 'section'
  section.id = 'config-section'

  switch (entry.nodeType) {
    case 'agent':
      renderAgentFields(section, cfg)
      break
    case 'ctx':
      renderCtxFields(section, cfg)
      break
    case 'table':
      renderTableFields(section, cfg)
      break
    case 'endpoint':
      renderEndpointFields(section, cfg)
      break
    case 'script':
      renderScriptFields(section, cfg)
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

  const saveRow = document.createElement('div')
  saveRow.className = 'save-row'

  const status = document.createElement('span')
  status.className = 'save-status'
  status.id = 'inspector-save-status'
  saveRow.appendChild(status)

  const saveBtn = document.createElement('button')
  saveBtn.className = 'btn-sm primary'
  saveBtn.textContent = 'Save'
  saveBtn.id = 'inspector-save-btn'
  saveBtn.addEventListener('click', () => saveConfig(entry))
  saveRow.appendChild(saveBtn)

  section.appendChild(saveRow)
  $content.appendChild(section)
}

function renderAgentFields(section, cfg) {
  appendSelect(section, 'harness', 'Harness', HARNESS_OPTIONS, cfg.harness || 'claude')
  appendInput(section, 'model', 'Model', cfg.model || '', 'Leave empty for harness default')
  appendTextarea(section, 'system_prompt', 'System Prompt', cfg.system_prompt || '', 'Instructions for this agent...')
  appendToggle(section, 'run_on_startup', 'Start with project', !!cfg.run_on_startup)
  appendToggle(section, 'ephemeral_context', 'Clear context after each turn', !!cfg.ephemeral_context)
}

function renderCtxFields(section, cfg) {
  appendTextarea(section, 'markdown', 'Content (Markdown)', cfg.markdown || '', 'Context content...')
}

function renderTableFields(section, cfg) {
  const columns = cfg.columns || []
  const label = document.createElement('div')
  label.className = 'field-label'
  label.textContent = `Columns (${columns.length})`
  section.appendChild(label)

  const container = document.createElement('div')
  container.id = 'table-columns'
  container.className = 'columns-list'

  for (let i = 0; i < columns.length; i++) {
    appendColumnRow(container, columns[i], i)
  }

  section.appendChild(container)

  const addBtn = document.createElement('button')
  addBtn.className = 'btn-sm'
  addBtn.textContent = '+ Column'
  addBtn.addEventListener('click', () => {
    appendColumnRow(container, { name: '', type: 'text' }, container.children.length)
  })
  section.appendChild(addBtn)
}

function appendColumnRow(container, col, index) {
  const row = document.createElement('div')
  row.className = 'column-row'

  const nameInput = document.createElement('input')
  nameInput.className = 'field-input'
  nameInput.value = col.name || ''
  nameInput.placeholder = 'column name'
  nameInput.dataset.colIndex = index
  nameInput.dataset.colField = 'name'
  row.appendChild(nameInput)

  const typeSelect = document.createElement('select')
  typeSelect.className = 'field-select'
  typeSelect.dataset.colIndex = index
  typeSelect.dataset.colField = 'type'
  for (const t of ['text', 'integer', 'real', 'blob', 'json']) {
    const opt = document.createElement('option')
    opt.value = t
    opt.textContent = t
    if (t === (col.type || 'text')) opt.selected = true
    typeSelect.appendChild(opt)
  }
  row.appendChild(typeSelect)

  const removeBtn = document.createElement('button')
  removeBtn.className = 'btn-sm danger'
  removeBtn.textContent = '\u00d7'
  removeBtn.addEventListener('click', () => row.remove())
  row.appendChild(removeBtn)

  container.appendChild(row)
}

function renderEndpointFields(section, cfg) {
  appendSelect(section, 'method', 'Method', HTTP_METHODS.map(m => ({ value: m, label: m })), (cfg.method || 'POST').toUpperCase())
  appendInput(section, 'path', 'Path', cfg.path || '/', '/path')
  appendSelect(section, 'response_mode', 'Response Mode', RESPONSE_MODES.map(m => ({ value: m, label: m })), cfg.response_mode || 'ack')
}

function renderScriptFields(section, cfg) {
  appendSelect(section, 'language', 'Language', SCRIPT_LANGUAGES.map(l => ({ value: l, label: l })), cfg.language || 'ts')
  appendTextarea(section, 'source', 'Source', cfg.source || '', 'Script source code...')
}

function renderMcpFields(section, cfg) {
  const transport = cfg.transport || 'stdio'
  appendSelect(section, 'transport', 'Transport', MCP_TRANSPORTS.map(t => ({ value: t, label: t })), transport)

  if (transport === 'stdio') {
    appendInput(section, 'command', 'Command', cfg.command || '', 'e.g. npx -y @modelcontextprotocol/server')
  } else {
    appendInput(section, 'url', 'URL', cfg.url || '', 'https://...')
  }
}

function renderVaultFields(section, cfg) {
  const keys = cfg.keys || []
  const label = document.createElement('div')
  label.className = 'field-label'
  label.textContent = `Secret Keys (${keys.length})`
  section.appendChild(label)

  const container = document.createElement('div')
  container.id = 'vault-keys'

  for (const k of keys) {
    appendVaultKeyRow(container, k)
  }

  section.appendChild(container)

  const addBtn = document.createElement('button')
  addBtn.className = 'btn-sm'
  addBtn.textContent = '+ Key'
  addBtn.addEventListener('click', () => appendVaultKeyRow(container, ''))
  section.appendChild(addBtn)
}

function appendVaultKeyRow(container, key) {
  const row = document.createElement('div')
  row.className = 'column-row'

  const input = document.createElement('input')
  input.className = 'field-input vault-key-input'
  input.value = key
  input.placeholder = 'KEY_NAME'
  row.appendChild(input)

  const removeBtn = document.createElement('button')
  removeBtn.className = 'btn-sm danger'
  removeBtn.textContent = '\u00d7'
  removeBtn.addEventListener('click', () => row.remove())
  row.appendChild(removeBtn)

  container.appendChild(row)
}

function renderToolFields(section, cfg) {
  const label = document.createElement('div')
  label.className = 'field-label'
  label.textContent = 'Tool nodes are configured via import. Use the Wheel API tool handler.'
  section.appendChild(label)

  if (cfg.base_url) {
    appendInput(section, 'base_url', 'Base URL', cfg.base_url, '')
  }
}

// ---- Field helpers ----

function appendInput(parent, id, label, value, placeholder) {
  const group = document.createElement('div')
  group.className = 'field-group'

  const lbl = document.createElement('div')
  lbl.className = 'field-label'
  lbl.textContent = label
  group.appendChild(lbl)

  const input = document.createElement('input')
  input.className = 'field-input'
  input.id = `field-${id}`
  input.type = 'text'
  input.value = value
  if (placeholder) input.placeholder = placeholder
  group.appendChild(input)

  parent.appendChild(group)
}

function appendTextarea(parent, id, label, value, placeholder) {
  const group = document.createElement('div')
  group.className = 'field-group'

  const lbl = document.createElement('div')
  lbl.className = 'field-label'
  lbl.textContent = label
  group.appendChild(lbl)

  const textarea = document.createElement('textarea')
  textarea.className = 'field-textarea'
  textarea.id = `field-${id}`
  textarea.value = value
  textarea.rows = 4
  if (placeholder) textarea.placeholder = placeholder
  group.appendChild(textarea)

  parent.appendChild(group)
}

function appendSelect(parent, id, label, options, selected) {
  const group = document.createElement('div')
  group.className = 'field-group'

  const lbl = document.createElement('div')
  lbl.className = 'field-label'
  lbl.textContent = label
  group.appendChild(lbl)

  const select = document.createElement('select')
  select.className = 'field-select'
  select.id = `field-${id}`

  for (const opt of options) {
    const o = document.createElement('option')
    o.value = typeof opt === 'object' ? opt.value : opt
    o.textContent = typeof opt === 'object' ? opt.label : opt
    if (o.value === selected) o.selected = true
    select.appendChild(o)
  }

  group.appendChild(select)
  parent.appendChild(group)
}

function appendToggle(parent, id, label, checked) {
  const row = document.createElement('div')
  row.className = 'toggle-row'

  const toggle = document.createElement('label')
  toggle.className = 'toggle-switch'

  const input = document.createElement('input')
  input.type = 'checkbox'
  input.id = `field-${id}`
  input.checked = checked

  const slider = document.createElement('span')
  slider.className = 'toggle-slider'

  toggle.appendChild(input)
  toggle.appendChild(slider)
  row.appendChild(toggle)

  const text = document.createElement('span')
  text.className = 'toggle-label'
  text.textContent = label
  row.appendChild(text)

  parent.appendChild(row)
}

// ---- Save config ----

async function saveConfig(entry) {
  if (!inspectorApi || !boardState?.projectId) return

  const statusEl = document.getElementById('inspector-save-status')
  const saveBtn = document.getElementById('inspector-save-btn')
  if (saveBtn) saveBtn.disabled = true
  if (statusEl) { statusEl.className = 'save-status'; statusEl.textContent = 'Saving...' }

  try {
    const config = collectConfig(entry.nodeType)
    await inspectorApi.patchNode(boardState.projectId, entry.nodeId, { config })

    entry.nodeConfig = config
    updateBoardStateEntry(entry)

    if (statusEl) { statusEl.className = 'save-status ok'; statusEl.textContent = 'Saved' }
    setTimeout(() => { if (statusEl) statusEl.textContent = '' }, 2000)
  } catch (err) {
    if (statusEl) { statusEl.className = 'save-status err'; statusEl.textContent = err.message }
  } finally {
    if (saveBtn) saveBtn.disabled = false
  }
}

function collectConfig(nodeType) {
  const val = (id) => document.getElementById(`field-${id}`)?.value || ''
  const checked = (id) => document.getElementById(`field-${id}`)?.checked || false

  switch (nodeType) {
    case 'agent':
      return {
        harness: val('harness') || 'claude',
        system_prompt: val('system_prompt'),
        model: val('model') || undefined,
        run_on_startup: checked('run_on_startup'),
        ephemeral_context: checked('ephemeral_context'),
      }
    case 'ctx':
      return { markdown: val('markdown') }
    case 'table':
      return { columns: collectTableColumns() }
    case 'endpoint':
      return {
        method: val('method') || 'POST',
        path: val('path') || '/',
        response_mode: val('response_mode') || 'ack',
      }
    case 'script':
      return {
        language: val('language') || 'ts',
        source: val('source') || '// empty',
      }
    case 'mcp': {
      const transport = val('transport') || 'stdio'
      if (transport === 'stdio') return { transport: 'stdio', command: val('command') || 'echo' }
      return { transport: 'http', url: val('url') || 'https://example.com' }
    }
    case 'vault':
      return { keys: collectVaultKeys() }
    case 'chest':
      return {}
    case 'tool':
      return undefined
    default:
      return undefined
  }
}

function collectTableColumns() {
  const container = document.getElementById('table-columns')
  if (!container) return []
  const columns = []
  for (const row of container.children) {
    const nameInput = row.querySelector('input')
    const typeSelect = row.querySelector('select')
    if (nameInput?.value) {
      columns.push({ name: nameInput.value, type: typeSelect?.value || 'text' })
    }
  }
  return columns
}

function collectVaultKeys() {
  const container = document.getElementById('vault-keys')
  if (!container) return []
  const keys = []
  for (const row of container.children) {
    const input = row.querySelector('.vault-key-input')
    if (input?.value) keys.push(input.value)
  }
  return keys
}

async function updateBoardStateEntry(entry) {
  try {
    await reloadBoardState()
    if (boardState?.paneToNode) {
      for (const [pid, e] of Object.entries(boardState.paneToNode)) {
        if (e.nodeId === entry.nodeId) {
          e.nodeConfig = entry.nodeConfig
        }
      }
      await inspectorSendRequest('secrets.set', {
        key: 'boardState',
        value: JSON.stringify(boardState),
      })
    }
  } catch {
    // board state update is best-effort
  }
}

// ---- Wire matrix (mirrors wheel-core/src/wire.rs) ----

const WIRE_MATRIX = [
  ['agent', 'send', 'agent'],
  ['agent', 'read', 'ctx'],
  ['agent', 'write', 'ctx'],
  ['agent', 'read', 'table'],
  ['agent', 'write', 'table'],
  ['agent', 'read', 'vault'],
  ['agent', 'read', 'chest'],
  ['agent', 'write', 'chest'],
  ['agent', 'read', 'script'],
  ['agent', 'read', 'mcp'],
  ['agent', 'read', 'tool'],
  ['ctx', 'send', 'agent'],
  ['endpoint', 'send', 'agent'],
  ['endpoint', 'write', 'table'],
  ['endpoint', 'send', 'script'],
  ['endpoint', 'read', 'vault'],
  ['script', 'send', 'agent'],
  ['script', 'read', 'ctx'],
  ['script', 'write', 'ctx'],
  ['script', 'read', 'table'],
  ['script', 'write', 'table'],
  ['script', 'read', 'chest'],
  ['script', 'write', 'chest'],
  ['script', 'read', 'vault'],
  ['script', 'read', 'tool'],
  ['tool', 'read', 'vault'],
]

function wireAllowed(fromType, wireType, toType) {
  return WIRE_MATRIX.some(([f, w, t]) => f === fromType && w === wireType && t === toType)
}

function allowedWireTypes(fromType, toType) {
  return ['read', 'write', 'send'].filter(w => wireAllowed(fromType, w, toType))
}

function allowedTargets(fromType) {
  const targets = new Set()
  for (const [f, , t] of WIRE_MATRIX) {
    if (f === fromType) targets.add(t)
  }
  return targets
}

// ---- Wires section ----

function renderWiresSection(entry, paneId) {
  const section = document.createElement('div')
  section.className = 'section'
  section.id = 'wires-section'

  const title = document.createElement('div')
  title.className = 'field-label'
  title.textContent = 'Wires'
  title.style.marginBottom = '4px'
  section.appendChild(title)

  const wireList = document.createElement('div')
  wireList.id = 'wire-list'

  const wires = entry.wires || []
  if (wires.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'wire-empty'
    empty.textContent = 'No wires.'
    wireList.appendChild(empty)
  }

  for (const w of wires) {
    const row = document.createElement('div')
    row.className = 'wire-item'

    const dir = document.createElement('span')
    dir.className = 'wire-dir'
    dir.textContent = w.direction === 'outgoing' ? '\u2192 ' : '\u2190 '
    row.appendChild(dir)

    const wireType = document.createElement('span')
    wireType.className = `wire-type wire-type-${w.type}`
    wireType.textContent = w.type
    row.appendChild(wireType)

    const peer = document.createElement('span')
    peer.className = 'wire-peer'
    peer.textContent = ` ${w.direction === 'outgoing' ? 'to' : 'from'} ${w.peerName}`
    row.appendChild(peer)

    const removeBtn = document.createElement('button')
    removeBtn.className = 'btn-sm danger wire-remove'
    removeBtn.textContent = '\u00d7'
    removeBtn.addEventListener('click', () => removeWire(entry, w, row))
    row.appendChild(removeBtn)

    wireList.appendChild(row)
  }

  section.appendChild(wireList)

  const validTargets = allowedTargets(entry.nodeType)
  const peers = []
  if (boardState?.paneToNode) {
    for (const [, e] of Object.entries(boardState.paneToNode)) {
      if (e.nodeId === entry.nodeId) continue
      if (!validTargets.has(e.nodeType)) continue
      peers.push(e)
    }
  }

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

  const addRow = document.createElement('div')
  addRow.className = 'wire-add-row'

  const peerSelect = document.createElement('select')
  peerSelect.className = 'field-select wire-peer-select'
  peerSelect.id = 'wire-peer-select'

  const defaultOpt = document.createElement('option')
  defaultOpt.value = ''
  defaultOpt.textContent = 'Target node...'
  peerSelect.appendChild(defaultOpt)

  for (const e of peers) {
    const opt = document.createElement('option')
    opt.value = e.nodeId
    opt.textContent = `${e.nodeName} (${e.nodeType})`
    opt.dataset.nodeType = e.nodeType
    peerSelect.appendChild(opt)
  }
  addRow.appendChild(peerSelect)

  const typeSelect = document.createElement('select')
  typeSelect.className = 'field-select wire-type-select'
  typeSelect.id = 'wire-type-select'
  addRow.appendChild(typeSelect)

  function updateTypeOptions() {
    typeSelect.textContent = ''
    const selectedOpt = peerSelect.selectedOptions[0]
    const targetType = selectedOpt?.dataset?.nodeType
    if (!targetType) {
      const placeholder = document.createElement('option')
      placeholder.value = ''
      placeholder.textContent = 'type...'
      typeSelect.appendChild(placeholder)
      return
    }
    const types = allowedWireTypes(entry.nodeType, targetType)
    for (const t of types) {
      const opt = document.createElement('option')
      opt.value = t
      opt.textContent = t
      typeSelect.appendChild(opt)
    }
  }

  peerSelect.addEventListener('change', updateTypeOptions)
  updateTypeOptions()

  const addBtn = document.createElement('button')
  addBtn.className = 'btn-sm primary'
  addBtn.textContent = '+ Wire'
  addBtn.addEventListener('click', () => addWire(entry, paneId))
  addRow.appendChild(addBtn)

  section.appendChild(addRow)
  $content.appendChild(section)
}

async function addWire(entry, paneId) {
  if (!inspectorApi || !boardState?.projectId) return

  const peerNodeId = document.getElementById('wire-peer-select')?.value
  const wireType = document.getElementById('wire-type-select')?.value
  if (!peerNodeId || !wireType) return

  try {
    await inspectorApi.createWire(boardState.projectId, entry.nodeId, peerNodeId, wireType)
    await reloadBoardState()
    await syncAllWireConnections()

    const updatedEntry = boardState?.paneToNode && Object.values(boardState.paneToNode).find(e => e.nodeId === entry.nodeId)
    if (updatedEntry) {
      await refreshEntryWires(entry)
      showNode({ ...entry, wires: entry.wires }, paneId)
    }
  } catch (err) {
    const statusEl = document.getElementById('inspector-save-status')
    if (statusEl) { statusEl.className = 'save-status err'; statusEl.textContent = err.message }
  }
}

async function removeWire(entry, wire, row) {
  if (!inspectorApi || !boardState?.projectId) return

  const peerNodeId = findNodeIdByName(wire.peerName)
  if (!peerNodeId) return

  const fromId = wire.direction === 'outgoing' ? entry.nodeId : peerNodeId
  const toId = wire.direction === 'outgoing' ? peerNodeId : entry.nodeId

  try {
    await inspectorApi.deleteWire(boardState.projectId, fromId, toId, wire.type)
    row.remove()
    await reloadBoardState()
    await syncAllWireConnections()
  } catch (err) {
    const statusEl = document.getElementById('inspector-save-status')
    if (statusEl) { statusEl.className = 'save-status err'; statusEl.textContent = err.message }
  }
}

function findNodeIdByName(name) {
  if (!boardState?.paneToNode) return null
  for (const e of Object.values(boardState.paneToNode)) {
    if (e.nodeName === name) return e.nodeId
  }
  return null
}

async function refreshEntryWires(entry) {
  if (!inspectorApi || !boardState?.projectId) return
  try {
    const apiBoard = await inspectorApi.getBoard(boardState.projectId)
    const wires = apiBoard.wires || []
    const nodesById = {}
    for (const n of (apiBoard.nodes || [])) nodesById[n.id] = n

    entry.wires = wires
      .filter(w => w.from === entry.nodeId || w.to === entry.nodeId)
      .map(w => ({
        type: w.type,
        direction: w.from === entry.nodeId ? 'outgoing' : 'incoming',
        peerName: (nodesById[w.from === entry.nodeId ? w.to : w.from] || {}).name || 'unknown',
        peerType: (nodesById[w.from === entry.nodeId ? w.to : w.from] || {}).type || 'unknown',
      }))
  } catch {
    // wire refresh is best-effort
  }
}

async function syncAllWireConnections() {
  if (!inspectorApi || !boardState?.projectId) return

  try {
    const apiBoard = await inspectorApi.getBoard(boardState.projectId)
    const wires = apiBoard.wires || []

    const nodeIdToPane = {}
    for (const [paneId, entry] of Object.entries(boardState.paneToNode || {})) {
      nodeIdToPane[entry.nodeId] = paneId
    }

    const paneAssociations = {}
    for (const paneId of Object.keys(boardState.paneToNode || {})) {
      paneAssociations[paneId] = new Set()
    }

    for (const wire of wires) {
      const fromPane = nodeIdToPane[wire.from]
      const toPane = nodeIdToPane[wire.to]
      if (fromPane && toPane) {
        paneAssociations[fromPane]?.add(toPane)
        paneAssociations[toPane]?.add(fromPane)
      }
    }

    for (const [paneId, peers] of Object.entries(paneAssociations)) {
      const associatedPaneIds = [...peers]
      await inspectorSendRequest('canvas.updatePane', { paneId, associatedPaneIds }).catch(() => {})
    }
  } catch {
    // wire sync is best-effort
  }
}

// ---- Agent log ----

function renderAgentLog(entry) {
  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('div')
  title.className = 'field-label'
  title.textContent = 'Agent Log'
  section.appendChild(title)

  const logContainer = document.createElement('div')
  logContainer.id = 'agent-log'
  logContainer.className = 'agent-log'
  section.appendChild(logContainer)

  $content.appendChild(section)
  startLogPolling(entry.nodeId)
}

function startLogPolling(nodeId) {
  stopLogPolling()
  if (!inspectorApi || !boardState?.projectId) return

  logCursor = 0
  fetchAgentLog(nodeId)
  logPollTimer = setInterval(() => fetchAgentLog(nodeId), 5000)
}

function stopLogPolling() {
  if (logPollTimer) {
    clearInterval(logPollTimer)
    logPollTimer = null
  }
}

async function fetchAgentLog(nodeId) {
  if (!inspectorApi || !boardState?.projectId) return

  try {
    const log = await inspectorApi.agentLog(boardState.projectId, nodeId, { since: logCursor })
    const entries = Array.isArray(log) ? log : (log.entries || [])
    if (entries.length === 0) return

    logCursor = entries[entries.length - 1].seq || entries[entries.length - 1].id || logCursor

    const logContainer = document.getElementById('agent-log')
    if (!logContainer) return

    for (const entry of entries) {
      const line = document.createElement('div')
      line.className = 'log-line'
      const stream = entry.stream || 'stdout'
      if (stream === 'stderr') line.classList.add('log-stderr')
      const text = entry.text || entry.line || entry.body || JSON.stringify(entry)
      line.textContent = text.length > 200 ? text.slice(0, 200) + '...' : text
      logContainer.appendChild(line)
    }

    while (logContainer.children.length > 100) {
      logContainer.removeChild(logContainer.firstChild)
    }

    logContainer.scrollTop = logContainer.scrollHeight
  } catch {
    // log fetch failed
  }
}

// ---- Init ----

async function reloadBoardState() {
  try {
    const result = await inspectorSendRequest('secrets.get', { key: 'boardState' })
    if (result?.value) {
      boardState = JSON.parse(result.value)
    }
  } catch {
    // reload failed
  }
}

function listenForInspectorEvents() {
  ext.onMessage((msg) => {
    if (msg.kind !== 'event') return

    if (msg.topic === 'canvas.paneFocused') {
      const paneId = msg.payload?.paneId
      if (!paneId || !boardState) return

      reloadBoardState().then(async () => {
        const entry = boardState?.paneToNode?.[paneId]
        if (!entry) return

        await refreshEntryWires(entry)
        showNode(entry, paneId)
      })
    }

    if (msg.topic === 'canvas.paneRemoved') {
      const paneId = msg.payload?.paneId
      if (!paneId || !boardState) return

      const entry = boardState?.paneToNode?.[paneId]
      if (entry?.nodeId === currentNodeId) {
        showEmpty('Node removed.')
      }
    }
  })
}

async function initInspector() {
  try {
    const [urlResult, tokenResult, boardResult] = await Promise.all([
      inspectorSendRequest('secrets.get', { key: 'apiUrl' }),
      inspectorSendRequest('secrets.get', { key: 'apiToken' }),
      inspectorSendRequest('secrets.get', { key: 'boardState' }),
    ])

    const apiUrl = urlResult?.value || 'https://wheel-api-production-28d3.up.railway.app'
    const apiToken = tokenResult?.value || ''

    if (apiUrl && apiToken) {
      inspectorApi = new WheelApi(apiUrl, apiToken)
    }

    if (boardResult?.value) {
      boardState = JSON.parse(boardResult.value)
    }
  } catch {
    // secrets load failed
  }

  if (!boardState) {
    showEmpty('No Wheel project synced. Open a project from the Wheel Projects panel.')
    return
  }

  showEmpty('Project synced. Click a Wheel node on the canvas to inspect.')
  listenForInspectorEvents()
}

initInspector()
