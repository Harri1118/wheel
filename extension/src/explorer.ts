import { SSEStream, createPanel } from '@agentgrid/sdk'
import type { PanelClient } from '@agentgrid/sdk'
import { associatePanesByWires, readBoardState, summarizeWires, writeBoardState } from './board-state'
import { byId } from './dom'
import { indexNodes } from './spawn-plan'
import { DEFAULT_API_URL, WHEEL_EXTENSION_ID, errorMessage, surfaceIdFor } from './types'
import type { PaneEntry, SharedBoardState, WheelNode, WheelWire } from './types'
import { WheelApi } from './wheel-api'

type BuilderEventData = { text?: string; message?: string }

const BOARD_POLL_MS = 5000
const BUILDER_CLOSE_DELAY_MS = 1500
const BUILDER_PREVIEW_CHARS = 200

const $notConfigured = byId('not-configured')
const $configured = byId('configured')
const $connDot = byId('conn-dot')
const $connLabel = byId('conn-label')
const $peerBadge = byId('peer-badge')
const $projectList = byId('project-list')
const $projectError = byId('project-error')
const $syncArea = byId('sync-area')
const $syncDot = byId('sync-dot')
const $syncLabel = byId('sync-label')
const $syncDetail = byId('sync-detail')
const $nodeList = byId('node-list')
const $builderInline = byId('builder-inline')
const $builderPrompt = byId<HTMLTextAreaElement>('builder-prompt')
const $builderStatus = byId('builder-status')
const $builderGo = byId<HTMLButtonElement>('builder-go')
const $builderCancel = byId<HTMLButtonElement>('builder-cancel')
const $btnBuilder = byId('btn-builder')

let panel!: PanelClient
let explorerApi: WheelApi | null = null
let boardSyncTimer: ReturnType<typeof setInterval> | null = null
let suppressPaneRemoved = false
let listeningForCanvasEvents = false

start()

async function start(): Promise<void> {
  try {
    panel = await createPanel()
  } catch (err) {
    console.error('[wheel:explorer] createPanel error:', err)
    showNotConfigured()
    return
  }

  byId('btn-refresh').addEventListener('click', initExplorer)
  byId('btn-retry').addEventListener('click', initExplorer)
  byId('btn-sync').addEventListener('click', syncFromWheel)
  byId('btn-stop').addEventListener('click', stopProject)
  $btnBuilder.addEventListener('click', openBuilder)
  $builderCancel.addEventListener('click', closeBuilder)
  $builderGo.addEventListener('click', runBuilder)

  await initExplorer()
}

async function initExplorer(): Promise<void> {
  console.log('[wheel:explorer] initExplorer starting')

  try {
    const [url, token] = await Promise.all([panel.secrets.get('apiUrl'), panel.secrets.get('apiToken')])

    console.log('[wheel:explorer] secrets loaded, url:', url || '(default)', 'token:', token ? '***' + token.slice(-4) : '(none)')

    if (!token) {
      console.log('[wheel:explorer] no token, showing not-configured')
      showNotConfigured()
      return
    }

    explorerApi = new WheelApi(url || DEFAULT_API_URL, token)
    $notConfigured.hidden = true
    $configured.hidden = false

    await refreshProjects()
    await refreshSyncStatus()
    listenForCanvasEvents()
    startBoardPolling()
    console.log('[wheel:explorer] initExplorer complete')
  } catch (err) {
    console.error('[wheel:explorer] initExplorer error:', err)
    showNotConfigured()
  }
}

function showNotConfigured(): void {
  $notConfigured.hidden = false
  $configured.hidden = true
}

async function refreshProjects(): Promise<void> {
  if (!explorerApi) return

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
      const nameSpan = document.createElement('span')
      const openBtn = document.createElement('button')

      li.className = 'project-item'
      nameSpan.className = 'project-name'
      nameSpan.textContent = project.name || project.id

      if (project.status) {
        const statusSpan = document.createElement('span')

        statusSpan.className = `project-status ${project.status}`
        statusSpan.textContent = project.status
        nameSpan.appendChild(statusSpan)
      }

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
    $projectError.textContent = errorMessage(err)
    $projectError.hidden = false
  }
}

async function openProject(projectId: string): Promise<void> {
  if (!explorerApi) return

  console.log('[wheel:explorer] openProject called, projectId:', projectId)
  $syncArea.hidden = false
  $syncDot.className = 'dot'
  $syncLabel.textContent = 'Opening...'
  $syncDetail.textContent = ''

  try {
    console.log('[wheel:explorer] killing all wheel panes...')
    await killAllWheelPanes()

    const apiBoard = await explorerApi.getBoard(projectId)
    const nodes = apiBoard.nodes || []
    const wires = apiBoard.wires || []

    console.log('[wheel:explorer] board fetched:', nodes.length, 'nodes,', wires.length, 'wires')
    $syncDetail.textContent = `API returned ${nodes.length} nodes`

    const board: SharedBoardState = { projectId, paneToNode: {}, nodesById: indexNodes(nodes), spawning: true }

    await writeBoardState(panel.secrets, board)
    await spawnNodePanes(board, nodes, wires)
    console.log('[wheel:explorer] boardState written, paneToNode keys:', Object.keys(board.paneToNode).length)

    suppressPaneRemoved = false
    await syncWireConnections(projectId)
    await refreshSyncStatus()
    console.log('[wheel:explorer] openProject complete')
  } catch (err) {
    suppressPaneRemoved = false
    console.error('[wheel:explorer] openProject error:', err)
    $syncDot.className = 'dot err'
    $syncLabel.textContent = 'Error'
    $syncDetail.textContent = errorMessage(err)
  }
}

async function syncFromWheel(): Promise<void> {
  console.log('[wheel:explorer] syncFromWheel called')
  if (!explorerApi) return

  $syncDot.className = 'dot'
  $syncLabel.textContent = 'Syncing...'
  suppressPaneRemoved = true

  try {
    const board = await readBoardState(panel.secrets).catch(() => null)

    if (!board?.projectId) return

    const apiBoard = await explorerApi.getBoard(board.projectId)
    const remoteNodes = apiBoard.nodes || []
    const remoteWires = apiBoard.wires || []

    console.log('[wheel:explorer] sync: killing all existing panes and rebuilding from remote')
    for (const paneId of Object.keys(board.paneToNode)) {
      await panel.canvas.kill(paneId).catch(() => {})
    }

    board.paneToNode = {}
    delete board.closedNodes
    board.spawning = true
    board.nodesById = indexNodes(remoteNodes)

    await writeBoardState(panel.secrets, board)
    await spawnNodePanes(board, remoteNodes, remoteWires)
    console.log('[wheel:explorer] sync complete, paneToNode keys:', Object.keys(board.paneToNode).length)

    suppressPaneRemoved = false
    await syncWireConnections(board.projectId)
    await refreshSyncStatus()
  } catch (err) {
    suppressPaneRemoved = false
    console.error('[wheel:explorer] syncFromWheel error:', err)
    $syncDot.className = 'dot err'
    $syncLabel.textContent = 'Sync failed'
    $syncDetail.textContent = errorMessage(err)
  }
}

async function spawnNodePanes(board: SharedBoardState, nodes: WheelNode[], wires: WheelWire[]): Promise<void> {
  for (const node of nodes) {
    const { paneId } = await panel.canvas.spawn({
      kind: 'note',
      title: node.name,
      extensionId: WHEEL_EXTENSION_ID,
      surfaceId: surfaceIdFor(node.type),
    })

    if (!paneId) continue

    board.paneToNode[paneId] = {
      nodeId: node.id,
      nodeType: node.type,
      nodeName: node.name,
      nodeConfig: node.config,
      wires: summarizeWires(node.id, wires, board.nodesById),
    }

    await writeBoardState(panel.secrets, board)
  }

  board.spawning = false
  await writeBoardState(panel.secrets, board)
}

async function killAllWheelPanes(): Promise<void> {
  suppressPaneRemoved = true
  await panel.rpc.request('canvas.killAllPanes', {}).catch(() => {})
}

async function syncWireConnections(projectId: string): Promise<void> {
  if (!explorerApi || !projectId) return

  try {
    const board = await readBoardState(panel.secrets).catch(() => null)

    if (!board) return

    const apiBoard = await explorerApi.getBoard(projectId)

    await associatePanesByWires(panel.canvas, board.paneToNode, apiBoard.wires || [])
  } catch {
    return
  }
}

function updatePeerBadge(count: number): void {
  if (count > 0) {
    $peerBadge.textContent = `${count} peer${count === 1 ? '' : 's'}`
    $peerBadge.hidden = false
  } else {
    $peerBadge.hidden = true
  }
}

function listenForCanvasEvents(): void {
  if (listeningForCanvasEvents) return

  listeningForCanvasEvents = true

  panel.rpc.on('canvas.workerStatusChange', () => {
    refreshSyncStatus()
  })

  panel.events.on('canvas.paneRemoved', ({ paneId }) => {
    if (paneId) handlePaneRemoved(paneId)
  })
}

async function handlePaneRemoved(paneId: string): Promise<void> {
  if (suppressPaneRemoved) return

  try {
    const board = await readBoardState(panel.secrets).catch(() => null)

    if (!board?.projectId) return

    const entry = board.paneToNode[paneId]

    if (!entry) return

    entry.closedPaneId = paneId
    board.closedNodes = board.closedNodes || {}
    board.closedNodes[entry.nodeId] = entry
    delete board.paneToNode[paneId]

    await writeBoardState(panel.secrets, board)

    refreshSyncStatus()
    await syncWireConnections(board.projectId)
  } catch {
    return
  }
}

function renderNodeList(board: SharedBoardState): void {
  $nodeList.textContent = ''

  for (const [paneId, entry] of Object.entries(board.paneToNode)) {
    const li = createNodeItem(entry, entry.nodeId)

    li.appendChild(createDeleteButton(() => deleteNodeFromExplorer(paneId, entry, board.projectId)))
    $nodeList.appendChild(li)
  }

  for (const [nodeId, entry] of Object.entries(board.closedNodes || {})) {
    const li = createNodeItem(entry, nodeId)

    li.classList.add('node-item-closed')
    li.title = 'Click to reopen on canvas'
    li.style.opacity = '0.5'
    li.style.cursor = 'pointer'
    li.addEventListener('click', () => respawnClosedNode(nodeId, entry, board.projectId))
    li.appendChild(createDeleteButton((e) => {
      e.stopPropagation()
      deleteClosedNode(nodeId, board.projectId)
    }))
    $nodeList.appendChild(li)
  }
}

function createNodeItem(entry: PaneEntry, fallbackName: string): HTMLLIElement {
  const li = document.createElement('li')
  const tag = document.createElement('span')
  const name = document.createElement('span')

  li.className = 'node-item'
  tag.className = 'node-type-tag'
  tag.textContent = entry.nodeType || '?'
  name.className = 'node-item-name'
  name.textContent = entry.nodeName || fallbackName

  li.appendChild(tag)
  li.appendChild(name)

  return li
}

function createDeleteButton(onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const del = document.createElement('button')

  del.className = 'node-delete-btn'
  del.textContent = '×'
  del.title = 'Delete node'
  del.addEventListener('click', onClick)

  return del
}

async function respawnClosedNode(nodeId: string, entry: PaneEntry, projectId: string | null): Promise<void> {
  suppressPaneRemoved = true

  try {
    const board = await readBoardState(panel.secrets).catch(() => null)

    if (!board) return

    const restored: PaneEntry = { ...entry }

    delete restored.closedPaneId

    if (board.closedNodes) {
      delete board.closedNodes[nodeId]
      if (Object.keys(board.closedNodes).length === 0) delete board.closedNodes
    }

    board.spawning = true
    await writeBoardState(panel.secrets, board)

    const { paneId } = await panel.canvas.spawn({
      kind: 'note',
      title: entry.nodeName || nodeId,
      extensionId: WHEEL_EXTENSION_ID,
      surfaceId: surfaceIdFor(entry.nodeType),
    })

    if (paneId) {
      board.paneToNode[paneId] = restored
    }

    board.spawning = false
    await writeBoardState(panel.secrets, board)

    suppressPaneRemoved = false
    if (projectId) await syncWireConnections(projectId)
    refreshSyncStatus()
  } catch {
    suppressPaneRemoved = false
  }
}

async function deleteClosedNode(nodeId: string, projectId: string | null): Promise<void> {
  try {
    if (explorerApi && projectId) {
      await explorerApi.deleteNode(projectId, nodeId).catch(() => {})
    }

    const board = await readBoardState(panel.secrets).catch(() => null)

    if (board) {
      if (board.closedNodes) delete board.closedNodes[nodeId]
      delete board.nodesById[nodeId]
      await writeBoardState(panel.secrets, board)
    }

    refreshSyncStatus()
  } catch {
    return
  }
}

async function deleteNodeFromExplorer(paneId: string, entry: PaneEntry, projectId: string | null): Promise<void> {
  try {
    if (explorerApi && projectId && entry.nodeId) {
      await explorerApi.deleteNode(projectId, entry.nodeId).catch(() => {})
    }

    await panel.canvas.kill(paneId).catch(() => {})

    const board = await readBoardState(panel.secrets).catch(() => null)

    if (board) {
      delete board.paneToNode[paneId]
      await writeBoardState(panel.secrets, board)
    }

    refreshSyncStatus()
  } catch {
    return
  }
}

async function refreshSyncStatus(): Promise<void> {
  console.log('[wheel:explorer] refreshSyncStatus called')

  try {
    const board = await readBoardState(panel.secrets).catch(() => null)

    if (!board) {
      console.log('[wheel:explorer] refreshSyncStatus: no boardState, hiding sync area')
      $syncArea.hidden = true
      return
    }

    const activeCount = Object.keys(board.paneToNode).length
    const closedCount = Object.keys(board.closedNodes || {}).length

    console.log('[wheel:explorer] refreshSyncStatus: projectId:', board.projectId, 'paneToNode keys:', activeCount, 'closedNodes:', closedCount)

    if (!board.projectId) {
      console.log('[wheel:explorer] refreshSyncStatus: no projectId, hiding sync area')
      $syncArea.hidden = true
      return
    }

    const totalCount = activeCount + closedCount
    const parts = [`${activeCount} on canvas`]

    if (closedCount > 0) parts.push(`${closedCount} closed`)

    $syncArea.hidden = false
    $syncDot.className = 'dot ok'
    $syncLabel.textContent = 'Synced'
    $syncDetail.textContent = `${totalCount} node${totalCount === 1 ? '' : 's'} — ${parts.join(', ')}`
    console.log('[wheel:explorer] refreshSyncStatus: showing', totalCount, 'nodes,', activeCount, 'on canvas')
    renderNodeList(board)
  } catch (err) {
    console.error('[wheel:explorer] refreshSyncStatus error:', err)
  }
}

async function stopProject(): Promise<void> {
  try {
    await killAllWheelPanes()
    await writeBoardState(panel.secrets, { projectId: null, paneToNode: {}, nodesById: {} })

    suppressPaneRemoved = false
    $syncArea.hidden = true
    $nodeList.textContent = ''
  } catch {
    suppressPaneRemoved = false
  }
}

function openBuilder(): void {
  $builderInline.hidden = false
  $btnBuilder.hidden = true
  $builderPrompt.value = ''
  $builderStatus.hidden = true
  $builderStatus.textContent = ''
  $builderStatus.className = 'builder-status'
  $builderGo.disabled = false
  $builderPrompt.focus()
}

function closeBuilder(): void {
  $builderInline.hidden = true
  $btnBuilder.hidden = false
}

async function runBuilder(): Promise<void> {
  if (!explorerApi) return

  const promptText = $builderPrompt.value.trim()

  if (!promptText) return

  const board = await readBoardState(panel.secrets).catch(() => null)

  if (!board?.projectId) return

  $builderGo.disabled = true
  $builderCancel.disabled = true
  $builderStatus.hidden = false
  $builderStatus.textContent = 'Starting builder...'
  $builderStatus.className = 'builder-status streaming'

  try {
    const stream = await explorerApi.builderTurn(board.projectId, {
      mode: 'improve',
      turns: [{ role: 'user', text: promptText }],
    })

    await streamBuilderProgress(stream)
    await syncFromWheel()

    $builderStatus.textContent = 'Done — board synced.'
    $builderStatus.className = 'builder-status done'

    setTimeout(closeBuilder, BUILDER_CLOSE_DELAY_MS)
  } catch (err) {
    console.error('[wheel:explorer] builder error:', err)
    $builderStatus.textContent = errorMessage(err) || 'Builder failed'
    $builderStatus.className = 'builder-status err'
  } finally {
    $builderGo.disabled = false
    $builderCancel.disabled = false
  }
}

async function streamBuilderProgress(stream: ReadableStream<Uint8Array>): Promise<void> {
  let fullText = ''

  for await (const { event, data } of new SSEStream<BuilderEventData | string>(new Response(stream))) {
    if (!event || typeof data !== 'object' || data === null) continue

    if (event === 'delta' && data.text) {
      fullText += data.text
      $builderStatus.textContent = fullText.slice(-BUILDER_PREVIEW_CHARS)
    } else if (event === 'done') {
      fullText = data.text || fullText
      $builderStatus.textContent = 'Builder finished. Syncing board...'
      $builderStatus.className = 'builder-status done'
    } else if (event === 'error') {
      throw new Error(data.message || 'Builder error')
    }
  }
}

async function pollBoardSync(): Promise<void> {
  if (!explorerApi) return

  try {
    const board = await readBoardState(panel.secrets).catch(() => null)

    if (!board?.projectId || board.spawning) return

    const localNodeIds = new Set(Object.values(board.paneToNode).map(e => e.nodeId).filter(Boolean))

    if (localNodeIds.size === 0) return

    const apiBoard = await explorerApi.getBoard(board.projectId)
    const remoteNodeIds = new Set((apiBoard.nodes || []).map(n => n.id))

    console.log('[wheel:poll] local nodeIds:', [...localNodeIds], 'remote nodeIds:', [...remoteNodeIds])

    const stalePaneIds = Object.entries(board.paneToNode)
      .filter(([, entry]) => !entry.uncommitted && (!entry.nodeId || !remoteNodeIds.has(entry.nodeId)))
      .map(([paneId]) => paneId)

    for (const paneId of stalePaneIds) {
      console.log('[wheel:poll] stale pane:', paneId, 'nodeId:', board.paneToNode[paneId]?.nodeId, 'not in remote')
    }

    if (stalePaneIds.length === 0) {
      refreshSyncStatus()
      return
    }

    console.log('[wheel:poll] killing', stalePaneIds.length, 'stale panes')
    for (const paneId of stalePaneIds) {
      delete board.paneToNode[paneId]
      await panel.canvas.kill(paneId).catch(() => {})
    }

    await writeBoardState(panel.secrets, board)

    refreshSyncStatus()
    await syncWireConnections(board.projectId)
  } catch {
    return
  }
}

function startBoardPolling(): void {
  if (boardSyncTimer) clearInterval(boardSyncTimer)
  boardSyncTimer = setInterval(pollBoardSync, BOARD_POLL_MS)
}
