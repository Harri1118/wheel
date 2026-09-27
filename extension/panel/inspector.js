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
  function allowedWireTypes(matrix, fromType, toType) {
    return matrix.rules.filter((rule) => rule.from === fromType && rule.to === toType).map((rule) => rule.type);
  }
  function allowedTargets(matrix, fromType) {
    return matrix.rules.filter((rule) => rule.from === fromType).map((rule) => ({ toType: rule.to, wireType: rule.type }));
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

  // src/spawn-plan.ts
  function indexNodes(nodes) {
    const nodesById = {};
    for (const n of nodes) nodesById[n.id] = n;
    return nodesById;
  }

  // src/types.ts
  var DEFAULT_API_URL = "https://wheel-api-production-28d3.up.railway.app";
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
  function wheelWireTypes(fromType, toType) {
    return allowedWireTypes(WHEEL_WIRES, fromType, toType);
  }
  function wheelTargetTypes(fromType) {
    return new Set(allowedTargets(WHEEL_WIRES, fromType).map((target) => target.toType));
  }

  // src/inspector.ts
  var HARNESS_OPTIONS = [
    { value: "claude", label: "Claude Code" },
    { value: "codex", label: "Codex" },
    { value: "opencode", label: "OpenCode" },
    { value: "cursor", label: "Cursor" },
    { value: "grok", label: "Grok" },
    { value: "devin", label: "Devin" },
    { value: "kimi", label: "Kimi" },
    { value: "antigravity", label: "Antigravity" }
  ];
  var HTTP_METHODS = ["GET", "POST", "PUT", "DELETE"];
  var RESPONSE_MODES = ["ack", "script"];
  var SCRIPT_LANGUAGES = ["ts", "js", "python"];
  var MCP_TRANSPORTS = ["stdio", "http"];
  var COLUMN_TYPES = ["text", "integer", "real", "blob", "json"];
  var NO_PROJECT_MESSAGE = "No Wheel project synced. Open a project from the Wheel Projects panel.";
  var LOG_POLL_MS = 5e3;
  var MAX_LOG_LINES = 100;
  var MAX_LOG_LINE_CHARS = 200;
  var SAVED_STATUS_CLEAR_MS = 2e3;
  var $empty = byId("inspector-empty");
  var $content = byId("inspector-content");
  var panel;
  var inspectorApi = null;
  var boardState = null;
  var logPollTimer = null;
  var logCursor = 0;
  var currentNodeId = null;
  start();
  async function start() {
    try {
      panel = await createPanel();
      const [apiUrl, apiToken] = await Promise.all([panel.secrets.get("apiUrl"), panel.secrets.get("apiToken")]);
      if (apiToken) {
        inspectorApi = new WheelApi(apiUrl || DEFAULT_API_URL, apiToken);
      }
      boardState = await readBoardState(panel.secrets);
    } catch {
      boardState = null;
    }
    if (!boardState) {
      showEmpty(NO_PROJECT_MESSAGE);
      return;
    }
    showEmpty("Project synced. Click a Wheel node on the canvas to inspect.");
    listenForCanvasEvents();
  }
  function listenForCanvasEvents() {
    panel.events.on("canvas.paneFocused", ({ paneId }) => {
      if (!paneId || !boardState) return;
      reloadBoardState().then(async () => {
        const entry = boardState?.paneToNode[paneId];
        if (!entry) return;
        await refreshEntryWires(entry);
        showNode(entry, paneId);
      });
    });
    panel.events.on("canvas.paneRemoved", ({ paneId }) => {
      if (!paneId) return;
      reloadBoardState().then(() => {
        const activeEntries = Object.values(boardState?.paneToNode || {});
        if (activeEntries.length === 0) {
          showEmpty(NO_PROJECT_MESSAGE);
          return;
        }
        if (currentNodeId && !activeEntries.some((e) => e.nodeId === currentNodeId)) {
          showEmpty("Node removed.");
        }
      });
    });
  }
  function showEmpty(message) {
    $empty.textContent = message || "No Wheel node selected.";
    $empty.hidden = false;
    $content.hidden = true;
    stopLogPolling();
  }
  function showNode(entry, paneId) {
    const header = document.createElement("div");
    const badge = document.createElement("span");
    const name = document.createElement("span");
    $empty.hidden = true;
    $content.hidden = false;
    $content.textContent = "";
    currentNodeId = entry.nodeId;
    header.className = "node-header";
    badge.className = `node-type-badge ${entry.nodeType}`;
    badge.textContent = entry.nodeType;
    name.className = "node-name";
    name.textContent = entry.nodeName;
    header.appendChild(badge);
    header.appendChild(name);
    $content.appendChild(header);
    renderEditableConfig(entry);
    renderWiresSection(entry, paneId);
    if (entry.nodeType === "agent") {
      renderAgentLog(entry);
    }
  }
  function renderEditableConfig(entry) {
    const cfg = entry.nodeConfig || {};
    const section = document.createElement("div");
    const saveRow = document.createElement("div");
    const status = document.createElement("span");
    const saveBtn = document.createElement("button");
    section.className = "section";
    section.id = "config-section";
    renderFieldsFor(entry.nodeType, section, cfg);
    saveRow.className = "save-row";
    status.className = "save-status";
    status.id = "inspector-save-status";
    saveBtn.className = "btn-sm primary";
    saveBtn.textContent = "Save";
    saveBtn.id = "inspector-save-btn";
    saveBtn.addEventListener("click", () => saveConfig(entry));
    saveRow.appendChild(status);
    saveRow.appendChild(saveBtn);
    section.appendChild(saveRow);
    $content.appendChild(section);
  }
  function renderFieldsFor(nodeType, section, cfg) {
    switch (nodeType) {
      case "agent":
        appendSelect(section, "harness", "Harness", HARNESS_OPTIONS, cfg.harness || "claude");
        appendInput(section, "model", "Model", cfg.model || "", "Leave empty for harness default");
        appendTextarea(section, "system_prompt", "System Prompt", cfg.system_prompt || "", "Instructions for this agent...");
        appendToggle(section, "run_on_startup", "Start with project", !!cfg.run_on_startup);
        appendToggle(section, "ephemeral_context", "Clear context after each turn", !!cfg.ephemeral_context);
        break;
      case "ctx":
        appendTextarea(section, "markdown", "Content (Markdown)", cfg.markdown || "", "Context content...");
        break;
      case "table":
        renderTableFields(section, cfg);
        break;
      case "endpoint":
        appendSelect(section, "method", "Method", optionsFrom(HTTP_METHODS), (cfg.method || "POST").toUpperCase());
        appendInput(section, "path", "Path", cfg.path || "/", "/path");
        appendSelect(section, "response_mode", "Response Mode", optionsFrom(RESPONSE_MODES), cfg.response_mode || "ack");
        break;
      case "script":
        appendSelect(section, "language", "Language", optionsFrom(SCRIPT_LANGUAGES), cfg.language || "ts");
        appendTextarea(section, "source", "Source", typeof cfg.source === "string" ? cfg.source : "", "Script source code...");
        break;
      case "mcp":
        renderMcpFields(section, cfg);
        break;
      case "vault":
        renderVaultFields(section, cfg);
        break;
      case "chest":
        break;
      case "tool":
        renderToolFields(section, cfg);
        break;
    }
  }
  function renderTableFields(section, cfg) {
    const columns = cfg.columns || [];
    const container = document.createElement("div");
    section.appendChild(createFieldLabel(`Columns (${columns.length})`));
    container.id = "table-columns";
    container.className = "columns-list";
    columns.forEach((column, index) => appendColumnRow(container, column, index));
    section.appendChild(container);
    section.appendChild(createSmallButton("+ Column", "btn-sm", () => {
      appendColumnRow(container, { name: "", type: "text" }, container.children.length);
    }));
  }
  function appendColumnRow(container, column, index) {
    const row = document.createElement("div");
    const nameInput = document.createElement("input");
    const typeSelect = document.createElement("select");
    row.className = "column-row";
    nameInput.className = "field-input";
    nameInput.value = column.name || "";
    nameInput.placeholder = "column name";
    nameInput.dataset.colIndex = String(index);
    nameInput.dataset.colField = "name";
    row.appendChild(nameInput);
    typeSelect.className = "field-select";
    typeSelect.dataset.colIndex = String(index);
    typeSelect.dataset.colField = "type";
    for (const columnType of COLUMN_TYPES) {
      typeSelect.appendChild(createOption({ value: columnType, label: columnType }, column.type || "text"));
    }
    row.appendChild(typeSelect);
    row.appendChild(createSmallButton("\xD7", "btn-sm danger", () => row.remove()));
    container.appendChild(row);
  }
  function renderMcpFields(section, cfg) {
    const transport = cfg.transport || "stdio";
    appendSelect(section, "transport", "Transport", optionsFrom(MCP_TRANSPORTS), transport);
    if (transport === "stdio") {
      appendInput(section, "command", "Command", cfg.command || "", "e.g. npx -y @modelcontextprotocol/server");
    } else {
      appendInput(section, "url", "URL", cfg.url || "", "https://...");
    }
  }
  function renderVaultFields(section, cfg) {
    const keys = cfg.keys || [];
    const container = document.createElement("div");
    section.appendChild(createFieldLabel(`Secret Keys (${keys.length})`));
    container.id = "vault-keys";
    for (const key of keys) appendVaultKeyRow(container, key);
    section.appendChild(container);
    section.appendChild(createSmallButton("+ Key", "btn-sm", () => appendVaultKeyRow(container, "")));
  }
  function appendVaultKeyRow(container, key) {
    const row = document.createElement("div");
    const input = document.createElement("input");
    row.className = "column-row";
    input.className = "field-input vault-key-input";
    input.value = key;
    input.placeholder = "KEY_NAME";
    row.appendChild(input);
    row.appendChild(createSmallButton("\xD7", "btn-sm danger", () => row.remove()));
    container.appendChild(row);
  }
  function renderToolFields(section, cfg) {
    section.appendChild(createFieldLabel("Tool nodes are configured via import. Use the Wheel API tool handler."));
    if (cfg.base_url) {
      appendInput(section, "base_url", "Base URL", cfg.base_url, "");
    }
  }
  function appendInput(parent, id, label, value, placeholder) {
    const group = createFieldGroup(label);
    const input = document.createElement("input");
    input.className = "field-input";
    input.id = `field-${id}`;
    input.type = "text";
    input.value = value;
    if (placeholder) input.placeholder = placeholder;
    group.appendChild(input);
    parent.appendChild(group);
  }
  function appendTextarea(parent, id, label, value, placeholder) {
    const group = createFieldGroup(label);
    const textarea = document.createElement("textarea");
    textarea.className = "field-textarea";
    textarea.id = `field-${id}`;
    textarea.value = value;
    textarea.rows = 4;
    if (placeholder) textarea.placeholder = placeholder;
    group.appendChild(textarea);
    parent.appendChild(group);
  }
  function appendSelect(parent, id, label, options, selected) {
    const group = createFieldGroup(label);
    const select = document.createElement("select");
    select.className = "field-select";
    select.id = `field-${id}`;
    for (const option of options) select.appendChild(createOption(option, selected));
    group.appendChild(select);
    parent.appendChild(group);
  }
  function appendToggle(parent, id, label, checked) {
    const row = document.createElement("div");
    const toggle = document.createElement("label");
    const input = document.createElement("input");
    const slider = document.createElement("span");
    const text = document.createElement("span");
    row.className = "toggle-row";
    toggle.className = "toggle-switch";
    input.type = "checkbox";
    input.id = `field-${id}`;
    input.checked = checked;
    slider.className = "toggle-slider";
    text.className = "toggle-label";
    text.textContent = label;
    toggle.appendChild(input);
    toggle.appendChild(slider);
    row.appendChild(toggle);
    row.appendChild(text);
    parent.appendChild(row);
  }
  function createFieldGroup(label) {
    const group = document.createElement("div");
    group.className = "field-group";
    group.appendChild(createFieldLabel(label));
    return group;
  }
  function createFieldLabel(text) {
    const label = document.createElement("div");
    label.className = "field-label";
    label.textContent = text;
    return label;
  }
  function createOption(option, selected) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    if (option.value === selected) element.selected = true;
    return element;
  }
  function createSmallButton(text, className, onClick) {
    const button = document.createElement("button");
    button.className = className;
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }
  function optionsFrom(values) {
    return values.map((value) => ({ value, label: value }));
  }
  async function saveConfig(entry) {
    if (!inspectorApi || !boardState?.projectId) return;
    const statusEl = document.getElementById("inspector-save-status");
    const saveBtn = document.getElementById("inspector-save-btn");
    if (saveBtn) saveBtn.disabled = true;
    setSaveStatus(statusEl, "", "Saving...");
    try {
      const config = collectConfig(entry.nodeType);
      await inspectorApi.patchNode(boardState.projectId, entry.nodeId, { config });
      entry.nodeConfig = config;
      updateBoardStateEntry(entry);
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
  function collectConfig(nodeType) {
    switch (nodeType) {
      case "agent":
        return {
          harness: fieldValue("harness") || "claude",
          system_prompt: fieldValue("system_prompt"),
          model: fieldValue("model") || void 0,
          run_on_startup: fieldChecked("run_on_startup"),
          ephemeral_context: fieldChecked("ephemeral_context")
        };
      case "ctx":
        return { markdown: fieldValue("markdown") };
      case "table":
        return { columns: collectTableColumns() };
      case "endpoint":
        return {
          method: fieldValue("method") || "POST",
          path: fieldValue("path") || "/",
          response_mode: fieldValue("response_mode") || "ack"
        };
      case "script":
        return {
          language: fieldValue("language") || "ts",
          source: fieldValue("source") || "// empty"
        };
      case "mcp":
        return fieldValue("transport") === "http" ? { transport: "http", url: fieldValue("url") || "https://example.com" } : { transport: "stdio", command: fieldValue("command") || "echo" };
      case "vault":
        return { keys: collectVaultKeys() };
      case "chest":
        return {};
      case "tool":
        return void 0;
    }
  }
  function fieldValue(id) {
    return document.getElementById(`field-${id}`)?.value || "";
  }
  function fieldChecked(id) {
    return document.getElementById(`field-${id}`)?.checked || false;
  }
  function collectTableColumns() {
    const container = document.getElementById("table-columns");
    const columns = [];
    if (!container) return columns;
    for (const row of Array.from(container.children)) {
      const nameInput = row.querySelector("input");
      const typeSelect = row.querySelector("select");
      if (nameInput?.value) {
        columns.push({ name: nameInput.value, type: typeSelect?.value || "text" });
      }
    }
    return columns;
  }
  function collectVaultKeys() {
    const container = document.getElementById("vault-keys");
    const keys = [];
    if (!container) return keys;
    for (const row of Array.from(container.children)) {
      const input = row.querySelector(".vault-key-input");
      if (input?.value) keys.push(input.value);
    }
    return keys;
  }
  async function updateBoardStateEntry(entry) {
    try {
      await reloadBoardState();
      if (!boardState) return;
      for (const candidate of Object.values(boardState.paneToNode)) {
        if (candidate.nodeId === entry.nodeId) {
          candidate.nodeConfig = entry.nodeConfig;
        }
      }
      await writeBoardState(panel.secrets, boardState);
    } catch {
      return;
    }
  }
  function renderWiresSection(entry, paneId) {
    const section = document.createElement("div");
    const title = createFieldLabel("Wires");
    const wireList = document.createElement("div");
    section.className = "section";
    section.id = "wires-section";
    title.style.marginBottom = "4px";
    section.appendChild(title);
    wireList.id = "wire-list";
    const wires = entry.wires || [];
    if (wires.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wire-empty";
      empty.textContent = "No wires.";
      wireList.appendChild(empty);
    }
    for (const wire of wires) {
      wireList.appendChild(createWireRow(entry, wire));
    }
    section.appendChild(wireList);
    const validTargets = wheelTargetTypes(entry.nodeType);
    const peers = Object.values(boardState?.paneToNode || {}).filter((e) => e.nodeId !== entry.nodeId && validTargets.has(e.nodeType));
    if (peers.length === 0) {
      if (validTargets.size === 0) {
        const hint = document.createElement("div");
        hint.className = "wire-empty";
        hint.textContent = `${entry.nodeType} nodes have no outgoing wires.`;
        section.appendChild(hint);
      }
      $content.appendChild(section);
      return;
    }
    section.appendChild(createAddWireRow(entry, paneId, peers));
    $content.appendChild(section);
  }
  function createWireRow(entry, wire) {
    const row = document.createElement("div");
    const dir = document.createElement("span");
    const wireType = document.createElement("span");
    const peer = document.createElement("span");
    const removeBtn = createSmallButton("\xD7", "btn-sm danger wire-remove", () => removeWire(entry, wire, row));
    const isOutgoing = wire.direction === "outgoing";
    row.className = "wire-item";
    dir.className = "wire-dir";
    dir.textContent = isOutgoing ? "\u2192 " : "\u2190 ";
    wireType.className = `wire-type wire-type-${wire.type}`;
    wireType.textContent = wire.type;
    peer.className = "wire-peer";
    peer.textContent = ` ${isOutgoing ? "to" : "from"} ${wire.peerName}`;
    row.appendChild(dir);
    row.appendChild(wireType);
    row.appendChild(peer);
    row.appendChild(removeBtn);
    return row;
  }
  function createAddWireRow(entry, paneId, peers) {
    const addRow = document.createElement("div");
    const peerSelect = document.createElement("select");
    const typeSelect = document.createElement("select");
    const refreshTypeOptions = () => fillWireTypeOptions(typeSelect, entry.nodeType, peerSelect.selectedOptions[0]?.dataset.nodeType);
    addRow.className = "wire-add-row";
    peerSelect.className = "field-select wire-peer-select";
    peerSelect.id = "wire-peer-select";
    peerSelect.appendChild(createOption({ value: "", label: "Target node..." }, ""));
    for (const peer of peers) {
      const option = createOption({ value: peer.nodeId, label: `${peer.nodeName} (${peer.nodeType})` }, "");
      option.dataset.nodeType = peer.nodeType;
      peerSelect.appendChild(option);
    }
    typeSelect.className = "field-select wire-type-select";
    typeSelect.id = "wire-type-select";
    peerSelect.addEventListener("change", refreshTypeOptions);
    refreshTypeOptions();
    addRow.appendChild(peerSelect);
    addRow.appendChild(typeSelect);
    addRow.appendChild(createSmallButton("+ Wire", "btn-sm primary", () => addWire(entry, paneId)));
    return addRow;
  }
  function fillWireTypeOptions(typeSelect, fromType, targetType) {
    typeSelect.textContent = "";
    if (!targetType) {
      typeSelect.appendChild(createOption({ value: "", label: "type..." }, ""));
      return;
    }
    for (const wireType of wheelWireTypes(fromType, targetType)) {
      typeSelect.appendChild(createOption({ value: wireType, label: wireType }, ""));
    }
  }
  async function addWire(entry, paneId) {
    if (!inspectorApi || !boardState?.projectId) return;
    const peerNodeId = document.getElementById("wire-peer-select")?.value;
    const wireType = document.getElementById("wire-type-select")?.value;
    if (!peerNodeId || !wireType) return;
    try {
      await inspectorApi.createWire(boardState.projectId, entry.nodeId, peerNodeId, wireType);
      await reloadBoardState();
      await syncAllWireConnections();
      const stillOnBoard = Object.values(boardState?.paneToNode || {}).some((e) => e.nodeId === entry.nodeId);
      if (stillOnBoard) {
        await refreshEntryWires(entry);
        showNode({ ...entry, wires: entry.wires }, paneId);
      }
    } catch (err) {
      setSaveStatus(document.getElementById("inspector-save-status"), "err", errorMessage(err));
    }
  }
  async function removeWire(entry, wire, row) {
    if (!inspectorApi || !boardState?.projectId) return;
    const peerNodeId = findNodeIdByName(wire.peerName);
    if (!peerNodeId) return;
    const isOutgoing = wire.direction === "outgoing";
    const fromId = isOutgoing ? entry.nodeId : peerNodeId;
    const toId = isOutgoing ? peerNodeId : entry.nodeId;
    try {
      await inspectorApi.deleteWire(boardState.projectId, fromId, toId, wire.type);
      row.remove();
      await reloadBoardState();
      await syncAllWireConnections();
    } catch (err) {
      setSaveStatus(document.getElementById("inspector-save-status"), "err", errorMessage(err));
    }
  }
  function findNodeIdByName(name) {
    return Object.values(boardState?.paneToNode || {}).find((e) => e.nodeName === name)?.nodeId ?? null;
  }
  async function refreshEntryWires(entry) {
    if (!inspectorApi || !boardState?.projectId) return;
    try {
      const apiBoard = await inspectorApi.getBoard(boardState.projectId);
      entry.wires = summarizeWires(entry.nodeId, apiBoard.wires || [], indexNodes(apiBoard.nodes || []));
    } catch {
      return;
    }
  }
  async function syncAllWireConnections() {
    if (!inspectorApi || !boardState?.projectId) return;
    try {
      const apiBoard = await inspectorApi.getBoard(boardState.projectId);
      await associatePanesByWires(panel.canvas, boardState.paneToNode, apiBoard.wires || []);
    } catch {
      return;
    }
  }
  function renderAgentLog(entry) {
    const section = document.createElement("div");
    const logContainer = document.createElement("div");
    section.className = "section";
    section.appendChild(createFieldLabel("Agent Log"));
    logContainer.id = "agent-log";
    logContainer.className = "agent-log";
    section.appendChild(logContainer);
    $content.appendChild(section);
    startLogPolling(entry.nodeId);
  }
  function startLogPolling(nodeId) {
    stopLogPolling();
    if (!inspectorApi || !boardState?.projectId) return;
    logCursor = 0;
    fetchAgentLog(nodeId);
    logPollTimer = setInterval(() => fetchAgentLog(nodeId), LOG_POLL_MS);
  }
  function stopLogPolling() {
    if (!logPollTimer) return;
    clearInterval(logPollTimer);
    logPollTimer = null;
  }
  async function fetchAgentLog(nodeId) {
    if (!inspectorApi || !boardState?.projectId) return;
    try {
      const log = await inspectorApi.agentLog(boardState.projectId, nodeId, { since: logCursor });
      const entries = Array.isArray(log) ? log : log.entries || [];
      const newest = entries[entries.length - 1];
      if (!newest) return;
      logCursor = newest.seq || newest.id || logCursor;
      const logContainer = document.getElementById("agent-log");
      if (!logContainer) return;
      for (const logEntry of entries) {
        const line = document.createElement("div");
        const text = logEntry.text || logEntry.line || logEntry.body || JSON.stringify(logEntry);
        line.className = "log-line";
        if ((logEntry.stream || "stdout") === "stderr") line.classList.add("log-stderr");
        line.textContent = text.length > MAX_LOG_LINE_CHARS ? text.slice(0, MAX_LOG_LINE_CHARS) + "..." : text;
        logContainer.appendChild(line);
      }
      while (logContainer.children.length > MAX_LOG_LINES && logContainer.firstChild) {
        logContainer.removeChild(logContainer.firstChild);
      }
      logContainer.scrollTop = logContainer.scrollHeight;
    } catch {
      return;
    }
  }
  async function reloadBoardState() {
    try {
      const latest = await readBoardState(panel.secrets);
      if (latest) boardState = latest;
    } catch {
      return;
    }
  }
})();
