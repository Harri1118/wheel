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
let activeProjectId = null

async function initNodePane() {
  try {
    const desc = await paneSendRequest('host.describe')
    const myPaneId = desc?.paneId
    if (!myPaneId) {
      $loading.textContent = 'No pane identity.'
      return
    }

    const [urlResult, tokenResult] = await Promise.all([
      paneSendRequest('secrets.get', { key: 'apiUrl' }),
      paneSendRequest('secrets.get', { key: 'apiToken' }),
    ])

    const apiUrl = urlResult?.value || DEFAULT_API_URL
    const apiToken = tokenResult?.value || ''

    if (apiToken) {
      paneApi = new WheelApi(apiUrl, apiToken)
    }

    const entry = await waitForBoardEntry(myPaneId)
    if (!entry) {
      $loading.textContent = 'Node not found.'
      return
    }

    const { projectId, nodeId, nodeType, nodeName, nodeConfig, wires } = entry
    activeProjectId = projectId
    nodeData = { id: nodeId, type: nodeType, name: nodeName, config: nodeConfig || {}, wires: wires || [] }

    renderNode(nodeData)

    if (paneApi && nodeType === 'agent') {
      pollAgentStatus(projectId, nodeId)
    }
  } catch (err) {
    $loading.textContent = err.message
  }
}

async function waitForBoardEntry(paneId) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await paneSendRequest('secrets.get', { key: 'boardState' })
    if (result?.value) {
      const board = JSON.parse(result.value)
      const entry = board.paneToNode?.[paneId]
      if (entry) return { ...entry, projectId: board.projectId }
    }
    await new Promise(r => setTimeout(r, 500))
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
  }

  if (node.wires && node.wires.length > 0) {
    appendSeparator()
    renderWires(node)
  }

  if (node.type !== 'agent' && node.config) {
    renderNonAgentConfig(node)
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

ext.onMessage((msg) => {
  if (msg.kind !== 'event') return

  if (msg.topic === 'canvas.workerStatusChange') {
    const { status } = msg.payload || {}
    if (status) updateStatus(status)
  }
})

initNodePane()
