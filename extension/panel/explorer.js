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
    const board = await explorerApi.getBoard(projectId)
    const nodes = board.nodes || []
    const wires = board.wires || []
    const nodesById = {}
    for (const n of nodes) nodesById[n.id] = n

    let spawned = 0
    const nodeToPane = []

    for (const node of nodes) {
      const nodeWires = wires
        .filter(w => w.from === node.id || w.to === node.id)
        .map(w => ({
          type: w.type,
          direction: w.from === node.id ? 'outgoing' : 'incoming',
          peerName: (nodesById[w.from === node.id ? w.to : w.from] || {}).name || 'unknown',
          peerType: (nodesById[w.from === node.id ? w.to : w.from] || {}).type || 'unknown',
        }))

      const nodeState = {
        projectId,
        nodeId: node.id,
        nodeType: node.type,
        nodeName: node.name,
        nodeConfig: node.config,
        wires: nodeWires,
      }

      const body = node.type === 'agent'
        ? `**${node.type.toUpperCase()}** ${node.name}\n\nHarness: ${node.config?.harness || 'claude'}\n${node.config?.system_prompt ? `\n${node.config.system_prompt}` : ''}`
        : `**${node.type.toUpperCase()}** ${node.name}\n\n${Object.entries(node.config || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')}`

      const result = await explorerSendRequest('canvas.spawnPane', {
        kind: 'note',
        title: node.name,
        body,
      })

      if (result?.paneId) {
        nodeToPane.push([node.id, { paneId: result.paneId, type: node.type === 'agent' ? 'worker' : 'note' }])
      }

      spawned++
    }

    const paneToNode = {}
    for (const [nid, e] of nodeToPane) {
      paneToNode[e.paneId] = { nodeId: nid, nodeType: nodesById[nid]?.type, nodeName: nodesById[nid]?.name, nodeConfig: nodesById[nid]?.config }
    }

    const boardState = { projectId, paneToNode, nodesById }

    await explorerSendRequest('secrets.set', {
      key: 'boardState',
      value: JSON.stringify(boardState),
    })

    $syncDot.className = 'dot ok'
    $syncLabel.textContent = 'Synced'
    $syncDetail.textContent = `${spawned} pane${spawned === 1 ? '' : 's'} on canvas`
  } catch (err) {
    $syncDot.className = 'dot err'
    $syncLabel.textContent = 'Error'
    $syncDetail.textContent = err.message
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

    if (msg.topic === 'canvas.workerStatusChange' || msg.topic === 'canvas.paneClose') {
      refreshSyncStatus()
    }
  })
}

async function refreshSyncStatus() {
  try {
    const state = await explorerSendRequest('pane.loadState')
    if (!state?.data?.projectId) {
      $syncArea.hidden = true
      return
    }

    $syncArea.hidden = false
    const nodeCount = state.data.nodeToPane?.length ?? 0
    $syncDot.className = 'dot ok'
    $syncLabel.textContent = 'Synced'
    $syncDetail.textContent = `${nodeCount} node${nodeCount === 1 ? '' : 's'} on canvas`
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

    await refreshProjects()
    await refreshSyncStatus()
    listenForExplorerEvents()
  } catch {
    $notConfigured.hidden = false
    $configured.hidden = true
  }
}

initExplorer()
