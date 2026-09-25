const ext = window.agentGridExtension
let paneReqId = 0

const DEFAULT_API_URL = 'https://wheel-api-production-28d3.up.railway.app'

const HARNESS_OPTIONS = [
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

function paneSendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = `np-${++paneReqId}`
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('timeout'))
    }, 3000)
    const cleanup = ext.onMessage((msg) => {
      if (msg.kind !== 'response' || msg.id !== id) return
      clearTimeout(timeout)
      cleanup()
      if (msg.ok) resolve(msg.result)
      else reject(new Error(msg.error))
    })
    ext.postMessage({ kind: 'request', id, method, params })
  })
}

const $card = document.getElementById('node-card')
const $loading = document.getElementById('loading')

let nodeData = null
let paneApi = null
let activeProjectId = null

const SURFACE_TO_NODE_TYPE = {
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

async function initNodePane() {
  console.log('[wheel:node-pane] initNodePane starting')
  try {
    const [desc, urlResult, tokenResult] = await Promise.all([
      paneSendRequest('host.describe'),
      paneSendRequest('secrets.get', { key: 'apiUrl' }),
      paneSendRequest('secrets.get', { key: 'apiToken' }),
    ])

    const myPaneId = desc?.paneId
    myPaneIdGlobal = myPaneId
    const mySurfaceId = desc?.surfaceId
    console.log('[wheel:node-pane] desc:', JSON.stringify(desc))
    if (!myPaneId) {
      $loading.textContent = 'No pane identity.'
      return
    }

    const apiUrl = urlResult?.value || DEFAULT_API_URL
    const apiToken = tokenResult?.value || ''

    if (apiToken) {
      paneApi = new WheelApi(apiUrl, apiToken)
    }

    console.log('[wheel:node-pane] paneId:', myPaneId, 'surfaceId:', mySurfaceId, 'hasApi:', !!paneApi)
    let entry = await waitForBoardEntry(myPaneId)
    console.log('[wheel:node-pane] waitForBoardEntry result:', entry ? 'FOUND' : 'NOT FOUND', entry ? JSON.stringify({ nodeId: entry.nodeId, nodeName: entry.nodeName }) : '')

    if (!entry && mySurfaceId && SURFACE_TO_NODE_TYPE[mySurfaceId]) {
      console.log('[wheel:node-pane] falling through to autoCreateNode, surfaceId:', mySurfaceId, 'nodeType:', SURFACE_TO_NODE_TYPE[mySurfaceId])
      entry = await autoCreateNode(myPaneId, mySurfaceId)
      console.log('[wheel:node-pane] autoCreateNode result:', entry ? 'CREATED' : 'FAILED')
    }

    if (!entry) {
      console.log('[wheel:node-pane] NO ENTRY - paneApi:', !!paneApi, 'surfaceId:', mySurfaceId, 'mappedType:', SURFACE_TO_NODE_TYPE[mySurfaceId])
      $loading.textContent = paneApi ? 'Node not found.' : 'Configure Wheel API in extension settings.'
      return
    }

    const { projectId, nodeId, nodeType, nodeName, nodeConfig, wires } = entry
    activeProjectId = projectId
    myNodeType = nodeType
    nodeData = { id: nodeId, type: nodeType, name: nodeName, config: nodeConfig || {}, wires: wires || [] }

    renderNode(nodeData)
    renderSockets(nodeType)

    if (paneApi && nodeType === 'agent') {
      pollAgentStatus(projectId, nodeId)
    }
  } catch (err) {
    console.error('[wheel:node-pane] initNodePane error:', err)
    const msg = err.message || String(err)
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed')) {
      $loading.textContent = 'Connection error. Configure Wheel API in extension settings.'
    } else {
      $loading.textContent = msg
    }
  }
}

async function autoCreateNode(paneId, surfaceId) {
  const nodeType = SURFACE_TO_NODE_TYPE[surfaceId]
  if (!nodeType || !paneApi) return null

  const boardResult = await paneSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
  if (!boardResult?.value) {
    $loading.textContent = 'No project open.'
    return null
  }

  const board = JSON.parse(boardResult.value)
  if (!board.projectId) {
    $loading.textContent = 'No project open.'
    return null
  }

  const existingNames = Object.values(board.paneToNode || {}).map(e => e.nodeName || '')
  let counter = 1
  const sep = nodeType === 'table' ? '_' : '-'
  let name = `${nodeType}${sep}${counter}`
  while (existingNames.includes(name)) {
    counter++
    name = `${nodeType}${sep}${counter}`
  }

  const defaultConfigs = {
    agent: { harness: 'claude', system_prompt: '' },
    ctx: { markdown: '' },
    table: { columns: [] },
    endpoint: { method: 'POST', path: `/${name}`, response_mode: 'ack' },
    script: { language: 'ts', source: '// new script' },
    mcp: { transport: 'stdio', command: 'echo' },
    vault: { keys: [] },
    chest: {},
    tool: { kind: 'http', source: { format: 'manual', raw: '', imported_at: new Date().toISOString() }, base_url: 'https://example.com', operations: [] },
  }
  const config = defaultConfigs[nodeType] || {}

  $loading.textContent = `Creating ${nodeType} node...`

  const node = await paneApi.createNode(board.projectId, {
    name,
    type: nodeType,
    position: { x: 0, y: 0 },
    config,
  })
  if (!node?.id) return null

  board.paneToNode = board.paneToNode || {}
  board.paneToNode[paneId] = {
    nodeId: node.id,
    nodeType,
    nodeName: name,
    nodeConfig: node.config || {},
    wires: [],
  }
  board.nodesById = board.nodesById || {}
  board.nodesById[node.id] = node

  await paneSendRequest('secrets.set', {
    key: 'boardState',
    value: JSON.stringify(board),
  })

  return { ...board.paneToNode[paneId], projectId: board.projectId }
}

async function waitForBoardEntry(paneId, maxAttempts = 20, delayMs = 250) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await paneSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
    if (result?.value) {
      const board = JSON.parse(result.value)
      const entry = board.paneToNode?.[paneId]

      if (entry) return { ...entry, projectId: board.projectId }

      if (board.spawning) continue
    }
    await new Promise(r => setTimeout(r, delayMs))
  }
  return null
}

function renderNode(node) {
  $card.textContent = ''

  renderHeader(node)

  if (node.type === 'agent') {
    renderAgentStatusRow(node)
    appendSeparator()
    renderAgentConfig(node)
    appendSeparator()
    renderAgentRuntime(node)
  }

  if (node.wires && node.wires.length > 0) {
    appendSeparator()
    renderWires(node)
  }

  if (node.type !== 'agent' && node.config) {
    renderNonAgentConfig(node)
  }

  if (node.type === 'table') {
    appendSeparator()
    renderTableRuntime(node)
  } else if (node.type === 'vault') {
    appendSeparator()
    renderVaultRuntime(node)
  } else if (node.type === 'chest') {
    appendSeparator()
    renderChestRuntime(node)
  } else if (node.type === 'tool') {
    appendSeparator()
    renderToolRuntime(node)
  }
}

function renderHeader(node) {
  const header = document.createElement('div')
  header.className = 'node-header'

  const badge = document.createElement('span')
  badge.className = `type-badge ${node.type}`
  badge.textContent = node.type
  header.appendChild(badge)

  const name = document.createElement('span')
  name.className = 'node-name'
  name.textContent = node.name
  header.appendChild(name)

  $card.appendChild(header)
}

function renderAgentStatusRow(node) {
  const row = document.createElement('div')
  row.className = 'status-row'
  row.id = 'status-row'

  const dot = document.createElement('span')
  dot.className = 'status-dot stopped'
  dot.id = 'status-dot'
  row.appendChild(dot)

  const label = document.createElement('span')
  label.id = 'status-label'
  label.textContent = 'Stopped'
  row.appendChild(label)

  const actions = document.createElement('div')
  actions.className = 'status-actions'

  const startBtn = createButton('Start', 'btn-sm primary', () => agentAction('start'))
  const restartBtn = createButton('Restart', 'btn-sm', () => agentAction('restart'))
  const clearBtn = createButton('Clear', 'btn-sm danger', () => agentAction('clear'))

  actions.appendChild(startBtn)
  actions.appendChild(restartBtn)
  actions.appendChild(clearBtn)
  row.appendChild(actions)

  $card.appendChild(row)
}

function renderAgentConfig(node) {
  const cfg = node.config || {}

  const harnessGroup = createFieldGroup('Harness')
  const harnessSelect = document.createElement('select')
  harnessSelect.className = 'field-select'
  harnessSelect.id = 'field-harness'

  for (const opt of HARNESS_OPTIONS) {
    const option = document.createElement('option')
    option.value = opt.value
    option.textContent = opt.label
    if (opt.value === (cfg.harness || '')) option.selected = true
    harnessSelect.appendChild(option)
  }

  harnessGroup.appendChild(harnessSelect)
  $card.appendChild(harnessGroup)

  const modelGroup = createFieldGroup('Model')
  const modelInput = document.createElement('input')
  modelInput.className = 'field-input'
  modelInput.id = 'field-model'
  modelInput.type = 'text'
  modelInput.value = cfg.model || ''
  modelInput.placeholder = 'Leave empty for harness default'
  modelGroup.appendChild(modelInput)

  const modelHint = document.createElement('div')
  modelHint.className = 'field-hint'
  modelHint.textContent = 'Leave empty for the harness default.'
  modelGroup.appendChild(modelHint)
  $card.appendChild(modelGroup)

  const promptGroup = createFieldGroup('System prompt')
  const promptArea = document.createElement('textarea')
  promptArea.className = 'field-textarea'
  promptArea.id = 'field-system-prompt'
  promptArea.rows = 4
  promptArea.value = cfg.system_prompt || ''
  promptArea.placeholder = 'Instructions for this agent...'
  promptGroup.appendChild(promptArea)

  const promptHint = document.createElement('div')
  promptHint.className = 'field-hint'
  promptHint.textContent = 'Applied on start and again after every context clear.'
  promptGroup.appendChild(promptHint)
  $card.appendChild(promptGroup)

  const saveRow = document.createElement('div')
  saveRow.className = 'save-row'

  const saveStatus = document.createElement('span')
  saveStatus.className = 'save-status'
  saveStatus.id = 'save-status'
  saveRow.appendChild(saveStatus)

  const saveBtn = createButton('Save', 'btn-sm primary', () => saveAgentConfig())
  saveBtn.id = 'save-btn'
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

function renderToggle(id, label, description, checked) {
  const row = document.createElement('div')
  row.className = 'toggle-row'

  const toggle = document.createElement('label')
  toggle.className = 'toggle-switch'

  const input = document.createElement('input')
  input.type = 'checkbox'
  input.id = `toggle-${id}`
  input.checked = checked
  input.addEventListener('change', () => saveAgentConfig())

  const slider = document.createElement('span')
  slider.className = 'toggle-slider'

  toggle.appendChild(input)
  toggle.appendChild(slider)
  row.appendChild(toggle)

  const text = document.createElement('div')
  text.className = 'toggle-text'

  const labelEl = document.createElement('span')
  labelEl.className = 'toggle-label'
  labelEl.textContent = label
  text.appendChild(labelEl)

  const desc = document.createElement('span')
  desc.className = 'toggle-desc'
  desc.textContent = description
  text.appendChild(desc)

  row.appendChild(text)
  $card.appendChild(row)
}

function renderWires(node) {
  const wiresRow = document.createElement('div')
  wiresRow.className = 'wires-row'

  for (const w of node.wires) {
    const wireSpan = document.createElement('span')
    wireSpan.className = `wire-${w.type}`
    wireSpan.textContent = w.type

    const arrow = w.direction === 'outgoing' ? ' \u2192 ' : ' \u2190 '
    const peerText = document.createTextNode(arrow + w.peerName)

    wiresRow.appendChild(wireSpan)
    wiresRow.appendChild(peerText)

    const sep = document.createTextNode(' \u00B7 ')
    wiresRow.appendChild(sep)
  }

  $card.appendChild(wiresRow)
}

function renderNonAgentConfig(node) {
  const keys = Object.keys(node.config).filter(k => {
    const v = node.config[k]
    return v !== '' && v !== null && v !== undefined
  })

  if (keys.length === 0) return

  const preview = document.createElement('div')
  preview.className = 'config-preview'
  preview.textContent = keys.join(', ')
  $card.appendChild(preview)
}

// ---- Agent runtime: message log + send input ----

let agentLogCursor = 0
let agentLogTimer = null

function renderAgentRuntime(node) {
  const section = document.createElement('div')
  section.className = 'runtime-section'

  const label = document.createElement('div')
  label.className = 'section-label'
  label.textContent = 'Transcript'
  section.appendChild(label)

  const log = document.createElement('div')
  log.className = 'msg-log'
  log.id = 'agent-log'
  section.appendChild(log)

  const inputRow = document.createElement('div')
  inputRow.className = 'msg-input-row'

  const textarea = document.createElement('textarea')
  textarea.placeholder = 'Send a message...'
  textarea.rows = 1
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendAgentMessage(textarea)
    }
  })
  inputRow.appendChild(textarea)

  const sendBtn = createButton('Send', 'btn-sm primary', () => sendAgentMessage(textarea))
  sendBtn.id = 'agent-send-btn'
  inputRow.appendChild(sendBtn)

  section.appendChild(inputRow)
  $card.appendChild(section)

  startAgentLogPoll()
}

async function sendAgentMessage(textarea) {
  const body = textarea.value.trim()
  if (!body || !paneApi || !activeProjectId || !nodeData) return

  const sendBtn = document.getElementById('agent-send-btn')
  if (sendBtn) sendBtn.disabled = true
  textarea.disabled = true

  try {
    await paneApi.sendToAgent(activeProjectId, nodeData.id, body)
    textarea.value = ''
    pollAgentLog()
  } catch (err) {
    appendLogEntry('agent-log', err.message, 'log-stderr')
  } finally {
    textarea.disabled = false
    if (sendBtn) sendBtn.disabled = false
    textarea.focus()
  }
}

function startAgentLogPoll() {
  if (agentLogTimer) clearInterval(agentLogTimer)
  agentLogCursor = 0
  pollAgentLog()
  agentLogTimer = setInterval(pollAgentLog, 3000)
}

async function pollAgentLog() {
  if (!paneApi || !activeProjectId || !nodeData) return
  try {
    const result = await paneApi.agentLog(activeProjectId, nodeData.id, { since: agentLogCursor })
    const entries = Array.isArray(result) ? result : (result?.entries || [])
    const logEl = document.getElementById('agent-log')
    if (!logEl) return

    for (const entry of entries) {
      const seq = entry.seq ?? entry.id ?? 0
      if (seq > agentLogCursor) agentLogCursor = seq

      const stream = entry.stream || ''
      let cls = 'log-entry'
      if (stream === 'stderr') cls += ' log-stderr'
      else if (stream === 'transcript' || stream === 'stdout') cls += ' log-out'
      else cls += ' log-system'

      appendLogEntry('agent-log', entry.line || entry.text || JSON.stringify(entry), cls)
    }
  } catch {
    // poll failure — non-fatal
  }
}

function appendLogEntry(containerId, text, className) {
  const container = document.getElementById(containerId)
  if (!container) return
  const div = document.createElement('div')
  div.className = className || 'log-entry'
  div.textContent = text
  container.appendChild(div)
  container.scrollTop = container.scrollHeight
}

// ---- Table runtime: row viewer + SQL query ----

function renderTableRuntime(node) {
  const section = document.createElement('div')
  section.className = 'runtime-section'

  const label = document.createElement('div')
  label.className = 'section-label'
  label.textContent = 'Data'
  section.appendChild(label)

  const viewer = document.createElement('div')
  viewer.className = 'table-viewer'
  viewer.id = 'table-viewer'
  section.appendChild(viewer)

  const sqlRow = document.createElement('div')
  sqlRow.className = 'sql-row'

  const sqlInput = document.createElement('input')
  sqlInput.type = 'text'
  sqlInput.placeholder = 'SELECT * FROM ...'
  sqlInput.id = 'sql-input'
  sqlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSqlQuery()
  })
  sqlRow.appendChild(sqlInput)

  const runBtn = createButton('Run', 'btn-sm primary', runSqlQuery)
  sqlRow.appendChild(runBtn)

  const refreshBtn = createButton('Rows', 'btn-sm', loadTableRows)
  sqlRow.appendChild(refreshBtn)

  section.appendChild(sqlRow)

  const errEl = document.createElement('div')
  errEl.className = 'runtime-error'
  errEl.id = 'table-error'
  errEl.hidden = true
  section.appendChild(errEl)

  $card.appendChild(section)
  loadTableRows()
}

async function loadTableRows() {
  if (!paneApi || !activeProjectId || !nodeData) return
  const errEl = document.getElementById('table-error')
  if (errEl) errEl.hidden = true

  try {
    const result = await paneApi.tableRows(activeProjectId, nodeData.id, 50, 0)
    renderTableData(result)
  } catch (err) {
    if (errEl) { errEl.textContent = err.message; errEl.hidden = false }
  }
}

async function runSqlQuery() {
  const sqlInput = document.getElementById('sql-input')
  if (!sqlInput || !paneApi || !activeProjectId || !nodeData) return
  const sql = sqlInput.value.trim()
  if (!sql) return

  const errEl = document.getElementById('table-error')
  if (errEl) errEl.hidden = true

  try {
    const result = await paneApi.queryTable(activeProjectId, nodeData.id, sql)
    renderTableData(result)
  } catch (err) {
    if (errEl) { errEl.textContent = err.message; errEl.hidden = false }
  }
}

function renderTableData(result) {
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
  for (const col of columns) {
    const th = document.createElement('th')
    th.textContent = typeof col === 'string' ? col : (col.name || col)
    headerRow.appendChild(th)
  }
  thead.appendChild(headerRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const row of rows) {
    const tr = document.createElement('tr')
    const values = Array.isArray(row) ? row : columns.map(c => row[typeof c === 'string' ? c : c.name])
    for (const val of values) {
      const td = document.createElement('td')
      td.textContent = val === null ? 'NULL' : String(val)
      td.title = val === null ? 'NULL' : String(val)
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  viewer.appendChild(table)
}

// ---- Vault runtime: write secrets ----

function renderVaultRuntime(node) {
  const section = document.createElement('div')
  section.className = 'runtime-section'

  const label = document.createElement('div')
  label.className = 'section-label'
  label.textContent = 'Write Secret'
  section.appendChild(label)

  const row = document.createElement('div')
  row.className = 'vault-row'

  const keyInput = document.createElement('input')
  keyInput.type = 'text'
  keyInput.placeholder = 'Key'
  keyInput.id = 'vault-key'
  row.appendChild(keyInput)

  const valInput = document.createElement('input')
  valInput.type = 'password'
  valInput.placeholder = 'Value'
  valInput.id = 'vault-value'
  row.appendChild(valInput)

  const saveBtn = createButton('Save', 'btn-sm primary', saveVaultSecret)
  row.appendChild(saveBtn)

  section.appendChild(row)

  const status = document.createElement('div')
  status.id = 'vault-status'
  status.className = 'save-status'
  section.appendChild(status)

  $card.appendChild(section)
}

async function saveVaultSecret() {
  const keyEl = document.getElementById('vault-key')
  const valEl = document.getElementById('vault-value')
  const statusEl = document.getElementById('vault-status')
  if (!keyEl || !valEl || !paneApi || !activeProjectId || !nodeData) return

  const key = keyEl.value.trim()
  const value = valEl.value
  if (!key) return

  try {
    await paneApi.putSecret(activeProjectId, nodeData.id, key, value)
    if (statusEl) { statusEl.className = 'save-status ok'; statusEl.textContent = 'Saved' }
    keyEl.value = ''
    valEl.value = ''
    setTimeout(() => { if (statusEl) statusEl.textContent = '' }, 2000)
  } catch (err) {
    if (statusEl) { statusEl.className = 'save-status err'; statusEl.textContent = err.message }
  }
}

// ---- Chest runtime: file listing ----

function renderChestRuntime(node) {
  const section = document.createElement('div')
  section.className = 'runtime-section'

  const headerRow = document.createElement('div')
  headerRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between;'

  const label = document.createElement('div')
  label.className = 'section-label'
  label.textContent = 'Files'
  headerRow.appendChild(label)

  const refreshBtn = createButton('\u21bb', 'btn-sm', loadChestFiles)
  headerRow.appendChild(refreshBtn)
  section.appendChild(headerRow)

  const list = document.createElement('ul')
  list.className = 'file-list'
  list.id = 'chest-files'
  section.appendChild(list)

  $card.appendChild(section)
  loadChestFiles()
}

async function loadChestFiles() {
  if (!paneApi || !activeProjectId || !nodeData) return
  const list = document.getElementById('chest-files')
  if (!list) return
  list.textContent = ''

  try {
    const result = await paneApi.chestLs(activeProjectId, nodeData.id)
    const files = Array.isArray(result) ? result : (result?.files || result?.keys || [])

    if (files.length === 0) return

    for (const f of files) {
      const li = document.createElement('li')
      li.textContent = typeof f === 'string' ? f : (f.key || f.name || JSON.stringify(f))
      list.appendChild(li)
    }
  } catch {
    // load failed — non-fatal
  }
}

// ---- Tool runtime: operation list ----

function renderToolRuntime(node) {
  const section = document.createElement('div')
  section.className = 'runtime-section'

  const label = document.createElement('div')
  label.className = 'section-label'
  label.textContent = 'Operations'
  section.appendChild(label)

  const ops = node.config?.operations || []
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
    item.className = 'op-item'

    const method = document.createElement('span')
    method.className = `op-method ${(op.method || 'get').toLowerCase()}`
    method.textContent = op.method || 'GET'
    item.appendChild(method)

    const name = document.createElement('span')
    name.textContent = op.operation_id || op.name || op.path || '(unnamed)'
    item.appendChild(name)

    list.appendChild(item)
  }

  section.appendChild(list)
  $card.appendChild(section)
}

function appendSeparator() {
  const hr = document.createElement('hr')
  hr.className = 'separator'
  $card.appendChild(hr)
}

function createFieldGroup(labelText) {
  const group = document.createElement('div')
  group.className = 'field-group'

  const label = document.createElement('div')
  label.className = 'field-label'
  label.textContent = labelText
  group.appendChild(label)

  return group
}

function createButton(text, className, onClick) {
  const btn = document.createElement('button')
  btn.className = className
  btn.textContent = text
  btn.addEventListener('click', onClick)
  return btn
}

async function agentAction(action) {
  if (!paneApi || !activeProjectId || !nodeData) return

  const statusEl = document.getElementById('save-status')

  try {
    if (action === 'start') {
      await paneApi.startAgent(activeProjectId, nodeData.id)
      updateStatus('running')
    } else if (action === 'restart') {
      await paneApi.stopAgent(activeProjectId, nodeData.id).catch(() => {})
      await paneApi.startAgent(activeProjectId, nodeData.id)
      updateStatus('running')
    } else if (action === 'clear') {
      await paneApi.stopAgent(activeProjectId, nodeData.id).catch(() => {})
      updateStatus('stopped')
    }
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'save-status err'
      statusEl.textContent = err.message
    }
  }
}

async function saveAgentConfig() {
  if (!paneApi || !activeProjectId || !nodeData) return

  const statusEl = document.getElementById('save-status')
  const saveBtn = document.getElementById('save-btn')

  const harness = document.getElementById('field-harness')?.value || ''
  const model = document.getElementById('field-model')?.value || ''
  const systemPrompt = document.getElementById('field-system-prompt')?.value || ''
  const startWithProject = document.getElementById('toggle-start-with-project')?.checked || false
  const clearContext = document.getElementById('toggle-clear-context')?.checked || false

  const config = {
    ...(nodeData.config || {}),
    harness: harness || undefined,
    model: model || undefined,
    system_prompt: systemPrompt || undefined,
    run_on_startup: startWithProject,
    ephemeral_context: clearContext,
  }

  if (saveBtn) saveBtn.disabled = true
  if (statusEl) { statusEl.className = 'save-status'; statusEl.textContent = 'Saving...' }

  try {
    await paneApi.patchNode(activeProjectId, nodeData.id, { config })
    nodeData.config = config

    if (statusEl) { statusEl.className = 'save-status ok'; statusEl.textContent = 'Saved' }
    setTimeout(() => { if (statusEl) statusEl.textContent = '' }, 2000)
  } catch (err) {
    if (statusEl) { statusEl.className = 'save-status err'; statusEl.textContent = err.message }
  } finally {
    if (saveBtn) saveBtn.disabled = false
  }
}

function updateStatus(status) {
  const dot = document.getElementById('status-dot')
  const label = document.getElementById('status-label')
  if (!dot || !label) return

  dot.className = 'status-dot'
  if (status === 'running') { dot.classList.add('running'); label.textContent = 'Running' }
  else if (status === 'idle') { dot.classList.add('idle'); label.textContent = 'Idle' }
  else if (status === 'error' || status === 'rate_limited') { dot.classList.add('error'); label.textContent = status }
  else { dot.classList.add('stopped'); label.textContent = 'Stopped' }
}

let statusPollTimer = null

function pollAgentStatus(projectId, nodeId) {
  if (statusPollTimer) clearInterval(statusPollTimer)

  async function check() {
    try {
      const log = await paneApi.agentLog(projectId, nodeId, { since: 0 })
      const entries = Array.isArray(log) ? log : (log.entries || [])
      if (entries.length > 0) updateStatus('running')
    } catch {
      // poll failure is non-fatal
    }
  }

  check()
  statusPollTimer = setInterval(check, 10000)
}

let myPaneIdGlobal = null
let myNodeType = null

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

function outputWireTypes(nodeType) {
  const types = new Set()
  for (const [f, w] of WIRE_MATRIX) {
    if (f === nodeType) types.add(w)
  }
  return [...types]
}

function inputWireTypes(nodeType) {
  const types = new Set()
  for (const [, w, t] of WIRE_MATRIX) {
    if (t === nodeType) types.add(w)
  }
  return [...types]
}

const NODE_TYPE_LABELS = {
  agent: 'Agent', ctx: 'Context', table: 'Table', endpoint: 'Endpoint',
  script: 'Script', mcp: 'MCP Server', vault: 'Vault', chest: 'Chest', tool: 'Tool',
}

function compatibleTargetsForOutput(fromNodeType) {
  const targetTypes = new Set()
  for (const [f, , t] of WIRE_MATRIX) {
    if (f === fromNodeType) targetTypes.add(t)
  }
  return [...targetTypes].map(t => ({
    nodeType: t,
    label: NODE_TYPE_LABELS[t] || t,
    surfaceId: `wheel-${t}`,
  }))
}

function renderSockets(nodeType) {
  const existing = document.querySelector('.socket-container')
  if (existing) existing.remove()

  const container = document.createElement('div')
  container.className = 'socket-container'

  const outputs = outputWireTypes(nodeType)
  const inputs = inputWireTypes(nodeType)

  const rightSpacing = outputs.length > 0 ? 100 / (outputs.length + 1) : 0

  for (let i = 0; i < outputs.length; i++) {
    const dot = document.createElement('div')
    dot.className = `socket-dot ${outputs[i]}`
    dot.dataset.side = 'output'
    dot.dataset.wireType = outputs[i]
    dot.style.right = '-5px'
    dot.style.top = `${rightSpacing * (i + 1)}%`
    dot.title = `${outputs[i]} (output)`

    dot.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      paneSendRequest('canvas.startWireDrag', {
        nodeId: nodeData?.id || '',
        nodeType,
        side: 'output',
        compatibleTargets: compatibleTargetsForOutput(nodeType),
      })
    })

    container.appendChild(dot)
  }

  const leftSpacing = inputs.length > 0 ? 100 / (inputs.length + 1) : 0

  for (let i = 0; i < inputs.length; i++) {
    const dot = document.createElement('div')
    dot.className = `socket-dot ${inputs[i]}`
    dot.dataset.side = 'input'
    dot.dataset.wireType = inputs[i]
    dot.style.left = '-5px'
    dot.style.top = `${leftSpacing * (i + 1)}%`
    dot.title = `${inputs[i]} (input)`

    dot.addEventListener('mouseup', (e) => {
      e.preventDefault()
      e.stopPropagation()
      paneSendRequest('canvas.endWireDrag', {
        nodeId: nodeData?.id || '',
        nodeType,
      })
    })

    container.appendChild(dot)
  }

  document.body.appendChild(container)
}

function highlightValidSockets(fromNodeType) {
  const sockets = document.querySelectorAll('.socket-dot[data-side="input"]')

  for (const socket of sockets) {
    const wireType = socket.dataset.wireType
    const isValid = wireAllowed(fromNodeType, wireType, myNodeType)

    socket.classList.toggle('valid-target', isValid)
    socket.classList.toggle('dimmed', !isValid)
  }
}

function clearSocketHighlights() {
  const sockets = document.querySelectorAll('.socket-dot')

  for (const socket of sockets) {
    socket.classList.remove('valid-target', 'dimmed')
  }
}

async function handleWireDragEnded(payload) {
  const { fromPaneId, toPaneId, fromNodeId, toNodeId, fromNodeType, toNodeType } = payload

  const isOriginator = myPaneIdGlobal === fromPaneId
  if (!isOriginator || !paneApi || !activeProjectId) return

  const types = allowedWireTypes(fromNodeType, toNodeType)
  if (types.length === 0) return

  if (types.length === 1) {
    await createWireAndSync(fromNodeId, toNodeId, types[0])
    return
  }

  showWireTypePicker(types, async (selectedType) => {
    await createWireAndSync(fromNodeId, toNodeId, selectedType)
  })
}

async function createWireAndSync(fromNodeId, toNodeId, wireType) {
  try {
    await paneApi.createWire(activeProjectId, fromNodeId, toNodeId, wireType)
    await syncWireConnections()
  } catch (err) {
    console.error('[wheel:node-pane] createWire failed:', err)
  }
}

async function syncWireConnections() {
  if (!paneApi || !activeProjectId) return

  try {
    const boardResult = await paneSendRequest('secrets.get', { key: 'boardState' })
    if (!boardResult?.value) return

    const board = JSON.parse(boardResult.value)
    const apiBoard = await paneApi.getBoard(activeProjectId)
    const wires = apiBoard.wires || []

    const nodeIdToPane = {}
    for (const [paneId, entry] of Object.entries(board.paneToNode || {})) {
      nodeIdToPane[entry.nodeId] = paneId
    }

    const paneAssociations = {}
    for (const paneId of Object.keys(board.paneToNode || {})) {
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
      await paneSendRequest('canvas.updatePane', { paneId, associatedPaneIds }).catch(() => {})
    }
  } catch {
    // sync is best-effort
  }
}

function showWireTypePicker(types, onSelect) {
  removeWireTypePicker()

  const picker = document.createElement('div')
  picker.className = 'wire-type-picker'
  picker.id = 'wire-type-picker'
  picker.style.left = '50%'
  picker.style.top = '50%'
  picker.style.transform = 'translate(-50%, -50%)'

  for (const t of types) {
    const btn = document.createElement('button')
    btn.className = t
    btn.textContent = t.charAt(0).toUpperCase() + t.slice(1)
    btn.addEventListener('click', () => {
      removeWireTypePicker()
      onSelect(t)
    })
    picker.appendChild(btn)
  }

  document.body.appendChild(picker)

  setTimeout(() => {
    document.addEventListener('mousedown', dismissPicker, { once: true })
  }, 50)

  function dismissPicker(e) {
    if (!picker.contains(e.target)) removeWireTypePicker()
  }
}

function removeWireTypePicker() {
  const existing = document.getElementById('wire-type-picker')
  if (existing) existing.remove()
}

ext.onMessage((msg) => {
  if (msg.kind !== 'event') return

  if (msg.topic === 'canvas.workerStatusChange') {
    const { status } = msg.payload || {}
    if (status) updateStatus(status)
  }

  if (msg.topic === 'canvas.paneRemoved') {
    const removedPaneId = msg.payload?.paneId
    if (removedPaneId && removedPaneId === myPaneIdGlobal) {
      handleSelfRemoved()
    }
  }

  if (msg.topic === 'canvas.wireDragStarted') {
    const { fromPaneId, fromNodeType } = msg.payload || {}
    if (fromPaneId !== myPaneIdGlobal) {
      highlightValidSockets(fromNodeType)
    }
  }

  if (msg.topic === 'canvas.wireDragEnded') {
    clearSocketHighlights()
    handleWireDragEnded(msg.payload || {})
  }

  if (msg.topic === 'canvas.wireDragCancelled') {
    clearSocketHighlights()
  }

  if (msg.topic === 'canvas.wireDragSpawnRequest') {
    handleWireDragSpawnRequest(msg.payload || {})
  }
})

async function handleWireDragSpawnRequest(payload) {
  const { fromPaneId, fromNodeId, fromNodeType, targetNodeType, targetSurfaceId, x, y } = payload

  if (fromPaneId !== myPaneIdGlobal || !paneApi || !activeProjectId) return

  try {
    const nodeName = `${targetNodeType}-${Date.now().toString(36).slice(-4)}`
    const SCALE = 300
    const gridPos = { x: Math.round((x - 100) / SCALE * 10) / 10, y: Math.round((y - 100) / SCALE * 10) / 10 }

    const newNode = await paneApi.createNode(activeProjectId, { name: nodeName, type: targetNodeType, position: gridPos })
    if (!newNode?.id) return

    const result = await paneSendRequest('canvas.spawnPane', {
      kind: 'note',
      title: newNode.name || nodeName,
      extensionId: 'agentgrid.wheel',
      surfaceId: targetSurfaceId,
      x,
      y,
    })

    if (!result?.paneId) return

    const boardResult = await paneSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
    if (!boardResult?.value) return

    const board = JSON.parse(boardResult.value)
    board.paneToNode = board.paneToNode || {}
    board.nodesById = board.nodesById || {}
    board.paneToNode[result.paneId] = {
      nodeId: newNode.id,
      nodeType: targetNodeType,
      nodeName: newNode.name || nodeName,
      nodeConfig: newNode.config || {},
      wires: [],
    }
    board.nodesById[newNode.id] = newNode

    await paneSendRequest('secrets.set', { key: 'boardState', value: JSON.stringify(board) })

    const wireTypes = allowedWireTypes(fromNodeType, targetNodeType)
    if (wireTypes.length > 0) {
      await createWireAndSync(fromNodeId, newNode.id, wireTypes[0])
    }
  } catch (err) {
    console.error('[wheel:node-pane] wireDragSpawnRequest failed:', err)
  }
}

async function handleSelfRemoved() {
  if (!nodeData || !myPaneIdGlobal) return

  try {
    const surfaceId = `wheel-${nodeData.type}`
    const result = await paneSendRequest('canvas.spawnPane', {
      kind: 'note',
      title: nodeData.name,
      extensionId: 'agentgrid.wheel',
      surfaceId,
    })

    if (result?.paneId) {
      await migrateBoardEntry(myPaneIdGlobal, result.paneId)
    }
  } catch {
    // respawn failed
  }
}

async function migrateBoardEntry(oldPaneId, newPaneId) {
  try {
    const boardResult = await paneSendRequest('secrets.get', { key: 'boardState' })
    if (!boardResult?.value) return

    const board = JSON.parse(boardResult.value)
    const entry = board.paneToNode?.[oldPaneId]
    if (!entry) return

    board.paneToNode[newPaneId] = entry
    delete board.paneToNode[oldPaneId]

    await paneSendRequest('secrets.set', {
      key: 'boardState',
      value: JSON.stringify(board),
    })
  } catch {
    // migration is best-effort
  }
}

initNodePane()
