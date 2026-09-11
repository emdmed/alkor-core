# Improvements — harness and evals

Written 2026-08-21, after the two-model / two-arm / three-task run in `packs/clinical/RESULTS.md`
and the scorer review that preceded it. Every item names the evidence that put it on the list;
nothing here is a hypothetical tidy-up.

Ordered by what would change a wrong answer soonest.

---

## P0 — the gate is measuring the wrong thing

### 1. Move the vital-signs floor off detection

**Evidence.** Detection is 87/88 (Qwen3-4B) and 88/88 (gemma-3-4b), saturated at *every*
difficulty tier including d5. What separates the two models is value (82/88 vs 86/87) and unit
(81/88 vs 86/87) — neither of which gates. A CI run today passes a model that reads a fifth of
the flowsheet wrong.

**Do.** Add `valueFloor` and `unitFloor` to `vital-signs-cases.json`, gate on them alongside
detection, and keep detection as the floor it is rather than the discriminator it stopped being.
`profile.ts` already supports per-task sub-gates (`gates: Gate[]`) — this is wiring, not design.

**Done when** a model with perfect detection and gemma's unit rate fails the run.

### 2. Decide the pack-format compatibility story before anyone else writes a pack

**Evidence.** `[clinical.quoteVerification].accentSensitive` and `[clinical].corpusSynthetic`
were added today. The first is *required*: `loadSettings` throws without it. Any pack written
against `spec = 1` before today now fails to load, and `spec` was not bumped.

**Do.** Either bump to `spec = 2` and have the loader say what changed, or default
`accentSensitive` with a loud warning. Not both, and not neither. `spec/pack.md` documents the
keys but not the break.

**Done when** a pack that predates today either loads with a stated default or is refused with a
message naming the version and the missing key.

---

## P1 — the corpus has been outgrown

### 3. Write cases against the measured failure modes

**Evidence.** Every failure in the last run falls into five buckets, and the corpus has one or
two notes for each. The models are now failing in *known* ways, which means the corpus is no
longer discovering anything.

**Do.** Add notes that punish, specifically:

- **Tabular layout.** `vs-en-17-flowsheet` is the single most informative note in the corpus —
  it breaks Qwen on provenance (0/5, invented citations) and gemma on value (0/5, wrong row).
  One note carrying that much signal should be five.
- **Spanish units.** `lpm`/`rpm` cost gemma five unit slots across three notes and cost Qwen
  nothing. More of them, and a note that mixes the two languages mid-sentence.
- **Typography.** `°F` vs `F`, `kg/m²` vs `kg/m2`, `ºC` vs `°C`, middle-dot decimals.
- **The prompt's own examples.** gemma emitted `94 bpm` for a note with no heart rate — the
  exact figure in the prompt's worked example. Write cases *against* the prompt, not alongside
  it: a note whose true value differs from the example's.
- **Forbidden arithmetic.** Notes that state a weight and a height and never combine them.

**Done when** at least one model drops below 95% detection again.

### 4. Grow the two new tasks

**Evidence.** Summary is 3 records / 13 items; note-format is 6 notes / 18 items. One
hallucination moves the summary score by 8 points. These are baselines, not measurements.

**Do.** Target ~10 records and ~15 notes. Note-format's provenance sub-gate is the most valuable
check in the pack and it currently runs over ~34 quotes.

### 5. Rate the difficulty tiers against what they now measure

**Evidence.** d5 detection is 23/24 and 24/24. The tier that was added to end saturation is
saturated.

**Do.** Re-read the d5 notes against the rubric and rewrite the ones that no longer fight the
reader. The scale is fixed 1-5 on purpose; the notes move, not the scale.

---

## P2 — the harness can mis-measure without saying so

### 6. First-class offline re-scoring

**Evidence.** The most useful analysis in `RESULTS.md` — "the 0/88 is a format failure, here is
the same run at 84/84 with the fence stripped" — required a hand-written script, twice, both
times reaching into scorer internals that are not part of the public surface.

**Do.** `eval --from-trace FILE [--strip-fences]`: re-score recorded completions with no server.
It makes a claim about a past run checkable by anyone, which is the whole premise of the trace.

### 7. An end-to-end eval test against a stub server

**Evidence.** `--difficulty` reached `set-eval.ts`, was declared in its options, and was read by
nothing. No test caught it because no test runs an eval loop. `test/extract.test.ts` now shows
the pattern — a throwaway `node:http` server that counts requests and serves canned replies.

**Do.** Extend it to `runVitalSignsEval` and the two set evals: assert the case count under
`--difficulty`, the gate arithmetic on a zero denominator, and that declared sampling reaches the
request body for every task.

### 8. Typecheck in CI, and CI at all

**Evidence.** Node strips types and checks nothing. Today's signature changes (`scoreCase`,
`renderReading`, `checkQuote`) surfaced as *test failures*, not type errors — and would have
surfaced as runtime errors in any path a test does not cover.

**Do.** Add `"typecheck": "tsc --noEmit"` with a minimal `tsconfig.json`, and a workflow running
`npm test && npm run typecheck`.

### 9. Quantify the nondeterminism instead of documenting it

**Evidence.** `vs-en-16-addendum` returned `"weight 61.4 kg"` in one run and `"Weight 61.4 kg"`
in another — same model, same bytes, different KV prefix. Under the case-sensitive quote rule
that is a pass/fail flip, and today it happened to land on the passing side.

**Do.** Two things. Make `--runs N` meaningful by reporting per-case *variance* rather than
re-averaging (it is currently near-useless at temperature 0, as its own docstring admits). And
add a reproducibility mode — `--no-cache-prompt` — that trades the 60-88% prefix reuse for a run
that can be compared byte-for-byte with another.

### 10. Warn when a run cannot name what produced it

**Evidence.** `serverModel` and `serverProps` are best-effort and yield `(server did not say)`.
A result recorded that way is unreproducible, and nothing in the output treats it as a problem.

**Do.** Print a warning at the top of the run, and mark the trace's `run` event so a consumer can
refuse to quote the number.

---

## P3 — worth doing, nothing is currently wrong

### 11. Fix the `attempts` undercount in bench

`onMetrics` fires only on success, so a case whose first attempt failed at transport reports one
attempt and a retry that is invisible in the cost. Documented in `bench.ts`; still wrong.

### 12. A trace-content test for the redactor

`redactClinical` elides `completion`, `error` and `misses[].detail`. Nothing asserts that a
*whole trace file* from a real run contains no note text. Run an eval against a stub, scan every
line for a phrase from the corpus, fail if found.

### 13. Version the trace format

Consumers parse `run` / `case` / `bench` / `record` events by shape. A `traceSpec` field would let
a reader refuse a format it does not understand, exactly as `pack.spec` does.

### 14. Negation handling in set matching is a heuristic — say so in the pack

`matchesAny` refuses a match when a negator opens the same clause (`no`, `sin`, `niega`, …). That
list lives in `set-scorer.ts`, which makes it code rather than contract. If a pack in another
language uses this scorer, its negators are not there. Move the list into `[clinical]`, or accept
that it is English+Spanish and document the limit.

### 15. Consider whether `edited-only` should be its own floor

Both quote-verifying tasks now report it, and Qwen's two provenance failures on `vs-en-03` are
entirely that category. A pack might reasonably want "fabrications must be zero, tidying may be
5%" rather than one provenance floor covering both.
