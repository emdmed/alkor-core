# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

The harness is TypeScript on Node >= 24, run directly — no bundler, no framework, no build
step. There are three ways in and they drive the same assembly; nothing is reimplemented for
the browser:

- **`./start`** — one command from a fresh clone to a running dashboard.
- **`node src/cli.ts`** — the front door for every verb (`doctor`, `extract`, `eval`, `agent`,
  `route`, `workflow`, `profiles`).
- **`POST /pipeline`** on `node src/server.ts` — one request, one run id, back a verdict or a
  refusal naming the step that stopped, and the path of the trace it was recorded to. curl, a
  script and a cron job are first-class callers.

The server's `GET /events` SSE stream is what the live surfaces read. Two UI surfaces sit on
top, and they share the harness rather than reimplementing it:

- **`report.html`** — one standalone document at the repository root. No build step, no
  external network requests, every face and asset embedded.
- **`web/`** — the browser dashboard: React 19 + Vite 8 + Tailwind 4, Radix primitives,
  `@xyflow/react` for the execution graph, lucide icons. Dev on `npm run web`, static build to
  `web/dist/`. The intelligence is not in the app: the pure reducer in `src/monitor/state.ts`
  and the SSE core in `src/monitor/sse-core.ts` are dependency-free and unit-tested on Node,
  and the app supplies only the transport and the paint.

## Users

Three audiences. Which one leads depends on the surface, and all three are real:

1. **Someone evaluating alkor cold** — an engineer or clinical-informatics reader who has
   not read the repository, arriving at a result document and deciding whether the tool is
   credible. Confirmed as the audience for `report.html`, and the reason the README and the
   docs under `docs/` read the way they do.
2. **The maintainer and collaborators** — writing and revising contract packs, reading eval
   traces, deciding whether a prompt change earned its keep. This is the audience for the
   inspector, and their situation is specific: a run is in flight on the machine in
   front of them, one case at a time, slow enough that watching is a real activity, and they
   need to see where it has got to and what a given node actually sent and received.
3. **A curious technical-adjacent user** — a researcher, a self-hoster, a small clinic's
   tech-inclined person. Comfortable with software, **not an engineer**. Confirmed on
   2026-09-12 as the audience the **web dashboard** leads for. They are running alkor on
   their own machine and want to watch the machinery work and understand it, without being
   asked to read JSON, SSE frames, or a contract pack to do so. The raw material stays
   reachable one level down; it is no longer the front door.

The job in every case is the same: run a medical workflow on a small local model and know which
parts of its output can be trusted.

## Product Purpose

**alkor is an orchestration layer that sits between your prompt and local inference.** Three
things happen in that layer — **context management, model constraint, and tool calls** — and
they are there for one purpose: *to make small local models better at medicine.*

Everything else follows from where the layer sits. alkor runs an entire medical workflow on the
user's own hardware — starting each `llama-server` a step needs and stopping it after — and
checks every reading back against the note it came from. When a check fails, it reports nothing
rather than something plausible.

The premise is that **a 4B model is not a clinician**: a model small enough to run beside the
notes will miss findings, invent plausible ones, and get arithmetic wrong, all in the same
confident voice, and prompt wording does not fix that. alkor does not touch the weights. It
makes output checkable and drops what fails.

The user writes a **contract pack** — prompts, JSON schemas, eval cases — which is data, so the
pack that runs in production is the one the eval grades. "Good enough" is therefore a gate with
a floor rather than an impression.

## Positioning

The layer earns its place because a small model fails in ways prompt wording cannot reach.
Three answers to three failure modes — this is the mechanism a neighboring product could not
truthfully copy:

- **Invents findings** → every reading carries a verbatim quote, and a *second model* checks
  those quotes against the note. An unquoted reading never reaches output.
- **Cannot do arithmetic** → shock index, MAP and pulse pressure are recomputed in code from
  quoted values. The model's own numbers are dropped, not reconciled.
- **Will not say "I don't know"** → declining is scored, not excused. "Normal" and "nobody
  looked" stay distinct.

Around that: the pack is data, and the same files serve production runtime and measurement.
Generic eval frameworks (promptfoo, Inspect, lm-eval) measure prompts against models across
many tasks; the evals here exist to keep one contract honest, and that contract is the artifact
production reads. Narrower on purpose.

## Operating Context

- Everything runs on the user's own hardware. Under the orchestrator, alkor starts each
  `llama-server` a step needs and stops it after: `LlamaManager` spawns a backend on first
  request, polls `/health` until ready, and sweeps it after idle, with in-flight counting so a
  backend is never killed mid-generation. Pinned profiles (the router) are never swept. A step
  may name its own port, so one workflow spans several models at once.
- **For a measured eval the harness never starts a server**, because a server's flags are part
  of a measurement. That asymmetry is deliberate, not an inconsistency.
- Models named by sha256. The reference pack's default is **Gemma 4 E4B Q4_0**
  (`ggml-org/gemma-4-E4B-it-GGUF`, sha256 `a555b900…`, pinned in
  `packs/clinical/models.default.toml`) — run at ctx 32768, 1 slot, temperature 0, seed 0,
  sequential, `cache_prompt` on.
- Runs write JSONL traces to `~/.local/state/alkor/traces/<profile>/`, the CLI and the server
  alike — a run driven from the dashboard leaves the same record a CLI verb leaves, and
  `GET /runs` is the index over them. `ALKOR_SERVER_TRACE=0` turns the server's half off.
- Contract packs live under `packs/`; profiles under `src/profiles/`; results under
  `packs/<pack>/RESULTS.md`, which holds the rule that a result may never be a number the
  repository cannot reproduce.
- Pack schemas carry `$id`s under `https://alkor.dev/packs/<pack>/`. These are identifiers,
  not locations: the domain is unregistered and nothing resolves them. `$id` is ignored by
  llama.cpp's schema-to-grammar conversion, so it is the one part of a schema that can be
  edited without invalidating a measurement.
- Generation on this hardware is slow enough to be a design fact: on an 8-core CPU with no
  GPU, 8.7 tok/s, median case latency 19.5s, twenty cases in 485.7s, and a cold first case of
  107.7s. Every live surface is designed for a run that takes minutes, not milliseconds.

## Capabilities and Constraints

- **What the layer does, concretely — three jobs:**
  - **Context management.** Every step is a fresh call with no conversation history; what
    reaches the model is declared context, assembled per step from the pack and from prior
    steps' output.
  - **Model constraint.** The pack's JSON Schema is passed as `response_format.json_schema` and
    the server compiles it into a GBNF grammar, so invalid JSON is physically impossible to
    emit. The shape of the answer is decided before generation, not repaired after.
  - **Tool calls.** `toolChat()` carries `tools` and `tool_choice: "auto"` for agentic steps —
    a separate transport function rather than a flag, so it cannot be reached from eval by
    accident.
- **Nomenclature, one name per level: Run › Pipeline › Workflow › Step › Profile › Task→Pass.**
  This is the vocabulary every surface uses and the terms are not interchangeable. **"Stage" is
  not a level** — it is what a unit of work is called at any level, joined by `stageId`.
- **The orchestrator knows nothing about medicine** — the domain lives entirely in packs and
  profiles, and the layer would run a non-medical contract unchanged.
- A run ends in a verdict or a refusal that names the step that stopped it.
- Reference workflow **`clinical-verified`**: extract (gemma-4-E4B, :8081, 19.5s) →
  verify-derived (code, no GPU, 3ms) → verify-source (second model, :8085, 8.1s) → assess
  (code, 1ms). **Two of the four steps decide by rule and never touch a GPU**, and the ending is
  graded and renders to the same bytes every time.
- Constrained decoding against the pack's JSON Schema; schema property order and `maxItems`
  are load-bearing, not decorative.
- Evals report a gate (pass/fail against a floor) plus sub-gates such as echo of primary
  findings and invented-finding count.
- Observability: `GET /events` streams the run while it is in flight and `GET /runs` reads it
  back afterwards — the feed is a bounded ring buffer, the traces are files, and a surface
  that could only reach the first would lose every run older than the buffer. The desktop dashboard (`localhost:5173`) draws
  the stage tree live, with tool calls, HTTP traffic and a filterable, click-to-inspect log.
  **It observes, never drives** — and because the graph *is* the run, a stopped run is legible
  on sight. `report.html` is the standalone counterpart: no network requests, with the limits
  stated beside each figure.
- **The web dashboard is desktop-only.** It is operated beside a running server on the machine
  doing the work, so there is no mobile target and phone-width behavior is out of scope.
- **Not a medical device**, not clinical decision support, not validation evidence for any
  regulator. A research and educational tool; its output is not to be used to make medical
  decisions. The caveat travels with the output — it is resident in the dashboard header and
  carried in every copied run log, not left to a surface a reader may never open.
- **Not an inference server** and **not a generic eval framework**.
- Status: `0.1.1`, the first release. Any pre-release stage is a semver prerelease tag on the
  package version and is derived from it, never declared a second time — `src/core/version.ts`
  is the one place that reads it, the CLI banner and the dashboard's badge both render what it
  says, and both fall silent on a release version rather than going stale.

## Brand Commitments

- Name is lowercase `alkor`. Capitalised only where a platform forces it: the `ALKOR_*`
  environment variables and TypeScript identifiers (`useAlkor`, `createAlkorServer`).
- **The name does not describe the product, so it never travels alone on a first mention.**
  Pair it with a descriptor — "alkor — small local-model orchestration for medical workflows"
  — in every page title, README heading and result document. The hero line, confirmed
  2026-09-13, is **"Small local models better at medicine."** Descriptors that narrow the
  product to extraction alone are stale and are not to be reintroduced. The previous name
  carried the description inside the word and this one does not; the reader arriving cold is
  the one who pays for that difference, and they are audience #1.
- Provenance, for anyone writing copy: Alkor is the faint companion of Mizar in Ursa Major,
  and for centuries a test of eyesight — whether you could resolve it told you whether your
  instrument was good enough. A corpus of cases that discriminate does the same job, so the
  metaphor is load-bearing rather than decorative. The spelling is the coiner's own second
  one: Petrus Apianus wrote "Alcor" in *Cosmographicus Liber* (1524) and "Alkor" in
  *Astronomicum Caesareum* (1530). From Arabic *al-khawwār*, "the faint one"; the star is
  also *as-suhā*, "the forgotten one".
- The `k` is not optional. `Alcor` collides with Alcor Micro (flash controllers) and the
  Alcor Life Extension Foundation (cryonics) — the second actively misleading beside a
  clinical tool.
- Voice in existing docs: plain, exact, unhedged; states what a number does not show in the
  same breath as the number. Never oversells.
- **The web dashboard is a conventional modern dashboard, and that is a standing decision,
  not a default nobody made.** Asked on 2026-09-12 to choose between four derived visual
  directions and the category standard, the user chose the category standard in plain
  words, with Linear, Vercel and Stripe named as the craft bar. Convention is therefore the
  commitment: neutral surfaces, a single accent, borders carrying structure, restrained
  motion, executed at that level of finish and without irony. Future work on this surface
  raises the craft, never smuggles a metaphor back in. The one element carried across from
  the superseded worlds is the `alkor` wordmark with its Mizar/Alcor star pair.
- MIT. Contract packs under `packs/` carry CC BY 4.0 separately.

## Evidence on Hand

- `shock_siagnostic_test.md` — the shock-category ablation, written 2026-09-07. Four arms
  (harness, A naked, B labels, C tooling-only), 20 synthetic payloads, plus a label-order
  probe. This is the source of every figure in `report.html`.
- `packs/clinical/evals/shock-cases.json` — the corpus and its `_whatThisIsNot` note.
- `packs/clinical/RESULTS.md` — the dated, reproducible runs, each naming its weights, flags,
  machine and trace file. The current default model's entries are 2026-09-09 (shock, 20 cases,
  PASS) and 2026-09-10 (sepsis screen, 14 payloads, PASS against the then-three-gate contract,
  with the four-gate re-measurement still owed). Figures for other tasks are still against the
  previous default and say so; nothing there may be reported as a claim about these weights.
- The corpus contains **no patients**; all twenty payloads are synthetic. Nothing in the
  result is diagnostic accuracy; it is agreement with a published bedside heuristic
  (Vazquez et al., J Hosp Med 2010).
- The ablation arms A/B/C were run from throwaway scripts that no longer exist. Those figures
  are currently **not reproducible from this repository** — a stated limitation that must
  never be presented as settled measurement.

## Product Principles

1. When a check fails, report nothing rather than something plausible.
2. Don't fix the model, make its output checkable — quote what it claims, recompute what it
   calculates, and drop what does not survive.
3. What was measured is what runs — one assembly feeds both eval and production.
4. A number ships with what it does not show attached to it, and a result the repository cannot
   reproduce is evidence, not a measurement.
5. Restraint is a measured property: declining to answer is scored, not excused.
6. The honest baseline is always on the table, including when it beats the model.

## Accessibility & Inclusion

Standard web accessibility, on the read surface and the dashboard alike: real text over images
of text, sufficient contrast at the chosen pastel register (this is a stated risk of that
palette, not a license to fall below WCAG AA on body copy), keyboard-reachable interactive
elements, and no meaning carried by color alone in any chart or run state. Measured values are
read, compared and quoted, so type size on data is an accessibility concern here rather than a
stylistic one. Desktop-only for the dashboard is a scope decision about screen width, not
permission to drop keyboard or contrast support.
