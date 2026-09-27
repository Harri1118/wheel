export const NODE_TYPES = ['agent', 'ctx', 'table', 'endpoint', 'script', 'mcp', 'vault', 'chest', 'tool'] as const

export type NodeType = (typeof NODE_TYPES)[number]
export type WireKind = 'read' | 'write' | 'send'
export type WireDirection = 'outgoing' | 'incoming'
export type GridPosition = { x: number; y: number }

export type TableColumn = { name: string; type: string }
export type ToolOperation = { id?: string; name?: string; operation_id?: string; method?: string; path?: string }
export type ToolSource = { format: string; imported_at: string; raw: string }

export type NodeConfig = {
  harness?: string
  model?: string
  system_prompt?: string
  run_on_startup?: boolean
  ephemeral_context?: boolean
  markdown?: string
  columns?: TableColumn[]
  method?: string
  path?: string
  response_mode?: string
  language?: string
  source?: string | ToolSource
  timeout_secs?: number
  transport?: string
  command?: string
  url?: string
  keys?: string[]
  kind?: string
  base_url?: string
  operations?: ToolOperation[]
  [key: string]: unknown
}

export type WheelNode = {
  id: string
  name: string
  type: NodeType
  position?: GridPosition
  config?: NodeConfig
  uncommitted?: boolean
}

export type WheelWire = { from: string; to: string; type: WireKind }
export type WheelBoard = { nodes?: WheelNode[]; wires?: WheelWire[] }
export type WheelProject = { id: string; name?: string; status?: string }

export type WireSummary = { type: WireKind; direction: WireDirection; peerName: string; peerType: string }

export type PaneEntry = {
  nodeId: string
  nodeType: NodeType
  nodeName: string
  nodeConfig?: NodeConfig
  wires: WireSummary[]
  uncommitted?: boolean
  closedPaneId?: string
}

export type SharedBoardState = {
  projectId: string | null
  paneToNode: Record<string, PaneEntry>
  nodesById: Record<string, WheelNode>
  closedNodes?: Record<string, PaneEntry>
  spawning?: boolean
}

export const WHEEL_EXTENSION_ID = 'agentgrid.wheel'
export const DEFAULT_API_URL = 'https://wheel-api-production-28d3.up.railway.app'

export function isNodeType(value: string): value is NodeType {
  return (NODE_TYPES as readonly string[]).includes(value)
}

export function surfaceIdFor(nodeType: NodeType): string {
  return `wheel-${nodeType}`
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
