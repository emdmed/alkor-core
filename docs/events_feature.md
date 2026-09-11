# Feature: server activity feed (`src/core/activity.ts` + `GET /events`)

Status: planned. Decisions confirmed with the user.

## Goal

Every meaningful thing that happens inside the medextract server — profile loads, model
identification, prompt dispatched → processing → completion, router decisions, pipeline
handoffs, session turns, tool calls — is emitted as a structured event on an in-process bus,
and streamed live over `GET /events` (SSE) for a future real-time dashboard.

The headline use case: **display how data flows through the pipelines and where it is
routed**, e.g.

```
initial prompt → shock suspicion evaluator → shock gateway → shock classification
```

in enough detail to see the route taken, the deterministic gates, and which model pass ran
at each stage.

## Non-goals (phase 1)

- No persistence / journal across restarts.
- No prompt/completion/note **content** in events (metadata only — see below).
- No llama-server process lifecycle (model-manager stays out; the medextract server cannot
  see those processes boot).
- No control channel (no pause/cancel/approve over the wire).
- No token-level streaming.

## The one hard rule: metadata-only by construction

This codebase already has a content-bearing observability system — `Trace` (`core/trace.ts`)
— and it is the wrong shape for this feature on purpose: it holds raw prompts and
completions (PHI-adjacent, redactor-gated, written to disk outside the repo). Broadcasting
that over HTTP is the one unacceptable failure mode from `AGENTS.md` rule 1.

The activity feed enforces the opposite **by design, not policy**:

- `ActivityEvent` is a discriminated union whose fields are only: kinds, profile names,
  labels, URLs, durations, token counts, stop reasons, digests. There is no
  `content`/`prompt`/`completion`/`text`/`messages`/`note`/`document` field to fill in.
- `emit()` runs a recursive banned-key check over the whole event — including inside
  `stage.detail` — and **throws** on violation. A content leak fails loud at the source, in
  a test, not on someone's dashboard.
- Correlation with content uses the existing `elide` scheme from
  `profiles/clinical/redact.ts` (`[redacted N chars, sha256:…]` / digest + length), so a
  dashboard can say "same document as run #3" without holding the document.
- Error text only from the transport/wiring layers (`ChatError`, `ConfigError` —
  operational messages), truncated; never from parse/scoring layers, where messages quote
  completion prefixes (which is exactly why `redact.ts` lists `error` as a content field).
- A test walks every event the suite emits and asserts the invariant.
- Because there is nothing to redact, the feed needs **no redactor hook**.

## Decisions (confirmed)

1. **Content policy** — metadata-only by construction (recommended option).
2. **Scope** — harness activity only; llama-server lifecycle out of scope.
3. **Wire transport** — SSE via `GET /events`; no new dependencies.
4. **`stage.detail` shape** — closed scalar union (option 1), NOT a free
   `Record<string, unknown>`. Numbers, rule names, confidences, and the handoff edge are
   allowed; prose is not representable. This keeps the metadata-only guarantee true by
   construction rather than trust-based.

## Event catalogue (domain-free — core names no domain)

Every event: `{ activitySpec: 1, seq, ts, kind, … }` plus correlation ids when in scope
(`runId`, `sessionId`, `requestId`). `activitySpec` mirrors `TRACE_SPEC`'s reasoning: the
unit of the stream is the event, and a reader must be able to refuse a future shape.

| Need | Events |
|---|---|
| "which model has started" | `server.ready`, `profile.loaded` (name, mode, url, pack), `model.identified` (baseUrl → served model id, ctx, slots — or `identified:false`; resolved once per baseUrl via `identifyServer`, best-effort as today) |
| "prompt is being processed" | `llm.request` (requestId, label, baseUrl, model?, constrained, message count) → `llm.response` (wallMs, timings: prompt/predicted/cached tokens, finishReason, chunks) or `llm.error` (wallMs, message, truncated) |
| "model picks up a message left by another" | `pipeline.step.started` carries the edge `{ step, name, profile, input:{ ref:'step-1', field:'report', fromProfile:'clinical' } }` |
| HTTP envelope | `http.request` / `http.completed` |
| routing | `route.decided` (profile, confidence, reason, rule-vs-model) |
| run lifecycle | `run.started` / `run.completed` / `run.failed` (inputChars + digest) |
| pipeline | `pipeline.started` / `pipeline.step.started` / `pipeline.step.completed` / `pipeline.completed` |
| sessions | `session.created` / `turn.started` / `turn.completed` (stop, steps, toolsUsed, usage) / `destroyed` |
| tools | `tool.called` / `tool.completed` / `tool.declined` |
| **intra-profile flow** | **`stage`** — see below |

## The `stage` event (the addition that shows the clinical flow)

The headline example is **not** the pipeline mode's steps — it is a second routing layer
inside the clinical profile's `review()`. A shock-suspicious note actually travels:

```
POST /run { profile:'clinical-verified' }
  L1 · pipeline.mode steps            extract → verify                (runPipeline, core)
  L2 · inside the 'extract' step, clinical.profile.review():
        routeClinicalShape(text) → shape:'shock-suspicion' (rule-based, NO model)
        task = shock-extraction
          reviewShockExtraction()
            llm pass 1  EXTRACT: note → ShockExam JSON        ← "suspicion evaluator"
            confirmShock(exam) → shock GATEWAY (deterministic, NO model)
              confirmed → reviewShock()
                llm pass 2  CLASSIFY: exam → category          ← "shock classification"
```

The gateway (`confirmShock`) and the shape router (`routeClinicalShape`) are deterministic —
no model call — so the provider wrapper never sees them. A dashboard fed only by the basic
catalogue would show one opaque `extract` step, not the three-stage flow. So core gains a
generic `stage` envelope:

```ts
// core — envelope only, NO vocabulary. The profile supplies `name` and `detail`.
interface StageEvent {
  kind: 'stage'
  name: string                 // 'route' | 'shock-extraction' | 'gateway' | 'shock-classification' | …
  status: 'started' | 'completed'
  detail?: StageDetail
  wallMs?: number
  runId?: string
  stageId?: string
  parentId?: string            // the tree edge
}

// Closed union — a BP value or a rule name can appear; prose cannot.
type StageDetail =
  | string | number | boolean | null
  | { from: string; to: string; via: string; confirmed?: boolean }
  | Record<string, string | number | boolean | null>
```

### Correlation tree

`withActivityScope({ runId, stageId, parentId? }, fn)` in `AsyncLocalStorage`. Modes and
profiles open a child scope per stage; `emit` stamps the chain. A flat `runId` cannot
express "pass 2 happened because of the gateway, inside the extract step, inside pipeline
run N" — the `parentId`/`stagePath` chain is what the dashboard renders as a tree.

### Resulting sequence for a shock-suspicious note

```
pipeline.step.started   { name:'extract', profile:'clinical' }
  stage  route                    { shape:'shock-suspicion', confidence:0.92 }      (no llm)
  stage  shock-extraction  started
    llm.request / llm.response    { label:'shock-extraction' }                      ← evaluator
  stage  shock-extraction  completed
  stage  gateway           completed { via:'confirmShock', confirmed:true,
                                       systolic:78, shockIndex:0.84 }              (no llm)
  stage  shock-classification started
    llm.request / llm.response    { label:'shock' }                                 ← classification
  stage  shock-classification completed
pipeline.step.completed
```

A vitals note instead routes to `vital-signs` → one `llm.request`, so the dashboard shows a
genuinely different flow shape per input.

## Plumbing — minimal intrusion, following the `trace` pattern

1. **Model traffic: one wrapper, zero mode changes.** `withActivity(provider, activity)` in
   core wraps the `Provider` interface (`chat`, `toolChat`, `streamChat`) and emits `llm.*`.
   The server wraps `defaultProvider` once; every mode's model calls are captured.
   **`client.ts` is not touched** — the pinned request bodies stay byte-identical (the same
   property `onMetrics` was designed under). A test asserts pass-through byte equality.
2. **Correlation without signature churn.** The wrapper is created once but `runId` is
   per-request, so core holds an `AsyncLocalStorage` scope. The server request handler wraps
   its work in `withActivityScope({ runId, sessionId? }, …)`; emit stamps whatever is in
   scope. Events outside a scope simply lack the id.
3. **Mode seams only where a hook doesn't already exist:**
   - `session.ts`: **no change** — the server already passes `onToolCall`/`onToolResult` and
     wraps `send()`.
   - `router.ts`: **no change** — the server wraps `route()`; `RouteResult` has everything.
   - `pipeline.ts`: `PipelineOptions.activity?` → step/handoff events (CLI runs get them
     too).
   - `agentic.ts`: `AgenticOptions.activity?` → tool events beside the existing
     `trace.write`.
   - `server.ts`: bus, wrapped provider, ALS scope, `http.*`/`run.*`/`route.*`/`session.*`,
     `GET /events`.
   - `profiles/clinical`: `stage` emissions in `profile.ts` (the internal route),
     `review-shock-extraction.ts` (the gateway), `review-shock.ts` (classification).

## The bus

```ts
export const ACTIVITY_SPEC = 1
export interface Activity {
  emit(e: ActivityInput): void          // stamps activitySpec, ts, seq; enforces metadata-only
  subscribe(fn: (e: ActivityEvent) => void): () => void
  recent(n?: number): ActivityEvent[]   // ring buffer, default 1000
}
createActivity({ buffer?: number })
nullActivity()                          // same role as nullTrace()
withActivity(provider, activity): Provider
withActivityScope(ids, fn)
```

No dependencies — a subscriber set and a ring buffer, hand-rolled in the codebase's style.

## The wire: `GET /events` (SSE)

- `Content-Type: text/event-stream`; one frame per event:
  `id: <seq>` + `event: <kind>` + `data: <json>`. Named events so the dashboard can
  `addEventListener('pipeline.step.started', …)`.
- On connect, replay the ring buffer, then live events; `Last-Event-ID` resumes from `seq`
  (EventSource sends it for free on reconnect).
- `: ping` heartbeat every 15s so "quiet" is distinguishable from "dead".
- Slow client never slows the harness: bounded per-client buffer; on overflow, end that
  response — the client reconnects and replays.
- `GET /health` gains `{ activity: { buffered, subscribers } }`.
- Server stays on `127.0.0.1`; the metadata-only posture is what makes the feed safe to
  expose — restate this if binding ever widens.

## Tests (all model-free, per repo rules)

- `test/activity.test.ts` — bus: stamping, seq monotonicity, subscribe/unsubscribe, ring
  eviction, `nullActivity`, and the **metadata-only invariant** (banned-key walk over every
  emitted event, including inside `stage.detail`).
- `test/activity-provider.test.ts` — fake `Provider`: correct events, and the wrapped
  provider receives **byte-identical options** (the pin).
- `test/server-activity.test.ts` — the `server.test.ts` pattern (real server + stub
  llama-server): drive `/route`, `/run` (router needs no model), session send; assert the
  ordered stream `http.request → run.started → llm.request → llm.response → run.completed`,
  the pipeline handoff edge naming from→to, the clinical `stage` tree, SSE framing, buffer
  replay, `Last-Event-ID` resume.
- `test/package.test.ts` — add the new exports to `CONTRACT`.

## Docs and contract upkeep

- `spec/activity.md` — event catalogue, SSE framing, versioning rule (mirror of
  `spec/pack.md`).
- `AGENTS.md` — one line in the `src/core/` boundary bullet (activity: metadata-only
  operational events; content belongs to `Trace`) and one in conventions.
- `src/index.ts` exports; `server.ts` header endpoint list.

## Order of work

1. `core/activity.ts` + `test/activity.test.ts` (bus, union, `stage`, metadata-only walk,
   ALS).
2. Provider wrapper + `test/activity-provider.test.ts` (byte-identical pass-through).
3. `pipeline.ts` + `agentic.ts` activity params.
4. `server.ts` wiring + `GET /events` + `test/server-activity.test.ts`.
5. Clinical `stage` emissions (internal router + `review-shock-extraction` gateway +
   `review-shock`).
6. Exports, `package.test.ts`, `spec/activity.md`, `AGENTS.md`.

## Named follow-ups (not in this build)

- **Fidelity-eval visibility.** `--fidelity` (`src/profiles/clinical-verified/eval.ts`) runs the
  arms manually (`reviewVitalSigns`, `routeClinicalShape`, verifier calls) and bypasses both
  `runPipeline` and the wrapped provider, so it emits no `pipeline.*` or `llm.*` events.
  Cheap fix: thread the wrapped provider + activity into its review calls (gets `llm.*` per
  arm per case, still no `pipeline.*` framing). Real fix: make the pipeline wiring pass
  document + extraction to the verifier in the shape it expects so `--fidelity` can run
  through `runPipeline` as its own header intends.
- Journal to `${stateRoot()}/medextract/activity/` for cross-restart history.
- Standalone `dashboard.html` consuming `GET /events` (no-build, `report.html` pattern).
- `medprotocol` subprocess as its own `stage`.
