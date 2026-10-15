# SPEC: Integrate todo sidebar into the main plugin

## Goal (DoD)

The sidecar's sidebar functionality (todo list rendered in the OpenCode V2 TUI `sidebar.content` slot) is **built into the main plugin** (`opencode2-extra-tool`). The sidecar (`todo-sidebar/`) is absorbed and deleted. The TUI must display the server's todo state **without redundantly monitoring session data** — the transcript is not re-scanned; the server is the single observer and write point.

## Findings: how events/tool calls are handled today

### Main plugin — `dist/plugin.js` (server process only)

| Concern | Mechanism | Location (bundle lines) |
|---|---|---|
| `todowrite` tool | `ctx.tool.transform(tools => tools.add(todowriteToolFactory(store)))` | 21418–21424 |
| todo state write | `store.update(toolCtx.sessionID, todos)` inside tool `execute` — **the only writer** | 21403–21415 |
| todo state storage | in-memory `Map<sessionID, todos>`, **no persistence, no broadcast** | 21317–21328 |
| taskflow state storage | persistent `ctx.storage.get/set("taskflow/session/<encoded>")` | 21240–21244, 20640, 20664–20666 |
| event handling | **one** `ctx.event.subscribe({signal})` loop, filters `session.idle` / `session.execution.succeeded` → taskflow continuation via `ctx.session.synthetic` + final-report capture | 21278–21294 |
| model-context hook | `ctx.session.hook("context", addTaskFlowContext)` — strips audit messages, pushes completion nudge | 21268, 21170–21183 |
| loopback backend | Node `http` server, `127.0.0.1` random port, Bearer token (timing-safe), GET-only JSON: `/v1/taskflows/:session`, `/v1/taskflows/:session/history`; discovery file `${XDG_STATE_HOME:-~/.local/state}/opencode2-extra-tool/taskflow-backend.json` (0600, atomic write); non-GET → 405 | 20539–20541, 20542–20548, 20576–20635 |
| UI | **none** — server entry only, no TUI entrypoint | 21427–21442 |

Key fact: **nothing in the main plugin observes todo changes** — state exists only as a side effect of the tool's `execute`, in a process-local Map that dies with the server.

### Sidecar — `todo-sidebar/` (separate plugin, id `todo.sidebar`)

- `index.tsx` (server entry): `{ id: "todo.sidebar", setup() {} }` — inert.
- `tui.tsx` (TUI entry): claims `context.ui.slot({ append: "sidebar.content", render })` (lines 40–44) and renders a solid-js widget (collapse, markers, colors, hide-when-empty, keep-visible-when-complete).
- **Data flow (the redundancy)**: `createMemo(() => latestTodos(context.data.session.message.list(sessionID)))` (line 50) — on every reactive render it pulls the **entire session transcript** through the TUI SDK, walks all assistant messages backwards looking for the latest `todowrite` tool part (106–116), and parses the list through six fallback shapes — `state.output`, `part.output`, two metadata paths, two content paths, plus `JSON.parse` and a markdown-checkbox parser (118–202).

Why it is redundant/fragile:

1. Re-derives on the client what the server already computed at the single write point.
2. O(transcript) scan per render, with no invalidation control.
3. ~100 lines of speculative parsing exist only because the client doesn't trust the server's state; an empty `[]` result is a real trap here (it falls through to an older non-empty call — the sidecar had to special-case it, see its `parseTodos` comment, tui.tsx 149–158). Integration removes the bug class: the server broadcasts the authoritative list, clears included.
4. Runs in a different process than the server plugin — there is no direct path to the Map; the transcript was the only cross-process channel it had.

### Process model

- Server plugin host process runs `dist/plugin.js` (owns `ctx`: storage, event bus, session, tool).
- TUI process runs the `tui` entrypoint (owns `context`: `ui.slot`, `theme`, `data` SDK, `sessionID` per slot).
- Verified cross-process channels: (a) the loopback HTTP backend + discovery file; (b) the transcript via `context.data`. Channel (a) is the one to use.

## Target architecture

```
 model → todowrite tool (server)
              │  store.update(sessionID, todos)   ← single write point
              ▼
   TodoStore (Map cache + ctx.storage persistence)
              │  onWrite(sessionID, todos)
              ▼
   loopback backend (existing) ── SSE  GET /v1/events   {sessionID, todos, version}
              ▲   +   GET /v1/todos/:session (seed)
              │
   dist/tui.tsx (TUI entry, same plugin) ── reads discovery file, Bearer token
              │   fetch SSE, reconnect w/ backoff, seed on (re)connect
              ▼
   signal → solid View in sidebar.content slot (ported sidecar rendering)
```

No event-bus subscription, no transcript access, no polling in the happy path. The only reaction to todo changes is the server pushing at the write point.

## Changes

### S1 — Server: todo store persistence + write notification (bundle `// src/todowrite.ts` section)

- Rework `createTodoStore()` to the taskflow store shape: `createTodoStore({ read, write })` backed by `ctx.storage` under `todowrite/session/<encodeURIComponent(sessionID)>` (mirrors `TASKFLOW_STORAGE_PREFIX` pattern). The broadcaster is not a constructor arg — it is late-attached (see S2 wiring).
- `update(sessionID, todos)` becomes async: update in-memory Map, persist via `write`, then fire the attached broadcaster if present. Empty list = delete both (clear semantics preserved).
- Seed the Map from `read(sessionID)` lazily on first `get` after a restart.
- Add a monotonic `version` counter (per store instance) included in every broadcast.
- `registerTodoWriteTool(ctx)` wires `read`/`write` from `ctx.storage` and now also **returns the store** (alongside its dispose) so `setup` can hand it to taskflow; the broadcaster is **late-attached** (S2) because the backend only exists after `registerTaskFlow` runs. Tool `execute` awaits `store.update`.
- Store exposes `attachBroadcaster(fn)`; `update` fires the attached fn if present, no-op otherwise.
- `updatesBySession` reminder counter unchanged.

### S2 — Server: extend the loopback backend (bundle `// src/taskflow-backend.ts` section)

- Keep everything existing byte-compatible (token, discovery file path/format, taskflow routes) — the `opencode2-web` bridge must not break.
- New route `GET /v1/todos/:session` → `{ available: true, todos: Todo[] }` (empty array when none). Same sessionID validation as taskflow routes.
- New route `GET /v1/events` → SSE (`text/event-stream`, `cache-control: no-store`):
  - `event: todos`, `data: {"sessionID":..., "todos":[...], "version":N}` on every store write (via `pushTodos`; including clears — the TUI hides the widget on `[]`).
  - Heartbeat comment line (`: hb`) every 15 s.
  - Close on client disconnect; many clients allowed (only auth check per request).
- Handler change: branch to the SSE response before the existing 405/JSON path (SSE is GET, so the 405 rule still holds). `send()` (JSON, always ends) is left untouched for other routes.
- SSE cleanup: on client `close`, remove the response from the client set and clear its heartbeat interval (leaked timers would keep the process alive and broadcast to dead sockets).
- Broadcast wiring (verified gap): the backend is created **inside `registerTaskFlow`** (21253) while the todo store lives in `registerTodoWriteTool` (21419) — there is no path between them today. Wiring: `setup` (21427–21442, which already registers the todo tool *before* taskflow) calls `registerTaskFlow(ctx, { todoStore })`; inside, after the real backend starts successfully, `todoStore.attachBroadcaster((sessionID, todos, version) => backend.pushTodos(...))`. `startTaskFlowBackend` gains: a `pushTodos` method on its return object, an internal `Set` of live SSE responses, and options `readTodos: (sessionID) => todoStore.get(sessionID)` mirroring `readSnapshot`/`readHistory`. Attach **only** in the `startTaskFlowBackend` branch — the injectable `options.startBackend` path (21253) returns a bare `{dispose}` and must not be assumed to have `pushTodos` (nothing in this repo uses it; keep it compiling). Keep backend ownership/disposal exactly where it is (inside the taskflow teardown, 21299–21309) — do not move it.
- Degradation: backend start failure is already caught in setup (21259–21261) and leaves a no-op backend — then the sidebar just never gets data and stays hidden; taskflow keeps working. No new error path needed.

### T1 — New file `dist/tui.tsx` (TUI entry of the main plugin)

Single self-contained file (no build step; the TUI runtime executes TSX directly with `@jsxImportSource @opentui/solid`, same as the working sidecar). Contents:

- `Plugin.define({ id: "opencode2-extra-tool", setup(context) })`; server-side load (no `context.ui.slot`) → no-op, same as sidecar.
- Claim `sidebar.content`; render the **ported sidecar View** (collapse toggle, `(done/total)` counter, status markers/colors, `clip()`, hide-when-empty, completed lists stay visible) fed by a signal instead of the transcript memo.
- **Backend client** (module-level, one connection per TUI process):
  1. Read discovery file (`process.env.OPENCODE_TASKFLOW_DISCOVERY_FILE ?? XDG_STATE_HOME/...`), parse `{ url, token }`. File not found → retry every 5 s (backend starts during plugin setup; log once on give-up-free retry loop).
  2. `fetch(url + "v1/events", { headers: { authorization: "Bearer " + token } })` → stream SSE lines → on `todos` event update `state[sessionID] = { version, todos }` and bump a signal.
  3. On (re)connect: seed with `GET /v1/todos/:session` for every currently open slot, so pre-existing lists appear immediately.
  4. Reconnect with exponential backoff (1 s → 5 s cap) on stream end/401/network error; re-seed after each reconnect.
- **Delete** the transcript machinery: `latestTodos`, `todosFromPart`, `todosFromUnknown`, `todosFromContent`, `parseTodos`, `parseStatus`, `parseChecklist`, `markStatus`, `parseJson`, `parseTodo` — the server sends structured `Todo[]`; keep `isRecord` and add only a minimal shape guard (`isTodoArray`) around the SSE payload.
- Display-side code kept as-is: `clip`, `marker`, `inProgressColor`, `markerColor`, `lineColor`, `Todo`/`TodoStatus` types, `MAX_CONTENT_COLS`.

### D1 — Distribution / docs

- Flat local install becomes two files (README "Install" section):
  ```sh
  mkdir -p ~/.config/opencode/plugins/opencode2-extra-tool-en
  cp dist/plugin.js ~/.config/opencode/plugins/opencode2-extra-tool-en/plugin.js
  cp dist/tui.tsx  ~/.config/opencode/plugins/opencode2-extra-tool-en/tui.tsx
  ```
- README: TUI entry requires `solid-js`, `@opentui/solid`, `@opentui/core` (and the build-matching `@opencode-ai/plugin`) resolvable from `~/.config/opencode/package.json` — the same set the sidecar already used; extend the backend paragraph to mention `/v1/todos/:session` + `/v1/events`, token-protected, local bridge use.
- Repo: delete `todo-sidebar/` after validation (its `tui.tsx` is the seed for `dist/tui.tsx`).
- **Before validating**: the original npm package was observed live in this session (its `taskflow` tool answered in Turkish) — so the machine currently loads `@vaur94/opencode2-extra-tool` alongside any flat local copy. Installing the integrated English plugin must not coexist with the npm entry: remove the npm plugin from `opencode.json` `plugins` for validation, otherwise both register `todowrite`/`taskflow` (duplicate tools, two backends fighting over the discovery file) and results will be misdiagnosed.
- `package.json` `files`/`exports`: add the TUI entry if npm distribution is ever revived (fork is unpublished — no-op for now, note in README).

## API contract (new surface)

```
GET /v1/todos/:session
  → 200 { "available": true, "todos": [{ "content": string, "status": "pending|in_progress|completed|cancelled", "priority": "high|medium|low" }] }
  → 401/400/404/405/500 as today

GET /v1/events   (SSE)
  event: todos
  data: {"sessionID":"<id>","todos":[...],"version":12}
  : hb                      (every 15 s)
```

Auth: Bearer token from the discovery file, all routes, timing-safe compare (unchanged). Transport: `127.0.0.1` only (unchanged).

## Acceptance criteria (DoD)

1. With **only the main plugin** installed (the two files above), a `todowrite` call in a session shows the list in the TUI sidebar; every subsequent `todowrite` updates it live; an empty list hides the widget; click collapses; a fully completed list stays visible (subdued/strikethrough) — parity with the sidecar.
2. `dist/tui.tsx` contains **no** `context.data.session.message` (or equivalent transcript) access for todos; the only data path is the backend. Verified by grep + by observing the SSE connection while driving a session.
3. Server restart: todos survive (storage-backed), sidebar re-seeds after reconnect.
4. Taskflow regression: `/v1/taskflows/:session` and `.../history` responses unchanged; taskflow continuation behavior unchanged (existing `session.idle` loop untouched).
5. No Turkish strings introduced; English only. `LICENSE`/README provenance intact.

## Risks / tradeoffs

- **Remote TUI**: the loopback backend lives on the server host; a TUI on another machine gets no data (the old transcript approach worked remotely). Accepted: local-first, matches the existing backend's stated purpose ("local bridge, not exposed to browsers"). If the TUI SDK ever exposes a server→UI reactive channel, prefer it — but do not fall back to transcript scanning.
- **TUI starts before server**: discovery-file retry loop with 5 s backoff; widget simply absent until the connection lands.
- **Multiple concurrent OpenCode servers**: each overwrites the discovery file at startup (last starts wins) — pre-existing behavior of the taskflow backend, unchanged by this spec.
- **SSE support in TUI runtime**: bun `fetch` streams are available; if the TUI process turns out to run under a non-bun loader without streaming fetch, contingency is 1 s polling of `/v1/todos/:session` — same write-point architecture, still no transcript monitoring. Decide during implementation, note the outcome in README.

## Implementation order

1. S1 (store persistence + `attachBroadcaster`, return store from `registerTodoWriteTool`) — bundle edit, keep tool `execute` behavior identical otherwise.
2. S2 (backend `pushTodos` + `/v1/todos/:session` + `/v1/events` SSE + `setup`→`registerTaskFlow({ todoStore })` wiring) — keep taskflow routes byte-compatible.
3. T1 (`dist/tui.tsx`) — port sidecar View, add backend client, remove transcript parsers.
4. D1 (README/install, delete `todo-sidebar/`).
5. Validate against all five acceptance criteria (flat install, live session, restart, taskflow regression, grep checks).

## Open questions (resolve during implementation, not before)

- Does the TUI loader accept server+TUI entries sharing one plugin `id` (`opencode2-extra-tool`)? The sidecar already uses one id across its two entries, so risk is low — verify, and if the loader complains, fall back to a distinct TUI id.
- Exact TUI SDK shape of `context.data` (only used here to *avoid* it — confirm nothing in the ported View still touches it).
