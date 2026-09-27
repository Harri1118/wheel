import { allowedTargets, allowedWireTypes, createWireMatrix, inputTypes, outputTypes, wireAllowed } from '@agentgrid/sdk'
import type { NodeType, WireKind } from './types'

const WHEEL_WIRE_RULES: Array<[NodeType, WireKind, NodeType]> = [
  ['agent', 'send', 'agent'],
  ['agent', 'read', 'ctx'],
  ['agent', 'write', 'ctx'],
  ['agent', 'read', 'table'],
  ['agent', 'write', 'table'],
  ['agent', 'read', 'vault'],
  ['agent', 'read', 'chest'],
  ['agent', 'write', 'chest'],
  ['agent', 'read', 'script'],
  ['agent', 'read', 'mcp'],
  ['agent', 'read', 'tool'],
  ['ctx', 'send', 'agent'],
  ['endpoint', 'send', 'agent'],
  ['endpoint', 'write', 'table'],
  ['endpoint', 'send', 'script'],
  ['endpoint', 'read', 'vault'],
  ['script', 'send', 'agent'],
  ['script', 'read', 'ctx'],
  ['script', 'write', 'ctx'],
  ['script', 'read', 'table'],
  ['script', 'write', 'table'],
  ['script', 'read', 'chest'],
  ['script', 'write', 'chest'],
  ['script', 'read', 'vault'],
  ['script', 'read', 'tool'],
  ['tool', 'read', 'vault'],
]

const WHEEL_WIRES = createWireMatrix(WHEEL_WIRE_RULES.map(([from, type, to]) => ({ from, to, type })))

export function wheelWireAllowed(fromType: string, wireType: string, toType: string): boolean {
  return wireAllowed(WHEEL_WIRES, fromType, toType, wireType)
}

export function wheelWireTypes(fromType: string, toType: string): WireKind[] {
  return allowedWireTypes(WHEEL_WIRES, fromType, toType) as WireKind[]
}

export function wheelTargetTypes(fromType: string): Set<NodeType> {
  return new Set(allowedTargets(WHEEL_WIRES, fromType).map(target => target.toType as NodeType))
}

export function wheelOutputTypes(nodeType: string): WireKind[] {
  return outputTypes(WHEEL_WIRES, nodeType) as WireKind[]
}

export function wheelInputTypes(nodeType: string): WireKind[] {
  return inputTypes(WHEEL_WIRES, nodeType) as WireKind[]
}
