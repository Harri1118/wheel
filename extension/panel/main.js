"use strict";
(() => {
  // ../../agent-grid/.agent-grid/worktrees/sdk/packages/sdk/dist/index.js
  var Tools = class {
    constructor(rpc) {
      this.rpc = rpc;
    }
    rpc;
    settle(callId, answer) {
      this.rpc.notify("tools.settle", { callId, ...answer });
    }
    invoke(toolName, input) {
      return this.rpc.request("tools.invoke", { toolName, input: input ?? {} });
    }
    onInvoke(toolName, handler) {
      return this.rpc.on("tool", async (payload) => {
        const call = payload;
        if (call.toolName !== toolName) {
          return;
        }
        this.settle(call.callId, await answerFrom(() => handler(call.input)));
      });
    }
  };
  async function answerFrom(produce) {
    try {
      return { result: await produce() };
    } catch (err) {
      return { error: String(err) };
    }
  }
  var Agent = class {
    constructor(rpc) {
      this.rpc = rpc;
    }
    rpc;
    sendPrompt(text) {
      return this.rpc.request("agent.sendPrompt", { text });
    }
    onAction(handler) {
      return this.rpc.on("agent.action", async (payload) => {
        const { callId, action, data } = payload;
        this.rpc.notify("tools.settle", { callId, ...await answerFrom(() => handler(action, data ?? {})) });
      });
    }
    onReadState(handler) {
      return this.rpc.on("agent.readState", async (payload) => {
        const { callId } = payload;
        this.rpc.notify("tools.settle", { callId, ...await answerFrom(handler) });
      });
    }
  };
  var Canvas = class {
    constructor(rpc) {
      this.rpc = rpc;
    }
    rpc;
    spawn(options) {
      return this.rpc.request("canvas.spawnPane", options);
    }
    kill(paneId) {
      return this.rpc.request("canvas.killPane", { paneId });
    }
    update(options) {
      return this.rpc.request("canvas.updatePane", options);
    }
    move(moves) {
      return this.rpc.request("canvas.movePanes", { moves });
    }
    getLayouts() {
      return this.rpc.request("canvas.getLayouts");
    }
    applyLayout(layout) {
      return this.rpc.request("canvas.applyLayout", layout);
    }
    clearLayout() {
      return this.rpc.request("canvas.clearLayout");
    }
    startWireDrag(options) {
      return this.rpc.request("canvas.startWireDrag", options);
    }
    endWireDrag(params) {
      return this.rpc.request("canvas.endWireDrag", params);
    }
  };
  var Events = class {
    constructor(rpc) {
      this.rpc = rpc;
    }
    rpc;
    on(topic, handler) {
      return this.rpc.on(topic, handler);
    }
  };
  var DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
  var REQUEST_ID_PREFIX = "sdk-";
  var Rpc = class {
    bridge;
    nextId = 0;
    pending = /* @__PURE__ */ new Map();
    eventListeners = /* @__PURE__ */ new Map();
    cleanup;
    constructor(bridge) {
      this.bridge = bridge;
      this.cleanup = bridge.onMessage((message) => this.handleMessage(message));
    }
    request(method, params, opts) {
      const id = `${REQUEST_ID_PREFIX}${this.nextId += 1}`;
      const timeoutMs = opts?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const request = { kind: "request", id, method, params };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`@agentgrid/sdk: request "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        this.pending.set(id, { method, resolve, reject, timer });
        this.bridge.postMessage(request);
      });
    }
    notify(method, params) {
      const id = `${REQUEST_ID_PREFIX}${this.nextId += 1}`;
      const request = { kind: "request", id, method, params };
      this.bridge.postMessage(request);
    }
    on(topic, handler) {
      const handlers = this.eventListeners.get(topic) ?? /* @__PURE__ */ new Set();
      handlers.add(handler);
      this.eventListeners.set(topic, handlers);
      return () => {
        handlers.delete(handler);
      };
    }
    destroy() {
      this.cleanup();
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(`@agentgrid/sdk: request "${request.method}" cancelled because the client was destroyed`));
      }
      this.pending.clear();
      this.eventListeners.clear();
    }
    handleMessage(message) {
      if (isResponse(message)) {
        this.settleRequest(message);
        return;
      }
      if (isEvent(message)) {
        this.dispatchEvent(message);
      }
    }
    settleRequest(response) {
      const request = this.pending.get(response.id);
      if (!request) {
        return;
      }
      clearTimeout(request.timer);
      this.pending.delete(response.id);
      if (response.ok) {
        request.resolve(response.result);
        return;
      }
      request.reject(new Error(response.error ?? "Unknown host error"));
    }
    dispatchEvent(event) {
      const handlers = this.eventListeners.get(event.topic);
      if (!handlers) {
        return;
      }
      for (const handler of handlers) {
        handler(event.payload);
      }
    }
  };
  function isResponse(message) {
    const candidate = message;
    return candidate?.kind === "response" && typeof candidate.id === "string";
  }
  function isEvent(message) {
    const candidate = message;
    return candidate?.kind === "event" && typeof candidate.topic === "string";
  }
  var Secrets = class {
    constructor(rpc) {
      this.rpc = rpc;
    }
    rpc;
    list() {
      return this.rpc.request("secrets.list");
    }
    async get(key) {
      const secret = await this.rpc.request("secrets.get", { key });
      return secret.value ?? null;
    }
    set(key, value) {
      return this.rpc.request("secrets.set", { key, value });
    }
    clear(key) {
      return this.rpc.request("secrets.clear", { key });
    }
  };
  var State = class {
    constructor(bridge) {
      this.bridge = bridge;
    }
    bridge;
    persist(data) {
      this.bridge.persistState(data);
    }
    load() {
      return this.bridge.loadState();
    }
  };
  var MISSING_BRIDGE_MESSAGE = "@agentgrid/sdk: window.agentGridExtension not found \u2014 is this running inside an AgentGrid extension panel?";
  async function createPanel() {
    const bridge = globalThis.agentGridExtension;
    if (!bridge) {
      throw new Error(MISSING_BRIDGE_MESSAGE);
    }
    const rpc = new Rpc(bridge);
    const description = await rpc.request("host.describe");
    const events = new Events(rpc);
    return {
      description,
      rpc,
      canvas: new Canvas(rpc),
      secrets: new Secrets(rpc),
      events,
      tools: new Tools(rpc),
      state: new State(bridge),
      agent: new Agent(rpc),
      on: (topic, handler) => events.on(topic, handler),
      destroy: () => rpc.destroy()
    };
  }

  // src/board-state.ts
  function summarizeWires(nodeId, wires, nodesById) {
    return wires.filter((w) => w.from === nodeId || w.to === nodeId).map((w) => {
      const peer = nodesById[w.from === nodeId ? w.to : w.from];
      return {
        type: w.type,
        direction: w.from === nodeId ? "outgoing" : "incoming",
        peerName: peer?.name || "unknown",
        peerType: peer?.type || "unknown"
      };
    });
  }

  // src/spawn-plan.ts
  function wheelToCanvas(pos, scale, offsetX, offsetY) {
    return {
      x: Math.round(pos.x * scale + offsetX),
      y: Math.round(pos.y * scale + offsetY)
    };
  }
  function buildAgentPrompt(node, wires, nodesById, projectId) {
    const cfg = node.config || {};
    const parts = [];
    parts.push(`You are "${node.name}", a Wheel agent running on the "${projectId}" project.`);
    if (cfg.system_prompt) {
      parts.push("");
      parts.push("## System Prompt (from Wheel config)");
      parts.push(cfg.system_prompt);
    }
    const wireLines = describeWires(node, wires, nodesById);
    if (wireLines.length > 0) {
      parts.push("");
      parts.push("## Wires");
      parts.push("Your connections on the Wheel board:");
      parts.push(...wireLines);
    }
    const readableNodes = peersOf(wires, nodesById, (w) => w.type === "read" && w.from === node.id, "to");
    const writableNodes = peersOf(wires, nodesById, (w) => w.type === "write" && w.from === node.id, "to");
    const sendTargets = peersOf(wires, nodesById, (w) => w.type === "send" && w.from === node.id, "to");
    const receiveFrom = peersOf(wires, nodesById, (w) => w.type === "send" && w.to === node.id, "from");
    const hasToolAccess = readableNodes.length > 0 || writableNodes.length > 0 || sendTargets.length > 0 || receiveFrom.length > 0;
    if (!hasToolAccess) return parts.join("\n");
    parts.push("");
    parts.push("## Available Wheel Tools");
    parts.push(`Project ID: ${projectId}`);
    parts.push(`Your node ID: ${node.id}`);
    for (const n of readableNodes) {
      if (n.type === "table") {
        parts.push(`- wheel_query_table / wheel_table_rows with nodeId="${n.id}" to read from table "${n.name}"`);
      } else if (n.type === "ctx") {
        parts.push(`- Context node "${n.name}" (${n.id}) is readable via the board`);
      } else if (n.type === "chest") {
        parts.push(`- wheel_chest_ls with nodeId="${n.id}" to browse chest "${n.name}"`);
      }
    }
    for (const n of writableNodes) {
      if (n.type === "table") {
        parts.push(`- wheel_query_table with nodeId="${n.id}" to write to table "${n.name}"`);
      } else if (n.type === "vault") {
        parts.push(`- wheel_put_secret with nodeId="${n.id}" to write secrets to vault "${n.name}"`);
      }
    }
    for (const n of sendTargets) {
      parts.push(`- wheel_send_to_agent with nodeId="${n.id}" to send messages to agent "${n.name}"`);
    }
    if (receiveFrom.length > 0) {
      const names = receiveFrom.map((n) => `"${n.name}"`).join(", ");
      parts.push(`- You can receive messages from: ${names}. Messages arrive via wheel_poll_messages.`);
    }
    return parts.join("\n");
  }
  function buildNoteBody(node) {
    const lines = [`**Type:** ${node.type}`, `**ID:** ${node.id}`];
    const cfg = node.config || {};
    switch (node.type) {
      case "ctx":
        if (cfg.markdown) lines.push("", "---", "", cfg.markdown);
        break;
      case "table":
        if (cfg.columns) lines.push("", `**Columns:** ${cfg.columns.map((c) => c.name).join(", ")}`);
        break;
      case "endpoint":
        lines.push(`**Method:** ${cfg.method || "POST"}`, `**Path:** ${cfg.path || "/hook"}`);
        break;
      case "script":
        lines.push(`**Language:** ${cfg.language || "python"}`);
        if (typeof cfg.source === "string" && cfg.source) lines.push("", "```", cfg.source.slice(0, 500), "```");
        break;
      case "mcp":
        lines.push(`**Transport:** ${cfg.transport || "stdio"}`);
        if (cfg.command) lines.push(`**Command:** ${cfg.command}`);
        break;
      case "vault":
        if (cfg.keys?.length) lines.push(`**Keys:** ${cfg.keys.join(", ")}`);
        break;
      case "chest":
        lines.push("Blob storage node");
        break;
      case "tool":
        if (cfg.base_url) lines.push(`**Base URL:** ${cfg.base_url}`);
        if (cfg.operations?.length) lines.push(`**Operations:** ${cfg.operations.map((o) => o.id || o.name).join(", ")}`);
        break;
    }
    return lines.join("\n");
  }
  function describeWires(node, wires, nodesById) {
    const lines = [];
    for (const w of wires) {
      const isFrom = w.from === node.id;
      const peer = nodesById[isFrom ? w.to : w.from];
      if (!peer) continue;
      const dir = isFrom ? "outgoing" : "incoming";
      lines.push(`  - ${dir} ${w.type} wire ${isFrom ? "to" : "from"} "${peer.name}" (${peer.type})`);
    }
    return lines;
  }
  function peersOf(wires, nodesById, matches, peerEnd) {
    return wires.filter(matches).map((w) => nodesById[w[peerEnd]]).filter((peer) => Boolean(peer));
  }

  // src/board-sync.ts
  var GRID_SCALE = 120;
  var GRID_OFFSET = 100;
  var DEFAULT_LOG_POLL_MS = 5e3;
  var BoardSync = class {
    constructor(host) {
      this.host = host;
    }
    host;
    nodeToPane = /* @__PURE__ */ new Map();
    paneToNode = /* @__PURE__ */ new Map();
    projectId = null;
    nodesById = {};
    wires = [];
    topologyPaneId = null;
    peerCount = 0;
    onPeerCountChange = null;
    onAgentLog = null;
    onAgentStatusChange = null;
    logPollers = /* @__PURE__ */ new Map();
    async openProject(api2, projectId, scale = GRID_SCALE, offsetX = GRID_OFFSET, offsetY = GRID_OFFSET) {
      this.projectId = projectId;
      const board = await api2.getBoard(projectId);
      return this.spawnBoard(board, scale, offsetX, offsetY);
    }
    async spawnBoard(board, scale, offsetX, offsetY) {
      const nodes = board.nodes || [];
      const results = { spawned: 0, failed: 0, errors: [] };
      this.wires = board.wires || [];
      this.nodesById = {};
      for (const n of nodes) this.nodesById[n.id] = n;
      for (const node of nodes) {
        const pos = wheelToCanvas(node.position || { x: 0, y: 0 }, scale, offsetX, offsetY);
        try {
          await this.spawnPaneForNode(node, pos);
          results.spawned++;
        } catch (err) {
          results.failed++;
          results.errors.push({ nodeId: node.id, name: node.name, error: err instanceof Error ? err.message : String(err) });
        }
      }
      await this.spawnTopologyNote();
      this.persistState();
      return results;
    }
    async spawnWorkerForNode(node, position) {
      const relevantWires = this.wires.filter((w) => w.from === node.id || w.to === node.id);
      const prompt = buildAgentPrompt(node, relevantWires, this.nodesById, this.projectId ?? "");
      const result = await this.host.canvas.spawn({
        kind: "note",
        title: `${node.name} (agent)`,
        body: prompt,
        x: position?.x,
        y: position?.y
      });
      this.linkPane(node, result?.paneId, "worker");
      return result;
    }
    async spawnNoteForNode(node, position) {
      const result = await this.host.canvas.spawn({
        kind: "note",
        title: `${node.name} (${node.type})`,
        body: buildNoteBody(node),
        x: position?.x,
        y: position?.y
      });
      this.linkPane(node, result?.paneId, "note");
      return result;
    }
    async spawnTopologyNote() {
      if (this.wires.length === 0) return;
      try {
        const result = await this.host.canvas.spawn({
          kind: "note",
          title: "Wheel Topology",
          body: this.buildTopologyBody()
        });
        this.topologyPaneId = result?.paneId || null;
      } catch {
        return;
      }
    }
    buildTopologyBody() {
      const lines = [`**Project:** ${this.projectId}`, ""];
      const connectionsByName = /* @__PURE__ */ new Map();
      for (const w of this.wires) {
        const fromNode = this.nodesById[w.from];
        const toNode = this.nodesById[w.to];
        if (!fromNode || !toNode) continue;
        const fromConnections = connectionsFor(connectionsByName, fromNode.name);
        const toConnections = connectionsFor(connectionsByName, toNode.name);
        fromConnections.out.push(`  \u2192 ${w.type} \u2192 **${toNode.name}** (${toNode.type})`);
        toConnections.in.push(`  \u2190 ${w.type} \u2190 **${fromNode.name}** (${fromNode.type})`);
      }
      for (const [name, connections] of connectionsByName) {
        lines.push(`### ${name}`, ...connections.out, ...connections.in, "");
      }
      return lines.join("\n");
    }
    startAgentLogPolling(api2, nodeId, intervalMs = DEFAULT_LOG_POLL_MS) {
      const entry = this.nodeToPane.get(nodeId);
      if (!entry || entry.type !== "worker") return;
      if (this.logPollers.has(nodeId)) return;
      let since = 0;
      const timer = setInterval(async () => {
        if (!this.projectId) {
          this.stopAgentLogPolling(nodeId);
          return;
        }
        try {
          const log = await api2.agentLog(this.projectId, nodeId, { since });
          const entries = Array.isArray(log) ? log : log.entries || [];
          const newest = entries[entries.length - 1];
          if (!newest) return;
          since = newest.seq || newest.id || since;
          this.onAgentLog?.(nodeId, entry.paneId, entries);
        } catch {
          return;
        }
      }, intervalMs);
      this.logPollers.set(nodeId, timer);
    }
    stopAgentLogPolling(nodeId) {
      const timer = this.logPollers.get(nodeId);
      if (!timer) return;
      clearInterval(timer);
      this.logPollers.delete(nodeId);
    }
    stopAllLogPolling() {
      for (const timer of this.logPollers.values()) clearInterval(timer);
      this.logPollers.clear();
    }
    handleWorkerComplete(paneId, response) {
      const entry = this.paneToNode.get(paneId);
      if (!entry || entry.nodeType !== "agent") return null;
      return { nodeId: entry.nodeId, response };
    }
    agentNodeIds() {
      return [...this.nodeToPane].filter(([, entry]) => entry.type === "worker").map(([nodeId]) => nodeId);
    }
    handleNodeState(payload) {
      const nodeId = payload.node_id || payload.nodeId;
      if (!nodeId) return;
      const entry = this.nodeToPane.get(nodeId);
      if (!entry) return;
      if (payload.status && entry.type === "worker") {
        this.onAgentStatusChange?.(nodeId, entry.paneId, payload.status);
      }
      if (payload.position) {
        const pos = defaultCanvasPosition(payload.position);
        this.host.canvas.move([{ paneId: entry.paneId, x: pos.x, y: pos.y }]).catch(() => {
        });
      }
    }
    async handleBoardChanged(payload) {
      const changes = payload.changes || payload;
      if (!changes) return;
      for (const node of changes.added ?? []) {
        this.nodesById[node.id] = node;
        await this.spawnPaneForNode(node, defaultCanvasPosition(node.position)).catch(() => {
        });
      }
      for (const nodeId of changes.removed ?? []) {
        const entry = this.nodeToPane.get(nodeId);
        if (!entry) continue;
        this.host.canvas.kill(entry.paneId).catch(() => {
        });
        this.nodeToPane.delete(nodeId);
        this.paneToNode.delete(entry.paneId);
        delete this.nodesById[nodeId];
      }
      if (changes.wires) {
        this.wires = changes.wires;
      }
      this.persistState();
    }
    async handleLagged(api2) {
      if (!this.projectId) return;
      await this.reconcileBoard(await api2.getBoard(this.projectId));
    }
    async reconcileBoard(board) {
      const nodes = board.nodes || [];
      const currentNodeIds = new Set(nodes.map((n) => n.id));
      for (const [nodeId, entry] of this.nodeToPane) {
        if (currentNodeIds.has(nodeId)) continue;
        this.host.canvas.kill(entry.paneId).catch(() => {
        });
        this.nodeToPane.delete(nodeId);
        this.paneToNode.delete(entry.paneId);
      }
      for (const node of nodes) {
        this.nodesById[node.id] = node;
        if (!this.nodeToPane.has(node.id)) {
          await this.spawnPaneForNode(node, defaultCanvasPosition(node.position)).catch(() => {
          });
        }
      }
      this.wires = board.wires || [];
      this.persistState();
    }
    handlePaneMoved(paneId, x, y) {
      const entry = this.paneToNode.get(paneId);
      if (!entry) return null;
      return {
        nodeId: entry.nodeId,
        position: canvasToWheel({ x, y }, GRID_SCALE, GRID_OFFSET, GRID_OFFSET)
      };
    }
    handlePaneClose(paneId) {
      if (paneId === this.topologyPaneId) {
        this.topologyPaneId = null;
        return null;
      }
      const entry = this.paneToNode.get(paneId);
      if (!entry) return null;
      this.paneToNode.delete(paneId);
      this.nodeToPane.delete(entry.nodeId);
      return entry;
    }
    handlePeerCount(count) {
      this.peerCount = count;
      this.onPeerCountChange?.(count);
    }
    async createNode(api2, name, type, position) {
      if (!this.projectId) throw new Error("No project open");
      const wheelPos = position ? canvasToWheel(position, GRID_SCALE, GRID_OFFSET, GRID_OFFSET) : { x: 0, y: 0 };
      return api2.createNode(this.projectId, { name, type, position: wheelPos, config: defaultNodeConfig(type) });
    }
    paneIdForNode(nodeId) {
      return this.nodeToPane.get(nodeId)?.paneId || null;
    }
    nodeIdForPane(paneId) {
      return this.paneToNode.get(paneId)?.nodeId || null;
    }
    nodeForPane(paneId) {
      const entry = this.paneToNode.get(paneId);
      const node = entry ? this.nodesById[entry.nodeId] : void 0;
      if (!node) return null;
      return { ...node, wires: summarizeWires(node.id, this.wires, this.nodesById) };
    }
    persistState() {
      const state = {
        projectId: this.projectId,
        nodeToPane: [...this.nodeToPane],
        paneToNode: [...this.paneToNode],
        topologyPaneId: this.topologyPaneId
      };
      try {
        this.host.state.persist(state);
      } catch {
        return;
      }
    }
    async restoreState() {
      try {
        const state = await this.host.state.load();
        if (!state) return false;
        this.projectId = state.projectId || null;
        this.topologyPaneId = state.topologyPaneId || null;
        if (state.nodeToPane) this.nodeToPane = new Map(state.nodeToPane);
        if (state.paneToNode) this.paneToNode = new Map(state.paneToNode);
        return this.projectId !== null;
      } catch {
        return false;
      }
    }
    get mappedNodeCount() {
      return this.nodeToPane.size;
    }
    get activeProjectId() {
      return this.projectId;
    }
    spawnPaneForNode(node, position) {
      return node.type === "agent" ? this.spawnWorkerForNode(node, position) : this.spawnNoteForNode(node, position);
    }
    linkPane(node, paneId, type) {
      if (!paneId) return;
      this.nodeToPane.set(node.id, { paneId, type });
      this.paneToNode.set(paneId, { nodeId: node.id, nodeType: node.type });
    }
  };
  function canvasToWheel(canvasPos, scale, offsetX, offsetY) {
    return {
      x: Math.round((canvasPos.x - offsetX) / scale),
      y: Math.round((canvasPos.y - offsetY) / scale)
    };
  }
  function defaultNodeConfig(type) {
    switch (type) {
      case "agent":
        return { harness: "claude", system_prompt: "", run_on_startup: false, ephemeral_context: false };
      case "ctx":
        return { markdown: "" };
      case "table":
        return { columns: [{ name: "value", type: "text" }] };
      case "endpoint":
        return { method: "POST", path: "/hook", response_mode: "ack" };
      case "script":
        return { language: "python", source: "print('hello from wheel')\n", timeout_secs: 60 };
      case "mcp":
        return { transport: "stdio", command: "" };
      case "vault":
        return { keys: [] };
      case "chest":
        return {};
      case "tool":
        return { kind: "http", base_url: "", operations: [], source: { format: "manual", imported_at: (/* @__PURE__ */ new Date()).toISOString(), raw: "" } };
    }
  }
  function connectionsFor(connectionsByName, name) {
    const connections = connectionsByName.get(name) ?? { out: [], in: [] };
    connectionsByName.set(name, connections);
    return connections;
  }
  function defaultCanvasPosition(position) {
    return wheelToCanvas(position || { x: 0, y: 0 }, GRID_SCALE, GRID_OFFSET, GRID_OFFSET);
  }

  // src/dom.ts
  function byId(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing #${id} element`);
    return element;
  }

  // src/types.ts
  var NODE_TYPES = ["agent", "ctx", "table", "endpoint", "script", "mcp", "vault", "chest", "tool"];
  var WHEEL_EXTENSION_ID = "agentgrid.wheel";
  var DEFAULT_API_URL = "https://wheel-api-production-28d3.up.railway.app";
  function isNodeType(value) {
    return NODE_TYPES.includes(value);
  }
  function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
  }

  // src/wheel-api.ts
  var WheelApi = class {
    apiUrl;
    apiToken;
    constructor(apiUrl, apiToken) {
      this.apiUrl = apiUrl.replace(/\/+$/, "");
      this.apiToken = apiToken;
    }
    async request(path, opts = {}) {
      const headers = {};
      if (this.apiToken) headers["x-auth-token"] = this.apiToken;
      if (opts.body !== void 0) headers["content-type"] = "application/json";
      if (opts.projectId) headers["x-project-id"] = opts.projectId;
      const res = await fetch(`${this.apiUrl}${path}`, {
        method: opts.method || "GET",
        headers,
        body: opts.body !== void 0 ? JSON.stringify(opts.body) : void 0
      });
      if (!res.ok) {
        throw new Error(await readDetailedErrorMessage(res));
      }
      if (res.status === 204 || opts.expect === "void") return void 0;
      return res.json();
    }
    engine(projectId, ...segments) {
      return `/v1/projects/${encodeURIComponent(projectId)}/engine/v1/${segments.map(encodeURIComponent).join("/")}`;
    }
    login(email, password) {
      return this.postWithExplicitAuth("/v1/auth/login", { email, password }, {});
    }
    createToken(sessionToken, name) {
      return this.postWithExplicitAuth("/v1/auth/tokens", { name }, { "x-auth-token": sessionToken });
    }
    listProjects() {
      return this.request("/v1/projects");
    }
    getProject(projectId) {
      return this.request(`/v1/projects/${encodeURIComponent(projectId)}`, { projectId });
    }
    createProject(name) {
      return this.request("/v1/projects", { method: "POST", body: { name } });
    }
    startProject(projectId) {
      return this.request(`/v1/projects/${encodeURIComponent(projectId)}/start`, { method: "POST", projectId });
    }
    stopProject(projectId) {
      return this.request(`/v1/projects/${encodeURIComponent(projectId)}/stop`, { method: "POST", projectId });
    }
    async getBoard(projectId) {
      const result = await this.request(this.engine(projectId, "board"), { projectId });
      console.log("[wheel:api] getBoard raw response:", JSON.stringify(result));
      return result;
    }
    createNode(projectId, input) {
      return this.request(this.engine(projectId, "nodes"), { method: "POST", body: input, projectId });
    }
    patchNode(projectId, nodeId, patch) {
      return this.request(this.engine(projectId, "nodes", nodeId), { method: "PATCH", body: patch, projectId });
    }
    deleteNode(projectId, nodeId) {
      return this.request(this.engine(projectId, "nodes", nodeId), { method: "DELETE", projectId, expect: "void" });
    }
    createWire(projectId, from, to, type) {
      return this.request(this.engine(projectId, "wires"), { method: "POST", body: { from, to, type }, projectId });
    }
    deleteWire(projectId, from, to, type) {
      return this.request(this.engine(projectId, "wires"), { method: "DELETE", body: { from, to, type }, projectId, expect: "void" });
    }
    startAgent(projectId, nodeId) {
      return this.request(this.engine(projectId, "agents", nodeId, "start"), { method: "POST", projectId });
    }
    stopAgent(projectId, nodeId) {
      return this.request(this.engine(projectId, "agents", nodeId, "stop"), { method: "POST", projectId });
    }
    sendToAgent(projectId, nodeId, body) {
      return this.request(this.engine(projectId, "agents", nodeId, "send"), { method: "POST", body: { body }, projectId });
    }
    agentLog(projectId, nodeId, opts = {}) {
      const query = new URLSearchParams();
      if (opts.since !== void 0) query.set("since", String(opts.since));
      if (opts.stream) query.set("stream", opts.stream);
      const queryString = query.toString();
      const path = this.engine(projectId, "agents", nodeId, "log") + (queryString ? `?${queryString}` : "");
      return this.request(path, { projectId });
    }
    queryTable(projectId, nodeId, sql) {
      return this.request(this.engine(projectId, "tables", nodeId, "query"), { method: "POST", body: { sql }, projectId });
    }
    tableRows(projectId, nodeId, limit = 50, offset = 0) {
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      return this.request(this.engine(projectId, "tables", nodeId, "rows") + `?${query}`, { projectId });
    }
    putSecret(projectId, nodeId, key, value) {
      return this.request(this.engine(projectId, "vault", nodeId, key), { method: "PUT", body: { value }, projectId, expect: "void" });
    }
    async applyBoard(projectId, board, dryRun = false) {
      const res = await fetch(`${this.apiUrl}${this.engine(projectId, "board", "apply")}`, {
        method: "POST",
        headers: this.projectHeaders(projectId),
        body: JSON.stringify({ board, dry_run: dryRun })
      });
      return res.json();
    }
    importTool(projectId, raw, format) {
      const body = { raw };
      if (format) body.format = format;
      return this.request(this.engine(projectId, "tools", "import"), { method: "POST", body, projectId });
    }
    callTool(projectId, nodeId, op, args, dryRun = false) {
      return this.request(this.engine(projectId, "tools", nodeId, "call"), {
        method: "POST",
        body: { op, args, dry_run: dryRun },
        projectId
      });
    }
    messages(projectId) {
      return this.request(this.engine(projectId, "messages"), { projectId });
    }
    chestLs(projectId, nodeId, prefix = "") {
      const query = new URLSearchParams({ prefix });
      return this.request(this.engine(projectId, "chests", nodeId, "ls") + `?${query}`, { projectId });
    }
    async builderTurn(projectId, request) {
      const res = await fetch(`${this.apiUrl}/v1/projects/${encodeURIComponent(projectId)}/builder/turns`, {
        method: "POST",
        headers: this.projectHeaders(projectId),
        body: JSON.stringify(request)
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res));
      }
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream") || !res.body) {
        throw new Error("Builder did not return a stream");
      }
      return res.body;
    }
    async postWithExplicitAuth(path, body, authHeaders) {
      const res = await fetch(`${this.apiUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res));
      }
      return res.json();
    }
    projectHeaders(projectId) {
      return {
        "x-auth-token": this.apiToken,
        "x-project-id": projectId,
        "content-type": "application/json"
      };
    }
  };
  async function readDetailedErrorMessage(res) {
    try {
      const body = await res.json();
      console.log("[wheel:api] error response body:", JSON.stringify(body));
      return detailedMessageFrom(body, res.status);
    } catch {
      return `HTTP ${res.status}`;
    }
  }
  function detailedMessageFrom(body, status) {
    if (typeof body === "string") return body;
    const errorBody = body ?? {};
    if (typeof errorBody.error === "object" && errorBody.error?.message) return errorBody.error.message;
    if (typeof errorBody.error === "string") return errorBody.error;
    if (typeof errorBody.message === "string") return errorBody.message;
    if (errorBody.errors) return JSON.stringify(errorBody.errors);
    return `HTTP ${status}: ${JSON.stringify(body)}`;
  }
  async function readErrorMessage(res) {
    const statusMessage = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (typeof body?.error === "object" && body.error?.message) return body.error.message;
      if (typeof body?.error === "string") return body.error;
      return statusMessage;
    } catch {
      return statusMessage;
    }
  }

  // src/wheel-events.ts
  var MAX_RECONNECT_DELAY_MS = 3e4;
  var BASE_RECONNECT_DELAY_MS = 1e3;
  var WheelEventSource = class {
    api;
    projectId;
    handlers;
    ws = null;
    reconnectAttempt = 0;
    reconnectTimer = null;
    disposed = false;
    pendingFrames = [];
    flushScheduled = false;
    constructor(api2, projectId, handlers) {
      this.api = api2;
      this.projectId = projectId;
      this.handlers = handlers;
    }
    async connect() {
      if (this.disposed) return;
      const ticket = await this.fetchTicket();
      if (!ticket) {
        this.scheduleReconnect();
        return;
      }
      const ws = new WebSocket(this.buildWsUrl(ticket));
      this.ws = ws;
      ws.onopen = () => {
        this.reconnectAttempt = 0;
        this.handlers.onConnectionChange?.("connected");
      };
      ws.onmessage = (event) => {
        this.handleFrame(event.data);
      };
      ws.onclose = () => {
        this.ws = null;
        this.handlers.onConnectionChange?.("disconnected");
        if (!this.disposed) {
          this.scheduleReconnect();
        }
      };
      ws.onerror = () => {
      };
    }
    disconnect() {
      this.disposed = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.ws) {
        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
      }
      this.handlers.onConnectionChange?.("disconnected");
    }
    get connected() {
      return this.ws?.readyState === WebSocket.OPEN;
    }
    async fetchTicket() {
      try {
        const result = await this.api.request(
          `/v1/projects/${encodeURIComponent(this.projectId)}/ws-ticket`,
          { method: "POST" }
        );
        return result?.ticket || null;
      } catch {
        return null;
      }
    }
    buildWsUrl(ticket) {
      const base = this.api.apiUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
      return `${base}/v1/projects/${encodeURIComponent(this.projectId)}/engine/v1/events?ticket=${encodeURIComponent(ticket)}`;
    }
    handleFrame(raw) {
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      this.pendingFrames.push(frame);
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        requestAnimationFrame(() => this.flushFrames());
      }
    }
    flushFrames() {
      this.flushScheduled = false;
      for (const frame of this.pendingFrames.splice(0)) {
        this.dispatchFrame(frame);
      }
    }
    dispatchFrame(frame) {
      const payload = frame.payload || frame;
      switch (frame.kind || frame.type) {
        case "node.state":
          this.handlers.onNodeState?.(payload);
          break;
        case "board.changed":
          this.handlers.onBoardChanged?.(payload);
          break;
        case "message":
          this.handlers.onMessage?.(payload);
          break;
        case "log":
          this.handlers.onLog?.(payload);
          break;
        case "wire.denied":
          this.handlers.onWireDenied?.(payload);
          break;
        case "lagged":
          this.handlers.onLagged?.();
          break;
        case "peers":
          this.handlers.onPeers?.(payload);
          break;
        default:
          this.handlers.onUnknown?.(frame);
      }
    }
    scheduleReconnect() {
      if (this.disposed || this.reconnectTimer) return;
      const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempt), MAX_RECONNECT_DELAY_MS);
      this.reconnectAttempt++;
      this.handlers.onConnectionChange?.("reconnecting");
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    }
  };

  // src/main.ts
  var TOOL_HANDLERS = {
    wheel_list_projects: (api2) => api2.listProjects(),
    wheel_get_project: (api2, { projectId }) => api2.getProject(projectId),
    wheel_create_project: (api2, { name }) => api2.createProject(name),
    wheel_start_project: (api2, { projectId }) => api2.startProject(projectId),
    wheel_stop_project: (api2, { projectId }) => api2.stopProject(projectId),
    wheel_get_board: (api2, { projectId }) => api2.getBoard(projectId),
    wheel_create_node: (api2, { projectId, name, type, position, config }) => api2.createNode(projectId, { name, type, position, config: config || defaultNodeConfig(type) || {} }),
    wheel_patch_node: (api2, { projectId, nodeId, name, position, config }) => {
      const patch = {};
      if (name !== void 0) patch.name = name;
      if (position !== void 0) patch.position = position;
      if (config !== void 0) patch.config = config;
      return api2.patchNode(projectId, nodeId, patch);
    },
    wheel_delete_node: (api2, { projectId, nodeId }) => api2.deleteNode(projectId, nodeId),
    wheel_create_wire: (api2, { projectId, from, to, type }) => api2.createWire(projectId, from, to, type),
    wheel_delete_wire: (api2, { projectId, from, to, type }) => api2.deleteWire(projectId, from, to, type),
    wheel_start_agent: (api2, { projectId, nodeId }) => api2.startAgent(projectId, nodeId),
    wheel_stop_agent: (api2, { projectId, nodeId }) => api2.stopAgent(projectId, nodeId),
    wheel_send_to_agent: (api2, { projectId, nodeId, body }) => api2.sendToAgent(projectId, nodeId, body),
    wheel_agent_log: (api2, { projectId, nodeId, since, stream }) => api2.agentLog(projectId, nodeId, { since, stream }),
    wheel_query_table: (api2, { projectId, nodeId, sql }) => api2.queryTable(projectId, nodeId, sql),
    wheel_table_rows: (api2, { projectId, nodeId, limit, offset }) => api2.tableRows(projectId, nodeId, limit, offset),
    wheel_put_secret: (api2, { projectId, nodeId, key, value }) => api2.putSecret(projectId, nodeId, key, value),
    wheel_apply_board: (api2, { projectId, board, dryRun }) => api2.applyBoard(projectId, board, dryRun || false),
    wheel_import_tool: (api2, { projectId, raw, format }) => api2.importTool(projectId, raw, format),
    wheel_call_tool: (api2, { projectId, nodeId, op, args, dryRun }) => api2.callTool(projectId, nodeId, op, args, dryRun || false),
    wheel_messages: (api2, { projectId }) => api2.messages(projectId),
    wheel_chest_ls: (api2, { projectId, nodeId, prefix }) => api2.chestLs(projectId, nodeId, prefix),
    wheel_open_project: (api2, { projectId, scale, offsetX, offsetY }) => openProjectOnCanvas(api2, projectId, scale, offsetX, offsetY),
    wheel_poll_messages: async (api2, { projectId, since }) => {
      const response = await api2.messages(projectId);
      const all = Array.isArray(response) ? response : response.messages || [];
      const cursor = since || 0;
      const fresh = all.filter((m) => (m.seq || m.id || 0) > cursor);
      const nextCursor = fresh.length > 0 ? Math.max(...fresh.map((m) => m.seq || m.id || 0)) : cursor;
      return { messages: fresh, cursor: nextCursor };
    }
  };
  var NOT_CONFIGURED_MESSAGE = "Wheel API not configured. Open the Wheel pane and enter your API URL and token.";
  var NODE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
  var SPAWN_COMMAND_PREFIX = "wheel.spawn.";
  var MAX_LOG = 50;
  var MAX_GENERATED_NAME_INDEX = 100;
  var $setup = byId("setup");
  var $status = byId("status");
  var $dot = byId("dot");
  var $statusLabel = byId("status-label");
  var $apiUrlDisplay = byId("api-url-display");
  var $projectCount = byId("project-count");
  var $setupError = byId("setup-error");
  var $inputUrl = byId("input-url");
  var $inputEmail = byId("input-email");
  var $inputPassword = byId("input-password");
  var $inputToken = byId("input-token");
  var $tokenSection = byId("token-section");
  var $projectsSection = byId("projects-section");
  var $projectList = byId("project-list");
  var $syncStatus = byId("sync-status");
  var $syncDot = byId("sync-dot");
  var $syncLabel = byId("sync-label");
  var $syncDetail = byId("sync-detail");
  var $callLog = byId("call-log");
  var $btnSignin = byId("btn-signin");
  var callHistory = [];
  var panel;
  var api = null;
  var boardSync;
  var eventSource = null;
  start();
  async function start() {
    panel = await createPanel();
    boardSync = new BoardSync(panel);
    listenForTools();
    listenForCanvasEvents();
    $btnSignin.addEventListener("click", signIn);
    byId("btn-toggle-token").addEventListener("click", () => {
      $tokenSection.hidden = !$tokenSection.hidden;
    });
    byId("btn-save-token").addEventListener("click", saveToken);
    byId("btn-configure").addEventListener("click", () => showSetup(api?.apiUrl || ""));
    const restored = await boardSync.restoreState();
    try {
      const [url, token] = await Promise.all([panel.secrets.get("apiUrl"), panel.secrets.get("apiToken")]);
      if (!url || !token) {
        showSetup(url || DEFAULT_API_URL);
        return;
      }
      api = new WheelApi(url, token);
      await showStatus(api);
      const restoredProjectId = boardSync.activeProjectId;
      if (restored && restoredProjectId) {
        subscribeToCanvasEvents();
        connectEventStream(api, restoredProjectId);
        updateSyncStatus();
      }
    } catch {
      showSetup("");
    }
  }
  function listenForTools() {
    for (const toolName of Object.keys(TOOL_HANDLERS)) {
      panel.tools.onInvoke(toolName, (input) => runTool(toolName, input));
    }
    panel.events.on("tool", ({ callId, toolName }) => {
      if (toolName in TOOL_HANDLERS) return;
      panel.tools.settle(callId, { error: `Unknown tool: ${toolName}` });
      logCall(toolName, false, "unknown tool");
    });
  }
  async function runTool(toolName, input) {
    if (!api) {
      logCall(toolName, false, "not configured");
      throw new Error(NOT_CONFIGURED_MESSAGE);
    }
    const handler = TOOL_HANDLERS[toolName];
    try {
      const result = await handler(api, input || {});
      logCall(toolName, true, "");
      return result;
    } catch (err) {
      logCall(toolName, false, errorMessage(err));
      throw err;
    }
  }
  async function openProjectOnCanvas(wheelApi, projectId, scale, offsetX, offsetY) {
    eventSource?.disconnect();
    eventSource = null;
    boardSync.stopAllLogPolling();
    const result = await boardSync.openProject(wheelApi, projectId, scale || 120, offsetX || 100, offsetY || 100);
    subscribeToCanvasEvents();
    connectEventStream(wheelApi, projectId);
    startAgentLogPollers(wheelApi);
    updateSyncStatus();
    return { ...result, projectId, syncing: true };
  }
  function startAgentLogPollers(wheelApi) {
    for (const nodeId of boardSync.agentNodeIds()) {
      boardSync.startAgentLogPolling(wheelApi, nodeId);
    }
    boardSync.onAgentLog = (nodeId, _paneId, entries) => {
      logCall(`agent-log:${nodeId}`, true, `${entries.length} entries`);
    };
    boardSync.onAgentStatusChange = (nodeId, _paneId, status) => {
      logCall(`agent-status:${nodeId}`, true, status);
    };
  }
  function connectEventStream(wheelApi, projectId) {
    eventSource = new WheelEventSource(wheelApi, projectId, {
      onConnectionChange: (status) => {
        updateSyncConnection(status);
        if (status === "connected" && boardSync.activeProjectId) {
          reconcileOnReconnect(wheelApi);
        }
      },
      onNodeState: (payload) => boardSync.handleNodeState(payload),
      onBoardChanged: (payload) => boardSync.handleBoardChanged(payload),
      onLagged: () => boardSync.handleLagged(wheelApi),
      onPeers: (payload) => {
        const count = payload.count ?? payload.peers?.length ?? 0;
        boardSync.handlePeerCount(count);
        updatePeerCount(count);
      },
      onMessage: (payload) => {
        if (boardSync.activeProjectId && payload.node_id && boardSync.nodeToPane.has(payload.node_id)) {
          logCall(`ws:message:${payload.node_id}`, true, "");
        }
      },
      onLog: (payload) => {
        const entry = payload.node_id ? boardSync.nodeToPane.get(payload.node_id) : void 0;
        if (payload.node_id && entry) {
          boardSync.onAgentLog?.(payload.node_id, entry.paneId, [payload]);
        }
      },
      onWireDenied: (payload) => {
        logCall("ws:wire-denied", false, `${payload.from} \u2192 ${payload.to} (${payload.type})`);
      }
    });
    eventSource.connect();
  }
  async function reconcileOnReconnect(wheelApi) {
    const projectId = boardSync.activeProjectId;
    if (!projectId) return;
    try {
      await boardSync.reconcileBoard(await wheelApi.getBoard(projectId));
      updateSyncStatus();
    } catch {
      return;
    }
  }
  function subscribeToCanvasEvents() {
    panel.rpc.request("canvas.subscribe", {
      events: ["canvas.paneMoved", "canvas.paneClose", "canvas.workerComplete", "canvas.workerStatusChange"]
    }).catch(() => {
    });
  }
  function listenForCanvasEvents() {
    panel.rpc.on("canvas.paneMoved", (payload) => {
      const { paneId, x, y } = payload;
      const move = boardSync.handlePaneMoved(paneId, x, y);
      const projectId = boardSync.activeProjectId;
      if (move && projectId && api) {
        api.patchNode(projectId, move.nodeId, { position: move.position }).catch(() => {
        });
      }
    });
    panel.rpc.on("canvas.paneClose", (payload) => {
      const closed = boardSync.handlePaneClose(payload.paneId);
      const projectId = boardSync.activeProjectId;
      if (closed && projectId && api) {
        boardSync.stopAgentLogPolling(closed.nodeId);
        api.deleteNode(projectId, closed.nodeId).catch(() => {
        });
        updateSyncStatus();
      }
    });
    panel.rpc.on("canvas.workerComplete", (payload) => {
      const { paneId, response, error } = payload;
      const relay = response ? boardSync.handleWorkerComplete(paneId, response) : null;
      const projectId = boardSync.activeProjectId;
      if (relay && projectId && api && !error) {
        api.sendToAgent(projectId, relay.nodeId, relay.response).catch(() => {
        });
      }
    });
    panel.rpc.on("canvas.workerStatusChange", (payload) => {
      const { paneId, status } = payload;
      const entry = boardSync.paneToNode.get(paneId);
      const projectId = boardSync.activeProjectId;
      if (entry?.nodeType === "agent" && projectId && api && status === "running") {
        api.startAgent(projectId, entry.nodeId).catch(() => {
        });
      }
    });
    panel.events.on("command", ({ commandId }) => {
      if (commandId === "wheel.addNode") {
        showNodeCreationDialog();
      }
      if (commandId?.startsWith(SPAWN_COMMAND_PREFIX)) {
        handleSpawnCommand(commandId);
      }
    });
  }
  function showNodeCreationDialog() {
    if (!boardSync.activeProjectId || !api) return;
    const wheelApi = api;
    document.getElementById("node-dialog")?.remove();
    const dialog = document.createElement("div");
    const box = document.createElement("div");
    const heading = document.createElement("h3");
    const nameLabel = document.createElement("label");
    const nameInput = document.createElement("input");
    const typeLabel = document.createElement("label");
    const typeSelect = document.createElement("select");
    const actions = document.createElement("div");
    const cancelBtn = document.createElement("button");
    const createBtn = document.createElement("button");
    const errorEl = document.createElement("p");
    const showError = (message) => {
      errorEl.textContent = message;
      errorEl.hidden = false;
    };
    dialog.id = "node-dialog";
    dialog.className = "dialog-overlay";
    box.className = "dialog";
    heading.textContent = "Add Wheel Node";
    nameLabel.textContent = "Name";
    nameInput.id = "node-name";
    nameInput.type = "text";
    nameInput.placeholder = "my-node";
    nameLabel.appendChild(nameInput);
    typeLabel.textContent = "Type";
    typeSelect.id = "node-type";
    for (const nodeType of NODE_TYPES) {
      const option = document.createElement("option");
      option.value = nodeType;
      option.textContent = nodeType.charAt(0).toUpperCase() + nodeType.slice(1);
      typeSelect.appendChild(option);
    }
    typeLabel.appendChild(typeSelect);
    actions.className = "dialog-actions";
    cancelBtn.className = "link";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => dialog.remove());
    createBtn.textContent = "Create";
    errorEl.className = "error";
    errorEl.hidden = true;
    createBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      const type = typeSelect.value;
      if (!name) {
        showError("Name is required");
        return;
      }
      if (!NODE_NAME_PATTERN.test(name)) {
        showError("Name must be lowercase alphanumeric with dashes/underscores");
        return;
      }
      if (!isNodeType(type)) return;
      try {
        await boardSync.createNode(wheelApi, name, type);
        dialog.remove();
      } catch (err) {
        showError(errorMessage(err));
      }
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(createBtn);
    box.appendChild(heading);
    box.appendChild(nameLabel);
    box.appendChild(typeLabel);
    box.appendChild(actions);
    box.appendChild(errorEl);
    dialog.appendChild(box);
    document.body.appendChild(dialog);
  }
  async function handleSpawnCommand(commandId) {
    const nodeType = commandId.replace(SPAWN_COMMAND_PREFIX, "");
    if (!isNodeType(nodeType)) return;
    const projectId = boardSync.activeProjectId;
    if (!projectId || !api) {
      logCall(commandId, false, "no project open");
      return;
    }
    try {
      const name = generateNodeName(nodeType);
      const paneKind = nodeType === "agent" ? "worker" : "note";
      const node = await api.createNode(projectId, {
        name,
        type: nodeType,
        position: { x: 0, y: 0 },
        config: defaultNodeConfig(nodeType)
      });
      const { paneId } = await panel.canvas.spawn({
        kind: paneKind,
        title: name,
        extensionId: WHEEL_EXTENSION_ID,
        surfaceId: "wheel-node"
      });
      if (paneId && node?.id) {
        boardSync.nodeToPane.set(node.id, { paneId, type: paneKind });
        boardSync.paneToNode.set(paneId, { nodeId: node.id, nodeType });
        boardSync.nodesById[node.id] = node;
        boardSync.persistState();
        updateSyncStatus();
      }
      logCall(commandId, true, name);
    } catch (err) {
      logCall(commandId, false, errorMessage(err));
    }
  }
  function generateNodeName(nodeType) {
    const existingNames = /* @__PURE__ */ new Set();
    for (const entry of boardSync.paneToNode.values()) {
      const name = boardSync.nodesById[entry.nodeId]?.name;
      if (name) existingNames.add(name);
    }
    for (let i = 1; i <= MAX_GENERATED_NAME_INDEX; i++) {
      const candidate = `${nodeType}-${i}`;
      if (!existingNames.has(candidate)) return candidate;
    }
    return `${nodeType}-${Date.now()}`;
  }
  function logCall(toolName, ok, detail) {
    callHistory.unshift({ toolName, ok, detail, time: /* @__PURE__ */ new Date() });
    if (callHistory.length > MAX_LOG) callHistory.length = MAX_LOG;
    renderLog();
  }
  function renderLog() {
    $callLog.textContent = "";
    for (const entry of callHistory) {
      const li = document.createElement("li");
      const timeSpan = document.createElement("span");
      const nameSpan = document.createElement("span");
      const statusSpan = document.createElement("span");
      const resultSpan = document.createElement("span");
      timeSpan.textContent = entry.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " ";
      nameSpan.className = "tool-name";
      nameSpan.textContent = entry.toolName;
      statusSpan.textContent = " ";
      resultSpan.className = entry.ok ? "ok" : "fail";
      resultSpan.textContent = entry.ok ? "ok" : entry.detail;
      li.appendChild(timeSpan);
      li.appendChild(nameSpan);
      li.appendChild(statusSpan);
      li.appendChild(resultSpan);
      $callLog.appendChild(li);
    }
  }
  function showSetup(url) {
    $setup.hidden = false;
    $status.hidden = true;
    $inputUrl.value = url;
    $inputEmail.value = "";
    $inputPassword.value = "";
    $inputToken.value = "";
    $tokenSection.hidden = true;
    $setupError.hidden = true;
  }
  async function showStatus(wheelApi) {
    $setup.hidden = true;
    $status.hidden = false;
    $apiUrlDisplay.textContent = wheelApi.apiUrl;
    $dot.className = "dot";
    $statusLabel.textContent = "Checking...";
    $projectCount.textContent = "";
    try {
      const projects = await wheelApi.listProjects();
      $dot.className = "dot ok";
      $statusLabel.textContent = "Connected";
      $projectCount.textContent = `${projects.length} project${projects.length === 1 ? "" : "s"}`;
      renderProjectList(wheelApi, projects);
    } catch (err) {
      $dot.className = "dot err";
      $statusLabel.textContent = "Error";
      $projectCount.textContent = errorMessage(err);
      $projectsSection.hidden = true;
    }
  }
  function renderProjectList(wheelApi, projects) {
    $projectsSection.hidden = false;
    $projectList.textContent = "";
    for (const project of projects) {
      const li = document.createElement("li");
      const nameSpan = document.createElement("span");
      const openBtn = document.createElement("button");
      li.className = "project-item";
      nameSpan.className = "project-name";
      nameSpan.textContent = project.name || project.id;
      openBtn.className = "btn-small";
      openBtn.textContent = "Open on Canvas";
      openBtn.addEventListener("click", () => handleOpenProject(wheelApi, project.id));
      li.appendChild(nameSpan);
      li.appendChild(openBtn);
      $projectList.appendChild(li);
    }
  }
  async function handleOpenProject(wheelApi, projectId) {
    try {
      showSyncOpening();
      await openProjectOnCanvas(wheelApi, projectId);
    } catch (err) {
      showSyncError(errorMessage(err));
    }
  }
  function showSyncOpening() {
    $syncStatus.hidden = false;
    $syncDot.className = "dot";
    $syncLabel.textContent = "Opening board...";
    $syncDetail.textContent = "";
  }
  function showSyncError(detail) {
    $syncStatus.hidden = false;
    $syncDot.className = "dot err";
    $syncLabel.textContent = "Sync error";
    $syncDetail.textContent = detail;
  }
  function updateSyncStatus() {
    if (!boardSync.activeProjectId) {
      $syncStatus.hidden = true;
      return;
    }
    $syncStatus.hidden = false;
    $syncDot.className = "dot ok";
    $syncLabel.textContent = "Synced";
    $syncDetail.textContent = describeNodeCount(boardSync.mappedNodeCount);
  }
  function updateSyncConnection(wsStatus) {
    if ($syncStatus.hidden) return;
    if (wsStatus === "connected") {
      $syncDot.className = "dot ok";
      $syncLabel.textContent = "Live";
    } else if (wsStatus === "reconnecting") {
      $syncDot.className = "dot";
      $syncLabel.textContent = "Reconnecting...";
    } else {
      $syncDot.className = "dot err";
      $syncLabel.textContent = "Disconnected";
    }
  }
  function updatePeerCount(count) {
    const peerText = count > 0 ? ` \xB7 ${count} peer${count === 1 ? "" : "s"}` : "";
    $syncDetail.textContent = describeNodeCount(boardSync.mappedNodeCount || 0) + peerText;
  }
  function describeNodeCount(nodeCount) {
    return `${nodeCount} node${nodeCount === 1 ? "" : "s"} on canvas`;
  }
  function validateUrl() {
    const url = $inputUrl.value.trim() || DEFAULT_API_URL;
    try {
      new URL(url);
    } catch {
      showSetupError("Invalid URL");
      return null;
    }
    $setupError.hidden = true;
    return url;
  }
  async function signIn() {
    const url = validateUrl();
    if (!url) return;
    const email = $inputEmail.value.trim();
    const password = $inputPassword.value;
    if (!email || !password) {
      showSetupError("Email and password are required");
      return;
    }
    $btnSignin.disabled = true;
    $btnSignin.textContent = "Signing in...";
    $setupError.hidden = true;
    try {
      const unauthenticatedApi = new WheelApi(url, "");
      const session = await unauthenticatedApi.login(email, password);
      const created = await unauthenticatedApi.createToken(session.token, "AgentGrid");
      await panel.secrets.set("apiUrl", url);
      await panel.secrets.set("apiToken", created.token);
      api = new WheelApi(url, created.token);
      await showStatus(api);
    } catch (err) {
      showSetupError(errorMessage(err));
    } finally {
      $btnSignin.disabled = false;
      $btnSignin.textContent = "Sign in";
    }
  }
  async function saveToken() {
    const url = validateUrl();
    if (!url) return;
    const token = $inputToken.value.trim();
    try {
      await panel.secrets.set("apiUrl", url);
      if (token) await panel.secrets.set("apiToken", token);
      api = new WheelApi(url, token);
      await showStatus(api);
    } catch (err) {
      showSetupError(errorMessage(err));
    }
  }
  function showSetupError(message) {
    $setupError.textContent = message;
    $setupError.hidden = false;
  }
})();
