# AGENTS.md

## What this repo is

OpenCode V2 plugin providing the `todowrite` and `taskflow` tools. It is a reconstruction from the published npm package `@vaur94/opencode2-extra-tool@0.2.2` (upstream repo deleted); every model-facing string is translated to English, and the 0.2.2 logic is preserved unchanged. Added later on top of that: persisted todo state, a sidebar widget (`dist/tui.tsx`), and `todos`/`events` routes on the loopback backend. See README "Provenance" for user-facing details.

## The bundle is the only source code

- The shipped artifacts are `LICENSE`, `README.md`, `package.json`, `dist/plugin.js`, `dist/tui.tsx` (plus this file and `SPEC.md` as repo documentation). There is **no `src/`, no tsconfig, no lockfile, no tests**.
- `dist/plugin.js` (unminified esbuild bundle, ~21k lines) is the server-side source. `dist/tui.tsx` is the TUI entry (TSX, run as-is by the TUI loader — no build step). Edit both directly.
- The bundle is fully self-contained: `@opencode-ai/plugin` and the entire `effect` library are inlined. No runtime imports, no `node_modules` needed to run it.
- `// src/index.ts`, `// src/taskflow-backend.ts` etc. inside the bundle are esbuild section markers, **not** files that exist here.

## package.json scripts are inert

`bun run build`, `typecheck`, `test`, `check` all fail (no `src/index.ts`, no tsc, 0 test files) — the scripts are inherited from the original package's tooling. Don't run them or try to "fix" the pipeline; the shipped artifact is the prebuilt bundle.

## Distribution

- This fork is **not published** to npm. `npm install @vaur94/opencode2-extra-tool` fetches the original *Turkish-strings* package.
- The English fork is used by copying `dist/plugin.js` and `dist/tui.tsx` to `~/.config/opencode/plugins/opencode2-extra-tool-en/`. After any edit, both files must be re-copied to take effect.

## Editing conventions

- Keep model-facing strings English-only (the fork's purpose is the Turkish→English translation); currently zero Turkish characters exist in the bundle.
- Plugin entry is the `src_default` export at the end of `dist/plugin.js` (id `opencode2-extra-tool`); tools register via `ctx.tool.transform` → `tools.add(...)` (`todowriteToolFactory`, `registerTaskFlow`). `dist/tui.tsx` exports a second `Plugin.define` with the same id for the TUI loader (it claims the `sidebar.content` slot).
- Runtime state lives in OpenCode plugin storage, keyed by sessionID. The taskflow backend is a token-protected, read-only, loopback-only (127.0.0.1, random port) HTTP endpoint discovered via `${XDG_STATE_HOME:-~/.local/state}/opencode2-extra-tool/taskflow-backend.json` (override: `OPENCODE_TASKFLOW_DISCOVERY_FILE`); it is for a local bridge like `opencode2-web`, not for browsers. It serves taskflow routes plus `GET /v1/todos/:session` and the `GET /v1/events` SSE stream that feeds the sidebar widget.
- Preserve the MIT `LICENSE` (© Ugur Murat Alt) and the README provenance section.
- `.gitignore` covers `.agent/` scratch only; `dist/` is committed on purpose (it is the artifact). Don't commit `node_modules/` or scratch files.
