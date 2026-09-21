import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../agentgrid-extension.json'), 'utf-8')
)

describe('manifest structure', () => {
  it('has required top-level fields', () => {
    expect(manifest.id).toBe('wheel')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.publisher).toBeTruthy()
    expect(manifest.displayName).toBeTruthy()
    expect(manifest.description).toBeTruthy()
  })

  it('declares required permissions', () => {
    expect(manifest.permissions).toContain('agent:tools')
    expect(manifest.permissions).toContain('secrets')
    expect(manifest.permissions).toContain('network')
    expect(manifest.permissions).toContain('ui:panel')
  })

  it('declares network access for Wheel API and localhost', () => {
    const origins = manifest.networkAccess.external
    expect(origins).toContain('https://*.wheel.dev')
    expect(origins).toContain('http://127.0.0.1:*')
    expect(origins).toContain('http://localhost:*')
  })
})

describe('secrets', () => {
  const secrets = manifest.contributes.capabilities.secrets

  it('declares apiUrl and apiToken', () => {
    const keys = secrets.map((s: { key: string }) => s.key)
    expect(keys).toContain('apiUrl')
    expect(keys).toContain('apiToken')
  })

  it('each secret has a label', () => {
    for (const s of secrets) {
      expect(s.label).toBeTruthy()
    }
  })
})

describe('pane types', () => {
  const panes = manifest.contributes.ui.paneTypes

  it('declares a runtime pane', () => {
    expect(panes).toHaveLength(1)
    expect(panes[0].id).toBe('runtime')
    expect(panes[0].entrypoint).toBe('panel/index.html')
  })

  it('pane has a default size', () => {
    expect(panes[0].defaultSize.width).toBeGreaterThan(0)
    expect(panes[0].defaultSize.height).toBeGreaterThan(0)
  })
})

describe('tool handlers', () => {
  const tools = manifest.contributes.ui.toolHandlers

  it('declares at least 20 tools', () => {
    expect(tools.length).toBeGreaterThanOrEqual(20)
  })

  it('every tool has name, description, and inputSchema', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^wheel_/)
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('every tool name is unique', () => {
    const names = tools.map((t: { name: string }) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('project-scoped tools require projectId', () => {
    const projectTools = tools.filter((t: { name: string }) =>
      !['wheel_list_projects', 'wheel_create_project'].includes(t.name)
    )
    for (const tool of projectTools) {
      const required = tool.inputSchema.required || []
      expect(required).toContain('projectId')
    }
  })

  it('wheel_create_node requires name, type, and position', () => {
    const tool = tools.find((t: { name: string }) => t.name === 'wheel_create_node')
    expect(tool.inputSchema.required).toContain('name')
    expect(tool.inputSchema.required).toContain('type')
    expect(tool.inputSchema.required).toContain('position')
  })

  it('wheel_create_node type enum matches Wheel node types', () => {
    const tool = tools.find((t: { name: string }) => t.name === 'wheel_create_node')
    const allowed = tool.inputSchema.properties.type.enum
    expect(allowed).toEqual(
      expect.arrayContaining(['agent', 'ctx', 'table', 'endpoint', 'script', 'mcp', 'vault', 'chest', 'tool'])
    )
    expect(allowed).toHaveLength(9)
  })

  it('wheel_create_wire type enum matches Wheel wire types', () => {
    const tool = tools.find((t: { name: string }) => t.name === 'wheel_create_wire')
    const allowed = tool.inputSchema.properties.type.enum
    expect(allowed).toEqual(expect.arrayContaining(['read', 'write', 'send']))
    expect(allowed).toHaveLength(3)
  })

  it('wheel_send_to_agent requires body', () => {
    const tool = tools.find((t: { name: string }) => t.name === 'wheel_send_to_agent')
    expect(tool.inputSchema.required).toContain('body')
  })

  it('wheel_query_table requires sql', () => {
    const tool = tools.find((t: { name: string }) => t.name === 'wheel_query_table')
    expect(tool.inputSchema.required).toContain('sql')
  })

  it('wheel_put_secret requires key and value', () => {
    const tool = tools.find((t: { name: string }) => t.name === 'wheel_put_secret')
    expect(tool.inputSchema.required).toContain('key')
    expect(tool.inputSchema.required).toContain('value')
  })
})

describe('entrypoint exists', () => {
  it('panel/index.html is present', () => {
    const path = resolve(__dirname, '..', manifest.contributes.ui.paneTypes[0].entrypoint)
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('<!DOCTYPE html>')
  })
})
