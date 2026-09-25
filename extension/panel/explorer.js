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
const $nodeList = document.getElementById('node-list')

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

async function killAllWheelPanes() {
  suppressPaneRemoved = true
  await explorerSendRequest('canvas.killAllPanes', {}).catch(() => {})
  suppressPaneRemoved = false
}

async function openProject(projectId) {
  $syncArea.hidden = false
  $syncDot.className = 'dot'
  $syncLabel.textContent = 'Opening...'
  $syncDetail.textContent = ''

  try {
    await killAllWheelPanes()

    await explorerSendRequest('secrets.set', {
      key: 'boardState',
      value: JSON.stringify({ spawning: true }),
    })

    const board = await explorerApi.getBoard(projectId)
    const nodes = board.nodes || []
    const wires = board.wires || []
    const nodesById = {}
    for (const n of nodes) nodesById[n.id] = n

    const SCALE = 300
    const OFFSET_X = 100
    const OFFSET_Y = 100

    const boardState = { projectId, paneToNode: {}, nodesById, spawning: true }

    const spawnResults = []
    for (const node of nodes) {
      const surfaceId = `wheel-${node.type}`
      const pos = node.position || { x: 0, y: 0 }
      const result = await explorerSendRequest('canvas.spawnPane', {
        kind: 'note',
        title: node.name,
        extensionId: 'agentgrid.wheel',
        surfaceId,
        x: OFFSET_X + pos.x * SCALE,
        y: OFFSET_Y + pos.y * SCALE,
      })

      if (result?.paneId) {
        spawnResults.push({ paneId: result.paneId, node })
      }
    }

    for (const { paneId, node } of spawnResults) {
      const nodeWires = wires
        .filter(w => w.from === node.id || w.to === node.id)
        .map(w => ({
          type: w.type,
          direction: w.from === node.id ? 'outgoing' : 'incoming',
          peerName: (nodesById[w.from === node.id ? w.to : w.from] || {}).name || 'unknown',
          peerType: (nodesById[w.from === node.id ? w.to : w.from] || {}).type || 'unknown',
        }))
      boardState.paneToNode[paneId] = {
        nodeId: node.id,
        nodeType: node.type,
        nodeName: node.name,
        nodeConfig: node.config,
        wires: nodeWires,
      }
    }

    boardState.spawning = false

    await explorerSendRequest('secrets.set', {
      key: 'boardState',
      value: JSON.stringify(boardState),
    })

    await syncWireConnections(projectId)
    await refreshSyncStatus()
  } catch (err) {
    $syncDot.className = 'dot err'
    $syncLabel.textContent = 'Error'
    $syncDetail.textContent = err.message
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
  if (suppressPaneRemoved) return

  try {
    const boardResult = await explorerSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
    if (!boardResult?.value) return

    const board = JSON.parse(boardResult.value)
    if (!board.projectId) return

    const entry = board.paneToNode?.[paneId]
    if (!entry) return

    entry.closedPaneId = paneId
    board.closedNodes = board.closedNodes || {}
    board.closedNodes[entry.nodeId] = entry
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

function renderNodeList(board) {
  $nodeList.textContent = ''
  const paneToNode = board?.paneToNode || {}
  const closedNodes = board?.closedNodes || {}

  for (const [paneId, entry] of Object.entries(paneToNode)) {
    const li = document.createElement('li')
    li.className = 'node-item'

    const tag = document.createElement('span')
    tag.className = 'node-type-tag'
    tag.textContent = entry.nodeType || '?'
    li.appendChild(tag)

    const name = document.createElement('span')
    name.className = 'node-item-name'
    name.textContent = entry.nodeName || entry.nodeId
    li.appendChild(name)

    const del = document.createElement('button')
    del.className = 'node-delete-btn'
    del.textContent = '\u00d7'
    del.title = 'Delete node'
    del.addEventListener('click', () => deleteNodeFromExplorer(paneId, entry, board.projectId))
    li.appendChild(del)

    $nodeList.appendChild(li)
  }

  for (const [nodeId, entry] of Object.entries(closedNodes)) {
    const li = document.createElement('li')
    li.className = 'node-item node-item-closed'
    li.title = 'Click to reopen on canvas'
    li.style.opacity = '0.5'
    li.style.cursor = 'pointer'

    const tag = document.createElement('span')
    tag.className = 'node-type-tag'
    tag.textContent = entry.nodeType || '?'
    li.appendChild(tag)

    const name = document.createElement('span')
    name.className = 'node-item-name'
    name.textContent = entry.nodeName || nodeId
    li.appendChild(name)

    li.addEventListener('click', () => respawnClosedNode(nodeId, entry, board.projectId))

    const del = document.createElement('button')
    del.className = 'node-delete-btn'
    del.textContent = '\u00d7'
    del.title = 'Delete node'
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      deleteClosedNode(nodeId, entry, board.projectId)
    })
    li.appendChild(del)

    $nodeList.appendChild(li)
  }
}

async function respawnClosedNode(nodeId, entry, projectId) {
  try {
    const surfaceId = `wheel-${entry.nodeType}`
    const SCALE = 300
    const OFFSET_X = 100
    const OFFSET_Y = 100

    const nodeInfo = entry.nodeConfig?.position || { x: 0, y: 0 }
    const boardResult = await explorerSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
    if (!boardResult?.value) return
    const board = JSON.parse(boardResult.value)
    const pos = board.nodesById?.[nodeId]?.position || nodeInfo

    const result = await explorerSendRequest('canvas.spawnPane', {
      kind: 'note',
      title: entry.nodeName || nodeId,
      extensionId: 'agentgrid.wheel',
      surfaceId,
      x: OFFSET_X + (pos.x || 0) * SCALE,
      y: OFFSET_Y + (pos.y || 0) * SCALE,
    })

    if (!result?.paneId) return

    board.paneToNode = board.paneToNode || {}
    const restored = { ...entry }
    delete restored.closedPaneId
    board.paneToNode[result.paneId] = restored

    delete board.closedNodes[nodeId]
    if (Object.keys(board.closedNodes).length === 0) delete board.closedNodes

    await explorerSendRequest('secrets.set', {
      key: 'boardState',
      value: JSON.stringify(board),
    })

    await syncWireConnections(projectId)
    refreshSyncStatus()
  } catch {
    // respawn failed — not fatal
  }
}

async function deleteClosedNode(nodeId, entry, projectId) {
  try {
    if (explorerApi && projectId) {
      await explorerApi.deleteNode(projectId, nodeId).catch(() => {})
    }

    const boardResult = await explorerSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
    if (boardResult?.value) {
      const board = JSON.parse(boardResult.value)
      if (board.closedNodes) delete board.closedNodes[nodeId]
      if (board.nodesById) delete board.nodesById[nodeId]
      await explorerSendRequest('secrets.set', {
        key: 'boardState',
        value: JSON.stringify(board),
      })
    }

    refreshSyncStatus()
  } catch {
    // delete failed — not fatal
  }
}

async function deleteNodeFromExplorer(paneId, entry, projectId) {
  try {
    if (explorerApi && projectId && entry.nodeId) {
      await explorerApi.deleteNode(projectId, entry.nodeId).catch(() => {})
    }

    await explorerSendRequest('canvas.killPane', { paneId }).catch(() => {})

    const boardResult = await explorerSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
    if (boardResult?.value) {
      const board = JSON.parse(boardResult.value)
      delete board.paneToNode[paneId]
      await explorerSendRequest('secrets.set', {
        key: 'boardState',
        value: JSON.stringify(board),
      })
    }

    refreshSyncStatus()
  } catch {
    // delete failed — not fatal
  }
}

async function refreshSyncStatus() {
  try {
    const boardResult = await explorerSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)

    if (!boardResult?.value) {
      $syncArea.hidden = true
      return
    }

    const board = JSON.parse(boardResult.value)

    if (!board.projectId) {
      $syncArea.hidden = true
      return
    }

    $syncArea.hidden = false
    const activeCount = Object.keys(board.paneToNode || {}).length
    const closedCount = Object.keys(board.closedNodes || {}).length
    const totalCount = activeCount + closedCount
    $syncDot.className = 'dot ok'
    $syncLabel.textContent = 'Synced'
    const parts = [`${activeCount} on canvas`]
    if (closedCount > 0) parts.push(`${closedCount} closed`)
    $syncDetail.textContent = `${totalCount} node${totalCount === 1 ? '' : 's'} — ${parts.join(', ')}`
    renderNodeList(board)

  } catch {
    // state load failed — not fatal
  }
}

async function stopProject() {
  try {
    await killAllWheelPanes()

    await explorerSendRequest('secrets.set', {
      key: 'boardState',
      value: JSON.stringify({ projectId: null, paneToNode: {}, nodesById: {} }),
    })

    $syncArea.hidden = true
    $nodeList.textContent = ''
  } catch {
    suppressPaneRemoved = false
  }
}

document.getElementById('btn-refresh').addEventListener('click', initExplorer)
document.getElementById('btn-retry')?.addEventListener('click', initExplorer)
document.getElementById('btn-sync')?.addEventListener('click', syncFromWheel)
document.getElementById('btn-stop')?.addEventListener('click', stopProject)

let boardSyncTimer = null
let suppressPaneRemoved = false

async function syncFromWheel() {
  if (!explorerApi) return

  $syncDot.className = 'dot'
  $syncLabel.textContent = 'Syncing...'

  try {
    const boardResult = await explorerSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
    if (!boardResult?.value) return

    const board = JSON.parse(boardResult.value)
    if (!board.projectId) return

    const apiBoard = await explorerApi.getBoard(board.projectId)
    const remoteNodes = apiBoard.nodes || []
    const remoteWires = apiBoard.wires || []
    const remoteNodeIds = new Set(remoteNodes.map(n => n.id))
    const remoteNodesById = {}
    for (const n of remoteNodes) remoteNodesById[n.id] = n

    const paneToNode = board.paneToNode || {}
    const localNodeIds = new Set(Object.values(paneToNode).map(e => e.nodeId))

    const stalePaneIds = []
    for (const [paneId, entry] of Object.entries(paneToNode)) {
      if (!remoteNodeIds.has(entry.nodeId)) {
        stalePaneIds.push(paneId)
      }
    }
    for (const paneId of stalePaneIds) {
      delete paneToNode[paneId]
      await explorerSendRequest('canvas.killPane', { paneId }).catch(() => {})
    }

    const SCALE = 300
    const OFFSET_X = 100
    const OFFSET_Y = 100

    for (const node of remoteNodes) {
      if (localNodeIds.has(node.id)) continue

      const surfaceId = `wheel-${node.type}`
      const pos = node.position || { x: 0, y: 0 }
      const result = await explorerSendRequest('canvas.spawnPane', {
        kind: 'note',
        title: node.name,
        extensionId: 'agentgrid.wheel',
        surfaceId,
        x: OFFSET_X + pos.x * SCALE,
        y: OFFSET_Y + pos.y * SCALE,
      })

      if (result?.paneId) {
        const nodeWires = remoteWires
          .filter(w => w.from === node.id || w.to === node.id)
          .map(w => ({
            type: w.type,
            direction: w.from === node.id ? 'outgoing' : 'incoming',
            peerName: (remoteNodesById[w.from === node.id ? w.to : w.from] || {}).name || 'unknown',
            peerType: (remoteNodesById[w.from === node.id ? w.to : w.from] || {}).type || 'unknown',
          }))
        paneToNode[result.paneId] = {
          nodeId: node.id,
          nodeType: node.type,
          nodeName: node.name,
          nodeConfig: node.config,
          wires: nodeWires,
        }

        await explorerSendRequest('secrets.set', {
          key: 'boardState',
          value: JSON.stringify(board),
        })
      }
    }

    board.nodesById = remoteNodesById

    await explorerSendRequest('secrets.set', {
      key: 'boardState',
      value: JSON.stringify(board),
    })

    await syncWireConnections(board.projectId)
    await refreshSyncStatus()
  } catch (err) {
    $syncDot.className = 'dot err'
    $syncLabel.textContent = 'Sync failed'
    $syncDetail.textContent = err.message
  }
}

async function pollBoardSync() {
  if (!explorerApi) return

  try {
    const boardResult = await explorerSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
    if (!boardResult?.value) return

    const board = JSON.parse(boardResult.value)
    if (!board.projectId) return

    const paneToNode = board.paneToNode || {}
    const localNodeIds = new Set(Object.values(paneToNode).map(e => e.nodeId))
    if (localNodeIds.size === 0) return

    const apiBoard = await explorerApi.getBoard(board.projectId)
    const remoteNodeIds = new Set((apiBoard.nodes || []).map(n => n.id))

    const stalePaneIds = []
    for (const [paneId, entry] of Object.entries(paneToNode)) {
      if (!remoteNodeIds.has(entry.nodeId)) {
        stalePaneIds.push(paneId)
      }
    }

    if (stalePaneIds.length === 0) {
      refreshSyncStatus()
      return
    }

    for (const paneId of stalePaneIds) {
      delete paneToNode[paneId]
      await explorerSendRequest('canvas.killPane', { paneId }).catch(() => {})
    }

    await explorerSendRequest('secrets.set', {
      key: 'boardState',
      value: JSON.stringify(board),
    })

    refreshSyncStatus()
    await syncWireConnections(board.projectId)
  } catch {
    // poll failed — not fatal
  }
}

function startBoardSync() {
  if (boardSyncTimer) clearInterval(boardSyncTimer)
  boardSyncTimer = setInterval(pollBoardSync, 5000)
}

async function initExplorer() {
  console.log('[wheel:explorer] initExplorer starting')
  try {
    const secrets = await loadExplorerSecrets()
    const url = secrets.apiUrl
    const token = secrets.apiToken
    console.log('[wheel:explorer] secrets loaded, url:', url || '(default)', 'token:', token ? '***' + token.slice(-4) : '(none)')

    const effectiveUrl = url || DEFAULT_API_URL

    if (!token) {
      console.log('[wheel:explorer] no token, showing not-configured')
      $notConfigured.hidden = false
      $configured.hidden = true
      return
    }

    explorerApi = new WheelApi(effectiveUrl, token)
    $notConfigured.hidden = true
    $configured.hidden = false

    await refreshProjects()
    await refreshSyncStatus()
    listenForExplorerEvents()
    startBoardSync()
    console.log('[wheel:explorer] initExplorer complete')
  } catch (err) {
    console.error('[wheel:explorer] initExplorer error:', err)
    $notConfigured.hidden = false
    $configured.hidden = true
  }
}

initExplorer()
