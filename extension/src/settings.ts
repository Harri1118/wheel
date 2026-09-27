import { createPanel } from '@agentgrid/sdk'
import type { PanelClient } from '@agentgrid/sdk'
import { byId } from './dom'
import { DEFAULT_API_URL, errorMessage } from './types'
import { WheelApi } from './wheel-api'

const INIT_RETRIES = 3
const INIT_RETRY_DELAY_MS = 1000

const $loading = byId('loading')
const $signin = byId('signin')
const $connected = byId('connected')
const $connectedUrl = byId('connected-url')
const $signinError = byId('signin-error')
const $inputUrl = byId<HTMLInputElement>('input-url')
const $inputEmail = byId<HTMLInputElement>('input-email')
const $inputPassword = byId<HTMLInputElement>('input-password')
const $inputToken = byId<HTMLInputElement>('input-token')
const $tokenSection = byId('token-section')
const $btnSignin = byId<HTMLButtonElement>('btn-signin')

let panel: PanelClient | null = null

$btnSignin.addEventListener('click', signIn)
byId('btn-toggle-token').addEventListener('click', toggleTokenSection)
byId('btn-save-token').addEventListener('click', saveToken)
byId('btn-signout').addEventListener('click', signOut)

init(INIT_RETRIES)

async function init(retriesLeft: number): Promise<void> {
  try {
    panel ??= await createPanel()

    const [apiUrl, apiToken] = await Promise.all([panel.secrets.get('apiUrl'), panel.secrets.get('apiToken')])

    if (apiUrl && apiToken) {
      showConnected(apiUrl)
    } else {
      showSignin(apiUrl || DEFAULT_API_URL)
    }
  } catch {
    if (retriesLeft > 0) {
      setTimeout(() => init(retriesLeft - 1), INIT_RETRY_DELAY_MS)
    } else {
      showSignin(DEFAULT_API_URL)
    }
  }
}

async function signIn(): Promise<void> {
  const url = enteredApiUrl()
  const email = $inputEmail.value.trim()
  const password = $inputPassword.value

  if (!email || !password) {
    showSigninError('Email and password are required')
    return
  }

  $btnSignin.disabled = true
  $btnSignin.textContent = 'Signing in...'
  $signinError.hidden = true

  try {
    const client = requirePanel()
    const unauthenticatedApi = new WheelApi(url, '')
    const session = await unauthenticatedApi.login(email, password)
    const created = await unauthenticatedApi.createToken(session.token, 'AgentGrid')

    await client.secrets.set('apiUrl', url)
    await client.secrets.set('apiToken', created.token)
    showConnected(url)
  } catch (err) {
    showSigninError(errorMessage(err))
  } finally {
    $btnSignin.disabled = false
    $btnSignin.textContent = 'Sign in'
  }
}

function toggleTokenSection(): void {
  $tokenSection.hidden = !$tokenSection.hidden
}

async function saveToken(): Promise<void> {
  const url = enteredApiUrl()
  const token = $inputToken.value.trim()

  try {
    const client = requirePanel()

    await client.secrets.set('apiUrl', url)
    if (token) await client.secrets.set('apiToken', token)
    showConnected(url)
  } catch (err) {
    showSigninError(errorMessage(err))
  }
}

async function signOut(): Promise<void> {
  const client = requirePanel()

  await client.secrets.clear('apiUrl')
  await client.secrets.clear('apiToken')
  showSignin('')
}

function showSignin(url: string): void {
  $loading.hidden = true
  $signin.hidden = false
  $connected.hidden = true
  $inputUrl.value = url
  $inputEmail.value = ''
  $inputPassword.value = ''
  $inputToken.value = ''
  $tokenSection.hidden = true
  $signinError.hidden = true
}

function showConnected(url: string): void {
  $loading.hidden = true
  $signin.hidden = true
  $connected.hidden = false
  $connectedUrl.textContent = url
}

function showSigninError(message: string): void {
  $signinError.textContent = message
  $signinError.hidden = false
}

function enteredApiUrl(): string {
  return $inputUrl.value.trim().replace(/\/+$/, '') || DEFAULT_API_URL
}

function requirePanel(): PanelClient {
  if (!panel) throw new Error('Not connected to AgentGrid')

  return panel
}
