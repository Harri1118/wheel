const ext = window.agentGridExtension
let paneReqId = 0

const DEFAULT_API_URL = 'https://wheel-api-production-28d3.up.railway.app'

function paneSendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = `np-${++paneReqId}`
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('timeout'))
    }, 8000)
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

async function initNodePane() {
  try {
    const state = await paneSendRequest('pane.loadState')
    if (!state?.data?.projectId || !state?.data?.nodeId) {
      $loading.textContent = 'No node data.'
      return
    }

    const { projectId, nodeId, nodeType, nodeName, nodeConfig, wires } = state.data

    const [urlResult, tokenResult] = await Promise.all([
      paneSendRequest('secrets.get', { key: 'apiUrl' }),
      paneSendRequest('secrets.get', { key: 'apiToken' }),
    ])

    const apiUrl = urlResult?.value || DEFAULT_API_URL
    const apiToken = tokenResult?.value || ''

    if (apiToken) {
      paneApi = new WheelApi(apiUrl, apiToken)
    }

    nodeData = { id: nodeId, type: nodeType, name: nodeName, config: nodeConfig || {}, wires: wires || [] }

    renderNode(nodeData)

    if (paneApi && nodeType === 'agent') {
      pollAgentStatus(projectId, nodeId)
    }
  } catch (err) {
    $loading.textContent = err.message
  }
}

function renderNode(node) {
  $card.textContent = ''

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

  if (node.type === 'agent') {
    const statusRow = document.createElement('div')
    statusRow.className = 'status-row'
    statusRow.id = 'status-row'

    const dot = document.createElement('span')
    dot.className = 'status-dot stopped'
    dot.id = 'status-dot'
    statusRow.appendChild(dot)

    const label = document.createElement('span')
    label.id = 'status-label'
    label.textContent = 'Stopped'
    statusRow.appendChild(label)

    const cfg = node.config || {}
    if (cfg.harness) {
      const harness = document.createElement('span')
      harness.className = 'harness-label'
      harness.textContent = cfg.harness
      statusRow.appendChild(harness)
    }

    $card.appendChild(statusRow)
  }

  if (node.wires && node.wires.length > 0) {
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

  if (node.type !== 'agent' && node.config) {
    const preview = document.createElement('div')
    preview.className = 'config-preview'

    const keys = Object.keys(node.config).filter(k => {
      const v = node.config[k]
      return v !== '' && v !== null && v !== undefined
    })

    preview.textContent = keys.length > 0 ? keys.join(', ') : ''
    if (preview.textContent) $card.appendChild(preview)
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

ext.onMessage((msg) => {
  if (msg.kind !== 'event') return

  if (msg.topic === 'canvas.workerStatusChange') {
    const { status } = msg.payload || {}
    if (status) updateStatus(status)
  }
})

initNodePane()
