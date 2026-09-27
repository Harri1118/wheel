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

  // src/dom.ts
  function byId(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing #${id} element`);
    return element;
  }

  // src/types.ts
  var WHEEL_EXTENSION_ID = "agentgrid.wheel";
  var DEFAULT_API_URL = "https://wheel-api-production-28d3.up.railway.app";
  function surfaceIdFor(nodeType) {
    return `wheel-${nodeType}`;
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

  // src/palette.ts
  var SVG_NS = "http://www.w3.org/2000/svg";
  var PALETTE_ITEMS = [
    { type: "agent", label: "Agent", svg: '<path d="M9 2a2 2 0 0 1 2 2v1h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-1v1a1 1 0 0 1-2 0v-1H8v1a1 1 0 0 1-2 0v-1H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2V4a2 2 0 0 1 2-2zm0 2a.5.5 0 0 0-.5.5V5h1V4.5A.5.5 0 0 0 9 4zM7.5 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm3 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM7 11h4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>' },
    { type: "ctx", label: "Context", svg: '<rect x="4" y="2" width="10" height="14" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M7 6h4M7 9h4M7 12h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' },
    { type: "table", label: "Table", svg: '<rect x="2" y="3" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M2 7h14M2 11h14M7 7v8M11 7v8" stroke="currentColor" stroke-width="1.2"/>' },
    { type: "endpoint", label: "Endpoint", svg: '<path d="M4 9h8m0 0l-3-3m3 3l-3 3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 5v8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' },
    { type: "script", label: "Script", svg: '<rect x="3" y="2" width="12" height="14" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M7 7l-2 2 2 2M11 7l2 2-2 2" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' },
    { type: "mcp", label: "MCP Server", svg: '<circle cx="9" cy="5" r="2.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M9 7.5V10m-3 2l3-2 3 2" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="13" r="1.2" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="12" cy="13" r="1.2" stroke="currentColor" stroke-width="1.2" fill="none"/>' },
    { type: "vault", label: "Vault", svg: '<rect x="3" y="6" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M6 6V5a3 3 0 0 1 6 0v1" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/><circle cx="9" cy="11" r="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/>' },
    { type: "chest", label: "Chest", svg: '<rect x="2" y="5" width="14" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M2 9h14" stroke="currentColor" stroke-width="1.2"/><rect x="7.5" y="7.5" width="3" height="3" rx="0.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M5 5l1-3h6l1 3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/>' },
    { type: "tool", label: "Tool", svg: '<path d="M5.5 12.5l5-5M14 5.5a3 3 0 0 0-3-3l1.5 1.5L11 5.5 9.5 4A3 3 0 0 0 13 8l-5 5a1.5 1.5 0 0 0 2.1 2.1l5-5A3 3 0 0 0 14 5.5z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' }
  ];
  var $empty = byId("palette-empty");
  var $active = byId("palette-active");
  var $list = byId("palette-list");
  var panel;
  var paletteApi = null;
  start();
  async function start() {
    try {
      panel = await createPanel();
      const [url, token] = await Promise.all([panel.secrets.get("apiUrl"), panel.secrets.get("apiToken")]);
      if (token) {
        paletteApi = new WheelApi(url || DEFAULT_API_URL, token);
      }
      buildPalette();
      await refreshVisibility();
      panel.rpc.on("secrets.changed", () => {
        refreshVisibility();
      });
    } catch {
      showEmptyPalette();
    }
  }
  function buildPalette() {
    $list.textContent = "";
    for (const item of PALETTE_ITEMS) {
      const btn = document.createElement("button");
      const labelSpan = document.createElement("span");
      btn.className = "palette-btn";
      labelSpan.textContent = item.label;
      btn.appendChild(createIcon(item.svg));
      btn.appendChild(labelSpan);
      btn.addEventListener("click", () => spawnNode(item.type, item.label));
      $list.appendChild(btn);
    }
  }
  async function spawnNode(type, defaultLabel) {
    const board = await readBoardState(panel.secrets).catch(() => null);
    if (!board?.projectId || !paletteApi) return;
    const name = prompt(`Name for new ${defaultLabel} node:`, `${type}-${Date.now() % 1e3}`);
    if (!name) return;
    try {
      const node = await paletteApi.createNode(board.projectId, { type, name, config: {} });
      if (!node?.id) return;
      const { paneId } = await panel.canvas.spawn({
        kind: "note",
        title: name,
        extensionId: WHEEL_EXTENSION_ID,
        surfaceId: surfaceIdFor(type)
      });
      if (!paneId) return;
      board.paneToNode[paneId] = {
        nodeId: node.id,
        nodeType: type,
        nodeName: name,
        nodeConfig: node.config || {},
        wires: []
      };
      board.nodesById[node.id] = node;
      await writeBoardState(panel.secrets, board);
    } catch (err) {
      console.error("Failed to create node:", err);
    }
  }
  async function refreshVisibility() {
    const board = await readBoardState(panel.secrets).catch(() => null);
    const hasProject = Boolean(board?.projectId);
    $empty.hidden = hasProject;
    $active.hidden = !hasProject;
  }
  function showEmptyPalette() {
    $empty.hidden = false;
    $active.hidden = true;
  }
  function createIcon(markup) {
    const svg = document.createElementNS(SVG_NS, "svg");
    const parsed = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${markup}</svg>`, "image/svg+xml");
    svg.setAttribute("viewBox", "0 0 18 18");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("aria-hidden", "true");
    svg.append(...Array.from(parsed.documentElement.childNodes, (node) => document.importNode(node, true)));
    return svg;
  }
})();
