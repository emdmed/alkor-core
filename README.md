# alkor

Pull structured medical data out of clinical notes with a small local model — and know
what it is worth before you ship it.

You write a **contract pack** — the prompts, JSON schemas and eval cases your application
actually uses. `extract` runs that contract over a note and gives you the JSON. `eval` runs
the same contract over a corpus and gives you a gate, a trace and a reproducible number.
One assembly feeds both, so what was measured is what runs. The pack is data, so your own
application's runtime reads the same files: the number describes the product rather than a
rehearsal of it.

```bash
node src/cli.ts extract --profile clinical --note your-note.txt --constrain   # the job
node src/cli.ts eval    --profile clinical --constrain                        # what it is worth
```

> **Status: pre-release.** The harness, the pack format, the reference clinical pack and
> its corpus are here and tested. Every number below was measured on the corpus that ships
> in this repository, against weights named by sha256. See [Measured](docs/measured.md#measured) — including
> what the result does *not* show.

## Quickstart

You need **Node ≥ 24** and **`llama-server`** from
[llama.cpp](https://github.com/ggml-org/llama.cpp) on your `PATH`. This harness does not
bundle an inference engine and does not download weights — it talks to a server you start.

If you want the dashboard, one command does all of it — checks the Node version, installs
both dependency trees, verifies the engine and the declared weights are present, then starts
the interactive server and the dashboard together and stops them together:

```bash
./start           # or: npm start
./start --check   # run the checks and change nothing
```

For the CLI path, the same checks are a verb. `doctor` looks for the engine, for the weights
the pack declares, and for a server on the port the profile names — it installs nothing and
starts nothing, it just says which of the three is absent and prints the command that
supplies it:

```bash
npm install
npm test          # passes with no server and no model
node src/cli.ts doctor --profile clinical
```

The same check runs ahead of `extract`, `eval`, `route` and `agent`, so a missing piece is
one sentence in milliseconds rather than a transport failure per case.

Start a server. `LLAMA_HF` names a Hugging Face repo that `llama-server` downloads and
caches itself, so a fresh machine needs no separate download step — this is the reference
pack's declared default model (~4.6 GB, see `packs/clinical/models.default.toml`):

```bash
LLAMA_PORT=8081 LLAMA_HF=ggml-org/gemma-4-E4B-it-GGUF \
  scripts/llama-server.sh -ngl 99 --no-webui --parallel 1
```

In another shell, extract from a note that ships in this repository — no file of your own
needed, and the same note the eval grades:

```bash
node src/cli.ts extract --profile clinical --case vs-en-03-prose --constrain
```

Then run the gate over the whole corpus, which is the part that says what the extraction is
worth:

```bash
node src/cli.ts eval --profile clinical --constrain
```

From here: [Extracting from one note](docs/running.md#extracting-from-one-note) for the
verb and its output, [Contract packs](docs/packs.md) to point it at your own prompts and
schemas, and [the task list](docs/tasks.md) for what else the reference pack grades.
`npm run profiles` lists what is configured.

## Contents

This file is the short version: what the project is, how to start it, and what state it is
in. Everything that takes more than a screen lives beside it under `docs/`.

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

Each profile declares its own server URL in `profiles.toml`, so a workflow may talk to
multiple llama-server instances on different ports, each loaded with a different model or
quantisation.

The harness never starts servers for evals — server flags are part of a measurement. The
interactive server (`src/server.ts`) is the exception: `LlamaManager` spawns a backend on
first request, polls `/health` until ready, and sweeps it after `ALKOR_IDLE_MS`
(default 120s) of idle time. Pinned profiles (the router) are never swept. In-flight
request counting prevents killing a backend mid-generation.

One retry on transport failures (server unreachable, HTTP error). Parse failures are not
retried — at temperature 0 the same request produces the same output, and measuring that
30/30 cases recover zero is more useful than doing it in production.

## Status

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
| both models re-measured on the grown corpus | next — the entry `RESULTS.md` is waiting for |
| `validate` verb | planned |

The reference pack is a synthetic, bilingual corpus with a per-case answer key that states
what each case discriminates. It is synthetic from the first commit and will never be
derived from a real record — a public clinical corpus is the single most likely place for
patient data to enter a repository, and there the mistake is unrecoverable.

## Requirements

**Node ≥ 24.** The CLI is plain TypeScript run natively by Node — no bundler, no transpile,
no build step. What you read is what runs.

**`llama-server` from [llama.cpp](https://github.com/ggml-org/llama.cpp), on your `PATH`.**
Not bundled and not started for you: a server's flags are part of a measurement, so the
harness talks to one you control. Only the interactive server (`src/server.ts`) spawns
backends, and only on demand.

**A GGUF model.** Nothing here downloads weights, but `llama-server` does: pass
`LLAMA_HF=<repo>` to `scripts/llama-server.sh` and it fetches and caches them. The
reference pack declares its default in `packs/clinical/models.default.toml` — repo, file,
sha256, size and context size — so the number a run reports stays attributable to exact
bytes. Budget ~4.6 GB for the weights plus KV cache for `ctx_size`.

One thing is opt-in and needs more: the **web dashboard** has its own `npm install
--prefix web`. It is not needed to extract or to eval.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md). The short version: no patient data, ever; no number
that was not measured; a bad result stays; and core names no domain.

The corpus needs harder cases more than the harness needs features.

## License

Apache-2.0. Contract packs under `packs/` carry CC BY 4.0 separately, so a pack can be
forked and adapted without dragging code terms along.
