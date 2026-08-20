# Vital signs — measured results

What this pack has actually scored, and under what conditions. It lives beside the corpus
rather than in the README because a result belongs to the contract it was measured against:
change a note, a floor or a prompt and everything here is about a pack that no longer
exists, so the entry gets a new date rather than an edit.

Rules for this file:

- **Nothing here is projected, rounded up, or carried over from another corpus.** Every
  figure came out of a run on the notes in `notes/`.
- **The model is what the server reported**, not what `models.default.toml` declares. Those
  differ the moment anyone points `--url` at something else, which is exactly what happened
  below.
- **A bad result stays.** The 0/46 row is the most useful line in the file.

---

## 2026-08-20 — three models, constrained and free

**Conditions.** `pack 'clinical' spec 1`, 12 notes, 46 graded slots, temperature 0,
`max_tokens` 1024, one run per note, `llama-server` with `--jinja --no-webui --parallel 1`,
thinking off. Qwen3-4B is the local file whose sha256 `models.default.toml` pins
(`7485fe6f…`); the other two are whatever `llama-server -hf` resolved from
`Qwen/Qwen3-1.7B-GGUF` and `ggml-org/gemma-3-4b-it-GGUF` on the day. Harness at commit
`1589075`, on an AMD Renoir iGPU (Vulkan).

| model | grammar | detection (gate, floor 90%) | value | unit | provenance | halluc | failed runs | verdict |
|---|---|---|---|---|---|---|---|---|
| Qwen3-4B-Q4_K_M | constrained | 46/46 | 46/46 | 46/46 | 46/46 | 0 | 0 | PASS |
| Qwen3-4B-Q4_K_M | free | 46/46 | 46/46 | 46/46 | 46/46 | 0 | 0 | PASS |
| Qwen3-1.7B | constrained | 46/46 | 45/46 | 46/46 | 40/46 | 1 | 0 | PASS |
| Qwen3-1.7B | free | 44/46 | 44/44 | 44/44 | 38/44 | 2 | 0 | PASS |
| gemma-3-4b-it | constrained | 46/46 | 45/46 | 42/46 | 46/46 | 3 | 0 | PASS |
| gemma-3-4b-it | free | 0/46 | — | — | — | — | 12 | **FAIL** |

`value`, `unit` and `provenance` are shares of what was *detected*, which is why their
denominators shrink when detection does.

### What each model got wrong

**Qwen3-4B — nothing.** Both arms, every metric. That is a fact about the corpus: on these
notes it is a floor check, not a discriminating benchmark, and it does not yet show what a
grammar buys. Harder cases are the fix, and they will lower this row.

**Qwen3-1.7B, constrained** — 8 failures:

| case | field | failure |
|---|---|---|
| vs-en-03-prose | blood_pressure, heart_rate, respiratory_rate, temperature, oxygen_saturation | quote — all five paraphrased: `'heart rate 88 beats per minute'` where the note says *"the heart rate had settled to 88 beats per minute"* |
| vs-en-06-qualitative | temperature | hallucination — emitted `37.1 °C` for "febrile" |
| vs-es-08-glucemia-repetida | blood_glucose | value — took `240`, the first measurement, where the rule says the last |
| vs-es-11-imc-declarado | bmi | quote — wrote `kg/m²` inside a quote of a note that says `kg/m2` |

Every one of the six provenance failures carries the **right number** attached to a sentence
that is not in the note. A grammar cannot catch this: no JSON Schema keyword expresses
"substring of the prompt" and GBNF has no back-reference to the context.

**Qwen3-1.7B, free** — the same six provenance failures, plus two missed readings
(`heart_rate`, `respiratory_rate` on the imperial note) and a second hallucination
(`112 bpm` for "tachycardic"). Detection 44/46 against 46/46 constrained: requiring every
key and permitting a null value is what makes the model visit every slot.

**gemma-3-4b-it, constrained** — 8 failures, and a completely different profile from the
same-sized Qwen: provenance perfect, units 42/46.

| case | field | failure |
|---|---|---|
| vs-en-02-imperial | temperature | unit — `F` for `°F` |
| vs-es-07-bloque | heart_rate, respiratory_rate | unit — kept the Spanish `lpm` and `rpm` |
| vs-es-11-imc-declarado | bmi | unit — `kg/m2` for `kg/m²` |
| vs-en-06-qualitative | temperature, heart_rate, respiratory_rate | hallucination — `37 °C`, `94 bpm`, `20 breaths/min` |
| vs-es-08-glucemia-repetida | blood_glucose | value — `240` again, the first measurement |

Two 4B models, opposite failure modes. This is the argument for counting value, unit and
provenance apart rather than reporting one accuracy.

Worth noting: `94 bpm` is the exact figure in the prompt's own worked example. When this
model decides to fill a slot it has no evidence for, it reaches for the example. An argument
for writing the next cases *against* the prompt rather than alongside it.

**gemma-3-4b-it, free — 0/46, twelve parse failures.** It wrapped every single reply in a
` ```json ` fence, so nothing parsed.

This is a **format** failure, not a capability failure, and the distinction is measurable
rather than assumed: re-scoring the traced completions offline with the fence stripped — no
model running — gives **45/45 detection**, with one case still failing because it emitted
`{"value": null}` where the contract allows exactly one spelling of absent. The grammar makes
both impossible: it cannot emit a backtick outside the JSON, and it cannot take the null
branch inside a measurement.

The eval does not strip the fence for you. An application that does not strip it gets nothing
either, so scoring it as a success would measure a leniency the product does not have — but
the parser names the failure as a fence rather than as broken JSON, so nobody debugs the
wrong thing.

### What this run changed in the harness

Two gaps, both found by having a result to interrogate rather than by review:

1. The eval traced tallies but not completions, so checking a suspiciously perfect score meant
   re-running the model by hand. Completions are now traced — which is the only reason the
   gemma re-scoring above was possible at all.
2. The trace did not record *which model answered*, so these seven runs were mapped to models
   by timestamp. A `run` event now opens every trace with the model the server reported, the
   URL, whether a grammar was used, the sampling, and the pack's name and spec — and a
   `record` event closes it with the harness version and a sha256 per contract file the run
   read. A run recorded after 2026-08-20 states its own provenance; the rows above were
   reconstructed by hand, which is precisely why it exists.
