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

### 2026-08-22, later still — a thirteenth transcript, and the derivation gate goes red

`tr-es-13-control` was added after a short Spanish dictation failed repeatedly in the consuming
application. It is 191 characters, has no retraction, no aside, no inaudible span and no dictated
markup — none of the axes this corpus was built for — and it takes the task through a floor.

    Qwen3-4B-Q4_K_M.official.gguf   constrained   same flags, same machine
    temp 0 · max_tokens 2048 · 13 transcripts · 77 required items · 1 run each

| gate | 13 transcripts | 12 transcripts | floor | |
|---|---|---|---|---|
| item recall | **81%** (62/77) | 82% (60/73) | 80% | pass |
| provenance | **100%** (59/59) | 100% (54/54) | 95% | pass |
| derivation | **85%** (63/74) | 91% (61/67) | 90% | **FAIL** |
| nothing invented | **100%** (59/59) | 100% (54/54) | 100% | pass |

59 items emitted, 8 hallucinations, 5 dose errors, 0 edited-only quote failures, 0 failed runs.
11.3 tok/s (3617 tokens in 319.5 s), 93% prompt cache reuse, median 23.5 s, 344.8 s wall. Trace
`2026-08-22T14-23-13-176Z.jsonl`.

**Nothing regressed.** The twelve-case portion of this run reproduces the 2026-08-21 measurement
item for item — 60/73 recall, 54/54 provenance, 61/67 derivation — three weeks of harness changes
later and on a different server process. The entire movement in the table is the one new case, and
the new case scores 2/4 items with 2/7 derivations.

**The floors were not moved.** Derivation is six points under and the task fails. `_floorsMargin`
in the case file predicted this in as many words — "the number is one behaviour away from moving a
long way in either direction and the floor should notice when it does" — because five of the six
derivation failures were a single Spanish case translating its quote. There are now two such cases
and the prediction paid out on the first opportunity. Relaxing the floor to accommodate a real
defect would spend the one measurement this pack has that noticed it.

#### What the case shows that tr-es-10 did not

The translation behaviour is the same and it is worth recording that a *short* transcript does not
escape it — the standing hope was that the model drifted into English on long Spanish input, and
191 characters is not long. Beyond that, two failures with no analogue anywhere in the corpus:

- **The ASR mangled both drug names, and the mangle is the correct answer.** The recording gave
  `amblodipina` for amlodipino and `en la laperil` for enalapril. Deletion-only derivation makes
  repairing either one a violation, which is the right rule: a silently corrected drug name is a
  prescription the recording does not contain and is indistinguishable downstream from a good
  reading. The model preserved both, so this is the one thing it got right, and no case before this
  one tested it — every other transcript spells its drugs correctly.
- **Spoken doses are normalised into written ones.** `10 miligramos` came back as `10 mg` and
  `2,5 cada 8` as `2.5 every 8`. Both are graded twice, as derivation failures (`mg` and `2.5` are
  characters the transcript never contained) and as dose errors against a key spelled as dictated.
  Two of the run's five dose errors are this.

The visit also has no plan — `viene para control de salud` is a reason for attendance and
`está todo bien` is a finding — and the model filed `health check` under `plan`, which the `empty`
expectation catches. `presenting_complaint` swallowed the entire transcript, history and drug list
included, which two `absent` expectations catch.

**The corpus is now 13 and the Spanish third still scores 50%** (8/16 items), the same figure it
scored at 12. Adding a fourth measurement to that axis moved it not at all, which is a firmer
statement about the language gap than the original 6/12 was.

**This is a prompt problem, not a model problem** — gemma-3-4b answered `tr-es-10` in Spanish under
the identical prompt. Re-measure and raise the floors when the transcript prompt states the output
language; until then the red gate is the finding.

### 2026-08-22, later still again — the prompt was missing a sentence, and it cost 14 points

The red gate above is closed. `prompts/transcript.md` never stated what language to answer in,
and `tr-es-13-control` was the second case to prove it mattered. Two rules were added — output
language follows the transcript, and a spoken dose stays spoken — plus a short Spanish worked
example beside the English one. Nothing else changed: same weights, same schema, same key, same
machine, same thirteen transcripts.

| gate | after | before | floor (was) | |
|---|---|---|---|---|
| item recall | **95%** (73/77) | 81% (62/77) | 90% (80%) | pass |
| provenance | **100%** (63/63) | 100% (59/59) | 95% (95%) | pass |
| derivation | **99%** (82/83) | 85% (63/74) | 95% (90%) | pass |
| nothing invented | **100%** (63/63) | 100% | 100% | pass |

63 items emitted, 4 hallucinations, 2 dose errors, 0 edited-only quote failures, 0 failed runs.
11.1 tok/s (3714 tokens in 333.6 s), median 24.2 s, 382.2 s wall. Traces
`2026-08-22T14-36-51-480Z.jsonl` and `2026-08-22T14-43-48-303Z.jsonl` — **two runs on different
prompt-cache states** (88% and 95% reuse), agreeing item for item and token for token, which is
the standard this pack sets before a floor moves.

**The floors were raised to 90/95/95/100.** They were left alone while the task was failing and
moved only after the defect was fixed and reproduced, which is the order that keeps a floor
meaningful.

#### What the two Spanish cases did

    tr-es-10   29% items, 0% derivation   ->   86% items, 100% derivation
    tr-es-13   50% items, 29% derivation  ->  100% items, 100% derivation

Spanish is now 15/16 items rather than 8/16. The single remaining miss is `tr-es-10`'s
presenting complaint. Both cases derive every text and every dose by deletion, so the app flags
nothing in them — previously it flagged every item in both, correctly, and a clinician had no
way to tell that from a real provenance failure.

#### The English cases improved too, which was not the intent

`tr-en-01` 86->100, `tr-en-07` 86->100, `tr-en-12` 75->100, and `tr-en-08` went from 9 to 11
derivations checked with all of them passing. Two rules aimed at a language bug moved four
English cases, and the honest reading is that the second worked example did most of that work
rather than the language sentence: a prompt with one example teaches its example, and the corpus
had been measuring how well the model generalised from a single English dictation. Recorded
because it means the 82% baseline this pack reported for months was partly a property of having
one example, and a future prompt change that removes the Spanish example should expect to lose
more than the Spanish cases.

#### What still fails, and none of it is language

Four missed items and four hallucinations remain, unchanged in kind by this fix:

- `tr-en-02` still loses **amlodipine entirely** — the retraction over-correction documented
  above. "no actually make that 10 mg" deletes the subject rather than replacing the value. This
  is now the single largest defect in the corpus, worth 2 of the 4 missed items.
- `tr-en-06`, `tr-en-09` and `tr-es-13` each put something in a section that should be **empty**.
  On `tr-es-13` it is `control de salud` filed as a plan: the reason for attendance is not a
  decision, and the prompt says what `plan` is without ever saying that a visit can have none.
- `tr-en-05` and `tr-en-09` write a dose where the transcript has none (`milligrams`,
  `two years`), where null is the contract's answer.

Three of those four are the same shape — the model is reluctant to emit an empty section — and
that, not language, is where the next prompt change should go.

## The repair pass — 2026-08-23

A second call over the items whose citation failed, added because a real dictation lost a
correct diagnosis to a reworded quote: the speaker said `con antecedentes de hipertensión` and
the model cited `tiene antecedentes de hipertensión`. One substituted word, the same clinical
claim, no span in the transcript — and an item that cannot be shown anchored to anything.

    Qwen3-4B-Q4_K_M   constrained   ctx 32768 · 1 slot · sequential, cache_prompt on
    temp 0 · transcript max_tokens 2048 · transcript_repair max_tokens 1024
    13 transcripts · 77 required items · 1 run each · TWO calls per transcript

| gate | with repair | first pass alone | floor | |
|---|---|---|---|---|
| item recall | 95% (73/77) | 95% (73/77) | 90% | pass |
| provenance | 100% (65/65) | 100% (65/65) | 95% | pass |
| derivation | **98%** (83/85) | 96% (82/85) | 95% | pass |
| nothing invented | 100% (65/65) | 100% (65/65) | 100% | pass |

3 failed citations offered · 1 re-cited · 1 proposed and refused by the verifier · 1 the model
could not find. 65 items emitted, 3 hallucinations, 3 dose errors, 0 failed runs. 3889 tokens
over 16 case-runs — 13 first passes and 3 repairs, because the pass runs only where something
failed. Median 24.9 s, wall 451.3 s. Two runs, agreeing item for item.

**The floors were NOT moved.** One item of derivation is not evidence for a floor, and a floor
raised on the strength of a second call would be a floor a single-call run could no longer clear.

### The pass certifies nothing, and that is the whole design

Every repair is re-run through `verifyQuote` and `verifyDerivation` — same functions, same rule,
no relaxation — and accepted only if STRICTLY BETTER: no check that passed may fail, and at least
one that failed must pass. A repair that does not verify is discarded, leaving the original item
in its original failed state. The reply is a list of repairs keyed to item POSITIONS rather than
a reading, so the pass cannot add, drop or move an item; item recall is identical above for that
structural reason and not by luck.

### What it tried to get away with on day one

Both failures are recorded because both are more informative than the gain.

Handed three dose failures on the provoking dictation, the pass first returned the items
**unchanged** — refused correctly, no progress. The prompt had never said a quote may run across
a sentence boundary, and the doses had been dictated in the next sentence.

Told that it may, the pass then proposed a span **stitched from two real fragments with the words
between them dropped**: `está medicado con enalapril y amblodipina` joined directly to
`2.5 miligramos cada 8 horas`, deleting the transcriber's `En alapril` from the middle. It reads
like a sentence and it was never said. The verifier rejected it. The prompt now states that a
quote is one unbroken run of the transcript, including the words that look like noise — and on
that dictation the reading goes to 5/5 quotes and 7/7 derivations.

Recorded because it is the clearest evidence this pack has produced for keeping proposal and
verdict in different hands: the second pass invented evidence on its first live day, and nothing
about the reply's shape or plausibility would have caught it.

### What it cannot do

Repair a hallucination. An item nobody dictated has no span to be found, `found: false` is the
answer the prompt asks for, and the item stays flagged. The one such case in this corpus
(`tr-en-09`, a negation run filed as history) was confessed rather than cited, which is the
intended behaviour and not a gap.

## Doctor–patient dialogue — 2026-09-04

Three consultation transcripts added to the transcript task: `tr-en-18-dialogue`,
`tr-en-19-dialogue-correction`, `tr-es-20-dialogo`. Two speakers with labelled turns
(`dr:` / `pt:`), against the **unchanged** dictation prompt — the point was to find out what
a prompt written for one voice does with two.

Qwen3-4B-Q4_K_M.official.gguf, constrained, temp 0, `-ngl 99 --parallel 1`, 20 transcripts /
131 required items. The server would not report its model on this run, so the weights are named
from the command line rather than from the server.

| | |
|---|---|
| item recall | 94% (123/131) — floor 90%, **pass** |
| provenance | 99% (135/136) — floor 95%, pass |
| derivation | 94% (169/179) — floor 95%, **FAIL** |
| not invented | 99% (135/136) — floor 100%, **FAIL** |

**FAIL**, on derivation and on the fabrication floor. The seventeen dictations were previously
99% derivation; the three dialogues contribute six of the ten derivation failures and the single
invented span, so the red is theirs. Recall did not move much — the items are found. What breaks
is the relationship between an item and the span it cites.

### The dose is corrected by the other speaker, and the model takes the doctor's

`tr-en-19` is the case these were written for. The clinician states `metformin 1 g twice daily`
and the patient contradicts them — `no doctor it's 500 twice a day i never went up` — after which
the clinician restates `metformin 500 mg twice daily`. Both numbers are in the transcript and both
are quotable, so a citation verifies either way.

The model emitted **1 g twice daily**. `prompts/transcript.md` states the correction rule as *the
speaker's last word is the only word*, which is a rule about one speaker: it has nothing to say
about a fact withdrawn by somebody else, and the transcript's own last word on the dose is a
turn the model did not treat as a correction at all. Where a dictation's retraction is marked
(`sorry`, `actually`, `scratch that`), a dialogue's is marked only by who is talking.

### A dialogue is not a note, and the model listed it instead of sorting it

The same case emitted 23 quotes and 28 derived fields where a dictation of that length produces
six. Its `history` is the conversation, turn by turn, `text` being the turn with `dr:` deleted:
`you stopped it altogether`, `and the ramipril`, `ten in november`. Nothing is invented and every
quote verifies — the failure is that the four sections were used as a transcript viewer. The
derivation failures follow from it rather than causing it.

### A fact split across two turns has no span to cite

`tr-es-20`: the drug is in the clinician's turn (`y el paracetamol`) and the dose is in the
patient's reply (`1 g cuando me duele mucho tres veces al día como mucho`). No contiguous run of
the transcript contains both, so the model spliced them — `paracetamol 1 g cuando me duele mucho
tres veces al día como mucho`, which was never said, and which the verifier rejected. This is
the fabrication that costs the 100% floor, and it is the same splice the repair pass produced on
its first live day for the same reason: a quote is one unbroken run, and dialogue routinely puts
one clinical fact across a turn boundary. In a dictation it almost never does.

`tr-en-18` shows the benign version of the same pressure: `smoking` and `blood pressure
treatment` as history items, each derived from a quote that does not contain the word. The fact
is right and the citation is not, which is exactly the axis deletion-only derivation exists for.

### What this does not say

Nothing here is evidence about the weights. Three cases were added to a corpus whose floors were
measured on the other seventeen, and the prompt they ran under names a dictation in its first
line. The result is a measurement of the *contract* over an input it was not written for, which
is what it was run to obtain.

### 2026-09-04, later — a dialogue-aware prompt, and it moved three things and not the two it was for

`prompts/transcript.md` and `prompts/transcript.es.md` gained a two-speaker section: a turn is not
an item, a question is not an assertion, the correction rule holds across speakers, a speaker
label is markup, and a fact split across two turns is quoted as the unbroken run that spans both
turns *including the label between them*. Same weights, same corpus, same flags.

| | before | after | |
|---|---|---|---|
| item recall | 94% (123/131) | **91% (119/131)** | floor 90%, still passes |
| provenance | 99% (135/136) | 99% (140/141) | floor 95%, passes |
| derivation | 94% (169/179) | **95% (182/191)** | floor 95%, **was red, now passes** |
| not invented | 99% (135/136) | 99% (140/141) | floor 100%, **still red** |
| hallucinations | 5 | 2 | |

Still FAIL, on one axis instead of two. What the prompt bought was **caution**: three fewer
inventions, the derivation gate recovered, and two dictations that had been leaking
(`tr-es-10` 86→100%, `tr-en-12` 88→100%) came right. What it cost was **recall**, and not only on
the dialogues — `tr-en-02` fell 83→67% and `tr-en-08` 86→71%, both dictations that the rule *a
turn is not an item* has no business touching. A prompt is not a patch; adding a paragraph about
one input shape moved the model's threshold for calling anything an item at all.

Neither of the two failures the section was written for was fixed.

**The dose is still the clinician's.** `tr-en-19` came back with `metformin`, `1 g twice daily` —
the value the patient contradicts in the next turn. The rule now states the case almost verbatim
and the model did not apply it.

**The splice survived, in both languages.** `tr-es-20` again cited `paracetamol 1 g cuando me
duele mucho tres veces al día como mucho`, a sentence made of two turns with the `pt:` label
dropped from the middle — the exact string the new section forbids and shows the fix for. The
Spanish prompt carries the same worked example. The fabrication floor is still red for this one
item, as it was before the change.

#### The dialogue case degenerated into a repetition loop

`tr-en-19` scored 56% recall, its worst result, and the trace says why: `history` is fifteen
identical items — `{"quote": "you're on metformin 1 g twice daily now", "text": "metformin 1 g
twice daily"}` repeated to the array's `maxItems`, and `current_medication` the same. 33 quotes
and 48 derived fields on one transcript, against six on a comparable dictation, every one of them
verifying. The thyroid, the ramipril and the levothyroxine that follow in the transcript are
simply never reached: the model spends the array on one turn.

This is the failure `README.md` describes from the other end — a grammar blocks EOS while an array
is open, so the model cannot stop mid-array and something has to bound it. Here `maxItems: 15` is
what did, and `uniqueItems` did not, exactly as `note-format.schema.json`'s own caveat predicts:
it compares whole item objects, and fifteen byte-identical objects ought to violate it, but
llama.cpp's grammar does not enforce `uniqueItems` at all — the keyword is documentation, not a
constraint. **A duplicate-free array is a claim this pack cannot make with a schema.**

It also explains the run before this one. `tr-en-19` was killed at the pack's 300s deadline and
scored 0/9, which read as a slow machine; it was this loop, generating duplicates until something
stopped it. The deadline is now 900s (`[sampling.transcript]`), which is the right change for a
different reason — a backstop that binds on a legitimate answer is not a backstop — and it does
not make the loop a good answer. It makes it a visible one.

#### What to do next, and what not to

Not another paragraph in this prompt. Two edits in two days moved recall three points down and
derivation one point up, and the second one did not touch either failure it named, which is what
prompt-fitting looks like from inside. The two open defects are structural rather than
instructional: a fact whose authority depends on **who is speaking**, and an item whose evidence
spans a turn boundary. A second prompt for dialogue — routed by the same
`[clinical.languageDetection]` machinery that routes the Spanish one, on a marker as cheap as the
presence of turn labels — would let the dictations stop paying for rules written about speech they
do not contain. That is a pack change with a measurement attached, and it should be made against
these numbers rather than in place of them.

### 2026-09-05 — a separate dialogue prompt, routed by shape, and the two structural defects close

The two-speaker rules were taken back OUT of `prompts/transcript.md` and
`prompts/transcript.es.md` and written as their own contract — `prompts/dialogue.md` and
`prompts/dialogue.es.md` — reached through a new `[clinical.dialogueDetection]` table that counts
labelled turns, with `[clinical.languageDetection.dialoguePrompt]` choosing the language. Shape is
asked first, language second; anything the detector cannot call takes the dictation prompt, which
is what this task has always done.

| | dictation prompt | + dialogue section | **routed prompt** | |
|---|---|---|---|---|
| item recall | 94% (123/131) | 91% (119/131) | **92% (121/131)** | floor 90%, passes |
| provenance | 99% (135/136) | 99% (140/141) | **99% (122/123)** | floor 95%, passes |
| derivation | 94% (169/179) | 95% (182/191) | **92% (151/164)** | floor 95%, **red** |
| not invented | 99% | 99% | **99% (122/123)** | floor 100%, **red** |

Still FAIL, on the same two axes as the first run. The gates did not move and three specific
things did.

**The seventeen dictations are back, item for item.** `tr-en-02` 83%, `tr-en-08` 86%, `tr-en-12`
88% — the exact figures they scored before any of this started. That is the whole argument for
routing rather than editing: the regression the shared prompt caused was not a tradeoff anybody
chose, and separating the files gave it back without costing the dialogues anything.

**The cross-speaker correction works.** `tr-en-19`'s medication list is now completely right:
`metformin` / `500 twice a day` — the patient's contradiction, not the clinician's `1 g` — plus
the `ramipril` and `levothyroxine` that the repetition loop had eaten. Two runs ago this case
returned the wrong dose and two of its three drugs were never reached.

**The turn-spanning quote works, and it is the mechanism that fixed the dose.** All three of that
case's medication items cite across a turn boundary with the label left in:
`"you're on metformin 1 g twice daily now pt: no doctor it's 500 twice a day i never went up"`.
The evidence for 500 is the clinician's claim and the patient's correction inside one span, which
is what the fact actually is. `tr-es-20`'s paracetamol splice — the invented span that cost the
fabrication floor twice — is gone: 100% provenance on that case.

**The repetition loop is gone.** No section is padded to `maxItems` in any of the three dialogues.

#### What is red now is not what was red before

The single fabrication is a NEW one, and it is a near miss on the mechanism above:
`tr-en-19` wrote `"and you're on metformin…"` for a turn that begins `"you're on metformin…"`. One
word prepended to an otherwise perfect turn-spanning quote. The model reached for the right span
and copied it imperfectly, which is a smaller failure than the splice it replaced and it fails
the same 100% floor, exactly as it should.

Derivation fell to 92%, and almost all of it is one case. `tr-en-18` emitted a single medication
item reading `amlodipine 5 mg once daily, atorvastatin 20 mg at night` — two drugs in one item,
with both doses in one `dose` — three times, and put medication lines in `history` besides. That
is `_mergedItems`, the trap the transcript key already carries on all six multi-drug dictations,
firing on a dialogue for the first time. The dialogue prompt states one-item-per-drug; the case
that obeys it is the hard one and the case that does not is the easy one, which is not a pattern
this corpus can currently explain.

#### Where this leaves the task

Three measured attempts, and the gate has been red every time: 94/99/94/99, then 91/99/95/99, then
92/99/92/99. What has changed underneath is that the failures are now different failures. The
dialogue-specific defects the corpus was written to expose — a dose corrected by the other
speaker, evidence spanning a turn, a conversation copied out instead of read — are closed. What is
left is a merged medication item and a one-word copying slip, and both of those are failures this
pack already knows how to see on dictations.

The honest next step is not another prompt. It is a second model over the same twenty transcripts:
every number in this section is one set of weights, and `_mergedItems` exists because the first
graded run of this task walked straight through the gap it closes. A defect that appears on the
easy dialogue and not the hard one wants a second opinion before it wants another rule.

### 2026-09-05, later — the second opinion, and it reverses the August finding

`gemma-3-4b-it-Q4_K_M` (sha256 `04a43a22…`, the same file as the entry above), same harness, same
flags, same key, same machine, constrained. Twenty transcripts, 131 items.

| gate | Qwen3-4B | gemma-3-4b | floor |
|---|---|---|---|
| item recall | **92%** (121/131) | 85% (111/131) | 90% |
| provenance | **99%** (122/123) | 92% (108/117) | 95% |
| derivation | 92% (151/164) | 88% (133/151) | 95% |
| nothing invented | **99%** | 93% (109/117) | 100% |

117 items emitted, 4 hallucinations, 4 dose errors, 1 case-only quote failure, 0 failed runs,
10.0 tok/s, 1204.7 s wall — 2.3× Qwen's throughput on this machine and half the wall clock.

gemma fails all four gates; Qwen fails two. **On 2026-08-22, over thirteen transcripts, this
comparison came out the other way** — gemma 89% recall against Qwen's 82%, and 100% provenance
against 100%. Seven more transcripts reversed it. Nothing about the models changed; the corpus
got harder and longer, and a seven-point lead measured on 73 items did not survive 131.

That is worth more than either row. The August entry named its own limits — one run each, five
items of margin — and this is what those limits cash out as. A number from this pack describes a
model *on the corpus it was measured on*, and the corpus is the thing that keeps moving.

#### What it was run to answer

`tr-en-18` produced one medication item naming two drugs under Qwen, three times over. **gemma does
not merge**: it emits `amlodipine` and `atorvastatin` as separate items, so the merged item is a
property of those weights and not a hole in the prompt or the case. What gemma does on the same
transcript is cite the wrong span for both of them — `text 'amlodipine'` derived from a quote that
does not contain the word — and lose the aspirin, the exercise tolerance test and the blood
pressure entirely: 67% recall where Qwen scored 78%. Two models, one transcript, two unrelated
failures, and one number for each would have called them near-equivalent.

**Both models get the cross-speaker correction right.** gemma scores 89% on
`tr-en-19-dialogue-correction` with no dose error — the same result Qwen gets, and neither model
takes the clinician's `1 g`. Two independent sets of weights reading the same new rule the same
way is the strongest evidence in this file that `prompts/dialogue.md` is doing what it says.

#### Where gemma actually loses it: dictations, not dialogues

The dialogues cost gemma four gated items. The DICTATIONS cost it sixteen, and its provenance
collapse is almost entirely there:

- `tr-en-12-structured-dictation` — **1 of 5 quotes verify**. gemma rewrote the disciplined
  dictation into the section headings it dictates (`subjective mrs leila haddad attends for her
  annual review…`, `medications methotrexate 15 mg once weekly and folic acid…`), quoting a
  tidied version of the transcript rather than the transcript. It is the EASIEST case in the
  corpus, tier 2, and it is this model's worst.
- `tr-es-13`, `tr-es-14`, `tr-es-17` — a fabricated span each, all of them the same move: a
  fluent reassembly of what the speaker said.
- `tr-en-03` — a Spanish quote (`toma beclometasona 200 microgramos dos veces al dia`) over an
  English transcript. Not a language routing failure; the transcript is English and took the
  English prompt. The model translated the span it was copying.

That is the failure mode the August entry explicitly recorded as ABSENT for this model on speech
— "gemma invents nothing here". It invents plenty at twenty transcripts. The expectation was not
wrong when it was written; it was written on a corpus that did not contain the cases that provoke
it.

#### The state of the task

Qwen3-4B on the routed prompt is the best reading this pack has produced of these twenty
transcripts, and it is still two gates short. It is also, on this evidence, the model the floors
should continue to be set from — not because it is better in general, but because it is the one
whose failures this corpus has characterised across five runs.

### 2026-09-05, later still — the dialogue prompt was 40% too long, and the fabrication gate goes green

`prompts/dialogue.md` cut from 15.3 KB to 9.2 KB. Two changes, arrived at by ablation on the two
English dialogues rather than by judgement: the medication section compressed from ten bullets to
one paragraph, the second worked example (Spanish, inside the English prompt) removed, and the
"a turn is not an item" block left at full length because a first slimming pass that cut it
regressed. Same weights, same corpus, same flags.

| | 15.3 KB prompt | **9.2 KB prompt** | |
|---|---|---|---|
| item recall | 92% (121/131) | 92% (120/131) | floor 90%, passes |
| provenance | 99% (122/123) | **100% (127/127)** | floor 95%, passes |
| derivation | 92% (151/164) | 92% (154/168) | floor 95%, **red** |
| not invented | 99% (122/123) | **100% (127/127)** | floor 100%, **passes** |

**Nothing was invented.** That is the first run of this corpus since the dialogues were added
where the fabrication floor is met, and it clears the gate that a shorter prompt had no obvious
business clearing. One red gate remains where there were two, and the prompt that got there is
the smallest one tried.

The merged medication item is gone. `tr-en-18` now emits `amlodipine` / `5 mg once daily`,
`atorvastatin` / `20 mg at night` and `aspirin` / `75 mg once daily` as three items, and its
recall goes 78% → 89%. Six drugs across the two English dialogues, six correct doses, including
the cross-speaker correction on `tr-en-19`. **Compressing the section that states a rule improved
adherence to that rule**, which is the opposite of what adding text had done all week.

#### The ablation, because the negative half is the more useful half

Three prompts, two English dialogues, one run each at temperature 0:

| | 15.3 KB | 8.2 KB (uniform trim) | 9.2 KB (targeted) |
|---|---|---|---|
| medication, 6 drugs | 3 correct, 1 merged item ×3 | 5 correct, 1 miscited | **6 correct** |
| questions filed as history | yes | worse | yes |
| fabricated span | no | yes (`levothyoxine`) | no |

The uniform trim fixed the merge and broke turn filtering; restoring the filtering block fixed
nothing about turn filtering. **Three prompt versions — including one where the rule is stated
against the model's own counter-examples, verbatim — all file questions as history.**
`tr-en-18` returned `pain in the arm or the jaw`, `smoking`, `three months` and `settles when
stopped` from a prompt containing the sentences "'any pain in the arm or the jaw' is not a
symptom" and "'do you smoke' is not a smoking history".

That is not an overload problem and it is not an instruction problem. `history` is behaving as
the default sink for any turn the model reads as clinical, and it is where the remaining red gate
lives: ten of the fourteen derivation failures are on the three dialogues, and seven of those ten
are `tr-en-18`'s history absorbing questions. The one real history item on that transcript — the
osteoarthritis — is missed, underneath the junk.

#### What follows

The next thing worth trying on this defect is NOT prompt text. It is either a pass whose only
output is `history`, or a change to what the section is allowed to contain. Both are contract
changes with floors attached, and both should be measured against this row.

Also outstanding: `prompts/dialogue.es.md` is still the 15 KB version, so `tr-es-20` in the row
above ran the unslimmed Spanish prompt. The two edits above have not been mirrored and the pair
is inconsistent until they are, and until a run measures the result.
