const ext = window.agentGridExtension
let paletteReqId = 0
let paletteApi = null
const DEFAULT_API_URL = 'https://wheel-api-production-28d3.up.railway.app'

function paletteSendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = `pal-${++paletteReqId}`
    const cleanup = ext.onMessage((msg) => {
      if (msg.kind !== 'response' || msg.id !== id) return
      cleanup()
      if (msg.ok) resolve(msg.result)
      else reject(new Error(msg.error))
    })
    ext.postMessage({ kind: 'request', id, method, params })
  })
}

const NODE_TYPES = [
  { type: 'agent',    label: 'Agent',      svg: '<path d="M9 2a2 2 0 0 1 2 2v1h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-1v1a1 1 0 0 1-2 0v-1H8v1a1 1 0 0 1-2 0v-1H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2V4a2 2 0 0 1 2-2zm0 2a.5.5 0 0 0-.5.5V5h1V4.5A.5.5 0 0 0 9 4zM7.5 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm3 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM7 11h4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>' },
  { type: 'ctx',      label: 'Context',    svg: '<rect x="4" y="2" width="10" height="14" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M7 6h4M7 9h4M7 12h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' },
  { type: 'table',    label: 'Table',      svg: '<rect x="2" y="3" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M2 7h14M2 11h14M7 7v8M11 7v8" stroke="currentColor" stroke-width="1.2"/>' },
  { type: 'endpoint', label: 'Endpoint',   svg: '<path d="M4 9h8m0 0l-3-3m3 3l-3 3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 5v8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' },
  { type: 'script',   label: 'Script',     svg: '<rect x="3" y="2" width="12" height="14" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M7 7l-2 2 2 2M11 7l2 2-2 2" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' },
  { type: 'mcp',      label: 'MCP Server', svg: '<circle cx="9" cy="5" r="2.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M9 7.5V10m-3 2l3-2 3 2" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="13" r="1.2" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="12" cy="13" r="1.2" stroke="currentColor" stroke-width="1.2" fill="none"/>' },
  { type: 'vault',    label: 'Vault',      svg: '<rect x="3" y="6" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M6 6V5a3 3 0 0 1 6 0v1" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/><circle cx="9" cy="11" r="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/>' },
  { type: 'chest',    label: 'Chest',      svg: '<rect x="2" y="5" width="14" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M2 9h14" stroke="currentColor" stroke-width="1.2"/><rect x="7.5" y="7.5" width="3" height="3" rx="0.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M5 5l1-3h6l1 3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/>' },
  { type: 'tool',     label: 'Tool',       svg: '<path d="M5.5 12.5l5-5M14 5.5a3 3 0 0 0-3-3l1.5 1.5L11 5.5 9.5 4A3 3 0 0 0 13 8l-5 5a1.5 1.5 0 0 0 2.1 2.1l5-5A3 3 0 0 0 14 5.5z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' },
]

const $empty = document.getElementById('palette-empty')
const $active = document.getElementById('palette-active')
const $list = document.getElementById('palette-list')

function buildPalette() {
  $list.textContent = ''

  for (const nt of NODE_TYPES) {
    const btn = document.createElement('button')
    btn.className = 'palette-btn'

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 18 18')
    svg.setAttribute('width', '18')
    svg.setAttribute('height', '18')
    svg.setAttribute('aria-hidden', 'true')

    // SVG paths are hardcoded constants, not user input
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.innerHTML = nt.svg  // safe: static SVG from NODE_TYPES constant
    svg.appendChild(g)

    const labelSpan = document.createElement('span')
    labelSpan.textContent = nt.label

    btn.appendChild(svg)
    btn.appendChild(labelSpan)
    btn.addEventListener('click', () => spawnNode(nt.type, nt.label))
    $list.appendChild(btn)
  }
}

async function spawnNode(type, defaultLabel) {
  const boardResult = await paletteSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
  if (!boardResult?.value) return

  const board = JSON.parse(boardResult.value)
  if (!board.projectId || !paletteApi) return

  const name = prompt(`Name for new ${defaultLabel} node:`, `${type}-${Date.now() % 1000}`)
  if (!name) return

  try {
    const node = await paletteApi.createNode(board.projectId, { type, name, config: {} })

    const result = await paletteSendRequest('canvas.spawnPane', {
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

      await paletteSendRequest('secrets.set', {
        key: 'boardState',
        value: JSON.stringify(board),
      })
    }
  } catch (err) {
    console.error('Failed to create node:', err)
  }
}

async function refreshVisibility() {
  try {
    const boardResult = await paletteSendRequest('secrets.get', { key: 'boardState' }).catch(() => null)
    const hasProject = boardResult?.value && JSON.parse(boardResult.value).projectId

    $empty.hidden = !!hasProject
    $active.hidden = !hasProject
  } catch {
    $empty.hidden = false
    $active.hidden = true
  }
}

async function initPalette() {
  try {
    const [urlResult, tokenResult] = await Promise.all([
      paletteSendRequest('secrets.get', { key: 'apiUrl' }),
      paletteSendRequest('secrets.get', { key: 'apiToken' }),
    ])

    const url = urlResult?.value || DEFAULT_API_URL
    const token = tokenResult?.value

    if (token) {
      paletteApi = new WheelApi(url, token)
    }

    buildPalette()
    await refreshVisibility()

    ext.onMessage((msg) => {
      if (msg.kind === 'event' && msg.topic === 'secrets.changed') {
        refreshVisibility()
      }
    })
  } catch {
    $empty.hidden = false
    $active.hidden = true
  }
}

initPalette()
