# Running

```bash
npm test                # unit tests; pack-dependent tests SKIP when no pack is on disk
npm run typecheck       # tsc --noEmit; Node strips types, so this is the real check
npm run check           # npm test && npm run typecheck — what CI runs
npm run profiles        # what is configured

# what this machine is still missing: engine, weights, server
node src/cli.ts doctor --profile clinical

# start a server yourself — its flags are part of the measurement
LLAMA_PORT=8081 LLAMA_MODEL=~/models/gemma-4-E4B-it-Q4_0.gguf scripts/llama-server.sh -ngl 99

# single-note extraction
node src/cli.ts extract --profile clinical --note ward-round.txt --constrain

# multi-model orchestration
node src/cli.ts route    --profile router --input "dictated: BP 120/80, HR 72"
node src/cli.ts workflow --profile clinical-verified --input "ward-round.txt"

# model manager — start/stop/status per profile
node scripts/model-manager.ts status
```

### One command: `./start`

```bash
./start           # checks, then the server and the dashboard
./start --check   # the checks alone, nothing started
```

In order: Node ≥ 24, both dependency trees (`npm ci` when a lockfile is there, so a first run
does not rewrite it), `doctor --managed`, then the two ports, then the two processes. Each
step's failure is a sentence naming the next command, and nothing is started until every
check has passed — a half-started stack is the state this exists to prevent.

`PORT` moves the server off 3000, `WEB_PORT` moves the dashboard off 5173. The dashboard is
started with `--strictPort`, so it never drifts to another port and gets reported at an
address it is not on.

It starts the **interactive** server, which manages model lifecycles on demand: no model is
loaded when it comes up, and the first request through the dashboard spawns a backend —
including, on a cold machine, the ~4.6 GB download. `extract` and `eval` are unaffected and
still talk to a `llama-server` you started yourself, because a server's flags are part of a
measurement.

### Before the first run

`extract`, `eval`, `route` and `agent` all need a `llama-server` that this harness does not
start. On a fresh clone none of the three things they need is present, and the failure used
to arrive from the bottom of the transport as `fetch failed` — which reads the same whether
llama.cpp was never installed, the weights were never fetched, or the server is simply not
running. Those are three different next commands.

```bash
node src/cli.ts doctor                      # the defaults
node src/cli.ts doctor --profile clinical   # that profile's port, and its pack's declared model
```

```
llama-server  /usr/bin/llama-server
weights       not cached — gemma-4-E4B-it-Q4_0.gguf, ~4.6 GB, downloaded on first start
              looked in ~/.cache/llama.cpp
server        nothing listening at http://127.0.0.1:8081
```

It exits 0 when a run could reach a server and 1 when it could not. It installs nothing,
downloads nothing and starts nothing — a server's flags are part of a measurement, so it
prints the command rather than running it.

**Where it looks for the engine**, in order: `ALKOR_LLAMA_BIN`, then `PATH`, then the usual
build and install locations (`~/llama.cpp/build/bin/`, `/opt/homebrew/bin`, `/usr/local/bin`,
`/usr/bin`). A binary found off `PATH` is reported as found *and* flagged, because
`scripts/llama-server.sh` execs the bare name — "installed" and "the documented commands
work" are different claims. `ALKOR_LLAMA_BIN` is also what the interactive server spawns, so
the check and the run agree on which binary they mean.

**Where it looks for the weights**, most authoritative first:

1. `LLAMA_MODEL` — what someone launching by hand would pass.
2. The profile's `model` in `profiles.toml`, tilde-expanded exactly as the spawn expands it.
3. The llama.cpp cache directories — `LLAMA_CACHE`, then `$XDG_CACHE_HOME/llama.cpp`,
   `~/Library/Caches/llama.cpp`, `%LOCALAPPDATA%\llama.cpp` — matched by filename suffix,
   since llama.cpp decorates a cached download with the repo it came from.
4. `llama-server --cache-list`, asking the engine what it actually has. Last, because it
   costs a subprocess, and it is the only answer here rather than a guess about where an
   answer might be written. Matched on **repo *and* quantisation** — one repository publishes
   every quant, so `…-GGUF:Q8_0` does not satisfy a pack that pinned `Q4_0`. This is the same
   flag on `llama-cli` and `llama-server`; they share llama.cpp's argument parser, and the
   output is byte-identical, so neither binary is preferable.

`doctor` also asks `--list-devices`. When the engine reports none, it says so and drops
`-ngl 99` from the command it prints — on a CPU-only box that flag offloads nothing, and
suggesting it implies a run that is about to be fast. The pack's own
`[sampling.shock]` note records what that costs: a cold case measured 324 s, and every case
came back reading `cannot reach llama-server` — a deadline expiring, dressed as a server that
was down. Someone who has just cloned this cannot tell "slow" from "broken" without being
told. The `extract`/`eval` gate does not ask, because it would not print the answer.

When the file is found at a path but not at the declared `size_bytes`, that is reported as a
**size mismatch** rather than as absent: a half-finished download has a specific fix, and
calling it "missing" hides that the path was right. Weights found locally are started with
`LLAMA_MODEL=<path>`; `LLAMA_HF` is only ever suggested when nothing was found, because `-hf`
re-fetches into the engine's own cache.

The same check runs ahead of the verbs that need a server, so a run refuses in milliseconds
instead of reporting a transport failure per case. It refuses only on what it is certain of:

- **A reachable server passes outright.** Whatever is or is not on the local disk, a run
  pointed elsewhere with `--url` is never refused over a cache it was not going to read.
- **Uncached weights never refuse.** llama.cpp names a cached download its own way and `-hf`
  fetches on first use, so a miss changes the advice — expect a download, not a hang — rather
  than the outcome.
- `workflow` is exempt, because its steps each resolve their own backend. `eval --from-trace`
  is exempt because it contacts no server at all. `ALKOR_NO_PREFLIGHT=1` turns it off.

### Web dashboard (browser)

```bash
npm install --prefix web           # once
npm run web                        # dev server on http://localhost:5173
npm run web:build                  # static build to web/dist/
```

A React + Vite dashboard over the activity feed: live panels plus an inspector (sessions,
stage trees, tools, routes, HTTP traffic), an editable server URL, pause/resume, and a
filterable, click-to-inspect event log. It consumes the same `GET /events` SSE stream the
server already exposes — no in-process coupling, no additional API. The intelligence is
not in the app: the pure reducer in `src/monitor/state.ts` and the SSE core in
`src/monitor/sse-core.ts` are dependency-free and unit-tested on Node; the app supplies
only the transport (`fetch` + `ReadableStream`) and the paint.

The dashboard is cross-origin by definition, so the server answers CORS for **loopback
`Origin`s when an `Origin` header is present**; nothing else is granted by default. Set
`ALKOR_CORS` to a comma-separated allowlist to open it to specific other origins,
or `*` for an explicit blanket:

```bash
PORT=3000 ALKOR_CORS="http://192.168.1.20:5173" node src/server.ts
```

Point the dashboard at a different server with the URL field, or set
`VITE_ALKOR_URL` at build time. The wire carries only metadata-flowing event fields,
under the server's banned-key guarantee.

### Extracting from one note

```bash
node src/cli.ts extract --profile clinical --note ward-round.txt --constrain
node src/cli.ts extract --profile clinical --case vs-en-03-prose --constrain   # a note from the pack
cat note.txt | node src/cli.ts extract --profile clinical --note - --json | jq .
```

```
=== vital signs · ward-round.txt ===
model 'Qwen3-4B-Q4_K_M' · pack 'clinical' spec 3 · constrained · temp 0 · max_tokens 1024

blood_pressure       148/92 mmHg          quoted "BP 148/92 mmHg"
heart_rate           78 bpm               quoted "HR 78"
weight               —                    not in the note
oxygen_saturation    97 %                 UNVERIFIED — not a fragment of this note: "sats were 97%"

3 of 9 slots read · 2 quotes found in the document · 1 NOT verified — check it against the note
```

Three properties of that output are the point of the verb:

**Every slot is listed, including the empty ones.** A report of what was found reads as an
account of the note while being a list of the model's successes, and the slot a clinician
needs is the one nobody printed.

**Every reading is checked against the note it claims to come from.** The prompt's rule is
evidence-or-null, so each reading carries a quote, and the quote is looked for in the
document. This is the one check a grammar cannot perform — no JSON Schema keyword says
"substring of the prompt", and GBNF has no back-reference to the context — and it is what
catches a correct-looking number attached to a sentence nobody wrote. It runs without an
answer key, so it works on your notes and not only on the corpus.

**`UNVERIFIED` is not an error.** The run exits 0: the value may well be right, and what has
not been established is the evidence for it. Only a reply that produced no reading at all
exits nonzero.

`--json` puts the model's completion on stdout and everything else on stderr, so the verb
pipes into whatever would have consumed it. The completion is passed through unaltered
rather than re-serialized from the parsed shape — a parser keeps the fields it grades and
drops the rest, and handing you a tidied document no model emitted would defeat the purpose
of looking.

`--constrain` turns on grammar-constrained decoding for an `extract` profile. Run without
it to measure what the same prompt does unconstrained; the difference is usually the whole
argument for the schema.

### How an agentic run ends

`stop` is the outcome, and only `done` is success — the CLI exits nonzero for the rest.

| `stop` | Meaning |
|---|---|
| `done` | The model called the terminal tool. |
| `no_tool_call` | It answered in prose and kept doing so after a nudge. |
| `step_cap` | It kept acting and never finished. |
| `error` | The transport failed. |

`no_tool_call` is worth its own outcome because it is the common small-model failure: a 4B
model will edit the file correctly and then emit the literal text `done` rather than
calling `done`. One nudge recovers an accidental omission; a second identical reply means
it will not be recovered, so the loop stops instead of re-nudging until the iteration cap.

### Routing, pipeline and workflows

The product-level **pipeline** is the complete path from input to output, and there is
exactly one per deployment. Its router chooses one named **workflow**, and that workflow
supplies the step-by-step recipe. A step invokes a profile; users do not choose profiles or
workflows during a normal run. `POST /pipeline` performs routing and workflow execution under
one run id. Passing `workflow` is a diagnostic override that deliberately bypasses routing.

That run id is on the response — on the answer *and* on every refusal, including one raised
before the first step runs. It is what joins the value a caller holds to the activity events
that explain how it was produced, and it is how the dashboard assembles a run's log: the
error it saw, plus the events the feed carried while the run was in flight, as one block of
text you can copy out of the run panel.

### Recorded runs

A run through `POST /pipeline` or `POST /run` is written to a JSONL trace, in the same format
and the same directory the CLI verbs write to — `${XDG_STATE_HOME:-~/.local/state}/alkor/traces/<profile>/`,
outside any repository. The response carries `trace` beside `runId`, and `run.started` on the
activity feed carries it too: the feed is a ring buffer and the file is not, so a run that has
scrolled out of the dashboard is still on disk.

The server's own contribution to the file is an envelope — a `server-run` header and a
`server-result` footer, both metadata-only, a digest and a length rather than the document.
Everything between them is written by the profiles that ran, under the redaction hook each
one supplies. A workflow's trace composes the hooks of the workflow **and every step**, so a
workflow wrapper with no redactor of its own cannot write a step's raw completions to disk.

Two endpoints read them back:

```bash
curl -s localhost:3000/runs | jq '.runs[] | {runId, profile, startedAt, outcome}'
curl -s localhost:3000/runs/<runId> | jq '.events | length'
curl -s "localhost:3000/runs/<runId>?events=0"      # the verdict without the prompts
curl -s "localhost:3000/runs?profile=clinical-verified&limit=10"
```

A run is fetched by the id its caller was handed, or by the `<profile>/<stem>` id the listing
gives it — which is how a trace written by the CLI, with no run id in its name, is reachable
too. Ids are matched against the catalogue rather than joined onto a path, so the only readable
files are ones this harness wrote, and the match runs on names so a lookup opens one file
rather than the directory.

**The two routes are not the same kind of thing.** `/runs` is metadata — ids, times, outcomes
— and answers any loopback origin, which is what a dashboard's run history needs. `/runs/:id`
returns a trace's events, which is what the model was asked and what it answered; for an
extraction that answer quotes the document verbatim. A **browser page** must be named in
`ALKOR_TRACE_CORS` before it may read that:

```bash
ALKOR_TRACE_CORS=http://localhost:5173 npm run server
```

Without it a page gets 403 and the reason. A caller with no `Origin` header — curl, a script,
a cron job, all first-class callers here — is not a page and is unaffected. The distinction
matters because the loopback default is generous by design: *any* local dev server or app on
a localhost port is a loopback origin, and none of them is your dashboard. The activity feed
can be that generous because it is metadata-only by construction; a trace is not.

The redaction hook still stands behind this and elides completions for a pack that declares
its corpus real — but that hook was written to protect a file on your own machine, and only
one profile in this repository supplies one at all.

**An absent `outcome` is not a pass.** It means no footer was written: the run is in flight,
its process died, or a CLI verb wrote the trace and never had an envelope to close.

**`ok` means the run reached its end, and nothing stronger.** For a workflow it is
`!stoppedEarly`, and a step returning not-ok is what sets that — the same signal for a step
that broke and for a verifier that refused a quote. The workflow level does not distinguish
them, so a listing must not be read as an error rate. The distinction is a step-level fact,
recorded on the `workflow.step.completed` lines of the same trace.

`ALKOR_SERVER_TRACE=0` turns recording off for a deployment that wants the server to hold
nothing; `TRACE_DIR` moves the directory. `GET /runs` keeps working either way, because it
reads the directory rather than a memory of what this process ran.

### Stopping a run

A run stops when the caller's connection goes away — a closed tab, an interrupted curl — or
on request:

```bash
curl -s -XDELETE localhost:3000/run/<runId>
```

The `DELETE` answers the cancel, not the run: it says whether there was something in flight to
stop. The request that started the run is the one that carries its ending, and that ending is
**499** with `cancelled: true`. Not a 500, which would blame the harness for a button the
operator pressed, and not a 200, which would claim a result nobody produced. A run that has
already finished is a 404 — `GET /runs/:id` is where a finished run is looked up, and it
answers from a file rather than from this process's memory.

Cancellation reaches the model call through the **provider**, not through `ReviewContext`. That
is what makes an out-of-tree profile cancellable without having heard of cancellation: a
profile is stopped because of how it was called, not because it remembered to pass a signal on.
The workflow and agent loops check at their own boundaries too, which is what stops a cancel
landing during a code step from going unnoticed until the next model is loaded.

**The backend stops too.** llama.cpp cancels the task rather than finishing it into a closed
socket, so the cancel frees the machine and not just the caller — measured at 592% CPU during
generation, 1% within three seconds of the abort, with the aborted task stopping at 206 tokens
against a control's 2039. Conditions and the caveat in
[What a cancelled run stops](measured.md#what-a-cancelled-run-stops).

**What a cancel does not interrupt.** It takes effect at the next model call or step boundary,
and it cannot stop a profile's own work in between — a `code` step that sits in a loop for
thirty seconds without touching the provider will finish those thirty seconds, and the run is
recorded as cancelled when it does. This is a real limit and it is small in practice for the
reason the [Operating Context](../PRODUCT.md) gives: in `clinical-verified`, the two long
steps are model calls (19.5s and 8.1s) and the two code steps are 3ms and 1ms. A run is inside
a cancellable call for essentially all of its life. A profile that does heavy work of its own
between calls should take `signal` and check it.

A cancelled run is recorded as cancelled — `cancelled: true` and `cancelledBy` in the footer,
`outcome.cancelled` in a listing — and emits `run.cancelled` rather than `run.failed`. The
distinction is the point: the operator pressing stop says nothing about the model, and a
surface counting failures must be able to leave these out.

See [Nomenclature](reference.md#nomenclature) for how these words nest, and `spec/nomenclature.md` for
the full statement.

The generic **router mode** (`src/modes/router.ts`) is a rule-based classifier with an
optional model fallback. The deployed `workflow-router` uses it to choose a workflow. The
older `router` worked example still measures specialist classification, at 100% on the 32
adversarial cases it now carries, every one of them decided by a rule with no model call.
It is no longer the product front door. The 98.1% (53/54) in `scratch/next_steps.md` is the
historical figure for that arm, measured on a larger corpus that has since changed — read it
as the evidence the rules were built from, not as a current result.

The **clinical internal router** (`src/profiles/clinical/clinical-router.ts`) runs *before*
any GPU call, selecting the right sub-task (`vital-signs`, `shock`, `sepsis`, and the two
prose extractions that feed them) from what the document says: an exam or qSOFA payload,
shock or sepsis criteria in prose, vitals prose, or plain note. It is purely rule-based,
zero GPU cost, and measured at 100% on 90 cases — every shape at 100% precision and recall,
against a 95% accuracy floor.

It routes **clinical questions only**. `transcript`, `note-format` and `summary` are document
tooling — transcribing, laying out, summarising — and none of them names a syndrome or decides
a diagnosis, so the router cannot select them: they are asked for by name (`--task transcript`)
and graded by `--task all` like every other contract. A consultation is therefore routed by
what it says, not by being a conversation.

Each **workflow recipe** is a `mode = "workflow"` profile, run by `src/modes/workflow.ts`.
It chains profiles together: each step names a profile and an input reference, and the
harness passes outputs from one step to the next. Every step is a **fresh LLM call** — no
conversation history carries forward. The workflow maintains a **context** that accumulates
results, and each step's input is resolved from it:

| Reference | Resolves to |
|---|---|
| `"initial"` | the original user input |
| `"step-N"` | step N's output |
| `"step-N.raw"` | the raw LLM completion from step N |
| `"step-N.text"` | the rendered text |
| `"step-N.report"` | the structured report |
| `{"key": "ref", ...}` | an object template composing multiple refs into one JSON |
| `"run"` | the whole run so far: initial input, every step result, and whether it stopped early. Read by the terminal step |

For example, the `clinical-verified` workflow:

```toml
steps = [
  { name = "extract", profile = "clinical", input = "initial" },
  { name = "verify-derived", profile = "clinical-verifier", input = { document = "initial", extraction = "step-0.output" } },
  { name = "verify-source", profile = "verifier", input = "step-1.output" },
  { name = "assess", profile = "clinical-assessment", input = "run", final = true }
]
```

Step 0 runs the clinical extractor against the original note. Step 1 deterministically checks
clinical derivations and removes them from the source-provenance payload. Step 2 runs the generic
verifier against only the source observations — on a different LLM instance and port. Each step
delegates to its profile's own mode (`extract`, `agentic`, `router` or `code`), so the workflow is
a generic orchestrator that knows nothing about what any step does.

### The ending

Step 3 is the **terminal step**, marked `final = true`, and it is what turns a chain of machine
artifacts into a statement about the patient. It **computes nothing**: every fact it prints was
produced by a step above and checked by the verifier below it. That constraint is what makes it
gradeable — the page is a pure function of the run, so `eval --profile clinical-assessment` holds
it to four gates with no GPU and no model:

- **closure** — every printed line carries the input field it came from, and that field resolves.
  A renderer that composed a sentence out of its own vocabulary fails here rather than in front
  of a reader.
- **agreement** — the verdict printed is the verdict in the structure.
- **silence under refusal** — a run a gate stopped prints no verdict at all.
- **determinism** — the same run renders to the same bytes.

A terminal step runs on **every** exit, including the two failure exits, because a refused run is
the one whose reader most needs a sentence. It cannot change the verdict: `stoppedEarly` is
decided before it runs. A refused run ends like this instead:

```
NO ASSESSMENT — supplied input

Withheld at step 'verify-derived' (clinical-verifier):
  results.shock.output.shock_category: expected hypovolemic

What the run did establish is in the step output. No verdict is stated here, because the
check that would license one refused.
```

Model prose (`indeterminate_reason`, `screen_reason`, `notes`) is quoted verbatim and attributed
to its field, never paraphrased — the moment it is paraphrased, nobody can tell which words were
the model's. A finding the payload marks `not_assessed` is named rather than omitted, because the
difference between "the JVP was normal" and "nobody looked" is the difference a summary is most
likely to erase.

A failed step stops the workflow. No retry, no fallback. Persisting the context to disk
(`context.json` + `step-N.json`) enables crash recovery and step-by-step execution when
only one GPU is available. See `profiles.toml` for the definition and
`src/profiles/clinical-verified/` for the fidelity eval that compares three arms (monolith,
specialist, verified) against each other.

To evaluate that production composition for one ad-hoc synthetic input, without the fidelity
eval's verifier-shape transform:

```bash
node src/cli.ts eval --profile clinical-verified --input "<synthetic clinical note>"
```
