# Plan: OpenTUI terminal dashboard over the activity feed

## 0. The one finding that decides the shape

**OpenTUI cannot create its native renderer on this repo's pinned runtime.** Per
opentui.com/docs/getting-started/runtime-support:

- Bun ≥ 1.3, **or**
- Node.js ≥ 26.4.0 with `--experimental-ffi` (ESM only; the Core graph is async and
  `require()` fails with `ERR_REQUIRE_ASYNC_MODULE`).

This repo is Node ≥ 24 (running 24.11.1), no build step. So the plan is: **the harness
stays on Node ≥ 24; the TUI is an opt-in entry that requires Node ≥ 26.4 +
`--experimental-ffi` or Bun ≥ 1.3.** Everything except the thin view layer is plain
TypeScript that runs and is tested on Node 24 without FFI.

A second, confirming finding: `src/index.ts` already names "the window" as a layer that
is *deliberately absent* from the public contract — so the TUI is a consumer, like
`cli.ts`/`server.ts`. Nothing is added to `index.ts`; nothing under `src/core/`,
`src/modes/`, or `spec/` changes.

## 1. Architecture

```
alkor-server (unchanged)                TUI process (new)
  GET /health ────────────────────────────►  poll once at startup (profile list, counts)
  GET /events (SSE: replay + live,          ─► src/tui/sse.ts   → frames → ActivityEvent
               Last-Event-ID, heartbeat)         │
                                              src/tui/state.ts → pure reducer → ProjectState
                                                 │
                                              src/tui/app.ts  → @opentui/core renderables
```

- **One consumption path only: SSE over HTTP.** No in-process mode, no second bus
  subscription — the documented `GET /events` contract (replay ring, `Last-Event-ID`
  resume, 15 s heartbeat, `activitySpec` check) is the whole integration surface.
- **All intelligence in a pure reducer.** `ProjectState` is derived only from events;
  the OpenTUI layer renders it and handles keys. This is what keeps `npm test` able to
  prove things on Node 24.
- **Metadata-only is inherited, not re-enforced.** The banned-key walk at `emit()`
  guarantees there is nothing sensitive to render; the TUI never attempts to show
  document content because none exists on the wire.

### New files

| File | Imports OpenTUI? | Runs on Node 24? | Purpose |
|---|---|---|---|
| `src/tui/state.ts` | no | yes | Pure reducer: `applyEvent(state, ActivityEvent) → state` |
| `src/tui/sse.ts` | no | yes | SSE client on `undici` (already a dep): parse frames, dedup by `seq`, tolerate seq gaps, ignore `:ok`/`: ping` comments, resume with `Last-Event-ID`, backoff reconnect, refuse on `activitySpec !== ACTIVITY_SPEC` (per spec: drop the connection) |
| `src/tui/app.ts` | **yes** (dynamic import) | no | Layout, panels, keybindings; subscribes to state changes |
| `src/tui.ts` | indirectly | guard first | Entry: parse `--url` (default `http://127.0.0.1:${PORT ?? 3000}`), runtime probe, then `await import('./tui/app.ts')` |

The runtime probe in `src/tui.ts` checks Node ≥ 26.4 + FFI flag (or Bun ≥ 1.3) and
otherwise exits with one clear line:
`tui: needs Node ≥ 26.4 with --experimental-ffi, or Bun ≥ 1.3 — the rest of the harness runs fine on Node 24`.
Dynamic import is load-bearing: a static import of `@opentui/core` would make even
`node src/tui.ts --help` fail on Node 24, and `process.env.OPENTUI_LIBC` must be set
before the first Core import per the runtime docs.

### What "project state" is (the reducer's output)

All of it is just correlation over the existing catalogue — no new event kinds:

- **Profiles**: `profile.loaded` (name, mode, url, pack), seeded from `GET /health`.
- **Models**: `model.identified` keyed by `baseUrl` → served model id, ctx, slots, or
  `identified:false`.
- **Runs**: `run.started`/`run.completed`/`run.failed` by `runId` → profile, status,
  wallMs, inputChars, digest; rolling counts and failure rate.
- **LLM**: `llm.request`→`llm.response`/`llm.error` by `requestId` → label,
  constrained, wallMs, tokens; derived tok/s, in-flight age, cache-hit ratio from
  `cachedTokens`.
- **Pipelines**: step table from `pipeline.*`, including the handoff edge on
  `step.started` (`input: { ref, field, fromProfile }`).
- **Sessions**: `session.*`/`turn.*` → turns, last stop reason, tools used, usage.
- **Stage tree**: `stage` events assembled by `stageId`/`parentId` per `runId` (the
  clinical profile emits these; the view is generic name/status/wallMs — no clinical
  concept is named, keeping rule 4).
- **HTTP log** and a rolling **raw event log**; connection status (`live` /
  `reconnecting` / `refused: activitySpec 2`).

### UI sketch (`@opentui/core`, imperative — no React/Solid, matching the repo's minimal-dep ethos)

```
┌ alkor 127.0.0.1:3000 ● live ─ Qwen3-4B-Q4_K_M ctx 32768 slots 1 ──────┐
│ Profiles        │ Runs (recent)         │ LLM requests                      │
│  clinical extr  │  #41 clinical ✓ 1.2s  │  vital-signs     ✓ 812ms 412→96t  │
│  router    rout │  #42 clinical ✗ 0.4s  │  shock-classif   … 3.1s in flight │
├ Pipeline / Sessions / Stage tree (tabbed) ─────────────────────────────────┤
│ Event log (ScrollBox, colored by kind, / filter, ↑↓ scroll, q quit)        │
└─────────────────────────────────────────────────────────────────────────────┘
```

`createCliRenderer({ exitOnCtrlC: true })`, `Box`/`Text` flexbox panels, `ScrollBox`
for the log, keypress handling for filter/scroll/quit.

## 2. Work steps

1. **Deps & wiring** — add `@opentui/core` to `optionalDependencies` (install
   tolerated-but-not-required, so `npm ci` on Node 24 never hard-fails; the entry guard
   explains what's missing); add `"tui": "node --experimental-ffi src/tui.ts"` script
   and `"alkor-tui": "./src/tui.ts"` bin, mirroring `alkor-server`. Note:
   install pulls the platform native package (`@opentui/core-linux-x64` here) as an
   optional dep.
2. **`src/tui/state.ts` + `test/tui-state.test.ts`** — reducer first. Tests synthesize
   every event kind and must be able to fail: unpaired `llm.request` stays in-flight,
   `run.failed` increments failures, out-of-order `llm.response`-before-`request` is
   tolerated, duplicate `seq` is ignored, unknown `activitySpec` is surfaced as
   refusal, `stage` orphans attach to a synthetic root.
3. **`src/tui/sse.ts` + `test/tui-sse.test.ts`** — test against an in-process
   `createServer()` exactly as `test/server-activity.test.ts` does: replay burst on
   connect, `Last-Event-ID` skips replay, heartbeats ignored, kill the server →
   reconnect → resume without duplicates. No model, no pack.
4. **`src/tui/app.ts` + `src/tui.ts`** — the only OpenTUI-aware code; kept thin. Manual
   verification against `npm run server` with a stub llama-server (reuse the stub
   pattern from `test/server-activity.test.ts` to drive run/pipeline/session traffic).
5. **Docs** — README section (how to run:
   `node --experimental-ffi src/tui.ts --url …`, runtime prerequisite stated plainly);
   update `AGENTS.md` structure list with `src/tui/` and the rule that only `app.ts`
   may import OpenTUI and nothing in `npm test` may require FFI.

## 3. Test & verification rule

`npm run check` must stay green on Node 24 with zero FFI: `state.ts` and `sse.ts` carry
all logic and are unit-tested; `app.ts` is exercised manually. This extends the
existing rule — nothing in `npm test` needs a model, a server, a private pack, **or a
native renderer**.

## 4. Risks / open decision

- **Runtime choice**: recommended is Node ≥ 26.4 + `--experimental-ffi` (stays on the
  repo's runtime; one npm script) over Bun (second runtime to install). If a newer Node
  is not acceptable, the same entry runs under Bun 1.3+ with no code changes — step 1
  adjusts.
- **Observed, not in scope**: the server has a small replay seam in `GET /events` — an
  event emitted between the `activity.recent()` snapshot and `sseClients.add(res)` is
  missed for that client. The client tolerates the resulting `seq` gap; fixing the
  server (subscribe before snapshot) is a 3-line change if wanted.
- Node 26.4's `--experimental-ffi` is exactly that — experimental; the guard message
  must tell the user precisely what to do when the flag or version is missing.
