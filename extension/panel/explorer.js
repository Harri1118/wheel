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
  var NetworkError = class extends Error {
    constructor(message, status, body) {
      super(message);
      this.status = status;
      this.body = body;
      this.name = "NetworkError";
    }
    status;
    body;
  };
  var LINE_BREAK = /\r\n|\r|\n/;
  var RETRY_FIELD_VALUE = /^\d+$/;
  var SSEStream = class {
    reader;
    decoder;
    buffer;
    constructor(response) {
      if (!response.body) {
        throw new NetworkError("Response has no body for SSE streaming");
      }
      this.reader = response.body.getReader();
      this.decoder = new TextDecoder();
      this.buffer = "";
    }
    async *[Symbol.asyncIterator]() {
      let pending = emptyPendingEvent();
      try {
        for await (const line of this.readLines()) {
          if (line !== "") {
            applyField(pending, line);
            continue;
          }
          const event = toSSEEvent(pending);
          pending = emptyPendingEvent();
          if (event) {
            yield event;
          }
        }
      } finally {
        this.reader.cancel().catch(ignoreErrorAlreadyThrownToReader);
      }
    }
    close() {
      this.reader.cancel().catch((err) => {
        console.warn("[sdk/sse] cancel of an already-settled stream failed:", err);
      });
    }
    async *readLines() {
      while (true) {
        const { done, value } = await this.reader.read();
        if (done) {
          break;
        }
        this.buffer += this.decoder.decode(value, { stream: true });
        yield* this.drainCompleteLines(false);
      }
      this.buffer += this.decoder.decode();
      yield* this.drainCompleteLines(true);
    }
    *drainCompleteLines(streamEnded) {
      const mayBeSplitCrlf = !streamEnded && this.buffer.endsWith("\r");
      const scannable = mayBeSplitCrlf ? this.buffer.slice(0, -1) : this.buffer;
      const lines = scannable.split(LINE_BREAK);
      const incompleteLine = lines.pop() ?? "";
      this.buffer = mayBeSplitCrlf ? `${incompleteLine}\r` : incompleteLine;
      yield* lines;
    }
  };
  function emptyPendingEvent() {
    return { dataLines: [] };
  }
  function applyField(pending, line) {
    const isComment = line.startsWith(":");
    if (isComment) {
      return;
    }
    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    const rawValue = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    switch (field) {
      case "event":
        pending.event = value;
        break;
      case "data":
        pending.dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) {
          pending.id = value;
        }
        break;
      case "retry":
        if (RETRY_FIELD_VALUE.test(value)) {
          pending.retry = Number(value);
        }
        break;
    }
  }
  function toSSEEvent(pending) {
    if (pending.dataLines.length === 0) {
      return null;
    }
    const data = parseJsonOrText(pending.dataLines.join("\n"));
    return { event: pending.event, data, id: pending.id, retry: pending.retry };
  }
  function parseJsonOrText(text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  function ignoreErrorAlreadyThrownToReader() {
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

  // src/spawn-plan.ts
  function indexNodes(nodes) {
    const nodesById = {};
    for (const n of nodes) nodesById[n.id] = n;
    return nodesById;
  }

  // src/types.ts
  var WHEEL_EXTENSION_ID = "agentgrid.wheel";
  var DEFAULT_API_URL = "https://wheel-api-production-28d3.up.railway.app";
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

  // src/explorer.ts
  var BOARD_POLL_MS = 5e3;
  var BUILDER_CLOSE_DELAY_MS = 1500;
  var BUILDER_PREVIEW_CHARS = 200;
  var $notConfigured = byId("not-configured");
  var $configured = byId("configured");
  var $connDot = byId("conn-dot");
  var $connLabel = byId("conn-label");
  var $peerBadge = byId("peer-badge");
  var $projectList = byId("project-list");
  var $projectError = byId("project-error");
  var $syncArea = byId("sync-area");
  var $syncDot = byId("sync-dot");
  var $syncLabel = byId("sync-label");
  var $syncDetail = byId("sync-detail");
  var $nodeList = byId("node-list");
  var $builderInline = byId("builder-inline");
  var $builderPrompt = byId("builder-prompt");
  var $builderStatus = byId("builder-status");
  var $builderGo = byId("builder-go");
  var $builderCancel = byId("builder-cancel");
  var $btnBuilder = byId("btn-builder");
  var panel;
  var explorerApi = null;
  var boardSyncTimer = null;
  var suppressPaneRemoved = false;
  var listeningForCanvasEvents = false;
  start();
  async function start() {
    try {
      panel = await createPanel();
    } catch (err) {
      console.error("[wheel:explorer] createPanel error:", err);
      showNotConfigured();
      return;
    }
    byId("btn-refresh").addEventListener("click", initExplorer);
    byId("btn-retry").addEventListener("click", initExplorer);
    byId("btn-sync").addEventListener("click", syncFromWheel);
    byId("btn-stop").addEventListener("click", stopProject);
    $btnBuilder.addEventListener("click", openBuilder);
    $builderCancel.addEventListener("click", closeBuilder);
    $builderGo.addEventListener("click", runBuilder);
    await initExplorer();
  }
  async function initExplorer() {
    console.log("[wheel:explorer] initExplorer starting");
    try {
      const [url, token] = await Promise.all([panel.secrets.get("apiUrl"), panel.secrets.get("apiToken")]);
      console.log("[wheel:explorer] secrets loaded, url:", url || "(default)", "token:", token ? "***" + token.slice(-4) : "(none)");
      if (!token) {
        console.log("[wheel:explorer] no token, showing not-configured");
        showNotConfigured();
        return;
      }
      explorerApi = new WheelApi(url || DEFAULT_API_URL, token);
      $notConfigured.hidden = true;
      $configured.hidden = false;
      await refreshProjects();
      await refreshSyncStatus();
      listenForCanvasEvents();
      startBoardPolling();
      console.log("[wheel:explorer] initExplorer complete");
    } catch (err) {
      console.error("[wheel:explorer] initExplorer error:", err);
      showNotConfigured();
    }
  }
  function showNotConfigured() {
    $notConfigured.hidden = false;
    $configured.hidden = true;
  }
  async function refreshProjects() {
    if (!explorerApi) return;
    $projectError.hidden = true;
    $projectList.textContent = "";
    try {
      const projects = await explorerApi.listProjects();
      $connDot.className = "dot ok";
      $connLabel.textContent = "Connected";
      if (projects.length === 0) {
        const li = document.createElement("li");
        li.className = "empty-state";
        li.textContent = "No projects found.";
        $projectList.appendChild(li);
        return;
      }
      for (const project of projects) {
        const li = document.createElement("li");
        const nameSpan = document.createElement("span");
        const openBtn = document.createElement("button");
        li.className = "project-item";
        nameSpan.className = "project-name";
        nameSpan.textContent = project.name || project.id;
        if (project.status) {
          const statusSpan = document.createElement("span");
          statusSpan.className = `project-status ${project.status}`;
          statusSpan.textContent = project.status;
          nameSpan.appendChild(statusSpan);
        }
        openBtn.className = "btn-small";
        openBtn.textContent = "Open";
        openBtn.addEventListener("click", () => openProject(project.id));
        li.appendChild(nameSpan);
        li.appendChild(openBtn);
        $projectList.appendChild(li);
      }
    } catch (err) {
      $connDot.className = "dot err";
      $connLabel.textContent = "Error";
      $projectError.textContent = errorMessage(err);
      $projectError.hidden = false;
    }
  }
  async function openProject(projectId) {
    if (!explorerApi) return;
    console.log("[wheel:explorer] openProject called, projectId:", projectId);
    $syncArea.hidden = false;
    $syncDot.className = "dot";
    $syncLabel.textContent = "Opening...";
    $syncDetail.textContent = "";
    try {
      console.log("[wheel:explorer] killing all wheel panes...");
      await killAllWheelPanes();
      const apiBoard = await explorerApi.getBoard(projectId);
      const nodes = apiBoard.nodes || [];
      const wires = apiBoard.wires || [];
      console.log("[wheel:explorer] board fetched:", nodes.length, "nodes,", wires.length, "wires");
      $syncDetail.textContent = `API returned ${nodes.length} nodes`;
      const board = { projectId, paneToNode: {}, nodesById: indexNodes(nodes), spawning: true };
      await writeBoardState(panel.secrets, board);
      await spawnNodePanes(board, nodes, wires);
      console.log("[wheel:explorer] boardState written, paneToNode keys:", Object.keys(board.paneToNode).length);
      suppressPaneRemoved = false;
      await syncWireConnections(projectId);
      await refreshSyncStatus();
      console.log("[wheel:explorer] openProject complete");
    } catch (err) {
      suppressPaneRemoved = false;
      console.error("[wheel:explorer] openProject error:", err);
      $syncDot.className = "dot err";
      $syncLabel.textContent = "Error";
      $syncDetail.textContent = errorMessage(err);
    }
  }
  async function syncFromWheel() {
    console.log("[wheel:explorer] syncFromWheel called");
    if (!explorerApi) return;
    $syncDot.className = "dot";
    $syncLabel.textContent = "Syncing...";
    suppressPaneRemoved = true;
    try {
      const board = await readBoardState(panel.secrets).catch(() => null);
      if (!board?.projectId) return;
      const apiBoard = await explorerApi.getBoard(board.projectId);
      const remoteNodes = apiBoard.nodes || [];
      const remoteWires = apiBoard.wires || [];
      console.log("[wheel:explorer] sync: killing all existing panes and rebuilding from remote");
      for (const paneId of Object.keys(board.paneToNode)) {
        await panel.canvas.kill(paneId).catch(() => {
        });
      }
      board.paneToNode = {};
      delete board.closedNodes;
      board.spawning = true;
      board.nodesById = indexNodes(remoteNodes);
      await writeBoardState(panel.secrets, board);
      await spawnNodePanes(board, remoteNodes, remoteWires);
      console.log("[wheel:explorer] sync complete, paneToNode keys:", Object.keys(board.paneToNode).length);
      suppressPaneRemoved = false;
      await syncWireConnections(board.projectId);
      await refreshSyncStatus();
    } catch (err) {
      suppressPaneRemoved = false;
      console.error("[wheel:explorer] syncFromWheel error:", err);
      $syncDot.className = "dot err";
      $syncLabel.textContent = "Sync failed";
      $syncDetail.textContent = errorMessage(err);
    }
  }
  async function spawnNodePanes(board, nodes, wires) {
    for (const node of nodes) {
      const { paneId } = await panel.canvas.spawn({
        kind: "note",
        title: node.name,
        extensionId: WHEEL_EXTENSION_ID,
        surfaceId: surfaceIdFor(node.type)
      });
      if (!paneId) continue;
      board.paneToNode[paneId] = {
        nodeId: node.id,
        nodeType: node.type,
        nodeName: node.name,
        nodeConfig: node.config,
        wires: summarizeWires(node.id, wires, board.nodesById)
      };
      await writeBoardState(panel.secrets, board);
    }
    board.spawning = false;
    await writeBoardState(panel.secrets, board);
  }
  async function killAllWheelPanes() {
    suppressPaneRemoved = true;
    await panel.rpc.request("canvas.killAllPanes", {}).catch(() => {
    });
  }
  async function syncWireConnections(projectId) {
    if (!explorerApi || !projectId) return;
    try {
      const board = await readBoardState(panel.secrets).catch(() => null);
      if (!board) return;
      const apiBoard = await explorerApi.getBoard(projectId);
      await associatePanesByWires(panel.canvas, board.paneToNode, apiBoard.wires || []);
    } catch {
      return;
    }
  }
  function listenForCanvasEvents() {
    if (listeningForCanvasEvents) return;
    listeningForCanvasEvents = true;
    panel.rpc.on("canvas.workerStatusChange", () => {
      refreshSyncStatus();
    });
    panel.events.on("canvas.paneRemoved", ({ paneId }) => {
      if (paneId) handlePaneRemoved(paneId);
    });
  }
  async function handlePaneRemoved(paneId) {
    if (suppressPaneRemoved) return;
    try {
      const board = await readBoardState(panel.secrets).catch(() => null);
      if (!board?.projectId) return;
      const entry = board.paneToNode[paneId];
      if (!entry) return;
      entry.closedPaneId = paneId;
      board.closedNodes = board.closedNodes || {};
      board.closedNodes[entry.nodeId] = entry;
      delete board.paneToNode[paneId];
      await writeBoardState(panel.secrets, board);
      refreshSyncStatus();
      await syncWireConnections(board.projectId);
    } catch {
      return;
    }
  }
  function renderNodeList(board) {
    $nodeList.textContent = "";
    for (const [paneId, entry] of Object.entries(board.paneToNode)) {
      const li = createNodeItem(entry, entry.nodeId);
      li.appendChild(createDeleteButton(() => deleteNodeFromExplorer(paneId, entry, board.projectId)));
      $nodeList.appendChild(li);
    }
    for (const [nodeId, entry] of Object.entries(board.closedNodes || {})) {
      const li = createNodeItem(entry, nodeId);
      li.classList.add("node-item-closed");
      li.title = "Click to reopen on canvas";
      li.style.opacity = "0.5";
      li.style.cursor = "pointer";
      li.addEventListener("click", () => respawnClosedNode(nodeId, entry, board.projectId));
      li.appendChild(createDeleteButton((e) => {
        e.stopPropagation();
        deleteClosedNode(nodeId, board.projectId);
      }));
      $nodeList.appendChild(li);
    }
  }
  function createNodeItem(entry, fallbackName) {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    const name = document.createElement("span");
    li.className = "node-item";
    tag.className = "node-type-tag";
    tag.textContent = entry.nodeType || "?";
    name.className = "node-item-name";
    name.textContent = entry.nodeName || fallbackName;
    li.appendChild(tag);
    li.appendChild(name);
    return li;
  }
  function createDeleteButton(onClick) {
    const del = document.createElement("button");
    del.className = "node-delete-btn";
    del.textContent = "\xD7";
    del.title = "Delete node";
    del.addEventListener("click", onClick);
    return del;
  }
  async function respawnClosedNode(nodeId, entry, projectId) {
    suppressPaneRemoved = true;
    try {
      const board = await readBoardState(panel.secrets).catch(() => null);
      if (!board) return;
      const restored = { ...entry };
      delete restored.closedPaneId;
      if (board.closedNodes) {
        delete board.closedNodes[nodeId];
        if (Object.keys(board.closedNodes).length === 0) delete board.closedNodes;
      }
      board.spawning = true;
      await writeBoardState(panel.secrets, board);
      const { paneId } = await panel.canvas.spawn({
        kind: "note",
        title: entry.nodeName || nodeId,
        extensionId: WHEEL_EXTENSION_ID,
        surfaceId: surfaceIdFor(entry.nodeType)
      });
      if (paneId) {
        board.paneToNode[paneId] = restored;
      }
      board.spawning = false;
      await writeBoardState(panel.secrets, board);
      suppressPaneRemoved = false;
      if (projectId) await syncWireConnections(projectId);
      refreshSyncStatus();
    } catch {
      suppressPaneRemoved = false;
    }
  }
  async function deleteClosedNode(nodeId, projectId) {
    try {
      if (explorerApi && projectId) {
        await explorerApi.deleteNode(projectId, nodeId).catch(() => {
        });
      }
      const board = await readBoardState(panel.secrets).catch(() => null);
      if (board) {
        if (board.closedNodes) delete board.closedNodes[nodeId];
        delete board.nodesById[nodeId];
        await writeBoardState(panel.secrets, board);
      }
      refreshSyncStatus();
    } catch {
      return;
    }
  }
  async function deleteNodeFromExplorer(paneId, entry, projectId) {
    try {
      if (explorerApi && projectId && entry.nodeId) {
        await explorerApi.deleteNode(projectId, entry.nodeId).catch(() => {
        });
      }
      await panel.canvas.kill(paneId).catch(() => {
      });
      const board = await readBoardState(panel.secrets).catch(() => null);
      if (board) {
        delete board.paneToNode[paneId];
        await writeBoardState(panel.secrets, board);
      }
      refreshSyncStatus();
    } catch {
      return;
    }
  }
  async function refreshSyncStatus() {
    console.log("[wheel:explorer] refreshSyncStatus called");
    try {
      const board = await readBoardState(panel.secrets).catch(() => null);
      if (!board) {
        console.log("[wheel:explorer] refreshSyncStatus: no boardState, hiding sync area");
        $syncArea.hidden = true;
        return;
      }
      const activeCount = Object.keys(board.paneToNode).length;
      const closedCount = Object.keys(board.closedNodes || {}).length;
      console.log("[wheel:explorer] refreshSyncStatus: projectId:", board.projectId, "paneToNode keys:", activeCount, "closedNodes:", closedCount);
      if (!board.projectId) {
        console.log("[wheel:explorer] refreshSyncStatus: no projectId, hiding sync area");
        $syncArea.hidden = true;
        return;
      }
      const totalCount = activeCount + closedCount;
      const parts = [`${activeCount} on canvas`];
      if (closedCount > 0) parts.push(`${closedCount} closed`);
      $syncArea.hidden = false;
      $syncDot.className = "dot ok";
      $syncLabel.textContent = "Synced";
      $syncDetail.textContent = `${totalCount} node${totalCount === 1 ? "" : "s"} \u2014 ${parts.join(", ")}`;
      console.log("[wheel:explorer] refreshSyncStatus: showing", totalCount, "nodes,", activeCount, "on canvas");
      renderNodeList(board);
    } catch (err) {
      console.error("[wheel:explorer] refreshSyncStatus error:", err);
    }
  }
  async function stopProject() {
    try {
      await killAllWheelPanes();
      await writeBoardState(panel.secrets, { projectId: null, paneToNode: {}, nodesById: {} });
      suppressPaneRemoved = false;
      $syncArea.hidden = true;
      $nodeList.textContent = "";
    } catch {
      suppressPaneRemoved = false;
    }
  }
  function openBuilder() {
    $builderInline.hidden = false;
    $btnBuilder.hidden = true;
    $builderPrompt.value = "";
    $builderStatus.hidden = true;
    $builderStatus.textContent = "";
    $builderStatus.className = "builder-status";
    $builderGo.disabled = false;
    $builderPrompt.focus();
  }
  function closeBuilder() {
    $builderInline.hidden = true;
    $btnBuilder.hidden = false;
  }
  async function runBuilder() {
    if (!explorerApi) return;
    const promptText = $builderPrompt.value.trim();
    if (!promptText) return;
    const board = await readBoardState(panel.secrets).catch(() => null);
    if (!board?.projectId) return;
    $builderGo.disabled = true;
    $builderCancel.disabled = true;
    $builderStatus.hidden = false;
    $builderStatus.textContent = "Starting builder...";
    $builderStatus.className = "builder-status streaming";
    try {
      const stream = await explorerApi.builderTurn(board.projectId, {
        mode: "improve",
        turns: [{ role: "user", text: promptText }]
      });
      await streamBuilderProgress(stream);
      await syncFromWheel();
      $builderStatus.textContent = "Done \u2014 board synced.";
      $builderStatus.className = "builder-status done";
      setTimeout(closeBuilder, BUILDER_CLOSE_DELAY_MS);
    } catch (err) {
      console.error("[wheel:explorer] builder error:", err);
      $builderStatus.textContent = errorMessage(err) || "Builder failed";
      $builderStatus.className = "builder-status err";
    } finally {
      $builderGo.disabled = false;
      $builderCancel.disabled = false;
    }
  }
  async function streamBuilderProgress(stream) {
    let fullText = "";
    for await (const { event, data } of new SSEStream(new Response(stream))) {
      if (!event || typeof data !== "object" || data === null) continue;
      if (event === "delta" && data.text) {
        fullText += data.text;
        $builderStatus.textContent = fullText.slice(-BUILDER_PREVIEW_CHARS);
      } else if (event === "done") {
        fullText = data.text || fullText;
        $builderStatus.textContent = "Builder finished. Syncing board...";
        $builderStatus.className = "builder-status done";
      } else if (event === "error") {
        throw new Error(data.message || "Builder error");
      }
    }
  }
  async function pollBoardSync() {
    if (!explorerApi) return;
    try {
      const board = await readBoardState(panel.secrets).catch(() => null);
      if (!board?.projectId || board.spawning) return;
      const localNodeIds = new Set(Object.values(board.paneToNode).map((e) => e.nodeId).filter(Boolean));
      if (localNodeIds.size === 0) return;
      const apiBoard = await explorerApi.getBoard(board.projectId);
      const remoteNodeIds = new Set((apiBoard.nodes || []).map((n) => n.id));
      console.log("[wheel:poll] local nodeIds:", [...localNodeIds], "remote nodeIds:", [...remoteNodeIds]);
      const stalePaneIds = Object.entries(board.paneToNode).filter(([, entry]) => !entry.uncommitted && (!entry.nodeId || !remoteNodeIds.has(entry.nodeId))).map(([paneId]) => paneId);
      for (const paneId of stalePaneIds) {
        console.log("[wheel:poll] stale pane:", paneId, "nodeId:", board.paneToNode[paneId]?.nodeId, "not in remote");
      }
      if (stalePaneIds.length === 0) {
        refreshSyncStatus();
        return;
      }
      console.log("[wheel:poll] killing", stalePaneIds.length, "stale panes");
      for (const paneId of stalePaneIds) {
        delete board.paneToNode[paneId];
        await panel.canvas.kill(paneId).catch(() => {
        });
      }
      await writeBoardState(panel.secrets, board);
      refreshSyncStatus();
      await syncWireConnections(board.projectId);
    } catch {
      return;
    }
  }
  function startBoardPolling() {
    if (boardSyncTimer) clearInterval(boardSyncTimer);
    boardSyncTimer = setInterval(pollBoardSync, BOARD_POLL_MS);
  }
})();
