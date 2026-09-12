# Running

```bash
npm test                # unit tests; pack-dependent tests SKIP when no pack is on disk
npm run typecheck       # tsc --noEmit; Node strips types, so this is the real check
npm run check           # npm test && npm run typecheck — what CI runs
npm run profiles        # what is configured

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

### TUI (terminal dashboard)

```bash
npm run tui                    # connect to http://127.0.0.1:3000
node --experimental-ffi src/tui.ts --url http://127.0.0.1:3001
```

The TUI is an **opt-in entry** that requires a runtime with native FFI:

- **Node.js ≥ 26.4.0** with `--experimental-ffi`, **or**
- **Bun ≥ 1.3**

The rest of the harness (tests, CLI, server) runs unchanged on Node ≥ 24. The TUI
consumes the same `GET /events` SSE stream that the server already exposes; no
in-process coupling, no additional API, no build step.

### Web dashboard (browser)

```bash
npm install --prefix web           # once
npm run web                        # dev server on http://localhost:5173
npm run web:build                  # static build to web/dist/
```

A React + Vite dashboard that renders the same activity feed in the browser — the
terminal TUI's panels plus an inspector (sessions, stage trees, tools, routes, HTTP
traffic), an editable server URL, pause/resume, and a filterable, click-to-inspect event
log. It is a browser over the same three layers as the terminal TUI: the pure reducer in
`src/tui/state.ts` and the SSE core in `src/tui/sse-core.ts` are shared verbatim; only
the transport differs (browser `fetch` + `ReadableStream` instead of `undici`).

The dashboard is cross-origin by definition, so the server answers CORS for **loopback
`Origin`s when an `Origin` header is present**; nothing else is granted by default. Set
`MEDEXTRACT_CORS` to a comma-separated allowlist to open it to specific other origins,
or `*` for an explicit blanket:

```bash
PORT=3000 MEDEXTRACT_CORS="http://192.168.1.20:5173" node src/server.ts
```

Point the dashboard at a different server with the URL field, or set
`VITE_MEDEXTRACT_URL` at build time. The wire carries only metadata-flowing event fields,
under the same banned-key guarantee the terminal TUI relies on.

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
