// Wheel explorer sidebar — lightweight project picker that reads secrets
// from the extension host, lists projects, and triggers "Open on Canvas"
// via the main panel's tool handler.

const ext = window.agentGridExtension
let explorerReqId = 0
let explorerApi = null
const DEFAULT_API_URL = 'https://wheel-api-production-28d3.up.railway.app'

function explorerSendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = `exp-${++explorerReqId}`
    const cleanup = ext.onMessage((msg) => {
      if (msg.kind !== 'response' || msg.id !== id) return
      cleanup()
      if (msg.ok) resolve(msg.result)
      else reject(new Error(msg.error))
    })
    ext.postMessage({ kind: 'request', id, method, params })
  })
}

const $notConfigured = document.getElementById('not-configured')
const $configured = document.getElementById('configured')
const $connDot = document.getElementById('conn-dot')
const $connLabel = document.getElementById('conn-label')
const $peerBadge = document.getElementById('peer-badge')
const $projectList = document.getElementById('project-list')
const $projectError = document.getElementById('project-error')
const $syncArea = document.getElementById('sync-area')
const $syncDot = document.getElementById('sync-dot')
const $syncLabel = document.getElementById('sync-label')
const $syncDetail = document.getElementById('sync-detail')

async function loadExplorerSecrets() {
  const [urlResult, tokenResult] = await Promise.all([
    explorerSendRequest('secrets.get', { key: 'apiUrl' }),
    explorerSendRequest('secrets.get', { key: 'apiToken' }),
  ])
  return {
    apiUrl: urlResult?.value,
    apiToken: tokenResult?.value,
  }
}

async function refreshProjects() {
  $projectError.hidden = true
  $projectList.textContent = ''

  try {
    const projects = await explorerApi.listProjects()
    $connDot.className = 'dot ok'
    $connLabel.textContent = 'Connected'

    if (projects.length === 0) {
      const li = document.createElement('li')
      li.className = 'empty-state'
      li.textContent = 'No projects found.'
      $projectList.appendChild(li)
      return
    }

    for (const project of projects) {
      const li = document.createElement('li')
      li.className = 'project-item'

      const nameSpan = document.createElement('span')
      nameSpan.className = 'project-name'
      nameSpan.textContent = project.name || project.id

      if (project.status) {
        const statusSpan = document.createElement('span')
        statusSpan.className = `project-status ${project.status}`
        statusSpan.textContent = project.status
        nameSpan.appendChild(statusSpan)
      }

      const openBtn = document.createElement('button')
      openBtn.className = 'btn-small'
      openBtn.textContent = 'Open'
      openBtn.addEventListener('click', () => openProject(project.id))

      li.appendChild(nameSpan)
      li.appendChild(openBtn)
      $projectList.appendChild(li)
    }
  } catch (err) {
    $connDot.className = 'dot err'
    $connLabel.textContent = 'Error'
    $projectError.textContent = err.message
    $projectError.hidden = false
  }
}

async function openProject(projectId) {
  $syncArea.hidden = false
  $syncDot.className = 'dot'
  $syncLabel.textContent = 'Opening...'
  $syncDetail.textContent = ''

  try {
    const oldBoardResult = await explorerSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
    if (oldBoardResult?.value) {
      const oldBoard = JSON.parse(oldBoardResult.value)
      const oldPaneIds = Object.keys(oldBoard.paneToNode || {})
      for (const pid of oldPaneIds) {
        await explorerSendRequest('canvas.killPane', { paneId: pid }).catch(() => {})
      }
    }

    const board = await explorerApi.getBoard(projectId)
    const nodes = board.nodes || []
    const wires = board.wires || []
    const nodesById = {}
    for (const n of nodes) nodesById[n.id] = n

    let spawned = 0
    const nodeToPane = []

    for (const node of nodes) {
      const result = await explorerSendRequest('canvas.spawnPane', {
        kind: 'note',
        title: node.name,
        extensionId: 'wheel.wheel',
        surfaceId: 'wheel-node',
      })

      if (result?.paneId) {
        nodeToPane.push([node.id, { paneId: result.paneId, type: node.type === 'agent' ? 'worker' : 'note' }])
      }

      spawned++
    }

    const paneToNode = {}
    for (const [nid, entry] of nodeToPane) {
      const n = nodesById[nid]
      const nodeWires = wires
        .filter(w => w.from === nid || w.to === nid)
        .map(w => ({
          type: w.type,
          direction: w.from === nid ? 'outgoing' : 'incoming',
          peerName: (nodesById[w.from === nid ? w.to : w.from] || {}).name || 'unknown',
          peerType: (nodesById[w.from === nid ? w.to : w.from] || {}).type || 'unknown',
        }))
      paneToNode[entry.paneId] = {
        nodeId: nid,
        nodeType: n?.type,
        nodeName: n?.name,
        nodeConfig: n?.config,
        wires: nodeWires,
      }
    }

    const boardState = { projectId, paneToNode, nodesById }

    await explorerSendRequest('secrets.set', {
      key: 'boardState',
      value: JSON.stringify(boardState),
    })

    $syncDot.className = 'dot ok'
    $syncLabel.textContent = 'Synced'
    $syncDetail.textContent = `${spawned} pane${spawned === 1 ? '' : 's'} on canvas`

    showPaletteIfSynced(boardState)
    await syncWireConnections(projectId)
  } catch (err) {
    $syncDot.className = 'dot err'
    $syncLabel.textContent = 'Error'
    $syncDetail.textContent = err.message
  }
}

const $nodePalette = document.getElementById('node-palette')
const $paletteList = document.getElementById('palette-list')

const NODE_TYPES = [
  { type: 'agent',    label: 'Agent',      svg: '<path d="M9 2a2 2 0 0 1 2 2v1h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-1v1a1 1 0 0 1-2 0v-1H8v1a1 1 0 0 1-2 0v-1H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2V4a2 2 0 0 1 2-2zm0 2a.5.5 0 0 0-.5.5V5h1V4.5A.5.5 0 0 0 9 4zM7.5 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm3 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM7 11h4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>' },
  { type: 'ctx',      label: 'Context',    svg: '<rect x="4" y="2" width="10" height="14" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M7 6h4M7 9h4M7 12h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' },
  { type: 'table',    label: 'Table',      svg: '<rect x="2" y="3" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M2 7h14M2 11h14M7 7v8M11 7v8" stroke="currentColor" stroke-width="1.2"/>' },
  { type: 'endpoint', label: 'Endpoint',   svg: '<path d="M4 9h8m0 0l-3-3m3 3l-3 3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 5v8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' },
  { type: 'script',   label: 'Script',     svg: '<rect x="3" y="2" width="12" height="14" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M7 7l-2 2 2 2M11 7l2 2-2 2" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' },
  { type: 'mcp',      label: 'MCP server', svg: '<circle cx="9" cy="5" r="2.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M9 7.5V10m-3 2l3-2 3 2" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="13" r="1.2" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="12" cy="13" r="1.2" stroke="currentColor" stroke-width="1.2" fill="none"/>' },
  { type: 'vault',    label: 'Vault',      svg: '<rect x="3" y="6" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M6 6V5a3 3 0 0 1 6 0v1" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/><circle cx="9" cy="11" r="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/>' },
  { type: 'chest',    label: 'Chest',      svg: '<rect x="2" y="5" width="14" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M2 9h14" stroke="currentColor" stroke-width="1.2"/><rect x="7.5" y="7.5" width="3" height="3" rx="0.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M5 5l1-3h6l1 3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/>' },
  { type: 'tool',     label: 'Tool',       svg: '<path d="M5.5 12.5l5-5M14 5.5a3 3 0 0 0-3-3l1.5 1.5L11 5.5 9.5 4A3 3 0 0 0 13 8l-5 5a1.5 1.5 0 0 0 2.1 2.1l5-5A3 3 0 0 0 14 5.5z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' },
]

function buildPalette() {
  $paletteList.textContent = ''

  for (const nt of NODE_TYPES) {
    const btn = document.createElement('button')
    btn.className = 'palette-btn'

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 18 18')
    svg.setAttribute('width', '18')
    svg.setAttribute('height', '18')
    svg.setAttribute('aria-hidden', 'true')

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.innerHTML = nt.svg
    svg.appendChild(g)

    const labelSpan = document.createElement('span')
    labelSpan.textContent = nt.label

    btn.appendChild(svg)
    btn.appendChild(labelSpan)
    btn.addEventListener('click', () => spawnNodeFromPalette(nt.type, nt.label))
    $paletteList.appendChild(btn)
  }
}

async function spawnNodeFromPalette(type, defaultLabel) {
  const boardResult = await explorerSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
  if (!boardResult?.value) return

  const board = JSON.parse(boardResult.value)
  if (!board.projectId || !explorerApi) return

  const name = prompt(`Name for new ${defaultLabel} node:`, `${defaultLabel} ${Date.now() % 1000}`)
  if (!name) return

  try {
    const node = await explorerApi.createNode(board.projectId, { type, name, config: {} })

    const result = await explorerSendRequest('canvas.spawnPane', {
      kind: 'note',
      title: name,
      extensionId: 'wheel.wheel',
      surfaceId: 'wheel-node',
    })

    if (result?.paneId && node?.id) {
      board.paneToNode = board.paneToNode || {}
      board.paneToNode[result.paneId] = {
        nodeId: node.id,
        nodeType: type,
        nodeName: name,
        nodeConfig: node.config || {},
        wires: [],
      }
      board.nodesById = board.nodesById || {}
      board.nodesById[node.id] = node

      await explorerSendRequest('secrets.set', {
        key: 'boardState',
        value: JSON.stringify(board),
      })

      await syncWireConnections(board.projectId)
      refreshSyncStatus()
    }
  } catch (err) {
    $syncDot.className = 'dot err'
    $syncLabel.textContent = 'Error'
    $syncDetail.textContent = err.message
  }
}

function showPaletteIfSynced(boardState) {
  $nodePalette.hidden = !boardState?.projectId
}

async function syncWireConnections(projectId) {
  if (!explorerApi || !projectId) return

  try {
    const boardResult = await explorerSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
    if (!boardResult?.value) return

    const board = JSON.parse(boardResult.value)
    const paneToNode = board.paneToNode || {}

    const apiBoard = await explorerApi.getBoard(projectId)
    const wires = apiBoard.wires || []

    const nodeIdToPane = {}
    for (const [paneId, entry] of Object.entries(paneToNode)) {
      nodeIdToPane[entry.nodeId] = paneId
    }

    const paneAssociations = {}
    for (const paneId of Object.keys(paneToNode)) {
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

      await explorerSendRequest('canvas.updatePane', { paneId, associatedPaneIds }).catch(() => {})
    }
  } catch {
    // wire sync is best-effort
  }
}

function updatePeerBadge(count) {
  if (count > 0) {
    $peerBadge.textContent = `${count} peer${count === 1 ? '' : 's'}`
    $peerBadge.hidden = false
  } else {
    $peerBadge.hidden = true
  }
}

function listenForExplorerEvents() {
  ext.onMessage((msg) => {
    if (msg.kind !== 'event') return

    if (msg.topic === 'canvas.workerStatusChange') {
      refreshSyncStatus()
    }

    if (msg.topic === 'canvas.paneRemoved') {
      const paneId = msg.payload?.paneId
      if (paneId) handlePaneRemoved(paneId)
    }
  })
}

async function handlePaneRemoved(paneId) {
  try {
    const boardResult = await explorerSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
    if (!boardResult?.value) return

    const board = JSON.parse(boardResult.value)
    const entry = board.paneToNode?.[paneId]
    if (!entry) return

    if (explorerApi && board.projectId && entry.nodeId) {
      await explorerApi.deleteNode(board.projectId, entry.nodeId).catch(() => {})
    }

    delete board.paneToNode[paneId]

    await explorerSendRequest('secrets.set', {
      key: 'boardState',
      value: JSON.stringify(board),
    })

    refreshSyncStatus()
    await syncWireConnections(board.projectId)
  } catch {
    // cleanup failed — not fatal
  }
}

async function refreshSyncStatus() {
  try {
    const boardResult = await explorerSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)

    if (!boardResult?.value) {
      $syncArea.hidden = true
      showPaletteIfSynced(null)
      return
    }

    const board = JSON.parse(boardResult.value)

    if (!board.projectId) {
      $syncArea.hidden = true
      showPaletteIfSynced(null)
      return
    }

    $syncArea.hidden = false
    const nodeCount = Object.keys(board.paneToNode || {}).length
    $syncDot.className = 'dot ok'
    $syncLabel.textContent = 'Synced'
    $syncDetail.textContent = `${nodeCount} node${nodeCount === 1 ? '' : 's'} on canvas`

    showPaletteIfSynced(board)
  } catch {
    // state load failed — not fatal
  }
}

document.getElementById('btn-refresh').addEventListener('click', initExplorer)
document.getElementById('btn-retry')?.addEventListener('click', initExplorer)

async function initExplorer() {
  try {
    const secrets = await loadExplorerSecrets()
    const url = secrets.apiUrl
    const token = secrets.apiToken

    const effectiveUrl = url || DEFAULT_API_URL

    if (!token) {
      $notConfigured.hidden = false
      $configured.hidden = true
      return
    }

    explorerApi = new WheelApi(effectiveUrl, token)
    $notConfigured.hidden = true
    $configured.hidden = false

    buildPalette()
    await refreshProjects()
    await refreshSyncStatus()
    listenForExplorerEvents()
  } catch {
    $notConfigured.hidden = false
    $configured.hidden = true
  }
}

initExplorer()
