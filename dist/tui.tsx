// TUI entrypoint for opencode2-extra-tool: renders the per-session todo list
// in the sidebar. Ported from the standalone todo-sidebar sidecar (derived
// from the MIT-licensed gabparrot/opencode2-todo-tool widget) — the display
// code is unchanged, but the transcript parser is gone.
//
// Data source: the loopback taskflow backend this plugin's server side runs
// (discovery file + Bearer token, same contract as taskflow). It seeds
// GET /v1/todos/:session once per (re)connect and then follows the
// GET /v1/events SSE stream (`event: todos`). No session transcript access,
// no polling in the happy path.
//
// Deps (in ~/.config/opencode/package.json): @opencode-ai/plugin@0.0.0-beta-18314
// (the build-matching SDK), @opentui/solid@0.5.17, solid-js.
// @jsxImportSource @opentui/solid
import { Plugin } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Show, onCleanup, onMount } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// Max content width in cells. The sidebar is narrow; a safe cap keeps the
// layout intact regardless of how OpenTUI reports flex widths.
const MAX_CONTENT_COLS = 48
const ELLIPSIS = "…"

// OpenTUI's native truncate hard-clips without an ellipsis, so slice here:
// keep the head of the string and append "…" when it doesn't fit.
function clip(text: string, maxCols = MAX_CONTENT_COLS): string {
  if ([...text].length <= maxCols) return text
  return [...text].slice(0, maxCols - 1).join("") + ELLIPSIS
}

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

type Todo = {
  content: string
  status: TodoStatus
  priority: string
}

// ---------------------------------------------------------------------------
// Backend client (module level: one connection per TUI process, all sidebar
// slots share it).
// ---------------------------------------------------------------------------

type BackendState = { url: string; token: string }

function discoveryPath(): string {
  return (
    process.env.OPENCODE_TASKFLOW_DISCOVERY_FILE ??
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode2-extra-tool", "taskflow-backend.json")
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const todosBySession = new Map<string, Todo[]>()
const openSessions = new Set<string>()
const [tick, setTick] = createSignal(0)
let clientStarted = false
let warned = false

function ensureClient() {
  if (clientStarted) return
  clientStarted = true
  void run()
}

async function run() {
  let backoff = 1000
  for (;;) {
    try {
      const backend = await readDiscovery()
      backoff = 1000
      await connect(backend)
    } catch (error) {
      // Non-terminating retry: the backend starts when the server plugin
      // loads; log once, then just keep trying.
      if (!warned) {
        console.error("todo sidebar: backend unavailable", error instanceof Error ? error.message : error)
        warned = true
      }
      const enoent = isRecord(error) && error.code === "ENOENT"
      await sleep(enoent ? 5000 : backoff)
      if (!enoent) backoff = Math.min(backoff * 2, 5000)
    }
  }
}

async function readDiscovery(): Promise<BackendState> {
  const raw = await readFile(discoveryPath(), "utf8")
  const parsed = JSON.parse(raw) as unknown
  if (!isRecord(parsed) || typeof parsed.url !== "string" || typeof parsed.token !== "string" || !parsed.url || !parsed.token) {
    throw new Error("discovery file malformed")
  }
  return { url: parsed.url, token: parsed.token }
}

async function connect(backend: BackendState) {
  const base = backend.url.endsWith("/") ? backend.url : `${backend.url}/`
  const headers = { authorization: `Bearer ${backend.token}` }
  // Seed the sessions currently open in the TUI (covers updates made while
  // the stream was down); the SSE stream is authoritative afterwards.
  for (const sessionID of openSessions) {
    try {
      const response = await fetch(`${base}v1/todos/${encodeURIComponent(sessionID)}`, { headers })
      if (!response.ok) continue
      const body = (await response.json()) as { todos?: unknown }
      applyTodos(sessionID, body.todos)
    } catch {
      // best-effort seed
    }
  }
  const response = await fetch(`${base}v1/events`, { headers })
  if (!response.ok || !response.body) {
    throw new Error(`events endpoint returned ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      handleFrame(frame)
    }
  }
  throw new Error("events stream closed")
}

function handleFrame(frame: string) {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("")
  if (!data) return // heartbeat / comment frames
  try {
    const payload = JSON.parse(data) as unknown
    if (!isRecord(payload) || typeof payload.sessionID !== "string" || !Array.isArray(payload.todos)) return
    applyTodos(payload.sessionID, payload.todos)
  } catch {
    // ignore torn frame
  }
}

function applyTodos(sessionID: string, value: unknown) {
  todosBySession.set(sessionID, guardTodos(value))
  setTick((value) => value + 1)
}

// Minimal shape guard: the server validates every todo on write, so a record
// with a non-empty content string is all the shape check needs.
function guardTodos(value: unknown): Todo[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.content !== "string" || !item.content.trim()) return []
    const status = item.status === "in_progress" || item.status === "completed" || item.status === "cancelled" ? item.status : "pending"
    return [{ content: item.content.trim(), status, priority: typeof item.priority === "string" ? item.priority : "" }]
  })
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "opencode2-extra-tool",
  setup(context: any) {
    // Server-side load: no TUI context — nothing to claim.
    if (!context?.ui?.slot) return
    ensureClient()
    return context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }: { sessionID: string }) => <View context={context} sessionID={sessionID} />,
    })
  },
})

function View(props: { context: any; sessionID: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = props.context.theme
  onMount(() => {
    openSessions.add(props.sessionID)
  })
  onCleanup(() => {
    openSessions.delete(props.sessionID)
  })
  const todos = createMemo(() => {
    void tick()
    return todosBySession.get(props.sessionID) ?? []
  })
  const done = createMemo(() => todos().filter((todo: Todo) => todo.status === "completed").length)
  // Hide the whole widget when the session has no todos; a fully completed
  // list stays visible (struck through / subdued).

  return (
    <Show when={todos().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen((value: boolean) => !value)}>
          <text fg={theme.text.default}>{open() ? "▼" : "▶"}</text>
          <text fg={theme.text.default}>
            <b>TODO</b>
            <span style={{ fg: theme.text.subdued }}>
              {todos().length === 0 ? "" : ` (${done()}/${todos().length} done)`}
            </span>
          </text>
        </box>
        <Show when={open() && todos().length > 0}>
          <For each={todos()}>
            {(todo: Todo) => (
              <box flexDirection="row" gap={1} minWidth={0}>
                <box flexShrink={0} width={2}>
                  <text fg={markerColor(theme, todo.status)}>
                    {marker(todo.status)}
                  </text>
                </box>
                <Show
                  when={todo.status === "in_progress"}
                  fallback={
                    <text
                      fg={lineColor(theme, todo.status)}
                      attributes={todo.status === "cancelled" ? TextAttributes.STRIKETHROUGH : undefined}
                      wrapMode="none"
                      flexGrow={1}
                      flexShrink={1}
                      minWidth={0}
                    >
                      {clip(todo.content)}
                    </text>
                  }
                >
                  <text fg={inProgressColor(theme)} attributes={TextAttributes.BOLD} wrapMode="none" flexGrow={1} flexShrink={1} minWidth={0}>
                    {`▶${clip(todo.content, MAX_CONTENT_COLS - 1)}`}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

function marker(status: TodoStatus) {
  if (status === "completed") return "◉"
  if (status === "in_progress") return "◉" // text gets bold+color+▶ prefix in View
  if (status === "cancelled") return "○"
  return "○"
}

function inProgressColor(theme: any) {
  // Distinct accent for in-progress lines; falls back down the warning scale.
  return theme?.text?.feedback?.warning?.default ?? theme?.text?.default
}

function markerColor(theme: any, status: TodoStatus) {
  if (status === "completed") return theme.text.feedback.success.default
  if (status === "in_progress") return theme.text.feedback.warning.default
  return theme.text.subdued
}

function lineColor(theme: any, status: TodoStatus) {
  if (status === "completed" || status === "cancelled") return theme.text.subdued
  if (status === "in_progress") return theme.text.feedback.warning.default
  return theme.text.default
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
