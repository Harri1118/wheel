const ext = window.agentGridExtension
let reqId = 0

function sendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = `r-${++reqId}`
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('timeout'))
    }, 5000)
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

async function loadSecrets() {
  const secrets = await sendRequest('secrets.list')
  const map = {}
  if (Array.isArray(secrets)) {
    for (const s of secrets) map[s.key] = s.value
  }
  return map
}

async function saveSecret(key, value) {
  await sendRequest('secrets.set', { key, value })
}

async function clearSecret(key) {
  await sendRequest('secrets.clear', { key })
}

const $loading = document.getElementById('loading')
const $signin = document.getElementById('signin')
const $connected = document.getElementById('connected')
const $connectedUrl = document.getElementById('connected-url')
const $signinError = document.getElementById('signin-error')
const $inputUrl = document.getElementById('input-url')
const $inputEmail = document.getElementById('input-email')
const $inputPassword = document.getElementById('input-password')
const $inputToken = document.getElementById('input-token')
const $tokenSection = document.getElementById('token-section')

function showSignin(urlVal) {
  $loading.hidden = true
  $signin.hidden = false
  $connected.hidden = true
  $inputUrl.value = urlVal || ''
  $inputEmail.value = ''
  $inputPassword.value = ''
  $inputToken.value = ''
  $tokenSection.hidden = true
  $signinError.hidden = true
}

function showConnected(url) {
  $loading.hidden = true
  $signin.hidden = true
  $connected.hidden = false
  $connectedUrl.textContent = url
}

document.getElementById('btn-signin').addEventListener('click', async () => {
  const url = $inputUrl.value.trim().replace(/\/+$/, '')
  if (!url) {
    $signinError.textContent = 'API URL is required'
    $signinError.hidden = false
    return
  }

  const email = $inputEmail.value.trim()
  const password = $inputPassword.value
  if (!email || !password) {
    $signinError.textContent = 'Email and password are required'
    $signinError.hidden = false
    return
  }

  const btn = document.getElementById('btn-signin')
  btn.disabled = true
  btn.textContent = 'Signing in...'
  $signinError.hidden = true

  try {
    const loginRes = await fetch(`${url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })

    if (!loginRes.ok) {
      let msg = `HTTP ${loginRes.status}`
      try {
        const body = await loginRes.json()
        if (body?.error?.message) msg = body.error.message
      } catch {}
      throw new Error(msg)
    }

    const session = await loginRes.json()

    const tokenRes = await fetch(`${url}/v1/auth/tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': session.token,
      },
      body: JSON.stringify({ name: 'AgentGrid' }),
    })

    if (!tokenRes.ok) {
      let msg = `HTTP ${tokenRes.status}`
      try {
        const body = await tokenRes.json()
        if (body?.error?.message) msg = body.error.message
      } catch {}
      throw new Error(msg)
    }

    const created = await tokenRes.json()

    await saveSecret('apiUrl', url)
    await saveSecret('apiToken', created.token)
    showConnected(url)
  } catch (err) {
    $signinError.textContent = err.message
    $signinError.hidden = false
  } finally {
    btn.disabled = false
    btn.textContent = 'Sign in'
  }
})

document.getElementById('btn-toggle-token').addEventListener('click', () => {
  $tokenSection.hidden = !$tokenSection.hidden
})

document.getElementById('btn-save-token').addEventListener('click', async () => {
  const url = $inputUrl.value.trim().replace(/\/+$/, '')
  if (!url) {
    $signinError.textContent = 'API URL is required'
    $signinError.hidden = false
    return
  }

  const token = $inputToken.value.trim()

  try {
    await saveSecret('apiUrl', url)
    if (token) await saveSecret('apiToken', token)
    showConnected(url)
  } catch (err) {
    $signinError.textContent = err.message
    $signinError.hidden = false
  }
})

document.getElementById('btn-signout').addEventListener('click', async () => {
  await clearSecret('apiUrl')
  await clearSecret('apiToken')
  showSignin('')
})

async function init(retries) {
  try {
    const secrets = await loadSecrets()
    if (secrets.apiUrl && secrets.apiToken) {
      showConnected(secrets.apiUrl)
    } else {
      showSignin(secrets.apiUrl || 'https://wheel-api-production-28d3.up.railway.app')
    }
  } catch {
    if (retries > 0) {
      setTimeout(() => init(retries - 1), 1000)
    } else {
      showSignin('https://wheel-api-production-28d3.up.railway.app')
    }
  }
}

init(3)
