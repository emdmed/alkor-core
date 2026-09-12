# Nomenclature

One word per level, and one level per word. This file is the arbiter: a name that
contradicts it is a bug, in code or in prose.

It exists because `pipeline` used to mean two things — the deployment's front door and one
recipe that front door selects — and both senses appeared in the same function. Renaming the
recipe to `workflow` is what this spec records.

## The levels

| Term | Is | Where it lives |
|---|---|---|
| **Run** | One end-to-end execution for one input. Carries `runId`. | `run.started` / `run.completed` / `run.failed` |
| **Pipeline** | The deployment's front door: a router, the catalogue of workflows it may select, and a default. Exactly one per deployment. | `[pipeline]` in `profiles.toml`, `PipelineConfig`, `POST /pipeline` |
| **Workflow** | One selectable recipe: an ordered list of steps. A *processing shape*. | `mode = "workflow"` profiles, `src/modes/workflow.ts` |
| **Step** | One entry in a workflow. Names a profile and what it reads. | `steps = [...]`, `WorkflowStep`, `step-N` context keys |
| **Assessment** | The run's ending: what it established about this input, rendered for a person. Produced by the terminal step. | `final = true` in `steps`, `src/profiles/clinical-assessment/` |
| **Profile** | What a step invokes: a name, a mode, a pack, a server. | `profiles.toml`, `ProfileModule` |
| **Task** | A profile-internal choice of contract (`vital-signs`, `transcript`, `shock`). | `src/profiles/clinical/contracts.ts` |
| **Pass** | One model call or one deterministic code sweep a task makes. | `TASK_PASSES`, `ClinicalPass` |

Each level is contained by the one above it. A run executes one pipeline decision and then
one workflow; a workflow has steps; a step runs one profile; a profile picks a task; a task
makes passes.

### An assessment is a rendering, not a computation

The terminal step states what the run established and nothing more. It does not classify, it
does not score, and it does not re-read the input — every fact it prints was produced by an
earlier step and checked by a verifier before it. A second computation there would be a
second answer standing beside the first, with nothing to say which one the run means.

Two consequences follow, and both are load-bearing. The page is a pure function of the run,
so it is graded by exact match with no GPU (`eval --profile clinical-assessment`). And a run
a **gate** stopped gets no verdict at all — only the refusal, the step that made it, and its
reason. Withholding is a rendered, graded outcome here, not an error page.

The terminal step runs on EVERY exit, including a refusal, which is the whole reason it is
marked rather than merely placed last: a refused run is the one whose reader most needs a
sentence. It cannot change the run's verdict; `stoppedEarly` is decided before it runs.

### A workflow is a processing shape, not a question

Which syndrome a document raises is a property of the *document*, and is decided one level
down by the clinical router reading the note. A rule in the pipeline router should name a
workflow that processes input **differently** — a batch summary over many records — never a
clinical question asked of the same workflow. See `src/profiles/workflow-router/profile.ts`.

## Stage is not a level

**Stage** is the observability name for a unit of work at *any* level. It is the one word
that cuts across the table above rather than sitting in it.

`runWorkflow` emits a stage named `workflow`; each step emits a stage; `extract()` emits the
triple `prompt-assembly → llm-call → parse` beneath it. All of them are stages, and they are
nodes in one tree joined by `stageId`/`parentId`.

What distinguishes them is **`operation`**, not the name:

- `model` — a model call
- `code` — deterministic work
- `orchestrator` — a stage that only brackets other work
- `decision` — a branch among routes

A view must read `operation` rather than keep a list of stage names it recognises. Such a
list goes stale silently the moment a profile adds a pass. See `spec/activity.md`.

## Words with exactly one meaning

- **Router** — the thing that chooses. The pipeline's front-door router chooses a workflow;
  the clinical profile's router chooses tasks. Never `gateway`.
- **Gateway** — the clinical profile's deterministic rule check over an extracted payload.
  A `code` stage. Never a router.
- **Gate** — a code pass that can **stop the run**. Distinct from a verify pass, which
  annotates and lets the run continue. The failure modes differ, so the words do.
- **Iteration** — one turn of the agentic tool-calling loop (`maxIterations`). Not a *step*:
  a step is a workflow entry, and the agentic loop has no workflow.
- **Context** — the state carried between steps and the checkpoint it is persisted as
  (`WorkflowContext`, `contextDir`, `context.json`). Not `state`, not `checkpoint`.
- **Mode** — the execution shape a profile declares: `extract`, `agentic`, `router`, `code`,
  `workflow`. Eval is a *command*, not a mode.
- **Code** (as a mode) — a profile that calls no model: it reads structures other steps
  produced and returns one of its own. `clinical-verifier` and `clinical-assessment` are the
  two. Separate from `router` because `router` is the thing that CHOOSES and these choose
  nothing; they run through the same call, so the distinction costs nothing at the call site
  and answers "does this step need a model backend?" truthfully.

## One known exception

The clinical task `shock-pipeline` keeps its name, and it is not a pipeline in the sense
above. It is two clinical *tasks* chained under one `--task` flag: prose extraction, then
classification. The name survives because it is public surface — a `--task` value, a pack
data key (`shockExtractionCases.pipeline`), and a row in the eval tables — and renaming it
would edit answer keys rather than vocabulary.

Read it as a fixed proper noun. Nothing else in the repository may use `pipeline` to mean a
chain of work.

## Compatibility

Two retired spellings are still accepted on input, both resolved at the edge so exactly one
spelling exists downstream:

- `mode = "pipeline"` in `profiles.toml` → `mode = "workflow"`, resolved in `loadConfig`, so
  out-of-tree profile definitions keep loading.
- `alkor pipeline` on the CLI → the `workflow` command, resolved in `src/cli.ts`, so
  existing scripts keep running. `npm run workflow` is the current spelling.

Nothing in this repository writes either.

These were renamed with no alias, because each is a contract with a version to bump or a
field nobody stores:

- Activity event kinds `pipeline.*` → `workflow.*`, and `turn.completed.steps` →
  `iterations`. A wire change: `ACTIVITY_SPEC` is now `2`, and a reader that does not
  recognise the version drops the connection rather than parsing it.
- `GET /topology` reports `workflows` where it reported `pipelines`.
- The persisted workflow context (`context.json`) holds `values` where it held `state`.
- `maxSteps` → `maxIterations` on `ProfileModule`, and `--steps` → `--iterations` on the
  CLI. `AgenticResult.stop` reports `iteration_cap` where it reported `step_cap`.
