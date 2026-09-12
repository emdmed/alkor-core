# Refactor proposal: make the clinical profile addable-to without an archaeology pass

Four changes, ranked by how much maintenance pain they remove per unit of risk. Nothing here
touches `src/core/`'s boundary, `src/vendor/`, or the comment style — those are working.

The one-sentence diagnosis: **the harness is well-factored and the clinical profile is not.**
`src/core/` has a documented interface, a single reason for each hook, and no domain vocabulary
in it. `src/profiles/clinical/` is 33 flat files and ~11k lines organised by *layer prefix*
(`review-*.ts`, `*-eval.ts`) rather than by the thing that actually varies, which is the task.

---

## 1. Give the clinical profile a task registry — DONE, `TASK_SPECS` in `contracts.ts`

**The problem.** A "task" is not a thing in this codebase — it is a convention spread across
files that must be edited in lockstep.

`contracts.ts:293` declares the union:

```ts
export type Task = 'vital-signs' | 'summary' | 'note-format' | 'transcript' | 'shock'
                 | 'shock-extraction' | 'shock-pipeline' | 'sepsis' | 'sepsis-extraction'
```

and then eleven constants keyed by it (`TASKS`, `UNGRADED_TASKS`, `GRADED_TASKS`,
`TOOLING_TASKS`, `CLINICAL_TASKS`, `DEFAULT_TASK_FOR_SHAPE`, `TASK_FEEDS`, `TASK_ORDER`,
`UNREVIEWABLE_TASKS`, `ROUTED_TASKS`, `SAMPLING_KEY`, `DOCUMENT_KIND`). Some derive from
others; several do not.

Then `profile.ts` dispatches on the same union in **four separate if-chains**:

- `documentNames`, lines 111–119
- `runEval`'s task loop, lines 208–234
- `executeClinicalTask`'s review dispatch, lines 431–463
- the front-door/route path, lines 533+

and `rescore.ts:131–134` has a fifth, which covers only four of the nine tasks. 24 files under
`src/` mention `shock`.

The doc drift is the tell. `AGENTS.md:60` says adding a clinical task takes seven steps across
five files and **never mentions `profile.ts`'s four chains at all**. The recipe is wrong because
the seam is in the wrong place — nobody can hold the real list in their head long enough to
write it down.

**The change.** One `TaskModule` interface, one registry, keyed by task:

```ts
// src/profiles/clinical/tasks/registry.ts
export interface TaskModule {
  name: string
  request(pack: Pack, opts: RequestOptions): TaskRequest
  documentNames(pack: Pack): string[]
  runEval?(shared: SharedEvalOptions): Promise<TaskResult>
  review?(ctx: TaskReviewContext): Promise<ReviewResult>
  rescore?(events: TraceEvent[], record?: Record): RescoreResult
  /** Placement facts that are today eleven parallel tables. */
  graded: boolean
  reviewable: boolean
  kind: 'clinical' | 'tooling'
  documentKind: string
  samplingKey: string
  feedsFrom?: Task
  order: number
}

export const TASKS: Record<Task, TaskModule> = { ... }
export type Task = keyof typeof TASKS
```

`Task` derives from the registry instead of the registry being checked against `Task`. The
eleven tables become derived one-liners (`GRADED_TASKS = keys(TASKS).filter(t => TASKS[t].graded)`).
The five if-chains become `TASKS[task].runEval?.(shared) ?? refuse(task)` — and the careful
refusal at `profile.ts:227` (added after `--task all` silently graded transcripts under a new
task's name) becomes structural rather than a comment asking the next person to remember.

Files move from `review-shock.ts` / `shock-eval.ts` / `shock.ts` to `tasks/shock/{review,eval,rules}.ts`,
so a task is a directory you can read top to bottom.

**Payoff.** Adding a task becomes: one directory, one registry entry, one pack update. The
`AGENTS.md` recipe becomes short enough to be true. Deleting a task becomes possible — right now
it isn't, which is why `sepsis-extraction` sits in the union ungraded.

### What actually shipped, and a correction to the count above

**"Eleven parallel tables" was wrong — five of them were already derived.** `SAMPLING_KEY` and
`DOCUMENT_KIND` are computed from `CONTRACTS`, and `GRADED_TASKS`, `CLINICAL_TASKS` and
`ROUTED_TASKS` were already derived from their neighbours. The real problem was six
*hand-maintained* declarations that had to be edited in lockstep and could not be checked against
each other: the `Task` union, `TASKS`, `UNGRADED_TASKS`, `TOOLING_TASKS`, `TASK_FEEDS`,
`TASK_ORDER` and `UNREVIEWABLE_TASKS`.

**Nothing was moved or renamed.** The plan above implied a new `tasks/` directory and relocating
`Task`. That would have touched ~15 importers across `src/` and `test/` and risked an import
cycle, for no gain: the pain was "one fact about a task lives in six places", not "the file is
called contracts.ts". So `TASK_SPECS` was added *inside* `contracts.ts` and the six lists are now
derived from it. Every symbol is still exported under its old name from its old module — zero
importer churn. A `TASK_SPEC` typed view is declared just after `Task` (a `satisfies` on the
literal is circular, since `feeds` names a `Task` and `Task` is `keyof` the table) and it fails
the build if a `feeds` names a task that does not exist.

**All five dispatch chains are now tables**: `documentNames`, the `runEval` task loop, the
`review` chain and the route path in `profile.ts`, plus the one in `rescore.ts`. The review chain
was the worst of them — it repeated a seven-field argument literal at six call sites, where the
field most easily dropped is `activity`, whose absence costs a task its telemetry and nothing
else, so nothing fails and the dashboard is quietly short one stream. That is now built once.

**The refusals are now cross-checks rather than fall-through.** `executeClinicalTask` refuses on
the registry's own `reviewable: false` instead of by reaching the end of an if-chain, and a task
the registry calls reviewable with no wired reviewer is a distinct, named error.

**Three new tests in `test/clinical.test.ts`** hold the registry and the dispatch tables
together: every reviewable task has a reviewer wired, every graded task agrees with its own flag,
and the registry is internally well-formed (feed targets exist, ranks are unique, tooling holds
no plan rank). The first was mutation-tested — deleting `note-format` from the reviewer table
fails it with `note-format is declared reviewable but profile.ts has no entry in its reviewer
table`, so it is not vacuous.

**Verified**: 832/832 tests pass (829 before, plus the 3 new); `tsc --noEmit` clean apart from the
four pre-existing `test/web-graph.test.ts` errors. All nine derived lists were compared
element-by-element against the hand-written originals before the dispatch work began, and match
exactly, ordering included.

`AGENTS.md`'s "Add a new task" recipe has been corrected — it now names the `TASK_SPECS` entry and
both dispatch tables, which the old seven-step version omitted entirely.

---

## 2. Extract the eval-run skeleton (do this first) — DONE, `src/profiles/clinical/eval-run.ts`

**The problem.** The five model-calling eval runners are the same program five times.

- `sepsis-eval.ts` (353 lines) and `shock-eval.ts` (408 lines): after renaming the syndrome,
  `diff` reports 200 changed lines out of 761 — roughly three quarters is a shared skeleton.
- `const pct = (n, d) => ...` is byte-identical at **line 61 of three different files**
  (`shock-eval.ts`, `sepsis-eval.ts`, `shock-pipeline-eval.ts`) while `scorer.ts` already
  exports a `pct`.
- The same 8-import prelude — `identifyServer`/`UNIDENTIFIED`, `summarizeBench`/`formatBench`,
  `summarizeStability`/`formatStability`, `HARNESS_VERSION`, `extract`, `parseDifficultyRange`,
  `DIFFICULTY_MIN`/`MAX` — opens all five.

The cost isn't the bytes, it's that a fix to the header format, the `--runs` accumulation, or
the difficulty filter has to be found and applied five times, and the fifth copy is the one that
drifts. This is already visible: `shock-pipeline-eval.ts` tracks `lostMs` and `attempts` in its
own `costOf` helper that the others don't have.

**The change.** `src/profiles/clinical/task-eval.ts`:

```ts
export const runTaskEval = async <C, R>(spec: TaskEvalSpec<C, R>, o: SharedEvalOptions): Promise<TaskResult>
```

owning: case loading + difficulty filter, the `--runs` repeat loop, bench and stability
accumulation, identity/version header, gate evaluation and the `TaskResult` shape. The per-task
spec supplies only `loadCases`, `request`, `parse`, `score`, `floors`, and `formatMisses`.

Each syndrome eval drops to roughly 80–120 lines that are *only* its contract and its scoring.

**Why first.** It's the lowest-risk step (the `test/*-eval` tests pin the output), and it shrinks
the surface that step 1 has to re-key by about 900 lines.

### What actually shipped, and two corrections to the above

**The template method was not built.** `runTaskEval(spec)` was tried and abandoned: the head and
tail of these files are mechanical and identical, but the middle — which misses to accuse, which
columns to print, which fields to put in the case record — is bespoke prose in every task, and
inverting it into a dozen callbacks turns deliberate output into template soup at exactly the
point where it is decided. What shipped instead is seven focused helpers, each taking one
mechanical block that was duplicated verbatim: `costOf`/`benchSampleOf`, `evalScope`,
`runConditions`, `announceRun`, `recordParseFailure`, `reportTrailer`, `reportRuleArm`, plus the
shared `pct`. The reasoning is recorded in the file header.

**`pct` was not a redundant copy of `scorer.ts`'s.** They share a name and nothing else:
`scorer.ts` pads both halves to a fixed width and prints a bare `n/a` (it aligns the vital-signs
miss table); the eval copy is unpadded and prints `n/a (0/0)` (it reads inside a sentence).
Merging them would have re-aligned a table that is aligned on purpose. The three copies were
hoisted into `eval-run.ts` as a distinct export instead, with a comment saying why there are two.

**Result.** Duplicate blocks: `pct` 3 -> 1, the bench-cost reduce 3 -> 1, the parse-failure
branch 2 -> 1, the conditions/header/trailer/rule-arm blocks 2 -> 1. `shock-eval.ts` 408 -> 330
lines, `sepsis-eval.ts` 353 -> 279. Measured after renaming the syndrome, the two files' overlap
fell from 561 to 415 lines.

**Line count is a wash and that is the honest number**: 1087 -> 1108 non-comment lines across the
five files, because `eval-run.ts` costs 170 code lines to host what was ~190 duplicated ones, and
carries the shared "why" prose that was previously copy-pasted or missing. The win is the drift
surface, not the byte count — a fix to the cost accounting or the parse-failure record now has
one place to land instead of three.

**Verified**: 815/815 tests pass (unchanged from baseline); `tsc --noEmit` clean apart from four
pre-existing errors in `test/web-graph.test.ts` that predate this work. Console output was
captured before and after for both evals against a canned server and is byte-identical once
wall-clock numbers are scrubbed.

---

## 3. Split `src/server.ts` into a route table — DONE, `src/server/`

**The problem.** 1375 lines, one request handler, one if-chain over `url.pathname`
(lines 564, 649, 700, 778, 1124, 1163, 1275). The `POST /pipeline|/run` handler alone runs from
line 778 to 1124 — **~350 lines inline inside the dispatcher**. Nothing in it is reachable from a
test without opening a socket, which is why `test/server.test.ts` tests transport and not
pipeline logic.

**The change.** A route table and a handler-per-file:

```
src/server/
  index.ts        — listen, CORS, activity wiring, error envelope, 404   (~200 lines)
  routes.ts       — [method, pattern, handler][]
  routes/health.ts events.ts route.ts pipeline.ts session.ts
```

Each handler is `(req: ParsedRequest, deps: ServerDeps) => Promise<Reply>` — pure enough to call
directly from a test. The activity-emit/complete bracket at lines 556–559 stays in one place,
where it belongs.

**Payoff.** The pipeline logic becomes testable without a server, and the CORS/error/activity
policy stops being interleaved with domain work.

### What actually shipped

**server.ts 1436 -> 654 lines**, in four commits. The dispatcher is 32 lines; every handler is
a module under `src/server/routes/`: `health.ts` (94), `corpus.ts` (35), `events.ts` (54),
`route.ts` (89), `pipeline.ts` (370), `session.ts` (172). Alongside them: `reply.ts` (103,
CORS + the five status replies), `sse.ts` (74, the fan-out), `deps.ts` (72).

**`ServerDeps` states what the handlers share.** Every field was already reachable from every
handler — they were one closure, so the dependency was total and invisible. Writing it down does
not add coupling, it makes the coupling countable. The live objects are passed by reference: a
handler with its own copy of the reachability map would answer from a second opinion about which
backends are up.

**The SSE fan-out had to become an object**, not loose functions, because two of its five members
are mutable and shared — `heartbeatTimer` cannot be passed by value at all, and a handler
receiving a copy of the client set would add itself to a set nobody broadcasts to.

**Three things the typechecker caught that the tests did not.** Three `ServerDeps` signatures
were guesses and all three were wrong (`loadPackForProfile` takes three arguments, `sessions`
holds a wrapper around `Session`, `sseClients` is a `Set<ServerResponse>`); a `spawnable` map I
had listed does not exist, because the grep suggesting it matched a comment. Removing the dead
`createSession` import took `type Session` with it, and the full suite still passed — Node strips
the type — which is exactly the trap `tsconfig.json`'s own header describes. And the mechanical
rewrite of closure refs to `deps.*` broke object shorthand every time it touched one (`activity,`
-> `deps.activity,`), eight times across two files.

**Smoke-tested live, beyond the suite**: `/health`, `/corpus`, `/corpus/:id`, a 404 on an unknown
document, an unknown route, session create with and without a profile, session delete, and the
SSE handshake. 839/839 tests pass, typecheck clean.

---

## 4. Split the README; move working notes out of the working tree

**README.md is 995 lines / 57KB** covering, in one file: quickstart, contract-pack format,
profile authoring, verification, trace format, the eight tasks, corpus difficulty, run costs, a
`## Measured` results table (lines 670–803), and a `## Reference` section (804–929). Three
audiences — someone trying it, someone extending it, someone auditing a number — reading past
each other's material. Split to `README.md` (quickstart + what it is + status), `docs/packs.md`,
`docs/profiles.md`, `docs/reference.md`, `docs/measured.md`. The results table especially wants
its own file with a date on it; it goes stale silently inside a README.

**The repo root holds 14 untracked working files** — `report.html` (246KB), `architecture.html`,
`clinical_pipeline_architecture.html`, `graph_proposals.html`, `shock_eval.{html,txt}`,
`next_steps.md`, `k3_project_analysis.md`, `clinical_routing_plan.md`,
`shock_siagnostic_test.md` (typo'd filename). They're gitignored, so this is hygiene rather than
correctness, but they're the first thing anyone sees on a clean `ls`. A gitignored `scratch/`
directory costs one line and one `mv`.

Then correct `AGENTS.md:60` to the recipe step 1 makes possible.

### What actually shipped, and a correction

**README 999 -> 218 lines**, split into six files under `docs/`: `running.md` (247),
`measured.md` (169), `reference.md` (129), `tasks.md` (111), `packs.md` (70), `profiles.md`
(49). The Contents section became a table pointing at them. Content preservation was checked
mechanically: 800 non-blank lines before, 797 after, and every one of the 29 differing lines is
either the old nav block (deliberately condensed), a rewritten link, or a promoted heading. No
prose was lost.

**Twenty links were validated, and the split broke two of them** in a way no test would catch:
`packs/clinical/RESULTS.md` and `spec/pack.md` were correct relative to the repo root and wrong
once their section moved into `docs/`. Both now resolve. Three stale cross-references in
`AGENTS.md` and `CONTRIBUTING.md` ("the README table", "figures in the README") were repointed
at `docs/tasks.md` and `docs/measured.md`.

**Two of the ten root files are NOT disposable, contrary to the claim above.** `PRODUCT.md:11`
specifies "a single standalone `report.html` **at the repository root**" — moving it would
contradict a stated product requirement — and `PRODUCT.md:76` lists `shock_siagnostic_test.md`
under "Evidence on Hand" as the source of every figure in that report. Both stay at the root and
remain ignored by name; the `.gitignore` now says why, so the next person does not re-file them.

The other eight moved to a gitignored `scratch/`, replacing four filename-specific ignore rules
with one directory rule. `docs/running.md` cites `next_steps.md` as the provenance of a measured
number, so that citation was updated to the new path rather than left dangling. Root went from
26 entries to 16, with nothing untracked-and-unignored left in it.

**Verified**: 839/839 tests pass; `tsc --noEmit` clean apart from the four pre-existing
`test/web-graph.test.ts` errors. No test reads the README, so the split carries no test risk —
`test/corpus.test.ts`'s only `README.md` is a fixture it writes itself.

---

## Suggested order

| # | Change | Risk | Guarded by |
|---|--------|------|------------|
| 2 | Eval skeleton | low | `test/shock.test.ts`, `sepsis.test.ts`, `bench.test.ts`, `stability.test.ts` |
| 1 | Task registry | medium | `test/clinical.test.ts` corpus pins, `test/full-routing-flow.test.ts` |
| 3 | Server routes | low | `test/server.test.ts`, `server-activity.test.ts` |
| 4 | Docs | none | — |

3 and 4 are independent of 1 and 2 and can go in any order or in parallel. Each step should land
with `npm run check` green and the corpus numbers unchanged — for 1 and 2 that's the whole
acceptance test, since neither is allowed to move a measurement.

## Explicitly not proposed

- Touching `src/core/`. The boundary is clean, the interface is documented with reasons, and
  `profile.ts`'s two-fields-not-a-union decision for `redact`/`redactFor` is the kind of thing
  a refactor should leave alone.
- Touching `src/vendor/`. It is a copy (`VENDOR.md`).
- The `web/` app. `lib/graph/` at ~2100 lines across five files is large but coherently split,
  and `styles.css` at 2195 lines is the only real smell there — a separate question.
- Reducing the comment density. The "why" comments are this repo's best asset; the refactor
  should carry them to the new locations, not thin them.
