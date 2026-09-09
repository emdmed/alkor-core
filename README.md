# medextract

Pull structured medical data out of clinical notes with a small local model — and know
what it is worth before you ship it.

You write a **contract pack** — the prompts, JSON schemas and eval cases your application
actually uses. `extract` runs that contract over a note and gives you the JSON. `eval` runs
the same contract over a corpus and gives you a gate, a trace and a reproducible number.
One assembly feeds both, so what was measured is what runs. The pack is data, so your own
application's runtime reads the same files: the number describes the product rather than a
rehearsal of it.

```bash
node src/cli.ts extract --profile clinical --note ward-round.txt --constrain   # the job
node src/cli.ts eval    --profile clinical --constrain                         # what it is worth
```

> **Status: pre-release.** The harness, the pack format, the reference clinical pack and
> its corpus are here and tested. Every number below was measured on the corpus that ships
> in this repository, against weights named by sha256. See [Measured](#measured) — including
> what the result does *not* show.

## What this is, and what it is not

**It is** an extractor for one specific job — *this contract, out of these notes, with a
model small enough to run where the notes are* — with the gate that says whether it is good
enough to ship attached to it rather than sold separately.

**It is not a generic eval framework.** promptfoo, Inspect and lm-eval measure prompts
against models across many tasks. The evals here exist to keep one contract honest, and
that contract is the artifact production reads. Narrower on purpose.

**It is not an inference server.** It talks to a `llama-server` you started. A server's
flags are part of a measurement and outlive many runs, so the harness will not start one
behind your back. The interactive server (`src/server.ts`) is the exception — it manages
model lifecycles on demand, starting a backend on first request and sweeping it after idle.

**It is not a medical device**, not clinical decision support, and not validation evidence
for any regulator. What it measures is up to whoever points it.

## What makes a small model produce a usable contract

Three things about constrained extraction from clinical text are counter-intuitive enough
that everyone rediscovers them the expensive way. They are most of the difference between a
4B model that fills a schema and one that pads, stalls or returns `{}`:

**JSON Schema property order is load-bearing.** llama.cpp compiles object properties into
the grammar in the order given, so the model must emit them in that order. On one
extraction schema, with nothing different but key order: the domain identifier first
produced 6 items and 1625 characters; alphabetical order — which puts `confidence` first,
demanding a confidence score before the model has committed to a finding — produced 77
items and 8902 characters of padding. This is why parity tests here compare *serialized
bytes* against a golden rather than deep-equality.

**A grammar blocks EOS while an array is open.** The model cannot stop mid-array; it must
reach `]`. Unbounded, it will not — an early trial ran to 3483 tokens. So a pack's schemas
carry `maxItems` and `uniqueItems`, and both are load-bearing rather than decorative.

**An optional property is a legal way to stop early.** A property that is required but
typed `anyOf: [<shape>, null]` makes the model visit every slot and say something about
each. Making it optional instead compiles to a maybe-branch in the grammar, and that is how
a run comes back as `{}`.

A pack that gets these wrong produces a number, not an error. That is the failure mode this
repository exists to make visible.

## Layout

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
              router.ts    rule-based intent routing (clinical / coding / transcriptor / verifier)
              pipeline.ts  generic multi-profile orchestration
src/profiles/ clinical/    the reference profile: four tasks, names no vital sign
                           settings.ts  what the pack declares, and the refusals that make
                                        a declaration worth trusting
                           contracts.ts what one pass SENDS: prompt, schema, cap, routing
                           cases.ts     what the reply is graded against: the answer keys
                           review.ts    one note in, one reading out, provenance checked
                           eval.ts      vital signs over the corpus, scored and gated
                           set-eval.ts  summary, note-format, transcript: set extraction, cited
                           clinical-router.ts  shape-based routing inside clinical (dialogue, dictation, exam-json, vitals-note, note)
                           shock.ts     shock-category classification with rule-based reference arm
                           router-eval.ts   60-case confusion-matrix eval for the clinical router
                           shock-eval.ts    20-case eval for shock category
                           review-note-format.ts   post-processing for note-format
                           review-shock.ts       post-processing for shock
              coding/      the agentic worked example: six tools, no pack
              router/      the top-level router profile: rule-based + model fallback
              verifier/    the verification specialist: checks extraction for hallucinations
              clinical-verified/   the verified workflow: extract → verify
packs/        clinical/    the reference pack — 4 prompts, 4 schemas + goldens, 59 notes
              verifier/    the verifier contract pack (prompt + schema + cases)
scripts/      model-manager.ts   start/stop/status llama-server per profile
src/index.ts  the public API — what a profile is written against
src/tui/      state.ts     pure reducer over the activity event stream (tested, Node 24)
               sse.ts       SSE client (undici): replay, resume, reconnect, refusal (tested, Node 24)
               sse-core.ts  transport-agnostic SSE core — frames, dedup, refusal; shared with the web dashboard
               app.ts       OpenTUI renderer — the only file that imports it; dynamic import
               tui.ts       entry guard: Node 26.4 + --experimental-ffi or Bun ≥ 1.3
web/          the browser dashboard (own Vite + React app): same reducer, same SSE core
src/cli.ts    extract, eval, agent, route, pipeline, profiles
profiles.toml the only file that may name a project outside this repository
```

The swappable unit is the **execution mode**, not the toolset:

- **`extract`** — single-shot constrained output over one document. No tool loop.
- **`agentic`** — a tool-calling loop; termination is an explicit `done` tool call.
- **`session`** — multi-turn conversation with tools, streaming, consent gates for
  mutating operations, and abort support.
- **`router`** — rule-based classification with an optional model fallback.
- **`pipeline`** — multi-model orchestration: chain profiles, pass outputs between steps.

Extraction and agentic work are different shapes. Forcing extraction into an agent loop
would be slower, less reliable, and much harder to validate.

## How llama-server is handled

The harness talks to `llama-server` over the standard OpenAI-compatible API (`POST
/v1/chat/completions`). Three transport functions serve different shapes:

- **`chat()`** — non-streaming, for extraction and eval. Temperature 0, seed 0,
  `cache_prompt: true` (60-88% prefill reuse across a corpus). When `--constrain` is on,
  the JSON Schema is passed as `response_format.json_schema` and the server compiles it
  into a GBNF grammar that makes invalid JSON physically impossible to emit.
- **`toolChat()`** — non-streaming, for agentic loops. Adds `tools` and `tool_choice:
  "auto"` to the body. A separate function (not a flag) to prevent accidental use in eval.
- **`streamChat()`** — SSE streaming for interactive sessions. Parses delta frames,
  accumulates content, reasoning and tool calls.

Each profile declares its own server URL in `profiles.toml`, so a pipeline may talk to
multiple llama-server instances on different ports, each loaded with a different model or
quantisation.

The harness never starts servers for evals — server flags are part of a measurement. The
interactive server (`src/server.ts`) is the exception: `LlamaManager` spawns a backend on
first request, polls `/health` until ready, and sweeps it after `MEDEXTRACT_IDLE_MS`
(default 120s) of idle time. Pinned profiles (the router) are never swept. In-flight
request counting prevents killing a backend mid-generation.

One retry on transport failures (server unreachable, HTTP error). Parse failures are not
retried — at temperature 0 the same request produces the same output, and measuring that
30/30 cases recover zero is more useful than doing it in production.

## Contract packs

A pack is a **directory belonging to your project**, holding its prompts, schemas,
vocabularies and eval cases. It describes itself with a `pack.toml` manifest, and the
harness reads files by manifest **key** — never by path.

```toml
# your-project/contracts/pack.toml
spec = 2
name = "vitals"
documents = "notes/{case}.note.txt"

[files]
prompt       = "prompts/vital-signs.md"
schema       = "schemas/vital-signs.schema.json"
schemaGolden = "schemas/vital-signs.golden.json"
cases        = "evals/vital-signs-cases.json"
```

Point a profile at it:

```toml
[vitals]
mode = "extract"
pack = "../your-project/contracts"
url  = "http://127.0.0.1:8081"
```

Override the root with `PACK_ROOT_VITALS` or `--pack DIR`.

**Packs are not copied into this repository.** The typical pack owner is another runtime
evaluating the same model against the same contracts, and a copy is a divergence waiting to
happen. What actually drifts between two implementations is prompts, schemas and scoring
rules — all data. So the data is shared and the runtime stays native to each side. When a
pack ships goldens, the profile pins its assembled prompt and schema against them
byte-for-byte, which is what makes a cross-runtime comparison mean anything.

`spec` is the pack format version. Absent means 1. A pack declaring a version this harness
does not read is refused rather than read under the old rules — a misunderstood manifest
would otherwise produce a number instead of an error.

The format is documented in full in [`spec/pack.md`](spec/pack.md), including goldens, the
`[include]` rules, and the three constrained-decoding constraints a schema has to respect.

## Writing a profile

A profile is the code that reads a pack: it builds the prompt, parses the output, scores it
and decides the gate.

1. `src/profiles/<name>/profile.ts`, exporting a `PROFILE` that satisfies `ProfileModule`
   (`name`, `mode`, `needsPack`, `runEval`, plus `tools`/`systemPrompt` if agentic, and
   `chatSystemPrompt` to be conversational).
2. A `[<name>]` entry in `profiles.toml`.

`runEval` returns `{pass, summary}` so the CLI decides exit codes in one place, rather than
each profile inventing its own meaning for exit 1.

### Profiles that live in your repository, not this one

A profile does not have to be here. `module` names one, resolved exactly as `pack` is —
relative to `profiles.toml`, overridable with `PROFILE_MODULE_<PROFILE>`:

```toml
[oncology]
mode   = "extract"
module = "harness/oncology/profile.ts"   # your scorer, in your project
pack   = "contracts"                     # and your contracts, beside it
url    = "http://127.0.0.1:8081"
```

`pack` and `module` are two halves of one idea. A pack keeps your prompts, schemas and
cases out of this repository; without `module`, the code that *reads* them — the parser,
the scorer, the floors — would still have to live here. For a proprietary domain those are
the same secret as the prompts, so both halves move together and the harness stays a
runtime with no domain in it.

Such a profile imports the package rather than relative paths:

```ts
import { extract, openTrace, type ProfileModule } from 'medextract'
```

`src/index.ts` is the whole of what a profile may import: core, the modes and the
transport. The profiles themselves and the CLI's wiring are not exported — they consume
that contract rather than being part of it — and `exports` names the entry point and
nothing else, so deep imports are refused rather than quietly supported.

## Running

```bash
npm test                # unit tests; pack-dependent tests SKIP when no pack is on disk
npm run typecheck       # tsc --noEmit; Node strips types, so this is the real check
npm run check           # npm test && npm run typecheck — what CI runs
npm run profiles        # what is configured

# start a server yourself — its flags are part of the measurement
LLAMA_PORT=8082 LLAMA_MODEL=~/models/Qwen3-4B-Q4_K_M.gguf scripts/llama-server.sh -ngl 99

node src/cli.ts eval  --profile coding
node src/cli.ts agent --profile coding --task "fix the failing test" --workspace /tmp/wk

# single-note extraction
node src/cli.ts extract --profile clinical --note ward-round.txt --constrain

# multi-model orchestration
node src/cli.ts route    --profile router --input "dictated: BP 120/80, HR 72"
node src/cli.ts pipeline --profile clinical-verified --input "ward-round.txt"

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
model 'Qwen3-4B-Q4_K_M' · pack 'clinical' spec 1 · constrained · temp 0 · max_tokens 1024

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
it will not be recovered, so the loop stops instead of re-nudging until the step cap.

### Routing and pipeline

The **router** (`src/modes/router.ts`) is a rule-based classifier with an optional model
fallback. It decides which specialist profile should handle a given input — clinical,
coding, transcriptor, or verifier — measured at 98.1% accuracy on a 54-case adversarial
corpus (see `next_steps.md`).

The **clinical internal router** (`src/profiles/clinical/clinical-router.ts`) runs *before*
any GPU call, selecting the right sub-task (`vital-signs`, `transcript`, `summary`,
`note-format`, `shock`) based on input shape: dialogue, dictation, exam JSON, vitals
prose, or plain note. It is purely rule-based, zero GPU cost, and measured at 100% on 60
cases.

The **pipeline** (`src/modes/pipeline.ts`) chains profiles together. Each step names a
profile and an input reference, and the harness passes outputs from one step to the next.
Every step is a **fresh LLM call** — no conversation history carries forward. The pipeline
maintains a state map that accumulates results, and each step's input is resolved from it:

| Reference | Resolves to |
|---|---|
| `"initial"` | the original user input |
| `"step-N"` | step N's output |
| `"step-N.raw"` | the raw LLM completion from step N |
| `"step-N.text"` | the rendered text |
| `"step-N.report"` | the structured report |
| `{"key": "ref", ...}` | an object template composing multiple refs into one JSON |

For example, the `clinical-verified` workflow:

```toml
steps = [
  { name = "extract", profile = "clinical", input = "initial" },
  { name = "verify",  profile = "verifier", input = { document = "initial", extraction = "step-0.raw" } }
]
```

Step 0 runs the clinical extractor against the original note. Step 1 composes the original
document and the raw JSON completion from step 0 into `{document, extraction}`, then runs
the verifier — a different LLM instance on a different port. Each step delegates to its
profile's own mode (`extract`, `agentic`, or `router`), so the pipeline is a generic
orchestrator that knows nothing about what any step does.

A failed step stops the pipeline. No retry, no fallback. Checkpointing to disk
(`context.json` + `step-N.json`) enables crash recovery and step-by-step execution when
only one GPU is available. See `profiles.toml` for the definition and
`src/profiles/clinical-verified/` for the fidelity eval that compares three arms (monolith,
specialist, verified) against each other.

## Traces

Verification operates at three levels:

1. **Provenance** (no LLM) — after every extraction, `verifyQuote()` checks whether each
   field's `quote` appears in the source document by literal containment (whitespace/case
   accent normalization). `verifyDerivation()` checks whether the `text` field is a word
   subsequence of the `quote`. These run inside the profile as post-processing, no
   additional model call.

2. **Model-based** (`src/profiles/verifier/`) — a separate LLM instance that receives the
   original document and the extraction JSON, then checks every field's quote against the
   document. Reports `hallucination`, `modified_quote`, `missing_quote`, or
   `unsupported_value`. This is the second step of the `clinical-verified` pipeline.

3. **Rule-based** (eval shortcut) — checks that every numeric value in the extraction
   appears somewhere in the document. Conservative, fast, no GPU.

## Traces

Every run writes JSONL to `${XDG_STATE_HOME:-~/.local/state}/medextract/traces/<profile>/`
— **outside any repository**, deliberately. A trace line contains the raw prompt and the
raw completion, which for a clinical profile means the note. A profile that handles patient
data supplies a `redact` hook and must set one before tracing anything real.

## Six tasks over four corpora

The reference pack grades six contracts, and `--task` chooses:

```bash
node src/cli.ts eval --profile clinical --constrain                     # vital-signs, the default
node src/cli.ts eval --profile clinical --constrain --task summary      # a whole record in, three lists out
node src/cli.ts eval --profile clinical --constrain --task note-format  # one note, four sections, every item cited
node src/cli.ts eval --profile clinical --constrain --task transcript   # a dictation, sorted into the same four
node src/cli.ts eval --profile clinical --constrain --task shock        # a JSON exam payload, category + residue
node src/cli.ts eval --profile clinical --constrain --task sepsis       # a qSOFA payload, positive/negative + criteria
node src/cli.ts eval --profile clinical --constrain --task all          # the seven, each gated on its own floor
```

| task | input | what it returns | gate |
|---|---|---|---|
| `vital-signs` | one note | nine nullable readings, each with the fragment it came from | detection recall ≥ 90% |
| `summary` | a **record**: several notes assembled into one message | three bounded sets — history, usual medication, pending | item recall ≥ 80% |
| `note-format` | one note | four sections; every item carries a `quote` and a derived `text` | item recall ≥ 75%, **plus** provenance ≥ 90%, derivation ≥ 90% and *nothing invented* (100%) |
| `transcript` | one **dictated transcript** — speech, out of order, correcting itself | the same four sections, same `quote` and `text` | item recall ≥ 65%, same three sub-gates at 85 / 85 / 100% — **provisional, unmeasured** |
| `shock` | one **JSON exam payload** — vital signs, capillary refill, mental status | category + `indeterminate_reason` + agreement with rule-based reference | agreement ≥ 70%, concordance ≥ 80%, coverage ≥ 90%, format valid 100%, schema valid 100% |
| `sepsis` | one **qSOFA payload** — respiratory rate, systolic BP, GCS | positive/negative screen + `criteria_met` + agreement with the medprotocol CLI | screen agreement ≥ 84%, echo 100%, criteria fidelity 100% — **provisional, unmeasured** |

Three things about this arrangement are the reason it is worth having, and none of them are
visible in a single-task pack:

**One corpus, three readings — and the rest genuinely different.** The
note-format cases name a case in the vital-signs corpus and read *that* note: 30 notes grade
three tasks, and a note fixed once is fixed for all of them. The summary task brings its own
documents because its unit of input is a patient rather than an encounter. The transcript task
brings its own because a dictation is not a note — the pack declares a second `documents` kind
for it (spec 3) rather than filing speech under a filename that calls it prose. The shock and
sepsis tasks bring their own because a JSON payload is not prose — the pack declares an `exams`
kind for it.

**One structure, two inputs.** `transcript` sends the *note-format schema*, byte for byte,
under its own `json_schema.name`. A clinician reads one structure, and a second schema for it
would be a second thing free to drift in property order — which is what gets compiled into the
grammar. What the task has of its own is the prompt, because speech has failure modes prose
does not: the speaker retracts a dose out loud and the retracted one stays in the transcript,
quotable; they dictate "comma" and "period"; they talk to whoever is typing; the transcriber
writes `[inaudible]` where a number should be. The interesting property is that the harness
needed almost nothing new to grade it — deletion-only derivation, which exists to stop a drug
name drifting, is also exactly the rule that strips a filler.

**The assembly rule is part of the contract.** A record is built into one message under
`[clinical.summaryAssembly]` — per-note cap, running total, line format, marker — because two
runtimes that assemble differently are grading different inputs while appearing to share a
prompt. Same argument as pinning the schema bytes, applied to the input side.

**Every task clears its own floor, and the two quoting tasks have sub-gates.** Averaging would
let a ceiling on the mature task carry the new ones. And a run that finds every expected item while
fabricating the spans it cites has not passed, which one averaged number could not say.

## Quote, then tidy

The note-format contract asks for two fields per item and checks both, because a schema can
guarantee the shape of a citation and the truth of it not at all:

- **`quote`** must be in the note by literal containment (`[clinical.quoteVerification]`).
  Not a regex: a pattern built from the model's own output has to escape every `.`, `(`, `/`
  and `°` it contains, and one unescaped character turns a failed verification into a passing
  one — the single failure mode a verifier must not have.
- **`text`** must be that quote with words **deleted** — every word already in the quote, in
  the same order (`[clinical.textDerivation]`). This is the half that quote verification alone
  does not give you. Measured on a sibling pack: a model emitted a quote reading *"antibiotic
  cover with ceftriaxona 2 g every 24 hours"*, which verifies character for character, beside
  the item *"ceptriaxona 2 g every 24 hours"*. Provenance was perfect and the line a clinician
  reads named a drug that does not exist.

Measured here on the first run of the new task, Qwen3-4B cited *"He takes two 500 mg tablets
up to four times daily"* and labelled it `paracetamol` — a drug name that appears in the
**previous sentence**, not in the span it cited. The quote verified; the derivation check is
what caught it.

## How hard the notes are

Every case rates its **note** from 1 to 5 — how hard the base text is to read, not how many
slots it grades and not how badly some model does on it. The rating is a property of the
corpus, so it does not move when the weights do, and a per-tier score from two models is
comparing the same texts.

| | the text | notes |
|---|---|---|
| **1** | labelled and canonical: the sign is named, the figure follows it, one reading per sign | 2 |
| **2** | one systematic transformation — foreign abbreviations, imperial units, a decimal comma, an implausible value | 4 |
| **3** | a rule of the contract must be applied: prose, or two candidates for one sign (last, this encounter, stated not derived) | 5 |
| **4** | rejection before transcription: targets, plans, lab panels, another person's readings, an infant's normals | 5 |
| **5** | the text fights the reader: a chart instead of sentences, a figure retracted further down, a range around one true reading, a discharge summary made mostly of other numbers | 5 |

Half the graded slots sit at 4 and 5. `eval` prints detection per tier beside the gate, and
`--difficulty 4-5` grades only the hard end while iterating:

```bash
node src/cli.ts eval --profile clinical --constrain --difficulty 4-5
```

The tiers are **reported, never gated**. The floor is one number over the whole corpus,
because a contract ships or does not ship as one thing.

## What a run costs

Every eval reports what it cost, counted on the graded pass itself:

```
what it cost:
  generation  11.4 tok/s   (4833 tokens in 425.0s, server-counted)
  prompt      80.9 tok/s   (5301 evaluated, 26660 from cache = 83% reuse)
  latency     median 23.3s  p95 29.0s  min 9819ms  max 41.9s   over 21 case-runs
  first case  41.9s   cold cache, counted in the total and named here
  wall total  490.8s   of which 336ms is transport, not the model
  conditions  Q4_K - Medium · ctx 32768 · 1 slot(s) · sequential, cache_prompt on
```

**There is no `bench` verb, deliberately.** A timing pass with its own prompts would measure
something adjacent to the product — a different cap, a cold cache, a shorter note — and the
cost number would drift from the contract exactly as a measured path drifts from a used one.
llama-server returns a `timings` object unasked on the non-streamed path, so measuring costs
one field in the trace and **no change to the request body**: a measured run and an
unmeasured one send identical bytes.

Everything above is server-counted except wall time, which is the client round-trip. The gap
between them is transport and queueing — real cost an application pays that a server-side
number never shows. `cache reuse` is the `cache_prompt` design claim as a number: the system
prompt is identical across notes, so the sequential run re-evaluates almost none of it.

Read a speed with more care than a score. **Correctness travels between machines; throughput
does not.** A `tok/s` here belongs to an iGPU with every layer offloaded, one slot, this
build, this quantisation and this context size — which is why the conditions line is read
from the server rather than taken from the pack, and why nothing gates on it. `p95` over 30
notes *is* the maximum, so it is printed with its sample count. `--runs N` no longer
re-averages: it reports which cases returned a *different answer* and which of those flipped
a grade, because averaging N identical replies at temperature 0 is arithmetic on a constant.

## Measured

**These numbers are from a corpus that no longer exists.** They were measured on 21 notes / 88
graded slots; the corpus is now 59 / 132 + 103 required items, the summary task 10 records / 56
items, note formatting 15 notes / 47 items, transcript 15 / 47, shock 20 / 20, and `value` and
`unit` have become sub-gates at 95% — a floor the 81/88 unit row below fails. The table is kept
because it is the evidence those changes were made from, not as a current result; `packs/clinical/RESULTS.md` says so at the top and a re-run on the current corpus has not been made. What follows describes the run as it was.

21 notes / 88 graded slots for `vital-signs`, 3 records / 13 items for `summary`, 6 notes /
18 items for `note-format`. Temperature 0, `seed` 0, caps from the pack, one run per case, on
an AMD Renoir iGPU. Qwen3-4B was the then-default local file, sha256 `7485fe6f…`, verified
before the run; gemma-3-4b-it is `ggml-org/gemma-3-4b-it-GGUF`. Full
conditions, per-tier detection and per-case failures: `packs/clinical/RESULTS.md`.

| model | grammar | detection (gate) | value | unit | provenance | halluc | failed | tok/s | median/note |
|---|---|---|---|---|---|---|---|---|---|
| Qwen3-4B-Q4_K_M | constrained | 87/88 | 86/87 | 86/87 | 80/87 | 2 | 0 | 12.6 | 21.6s |
| Qwen3-4B-Q4_K_M | free | 87/88 | 86/87 | 86/87 | 80/87 | 2 | 0 | 12.6 | 20.5s |
| gemma-3-4b-it | constrained | 88/88 | 82/88 | 81/88 | 87/88 | 3 | 0 | 14.2 | 24.1s |
| gemma-3-4b-it | free | **0/88** | — | — | — | 0 | 21 | 14.2 | 23.8s |

The other two tasks, constrained: both models 13/13 summary items; both 15/18 note-format
items. The sub-gates separate them — Qwen provenance 100% and derivation 97%, gemma provenance
94% and derivation 100%. gemma's free arm scored 0 on all three tasks.

Five things in that table are the reason this repository exists.

**Detection is no longer where the interesting failures are.** Both models clear the floor on
all 21 notes and gemma finds every slot; what separates them is *value* (82/88 against 86/87)
and *unit* (81/88 against 86/87). A gate on detection alone would call these two contracts
equivalent, and it would be wrong in the direction a clinician notices.

**The same case fails both models in opposite directions.** On the flowsheet note, Qwen3-4B
gets every value right and invents every citation — `'BP 121/74'`, `'HR 91'`, `'Temp 37.2'`,
none of which are strings in the note, because the chart's labels and values sit in different
columns. gemma quotes the note faithfully and reads the wrong row: 5/5 provenance, 0/5 values.
One number combining the two axes would score them identically and describe neither.

**A grammar buys shape, and only where shape is missing.** Qwen3-4B's two arms are *identical*
— same tallies on all three tasks. gemma's free arm is `0/88`: every one of its 30 replies came
back wrapped in a ```json fence and nothing parsed. A model that already emits clean JSON has
no shape left to buy; a model that does not has nothing else that will save it.

**`0/88` is a format failure, and the harness says so rather than leaving you to guess.**
Re-scoring gemma's traced completions with the fence stripped and no model running gives 84/84
detection and the same failures as its constrained arm. Two cases stay unparseable even then,
because they emitted `{"value": null}` where the contract allows exactly one spelling of
absent. The grammar makes both impossible. The eval refuses to strip the fence for you, because
an application that does not strip it gets nothing either — but it names the failure as a fence
rather than as broken JSON, so nobody spends an afternoon on the wrong bug.

**Provenance catches what no schema can.** No JSON Schema keyword expresses "substring of the
prompt" and GBNF has no back-reference to the context, so a grammar will happily emit a
beautifully-formed citation of a sentence nobody wrote. Seven of Qwen's eight vital-signs
failures are provenance, and two of them are only a lowercased capital — reported apart from
the five fabrications, because a model being tidy and a model inventing a sentence are
different accusations with different fixes.

Reproduce any row:

```bash
LLAMA_PORT=8081 LLAMA_MODEL=~/models/Qwen3-4B-Q4_K_M.official.gguf scripts/llama-server.sh \
  -ngl 99 --no-webui --parallel 1
node src/cli.ts eval --profile clinical --constrain            # add --url for another port
```

The `.official` suffix identifies the historical copy whose sha256 was `7485fe6f…`; the pack
now declares Gemma 4 E4B as its default. The trace's `run` event records which difficulty tiers
a result covers and the server conditions a timing was taken under, so a row is never read
against a corpus or a machine it did not run on.

Every case's full completion goes into the trace, and a `run` event at the top of each trace
records the model the server reported, the URL, whether a grammar was used and the sampling.
So a suspiciously perfect score is checked by reading a file rather than by re-running the
model — which is how the gemma re-scoring above was done, with no model running at all. That
re-scoring is a verb rather than a script somebody wrote twice:

```bash
node src/cli.ts eval --profile clinical --from-trace ~/.local/state/medextract/traces/clinical/…jsonl
node src/cli.ts eval --profile clinical --from-trace …jsonl --strip-fences   # the same bytes, unwrapped
```

It contacts no server and it never produces a PASS: the floors belong to a run against a
model, and a command that could turn a saved file green would be a way to pass CI without
running anything. What it reports is agreement — the score today, the score the run recorded,
and which cases moved. A trace whose completions were redacted is refused rather than graded
as prose.

The completion is written verbatim only when the pack states that its corpus is synthetic
(`corpusSynthetic = true`). A pack that does not say is treated as holding real records, and
the profile's redactor replaces the completion, the parse error that quotes it and the misses
that quote the model's spans with a length and a sha256 — enough to tell two runs apart,
without the text. The trace directory is outside any repository for the same reason.

**A run is reproducible, not bit-identical, and the difference is measured.** The request body
pins `seed`, `temperature` and `cache_prompt`, but prompt-cache reuse is what decides how a
batch is split, and that decides the last bits of the logits. The same note, the same model
and the same bytes, scored once inside a 21-note run and once inside a five-note
`--difficulty 5` run, returned `"weight 61.4 kg"` and `"Weight 61.4 kg"`. One capital, and
under a case-sensitive quote rule that is the difference between a verified span and a
fabricated one. Treat a scoped run as its own measurement rather than as a slice of a full
one — which is what the `difficulty` field in the trace's `run` event is there to say.

Two things follow from that rather than only a warning. `--runs N` reports **which cases
returned a different answer** and which of those flipped a grade, instead of averaging N
replies that are usually identical. And `--no-cache-prompt` gives up the prefix reuse — 60 to
88% of prefill on this corpus — to buy a run that two machines can compare byte for byte:

```bash
node src/cli.ts eval --profile clinical --constrain --runs 3 --no-cache-prompt
```

Each trace also closes with a **record**: the harness version, the model, whether a grammar
was used, and a sha256 per contract file the run actually read — every prompt, schema, case
file and note. Read rather than declared, because the notes are named by a template rather
than by a key, and a record that pins the answer key but not the inputs pins the wrong half.

The per-case breakdown behind this table, and the conditions each row ran under, are in
[`packs/clinical/RESULTS.md`](packs/clinical/RESULTS.md). Results live beside the corpus
they were measured on: change a note or a floor and the old numbers describe a pack that no
longer exists, so an entry there gets a new date rather than an edit.

## Status

| | |
|---|---|
| harness core, modes, tracing | done, tested |
| `extract` — one note in, JSON out, provenance checked | done, tested |
| pack format (`spec = 2`) | done — with a changelog the loader quotes when a pack is older |
| out-of-tree profiles and packs | done |
| public API (`medextract` entry point) | done |
| agentic worked example (`coding`) | done |
| reference clinical pack + corpus | done — 59 notes, 132 graded slots + 103 required items, rated 1-5 |
| multi-task packs (`--task`, per-task floors, sub-gates) | done, tested |
| provenance: quote verification + deletion-only derivation | done, tested |
| harder cases for that corpus | done — nine more, written against the measured failure modes |
| cost measured on the graded pass (tok/s, latency, cache reuse) | done, tested |
| two models re-measured on the extended corpus | done — see `RESULTS.md` |
| offline re-scoring (`eval --from-trace`) | done, tested — a claim about a past run is checkable |
| typecheck and CI | done — `npm test && npm run typecheck` on every push |
| router (intent classification, 98.1% on 54 cases) | done, tested |
| clinical internal router (shape-based, 100% on 70 cases) | done, tested |
| shock category contract (20 cases, rule-based reference arm) | done, tested |
| sepsis screen contract (14 cases, medprotocol reference arm) | done, tested — awaiting a measured run for RESULTS.md |
| verifier (30 cases, 100% catch, 0% FP on 4B model) | done, tested |
| pipeline mode (multi-profile orchestration, state passing, checkpointing) | done, tested |
| clinical-verified pipeline (extract → verify, fidelity eval) | done, tested |
| interactive server (on-demand model lifecycle, idle sweep, in-flight protection) | done, tested |
| session mode (multi-turn, streaming, consent gates, abort) | done, tested |
| both models re-measured on the grown corpus | next — the entry `RESULTS.md` is waiting for |
| `validate` verb | planned |

The reference pack is a synthetic, bilingual corpus with a per-case answer key that states
what each case discriminates. It is synthetic from the first commit and will never be
derived from a real record — a public clinical corpus is the single most likely place for
patient data to enter a repository, and there the mistake is unrecoverable.

## Requirements

Node ≥ 24. The CLI is plain TypeScript run natively by Node — no bundler, no transpile,
no build step. What you read is what runs.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md). The short version: no patient data, ever; no number
that was not measured; a bad result stays; and core names no domain.

The corpus needs harder cases more than the harness needs features.

## License

Apache-2.0. Contract packs under `packs/` carry CC BY 4.0 separately, so a pack can be
forked and adapted without dragging code terms along.
