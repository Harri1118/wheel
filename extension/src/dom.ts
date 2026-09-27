export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id)

  if (!element) throw new Error(`Missing #${id} element`)

  return element as T
}

export function setSaveStatus(statusEl: HTMLElement | null, tone: '' | 'ok' | 'err', text: string): void {
  if (!statusEl) return

  statusEl.className = tone ? `save-status ${tone}` : 'save-status'
  statusEl.textContent = text
}
