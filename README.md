# alkor — small local-model orchestration for medical workflows

**Small local models better at medicine.**

alkor sits between your prompt and local inference. It does three things in that layer —
**manages context, constrains the model, and calls tools** — so that a small model running
on your own hardware can carry a whole medical workflow. It starts each `llama-server` a
step needs and stops it afterwards, and it checks every reading back against the note it
came from. If a check fails, it reports nothing rather than something plausible.

The premise: **a 4B model is not a clinician.** A model small enough to run beside the notes
will miss findings, invent them, and get arithmetic wrong — all in the same confident voice,
and better prompt wording does not fix it. alkor does not change the weights. It makes the
output checkable and drops whatever fails the check.

| The model… | alkor's answer |
|---|---|
| invents findings | every reading carries a verbatim quote, and a *second model* checks those quotes against the note. Unquoted readings never reach output. |
| cannot do arithmetic | shock index, MAP and pulse pressure are recomputed in code from the quoted values. The model's own numbers are dropped, not reconciled. |
| will not say "I don't know" | declining is scored, not excused. "Normal" and "nobody looked" stay distinct. |

You supply a **contract pack**: the prompts, JSON schemas and eval cases your application
actually uses. The pack is just data, and the same pack runs in production and gets graded
by the eval — so "good enough" is a gate with a floor, not an impression.

## Three ways in

One script, one CLI, one HTTP endpoint. All three drive the same code underneath:

```bash
./start                                                            # clone to running dashboard
node src/cli.ts workflow --profile clinical-verified --input "…"   # the job
node src/cli.ts eval --profile clinical --constrain                # what it is worth
curl -s localhost:3000/pipeline -d '{"input":"…"}'                 # one request, one run id
```

`POST /pipeline` routes the input, runs the workflow it picked, and returns either a verdict
or a refusal naming the step that stopped it. Both carry a run id that ties the answer to
everything the run emitted, so curl, a shell script and a cron job are all first-class
callers.

> **Status: alpha, released for testing.** The harness, the pack format, the reference
> clinical pack and its corpus all work and are tested. Interfaces, the pack format and the
> measured numbers may still change between alpha versions. Every number here was measured
> on the corpus in this repository, against weights named by sha256 — see
> [Measured](docs/measured.md#measured), including what the results do *not* show.
>
> `node src/cli.ts --version` names the build; the dashboard shows the stage of the server
> it is connected to, beside the mark.

> **Research and educational tool only.** alkor is **not a medical device**, not clinical
> decision support, and not validation evidence for any regulator. Its output must not be
> used to make medical decisions, or to diagnose, treat or care for any patient. See
> [What this is, and what it is not](#what-this-is-and-what-it-is-not).

## Quickstart

You need **Node ≥ 24** and **`llama-server`** from
[llama.cpp](https://github.com/ggml-org/llama.cpp) on your `PATH`. alkor does not bundle an
inference engine and does not download weights.

**If you want the dashboard**, one command does everything — checks the Node version,
installs both dependency trees, verifies the engine and the declared weights are present,
then starts the interactive server and dashboard together and stops them together:

```bash
./start           # or: npm start
./start --check   # run the checks and change nothing
```

**For the CLI**, the same checks are a verb. `doctor` looks for the engine, the weights the
pack declares, and a server on the port the profile names. It installs nothing and starts
nothing — it just says which of the three is missing and prints the command that supplies it:

```bash
npm install
npm test          # passes with no server and no model
node src/cli.ts doctor --profile clinical
```

That check also runs ahead of `extract`, `eval`, `route` and `agent`, so a missing piece is
one sentence in milliseconds instead of a transport failure on every case.

### Start a server

`LLAMA_HF` names a Hugging Face repo that `llama-server` downloads and caches itself, so a
fresh machine needs no separate download step. This is the reference pack's default model
(~4.6 GB, see `packs/clinical/models.default.toml`):

```bash
LLAMA_PORT=8081 LLAMA_HF=ggml-org/gemma-4-E4B-it-GGUF \
  scripts/llama-server.sh -ngl 99 --no-webui --parallel 1
```

### Run something

In another shell, extract from a note that ships in this repository — no file of your own
needed, and it is the same note the eval grades:

```bash
node src/cli.ts extract --profile clinical --case vs-en-03-prose --constrain
```

Then run the gate over the whole corpus. This is the part that says what the extraction is
worth:

```bash
node src/cli.ts eval --profile clinical --constrain
```

Those are single steps. To run the whole reference workflow — extract, then both
verifications, then the assessment — name the workflow instead of the profile:

```bash
node src/cli.ts workflow --profile clinical-verified \
  --input "$(cat packs/clinical/notes/sh-01-septic-classic.note.txt)"
```

From here: [Extracting from one note](docs/running.md#extracting-from-one-note) for the verb
and its output, [Routing, pipeline and workflows](docs/running.md#routing-pipeline-and-workflows)
for how the steps nest, [Contract packs](docs/packs.md) to point it at your own prompts and
schemas, and [the task list](docs/tasks.md) for what else the reference pack grades.
`npm run profiles` lists what is configured.

## Contents

This file is the short version: what the project is, how to start it, and what state it is
in. Anything longer than a screen lives under `docs/`.

| | |
|---|---|
| [Running](docs/running.md) | Every verb: `extract`, `eval`, `agent`, `route`, `workflow`, the dashboards, and what each prints. |
| [Contract packs](docs/packs.md) | The pack format — prompts, schemas, cases — plus quote verification and what a trace holds. |
| [Writing a profile](docs/profiles.md) | The code that reads a pack, including profiles that live in your repository rather than this one. |
| [The reference pack, task by task](docs/tasks.md) | The eight contracts the clinical pack grades, how its notes are rated, and the quote-then-tidy rule. |
| [What a run costs, and what it scored](docs/measured.md) | The measured numbers, the weights they were measured against, and what they do **not** show. |
| [Reference](docs/reference.md) | Nomenclature and repository layout. |

Also here: [What this is, and what it is not](#what-this-is-and-what-it-is-not) ·
[What makes a small model produce a usable contract](#what-makes-a-small-model-produce-a-usable-contract) ·
[How llama-server is handled](#how-llama-server-is-handled) ·
[Status](#status) · [Requirements](#requirements) · [Contributing](#contributing)

## What this is, and what it is not

**It is** an orchestration layer between your prompt and local inference — context
management, model constraint and tool calls — that carries a whole medical workflow on a
model small enough to run where the notes are. The gate that says whether the result is good
enough to ship is attached to it, not sold separately. Extraction is one step inside that,
not the whole of it.

The reference workflow, `clinical-verified`, has four steps:

| Step | Runs on | Time |
|---|---|---|
| extract | gemma-4-E4B, port 8081 | 19.5s |
| verify-derived | code, no GPU | 3ms |
| verify-source | a second model, port 8085 | 8.1s |
| assess | code | 1ms |

**Two of the four decide by rule and never touch a GPU**, and the ending is graded and
renders to the same bytes every time. A run ends in a verdict, or in a refusal that names
the step that stopped it.

**The orchestrator knows nothing about medicine.** All the domain knowledge lives in packs
and profiles; the layer would run a non-medical contract unchanged.

One name per level — **Run › Pipeline › Workflow › Step › Profile › Task→Pass** — and the
terms are not interchangeable. ("Stage" is not a level; it is what a unit of work is called
at any of them.) Every surface uses that vocabulary — see
[Nomenclature](docs/reference.md#nomenclature).

**It is not a generic eval framework.** promptfoo, Inspect and lm-eval measure prompts
against models across many tasks. The evals here exist to keep one contract honest, and that
contract is the artifact production reads. Narrower on purpose.

**It is not an inference server.** It talks to `llama-server`, and under the orchestrator it
manages those servers' lifecycles too — starting the backend a step needs on first request,
sweeping it after idle. **For a measured eval it never starts a server**: a server's flags
are part of a measurement, so there you start one you control. That asymmetry is deliberate.

**It is not a medical device**, not clinical decision support, and not validation evidence
for any regulator. It is a research and educational tool, and nothing it outputs is to be
used to make medical decisions. What it measures is up to whoever points it.

## What makes a small model produce a usable contract

Three things about constrained extraction from clinical text are counter-intuitive enough
that everyone rediscovers them the expensive way. They are most of the difference between a
4B model that fills a schema and one that pads, stalls or returns `{}`:

**JSON Schema property order matters.** llama.cpp compiles object properties into the
grammar in the order you give them, so the model must emit them in that order. On one
extraction schema, changing nothing but key order: putting the domain identifier first gave
6 items and 1625 characters; alphabetical order — which puts `confidence` first, demanding a
confidence score before the model has committed to a finding — gave 77 items and 8902
characters of padding. This is why parity tests here compare *serialized bytes* against a
golden file rather than using deep equality.

**A grammar blocks EOS while an array is open.** The model cannot stop mid-array; it has to
reach `]`. Left unbounded it will not — an early trial ran to 3483 tokens. So a pack's
schemas carry `maxItems` and `uniqueItems`, and both are load-bearing.

**An optional property is a legal way to stop early.** A property that is required but typed
`anyOf: [<shape>, null]` makes the model visit every slot and say something about each.
Making it optional instead compiles to a maybe-branch in the grammar — and that is how a run
comes back as `{}`.

A pack that gets these wrong produces a number, not an error. That failure mode is what this
repository exists to make visible.

## How llama-server is handled

alkor talks to `llama-server` over the standard OpenAI-compatible API
(`POST /v1/chat/completions`). Three transport functions cover different shapes:

- **`chat()`** — non-streaming, for extraction and eval. Temperature 0, seed 0,
  `cache_prompt: true` (60–88% prefill reuse across a corpus). With `--constrain`, the JSON
  Schema is passed as `response_format.json_schema` and the server compiles it into a GBNF
  grammar that makes invalid JSON physically impossible to emit.
- **`toolChat()`** — non-streaming, for agentic loops. Adds `tools` and
  `tool_choice: "auto"`. It is a separate function rather than a flag, to prevent accidental
  use in eval.
- **`streamChat()`** — SSE streaming for interactive sessions. Parses delta frames and
  accumulates content, reasoning and tool calls.

Each profile declares its own server URL in `profiles.toml`, so one workflow can talk to
several `llama-server` instances on different ports, each with a different model or
quantisation.

Under the orchestrator (`src/server.ts`), `LlamaManager` spawns a backend on first request,
polls `/health` until ready, and sweeps it after `ALKOR_IDLE_MS` (default 120s) of idle time.
Pinned profiles (the router) are never swept, and in-flight request counting keeps a backend
from being killed mid-generation.

For a measured eval alkor starts nothing. Server flags are part of a measurement, and a run
that silently supplied its own would be reporting a number about a configuration nobody
wrote down.

Transport failures (server unreachable, HTTP error) get one retry. Parse failures get none —
at temperature 0 the same request produces the same output, and measuring that 30/30 cases
recover zero is more useful than retrying in production.

## Status

**Alpha, released for testing.** The version carries the stage as a semver prerelease tag
(`0.1.0-alpha.1`), so everything that reports it — the CLI banner, `--version`, the badge on
the dashboard mark — reads one string and stops saying "alpha" the moment the tag is
dropped. What that stage means here: the pieces marked done below are tested and usable, and
the interfaces around them are not yet frozen.

| | |
|---|---|
| harness core, modes, tracing | done, tested |
| `extract` — one note in, JSON out, provenance checked | done, tested |
| pack format (`spec = 3`) | done — with a changelog the loader quotes when a pack is older |
| out-of-tree profiles and packs | done |
| public API (`alkor` entry point) | done |
| reference clinical pack + corpus | done — 62 notes, 20 transcripts, 34 exam payloads; vital signs 30 notes / 155 slots, rated 1-5 |
| multi-task packs (`--task`, per-task floors, sub-gates) | done, tested |
| provenance: quote verification + deletion-only derivation | done, tested |
| harder cases for that corpus | done — nine more, written against the measured failure modes |
| cost measured on the graded pass (tok/s, latency, cache reuse) | done, tested |
| two models re-measured on the extended corpus | done — see `RESULTS.md` |
| offline re-scoring (`eval --from-trace`) | done, tested — a claim about a past run is checkable |
| typecheck and CI | done — `npm test && npm run typecheck` on every push |
| router (intent classification, 100% on 32 cases) | done, tested |
| clinical internal router (shape-based, 100% on 90 cases) | done, tested |
| shock category contract (20 cases, rule-based reference arm) | done, tested |
| sepsis screen contract (14 cases, medprotocol reference arm) | done — 100% on three gates (pre–score-fidelity, 2026-09-10); four-gate re-measurement pending, `RESULTS.md` |
| shock-pipeline prose→classification (3 extraction cases, chained) | done, tested — **provisional, unmeasured** |
| verifier (34 cases — 23 clean, 11 injected) | done, tested — the 100% catch / 0% FP figures were measured when the corpus was 30 |
| workflow mode (multi-profile orchestration, context passing, resume) | done, tested |
| clinical-verified workflow (extract → verify, fidelity eval) | done, tested |
| interactive server (on-demand model lifecycle, idle sweep, in-flight protection) | done, tested |
| session mode (multi-turn, streaming, consent gates, abort) | done, tested |
| web dashboard on `GET /events` (live stage tree, tool calls, HTTP traffic, click-to-inspect log) | done — desktop-only; it observes, never drives |
| both models re-measured on the grown corpus | next — the entry `RESULTS.md` is waiting for |
| `validate` verb | planned |

The reference pack is a synthetic, bilingual corpus with a per-case answer key stating what
each case discriminates. It has been synthetic from the first commit and will never be
derived from a real record — a public clinical corpus is the single most likely place for
patient data to enter a repository, and there the mistake is unrecoverable.

## Requirements

**Node ≥ 24.** The CLI is plain TypeScript run natively by Node — no bundler, no transpile,
no build step. What you read is what runs.

**`llama-server` from [llama.cpp](https://github.com/ggml-org/llama.cpp), on your `PATH`.**
Not bundled, and not started for you: a server's flags are part of a measurement, so alkor
talks to one you control. Only the interactive server (`src/server.ts`) spawns backends, and
only on demand.

**A GGUF model.** Nothing here downloads weights, but `llama-server` does: pass
`LLAMA_HF=<repo>` to `scripts/llama-server.sh` and it fetches and caches them. The reference
pack declares its default in `packs/clinical/models.default.toml` — repo, file, sha256, size
and context size — so the number a run reports stays attributable to exact bytes. Budget
~4.6 GB for the weights, plus KV cache for `ctx_size`.

**Optional: the web dashboard.** It has its own `npm install --prefix web` (`./start` does
both trees for you). It reads the server's `GET /events` stream and draws the stage tree
live — it observes, never drives, and because the graph *is* the run, a stopped run is
legible on sight. It runs beside the server doing the work, so it is desktop-only. You do
not need it to extract or to eval.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md). The short version: no patient data, ever; no number
that was not measured; a bad result stays; and core names no domain.

The corpus needs harder cases more than the harness needs features.

## License

MIT. Contract packs under `packs/` carry CC BY 4.0 separately, so a pack can be forked and
adapted without dragging code terms along.
