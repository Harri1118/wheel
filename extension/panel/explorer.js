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

async function openProject(projectId) {
  console.log('[wheel:explorer] openProject called, projectId:', projectId)
  $syncArea.hidden = false
  $syncDot.className = 'dot'
  $syncLabel.textContent = 'Opening...'
  $syncDetail.textContent = ''

  try {
    const oldBoardResult = await explorerSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
    if (oldBoardResult?.value) {
      const oldBoard = JSON.parse(oldBoardResult.value)
      const oldPaneIds = Object.keys(oldBoard.paneToNode || {})
      console.log('[wheel:explorer] cleaning up old panes:', oldPaneIds)
      for (const pid of oldPaneIds) {
        await explorerSendRequest('canvas.killPane', { paneId: pid }).catch(() => {})
      }
    }

    console.log('[wheel:explorer] fetching board from API...')
    const board = await explorerApi.getBoard(projectId)
    const nodes = board.nodes || []
    const wires = board.wires || []
    console.log('[wheel:explorer] board fetched, nodes:', nodes.length, 'wires:', wires.length)
    const nodesById = {}
    for (const n of nodes) nodesById[n.id] = n

    let spawned = 0
    const nodeToPane = []

    const SCALE = 300
    const OFFSET_X = 100
    const OFFSET_Y = 100

    for (const node of nodes) {
      const surfaceId = `wheel-${node.type}`
      const pos = node.position || { x: 0, y: 0 }
      console.log('[wheel:explorer] spawning pane for node:', node.name, 'type:', node.type, 'surface:', surfaceId, 'pos:', pos)
      const result = await explorerSendRequest('canvas.spawnPane', {
        kind: 'note',
        title: node.name,
        extensionId: 'wheel.wheel',
        surfaceId,
        x: OFFSET_X + pos.x * SCALE,
        y: OFFSET_Y + pos.y * SCALE,
      })
      console.log('[wheel:explorer] spawnPane result:', JSON.stringify(result))

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
    console.log('[wheel:explorer] saving boardState, paneToNode keys:', Object.keys(paneToNode))
    console.log('[wheel:explorer] boardState:', JSON.stringify(boardState).slice(0, 500))

    await explorerSendRequest('secrets.set', {
      key: 'boardState',
      value: JSON.stringify(boardState),
    })
    console.log('[wheel:explorer] boardState saved successfully')

    $syncDot.className = 'dot ok'
    $syncLabel.textContent = 'Synced'
    $syncDetail.textContent = `${spawned} pane${spawned === 1 ? '' : 's'} on canvas`

    await syncWireConnections(projectId)
  } catch (err) {
    console.error('[wheel:explorer] openProject error:', err)
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

function renderNodeList(board) {
  $nodeList.textContent = ''
  const paneToNode = board?.paneToNode || {}
  const entries = Object.entries(paneToNode)

  for (const [paneId, entry] of entries) {
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
    const nodeCount = Object.keys(board.paneToNode || {}).length
    $syncDot.className = 'dot ok'
    $syncLabel.textContent = 'Synced'
    $syncDetail.textContent = `${nodeCount} node${nodeCount === 1 ? '' : 's'} on canvas`
    renderNodeList(board)

  } catch {
    // state load failed — not fatal
  }
}

document.getElementById('btn-refresh').addEventListener('click', initExplorer)
document.getElementById('btn-retry')?.addEventListener('click', initExplorer)

let boardSyncTimer = null

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

    if (stalePaneIds.length === 0) return

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
