// Wheel node inspector — explorer section panel that shows details about
// the currently selected Wheel-backed pane on the canvas. Enhanced with
// live agent status, log tail, and message queue depth.

const ext = window.agentGridExtension
let inspectorReqId = 0
let inspectorSync = null
let inspectorApi = null
let logPollTimer = null
let logCursor = 0
let currentNodeId = null

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

function showNode(node) {
  $empty.hidden = true
  $content.hidden = false
  $content.textContent = ''

  currentNodeId = node.id

  const header = document.createElement('div')
  header.className = 'node-header'

  const badge = document.createElement('span')
  badge.className = 'node-type-badge'
  badge.textContent = node.type
  header.appendChild(badge)

  const name = document.createElement('span')
  name.className = 'node-name'
  name.textContent = node.name
  header.appendChild(name)

  $content.appendChild(header)

  const idSection = document.createElement('div')
  idSection.className = 'config-item'
  const idKey = document.createElement('span')
  idKey.className = 'config-key'
  idKey.textContent = 'ID: '
  const idValue = document.createElement('span')
  idValue.className = 'config-value'
  idValue.textContent = node.id
  idSection.appendChild(idKey)
  idSection.appendChild(idValue)
  $content.appendChild(idSection)

  if (node.type === 'agent') {
    renderAgentSection(node)
  }

  if (node.wires && node.wires.length > 0) {
    renderWiresSection(node.wires)
  }

  if (node.config) {
    renderConfigSection(node.config)
  }
}

function renderAgentSection(node) {
  const section = document.createElement('div')
  section.className = 'section'

  const title = document.createElement('h3')
  title.textContent = 'Agent'
  section.appendChild(title)

  const statusRow = document.createElement('div')
  statusRow.className = 'config-item'
  statusRow.id = 'agent-status-row'

  const statusKey = document.createElement('span')
  statusKey.className = 'config-key'
  statusKey.textContent = 'Status: '
  statusRow.appendChild(statusKey)

  const statusValue = document.createElement('span')
  statusValue.className = 'agent-status'
  statusValue.id = 'agent-status-value'
  statusValue.textContent = 'unknown'
  statusRow.appendChild(statusValue)

  section.appendChild(statusRow)

  const cfg = node.config || {}
  if (cfg.harness) {
    const harnessRow = document.createElement('div')
    harnessRow.className = 'config-item'
    const hk = document.createElement('span')
    hk.className = 'config-key'
    hk.textContent = 'Harness: '
    const hv = document.createElement('span')
    hv.className = 'config-value'
    hv.textContent = cfg.harness
    harnessRow.appendChild(hk)
    harnessRow.appendChild(hv)
    section.appendChild(harnessRow)
  }

  const logTitle = document.createElement('h3')
  logTitle.textContent = 'Log'
  logTitle.style.marginTop = '8px'
  section.appendChild(logTitle)

  const logContainer = document.createElement('div')
  logContainer.id = 'agent-log'
  logContainer.className = 'agent-log'
  section.appendChild(logContainer)

  $content.appendChild(section)

  startLogPolling(node.id)
}

function renderWiresSection(wires) {
  const wireSection = document.createElement('div')
  wireSection.className = 'section'

  const wireTitle = document.createElement('h3')
  wireTitle.textContent = 'Wires'
  wireSection.appendChild(wireTitle)

  const wireList = document.createElement('ul')
  wireList.className = 'wire-list'

  for (const w of wires) {
    const li = document.createElement('li')

    const dir = document.createElement('span')
    dir.className = 'wire-dir'
    dir.textContent = w.direction === 'outgoing' ? '\u2192 ' : '\u2190 '
    li.appendChild(dir)

    const wireType = document.createElement('span')
    wireType.className = `wire-type-${w.type}`
    wireType.textContent = w.type
    li.appendChild(wireType)

    const peer = document.createElement('span')
    peer.textContent = ` ${w.direction === 'outgoing' ? 'to' : 'from'} ${w.peerName} (${w.peerType})`
    li.appendChild(peer)

    wireList.appendChild(li)
  }

  wireSection.appendChild(wireList)
  $content.appendChild(wireSection)
}

function renderConfigSection(config) {
  const configSection = document.createElement('div')
  configSection.className = 'section'

  const configTitle = document.createElement('h3')
  configTitle.textContent = 'Config'
  configSection.appendChild(configTitle)

  for (const [key, value] of Object.entries(config)) {
    if (value === '' || value === null || value === undefined) continue
    if (typeof value === 'object' && Object.keys(value).length === 0) continue
    if (key === 'system_prompt') continue

    const item = document.createElement('div')
    item.className = 'config-item'

    const keySpan = document.createElement('span')
    keySpan.className = 'config-key'
    keySpan.textContent = `${key}: `
    item.appendChild(keySpan)

    const valueSpan = document.createElement('span')
    valueSpan.className = 'config-value'
    valueSpan.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value)
    item.appendChild(valueSpan)

    configSection.appendChild(item)
  }

  $content.appendChild(configSection)
}

function startLogPolling(nodeId) {
  stopLogPolling()

  if (!inspectorApi || !inspectorSync?.activeProjectId) return

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
  if (!inspectorApi || !inspectorSync?.activeProjectId) return

  try {
    const log = await inspectorApi.agentLog(
      inspectorSync.activeProjectId,
      nodeId,
      { since: logCursor }
    )
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

    const maxLines = 100
    while (logContainer.children.length > maxLines) {
      logContainer.removeChild(logContainer.firstChild)
    }

    logContainer.scrollTop = logContainer.scrollHeight
  } catch {
    // log fetch failed — not fatal
  }
}

function updateAgentStatus(status) {
  const el = document.getElementById('agent-status-value')
  if (!el) return

  el.textContent = status
  el.className = 'agent-status'
  if (status === 'running') el.classList.add('status-running')
  else if (status === 'idle') el.classList.add('status-idle')
  else if (status === 'error' || status === 'rate_limited') el.classList.add('status-error')
}

async function initInspector() {
  inspectorSync = new BoardSync(inspectorSendRequest)
  const restored = await inspectorSync.restoreState()

  try {
    const secrets = await loadInspectorSecrets()
    if (secrets.apiUrl) {
      inspectorApi = new WheelApi(secrets.apiUrl, secrets.apiToken || '')
    }
  } catch {
    // secrets load failed — inspector works without API, just no log tail
  }

  if (!restored) {
    showEmpty('No Wheel project synced. Open a project from the main Wheel panel.')
    return
  }

  showEmpty(`Project: ${inspectorSync.activeProjectId} \u2014 ${inspectorSync.mappedNodeCount} nodes synced. Click a Wheel-backed pane to inspect.`)

  listenForInspectorEvents()
}

async function loadInspectorSecrets() {
  const secrets = await inspectorSendRequest('secrets.list')
  const map = {}
  if (Array.isArray(secrets)) {
    for (const s of secrets) map[s.key] = s.value
  }
  return map
}

function listenForInspectorEvents() {
  ext.onMessage((msg) => {
    if (msg.kind !== 'event') return

    if (msg.topic === 'canvas.paneMoved') {
      const paneId = msg.payload?.paneId
      if (!paneId || !inspectorSync) return
      const node = inspectorSync.nodeForPane(paneId)
      if (node) showNode(node)
    }

    if (msg.topic === 'canvas.paneClose') {
      const paneId = msg.payload?.paneId
      if (!paneId || !inspectorSync) return

      const node = inspectorSync.nodeForPane(paneId)
      if (node && node.id === currentNodeId) {
        showEmpty('Node removed from canvas.')
      }
    }

    if (msg.topic === 'canvas.workerStatusChange') {
      const { paneId, status } = msg.payload || {}
      if (!paneId || !inspectorSync) return

      const entry = inspectorSync.paneToNode.get(paneId)
      if (entry?.nodeId === currentNodeId) {
        updateAgentStatus(status)
      }
    }
  })
}

initInspector()
