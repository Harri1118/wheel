# Wheel Extension — Implementation Plan (Approach B: Live Sync Bridge)

**Branch:** TBD (off `feat/marketplace`)
**Goal:** Wheel's board drives AgentGrid's native canvas. The extension is a bidirectional sync bridge — Wheel nodes become real AgentGrid panes, Wheel events push live multi-peer updates, and user actions on the canvas relay back to Wheel's API.

---

## Phase 0 — AgentGrid permission + protocol additions (prerequisite)

These changes land in the agent-grid repo on `feat/marketplace`. Without them the extension has no way to control the canvas.

### 0.1 New permissions

Add to `shared/extensions/permissions.ts` EXTENSION_PERMISSIONS:

| Permission | Gates |
|---|---|
| `canvas:spawn` | Panel methods: `canvas.spawnWorker`, `canvas.spawnNote`, `canvas.spawnTerminal`, `canvas.spawnBrowser`, `canvas.movePanes`, `canvas.killPane` |
| `canvas:read` | Panel methods: `canvas.listPanes`, `canvas.readWorkerOutput`, `canvas.getWorkerStatus`, `canvas.getPanePosition` |
| `canvas:events` | Panel event subscriptions: `canvas.onWorkerComplete`, `canvas.onPaneClose`, `canvas.onPaneMoved`, `canvas.onWorkerStatusChange` |

`network:websocket` — not a new permission. Extend the existing `network` permission's CSP generation in `host/content-policy.ts` to include `ws:` and `wss:` protocols for origins declared in `networkAccess.external`.

`orchestrator:engine` — deferred to Phase C. Not needed for approach B.

### 0.2 New panel protocol methods

Add to `shared/extensions/panel-protocol.ts` PANEL_REQUEST_METHODS:

```
canvas.spawnWorker    → { role, prompt, harness?, model?, cwd?, position? } → { paneId }
canvas.spawnNote      → { title, body, position?, color? } → { paneId }
canvas.spawnTerminal  → { command?, initialCommand?, cwd?, position? } → { paneId }
canvas.spawnBrowser   → { url, position? } → { paneId }
canvas.movePanes      → { moves: [{ paneId, x, y }] } → void
canvas.killPane       → { paneId } → void
canvas.listPanes      → {} → { panes: [{ paneId, type, title, position, status? }] }
canvas.readWorkerOutput → { paneId } → { response, error? }
canvas.getWorkerStatus  → { paneId } → { status, summary? }
canvas.getPanePosition  → { paneId } → { x, y }
canvas.subscribe      → { events: string[] } → void
```

Add to panel-protocol PERMISSION_BY_METHOD:
- All `canvas.spawn*`, `canvas.movePanes`, `canvas.killPane` → `canvas:spawn`
- All `canvas.list*`, `canvas.read*`, `canvas.get*` → `canvas:read`
- `canvas.subscribe` → `canvas:events`

### 0.3 New panel event topics

Add to PanelEvent union:
```
| { kind: 'event'; topic: 'canvas.workerComplete'; payload: { paneId, response?, error? } }
| { kind: 'event'; topic: 'canvas.paneClose'; payload: { paneId } }
| { kind: 'event'; topic: 'canvas.paneMoved'; payload: { paneId, x, y } }
| { kind: 'event'; topic: 'canvas.workerStatusChange'; payload: { paneId, status } }
```

### 0.4 Implement handlers in main process

Wire the new panel methods in the extension host's RPC handler (likely `desktop/main/extensions/host/rpc.ts` or a new `canvas-bridge.ts`). Each handler delegates to AgentGrid's existing canvas/worker infrastructure — the same code paths that the MCP tools use.

### 0.5 WebSocket CSP fix

In `desktop/main/extensions/host/content-policy.ts`, when building `connect-src` from `networkAccess.external`, also emit `ws:` and `wss:` variants for each allowed origin. Example: `https://api.wheel.dev` also allows `wss://api.wheel.dev`.

### Verify Phase 0
- [ ] A test extension can call `canvas.spawnWorker` from its panel and a worker pane appears
- [ ] A test extension can call `canvas.listPanes` and see what it spawned
- [ ] A test extension receives `canvas.workerComplete` when a spawned worker finishes
- [ ] A test extension can open a WebSocket to a local server from its panel
- [ ] Permission checks: calls without `canvas:spawn` granted are refused

---

## Phase 1 — Extension manifest + project connection

Changes in `~/wheel/extension/`.

### 1.1 Update agentgrid-extension.json

Add new permissions and a side panel for the project picker:

```json
{
  "permissions": ["agent:tools", "secrets", "network", "ui:panel", "ui:slots", "canvas:spawn", "canvas:read", "canvas:events"],
  "networkAccess": {
    "external": ["https://*.wheel.dev", "http://127.0.0.1:*", "http://localhost:*"]
  },
  "contributes": {
    "ui": {
      "paneTypes": [...existing...],
      "explorerSections": [{
        "id": "wheel-projects",
        "title": "Wheel",
        "entrypoint": "panel/explorer.html",
        "position": "bottom"
      }],
      "statusBarItems": [{
        "id": "wheel.connection",
        "text": "Wheel",
        "tooltip": "Wheel connection status",
        "alignment": "right",
        "priority": 300
      }],
      "toolHandlers": [...existing...]
    }
  }
}
```

### 1.2 Project picker panel (panel/explorer.html + explorer.js)

A sidebar panel that:
- Shows saved API URL (from secrets)
- Lists projects from `api.listProjects()`
- "Open on Canvas" button per project → triggers board sync (Phase 2)
- Connection status indicator
- Peer count when connected via WebSocket

### 1.3 WebSocket client (panel/wheel-events.js)

Connects to `wss://<apiUrl>/v1/projects/<id>/engine/v1/events` (or goes through the ticket-based auth flow from `docs/AGENTGRID-CLOUD-CANVAS.md` §7):
1. `POST /v1/projects/:id/ws-ticket` → get single-use ticket
2. Open WebSocket with `?ticket=<ticket>`
3. Handle frames: `node.state`, `message`, `log`, `board.changed`, `wire.denied`, `lagged`
4. On `lagged` → full board refetch, not reconnect
5. Reconnection with exponential backoff (mirror `web/src/lib/events.ts`)

### Verify Phase 1
- [ ] Explorer panel shows projects list
- [ ] WebSocket connects and receives events in the console log
- [ ] Reconnection works after a dropped connection

---

## Phase 2 — Board-to-canvas sync (Wheel → AgentGrid)

The core sync bridge. When user clicks "Open on Canvas":

### 2.1 Board fetch + initial spawn

Fetch `GET /v1/board` → for each node, spawn the corresponding AgentGrid pane:

| Wheel node type | AgentGrid pane | Notes |
|---|---|---|
| `agent` | `canvas.spawnWorker` | role from config, system_prompt as prompt, harness from config |
| `ctx` | `canvas.spawnNote` | title = node name, body = config.markdown |
| `table` | `canvas.spawnNote` | title = node name, body = column schema summary |
| `vault` | `canvas.spawnNote` | title = node name, body = key list (values hidden) |
| `endpoint` | `canvas.spawnNote` | title = node name, body = method + path |
| `script` | `canvas.spawnNote` | title = node name, body = language + source preview |
| `mcp` | `canvas.spawnNote` | title = node name, body = transport + command |
| `chest` | `canvas.spawnNote` | title = node name, body = "Blob storage" |
| `tool` | `canvas.spawnNote` | title = node name, body = base_url + operations |

Position mapping uses `wheelToCanvas()` from existing `spawn-plan.js`.

### 2.2 State tracking (panel/board-sync.js)

Maintains a bidirectional map:
```
wheelNodeId ↔ agentGridPaneId
wheelNodeType → pane type
```

This map is persisted via `pane.persistState` so it survives panel reloads.

### 2.3 Live event relay (Wheel WebSocket → canvas updates)

| Wheel event | AgentGrid action |
|---|---|
| `node.state` (status change) | Update status bar, note body, or worker state |
| `node.state` (position change from peer) | `canvas.movePanes([{ paneId, x, y }])` |
| `board.changed` (node added by peer) | `canvas.spawnWorker` or `canvas.spawnNote` |
| `board.changed` (node deleted by peer) | `canvas.killPane` |
| `board.changed` (wire added/removed) | Update note bodies showing wire topology |
| `message` | Forward to relevant worker if applicable |
| `log` | Stream to worker transcript if applicable |
| `lagged` | Full board refetch + reconcile with existing panes |

### 2.4 Agent transcript relay

For `agent` type nodes, the extension polls or streams `GET /v1/agents/:id/log` and pipes log lines into the worker's context. When a Wheel agent's status changes (`idle`, `running`, `error`, `rate_limited`, `needs_auth`), update the corresponding AgentGrid worker pane.

### Verify Phase 2
- [ ] Opening a Wheel project spawns correct panes on the canvas
- [ ] Pane positions match Wheel board positions
- [ ] A peer moving a node in Wheel's web UI causes the AgentGrid pane to move
- [ ] A peer adding a node in Wheel's web UI causes a new pane to appear
- [ ] Agent status changes (running/idle/error) reflect in the AgentGrid pane

---

## Phase 3 — Canvas-to-board sync (AgentGrid → Wheel)

User actions on the AgentGrid canvas relay back to Wheel.

### 3.1 Pane move interception

Subscribe to `canvas.paneMoved` events. When the user drags a pane:
1. Look up the Wheel node id from the pane map
2. Convert canvas position back to Wheel grid coordinates (inverse of `wheelToCanvas`)
3. Call `PATCH /v1/nodes/:id` with new position
4. Wheel broadcasts `board.changed` → other peers see the move

### 3.2 Pane close interception

Subscribe to `canvas.paneClose` events. When the user closes a pane:
1. Look up the Wheel node id
2. Call `DELETE /v1/nodes/:id` (with confirmation — deleting a Wheel node is destructive)
3. Remove from the pane map

### 3.3 Worker actions → Wheel agent actions

When the user interacts with a worker pane that maps to a Wheel agent:
- Sending a message to the worker → `POST /v1/agents/:id/send`
- Starting/stopping → `POST /v1/agents/:id/start` or `/stop`

This requires intercepting AgentGrid's worker lifecycle for Wheel-backed panes. In approach B, the simplest path: the worker's system prompt tells it to use `wheel_send_to_agent` / `wheel_start_agent` / `wheel_stop_agent` tools rather than acting directly.

### 3.4 New node creation from canvas

When the user wants to add a Wheel node from AgentGrid:
- Spawn menu item: "Add Wheel Node..." (via `spawnMenuItems` contribution)
- Opens a small dialog (extension panel) to pick node type + name
- Calls `POST /v1/nodes` → Wheel creates the node → event fires → pane appears

### Verify Phase 3
- [ ] Dragging a pane on AgentGrid canvas moves the node for other Wheel peers
- [ ] Closing a pane deletes the Wheel node (with confirmation)
- [ ] Sending a message to a Wheel-backed worker reaches the Wheel agent
- [ ] Adding a node from the spawn menu creates it on the Wheel board

---

## Phase 4 — Wire visualization + inspector

### 4.1 Wire display

Wheel's wire topology (read/write/send edges between nodes) needs visual representation. Options:
- Color-coded borders or badges on panes showing wire connections
- A dedicated "Wheel Topology" note pane that renders the wire graph as text/ASCII
- Use AgentGrid's native connection lines if/when they exist

### 4.2 Node inspector side panel

The explorer section or a side panel that shows:
- Selected node's full config
- Wire connections (incoming/outgoing with types)
- Agent status, last activity, budget
- Log tail for agents
- Message queue depth

### Verify Phase 4
- [ ] Selecting a Wheel-backed pane shows its wire connections
- [ ] Agent inspector shows live status and log

---

## Phase 5 — Polish + multi-peer UX

### 5.1 Peer presence indicators

Show which peers are connected to the same Wheel project:
- Status bar: "Wheel: 3 peers"
- Cursor/selection indicators if Wheel adds presence events

### 5.2 Conflict resolution

When two peers move the same node simultaneously:
- Last-write-wins (Wheel's behavior)
- The extension applies the latest `board.changed` position
- No local prediction — wait for Wheel's authoritative state

### 5.3 Disconnect/reconnect

- On WebSocket disconnect: show "Reconnecting..." in status bar
- On reconnect: full board refetch + reconcile (add new panes, remove deleted ones, update positions)
- Stale panes (node deleted while disconnected) get cleaned up

---

## Files inventory

### AgentGrid repo (agent-grid, feat/marketplace)

| File | Change |
|---|---|
| `shared/extensions/permissions.ts` | Add `canvas:spawn`, `canvas:read`, `canvas:events` |
| `shared/extensions/panel-protocol.ts` | Add 10 new panel methods + 4 event topics |
| `desktop/main/extensions/host/rpc.ts` | Wire new canvas methods to AgentGrid internals |
| `desktop/main/extensions/host/content-policy.ts` | Add ws:/wss: to CSP connect-src |
| `desktop/main/extensions/host/canvas-bridge.ts` | NEW — implements canvas panel methods |

### Wheel extension repo (~/wheel/extension/)

| File | Change |
|---|---|
| `agentgrid-extension.json` | Add permissions, explorer section, status bar item, spawn menu item |
| `panel/wheel-events.js` | NEW — WebSocket client with reconnection |
| `panel/board-sync.js` | NEW — bidirectional node↔pane map, event relay |
| `panel/canvas-bridge.js` | NEW — helpers for spawning/updating AgentGrid panes |
| `panel/explorer.html` | NEW — project picker sidebar |
| `panel/explorer.js` | NEW — project list, connect button, peer count |
| `panel/main.js` | Update to integrate board-sync and canvas events |
| `panel/spawn-plan.js` | Already exists, reuse for initial board spawn |
| `__tests__/board-sync.test.ts` | NEW — sync logic tests |
| `__tests__/wheel-events.test.ts` | NEW — event parsing, reconnection tests |

---

## AgentGrid technical limitations (as of today)

Compact list of what must be built in AgentGrid before this extension can work:

1. **No `canvas.*` panel methods** — panels cannot spawn, move, read, or kill canvas panes
2. **No canvas event subscriptions for panels** — panels get tool/command events only, not canvas lifecycle events
3. **WebSocket in panel CSP** — `connect-src` may not include `ws:`/`wss:` protocols for declared network origins
4. **No `canvas.movePanes` concept** — no API for an extension to programmatically reposition panes
5. **No pane-move event emission** — AgentGrid doesn't broadcast when a user drags a pane
6. **No spawn-with-position** — `spawn_worker`/`spawn_note_pane` MCP tools may not accept position coordinates; canvas placement is auto-arranged
7. **Tool execution requires open panel** — if user closes the Wheel pane, all 20 tool handlers stop working (isolated host executor was gutted)
8. **No way to intercept worker lifecycle** — extension can't hook into "user sent message to worker" to reroute it through Wheel
9. **No pane metadata/tags** — no way to mark a pane as "Wheel-backed" so the extension can distinguish its own panes from native ones after a reload
10. **Panel state persistence size limit** — the node↔pane map could grow large for big boards; need to verify `pane.persistState` can handle it

Items 1-6 are the Phase 0 prerequisite. Items 7-10 are limitations to work around or fix incrementally.
