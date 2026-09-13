# Activity event format

The activity feed is an in-process bus of metadata-only operational events, exposed live over `GET /events` (SSE). Every event carries `activitySpec`, `seq`, `ts`, `kind`, and `instanceId`.

## Versioning

`activitySpec` mirrors `traceSpec`: the unit of the stream is the event, and a reader must be able to refuse a future shape. A consumer that does not recognise the `activitySpec` version should drop the connection rather than parse events it cannot trust.

Current value: `2` (`ACTIVITY_SPEC`). Spec 2 renamed the `pipeline.*` event kinds to `workflow.*` and `turn.completed.steps` to `iterations`; see `spec/nomenclature.md`.

## Stream identity: `instanceId`

`seq` is monotonic **within one bus**, i.e. within one server process. A restarted server counts from 1 again, so a watermark held as a bare `seq` rejects the entire new stream as already-seen — silently, while the connection still reports itself live. `instanceId` (a fresh id per `createActivity`) is what makes the watermark a `(instanceId, seq)` pair.

Rules for a reader:

- Dedup and gap tolerance apply only while `instanceId` is unchanged.
- A changed `instanceId` resets the watermark and invalidates everything derived from the old stream. Ids that fall back to `seq` — notably the reducer's `stage-${seq}` — would otherwise collide across processes and fuse unrelated nodes, so run history from the previous instance is dropped rather than merged.
- The field is optional on the wire: a stream that omits it is judged on `seq` alone, exactly as before it existed.
- `GET /health` reports the same value as `activity.instance`, so a poller can see a restart without waiting for an event.

## Event catalogue

| Need | Events |
|---|---|
| "which model has started" | `server.ready`, `profile.loaded` (name, mode, url, pack), `model.identified` (baseUrl → served model id, ctx, slots — or `identified:false`) |
| "managed backend spawned or stopped" | `model.lifecycle` (baseUrl, state `starting`/`ready`/`stopped`/`failed`, pid?, model?, reason? idle/shutdown, error?, wallMs?) — emitted only for backends the interactive server manages on demand |
| "prompt is being processed" | `llm.request` (requestId, label, baseUrl, model?, constrained, message count) → `llm.response` (wallMs, prompt/predicted/cached tokens, finishReason, chunks) or `llm.error` (wallMs, message, truncated); the call also paints a `stage` `llm-call` node sharing the request id |
| "a workflow is running as a tree of decisions" | `stage` `workflow` root, one `<step name>` stage per step under it, and the step's internal `prompt-assembly` / `llm-call` / `parse` / `verify` stages nested beneath |
| "model picks up a message left by another" | `workflow.step.started` carries the edge `{ step, name, profile, input:{ ref:'step-1', field:'report', fromProfile:'clinical' } }` |
| HTTP envelope | `http.request` / `http.completed` |
| routing | `route.decided` (profile, confidence, reason, rule-vs-model) |
| run lifecycle | `run.started` / `run.completed` / `run.failed` (inputChars + digest; `run.started` also carries `trace`, the path the run is being recorded to, or `(not recorded)`) |
| workflow | `workflow.started` / `workflow.step.started` / `workflow.step.completed` / `workflow.completed` |
| sessions | `session.created` / `turn.started` / `turn.completed` (stop, iterations, toolsUsed, usage) / `session.destroyed` |
| tools | `tool.called` / `tool.completed` / `tool.declined` |
| intra-profile flow | `stage` — see below |

## The `stage` event

Core provides the envelope; the harness and the profile supply `name` and `detail`.

```ts
interface StageEvent {
  kind: 'stage'
  name: string
  status: 'started' | 'completed'
  detail?: StageDetail
  wallMs?: number
  operation?: 'model' | 'code' | 'orchestrator' | 'decision'
  runId?: string
  stageId?: string
  parentId?: string
}
```

`detail` is a closed scalar union: `string | number | boolean | null | { from, to, via, confirmed? } | Record<string, string | number | boolean | null>`. Prose is not representable.

### `operation`: what performs the stage

The one fact a view cannot infer from a name. `verify` and `gateway` are arithmetic, `medication-pass` is a second model call, and nothing about either word says so — a dashboard that wants to draw model boundaries otherwise has to keep its own list of every stage name any profile has ever emitted, which goes stale the moment a profile adds a pass.

Optional, and additive rather than a spec bump: a stream that omits it is valid, and a view falls back to whatever it inferred before. Emitters that know should say. It is a property of the STAGE, not of the event, so a `completed` that omits it must not erase what the `started` declared.

The same field appears on `ProfileTopologyStage`, so a dashboard knows the answer for a profile's whole shape before a run starts.

### Node identity and pairing

A stage is one NODE in a run's decision tree, not one event: a `started`/`completed` pair must share a `stageId`. Emitters call `nextStageId()` once and stamp both events with it; the reducer then merges the pair into a single node. An emitter that omits `stageId` is still accepted — the reducer falls back to `stage-${seq}` — but that silently un-pairs a start and finish into two nodes, which is why every pair in the harness names an id.

`parentId` decides the tree shape and is stamped by the scope: `withActivityScope({ parentId, runId })` makes every event emitted inside the callback carry the chain. Emitters may also set `parentId` on the event itself. A stage with no `parentId` is a root of its run.

### Harness-emitted stages

Core and the modes paint the generic stages a decision tree is built from; a profile paints only what is its own.

| Stage | Emitted by | `operation` | `detail` |
|---|---|---|---|
| `workflow` | `workflow.ts` | `orchestrator` | `{ steps }` · `{ stoppedEarly }`; the root of a workflow run, with each step a child |
| `<step name>` | `workflow.ts` | `orchestrator` | `{ step, profile, input: { ref, field, fromProfile } }` · `{ step, ok }`; one per step, under the workflow root, and every sub-emission from the step's own mode nests beneath it |
| `prompt-assembly` | `extract.ts` | `code` | `{ constrained, messageCount, promptChars, documentChars, maxTokens? }` — the assembled request crossed into the transport |
| `llm-call` | `withActivity` | `model` | `{ label, constrained }` · `{ ok }`; shares the request's id, so a dashboard joins the node to the `llm.request`/`llm.response` record |
| `parse` | `extract.ts` | `code` | `{ ok }` · `{ ok: false, reason? }` — the completion's parse attempt |
| `verify` | clinical reviews, verifier profile | `code` | the provenance verdicts: `{ ok, read, quoted, unverified }`, `{ ok, items, quotesVerified, quotesAbsent, derivationsOk, repaired }`, or the verifier's `{ ok, verified, issues, confidence }` |
| `route` | router profile | `decision` | `{ profile, confidence, reason }` — the run's first branch |
| `shock-classification`, `shock-extraction`, `medication-pass`, `transcript-repair` | clinical reviews | `model` | brackets around a model pass; the bracket carries the operation, not the anonymous `llm-call` under it |
| `gateway` | clinical extraction reviews | `code` | `{ via, ... }` — the deterministic rule check over an extracted payload |

A single `completed` emission (no `started` pair) is valid for a leaf decision — `verify` on the verifier, `route`, `gateway` — and renders as a finished node.

## SSE framing (`GET /events`)

- `Content-Type: text/event-stream`
- One frame per event: `id: <seq>` + `event: <kind>` + `data: <json>`
- On connect, replay the ring buffer, then live events
- `Last-Event-ID` resumes from `seq`, paired with `X-Activity-Instance` (`ACTIVITY_INSTANCE_HEADER`) naming the instance that seq belongs to. A seq from a *different* instance is discarded and the whole buffer is replayed, because it says nothing about what this process has sent; an unparseable value likewise replays everything rather than suppressing the replay. A client that names no instance — a bare `EventSource`, which cannot set headers — is taken at its word.
- `: ping` heartbeat every 15s. It is there to be *measured*: a reader with no traffic for a few ping intervals drops the connection and reconnects, since a half-open socket is otherwise indistinguishable from a quiet server. Both shipped clients use a 45s idle timeout.
- A client that stops reading is bounded, not accommodated: past 1 MiB queued for that response the server ends it, and the client recovers through the ordinary reconnect-and-replay path.
- The `http.request`/`http.completed` envelope for `/events` itself closes when the *stream* does, so its `wallMs` is how long the feed was held open.
- The server writes `id`/`event`/`data` with `: ` and LF terminators, but a reader parses the SSE grammar: optional space after the colon, CR / LF / CRLF terminators, repeated `data:` lines joined with newlines. A parser that only understands this server's exact bytes breaks on whatever ends up sitting between the two.
- Closing the server ends attached streams. `close()` waits for open connections and an SSE stream never ends on its own, so the feeds are part of what gets closed; clients reconnect when the server returns.

## Metadata-only rule

`ActivityEvent` is a discriminated union whose fields are only kinds, names, labels, URLs, durations, token counts, stop reasons, and digests. There is no `content`/`prompt`/`completion`/`text`/`messages`/`note`/`document` field. `emit()` runs a recursive banned-key walk over the whole event and throws on violation. A content leak fails loud at the source, in a test, not on a dashboard.

Correlation with content uses the existing `elide` scheme (`[redacted N chars, sha256:…]`), so a dashboard can say "same document as run #3" without holding the document.

Because there is nothing to redact, the feed needs no redactor hook.
