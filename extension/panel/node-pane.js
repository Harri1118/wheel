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
  function createWireMatrix(rules) {
    return { rules };
  }
  function wireAllowed(matrix, fromType, toType, wireType) {
    return matrix.rules.some((rule) => rule.from === fromType && rule.to === toType && rule.type === wireType);
  }
  function allowedWireTypes(matrix, fromType, toType) {
    return matrix.rules.filter((rule) => rule.from === fromType && rule.to === toType).map((rule) => rule.type);
  }
  function allowedTargets(matrix, fromType) {
    return matrix.rules.filter((rule) => rule.from === fromType).map((rule) => ({ toType: rule.to, wireType: rule.type }));
  }
  function outputTypes(matrix, nodeType) {
    return unique(matrix.rules.filter((rule) => rule.from === nodeType).map((rule) => rule.type));
  }
  function inputTypes(matrix, nodeType) {
    return unique(matrix.rules.filter((rule) => rule.to === nodeType).map((rule) => rule.type));
  }
  function unique(values) {
    return [...new Set(values)];
  }

  // src/board-state.ts
  var BOARD_STATE_KEY = "boardState";
  async function readBoardState(secrets) {
    const raw = await secrets.get(BOARD_STATE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    return {
      ...stored,
      projectId: stored.projectId ?? null,
      paneToNode: stored.paneToNode ?? {},
      nodesById: stored.nodesById ?? {}
    };
  }
  function writeBoardState(secrets, board) {
    return secrets.set(BOARD_STATE_KEY, JSON.stringify(board));
  }
  async function associatePanesByWires(canvas, paneToNode, wires) {
    const paneByNodeId = {};
    const peersByPane = {};
    for (const [paneId, entry] of Object.entries(paneToNode)) {
      paneByNodeId[entry.nodeId] = paneId;
      peersByPane[paneId] = /* @__PURE__ */ new Set();
    }
    for (const wire of wires) {
      const fromPane = paneByNodeId[wire.from];
      const toPane = paneByNodeId[wire.to];
      if (fromPane && toPane) {
        peersByPane[fromPane]?.add(toPane);
        peersByPane[toPane]?.add(fromPane);
      }
    }
    for (const [paneId, peers] of Object.entries(peersByPane)) {
      await canvas.update({ paneId, associatedPaneIds: [...peers] }).catch(() => {
      });
    }
  }

  // src/dom.ts
  function byId(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing #${id} element`);
    return element;
  }
  function setSaveStatus(statusEl, tone, text) {
    if (!statusEl) return;
    statusEl.className = tone ? `save-status ${tone}` : "save-status";
    statusEl.textContent = text;
  }

  // src/types.ts
  var NODE_TYPES = ["agent", "ctx", "table", "endpoint", "script", "mcp", "vault", "chest", "tool"];
  var WHEEL_EXTENSION_ID = "agentgrid.wheel";
  var DEFAULT_API_URL = "https://wheel-api-production-28d3.up.railway.app";
  function isNodeType(value) {
    return NODE_TYPES.includes(value);
  }
  function surfaceIdFor(nodeType) {
    return `wheel-${nodeType}`;
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

  // src/wire-matrix.ts
  var WHEEL_WIRE_RULES = [
    ["agent", "send", "agent"],
    ["agent", "read", "ctx"],
    ["agent", "write", "ctx"],
    ["agent", "read", "table"],
    ["agent", "write", "table"],
    ["agent", "read", "vault"],
    ["agent", "read", "chest"],
    ["agent", "write", "chest"],
    ["agent", "read", "script"],
    ["agent", "read", "mcp"],
    ["agent", "read", "tool"],
    ["ctx", "send", "agent"],
    ["endpoint", "send", "agent"],
    ["endpoint", "write", "table"],
    ["endpoint", "send", "script"],
    ["endpoint", "read", "vault"],
    ["script", "send", "agent"],
    ["script", "read", "ctx"],
    ["script", "write", "ctx"],
    ["script", "read", "table"],
    ["script", "write", "table"],
    ["script", "read", "chest"],
    ["script", "write", "chest"],
    ["script", "read", "vault"],
    ["script", "read", "tool"],
    ["tool", "read", "vault"]
  ];
  var WHEEL_WIRES = createWireMatrix(WHEEL_WIRE_RULES.map(([from, type, to]) => ({ from, to, type })));
  function wheelWireAllowed(fromType, wireType, toType) {
    return wireAllowed(WHEEL_WIRES, fromType, toType, wireType);
  }
  function wheelWireTypes(fromType, toType) {
    return allowedWireTypes(WHEEL_WIRES, fromType, toType);
  }
  function wheelTargetTypes(fromType) {
    return new Set(allowedTargets(WHEEL_WIRES, fromType).map((target) => target.toType));
  }
  function wheelOutputTypes(nodeType) {
    return outputTypes(WHEEL_WIRES, nodeType);
  }
  function wheelInputTypes(nodeType) {
    return inputTypes(WHEEL_WIRES, nodeType);
  }

  // src/node-pane.ts
  var HARNESS_OPTIONS = [
    { value: "", label: "(default)" },
    { value: "claude", label: "Claude Code" },
    { value: "codex", label: "Codex" },
    { value: "opencode", label: "OpenCode" },
    { value: "cursor", label: "Cursor" },
    { value: "grok", label: "Grok" },
    { value: "devin", label: "Devin" },
    { value: "kimi", label: "Kimi" },
    { value: "antigravity", label: "Antigravity" }
  ];
  var NODE_TYPE_LABELS = {
    agent: "Agent",
    ctx: "Context",
    table: "Table",
    endpoint: "Endpoint",
    script: "Script",
    mcp: "MCP Server",
    vault: "Vault",
    chest: "Chest",
    tool: "Tool"
  };
  var SURFACE_TO_NODE_TYPE = {
    "wheel-agent": "agent",
    "wheel-ctx": "ctx",
    "wheel-table": "table",
    "wheel-endpoint": "endpoint",
    "wheel-script": "script",
    "wheel-mcp": "mcp",
    "wheel-vault": "vault",
    "wheel-chest": "chest",
    "wheel-tool": "tool"
  };
  var BOARD_ENTRY_TIMEOUT_MS = 15e3;
  var BOARD_ENTRY_POLL_MS = 150;
  var BOARD_ENTRY_VERBOSE_ATTEMPTS = 3;
  var AGENT_LOG_POLL_MS = 3e3;
  var AGENT_STATUS_POLL_MS = 1e4;
  var SAVED_STATUS_CLEAR_MS = 2e3;
  var WIRE_PICKER_DISMISS_DELAY_MS = 50;
  var SPAWN_GRID_SCALE = 300;
  var SPAWN_GRID_OFFSET = 100;
  var $card = byId("node-card");
  var $loading = byId("loading");
  var panel;
  var paneApi = null;
  var nodeData = null;
  var activeProjectId = null;
  var myPaneId = null;
  var myNodeType = null;
  var agentLogCursor = 0;
  var agentLogTimer = null;
  var statusPollTimer = null;
  start();
  async function start() {
    console.log("[wheel:node-pane] initNodePane starting");
    try {
      panel = await createPanel();
      listenForCanvasEvents();
      await initNodePane();
    } catch (err) {
      console.error("[wheel:node-pane] initNodePane error:", err);
      showLoadError(errorMessage(err));
    }
  }
  async function initNodePane() {
    const [apiUrl, apiToken] = await Promise.all([panel.secrets.get("apiUrl"), panel.secrets.get("apiToken")]);
    const { paneId, surfaceId } = panel.description;
    const autoCreatableType = SURFACE_TO_NODE_TYPE[surfaceId];
    myPaneId = paneId;
    console.log("[wheel:node-pane] desc:", JSON.stringify(panel.description));
    if (!paneId) {
      $loading.textContent = "No pane identity.";
      return;
    }
    if (apiToken) {
      paneApi = new WheelApi(apiUrl || DEFAULT_API_URL, apiToken);
    }
    console.log("[wheel:node-pane] calling waitForBoardEntry, paneId:", paneId);
    let entry = await waitForBoardEntry(paneId);
    console.log("[wheel:node-pane] waitForBoardEntry returned:", entry ? JSON.stringify({ nodeId: entry.nodeId, nodeType: entry.nodeType, projectId: entry.projectId }) : "null");
    if (!entry && autoCreatableType) {
      const isUserSpawned = await checkUserSpawned();
      console.log("[wheel:node-pane] no entry, isUserSpawned:", isUserSpawned);
      if (isUserSpawned) {
        entry = await autoCreateNode(paneId, autoCreatableType);
        console.log("[wheel:node-pane] autoCreateNode returned:", entry ? "ok" : "null");
      }
    }
    if (!entry && autoCreatableType) {
      console.log("[wheel:node-pane] FAIL: no entry after all attempts, paneApi:", !!paneApi);
      $loading.textContent = paneApi ? "Failed to create node on Wheel." : "Configure Wheel API in extension settings.";
      return;
    }
    if (!entry) {
      $loading.textContent = paneApi ? "Node not found." : "Configure Wheel API in extension settings.";
      return;
    }
    activeProjectId = entry.projectId;
    myNodeType = entry.nodeType;
    nodeData = {
      id: entry.nodeId,
      type: entry.nodeType,
      name: entry.nodeName,
      config: entry.nodeConfig || {},
      wires: entry.wires || []
    };
    if (entry.nodeName) {
      panel.canvas.update({ paneId, customTitle: entry.nodeName }).catch(() => {
      });
    }
    renderNode(nodeData);
    renderSockets(entry.nodeType);
    if (paneApi && entry.projectId && entry.nodeType === "agent") {
      pollAgentStatus(entry.projectId, entry.nodeId);
    }
  }
  function showLoadError(message) {
    const looksLikeNetworkFailure = message.includes("fetch") || message.includes("network") || message.includes("Failed");
    $loading.textContent = looksLikeNetworkFailure ? "Connection error. Configure Wheel API in extension settings." : message;
  }
  async function checkUserSpawned() {
    const board = await readBoardState(panel.secrets).catch(() => null);
    if (!board) {
      console.log("[wheel:node-pane] checkUserSpawned: no boardState \u2192 true");
      return true;
    }
    console.log("[wheel:node-pane] checkUserSpawned: projectId:", board.projectId, "spawning:", board.spawning, "paneToNode keys:", Object.keys(board.paneToNode));
    return !board.projectId || !board.spawning;
  }
  async function autoCreateNode(paneId, nodeType) {
    if (!paneApi) return null;
    const board = await readBoardState(panel.secrets).catch(() => null);
    if (!board?.projectId) return null;
    const name = nextAvailableName(nodeType, Object.values(board.paneToNode).map((e) => e.nodeName));
    const node = await paneApi.createNode(board.projectId, {
      name,
      type: nodeType,
      position: { x: 0, y: 0 },
      config: {}
    }).catch((err) => {
      console.error("[wheel:node-pane] autoCreateNode API failed:", err);
      return null;
    });
    if (!node?.id) return null;
    const entry = {
      nodeId: node.id,
      nodeType,
      nodeName: node.name || name,
      nodeConfig: node.config || {},
      wires: []
    };
    board.paneToNode[paneId] = entry;
    board.nodesById[node.id] = node;
    await writeBoardState(panel.secrets, board);
    await panel.canvas.update({ paneId, customTitle: entry.nodeName }).catch(() => {
    });
    console.log("[wheel:node-pane] autoCreateNode created", nodeType, node.id, "for pane", paneId);
    return { ...entry, projectId: board.projectId };
  }
  function nextAvailableName(nodeType, takenNames) {
    const existingNames = new Set(takenNames.filter(Boolean));
    const separator = nodeType === "table" ? "_" : "-";
    let counter = 1;
    while (existingNames.has(`${nodeType}${separator}${counter}`)) counter++;
    return `${nodeType}${separator}${counter}`;
  }
  async function waitForBoardEntry(paneId) {
    const deadline = Date.now() + BOARD_ENTRY_TIMEOUT_MS;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      const board = await readBoardState(panel.secrets).catch((err) => {
        console.log("[wheel:node-pane] waitForBoardEntry secrets.get failed attempt", attempt, errorMessage(err));
        return null;
      });
      if (!board) {
        if (attempt <= BOARD_ENTRY_VERBOSE_ATTEMPTS) console.log("[wheel:node-pane] waitForBoardEntry attempt", attempt, "no boardState value");
        await sleep(BOARD_ENTRY_POLL_MS);
        continue;
      }
      const entry = board.paneToNode[paneId];
      const closedNodes = board.closedNodes || {};
      const closedKeys = Object.keys(closedNodes);
      if (attempt <= BOARD_ENTRY_VERBOSE_ATTEMPTS || entry) {
        console.log(
          "[wheel:node-pane] waitForBoardEntry attempt",
          attempt,
          "spawning:",
          board.spawning,
          "projectId:",
          board.projectId,
          "myPaneId:",
          paneId,
          "paneToNode keys:",
          Object.keys(board.paneToNode),
          "found:",
          !!entry,
          "closedNodes:",
          closedKeys
        );
      }
      if (entry) return { ...entry, projectId: board.projectId };
      const closedNodeId = closedKeys[0];
      const closedEntry = closedNodeId ? closedNodes[closedNodeId] : void 0;
      if (!board.spawning && closedNodeId && closedEntry && board.projectId) {
        console.log("[wheel:node-pane] recovering from closedNodes:", closedNodeId, closedEntry.nodeName);
        const recovered = {
          nodeId: closedNodeId,
          nodeType: closedEntry.nodeType,
          nodeName: closedEntry.nodeName,
          nodeConfig: closedEntry.nodeConfig,
          wires: closedEntry.wires || []
        };
        board.paneToNode[paneId] = recovered;
        delete closedNodes[closedNodeId];
        if (Object.keys(closedNodes).length === 0) delete board.closedNodes;
        await writeBoardState(panel.secrets, board);
        return { ...recovered, projectId: board.projectId };
      }
      if (!board.spawning) {
        console.log("[wheel:node-pane] waitForBoardEntry giving up: spawning=false, no entry for", paneId);
        return null;
      }
      await sleep(BOARD_ENTRY_POLL_MS);
    }
    console.log("[wheel:node-pane] waitForBoardEntry timed out after", attempt, "attempts");
    return null;
  }
  function renderNode(node) {
    $card.textContent = "";
    renderHeader(node);
    if (node.type === "agent") {
      renderAgentStatusRow();
      appendSeparator();
      renderAgentConfig(node);
      appendSeparator();
      renderAgentRuntime();
    }
    if (node.wires.length > 0) {
      appendSeparator();
      renderWires(node);
    }
    if (node.type !== "agent") {
      renderNonAgentConfig(node);
    }
    if (node.type === "table") {
      appendSeparator();
      renderTableRuntime();
    } else if (node.type === "vault") {
      appendSeparator();
      renderVaultRuntime();
    } else if (node.type === "chest") {
      appendSeparator();
      renderChestRuntime();
    } else if (node.type === "tool") {
      appendSeparator();
      renderToolRuntime(node);
    }
  }
  function renderHeader(node) {
    const header = document.createElement("div");
    const badge = document.createElement("span");
    const name = document.createElement("span");
    header.className = "node-header";
    badge.className = `type-badge ${node.type}`;
    badge.textContent = node.type;
    name.className = "node-name";
    name.textContent = node.name;
    header.appendChild(badge);
    header.appendChild(name);
    if (node.uncommitted) {
      const tag = document.createElement("span");
      tag.className = "uncommitted-badge";
      tag.textContent = "uncommitted";
      header.appendChild(tag);
    }
    $card.appendChild(header);
  }
  function renderAgentStatusRow() {
    const row = document.createElement("div");
    const dot = document.createElement("span");
    const label = document.createElement("span");
    const actions = document.createElement("div");
    row.className = "status-row";
    row.id = "status-row";
    dot.className = "status-dot stopped";
    dot.id = "status-dot";
    label.id = "status-label";
    label.textContent = "Stopped";
    actions.className = "status-actions";
    actions.appendChild(createButton("Start", "btn-sm primary", () => agentAction("start")));
    actions.appendChild(createButton("Restart", "btn-sm", () => agentAction("restart")));
    actions.appendChild(createButton("Clear", "btn-sm danger", () => agentAction("clear")));
    row.appendChild(dot);
    row.appendChild(label);
    row.appendChild(actions);
    $card.appendChild(row);
  }
  function renderAgentConfig(node) {
    const cfg = node.config;
    const harnessGroup = createFieldGroup("Harness");
    const harnessSelect = document.createElement("select");
    const modelGroup = createFieldGroup("Model");
    const modelInput = document.createElement("input");
    const promptGroup = createFieldGroup("System prompt");
    const promptArea = document.createElement("textarea");
    const saveRow = document.createElement("div");
    const saveStatus = document.createElement("span");
    const saveBtn = createButton("Save", "btn-sm primary", () => saveAgentConfig());
    harnessSelect.className = "field-select";
    harnessSelect.id = "field-harness";
    for (const option of HARNESS_OPTIONS) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      if (option.value === (cfg.harness || "")) element.selected = true;
      harnessSelect.appendChild(element);
    }
    harnessGroup.appendChild(harnessSelect);
    $card.appendChild(harnessGroup);
    modelInput.className = "field-input";
    modelInput.id = "field-model";
    modelInput.type = "text";
    modelInput.value = cfg.model || "";
    modelInput.placeholder = "Leave empty for harness default";
    modelGroup.appendChild(modelInput);
    modelGroup.appendChild(createFieldHint("Leave empty for the harness default."));
    $card.appendChild(modelGroup);
    promptArea.className = "field-textarea";
    promptArea.id = "field-system-prompt";
    promptArea.rows = 4;
    promptArea.value = cfg.system_prompt || "";
    promptArea.placeholder = "Instructions for this agent...";
    promptGroup.appendChild(promptArea);
    promptGroup.appendChild(createFieldHint("Applied on start and again after every context clear."));
    $card.appendChild(promptGroup);
    saveRow.className = "save-row";
    saveStatus.className = "save-status";
    saveStatus.id = "save-status";
    saveBtn.id = "save-btn";
    saveRow.appendChild(saveStatus);
    saveRow.appendChild(saveBtn);
    $card.appendChild(saveRow);
    appendSeparator();
    renderToggle(
      "start-with-project",
      "Start with the project",
      "Comes up automatically whenever the container starts.",
      !!cfg.run_on_startup
    );
    renderToggle(
      "clear-context",
      "Clear context after each turn",
      "Resets the conversation after each message cycle.",
      !!cfg.ephemeral_context
    );
  }
  function renderToggle(id, label, description, checked) {
    const row = document.createElement("div");
    const toggle = document.createElement("label");
    const input = document.createElement("input");
    const slider = document.createElement("span");
    const text = document.createElement("div");
    const labelEl = document.createElement("span");
    const desc = document.createElement("span");
    row.className = "toggle-row";
    toggle.className = "toggle-switch";
    input.type = "checkbox";
    input.id = `toggle-${id}`;
    input.checked = checked;
    input.addEventListener("change", () => saveAgentConfig());
    slider.className = "toggle-slider";
    text.className = "toggle-text";
    labelEl.className = "toggle-label";
    labelEl.textContent = label;
    desc.className = "toggle-desc";
    desc.textContent = description;
    toggle.appendChild(input);
    toggle.appendChild(slider);
    text.appendChild(labelEl);
    text.appendChild(desc);
    row.appendChild(toggle);
    row.appendChild(text);
    $card.appendChild(row);
  }
  function renderWires(node) {
    const wiresRow = document.createElement("div");
    wiresRow.className = "wires-row";
    for (const wire of node.wires) {
      const wireSpan = document.createElement("span");
      const arrow = wire.direction === "outgoing" ? " \u2192 " : " \u2190 ";
      wireSpan.className = `wire-${wire.type}`;
      wireSpan.textContent = wire.type;
      wiresRow.appendChild(wireSpan);
      wiresRow.appendChild(document.createTextNode(arrow + wire.peerName));
      wiresRow.appendChild(document.createTextNode(" \xB7 "));
    }
    $card.appendChild(wiresRow);
  }
  function renderNonAgentConfig(node) {
    const keys = Object.keys(node.config).filter((key) => {
      const value = node.config[key];
      return value !== "" && value !== null && value !== void 0;
    });
    if (keys.length === 0) return;
    const preview = document.createElement("div");
    preview.className = "config-preview";
    preview.textContent = keys.join(", ");
    $card.appendChild(preview);
  }
  function renderAgentRuntime() {
    const section = createRuntimeSection("Transcript");
    const log = document.createElement("div");
    const inputRow = document.createElement("div");
    const textarea = document.createElement("textarea");
    const sendBtn = createButton("Send", "btn-sm primary", () => sendAgentMessage(textarea));
    log.className = "msg-log";
    log.id = "agent-log";
    section.appendChild(log);
    inputRow.className = "msg-input-row";
    textarea.placeholder = "Send a message...";
    textarea.rows = 1;
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendAgentMessage(textarea);
      }
    });
    sendBtn.id = "agent-send-btn";
    inputRow.appendChild(textarea);
    inputRow.appendChild(sendBtn);
    section.appendChild(inputRow);
    $card.appendChild(section);
    startAgentLogPoll();
  }
  async function sendAgentMessage(textarea) {
    const body = textarea.value.trim();
    if (!body || !paneApi || !activeProjectId || !nodeData) return;
    const sendBtn = document.getElementById("agent-send-btn");
    if (sendBtn) sendBtn.disabled = true;
    textarea.disabled = true;
    try {
      await paneApi.sendToAgent(activeProjectId, nodeData.id, body);
      textarea.value = "";
      pollAgentLog();
    } catch (err) {
      appendLogEntry("agent-log", errorMessage(err), "log-stderr");
    } finally {
      textarea.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      textarea.focus();
    }
  }
  function startAgentLogPoll() {
    if (agentLogTimer) clearInterval(agentLogTimer);
    agentLogCursor = 0;
    pollAgentLog();
    agentLogTimer = setInterval(pollAgentLog, AGENT_LOG_POLL_MS);
  }
  async function pollAgentLog() {
    if (!paneApi || !activeProjectId || !nodeData) return;
    try {
      const result = await paneApi.agentLog(activeProjectId, nodeData.id, { since: agentLogCursor });
      const entries = Array.isArray(result) ? result : result?.entries || [];
      if (!document.getElementById("agent-log")) return;
      for (const entry of entries) {
        const seq = entry.seq ?? entry.id ?? 0;
        if (seq > agentLogCursor) agentLogCursor = seq;
        appendLogEntry("agent-log", entry.line || entry.text || JSON.stringify(entry), logEntryClass(entry.stream || ""));
      }
    } catch {
      return;
    }
  }
  function logEntryClass(stream) {
    if (stream === "stderr") return "log-entry log-stderr";
    if (stream === "transcript" || stream === "stdout") return "log-entry log-out";
    return "log-entry log-system";
  }
  function appendLogEntry(containerId, text, className) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const line = document.createElement("div");
    line.className = className || "log-entry";
    line.textContent = text;
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
  }
  function renderTableRuntime() {
    const section = createRuntimeSection("Data");
    const viewer = document.createElement("div");
    const sqlRow = document.createElement("div");
    const sqlInput = document.createElement("input");
    const errEl = document.createElement("div");
    viewer.className = "table-viewer";
    viewer.id = "table-viewer";
    section.appendChild(viewer);
    sqlRow.className = "sql-row";
    sqlInput.type = "text";
    sqlInput.placeholder = "SELECT * FROM ...";
    sqlInput.id = "sql-input";
    sqlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runSqlQuery();
    });
    sqlRow.appendChild(sqlInput);
    sqlRow.appendChild(createButton("Run", "btn-sm primary", runSqlQuery));
    sqlRow.appendChild(createButton("Rows", "btn-sm", loadTableRows));
    section.appendChild(sqlRow);
    errEl.className = "runtime-error";
    errEl.id = "table-error";
    errEl.hidden = true;
    section.appendChild(errEl);
    $card.appendChild(section);
    loadTableRows();
  }
  async function loadTableRows() {
    if (!paneApi || !activeProjectId || !nodeData) return;
    const api = paneApi;
    const projectId = activeProjectId;
    const nodeId = nodeData.id;
    await showTableResult(() => api.tableRows(projectId, nodeId, 50, 0));
  }
  async function runSqlQuery() {
    const sqlInput = document.getElementById("sql-input");
    if (!sqlInput || !paneApi || !activeProjectId || !nodeData) return;
    const sql = sqlInput.value.trim();
    if (!sql) return;
    const api = paneApi;
    const projectId = activeProjectId;
    const nodeId = nodeData.id;
    await showTableResult(() => api.queryTable(projectId, nodeId, sql));
  }
  async function showTableResult(fetchTable) {
    const errEl = document.getElementById("table-error");
    if (errEl) errEl.hidden = true;
    try {
      renderTableData(await fetchTable());
    } catch (err) {
      if (errEl) {
        errEl.textContent = errorMessage(err);
        errEl.hidden = false;
      }
    }
  }
  function renderTableData(result) {
    const viewer = document.getElementById("table-viewer");
    if (!viewer) return;
    viewer.textContent = "";
    const columns = result?.columns || [];
    const rows = result?.rows || [];
    if (columns.length === 0 && rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-table";
      empty.textContent = "No data.";
      viewer.appendChild(empty);
      return;
    }
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    const tbody = document.createElement("tbody");
    for (const column of columns) {
      const th = document.createElement("th");
      th.textContent = columnName(column);
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);
    for (const row of rows) {
      const tr = document.createElement("tr");
      const values = Array.isArray(row) ? row : columns.map((column) => row[columnName(column)]);
      for (const value of values) {
        const td = document.createElement("td");
        const text = value === null ? "NULL" : String(value);
        td.textContent = text;
        td.title = text;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    viewer.appendChild(table);
  }
  function columnName(column) {
    return typeof column === "string" ? column : column.name || String(column);
  }
  function renderVaultRuntime() {
    const section = createRuntimeSection("Write Secret");
    const row = document.createElement("div");
    const keyInput = document.createElement("input");
    const valInput = document.createElement("input");
    const status = document.createElement("div");
    row.className = "vault-row";
    keyInput.type = "text";
    keyInput.placeholder = "Key";
    keyInput.id = "vault-key";
    valInput.type = "password";
    valInput.placeholder = "Value";
    valInput.id = "vault-value";
    row.appendChild(keyInput);
    row.appendChild(valInput);
    row.appendChild(createButton("Save", "btn-sm primary", saveVaultSecret));
    section.appendChild(row);
    status.id = "vault-status";
    status.className = "save-status";
    section.appendChild(status);
    $card.appendChild(section);
  }
  async function saveVaultSecret() {
    const keyEl = document.getElementById("vault-key");
    const valEl = document.getElementById("vault-value");
    const statusEl = document.getElementById("vault-status");
    if (!keyEl || !valEl || !paneApi || !activeProjectId || !nodeData) return;
    const key = keyEl.value.trim();
    if (!key) return;
    try {
      await paneApi.putSecret(activeProjectId, nodeData.id, key, valEl.value);
      setSaveStatus(statusEl, "ok", "Saved");
      keyEl.value = "";
      valEl.value = "";
      setTimeout(() => {
        if (statusEl) statusEl.textContent = "";
      }, SAVED_STATUS_CLEAR_MS);
    } catch (err) {
      setSaveStatus(statusEl, "err", errorMessage(err));
    }
  }
  function renderChestRuntime() {
    const section = document.createElement("div");
    const headerRow = document.createElement("div");
    const label = document.createElement("div");
    const list = document.createElement("ul");
    section.className = "runtime-section";
    headerRow.style.cssText = "display:flex; align-items:center; justify-content:space-between;";
    label.className = "section-label";
    label.textContent = "Files";
    headerRow.appendChild(label);
    headerRow.appendChild(createButton("\u21BB", "btn-sm", loadChestFiles));
    section.appendChild(headerRow);
    list.className = "file-list";
    list.id = "chest-files";
    section.appendChild(list);
    $card.appendChild(section);
    loadChestFiles();
  }
  async function loadChestFiles() {
    if (!paneApi || !activeProjectId || !nodeData) return;
    const list = document.getElementById("chest-files");
    if (!list) return;
    list.textContent = "";
    try {
      const result = await paneApi.chestLs(activeProjectId, nodeData.id);
      const files = Array.isArray(result) ? result : result?.files || result?.keys || [];
      for (const file of files) {
        const li = document.createElement("li");
        li.textContent = typeof file === "string" ? file : file.key || file.name || JSON.stringify(file);
        list.appendChild(li);
      }
    } catch {
      return;
    }
  }
  function renderToolRuntime(node) {
    const section = createRuntimeSection("Operations");
    const ops = node.config.operations || [];
    if (ops.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color: #555; font-size: 11px;";
      empty.textContent = "No operations imported.";
      section.appendChild(empty);
      $card.appendChild(section);
      return;
    }
    const list = document.createElement("div");
    list.className = "op-list";
    for (const op of ops) {
      const item = document.createElement("div");
      const method = document.createElement("span");
      const name = document.createElement("span");
      item.className = "op-item";
      method.className = `op-method ${(op.method || "get").toLowerCase()}`;
      method.textContent = op.method || "GET";
      name.textContent = op.operation_id || op.name || op.path || "(unnamed)";
      item.appendChild(method);
      item.appendChild(name);
      list.appendChild(item);
    }
    section.appendChild(list);
    $card.appendChild(section);
  }
  function createRuntimeSection(labelText) {
    const section = document.createElement("div");
    const label = document.createElement("div");
    section.className = "runtime-section";
    label.className = "section-label";
    label.textContent = labelText;
    section.appendChild(label);
    return section;
  }
  function appendSeparator() {
    const hr = document.createElement("hr");
    hr.className = "separator";
    $card.appendChild(hr);
  }
  function createFieldGroup(labelText) {
    const group = document.createElement("div");
    const label = document.createElement("div");
    group.className = "field-group";
    label.className = "field-label";
    label.textContent = labelText;
    group.appendChild(label);
    return group;
  }
  function createFieldHint(text) {
    const hint = document.createElement("div");
    hint.className = "field-hint";
    hint.textContent = text;
    return hint;
  }
  function createButton(text, className, onClick) {
    const btn = document.createElement("button");
    btn.className = className;
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    return btn;
  }
  async function agentAction(action) {
    if (!paneApi || !activeProjectId || !nodeData) return;
    const api = paneApi;
    const projectId = activeProjectId;
    const nodeId = nodeData.id;
    try {
      if (action === "start") {
        await api.startAgent(projectId, nodeId);
        updateStatus("running");
      } else if (action === "restart") {
        await api.stopAgent(projectId, nodeId).catch(() => {
        });
        await api.startAgent(projectId, nodeId);
        updateStatus("running");
      } else {
        await api.stopAgent(projectId, nodeId).catch(() => {
        });
        updateStatus("stopped");
      }
    } catch (err) {
      setSaveStatus(document.getElementById("save-status"), "err", errorMessage(err));
    }
  }
  async function saveAgentConfig() {
    if (!paneApi || !activeProjectId || !nodeData) return;
    const statusEl = document.getElementById("save-status");
    const saveBtn = document.getElementById("save-btn");
    const config = {
      ...nodeData.config,
      harness: inputValue("field-harness") || void 0,
      model: inputValue("field-model") || void 0,
      system_prompt: inputValue("field-system-prompt") || void 0,
      run_on_startup: inputChecked("toggle-start-with-project"),
      ephemeral_context: inputChecked("toggle-clear-context")
    };
    if (saveBtn) saveBtn.disabled = true;
    setSaveStatus(statusEl, "", "Saving...");
    try {
      await paneApi.patchNode(activeProjectId, nodeData.id, { config });
      nodeData.config = config;
      setSaveStatus(statusEl, "ok", "Saved");
      setTimeout(() => {
        if (statusEl) statusEl.textContent = "";
      }, SAVED_STATUS_CLEAR_MS);
    } catch (err) {
      setSaveStatus(statusEl, "err", errorMessage(err));
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }
  function inputValue(id) {
    return document.getElementById(id)?.value || "";
  }
  function inputChecked(id) {
    return document.getElementById(id)?.checked || false;
  }
  function updateStatus(status) {
    const dot = document.getElementById("status-dot");
    const label = document.getElementById("status-label");
    if (!dot || !label) return;
    dot.className = "status-dot";
    if (status === "running") {
      dot.classList.add("running");
      label.textContent = "Running";
    } else if (status === "idle") {
      dot.classList.add("idle");
      label.textContent = "Idle";
    } else if (status === "error" || status === "rate_limited") {
      dot.classList.add("error");
      label.textContent = status;
    } else {
      dot.classList.add("stopped");
      label.textContent = "Stopped";
    }
  }
  function pollAgentStatus(projectId, nodeId) {
    if (statusPollTimer) clearInterval(statusPollTimer);
    const check = async () => {
      if (!paneApi) return;
      try {
        const log = await paneApi.agentLog(projectId, nodeId, { since: 0 });
        const entries = Array.isArray(log) ? log : log.entries || [];
        if (entries.length > 0) updateStatus("running");
      } catch {
        return;
      }
    };
    check();
    statusPollTimer = setInterval(check, AGENT_STATUS_POLL_MS);
  }
  function listenForCanvasEvents() {
    panel.rpc.on("canvas.workerStatusChange", (payload) => {
      const { status } = payload || {};
      if (status) updateStatus(status);
    });
    panel.events.on("canvas.wireDragStarted", ({ fromPaneId, fromNodeType }) => {
      if (fromPaneId !== myPaneId) highlightValidSockets(fromNodeType);
    });
    panel.events.on("canvas.wireDragEnded", (payload) => {
      clearSocketHighlights();
      handleWireDragEnded(payload);
    });
    panel.events.on("canvas.wireDragCancelled", () => {
      clearSocketHighlights();
    });
    panel.events.on("canvas.wireDragSpawnRequest", (payload) => {
      handleWireDragSpawnRequest(payload);
    });
  }
  function renderSockets(nodeType) {
    document.querySelector(".socket-container")?.remove();
    const container = document.createElement("div");
    container.className = "socket-container";
    placeSockets(container, wheelOutputTypes(nodeType), "output", (dot) => {
      dot.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        panel.canvas.startWireDrag({
          nodeId: nodeData?.id || "",
          nodeType,
          side: "output",
          compatibleTargets: compatibleTargetsForOutput(nodeType)
        });
      });
    });
    placeSockets(container, wheelInputTypes(nodeType), "input", (dot) => {
      dot.addEventListener("mouseup", (e) => {
        e.preventDefault();
        e.stopPropagation();
        panel.canvas.endWireDrag({ nodeId: nodeData?.id || "", nodeType });
      });
    });
    document.body.appendChild(container);
  }
  function placeSockets(container, wireTypes, side, bindDrag) {
    const spacing = wireTypes.length > 0 ? 100 / (wireTypes.length + 1) : 0;
    wireTypes.forEach((wireType, index) => {
      const dot = document.createElement("div");
      dot.className = `socket-dot ${wireType}`;
      dot.dataset.side = side;
      dot.dataset.wireType = wireType;
      dot.style[side === "output" ? "right" : "left"] = "-5px";
      dot.style.top = `${spacing * (index + 1)}%`;
      dot.title = `${wireType} (${side})`;
      bindDrag(dot);
      container.appendChild(dot);
    });
  }
  function compatibleTargetsForOutput(fromNodeType) {
    return [...wheelTargetTypes(fromNodeType)].map((targetType) => ({
      nodeType: targetType,
      label: NODE_TYPE_LABELS[targetType] || targetType,
      surfaceId: surfaceIdFor(targetType)
    }));
  }
  function highlightValidSockets(fromNodeType) {
    for (const socket of document.querySelectorAll('.socket-dot[data-side="input"]')) {
      const isValid = myNodeType !== null && wheelWireAllowed(fromNodeType, socket.dataset.wireType || "", myNodeType);
      socket.classList.toggle("valid-target", isValid);
      socket.classList.toggle("dimmed", !isValid);
    }
  }
  function clearSocketHighlights() {
    for (const socket of document.querySelectorAll(".socket-dot")) {
      socket.classList.remove("valid-target", "dimmed");
    }
  }
  async function handleWireDragEnded(payload) {
    const { fromPaneId, fromNodeId, toNodeId, fromNodeType, toNodeType } = payload;
    const isOriginator = myPaneId === fromPaneId;
    if (!isOriginator || !paneApi || !activeProjectId) return;
    const types = wheelWireTypes(fromNodeType, toNodeType);
    const [firstType] = types;
    if (!firstType) return;
    if (types.length === 1) {
      await createWireAndSync(fromNodeId, toNodeId, firstType);
      return;
    }
    showWireTypePicker(types, (selectedType) => createWireAndSync(fromNodeId, toNodeId, selectedType));
  }
  async function createWireAndSync(fromNodeId, toNodeId, wireType) {
    if (!paneApi || !activeProjectId) return;
    try {
      await paneApi.createWire(activeProjectId, fromNodeId, toNodeId, wireType);
      await syncWireConnections();
    } catch (err) {
      console.error("[wheel:node-pane] createWire failed:", err);
    }
  }
  async function syncWireConnections() {
    if (!paneApi || !activeProjectId) return;
    try {
      const board = await readBoardState(panel.secrets);
      if (!board) return;
      const apiBoard = await paneApi.getBoard(activeProjectId);
      await associatePanesByWires(panel.canvas, board.paneToNode, apiBoard.wires || []);
    } catch {
      return;
    }
  }
  function showWireTypePicker(types, onSelect) {
    removeWireTypePicker();
    const picker = document.createElement("div");
    const dismissPicker = (e) => {
      if (!picker.contains(e.target)) removeWireTypePicker();
    };
    picker.className = "wire-type-picker";
    picker.id = "wire-type-picker";
    picker.style.left = "50%";
    picker.style.top = "50%";
    picker.style.transform = "translate(-50%, -50%)";
    for (const wireType of types) {
      const btn = document.createElement("button");
      btn.className = wireType;
      btn.textContent = wireType.charAt(0).toUpperCase() + wireType.slice(1);
      btn.addEventListener("click", () => {
        removeWireTypePicker();
        onSelect(wireType);
      });
      picker.appendChild(btn);
    }
    document.body.appendChild(picker);
    setTimeout(() => {
      document.addEventListener("mousedown", dismissPicker, { once: true });
    }, WIRE_PICKER_DISMISS_DELAY_MS);
  }
  function removeWireTypePicker() {
    document.getElementById("wire-type-picker")?.remove();
  }
  async function handleWireDragSpawnRequest(payload) {
    const { fromPaneId, fromNodeId, fromNodeType, targetNodeType, targetSurfaceId, x, y } = payload;
    if (fromPaneId !== myPaneId || !paneApi || !activeProjectId || !isNodeType(targetNodeType)) return;
    try {
      const nodeName = `${targetNodeType}-${Date.now().toString(36).slice(-4)}`;
      const gridPos = {
        x: Math.round((x - SPAWN_GRID_OFFSET) / SPAWN_GRID_SCALE * 10) / 10,
        y: Math.round((y - SPAWN_GRID_OFFSET) / SPAWN_GRID_SCALE * 10) / 10
      };
      const newNode = await paneApi.createNode(activeProjectId, { name: nodeName, type: targetNodeType, position: gridPos });
      if (!newNode?.id) return;
      const { paneId } = await panel.canvas.spawn({
        kind: "note",
        title: newNode.name || nodeName,
        extensionId: WHEEL_EXTENSION_ID,
        surfaceId: targetSurfaceId,
        x,
        y
      });
      if (!paneId) return;
      const board = await readBoardState(panel.secrets).catch(() => null);
      if (!board) return;
      board.paneToNode[paneId] = {
        nodeId: newNode.id,
        nodeType: targetNodeType,
        nodeName: newNode.name || nodeName,
        nodeConfig: newNode.config || {},
        wires: []
      };
      board.nodesById[newNode.id] = newNode;
      await writeBoardState(panel.secrets, board);
      const firstWireType = wheelWireTypes(fromNodeType, targetNodeType)[0];
      if (firstWireType) {
        await createWireAndSync(fromNodeId, newNode.id, firstWireType);
      }
    } catch (err) {
      console.error("[wheel:node-pane] wireDragSpawnRequest failed:", err);
    }
  }
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
