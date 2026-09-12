# Agents

## Project overview

`alkor` is a local-LLM extraction harness for clinical text. The codebase is TypeScript
on Node ≥ 24, run natively — no bundler, no build step, no transpilation. `npm test` runs
unit tests directly against `.ts` files; `npm run typecheck` runs `tsc --noEmit`.

**Key rule:** Node strips types at runtime, so a test failure is the first signal of a type
error. Always run `npm run check` (test + typecheck) before committing.

## Architecture boundaries

- `src/core/` — the harness: config, pack loading, transport, tracing, verification,
  assembly, bench, activity. **Core must never mention a clinical concept, vital sign, or consuming
  project.** Domain arrives as a pack (data) and a profile (code that reads it).
- `src/modes/` — execution shapes: `extract`, `agentic`, `session`, `router`, `workflow`.
  These are generic; they know about the mode, not the domain. A profile may also declare
  `mode = "code"`, which calls no model and runs through the same `review` call as `router`;
  it is a declaration, not a module here.
- **A workflow ends with an assessment, and an assessment computes nothing.** The step marked
  `final = true` runs on every exit — including a refusal — and renders only values earlier
  steps produced and a verifier checked. Never add a computation, a re-read of the input, or a
  model call to it: that is what makes the ending gradeable by exact match with no GPU, and a
  refused run must end stating no verdict at all. See `spec/nomenclature.md`.
- `src/profiles/` — domain-specific implementations. Each profile exports a `ProfileModule`
  that satisfies the interface in `src/core/profile.ts`. The reference `clinical/` profile
  is the worked example; it is not special to core.
- `packs/` — contract packs: prompts, schemas, eval cases, goldens. The clinical pack is the
  only one that lives in this repository; others are pointed to from `profiles.toml`.
- `src/vendor/` — third-party code copied in verbatim, not written here. Currently the
  medprotocol CLI v0.7.10, which the clinical profile shells out to for every numeric decision;
  carrying it is what makes the reference pack reproducible on a clean clone. It is a copy, not
  a fork: do not fix, refactor, or restyle anything under it, and read
  `src/vendor/medprotocol/VENDOR.md` before touching it at all. It is typechecked by
  `tsconfig.vendor.json` on upstream's settings rather than this repository's, and excluded from
  `tsconfig.json` for that reason.
- `src/index.ts` — the public API. Everything a profile may import is re-exported here;
  nothing that is itself a profile is exported. Deep imports are unsupported.
- `src/monitor/` — the dashboard's pure core over the activity feed. `state.ts` (the
  reducer), `sse-core.ts` (frame parsing, dedup, spec refusal) and `source.ts` (backend
  connection identity) are dependency-free and unit-tested on Node 24, so the intelligence
  is provable without a browser. `web/` imports them; nothing here may import React.
- `web/` — the browser dashboard (React + Vite). It is a separate app with its own
  `package.json`; it imports the shared reducer/SSE core from the repo root by relative
  path and talks to the server over the same `GET /events` + `/health` endpoints. The
  server answers CORS for loopback origins only by default (`ALKOR_CORS` widens it).

## How to add things

### Add a new profile

1. Create `src/profiles/<name>/profile.ts` exporting `PROFILE` that satisfies
   `ProfileModule` (see `src/core/profile.ts` for the interface).
2. Add `[<name>]` to `profiles.toml` with `mode`, `url`, and optionally `pack`/`module`.
3. If the profile needs a pack, write the pack directory and manifest (`pack.toml`).
4. Run `npm test` and `npm run typecheck`.

### Add a new task to the clinical pack

1. Add the prompt, schema, and golden under `packs/clinical/`.
2. Add the eval cases under `packs/clinical/evals/`.
3. Add a `CONTRACTS` entry in `src/profiles/clinical/contracts.ts` — the pack keys, the
   sampling table and the document kind.
4. Add a `TASK_SPECS` entry beside it. That one line is what makes the task exist: `TASKS`,
   `GRADED_TASKS`, `TOOLING_TASKS`, `CLINICAL_TASKS`, `UNREVIEWABLE_TASKS`, `TASK_FEEDS`,
   `TASK_ORDER` and the `Task` union are all derived from it. Set `graded: false` until the
   eval in step 6 exists — a task that promises a number nobody computes is the one failure
   `test/clinical.test.ts` checks for.
5. Add scoring logic in `src/profiles/clinical/review-<task>.ts`, and wire it into the
   `reviewers` table in `executeClinicalTask` (`profile.ts`). Anything declared
   `reviewable: true` with no entry there fails the wiring test.
6. Write the eval in `src/profiles/clinical/<task>-eval.ts` — build it on the shared helpers in
   `eval-run.ts` rather than copying another eval's preamble — and wire it into the `EVALS`
   table in `runEval`. Set the floor in the pack, not in the code.
7. Update the corpus pin in `test/clinical.test.ts` if the denominator moves.
8. Run `npm test` and the eval against the corpus; commit numbers with the change.

### Add a new mode

1. Implement the mode in `src/modes/<mode>.ts`.
2. Add the mode name to the `Mode` union in `src/core/config.ts`.
3. Export the public surface from `src/index.ts`.
4. Add tests in `test/<mode>.test.ts`.
5. Update `src/cli.ts` to wire the command if it is a CLI verb.

## Running and testing

```bash
npm install
npm test          # no model, no server, no pack required
npm run typecheck # tsc --noEmit; node checks none of the types it strips
npm run check     # both, which is what CI runs
```

To run evals, start a `llama-server` first — the harness will not start one for you:

```bash
LLAMA_PORT=8081 LLAMA_MODEL=~/models/gemma-4-E4B-it-Q4_0.gguf scripts/llama-server.sh \
  -ngl 99 --no-webui --parallel 1
node src/cli.ts eval --profile clinical --constrain
node src/cli.ts eval --profile router
node src/cli.ts eval --profile verifier
node src/cli.ts eval --profile clinical --task shock --constrain
node src/cli.ts eval --profile clinical-verified --fidelity
```

## Non-negotiable rules

These are taken from `CONTRIBUTING.md` and are enforced by design, not by policy:

1. **No patient data, ever.** `packs/clinical/notes/` is synthetic and written for this
   repository. A note derived from, edited from, or "inspired by" a real record does not
   belong here. This is the one rule where a good-faith mistake is still unacceptable.
2. **No number that was not measured.** Figures in `docs/measured.md` and `RESULTS.md` come from a
   run on the corpus in this repository, and name the model, quantisation, and sampling.
   Do not round up, do not carry a number over, and do not edit an old result — add a new
   dated entry instead.
3. **A bad result stays.** Deleting an unflattering measurement is the same act as inventing
   a flattering one.
4. **Core names no domain.** Nothing under `src/core/` or `src/modes/` may mention a vital
   sign, a clinical concept, or a consuming project. If a change needs core to know
   something about medicine, that is a sign the profile boundary is in the wrong place.
5. **The public API is `src/index.ts`.** Removing an export is a breaking change for
   out-of-tree profiles. `test/package.test.ts` states the contract by name.

## What tests must cover

- A test must be able to fail. A scorer test that only exercises the success path proves
  nothing — `test/clinical.test.ts` asserts hallucinations, wrong units, half-right blood
  pressures, and fabricated quotes because those are the outcomes that matter.
- The eval loop is testable without a model: `test/eval-loop.test.ts` runs against a
  throwaway `node:http` server that counts requests and serves canned replies.
- Nothing in `npm test` may need a model, a server, a private pack, **or a browser**.
  `test/monitor-state.test.ts`, `test/sse-core.test.ts` and `test/web-state.test.ts` prove the
  whole dashboard intelligence on Node 24, because it lives in `src/monitor/` rather than in
  a component; `npm run web:typecheck` guards the browser side.

## Files and conventions

- `profiles.toml` is the only file that may name a project outside this repository. `pack`
   and `module` entries point to out-of-tree code and data.
- `spec/pack.md` documents the pack format, including the three constrained-decoding
  constraints a schema must respect.
- Traces go to `${XDG_STATE_HOME:-~/.local/state}/alkor/traces/<profile>/`, outside
  any repository, deliberately. A trace contains raw prompts and completions; a profile
  that handles patient data must supply a `redact` hook before tracing anything real.
- Activity events go to the in-process bus and, via `GET /events`, over SSE. They are
  metadata-only by construction: no `content`/`prompt`/`completion`/`text`/`messages`/`note`/
  `document` field exists on the union, and `emit()` throws if a banned key appears anywhere.
  Because there is nothing to redact, the feed needs no redactor hook.
- `spec = 3` in `pack.toml` is the current pack format. Absent means 1. A pack declaring a
  version this harness does not read is refused rather than read under the old rules. The
  version lives in `SPEC_VERSION` in `src/core/pack.ts`; bumping it means adding the entry to
  `SPEC_CHANGES` beside it and to the changelog in `spec/pack.md`, which is what a loader
  quotes when a pack is older than the harness.

## When you change a contract

A pack's prompt, schema, or cases are the thing under measurement, so a change invalidates
every number measured before it. Rules:

- Changing a **schema** means regenerating its golden. Property order is compiled into the
  grammar; see `spec/pack.md`.
- Changing the **corpus** — adding a case, fixing an expectation — means the denominator
  moves. Update the pin in `test/clinical.test.ts` in the same commit and say what moved and why.
- Changing a **prompt** means re-measuring. Say in the commit message what the numbers were
  before and after.
- Changing a **floor** means updating `packs/clinical/evals/*-cases.json` and the task table
  in `docs/tasks.md`.
- Adding a **new task** means adding its own floor, its own eval, and its own entry in the
  status table. Never let a new task inherit a floor from an old one.

## Comments and commits

Comments explain **why**, and often cite the measurement that settled it. A rule without its
reason gets "cleaned up" by the next person. Commit messages say what changed and what it
cost. If a change made a number move, the message is where the old number goes.

Activity events follow the same rule: metadata-only by construction, with a banned-key walk
that fails loud at the source. `spec/activity.md` mirrors `spec/pack.md` for the event
catalogue, SSE framing, and versioning rule.
