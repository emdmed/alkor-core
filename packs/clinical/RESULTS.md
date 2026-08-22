# Vital signs — measured results

What this pack has actually scored, and under what conditions. It lives beside the corpus
rather than in the README because a result belongs to the contract it was measured against:
change a note, a floor or a prompt and everything here is about a pack that no longer
exists, so the entry gets a new date rather than an edit.

Rules for this file:

- **Nothing here is projected, rounded up, or carried over from another corpus.** Every
  figure came out of a run on the notes in `notes/`.
- **The model is what the server reported**, not what `models.default.toml` declares. Those
  differ the moment anyone points `--url` at something else.
- **A bad result stays.** The `0/88` row is the most useful line in the file.
- **A timing is quoted with its machine or not at all.** Speeds here are an iGPU with every
  layer offloaded, one slot, sequential, `cache_prompt` on. Correctness travels between
  machines; throughput does not, and a `tok/s` lifted out of its conditions block is a
  number about hardware nobody named.

**Everything before 2026-08-21 was deleted rather than kept.** Those entries were measured by
a scorer that had ten defects in it — a quote rule one of the two quoting tasks ignored, set
matching that credited "No diabetes mellitus" against `diabet`, sub-gates that passed on a
zero denominator, a `--difficulty` filter two tasks silently ignored, and a declared sampling
that was reported but never sent. Numbers produced by that scorer describe a measurement
nobody can reproduce, and keeping them under a caveat would have invited exactly the
comparison the caveat forbids. `git show HEAD:packs/clinical/RESULTS.md` has them if a
question ever needs the history.

---

## 2026-08-21 (later the same day) — THE CORPUS AND THE GATES BELOW HAVE CHANGED

No new measurement. This entry exists because the rule at the top of this file says a result
belongs to the contract it was measured against, and that contract has since moved:

- **The corpus grew.** Vital signs went from 21 notes / 88 graded slots to 30 / 132; summary
  from 3 records / 13 items to 10 / 56; note formatting from 6 notes / 18 items to 15 / 47.
  The nine new vital-signs notes were written directly against the failure modes in the run
  below — four tabular layouts because `vs-en-17-flowsheet` broke both models in opposite
  directions, three carrying Spanish `lpm`/`rpm`, one whose true figures contradict the
  prompt's own worked example, and one that states a weight and a height and never combines
  them.
- **The gate moved.** Detection was saturated at every tier for both models and is no longer
  the only floor: `valueFloor` and `unitFloor` are sub-gates at 0.95, which is set where the
  81/88 unit rate in the table below FAILS. The note-format task gained an optional
  `fabricationFloor` at 1.0, separating "the model tidied a capital" from "the model invented
  a sentence" — two accusations this very run showed coming apart completely.
- **The pack format moved.** `spec` is 2.

So every number below describes a pack that no longer exists, and none of them may be quoted
as a current result. They are kept because they are the evidence the changes were made from:
the saturation is the argument for the sub-gates, and the flowsheet row is the argument for
the four new tables. The next entry is a re-run on the current corpus, and it has not been
made — this repository has no model in it, and a number nobody measured is the one thing this
file has never carried.

---

## 2026-08-21 — two models, both arms, three tasks, on a fixed harness

The first entry measured after the scorer fixes, and the first where every task, both arms
and both models were run in one sitting against one build.

**Conditions.** `pack 'clinical' spec 1`, 21 notes / 88 graded slots for vital signs, 3
records / 13 items for summary, 6 notes / 18 items for note-format. Temperature 0, `seed` 0,
one run per case, sequential, `cache_prompt` on. `llama-server` with `--jinja --no-webui
--parallel 1 -ngl 99`, ctx 32768, thinking off, AMD Renoir iGPU (Vulkan). Caps from the pack:
1024 for vital signs, 2048 for the other two.

Qwen3-4B-Q4_K_M is the local file whose sha256 `models.default.toml` pins (`7485fe6f…`,
verified before the run; `Q4_K - Medium` as the server reports it). gemma-3-4b-it is
`ggml-org/gemma-3-4b-it-GGUF` snapshot `d097622…`, also `Q4_K - Medium`.

### Vital signs — the gate is detection, floor 90%

`value`, `unit` and `provenance` are shares of what was DETECTED, which is why their
denominators shrink when detection does.

| model | grammar | detection | value | unit | provenance | edited-only | halluc | failed | verdict |
|---|---|---|---|---|---|---|---|---|---|
| Qwen3-4B-Q4_K_M | constrained | 87/88 | 86/87 | 86/87 | 80/87 | 2 | 2 | 0 | PASS |
| Qwen3-4B-Q4_K_M | free | 87/88 | 86/87 | 86/87 | 80/87 | 2 | 2 | 0 | PASS |
| gemma-3-4b-it | constrained | **88/88** | 82/88 | 81/88 | 87/88 | 0 | 3 | 0 | PASS |
| gemma-3-4b-it | free | **0/88** | — | — | — | — | 0 | 21 | **FAIL** |

`edited-only` is the share of the provenance failures that are found once a capital or an
accent is ignored — a model tidying, not a model inventing. It is reported apart because
those are different accusations with different fixes.

**Detection by difficulty**, which is why the tiers are rated:

| model | grammar | d1 | d2 | d3 | d4 | d5 |
|---|---|---|---|---|---|---|
| Qwen3-4B | either | 6/6 | 22/22 | 16/16 | 20/20 | 23/24 |
| gemma-3-4b | constrained | 6/6 | 22/22 | 16/16 | 20/20 | **24/24** |

Detection has saturated for both models at every tier. It is a floor check on this corpus,
not a discriminating benchmark, and the columns beside it are where the two models differ.

### Summary and note-format

| model | grammar | summary items (floor 80%) | halluc | note-format items (floor 75%) | provenance (floor 90%) | derivation (floor 90%) | dose |
|---|---|---|---|---|---|---|---|
| Qwen3-4B | constrained | 13/13 | 1 | 15/18 | **100%** | 97% | 0 |
| Qwen3-4B | free | 13/13 | 1 | 15/18 | **100%** | 97% | 0 |
| gemma-3-4b | constrained | 13/13 | 3 | 15/18 | 94% | 100% | 1 |
| gemma-3-4b | free | 0/13 (3 failed) | — | 0/18 (6 failed) | not measured | not measured | — |

Both models clear the same item-recall floors and miss the same three note-format items. The
sub-gates separate them: Qwen cites perfectly and paraphrases once, gemma derives perfectly
and fabricates two spans.

### What each model got wrong

**Qwen3-4B — 8 failures, and the interesting one is `vs-en-17`.**

| case | what happened |
|---|---|
| vs-en-03-prose | provenance ×2 — quotes lowercased: `'temperature this morning was 37.1 degrees'` where the note capitalises. Counted as `edited-only`: the sentence is there, the model tidied it |
| vs-en-16-addendum | hallucination — emitted a BMI of `22.7 kg/m²` the note does not state |
| vs-en-17-flowsheet | provenance ×5 — **every value correct, every citation invented**: `'BP 121/74'`, `'HR 91'`, `'RR 19'`, `'SpO2 96'`, `'Temp 37.2'`, none of which appear in the note. It read the flowsheet correctly and then wrote its own compact version of the row |
| vs-es-18-mixta | value and unit ×1, hallucination ×1 |
| vs-en-20-discharge | one slot missed (free arm only) |

**gemma-3-4b — 17 failures, an almost disjoint profile.**

| case | what happened |
|---|---|
| vs-en-02-imperial | unit — `F` for `°F` |
| vs-en-06-qualitative | hallucination ×3 — `37 °C`, `94 bpm`, `20 breaths/min` for a note that gives none. `94 bpm` is the figure in the prompt's own worked example |
| vs-es-07, vs-es-18, vs-es-19 | unit ×5 — Spanish `lpm` and `rpm` carried through untranslated |
| vs-es-08-glucemia-repetida | value — took `240`, the first measurement, where the rule says the last |
| vs-es-11-imc-declarado | unit — `kg/m2` for `kg/m²` |
| vs-en-17-flowsheet | value ×5 — **every citation faithful, every value wrong**: it quoted the note correctly and read the wrong row of the flowsheet |
| vs-en-20-discharge | provenance ×1 — `'Weight 72 kg'` is not in the note |

**`vs-en-17-flowsheet` is the case worth keeping.** The two models fail it in exactly opposite
directions: Qwen gets 5/5 values and 0/5 quotes, gemma gets 0/5 values and 5/5 quotes. One
number combining value and provenance would score them identically and describe neither. It is
the clearest argument in this corpus for counting the axes apart.

**Summary hallucinations, both models.** Qwen filed the patient's father's bowel cancer in
`history` as the patient's own problem — the trap `sum-en-01` was written for. gemma kept
amlodipine (stopped in a later note), carried a spirometry already reported, and invented a
pending physiotherapy referral in the thin record.

**note-format.** Both models missed the CKD diagnosis in `fmt-01` and the diabetes history in
`fmt-06`, and both put `'inhaled steroid'` into a section that must be empty — the note names
a drug CLASS and no drug. gemma additionally fabricated two quotes and gave `insulina rapida`
a dose (`'segun pauta'`) the note does not state; Qwen additionally paraphrased once, writing
the item `paracetamol` under a quote that does not contain the word.

### What it cost

| model | grammar | task | generation | prompt | median/case | wall | cache reuse |
|---|---|---|---|---|---|---|---|
| Qwen3-4B | constrained | vital signs | 12.6 tok/s | 87.1 tok/s | 21.6s | 445.2s | 83% |
| Qwen3-4B | free | vital signs | 12.6 tok/s | 82.1 tok/s | 20.5s | 428.2s | 88% |
| gemma-3-4b | constrained | vital signs | 14.2 tok/s | 96.0 tok/s | 24.1s | 511.2s | 59% |
| gemma-3-4b | free | vital signs | 14.2 tok/s | 92.9 tok/s | 23.8s | 506.4s | 63% |
| Qwen3-4B | constrained | summary / note-format | 13.4 / 12.6 tok/s | — | 10.8s / 15.1s | 33.6s / 111.6s | 48% / 70% |
| gemma-3-4b | constrained | summary / note-format | 14.0 / 14.1 tok/s | — | 12.0s / 22.8s | 37.8s / 145.0s | 39% / 56% |

Transport is under 1.4s across every run of 7-9 minutes. Whatever is slow here, it is not the
harness. gemma generates ~13% faster per token than Qwen and still finishes slower per note,
because it emits more tokens per answer and reuses less of the cache.

**The failing arm is no longer the expensive one.** The gemma free run took 506s against the
constrained run's 511s. Before the retry fix it took 987s — a parse failure was retried with a
byte-identical request against a greedy sampler, so every one of the 30 cases paid twice for
the same answer and none recovered.

### The unconstrained arm: 0/88, and what is underneath it

gemma wrapped **all 30 replies across the three tasks** in a ```json fence, so nothing parsed.
The eval does not strip the fence: an application that does not strip it gets nothing either,
and scoring it as a success would measure a leniency the product does not have. The parser
names it as a fence rather than as broken JSON, which is the difference between a one-line fix
and an afternoon.

Re-scoring those same traced completions with the fence stripped and no model running gives
**84/84 detection, 13/13 summary items, 15/18 note-format items** — the same failures and the
same numbers as the constrained arm. Two vital-signs cases stay unparseable even then, because
they emitted `{"value": null}` where the contract allows exactly one spelling of absent.

So on this corpus the grammar buys **format compliance and 4 slots**, not accuracy. For Qwen it
buys nothing at all: its two arms are identical on every column of every task.

### A run is reproducible; it is not bit-identical

Measured rather than assumed. `vs-en-16-addendum`, same model, same bytes, scored twice — once
inside the 21-note run and once inside a 5-note `--difficulty 5` run:

    full run:  "raw_text": "weight 61.4 kg"
    subset:    "raw_text": "Weight 61.4 kg"

Four of the five d5 notes were byte-identical across those two runs; this one was not. The
cause is `cache_prompt`: a different set of preceding notes leaves a different KV prefix, which
changes how the batch is split, which changes the last bits of the logits, which flips a
near-tied argmax. One capital letter — and under this pack's case-sensitive quote rule, that is
the difference between a verified span and a failure. The request body pins `seed`, which does
not fix it and was never going to: the seed is not where the nondeterminism is.

**Treat a scoped run as its own measurement, not as a slice of a full one.** The `difficulty`
field in the trace's `run` event is what says which one you are reading.

### Traces

Every completion, every tally, and a `run` event naming the model, the URL, the grammar, the
sampling and the pack — plus a closing `record` with a sha256 per contract file the run read.

    Qwen3-4B  constrained  2026-08-21T13-36-26-580Z.jsonl
    Qwen3-4B  free         2026-08-21T13-46-44-703Z.jsonl
    gemma     constrained  2026-08-21T13-56-36-687Z.jsonl
    gemma     free         2026-08-21T14-08-51-627Z.jsonl

under `$XDG_STATE_HOME/medextract/traces/clinical/`, which is outside this repository on
purpose. They hold completions verbatim because `pack.toml` declares `corpusSynthetic = true`;
a pack that does not say gets its trace content elided to a digest.

## Dictated transcripts — 2026-08-22

First graded run of the `transcript` task, on the twelve transcripts added the same day.

    Qwen3-4B-Q4_K_M.official.gguf   constrained   llama.cpp b10333-08659901c4
    ctx 32768 · 1 slot · -ngl 99 · --jinja · sequential, cache_prompt on
    temp 0 · max_tokens 2048 · 12 transcripts · 73 required items · 1 run each

| gate | measured | floor | |
|---|---|---|---|
| item recall | **82%** (60/73) | 65% | pass |
| provenance | **100%** (54/54) | 85% | pass |
| derivation | **91%** (61/67) | 85% | pass |
| nothing invented | **100%** (54/54) | 100% | pass |

54 items emitted, 5 hallucinations, 3 dose errors, 0 edited-only quote failures, 0 failed
runs. 11.4 tok/s generation (3119 tokens in 272.6 s), prompt 71.9 tok/s with 93% cache reuse,
median 22.8 s per transcript, 296.2 s wall. Trace
`2026-08-22T02-35-46-953Z.jsonl`.

**Measured twice, against two versions of the answer key.** The first pass
(`2026-08-22T02-21-54-849Z.jsonl`) ran before the merged-item trap below existed and reported
3 hallucinations; the key was then tightened and the run repeated. The completions are
byte-identical between the two — same 3119 tokens, same misses, same quotes — so the whole
difference is what the key could see. Item recall, provenance and derivation are unchanged,
because an `absent` expectation is not a gated item: only the hallucination count moved, from
3 to 5. Both numbers are recorded rather than the second replacing the first, because the
distance between them is the measurement.

**The floors above are still the provisional ones.** They were not moved to fit this run and
should not be moved on one model's one pass; the numbers are recorded here so a second model
has something to be compared against.

### Not one quote was invented, and it did not save the Spanish case

`tr-es-10-consulta` scored 2/7 with **4/4 quotes verifying character for character** — and
every derived `text` in it was an English translation of the Spanish span it cited:

    quote  "de antecedentes tiene fibrilación auricular desde 2017 y una artrosis de cadera"
    text   "fibrillation since 2017 and hip osteoarthritis"

Provenance alone calls that a perfect answer. Deletion-only derivation caught all five, which
is the clearest evidence this pack has produced for keeping the two checks apart: the rule was
added to stop `ceftriaxona` becoming `ceptriaxona`, and it turns out to catch a whole-language
substitution by the same mechanism and without being told about languages at all. Five of the
run's six derivation failures are this one case. The other is `tr-en-04`, where the model added
the word "follow-up" to a plan item — the ordinary kind.

English 54/61 (89%), Spanish 6/12 (50%). The gap is almost entirely this one behaviour.

### A retraction is over-corrected, not mis-corrected

The axis the corpus was built for came out the opposite way round from the expected failure.
Neither self-correction case put the *superseded* value in the answer. Both dropped the
**corrected** drug entirely:

- `tr-en-02` — "amlodipine 5 mg once daily no actually make that 10 mg once daily" produced no
  amlodipine item in either `plan` or `current_medication`. Apixaban, mentioned without any
  correction, came through fine.
- `tr-es-11` — "metamizol 575 mg no espera mejor paracetamol 1 g" produced
  `current_medication: []`. The retracted drug was correctly suppressed and the substituted one
  went with it.

So the model treats "no / actually / espera" as *delete this whole subject* rather than
*replace what precedes it*. That is the safer of the two directions — a dropped drug is a
visible omission and a superseded dose is an invisible error — but it is a 4-item loss across
two cases, and it is a prompt problem rather than a reading problem: the instruction says the
abandoned version must not appear and never says the corrected one must.

### Everything else that went wrong

- `tr-en-09` put two negation runs into `history` ("no significant past medical history", "no
  fever no rash no difficulty swallowing"), which the `empty` expectation caught as 2
  hallucinations. It also gave microgynon a dose of "two years" — a duration read as a dose.
- `tr-en-05` wrote `dose: "[inaudible] milligrams"` rather than null. It quoted honestly and
  refused to invent a number, which is the important half; it did not know that an unheard
  dose is an absent dose.
- `tr-en-06` filled the empty plan with "nothing was decided today" — the sentence that says
  the plan is empty, emitted as the plan.
- `tr-en-01`, `tr-en-12` lost the second fact in a two-fact sentence: "type 2 diabetes ... and
  hypertension" yielded one item, and osteoporosis went missing from a sentence naming it
  beside rheumatoid arthritis.
- `tr-en-07` made the patient identifier line ("mrs joan whitaker aged 78 seen at home with her
  daughter") the presenting complaint and filed the breathlessness under history. The third
  party trap itself held: nothing of the daughter's appeared anywhere.

### Two drugs in one item, and the key that could not see it

`tr-en-12` merged three drugs into ONE medication item — `text` naming all three, `dose`
holding all three schedules:

    text  "methotrexate 15 mg once weekly and folic acid 5 mg once weekly on a different
           day and alendronic acid 70 mg once weekly"
    dose  "15 mg once weekly, 5 mg once weekly on a different day, 70 mg once weekly"

Under the original key that scored **3/3 on the drugs with no dose error**, because a set
matcher looking for "folic acid" finds it in a merged string exactly as well as in its own
item. Every quote verified, every derivation held, and the contract's one-item-per-drug rule
— the whole reason `text` is a bare drug name — was simply not being checked.

This is the failure `note-format.schema.json` predicted under `medicationIsNamesOnly`: no JSON
Schema keyword can express "text must be a single drug name", so the schema said the prompt
would have to ask and the eval would have to measure. The eval was not measuring.

The fix is an `absent` expectation whose AND-group is two DRUG NAMES — an item matching both is
one item that should have been two — and it is on **all six** multi-drug cases rather than on
the one where the failure was seen. A check written only where a model already failed is a
check fitted to a run.

Putting it on all six paid immediately. It fires on two cases, not one:

- `tr-en-12`, as expected.
- `tr-es-10`, which merged apixabán and bisoprolol the same way. The first run saw only a dose
  error there and reported the merge as a wrong dose, which is a different accusation about a
  different defect.

Item recall does not move — `tr-en-12` still reports 6/8 and the run still reports 60/73 — and
that is correct rather than a shortfall: the model did name all three drugs, so the recall
number was never the wrong one. What was wrong was that a badly-shaped answer and a
well-shaped one produced the same report. They no longer do.

### 2026-08-22, later — reproduced on a second server, and the floors are now measured

The run above was repeated on a **fresh `llama-server` process**, same weights (sha256 verified
`7485fe6f…` against the bytes on disk before starting), same flags, same pack, tightened key.

    item recall 82% (60/73) · provenance 100% (54/54) · derivation 91% (61/67) · invented 0
    54 items emitted · 5 hallucinations · 3 dose errors · 0 edited-only · 0 failed runs

Every case scored the same, every miss was the same miss, and the run emitted the same 3119
completion tokens. Trace `2026-08-22T03-51-24-067Z.jsonl`. Cost differed, as it should: 11.9
tok/s generation, 87.5 tok/s prompt at 85% cache reuse, median 21.9 s, 302.7 s wall, first case
47.1 s on a cold cache. **Correctness reproduced; throughput did not, and only one of those is
a property of the model.**

**The four provisional floors are replaced.** They were set before any model saw this corpus,
by adjusting the note-format floors downward, and `transcript-cases.json` said so. They now
read from what two agreeing runs support:

| gate | was | now | measured |
|---|---|---|---|
| item recall | 0.65 | **0.80** | 0.82 (60/73) |
| provenance | 0.85 | **0.95** | 1.00 (54/54) |
| derivation | 0.85 | **0.90** | 0.91 (61/67) |
| nothing invented | 1.00 | **1.00** | 1.00 (54/54) |

Each sits slightly under its measurement rather than on it. At temperature 0 this task is
deterministic, so a floor set exactly at the number would fail on any change at all — a prompt
edit, a llama.cpp release that re-tokenises one span — and the pack would spend its failures on
noise instead of on regressions. The margins are about one item each. Fabrication is not a rate
to trade against and stays at 1.0.

The earlier entry declined to move these on one model's one pass, which was right at the time.
What changed is not the model's score but the number of runs behind it: a floor under a
reproduced result is a claim, and a floor under a single pass is a guess with a decimal point.

**The decision this phase exists to record: yes, this contract is good enough to build a runtime
on, as measured.** 82% recall clears the provisional gate by seventeen points, so the recall
figure is not a prompt bug and no upstream prompt work is owed before an application reads this
pack. Provenance is perfect and deletion-only derivation caught a whole-language substitution
that provenance alone called a perfect answer — the two checks the app must reimplement are the
two carrying the run.

What is **not** endorsed by that decision, and what any application reading this pack inherits:

- **Spanish is half a task.** 6/12 items, and five of the run's six derivation failures are
  `tr-es-10` translating its own quote into English. An app can show this — a failed derivation
  is a visible state — but it cannot fix it, and the bilingual claim is not measured until this
  moves.
- **Merged medication items survive every check.** Two runs, two cases (`tr-en-12`, `tr-es-10`),
  quotes verifying and derivations holding on an item that should have been three. Only the
  answer key sees it. A runtime has no equivalent, which means one-drug-per-item is a rule the
  app cannot enforce and should not imply it has.
- **Thirteen dictated items are simply absent** from the reading, including a hypertension in
  the baseline case. Recall is a floor, not a finding.

### 2026-08-22 — a second model, and it is better

`gemma-3-4b-it-Q4_K_M` (sha256 `04a43a22…`), same harness, same flags, same key, same machine.

| gate | gemma-3-4b | Qwen3-4B | floor |
|---|---|---|---|
| item recall | **89%** (65/73) | 82% (60/73) | 80% |
| provenance | **100%** (58/58) | 100% (54/54) | 95% |
| derivation | **96%** (70/73) | 91% (61/67) | 90% |
| nothing invented | **100%** | 100% | 100% |

58 items emitted, 3 hallucinations, 1 dose error, 0 failed runs, 13.8 tok/s, 250.4 s wall.

**The model this pack's floors were measured on is not the best model on this task**, and that is
the finding. Five more of the seventy-three items, and the derivation gap closes almost entirely:
gemma answers `tr-es-10` in Spanish, so the whole-language substitution that cost Qwen five of its
six derivation failures does not happen. Both clear every floor, so nothing here is a regression —
it is the second data point the entry above said this file was waiting for.

Two things stop this from being a recommendation on its own:

- **One run each.** These are deterministic tasks and both runs reproduced within themselves, but a
  seven-point gap on 73 items is five items, and five items is not a large sample.
- **The other arm.** gemma scored 0/88 UNCONSTRAINED on this pack's neighbouring tasks — every
  reply fenced — where Qwen degraded gracefully. That says nothing about the constrained numbers
  above, and it says something about what happens the day a grammar is unavailable.

Where they fail differently is more useful than which is ahead. gemma invents nothing here — the
expectation that it would fabricate spans, carried over from the note tasks, did not hold on
speech. What it does instead is emit a negated history item on `tr-en-09` where the correct answer
is an empty section, and put a retracted `ramipril` in the plan on `tr-en-02` — the retraction trap,
which Qwen passed.
