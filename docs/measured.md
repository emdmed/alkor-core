# What a run costs, and what it scored

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

**These numbers are from a corpus that no longer exists.** They were measured on 21 notes /
88 graded slots. The corpus is now:

| task | cases | graded expectations |
|---|---|---|
| `vital-signs` | 30 notes | 155 slots |
| `summary` | 10 records | 80 items |
| `note-format` | 15 notes | 65 items |
| `transcript` | 20 dictations | 178 items |
| `shock` | 20 exam payloads | category + residue |
| `sepsis` | 14 qSOFA payloads | screen + criteria |
| `shock-extraction` | 3 prose notes | payload, field by field |

`value` and `unit` have also become sub-gates at 95% — a floor the 81/88 unit row below
fails. The table is kept because it is the evidence those changes were made from, not as a
current result; `packs/clinical/RESULTS.md` says so at the top, and a re-run on the current
corpus has not been made. What follows describes the run as it was.

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
node src/cli.ts eval --profile clinical --from-trace ~/.local/state/alkor/traces/clinical/…jsonl
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
[`packs/clinical/RESULTS.md`](../packs/clinical/RESULTS.md). Results live beside the corpus
they were measured on: change a note or a floor and the old numbers describe a pack that no
longer exists, so an entry there gets a new date rather than an edit.
