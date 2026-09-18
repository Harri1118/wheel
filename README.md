# Wheel

They always say "don't reinvent the wheel" — sometimes you have to.

Wheel is a per-project, per-user container that runs Claude Code / Codex agents as child processes, wired to each
other and to tables, endpoints, scripts, MCP servers, vaults and chests on a visual board.

- `docs/ARCHITECTURE.md` — the shared contract every team builds against. Read it first.
- `docs/PROTOCOL.md` — engine control plane + `wheel` CLI (SDK/Engine team)
- `docs/API.md` — api.wheel.dev (API team)
- `docs/TESTPLAN.md` — acceptance criteria (QA)
- `redteam/` — threat model and findings (ADVERSARY)

Workflow: one worktree per team under `/Users/metatron/wheel-wt/<role>`, merge to `main` after `make check`.

## Running Wheel

Wheel is source-available (PolyForm Noncommercial 1.0.0) — free to use, modify, and share for any noncommercial purpose.

Fastest way to get going — Docker Engine + `git`, nothing else:
```bash
docker build -f docker/Dockerfile.wheeld -t wheeld .
docker run -d --name wheeld --stop-timeout 30 -v wheel-data:/data -p 127.0.0.1:8080:8080 wheeld
(umask 077; docker exec wheeld cat /data/operator-token > ~/.wheel-token)
export WHEEL_TOKEN_FILE=~/.wheel-token
```

Then drive it with that token:
```bash
wh() { local path=$1; shift
       curl -fsS -H @<(printf 'x-auth-token: %s\n' "$(cat "${WHEEL_TOKEN_FILE:-$HOME/.wheel/operator-token}")") \
            -H 'content-type: application/json' "http://127.0.0.1:8080$path" "$@"; }

P=$(wh /v1/projects -d '{"name":"hello"}' | jq -r .id)            # a project; its engine starts with it

wh /v1/projects/$P/board/apply -d '{"board": {
  "nodes": [ {"name": "keys",     "type": "vault", "config": {"keys": []}},
             {"name": "worker",   "type": "agent", "config": {"harness": "claude", "system_prompt": "Be brief."}},
             {"name": "reviewer", "type": "agent", "config": {"harness": "claude", "system_prompt": "Review worker."}} ],
  "wires": [ {"from": "worker",   "to": "keys", "type": "read"},
             {"from": "reviewer", "to": "keys", "type": "read"} ] }}'

id() { wh /v1/projects/$P/engine/v1/board | jq -r --arg n "$1" '.nodes[] | select(.name == $n) | .id'; }

# Sign `worker` into a real Anthropic account (paste-code OAuth) rather than pasting an API key —
# self-hosted wheeld's default policy accepts either, but this is the path that also lets `reviewer`
# share the credential with no login of its own.
begin=$(wh /v1/projects/$P/engine/v1/agents/$(id worker)/auth/begin -X POST)
echo "$begin" | jq -r .url            # open this, sign in, and copy the code Anthropic shows you
session=$(echo "$begin" | jq -r .session)
read -rp 'paste the code: ' code
wh /v1/projects/$P/engine/v1/agents/$(id worker)/auth/complete -d "$(jq -n --arg c "$code" --arg s "$session" \
  '{code: $c, session: $s, save_to_vault: "keys", allow_shared_expiry: true}')"

wh /v1/projects/$P/engine/v1/agents/$(id worker)/start -X POST
wh /v1/projects/$P/engine/v1/agents/$(id worker)/send -d '{"body": "Say hello."}'
wh "/v1/projects/$P/engine/v1/agents/$(id worker)/log?limit=50"
```
Four traps in that flow, each one a refusal you'd otherwise have to reverse-engineer:
- The child spawned by `auth/begin` **stays alive between the two calls** — that's the whole reason
  this is two calls instead of one, since the CLI itself is what verifies the pasted code — and the
  engine kills it if you never come back with `auth/complete`.
- `save_to_vault` needs the agent to **already hold a `read` wire** to that vault (403 otherwise),
  which is why the wire is drawn in `board/apply` before any of this runs.
- `allow_shared_expiry: true` is **required whenever the credential expires and at least one other
  agent already reads that vault** — `reviewer` does here, so this would 409 (`shared_expiry`)
  without it: every reader stops the moment a shared session lapses, and a warning buried in a
  response body is the wrong place to learn that. `claude setup-token` (run locally, where the CLI
  is installed) produces a credential that never expires — paste it as
  `{"setup_token": "<token>", "save_to_vault": "keys"}` and the flag is not needed at all.
- **Never pass `vault_key`.** The engine derives the right variable name from the credential itself
  (`CLAUDE_CODE_OAUTH_TOKEN` for a login, `ANTHROPIC_API_KEY` for a provider key) and refuses a
  caller who names a different one — letting the caller choose would let one agent's key land under
  a name the harness doesn't read for every OTHER agent that shares the vault.

Want the board UI too? `WHEEL_API_URL=http://127.0.0.1:8080 npx wheel-web` (needs Node 22+).

Building `wheeld` from source, the board UI in depth, production deployment (systemd, reverse proxy, signup,
Railway/VM/Kubernetes), and every environment variable: **[docs/SETUP.md](docs/SETUP.md)**.

### Agents and credentials
Agents are Claude Code / Codex processes. Give them credentials through a **vault** node (one per account; wire
the agent to it) or the agent's Authenticate panel (in-browser login, `claude setup-token`, or an API key). See
`docs/ARCHITECTURE.md` for the model and `docs/WHEEL-ON-WHEEL.md` for a board that develops Wheel itself.

### Authoring a board from source
`board/apply`'s request shape is not what `GET .../board` hands back — one is a spec you write, the
other is board state with ids and runtime status — and mixing the two up is the most common way to
get a `422` here. Everything below is checked directly against `wheel_core::node`, `validate.rs` and
`wheel_core::wire::wire_allowed`, not transcribed from memory.

**Node shape**: `{"name", "type", "config": {...}, "position": {x, y}}` — `config` is a NESTED
object keyed by node type, never flattened onto the node itself (`NodeConfig` is adjacently
tagged: `#[serde(tag = "type", content = "config")]`). `position` defaults to `{0, 0}` if omitted.
Minimum config per type actually used above, plus the ones most often gotten wrong:
- `agent`: `harness` (`"claude"` or `"codex"`) and `system_prompt` are required; everything else
  (`model`, `run_on_startup`, `ephemeral_context`, `idle_timeout_secs`, `budget`, `workspaces`)
  defaults.
- `ctx`: `markdown` (a string) — **not** `text`.
- `vault`: `keys`, an array — `[]` is legal; it only documents what SHOULD be there and is never
  required to match what's actually written.
- `endpoint`: `method`, `path` (leading slash, no `..`), `response_mode` — exactly `"ack"` or
  `"script"`, nothing else. `auth` defaults to `{"mode": "none"}`.
- `table`: `columns`, an array of `{"name", "type"}` (`type` one of `text`/`integer`/`real`/`blob`/`json`).

**Wires** are a FLAT list in the request, `{"from", "to", "type"}`, addressed by NODE NAME — not
id. The matrix is asymmetric and default-deny; the two directions that trip people up most are
`vault → agent` (refused — vaults have no outgoing wires at all; an agent *reads* a vault, a vault
never reaches one) and anything `→ endpoint` (also refused — an endpoint only wires OUT). The rest,
transcribed from `wire_allowed` itself:

| from → to | read | write | send |
|---|---|---|---|
| agent → agent | — | — | ✓ |
| agent → ctx | ✓ | ✓ | — |
| agent → table | ✓ | ✓ | — |
| agent → vault | ✓ | — | — |
| agent → chest | ✓ | ✓ | — |
| agent → script | ✓ | — | — |
| agent → mcp | ✓ | — | — |
| agent → tool | ✓ | — | — |
| tool → vault | ✓ | — | — |
| ctx → agent | — | — | ✓ |
| endpoint → agent | — | — | ✓ |
| endpoint → table | — | ✓ | — |
| endpoint → script | — | — | ✓ |
| endpoint → vault | ✓ | — | — |
| script → agent | — | — | ✓ |
| script → ctx | ✓ | ✓ | — |
| script → table | ✓ | ✓ | — |
| script → chest | ✓ | ✓ | — |
| script → vault | ✓ | — | — |
| script → tool | ✓ | — | — |

Everything not in this table is refused. `mcp`, `table`, `vault` and `chest` have no outgoing wires
at all.

**`dry_run: true`** plans the board — same validation, same response shape — without creating or
wiring anything, so you can check a board before committing to it.

**`allow_patch`/`allow_wire`** default to `false`. A board that names a node which already exists
is refused (`422`, `patch_not_permitted`, naming every node it would have touched) rather than
silently modified; a wire that would attach to an existing node is refused the same way
(`wire_touches_existing_node`). Set the matching flag to opt in — the refusal body names exactly
what you're being asked to grant, so there's no guessing.

**The project-level HTTP gate is separate from the endpoint's own config, and easy to miss.** An
`endpoint` node with `auth: {"mode": "none"}` and a correct `path` still answers `403` on
`/p/{project}/...` until the PROJECT ITSELF has `capabilities.http: true`:
```bash
wh /v1/projects/$P -X PATCH -d '{"capabilities": {"http": true}}'
```
The endpoint can look completely correctly configured and still be refused — this gate is checked
before the request ever reaches the endpoint node, and nothing on the endpoint's own config hints
that it exists. Tracked as `redteam/findings/057` (the gate itself fails safe and is correct by
design; the finding is about the missing signal, not the gate).

**A saved `GET .../board` response is not what `board/apply` wants**, and feeding one straight to
the other fails confusingly rather than obviously: `GET .../board` returns wires PER NODE, keyed by
the OTHER node's id (`{"nodes": [{"id", "name", ..., "wires": [{"to": "<id>", "type": "read"}]}]}`);
`board/apply` wants one flat list keyed by NAME. Translating one into the other:
```bash
board=$(wh /v1/projects/$P/engine/v1/board)
by_id=$(echo "$board" | jq '[.nodes[] | {key: .id, value: .name}] | from_entries')
echo "$board" | jq --argjson by_id "$by_id" '{
  nodes: [.nodes[] | {name, type, config, position}],
  wires: [.nodes[] | .name as $from | .wires[] | {from: $from, to: $by_id[.to], type}]
}'
```
There is no built-in export/import endpoint yet to do this for you — it's tracked, not shipped.

# Development
Wheel develops itself; there is a cloud board (template available for free) that handles each moving piece separately so that the agents can figure out what they need and build it themselves. If you want to contribute to wheel, you can clone it and get started in the `crates/`, `web/`, or `docker/` directory.  

# Legal disclaimer, asshole
Wheel is independent, original work. It shares no code, assets, copy, designs, or other protected material with any other product, and it wasn't built using anyone's confidential or proprietary information.

Ideas aren't ownable; expression is. Wheel is my own expression of ideas that are common to this category of tooling. If you think otherwise, the contact address is in the LICENSE — put it in writing.
