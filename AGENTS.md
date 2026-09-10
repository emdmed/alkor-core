# Agents

## Project overview

`medextract` is a local-LLM extraction harness for clinical text. The codebase is TypeScript
on Node ≥ 24, run natively — no bundler, no build step, no transpilation. `npm test` runs
unit tests directly against `.ts` files; `npm run typecheck` runs `tsc --noEmit`.

**Key rule:** Node strips types at runtime, so a test failure is the first signal of a type
error. Always run `npm run check` (test + typecheck) before committing.

## Architecture boundaries

- `src/core/` — the harness: config, pack loading, transport, tracing, verification,
  assembly, bench, activity. **Core must never mention a clinical concept, vital sign, or consuming
  project.** Domain arrives as a pack (data) and a profile (code that reads it).
- `src/modes/` — execution shapes: `extract`, `agentic`, `session`, `router`, `pipeline`.
  These are generic; they know about the mode, not the domain.
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
- `src/tui/` — dashboards over the activity feed, sharing one pure core. `state.ts` (the
  reducer) and `sse-core.ts` (frame parsing, dedup, spec refusal) are dependency-free and
  unit-tested on Node 24; the terminal app and the browser dashboard both import them. The
  terminal side is `sse.ts` (undici) + `app.ts` (OpenTUI — the only file that may import
  `@opentui/core`, dynamically, so `node src/tui.ts --help` never fails on Node 24).
- `web/` — the browser dashboard (React + Vite). It is a separate app with its own
  `package.json`; it imports the shared reducer/SSE core from the repo root by relative
  path and talks to the server over the same `GET /events` + `/health` endpoints. The
  server answers CORS for loopback origins only by default (`MEDEXTRACT_CORS` widens it).

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
3. Update `src/profiles/clinical/contracts.ts` to register the task.
4. Add scoring logic in `src/profiles/clinical/review-<task>.ts` or extend existing review.
5. Update `src/profiles/clinical/eval.ts` to run the eval and set the floor.
6. Update the corpus pin in `test/clinical.test.ts` if the denominator moves.
7. Run `npm test` and the eval against the corpus; commit numbers with the change.

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
2. **No number that was not measured.** Figures in the README and `RESULTS.md` come from a
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
- Nothing in `npm test` may need a model, a server, a private pack, **or a native renderer**.
  `test/tui-state.test.ts` and `test/tui-sse.test.ts` prove the whole TUI intelligence on
  Node 24 without `@opentui/core` installed; `app.ts` is exercised manually. The same core
  is what the browser dashboard renders, so nothing in `npm test` needs the web app;
  `npm run web:typecheck` guards the browser side.

## Files and conventions

- `profiles.toml` is the only file that may name a project outside this repository. `pack`
   and `module` entries point to out-of-tree code and data.
- `spec/pack.md` documents the pack format, including the three constrained-decoding
  constraints a schema must respect.
- Traces go to `${XDG_STATE_HOME:-~/.local/state}/medextract/traces/<profile>/`, outside
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
- Changing a **floor** means updating `packs/clinical/evals/*-cases.json` and the README table.
- Adding a **new task** means adding its own floor, its own eval, and its own entry in the
  status table. Never let a new task inherit a floor from an old one.

## Comments and commits

Comments explain **why**, and often cite the measurement that settled it. A rule without its
reason gets "cleaned up" by the next person. Commit messages say what changed and what it
cost. If a change made a number move, the message is where the old number goes.

Activity events follow the same rule: metadata-only by construction, with a banned-key walk
that fails loud at the source. `spec/activity.md` mirrors `spec/pack.md` for the event
catalogue, SSE framing, and versioning rule.
