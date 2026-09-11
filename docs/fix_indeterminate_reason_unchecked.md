# A right category for a reason the payload contradicts

**Status:** open, unfixed. Found 2026-09-11 while diagnosing a `verify-source` refusal on a
real MICU admission note; unrelated to that refusal, which was a separate pack gap and is
fixed.

## The observation

The note gave a blood pressure but never said how long it had been low, so
`prompts/shock-extraction.md` did what it says and wrote `duration_minutes: 0`. The cohort gate
therefore failed on its duration half, and the payload handed to the model said so in as many
words:

```
hypotension_duration: 0 minutes
in_studied_cohort: no (hypotension has lasted 0 minutes, under the 30 the rule requires)
skin_temperature: cool
jugular_venous_pressure: not_assessed
```

`classify` (src/profiles/clinical/shock.ts:243) stops at the first line it can: the cohort gate
is checked before anything else, so the truth is `indeterminate` for
`outside_studied_cohort`. The model answered:

```json
"shock_category": "indeterminate",
"indeterminate_reason": "Step 2: the jugular venous pressure was not assessable, and it is the
  finding that separates cardiogenic from hypovolemic shock in a cool patient; a measured
  central venous pressure or an echocardiogram would settle it."
```

Right category, and the run passed every gate. But the reason names **Step 2**
(`primary_finding_not_assessed`) when the payload had already stopped it at **Step 1**. The
model never engaged with the `in_studied_cohort: no` line at all — it read past the one fact the
whole medprotocol change exists to state, and reconstructed a different stopping point that
happened to also be present.

## Why nothing caught it

Three checks could have and none does, each for a stated reason:

- `clinical-verifier` (src/profiles/clinical-verifier/profile.ts:252) checks only the PAIRING:
  indeterminate is answered with a reason, anything else with `null`. The comment there explains
  why it is not an equality — `truth.reason` is one of three closed tokens and the model's reason
  is a sentence its own prompt demands, so `!==` could only pass by the model disobeying the pack.
- `shock.schema.json` (`x-notes.reasonIsFreeText`) deliberately types the field as free text and
  records that it is **not graded automatically**, so that a model declining for a reason the rule
  has no word for can still say so.
- The shock eval (src/profiles/clinical/shock-eval.ts:221) counts `declinedWithReason` —
  presence, not content.

So the contract is self-consistent and the hole is real at the same time: a model can reach the
right category from the wrong stop, and the only artifact that would reveal it is the sentence
nobody grades. On this case the two stops happened to agree on the category. They do not always:
a payload outside the cohort with BOTH primaries assessed stops at Step 1 and would be
`cardiogenic` or `hypovolemic` if the cohort gate were the thing the model skipped.

## What a fix has to preserve

The free-text field must stay free text — an enum deletes the most useful thing this contract
produces. So the check cannot be on wording.

Sketches, none chosen:

1. **A separate closed field.** Add `stopped_at_step` (enum: `cohort`, `primary_not_assessed`,
   `empty_square`, `null`) beside the free-text reason, and check THAT against `truth.reason`
   deterministically in `clinical-verifier`. The sentence stays ungraded and unconstrained; the
   machine-checkable claim moves to a field that can carry it. Costs one schema field and one
   prompt paragraph, and makes the grammar wider by four tokens.
2. **Rule-side only.** Leave the contract alone and have `clinical-verifier` refuse when the
   payload says `in_studied_cohort: no` and the reply's category is decided — catching the
   dangerous direction (skipping the gate entirely) without touching the reason at all. Cheaper,
   narrower: it does not catch this case, where the category was right.
3. **Measure it before fixing it.** Add cases to the shock corpus where the two stops disagree on
   the category, and see whether the model actually skips the gate or only mis-narrates it. If it
   is only narration, option 1 is the whole fix; if it is the gate, this is a prompt failure and
   `prompts/shock.md` needs the Step 1 line hardened rather than the schema widened.

Option 3 first: nothing here establishes how often this happens, and one observed case is one
observed case.

## Reproducing

Any note whose blood pressure is below 90 systolic, whose duration is unstated, and whose skin or
JVP is `not_assessed`. The note used is a septic-shock MICU admission; `duration_minutes: 0` plus
`jugular_venous_pressure: "not_assessed"` is the whole trigger.
