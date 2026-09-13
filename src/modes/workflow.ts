/**
 * Workflow mode: orchestrate multi-model recipes where the output of one specialist
 * becomes the input of the next.
 *
 * A workflow is a sequence of steps, each naming a profile and describing what it reads.
 * The workflow itself is stateless: it holds the step definitions and the intermediate
 * results, and it delegates every actual model call to the profile's own mode (extract,
 * agentic, or nested workflow). See `spec/nomenclature.md` for how workflow, step, profile,
 * task and pass nest — and for why the deployment's front door is the PIPELINE, of which a
 * workflow is one selectable recipe.
 *
 * The harness already supports per-profile servers and per-profile packs; a workflow
 * simply composes them. Each step runs against whatever server and model its profile
 * names in `profiles.toml`, so a workflow with four steps may talk to four different
 * llama-server instances on four different ports, each loaded with a different quantisation.
 *
 * Error handling is deliberately simple: a step that fails stops the workflow and returns
 * what it has so far. There is no retry, no fallback, and no circuit breaker — those belong
 * to the product layer above, not to the harness that runs the steps.
 *
 * THE TERMINAL STEP. A workflow may mark its last step `final`, and that step runs on every
 * exit — after the chain completes, after a step is rejected, and after a step throws. It is
 * how a workflow ends with a statement rather than with whatever its last successful step
 * happened to leave behind. A refused run is exactly when a caller most needs a sentence, so
 * the one step whose job is to produce that sentence is the one step a refusal may not skip.
 *
 * A terminal step reads `run` — a value the workflow composes for it holding the initial
 * input, every step result so far (including the error of the one that refused), and whether
 * the chain stopped early. It reads results by PROFILE rather than by index, so reordering a
 * recipe cannot silently point it at the wrong step.
 *
 * Running it changes no verdict: `stoppedEarly` is decided before it runs and is not
 * revisited, so an ending that renders successfully never turns a refused run into a passed
 * one. If the terminal step itself fails, its failure is recorded beside the others and the
 * run's original verdict stands.
 *
 * A workflow step may read:
 * - `initial`: the original user input that started the workflow.
 * - `step-N`: the output of step N (0-indexed).
 * - `step-N.raw`: the raw completion of step N, before parsing.
 * - `step-N.text`: the rendered text of step N, when available.
 * - `step-N.report`: the structured report of step N, when available.
 * - an OBJECT of names to refs, when a step needs to COMPOSE its input from more than one
 *   source: `{ document = "initial", extraction = "step-1.report" }` hands the step a JSON
 *   object built from the two refs. Template refs resolve STRICTLY — a ref whose field the
 *   previous step did not produce resolves to `undefined` (which `JSON.stringify` drops)
 *   rather than substituting the whole step's values, so a template cannot quietly smuggle the
 *   previous step's spill into a field the consumer treats as a specific thing.
 *
 * A workflow step may write:
 * - `output`: the step's structured output, if the profile produces one.
 * - `raw`: the raw completion.
 * - `text`: the rendered text.
 * - `report`: the structured report.
 */

import type { ProfileModule, ReviewContext, ReviewResult } from '../core/profile.ts'
import type { Pack } from '../core/pack.ts'
import type { Trace } from '../core/trace.ts'
import type { Activity, TemplateRefEntry } from '../core/activity.ts'
import { nextStageId, withActivityScope, currentActivityScope } from '../core/activity.ts'
import { extract, type ExtractOutcome } from './extract.ts'
import type { Provider } from '../core/client.ts'
import { runAgent } from './agentic.ts'
import { type RouterOptions } from './router.ts'
import { nullTrace } from '../core/trace.ts'
import { callsModel } from '../core/config.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WorkflowStep {
  /** Human-readable name for diagnostics. */
  name: string
  /** The profile to run for this step. */
  profile: string
  /**
   * What this step reads as its input. A ref like `step-1.report`, or an object template
   * that composes several refs into one JSON object (see the header). Defaults to
   * `initial` for the first step, and `step-${n-1}.output` for subsequent steps.
   */
  input?: string | Record<string, string>
  /**
   * Which field of the previous step to read. Defaults to `output`.
   * Supported: `output`, `raw`, `text`, `report`, `document`.
   */
  field?: string
  /**
   * Override options passed to the step's profile. Merged with the workflow's
   * shared options; explicit step options win.
   */
  options?: Record<string, unknown>
  /**
   * The terminal step: runs on every exit, including a refusal. At most one per workflow and
   * it must be last. Defaults its input to `run` (see the header).
   */
  final?: boolean
}

export interface WorkflowOptions {
  /** The user input that started the workflow. */
  initialInput: string
  steps: WorkflowStep[]
  /** Shared options passed to every step unless overridden. */
  options?: Record<string, unknown>
  /** A pre-loaded profile map, so the workflow does not re-import modules. */
  profiles: Map<string, ProfileModule>
  /** A pre-loaded pack map, indexed by profile name. */
  packs: Map<string, Pack | undefined>
  /** Base URLs per profile, from profiles.toml. */
  baseUrls: Map<string, string | undefined>
  /** Trace for the workflow as a whole; each step writes its own sub-trace. */
  trace?: Trace
  /**
   * Directory to save the workflow context after each step. Enables resuming after a crash
   * and step-by-step execution where only one model is loaded at a time.
   */
  contextDir?: string
  /**
   * Run only this step (0-indexed). Requires `contextDir` for steps > 0,
   * because the context from previous steps must be loaded from disk.
   */
  runStep?: number
  /**
   * Cancellation for the run as a whole, checked at every step boundary.
   *
   * The provider carries the same signal into each model call, so a cancel that lands
   * mid-generation stops that call. This is the other half: a cancel that lands during a
   * code step — verify-derived and assess are milliseconds apiece and never see a provider
   * — would otherwise go unnoticed until the next model call started, which on this
   * hardware means loading a set of weights for a run nobody is waiting for.
   */
  signal?: AbortSignal
  /** A custom LLM provider; defaults to the built-in HTTP client. */
  provider?: Provider
  /** Activity bus for operational events. */
  activity?: Activity
  /**
   * Bring up the backend a step is about to use, returning null when it is usable and the
   * reason when it is not. Called once per step that can reach a model, immediately before
   * that step runs — which is what keeps a multi-model workflow to one resident model at a
   * time on a machine that cannot hold two. The step whose backend cannot be made usable
   * fails like any other failing step; the workflow stops there and its terminal step still
   * runs, so a run refused for want of memory still ends with a sentence.
   *
   * Absent, every step assumes its backend is already up — which is how the CLI runs, where
   * the operator started the servers themselves.
   */
  ensureBackend?: (baseUrl: string | undefined, profile: string) => Promise<string | null>
}

/** The values carried between steps, serialized to `contextDir` after each one. */
export interface WorkflowContext {
  initialInput: string
  results: WorkflowStepResult[]
  values: Record<string, unknown>
  completedStep: number
}

const CONTEXT_FILE = 'context.json'

const saveContext = (dir: string, context: WorkflowContext) => {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, CONTEXT_FILE)
  writeFileSync(path, JSON.stringify(context, null, 2), 'utf8')
  // Also write per-step files so the next step (or a human operator) can read
  // the context message without parsing the whole of it.
  for (const result of context.results) {
    writeFileSync(join(dir, `step-${result.step}.json`), JSON.stringify(result, null, 2), 'utf8')
  }
}

const loadContext = (dir: string): WorkflowContext | undefined => {
  const path = join(dir, CONTEXT_FILE)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WorkflowContext
  } catch {
    return undefined
  }
}

// The highest step result by step number, not by array index. After a re-run the
// array may not be in step order, so the last element is not necessarily the final step.
const highestStepResult = (results: WorkflowStepResult[]): WorkflowStepResult | undefined =>
  results.length === 0 ? undefined : results.reduce((a, b) => (b.step > a.step ? b : a))

/** The newest value a step actually produced, including a rejected verifier report. */
const finalOutput = (results: WorkflowStepResult[]): unknown => {
  const produced = results.filter((result) => result.output !== undefined)
  return highestStepResult(produced)?.output
}

export interface WorkflowStepResult {
  step: number
  name: string
  profile: string
  /** Whether the step produced a usable result. */
  ok: boolean
  /** The result, shape depends on the profile's mode. */
  output?: unknown
  /** Raw completion when the profile produces one. */
  raw?: string
  /** Rendered text when the profile produces one. */
  text?: string
  /** Structured report when the profile produces one. */
  report?: unknown
  /** Error message when the step failed. */
  error?: string
  /** Latency of the step in milliseconds. */
  wallMs?: number
}

export interface WorkflowResult {
  /** All steps that ran, in order. */
  steps: WorkflowStepResult[]
  /**
   * The last output the workflow produced, whatever its shape.
   *
   * Present on an early stop when the rejected step returned a usable report, or when an
   * earlier step produced output before a later step threw. The HTTP caller asked for a run,
   * so losing its produced value merely because the workflow also reports failure makes the
   * response impossible to inspect.
   */
  final?: unknown
  /** The workflow stopped early because a step failed. */
  stoppedEarly: boolean
  /**
   * The chain stopped because `signal` fired, not because a step went wrong.
   *
   * `stoppedEarly` cannot answer this: it is set by any step returning not-ok, which is the
   * same signal for a step that broke, a verifier that refused a quote, and a run somebody
   * cancelled. A caller distinguishing "stop, I asked for that" from "stop, something is
   * wrong" would otherwise be reading the error strings, and this is the fact rather than a
   * recognisable message.
   */
  cancelled?: boolean
  /** Total wall time for the workflow. */
  totalMs: number
}

/** Run a workflow from step 0 to completion or first failure. */
export const runWorkflow = async (o: WorkflowOptions): Promise<WorkflowResult> => {
  const startedAt = performance.now()
  o.activity?.emit({ kind: 'workflow.started' })
  // The root node of the decision tree. Steps nest under it (see stepStageId below).
  const rootStageId = o.activity ? nextStageId() : undefined
  o.activity?.emit({
    kind: 'stage',
    stageId: rootStageId,
    name: 'workflow',
    status: 'started',
    detail: { steps: o.steps.length },
  })
  const rootDone = (stoppedEarly: boolean, totalMs: number) =>
    o.activity?.emit({
      kind: 'stage',
      stageId: rootStageId,
      name: 'workflow',
      status: 'completed',
      wallMs: totalMs,
      detail: { stoppedEarly },
    })
  let results: WorkflowStepResult[] = []
  const context = new Map<string, unknown>()
  let startStep = 0
  let initialInput = o.initialInput

  // The terminal step is not part of the chain: the loop below never reaches it, and
  // `conclude` gives it its turn on whichever exit the chain takes.
  const terminalIndex = terminalStepIndex(o.steps)
  const chainEnd = terminalIndex === -1 ? o.steps.length : terminalIndex

  // Load a saved context if contextDir is provided.
  if (o.contextDir) {
    const saved = loadContext(o.contextDir)
    if (saved) {
      // Step 0 is always a fresh start: overwrite any previous context.
      if (o.runStep !== 0) {
        results = saved.results
        for (const [key, value] of Object.entries(saved.values)) {
          context.set(key, value)
        }
        initialInput = saved.initialInput
        // When re-running a specific step, truncate downstream results and context so the
        // re-run starts clean. Without this, stale results from later
        // steps survive and corrupt the final output.
        if (o.runStep !== undefined && o.runStep > 0) {
          results = saved.results.filter((r) => r.step < o.runStep!)
          for (const key of Array.from(context.keys())) {
            if (key.startsWith('step-')) {
              const stepNum = parseInt(key.slice('step-'.length), 10)
              if (stepNum >= o.runStep!) context.delete(key)
            }
          }
        }
        if (o.runStep === undefined) {
          // Chain steps only. The terminal step runs after every exit, so it is the highest
          // result in a saved context whether or not the chain got anywhere — reading it here
          // would report a refused run as finished.
          const lastResult = highestStepResult(saved.results.filter((r) => r.step < chainEnd))
          if (lastResult && !lastResult.ok) {
            // The last step failed; resume from it so it can be re-run after a fix.
            startStep = lastResult.step
          } else {
            startStep = saved.completedStep + 1
          }
        }
      }
    } else if (o.runStep !== undefined && o.runStep > 0) {
      throw new Error(
        `no context in '${o.contextDir}' — step ${o.runStep} needs values from previous steps`,
      )
    }
  }

  // If nothing was loaded, initialise from the beginning.
  if (context.size === 0) {
    context.set('initial', initialInput)
  }

  const persist = (completedStep: number) => {
    if (!o.contextDir) return
    saveContext(o.contextDir, {
      initialInput,
      results,
      values: Object.fromEntries(context),
      completedStep,
    })
  }

  /**
   * Run the terminal step, whatever brought the chain here.
   *
   * It reads `run`: the initial input, the results so far, and the verdict already reached.
   * The results are COPIED into that value so the step cannot see its own entry, and the
   * verdict is passed in rather than recomputed so nothing the ending does can revise it.
   */
  const runTerminal = async (stepDef: WorkflowStep, index: number, stoppedEarly: boolean): Promise<void> => {
    const stepStart = performance.now()
    // Its own entry is filtered out, not merely absent: on a resume the saved context still
    // holds the ending written for the previous attempt, and a step handed its own last answer
    // as evidence is a step that can agree with itself.
    context.set('run', { output: { initialInput, steps: results.filter((r) => r.step !== index), stoppedEarly } })
    const inputRef = stepDef.input ?? 'run'
    const input = resolveInput(context, inputRef, stepDef.field)

    o.activity?.emit({
      kind: 'workflow.step.started',
      step: index,
      name: stepDef.name,
      profile: stepDef.profile,
      input: { ref: describeInputRef(inputRef), field: stepDef.field, fromProfile: o.steps[index - 1]?.profile },
    })
    const stepStageId = o.activity ? nextStageId() : undefined
    o.activity?.emit({
      kind: 'stage',
      stageId: stepStageId,
      parentId: rootStageId,
      name: stepDef.name,
      status: 'started',
      detail: { step: index, profile: stepDef.profile, final: true, input: { ref: describeInputRef(inputRef), field: stepDef.field } },
    })

    const record = (stepResult: WorkflowStepResult) => {
      const existingIdx = results.findIndex((r) => r.step === index)
      if (existingIdx !== -1) results.splice(existingIdx, 1)
      results.push(stepResult)
      o.activity?.emit({ kind: 'workflow.step.completed', step: index, name: stepDef.name, profile: stepDef.profile, ok: stepResult.ok, wallMs: stepResult.wallMs ?? 0 })
      o.activity?.emit({ kind: 'stage', stageId: stepStageId, parentId: rootStageId, name: stepDef.name, status: 'completed', wallMs: stepResult.wallMs, detail: { step: index, ok: stepResult.ok, final: true } })
      // Checkpoint the ending, but leave `completedStep` where the CHAIN left it: a resume
      // must still restart at the step that refused, and an ending written after it is not
      // evidence that it succeeded.
      persist(highestStepResult(results.filter((r) => r.step < chainEnd))?.step ?? -1)
    }

    const profile = o.profiles.get(stepDef.profile)
    if (!profile) {
      record({
        step: index,
        name: stepDef.name,
        profile: stepDef.profile,
        ok: false,
        error: `profile '${stepDef.profile}' not found in workflow profile map`,
        wallMs: performance.now() - stepStart,
      })
      return
    }

    // The ending needs its own backend like any other step, and by the time it runs the
    // chain's last model may have been evicted to make room for one of its successors.
    const unusable = callsModel(profile.mode)
      ? await o.ensureBackend?.(o.baseUrls.get(stepDef.profile), stepDef.profile)
      : null
    if (unusable) {
      record({
        step: index,
        name: stepDef.name,
        profile: stepDef.profile,
        ok: false,
        error: unusable,
        wallMs: performance.now() - stepStart,
      })
      return
    }

    try {
      const result = await withActivityScope({ ...currentActivityScope(), parentId: stepStageId }, () =>
        runStep({
          profile,
          pack: o.packs.get(stepDef.profile),
          baseUrl: o.baseUrls.get(stepDef.profile),
          input,
          options: { ...o.options, ...stepDef.options },
          trace: o.trace,
          provider: o.provider,
          activity: o.activity,
        }),
      )
      context.set(`step-${index}`, { output: result.output, raw: result.raw, text: result.text, report: result.report, document: result.document })
      record({
        step: index,
        name: stepDef.name,
        profile: stepDef.profile,
        ok: result.ok,
        error: result.ok ? undefined : result.text,
        output: result.output,
        raw: result.raw,
        text: result.text,
        report: result.report,
        wallMs: performance.now() - stepStart,
      })
    } catch (e) {
      record({
        step: index,
        name: stepDef.name,
        profile: stepDef.profile,
        ok: false,
        error: (e as Error).message,
        wallMs: performance.now() - stepStart,
      })
    }
  }

  /**
   * Every exit from the chain goes through here, which is what makes the terminal step
   * unskippable. `--step N` is excluded: a single-step re-run is an inspection of one step,
   * not a run, and appending an ending to it would write a conclusion nobody asked for.
   */
  const conclude = async (stoppedEarly: boolean, announce = true): Promise<WorkflowResult> => {
    if (terminalIndex !== -1 && o.runStep === undefined) {
      await runTerminal(o.steps[terminalIndex]!, terminalIndex, stoppedEarly)
    }
    const totalMs = performance.now() - startedAt
    rootDone(stoppedEarly, totalMs)
    if (announce && !stoppedEarly) o.activity?.emit({ kind: 'workflow.completed', stoppedEarly: false, totalMs })
    // Read from the signal rather than passed in, so it is right on every exit — a cancel
    // that lands inside a step arrives as that step's error, and only the signal knows
    // the difference between that and a step that genuinely broke.
    return {
      steps: results,
      final: finalOutput(results),
      stoppedEarly,
      ...(o.signal?.aborted ? { cancelled: true } : {}),
      totalMs,
    }
  }

  const actualStart = o.runStep !== undefined ? o.runStep : startStep
  const endStep = o.runStep !== undefined ? o.runStep + 1 : chainEnd

  // `--step N` may name the terminal step directly: recomposing the ending from a saved
  // context is the one thing worth doing without re-running any model.
  if (o.runStep !== undefined && o.runStep === terminalIndex) {
    const stoppedEarly = results.some((r) => !r.ok)
    await runTerminal(o.steps[terminalIndex]!, terminalIndex, stoppedEarly)
    const totalMs = performance.now() - startedAt
    rootDone(stoppedEarly, totalMs)
    return {
      steps: results,
      final: finalOutput(results),
      stoppedEarly,
      ...(o.signal?.aborted ? { cancelled: true } : {}),
      totalMs,
    }
  }

  if (actualStart >= chainEnd) {
    return conclude(false, false)
  }

  for (let i = actualStart; i < endStep; i++) {
    const stepDef = o.steps[i]!
    // Checked BEFORE the step is announced, so a cancelled run does not emit a
    // `workflow.step.started` for a step that never begins — a dashboard drawing the graph
    // from the feed would leave that node spinning forever. The recorded step says
    // cancelled rather than failed, because those are different things and this is the
    // only place that still knows which one happened.
    if (o.signal?.aborted) {
      results.push({
        step: i,
        name: stepDef.name,
        profile: stepDef.profile,
        ok: false,
        error: 'run cancelled before this step started',
        wallMs: 0,
      })
      return conclude(true)
    }
    const stepStart = performance.now()
    const inputRef = stepDef.input ?? (i === 0 ? 'initial' : `step-${i - 1}.output`)
    const input = resolveInput(context, inputRef, stepDef.field)

    const fromProfile = i > 0 ? o.steps[i - 1]!.profile : undefined
    o.activity?.emit({
      kind: 'workflow.step.started',
      step: i,
      name: stepDef.name,
      profile: stepDef.profile,
      input: { ref: describeInputRef(inputRef), field: stepDef.field, fromProfile },
    })
    // The step as a node in the decision tree, attached under the workflow root. Everything
    // the step's own mode and provider emits while running nests underneath it via the
    // parentId scope in `withActivityScope` below.
    const stepStageId = o.activity ? nextStageId() : undefined
    o.activity?.emit({
      kind: 'stage',
      stageId: stepStageId,
      parentId: rootStageId,
      name: stepDef.name,
      status: 'started',
      detail: { step: i, profile: stepDef.profile, input: { ref: describeInputRef(inputRef), field: stepDef.field, fromProfile } },
    })

    const profile = o.profiles.get(stepDef.profile)
    if (!profile) {
      const wallMs = performance.now() - stepStart
      const fail = {
        step: i,
        name: stepDef.name,
        profile: stepDef.profile,
        ok: false,
        error: `profile '${stepDef.profile}' not found in workflow profile map`,
        wallMs,
      }
      results.push(fail)
      o.activity?.emit({ kind: 'workflow.step.completed', step: i, name: stepDef.name, profile: stepDef.profile, ok: false, wallMs })
      o.activity?.emit({ kind: 'stage', stageId: stepStageId, parentId: rootStageId, name: stepDef.name, status: 'completed', wallMs, detail: { step: i, ok: false } })
      return conclude(true)
    }

    const pack = o.packs.get(stepDef.profile)
    const baseUrl = o.baseUrls.get(stepDef.profile)
    const stepOptions = { ...o.options, ...stepDef.options }

    // The model this step needs, loaded at this step. A deterministic step reaches no
    // backend at all, so asking for one would start a model to run code that never calls it.
    const unusable = callsModel(profile.mode) ? await o.ensureBackend?.(baseUrl, stepDef.profile) : null
    if (unusable) {
      const wallMs = performance.now() - stepStart
      results.push({ step: i, name: stepDef.name, profile: stepDef.profile, ok: false, error: unusable, wallMs })
      o.activity?.emit({ kind: 'workflow.step.completed', step: i, name: stepDef.name, profile: stepDef.profile, ok: false, wallMs })
      o.activity?.emit({ kind: 'stage', stageId: stepStageId, parentId: rootStageId, name: stepDef.name, status: 'completed', wallMs, detail: { step: i, ok: false } })
      return conclude(true)
    }

    try {
      const result = await withActivityScope(
        // The scope is replaced, not stacked — merge the outer runId/scope eagerly.
        { ...currentActivityScope(), parentId: stepStageId },
        () =>
          runStep({
            profile,
            pack,
            baseUrl,
            input,
            options: stepOptions,
            trace: o.trace,
            provider: o.provider,
            activity: o.activity,
          }),
      )

      const wallMs = performance.now() - stepStart
      const stepResult: WorkflowStepResult = {
        step: i,
        name: stepDef.name,
        profile: stepDef.profile,
        ok: result.ok,
        // A profile can reject a request without throwing (for example, a verifier refusing
        // an incomplete composed input). Preserve that reason for CLI and dashboard users;
        // otherwise every such refusal is rendered as the unhelpful "step failed".
        error: result.ok ? undefined : result.text,
        output: result.output,
        raw: result.raw,
        text: result.text,
        report: result.report,
        wallMs,
      }

      // If this step is being re-run, replace the old result instead of appending.
      const existingIdx = results.findIndex((r) => r.step === i)
      if (existingIdx !== -1) {
        results.splice(existingIdx, 1)
      }
      results.push(stepResult)
      context.set(`step-${i}`, {
        output: result.output,
        raw: result.raw,
        text: result.text,
        report: result.report,
        document: result.document,
      })

      o.activity?.emit({ kind: 'workflow.step.completed', step: i, name: stepDef.name, profile: stepDef.profile, ok: result.ok, wallMs })
      o.activity?.emit({ kind: 'stage', stageId: stepStageId, parentId: rootStageId, name: stepDef.name, status: 'completed', wallMs, detail: { step: i, ok: result.ok } })

      persist(i)

      if (!result.ok) return conclude(true)
    } catch (e) {
      const wallMs = performance.now() - stepStart
      const stepResult: WorkflowStepResult = {
        step: i,
        name: stepDef.name,
        profile: stepDef.profile,
        ok: false,
        error: (e as Error).message,
        wallMs,
      }
      const existingIdx = results.findIndex((r) => r.step === i)
      if (existingIdx !== -1) {
        results.splice(existingIdx, 1)
      }
      results.push(stepResult)
      o.activity?.emit({ kind: 'workflow.step.completed', step: i, name: stepDef.name, profile: stepDef.profile, ok: false, wallMs })
      o.activity?.emit({ kind: 'stage', stageId: stepStageId, parentId: rootStageId, name: stepDef.name, status: 'completed', wallMs, detail: { step: i, ok: false } })
      persist(i)
      return conclude(true)
    }
  }

  return conclude(false)
}

/**
 * Where the terminal step sits, or -1. At most one, and it must be last: a step that runs
 * after a refusal cannot have steps depending on it, so anything declared behind it would be
 * a step the workflow promises to run and then does not.
 */
const terminalStepIndex = (steps: WorkflowStep[]): number => {
  const marked = steps.map((step, i) => (step.final ? i : -1)).filter((i) => i !== -1)
  if (marked.length === 0) return -1
  if (marked.length > 1) {
    throw new Error(`a workflow may mark one step 'final'; steps ${marked.join(', ')} are all marked`)
  }
  const index = marked[0]!
  if (index !== steps.length - 1) {
    throw new Error(`the 'final' step must be last; step ${index} is marked but ${steps.length - 1} is last`)
  }
  return index
}

/** Resolve a context reference like `step-0.output` or `initial`. */
const resolveRef = (context: Map<string, unknown>, ref: string, field?: string): unknown => {
  const parts = ref.split('.')
  const key = parts[0]!
  const explicitField = parts[1] ?? field ?? 'output'
  const value = context.get(key)
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null) {
    return (value as Record<string, unknown>)[explicitField] ?? value
  }
  return value
}

/**
 * Resolve a template ref STRICTLY, without the `?? value` fallback `resolveRef` keeps.
 *
 * A plain `step-1` step accepts a whole-step object when the field it named is absent, and
 * that leniency has a purpose. A template composes SPECIFIC fields into one object; a field
 * the previous step did not produce must come out as `undefined` (dropped by the caller's
 * `JSON.stringify`) rather than as the previous step's spill — otherwise the vital-signs
 * certificate of a verifier built as `{extraction = "step-1.report"}` silently receives the
 * step's whole output under the `extraction` name.
 */
const resolveTemplateRef = (context: Map<string, unknown>, ref: string): unknown => {
  const parts = ref.split('.')
  const key = parts[0]!
  const explicitField = parts[1] ?? 'output'
  const value = context.get(key)
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null) {
    return (value as Record<string, unknown>)[explicitField]
  }
  return value
}

/** Compose a step input from a map of names to refs. */
const resolveTemplate = (context: Map<string, unknown>, template: Record<string, string>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [name, ref] of Object.entries(template)) {
    out[name] = resolveTemplateRef(context, ref)
  }
  return out
}

const resolveInput = (
  context: Map<string, unknown>,
  ref: string | Record<string, string>,
  field?: string,
): unknown => (typeof ref === 'string' ? resolveRef(context, ref, field) : resolveTemplate(context, ref))

/**
 * A metadata-only description of a step's input reference, for activity events.
 *
 * A plain ref is itself a string, so it can be emitted as-is. A template is MAP of names
 * to refs, and the names are fields the composed input will carry — a template pointing at
 * `document` would carry a field named `document`, which is exactly the ban in the
 * activity spec. So the template is emitted as (name, ref) pairs, where `name` is a VALUE
 * rather than a key and the walk has nothing to refuse.
 */
const describeInputRef = (ref: string | Record<string, string>): string | TemplateRefEntry[] => {
  if (typeof ref === 'string') return ref
  return Object.entries(ref).map(([name, r]) => ({ name, ref: r }))
}

interface StepRunResult {
  ok: boolean
  output?: unknown
  raw?: string
  text?: string
  report?: unknown
  document?: string
}

/** Run a single step by delegating to the profile's mode. */
const runStep = async (o: {
  profile: ProfileModule
  pack: Pack | undefined
  baseUrl: string | undefined
  input: unknown
  options: Record<string, unknown>
  trace?: Trace
  provider?: Provider
  activity?: Activity
}): Promise<StepRunResult> => {
  const { profile, pack, baseUrl, input, options, provider } = o

  // Extract mode: single-shot constrained output.
  if (profile.mode === 'extract' && profile.review) {
    const textInput = typeof input === 'string' ? input : JSON.stringify(input)
    const reviewCtx: ReviewContext = {
      pack,
      baseUrl,
      trace: o.trace ?? nullTrace(),
      input: { kind: 'text', text: textInput, label: 'workflow-step' },
      options,
      provider,
      activity: o.activity,
    }
    const result = await profile.review(reviewCtx)
    return {
      ok: result.ok,
      text: result.text,
      raw: result.raw,
      report: result.report,
      document: result.document,
      output: result.report ?? result.raw,
    }
  }

  // Agentic mode: tool-calling loop.
  if (profile.mode === 'agentic' && profile.tools) {
    const task = typeof input === 'string' ? input : JSON.stringify(input)
    const workspace = String(options.workspace ?? process.cwd())
    const result = await runAgent({
      systemPrompt: profile.systemPrompt ?? '',
      task,
      workspace,
      tools: profile.tools,
      maxIterations: profile.maxIterations ?? 12,
      baseUrl,
      trace: o.trace,
      provider,
    })
    return {
      ok: result.stop === 'done',
      text: result.answer ?? result.error ?? `stop: ${result.stop}`,
      output: result,
    }
  }

  // Router and code modes: delegate to the profile's review, which reaches no model. The two
  // are separate declarations (one chooses, one computes) and one call site.
  if ((profile.mode === 'router' || profile.mode === 'code') && profile.review) {
    const textInput = typeof input === 'string' ? input : JSON.stringify(input)
    const reviewCtx: ReviewContext = {
      pack,
      baseUrl,
      trace: o.trace ?? nullTrace(),
      input: { kind: 'text', text: textInput, label: 'workflow-step' },
      options,
      provider,
      activity: o.activity,
    }
    const result = await profile.review(reviewCtx)
    return {
      ok: result.ok,
      text: result.text,
      raw: result.raw,
      report: result.report,
      output: result.report ?? result.raw,
    }
  }

  // Workflow mode: nested workflow.
  if (profile.mode === 'workflow') {
    // Nested workflows are not supported in the first cut; they require resolving
    // a new set of profiles and packs, which risks infinite recursion.
    throw new Error('nested workflow mode is not supported in this step')
  }

  throw new Error(`profile mode '${profile.mode}' cannot be used as a workflow step`)
}

/** Build a workflow definition from a simple declarative format. */
export const buildWorkflow = (
  steps: Array<{
    name: string
    profile: string
    input?: string | Record<string, string>
    field?: string
    options?: Record<string, unknown>
    final?: boolean
  }>,
): WorkflowStep[] => {
  const built = steps.map((s) => ({
    name: s.name,
    profile: s.profile,
    input: s.input,
    field: s.field,
    options: s.options,
    final: s.final,
  }))
  // Refuse a malformed terminal declaration here, where the config is being read, rather than
  // at the exit of a run that has already spent several minutes on a model.
  terminalStepIndex(built)
  return built
}
