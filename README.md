# medextract

A harness for validating local-model extraction from clinical notes.

You write a **contract pack** — the prompts, JSON schemas and eval cases your application
actually uses — and `medextract` scores a model you run yourself against it, with a gate,
a trace and a reproducible number. The pack is data, so the same files can be read by your
application's own runtime: the number then describes the product rather than a rehearsal
of it.

```bash
node src/cli.ts eval --profile clinical --constrain
```

> **Status: pre-release.** The harness, the pack format, the reference clinical pack and
> its corpus are here and tested. Every number below was measured on the corpus that ships
> in this repository, against weights named by sha256. See [Measured](#measured) — including
> what the result does *not* show.

## What this is, and what it is not

**It is** a measuring instrument for one specific job: *does this local model extract this
contract from these notes well enough to ship?*

**It is not a generic eval framework.** promptfoo, Inspect and lm-eval measure prompts
against models across many tasks. This measures one contract against one runtime, and the
contract is the artifact production reads. Narrower on purpose.

**It is not an inference server.** It talks to a `llama-server` you started. A server's
flags are part of a measurement and outlive many runs, so the harness will not start one
behind your back.

**It is not a medical device**, not clinical decision support, and not validation evidence
for any regulator. What it measures is up to whoever points it.

## Why a harness rather than a script

Three things about constrained extraction from clinical text are counter-intuitive enough
that everyone rediscovers them the expensive way. They are why this is a harness:

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
              client.ts    llama-server transport (temperature 0, cache_prompt)
              tools.ts     the tool CONTRACT — core defines no tools
              trace.ts     JSONL tracing with a per-profile redaction hook
src/modes/    extract.ts   single-shot constrained extraction, one retry
              agentic.ts   the tool loop, for one task run to completion
              session.ts   the same loop, multi-turn, with a consent gate
src/profiles/ clinical/    the reference profile: reads the pack below, names no vital sign
              coding/      the agentic worked example: six tools, no pack
packs/        clinical/    the reference pack — prompt, schema + golden, cases, 12 notes
src/index.ts  the public API — what a profile is written against
src/cli.ts    eval, agent, profiles
profiles.toml the only file that may name a project outside this repository
```

The swappable unit is the **execution mode**, not the toolset:

- **`extract`** — single-shot constrained output over one document. No tool loop.
- **`agentic`** — a tool-calling loop.

Extraction and agentic work are different shapes. Forcing extraction into an agent loop
would be slower, less reliable, and much harder to validate.

## Contract packs

A pack is a **directory belonging to your project**, holding its prompts, schemas,
vocabularies and eval cases. It describes itself with a `pack.toml` manifest, and the
harness reads files by manifest **key** — never by path.

```toml
# your-project/contracts/pack.toml
spec = 1
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
npm run profiles        # what is configured

# start a server yourself — its flags are part of the measurement
LLAMA_PORT=8082 LLAMA_MODEL=~/models/Qwen3-4B-Q4_K_M.gguf scripts/llama-server.sh -ngl 99

node src/cli.ts eval  --profile coding
node src/cli.ts agent --profile coding --task "fix the failing test" --workspace /tmp/wk
```

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

## Traces

Every run writes JSONL to `${XDG_STATE_HOME:-~/.local/state}/medextract/traces/<profile>/`
— **outside any repository**, deliberately. A trace line contains the raw prompt and the
raw completion, which for a clinical profile means the note. A profile that handles patient
data supplies a `redact` hook and must set one before tracing anything real.

## Measured

Temperature 0, `max_tokens` 1024, one run per note, 12 notes / 46 graded slots. Qwen3-4B is
the local file whose sha256 `packs/clinical/models.default.toml` pins; the other two are
whatever `llama-server -hf` resolved from `Qwen/Qwen3-1.7B-GGUF` and
`ggml-org/gemma-3-4b-it-GGUF` on 2026-08-20.

| model | grammar | detection (gate) | value | unit | provenance | halluc | failed |
|---|---|---|---|---|---|---|---|
| Qwen3-4B-Q4_K_M | constrained | 46/46 | 46/46 | 46/46 | 46/46 | 0 | 0 |
| Qwen3-4B-Q4_K_M | free | 46/46 | 46/46 | 46/46 | 46/46 | 0 | 0 |
| Qwen3-1.7B | constrained | 46/46 | 45/46 | 46/46 | 40/46 | 1 | 0 |
| Qwen3-1.7B | free | 44/46 | 44/44 | 44/44 | 38/44 | 2 | 0 |
| gemma-3-4b-it | constrained | 46/46 | 45/46 | 42/46 | 46/46 | 3 | 0 |
| gemma-3-4b-it | free | **0/46** | — | — | — | — | **12** |

Four things in that table are the reason this repository exists.

**A saturated row is not a good result.** Qwen3-4B scores perfectly on every metric with and
without a grammar. That is a statement about the corpus, not the model: on these notes it is
a floor check rather than a discriminating benchmark. Quoting the 46/46 without this sentence
would be a misleading number rather than an impressive one.

**Models of the same size fail in different places.** gemma-3-4b matches Qwen3-4B on
detection and provenance and loses four points on units — it writes `F` for `°F`, keeps
`lpm` and `rpm` from the Spanish note, and spells BMI `kg/m2`. Qwen3-1.7B has the opposite
profile: units perfect, provenance 40/46, because on the prose note it *paraphrases* the
sentence it claims to be quoting. One number would have hidden both. This is why value,
unit and provenance are counted apart.

**The provenance check earns its place.** Every one of Qwen3-1.7B's six provenance failures
carries a correct value attached to a sentence that is not in the note. No JSON Schema
keyword can express "substring of the prompt" and GBNF has no back-reference to the context,
so a grammar cannot catch this — only comparing the quote to the note can.

**`0/46` is what an unconstrained contract looks like on the wrong day.** gemma-3-4b wrapped
every single unconstrained reply in a ```json fence, so nothing parsed. Re-scoring those same
traced completions with the fence stripped gives 45/45 detection — the model could read the
notes perfectly well, it just would not answer in the format asked for, and one case also
emitted `{"value": null}` where the contract allows exactly one spelling of absent. The
grammar makes both impossible: it cannot emit a backtick outside the JSON, and it cannot
take the null branch inside a measurement. The eval refuses to strip the fence for you,
because an application that does not strip it gets nothing either — but it names the failure
as a fence rather than as broken JSON, so nobody spends an afternoon on the wrong bug.

Reproduce any row:

```bash
LLAMA_PORT=8081 LLAMA_MODEL=~/models/Qwen3-4B-Q4_K_M.gguf scripts/llama-server.sh \
  -ngl 99 --no-webui --parallel 1
node src/cli.ts eval --profile clinical --constrain            # add --url for another port
```

Every case's full completion goes into the trace, and a `run` event at the top of each trace
records the model the server reported, the URL, whether a grammar was used and the sampling.
So a suspiciously perfect score is checked by reading a file rather than by re-running the
model — which is how the gemma re-scoring above was done, with no model running at all.

The per-case breakdown behind this table, and the conditions each row ran under, are in
[`packs/clinical/RESULTS.md`](packs/clinical/RESULTS.md). Results live beside the corpus
they were measured on: change a note or a floor and the old numbers describe a pack that no
longer exists, so an entry there gets a new date rather than an edit.

## Status

| | |
|---|---|
| harness core, modes, tracing | done, tested |
| pack format (`spec = 1`) | done |
| out-of-tree profiles and packs | done |
| public API (`medextract` entry point) | done |
| agentic worked example (`coding`) | done |
| reference clinical pack + corpus | done — 12 notes, 46 graded slots, three models measured |
| harder cases for that corpus | next — Qwen3-4B saturates it |
| `validate` verb, run records, CI | planned |

The reference pack is a synthetic, bilingual corpus with a per-case answer key that states
what each case discriminates. It is synthetic from the first commit and will never be
derived from a real record — a public clinical corpus is the single most likely place for
patient data to enter a repository, and there the mistake is unrecoverable.

## Requirements

Node ≥ 24. The CLI is plain TypeScript run natively by Node — no bundler, no transpile,
no build step. What you read is what runs.

## License

Apache-2.0. Contract packs under `packs/` carry CC BY 4.0 separately, so a pack can be
forked and adapted without dragging code terms along.
