# Reference

Two things you do not need to run anything, and will want as soon as you read the code or
write a profile: the vocabulary, and where everything lives.

### Nomenclature

One word per level, and one level per word. `spec/nomenclature.md` is the arbiter — a name
that contradicts it is a bug, in code or in prose. The short version:

| Term | Is | Where it lives |
|---|---|---|
| **Run** | one end-to-end execution for one input, carrying a `runId` | `run.started` / `run.completed` / `run.failed` |
| **Pipeline** | the deployment's front door: a router, the catalogue of workflows it may select, and a default. **Exactly one per deployment** | `[pipeline]` in `profiles.toml`, `POST /pipeline` |
| **Workflow** | one selectable recipe: an ordered list of steps. A *processing shape* | `mode = "workflow"` profiles, `src/modes/workflow.ts` |
| **Step** | one entry in a workflow. Names a profile and what it reads | `steps = [...]`, `step-N` context keys |
| **Assessment** | the run's ending: what it established about this input, rendered for a person | `final = true` in `steps`, `src/profiles/clinical-assessment/` |
| **Profile** | what a step invokes: a name, a mode, a pack, a server | `profiles.toml`, `ProfileModule` |
| **Task** | a profile-internal choice of contract (`vital-signs`, `transcript`, `shock`) | `src/profiles/clinical/contracts.ts` |
| **Pass** | one model call or one deterministic code sweep a task makes | `TASK_PASSES` |

Each level is contained by the one above: a run executes one pipeline decision and then one
workflow; a workflow has steps; a step runs one profile; a profile picks a task; a task makes
passes.

**Stage is not a level.** It is the observability name for a unit of work at *any* level —
`runWorkflow` emits a stage named `workflow`, each step emits a stage, and `extract()` emits
`prompt-assembly → llm-call → parse` beneath it. They are nodes in one tree joined by
`stageId`/`parentId`. What distinguishes them is `operation` (`model`, `code`,
`orchestrator`, `decision`), not the name — a view must read that field rather than keep a
list of stage names, which goes stale the moment a profile adds a pass.

Words with exactly one meaning:

- **Router** — the thing that chooses. Never `gateway`.
- **Gateway** — the clinical profile's deterministic rule check over an extracted payload. Never a router.
- **Gate** — a code pass that can **stop the run**, as distinct from a verify pass that annotates and lets it continue.
- **Iteration** — one turn of the agentic tool-calling loop (`maxIterations`). Not a *step*.
- **Context** — the state carried between steps and persisted as `context.json`. Not `state`, not `checkpoint`.
- **Mode** — the execution shape a profile declares: `extract`, `agentic`, `router`, `code`, `workflow`. Eval is a *command*, not a mode.
- **Code** (as a mode) — a profile that calls no model, reading structures other steps produced. Not a `router`: it chooses nothing.

One exception, deliberate: the clinical task **`shock-pipeline`** is not a pipeline. It is two
tasks chained under one `--task` flag, and the name survives because it is public surface — a
`--task` value, a pack data key, a row in the eval tables. Read it as a fixed proper noun.

`mode = "pipeline"` and the `alkor pipeline` command are still accepted as retired
spellings of `workflow`, resolved at the edge so exactly one spelling exists downstream. The
activity event kinds were renamed with them (`pipeline.*` → `workflow.*`), which is a wire
change: `ACTIVITY_SPEC` is `2`.

### Layout

```
src/core/     config.ts    profiles.toml — which profiles exist, and what each reads
              pack.ts      contract packs: a manifest-described directory of contracts
              profile.ts   what a profile must expose; resolved by dynamic import
              client.ts    llama-server transport: chat(), toolChat(), streamChat()
                           pinned request body (seed, temperature 0, cache_prompt)
                           --constrain compiles JSON Schema into GBNF grammar
                           one retry on transport failures, none on parse failures
              llama-manager.ts  on-demand llama-server lifecycle: spawn, idle sweep,
                           in-flight protection; used only by the interactive server
              tools.ts     the tool CONTRACT — core defines no tools
              trace.ts     JSONL tracing with a per-profile redaction hook
              bench.ts     what a run cost, from the graded pass itself
              verify.ts    quote verification (literal containment) and
                           deletion-only derivation (word subsequence)
              assemble.ts  many documents into the one message a task actually sends
src/modes/    extract.ts   single-shot constrained extraction; one retry, transport only
              agentic.ts   the tool loop, for one task run to completion
              session.ts   the same loop, multi-turn, with a consent gate
              router.ts    rule-based intent routing (clinical / transcriptor / verifier)
              workflow.ts  generic multi-profile orchestration
src/profiles/ clinical/    the reference profile: nine tasks, names no vital sign
                           settings.ts  what the pack declares, and the refusals that make
                                        a declaration worth trusting
                           contracts.ts what one pass SENDS: prompt, schema, cap, routing
                           cases.ts     what the reply is graded against: the answer keys
                           review.ts    one note in, one reading out, provenance checked
                           eval.ts      vital signs over the corpus, scored and gated
                           set-eval.ts  summary, note-format, transcript: set extraction, cited
                           clinical-router.ts  shape-based routing inside clinical (exam-json, qsofa-json, shock/sepsis suspicion, vitals-note, note)
                           vitals-first.ts  the front door: read the vitals, run the CLI, then route
                           shock.ts     shock-category classification with rule-based reference arm
                           router-eval.ts   90-case confusion-matrix eval for the clinical router
                           syndrome-routing-eval.ts  does a note reach shock, sepsis, or both arms
                           shock-eval.ts    20-case eval for shock category
                           review-note-format.ts   post-processing for note-format
                           review-shock.ts       post-processing for shock
              router/      the top-level router profile: rule-based + model fallback
              verifier/    the verification specialist: checks extraction for hallucinations
              clinical-verified/   the verified workflow: extract → verify
packs/        clinical/    the reference pack — 16 prompts, 10 schemas + goldens,
                           62 notes, 20 transcripts, 34 exam payloads
              verifier/    the verifier contract pack (prompt + system + schema; its
                           cases live in src/profiles/verifier/eval.ts)
scripts/      model-manager.ts   start/stop/status llama-server per profile
              llama-server.sh    start one server with the flags that are easy to get wrong
src/index.ts  the public API — what a profile is written against
src/server.ts the interactive HTTP server: POST /pipeline, GET /events (SSE),
              GET /corpus (the packs' source documents, for driving a run by hand),
              GET /runs (what has been recorded), on-demand model lifecycle
              via LlamaManager
src/core/corpus.ts
              the pack corpus enumerated for a reader, not for a run — reads here
              stay out of the pack's digest so browsing cannot enter a run's record
src/core/runs.ts
              the index over the trace directory: what has run, when, and how it
              ended. Reads the traces and nothing else — a second record of what
              ran is a second record that can disagree with the first
src/monitor/  state.ts     pure reducer over the activity event stream (tested, Node 24)
              sse-core.ts  transport-agnostic SSE core — frames, dedup, refusal (tested, Node 24)
              source.ts    pure transitions for which backend owns the dashboard;
                           a source change resets state so no payload crosses origins
web/          the browser dashboard (own Vite + React app) over that core
src/cli.ts    extract, eval, agent, route, workflow, profiles
profiles.toml the only file that may name a project outside this repository
```

The swappable unit is the **execution mode**, not the toolset:

- **`extract`** — single-shot constrained output over one document. No tool loop.
- **`agentic`** — a tool-calling loop; termination is an explicit `done` tool call.
- **`session`** — multi-turn conversation with tools, streaming, consent gates for
  mutating operations, and abort support.
- **`router`** — rule-based classification with an optional model fallback.
- **`workflow`** — multi-model orchestration: chain profiles, pass outputs between steps.

Extraction and agentic work are different shapes. Forcing extraction into an agent loop
would be slower, less reliable, and much harder to validate.
