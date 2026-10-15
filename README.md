# opencode2-extra-tool (English strings)

An OpenCode V2 plugin that provides the `todowrite` and `taskflow` tools.

> **Provenance.** The upstream repository
> (`github.com/ugur-murat-alt/opencode2-extra-tool`) has been deleted and no
> forks of it exist on GitHub, so this project was reconstructed from the
> published npm package `@vaur94/opencode2-extra-tool@0.2.2` (which contains
> only the unminified esbuild bundle, `dist/plugin.js` — no TypeScript sources).
> Every model-facing Turkish string in the bundle was translated to English;
> the 0.2.2 logic is preserved unchanged. Features added after the
> reconstruction (todo persistence, the sidebar widget, and the backend
> `todos`/`events` routes) are documented below and keep the shipped tool
> contracts intact. MIT license and upstream attribution (© 2026 Ugur Murat Alt)
> are preserved. This fork is not
> published to npm; `npm install` of the `@vaur94` name still fetches the
> original (Turkish-strings) package.

## Install

```jsonc
{
  "plugins": ["@vaur94/opencode2-extra-tool@0.2.2"]
}
```

To use this fork instead of the original npm package (English model-facing
strings), place both entries in OpenCode's local plugins directory — the
server entry must be named `index.js` and the TUI entry `tui.tsx` (the loader
resolves `index.*` / `tui.*` inside a plugin directory; any other filename is
ignored):

```sh
mkdir -p ~/.config/opencode/plugins/opencode2-extra-tool-en
cp dist/plugin.js ~/.config/opencode/plugins/opencode2-extra-tool-en/index.js
cp dist/tui.tsx ~/.config/opencode/plugins/opencode2-extra-tool-en/tui.tsx
```

Plugins load at OpenCode server startup, so restart the server after copying
(a TUI relaunch alone is not enough if the `opencode serve` process keeps
running).

`plugin.js` is the server entry (tools + storage + loopback backend). `tui.tsx`
is the TUI entry and renders the todo list in the sidebar; it needs the usual
TUI plugin dependencies in `~/.config/opencode/package.json`
(`@opencode-ai/plugin`, `@opentui/solid`, `solid-js`).

`todowrite` replaces the current session's full structured task list. Its input is
`{ todos: [{ content, status, priority }] }`; an empty list clears it. The list
persists in OpenCode plugin storage across restarts and is shown live in the
sidebar widget (`tui.tsx`), fed by the loopback endpoint described below:
instant SSE pushes plus a periodic storage-backed reconcile — no transcript
access.

## Taskflow

`taskflow` stores a full, session-scoped task plan with an objective, acceptance
criteria, and ordered steps. The current state, durable revision history, step
transition times, and continuation counters use OpenCode's plugin storage. Plan
and report history is kept out of the model conversation, so bookkeeping does not
create extra assistant turns or distract the agent. Active-plan guidance is not
repeated on every tool-driven model call. When an incomplete session becomes idle,
the plugin queues one detailed continuation message for that plan revision so the
agent can resume the remaining steps and update their statuses at meaningful
milestones. Continuation text is capped to keep unusually large plans from
flooding the model context.

A step can be marked `blocked` when a verified blocker prevents further work.
Blocked steps keep the plan incomplete but do not trigger automatic continuation;
continuation resumes after a later revision makes at least one step `pending` or
`in_progress` again.

A step may name an existing agent. The plugin only records that assignment and
instructs the active agent to use OpenCode's existing delegation flow; it never
registers or injects an additional agent.

Plan snapshots classify updates as initial, progress, definition, or unchanged;
definition changes identify the affected title, objective, acceptance criteria,
step structure/content, agent assignment, and step status fields. Once all steps
are complete, the latest assistant response is stored as a bounded final report
for that revision and is included in the read-only snapshot.

Current plans and per-revision continuation markers are restored after an
OpenCode service restart. The plugin also publishes a token-protected, read-only
loopback endpoint discovered through
`${XDG_STATE_HOME:-~/.local/state}/opencode2-extra-tool/taskflow-backend.json`.
This endpoint is intended for a local bridge such as `opencode2-web`; it is not
exposed directly to browsers.

The same endpoint also serves the todo state: `GET /v1/todos/:session` returns
the session's current list (`{ available, todos }`), read fresh from plugin
storage on every request — so the answer stays correct even when several
server instances each run a backend. `GET /v1/events` is a server-sent event
stream that emits `event: todos` frames (`{ sessionID, todos, version }`) on
every `todowrite` call, with a comment heartbeat every 15 s. The TUI sidebar
widget follows the SSE stream for instant updates and reconciles through the
GET route every 15 s.
