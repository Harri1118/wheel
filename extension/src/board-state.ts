import type { Canvas, Secrets } from '@agentgrid/sdk'
import type { PaneEntry, SharedBoardState, WheelNode, WheelWire, WireSummary } from './types'

const BOARD_STATE_KEY = 'boardState'

export async function readBoardState(secrets: Secrets): Promise<SharedBoardState | null> {
  const raw = await secrets.get(BOARD_STATE_KEY)

  if (!raw) return null

  const stored = JSON.parse(raw) as Partial<SharedBoardState>

  return {
    ...stored,
    projectId: stored.projectId ?? null,
    paneToNode: stored.paneToNode ?? {},
    nodesById: stored.nodesById ?? {},
  }
}

export function writeBoardState(secrets: Secrets, board: SharedBoardState): Promise<void> {
  return secrets.set(BOARD_STATE_KEY, JSON.stringify(board))
}

export function summarizeWires(nodeId: string, wires: WheelWire[], nodesById: Record<string, WheelNode>): WireSummary[] {
  return wires
    .filter(w => w.from === nodeId || w.to === nodeId)
    .map(w => {
      const peer = nodesById[w.from === nodeId ? w.to : w.from]

      return {
        type: w.type,
        direction: w.from === nodeId ? 'outgoing' : 'incoming',
        peerName: peer?.name || 'unknown',
        peerType: peer?.type || 'unknown',
      }
    })
}

export async function associatePanesByWires(canvas: Canvas, paneToNode: Record<string, PaneEntry>, wires: WheelWire[]): Promise<void> {
  const paneByNodeId: Record<string, string> = {}
  const peersByPane: Record<string, Set<string>> = {}

  for (const [paneId, entry] of Object.entries(paneToNode)) {
    paneByNodeId[entry.nodeId] = paneId
    peersByPane[paneId] = new Set()
  }

  for (const wire of wires) {
    const fromPane = paneByNodeId[wire.from]
    const toPane = paneByNodeId[wire.to]

    if (fromPane && toPane) {
      peersByPane[fromPane]?.add(toPane)
      peersByPane[toPane]?.add(fromPane)
    }
  }

  for (const [paneId, peers] of Object.entries(peersByPane)) {
    await canvas.update({ paneId, associatedPaneIds: [...peers] }).catch(() => {})
  }
}
