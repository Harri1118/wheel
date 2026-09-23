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
const $paletteGrid = document.getElementById('palette-grid')

const NODE_TYPES = [
  { type: 'agent',    icon: '\u{1F916}', label: 'Agent' },
  { type: 'ctx',      icon: '\u{1F4C4}', label: 'Context' },
  { type: 'table',    icon: '\u{1F4CA}', label: 'Table' },
  { type: 'endpoint', icon: '\u{1F50C}', label: 'Endpoint' },
  { type: 'script',   icon: '\u26A1',     label: 'Script' },
  { type: 'mcp',      icon: '\u{1F527}', label: 'MCP' },
  { type: 'vault',    icon: '\u{1F510}', label: 'Vault' },
  { type: 'chest',    icon: '\u{1F4E6}', label: 'Chest' },
  { type: 'tool',     icon: '\u{1F6E0}', label: 'Tool' },
]

function buildPalette() {
  $paletteGrid.textContent = ''

  for (const nt of NODE_TYPES) {
    const btn = document.createElement('button')
    btn.className = 'palette-btn'

    const iconSpan = document.createElement('span')
    iconSpan.className = 'palette-icon'
    iconSpan.textContent = nt.icon

    const labelSpan = document.createElement('span')
    labelSpan.className = 'palette-label'
    labelSpan.textContent = nt.label

    btn.appendChild(iconSpan)
    btn.appendChild(labelSpan)
    btn.addEventListener('click', () => spawnNodeFromPalette(nt.type, nt.label))
    $paletteGrid.appendChild(btn)
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
  if (boardState?.projectId && Object.keys(boardState.paneToNode || {}).length > 0) {
    $nodePalette.hidden = false
  } else {
    $nodePalette.hidden = true
  }
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
