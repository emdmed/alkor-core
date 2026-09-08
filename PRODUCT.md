# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing codebase: TypeScript on Node >= 24, run directly via `node src/cli.ts` (no bundler,
no framework). The report surface requested here is a single standalone `report.html` at the
repository root — no build step, no external network requests.

## Users

Two audiences, in this order of priority for public-facing surfaces:

1. **Someone evaluating medextract cold** — an engineer or clinical-informatics reader who has
   not read the repository, arriving at a result document and deciding whether the tool is
   credible. Confirmed as the audience for `report.html`.
2. **The maintainer and collaborators** — writing and revising contract packs, reading eval
   traces, deciding whether a prompt change earned its keep.

The job in both cases is the same: decide whether a small local model, wrapped in this
harness, produces output good enough to ship for one specific extraction contract.

## Product Purpose

Pull structured medical data out of clinical notes using a model small enough to run where the
notes are, and attach the gate that says whether the result is good enough to ship. The user
writes a **contract pack** — prompts, JSON schemas, eval cases. `extract` runs that contract
over a note and returns JSON; `eval` runs the same contract over a corpus and returns a gate,
a trace, and a reproducible number. One assembly feeds both, so what was measured is what runs.

## Positioning

The pack is data, and the same files serve production runtime and measurement. Generic eval
frameworks (promptfoo, Inspect, lm-eval) measure prompts against models across many tasks; the
evals here exist to keep one contract honest, and that contract is the artifact production
reads. Narrower on purpose.

## Operating Context

- Local `llama-server` the user started themselves; the harness never starts one behind their
  back, because a server's flags are part of a measurement.
- Models named by sha256; e.g. `Qwen3-4B-Q4_K_M` on an AMD Lucienne iGPU, ctx 32768, 1 slot,
  temperature 0, seed 0.
- Runs write JSONL traces to `~/.local/state/medextract/traces/<pack>/`.
- Contract packs live under `packs/`; profiles under `src/profiles/`; results under
  `packs/<pack>/RESULTS.md`, which holds the rule that a result may never be a number the
  repository cannot reproduce.
- Generation on this hardware is slow enough to be a design fact: ~4.7 tok/s, median case
  latency 25.3s, twenty cases in 590.8s.

## Capabilities and Constraints

- Constrained decoding against the pack's JSON Schema; schema property order and `maxItems`
  are load-bearing, not decorative.
- Evals report a gate (pass/fail against a floor) plus sub-gates such as echo of primary
  findings and invented-finding count.
- **Not a medical device**, not clinical decision support, not validation evidence for any
  regulator.
- **Not an inference server** and **not a generic eval framework**.
- Status: pre-release.

## Brand Commitments

- Name is lowercase `medextract`.
- Voice in existing docs: plain, exact, unhedged; states what a number does not show in the
  same breath as the number. Never oversells.
- Apache-2.0.

## Evidence on Hand

- `shock_siagnostic_test.md` — the shock-category ablation, written 2026-09-07. Four arms
  (harness, A naked, B labels, C tooling-only), 20 synthetic payloads, plus a label-order
  probe. This is the source of every figure in `report.html`.
- `packs/clinical/evals/shock-cases.json` — the corpus and its `_whatThisIsNot` note.
- The corpus contains **no patients**; all twenty payloads are synthetic. Nothing in the
  result is diagnostic accuracy; it is agreement with a published bedside heuristic
  (Vazquez et al., J Hosp Med 2010).
- The ablation arms A/B/C were run from throwaway scripts that no longer exist. Those figures
  are currently **not reproducible from this repository** — a stated limitation that must
  never be presented as settled measurement.

## Product Principles

1. What was measured is what runs — one assembly feeds both eval and production.
2. A number ships with what it does not show attached to it.
3. A result the repository cannot reproduce is evidence, not a measurement.
4. Restraint is a measured property: declining to answer is scored, not excused.
5. The honest baseline is always on the table, including when it beats the model.

## Accessibility & Inclusion

Standard web accessibility for a read surface: real text over images of text, sufficient
contrast at the chosen pastel register (this is a stated risk of the requested palette, not a
license to fall below WCAG AA on body copy), keyboard-reachable interactive elements, and no
meaning carried by color alone in any chart.
