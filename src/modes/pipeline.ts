/**
 * Pipeline mode: orchestrate multi-model workflows where the output of one specialist
 * becomes the input of the next.
 *
 * A pipeline is a sequence of steps, each naming a profile and describing what it reads.
 * The pipeline itself is stateless: it holds the step definitions and the intermediate
 * results, and it delegates every actual model call to the profile's own mode (extract,
 * agentic, or nested pipeline).
 *
 * The harness already supports per-profile servers and per-profile packs; a pipeline
 * simply composes them. Each step runs against whatever server and model its profile
 * names in `profiles.toml`, so a pipeline with four steps may talk to four different
 * llama-server instances on four different ports, each loaded with a different quantisation.
 *
 * Error handling is deliberately simple: a step that fails stops the pipeline and returns
 * what it has so far. There is no retry, no fallback, and no circuit breaker — those belong
 * to the product layer above, not to the harness that runs the steps.
 *
 * A pipeline step may read:
 * - `initial`: the original user input that started the pipeline.
 * - `step-N`: the output of step N (0-indexed).
 * - `step-N.raw`: the raw completion of step N, before parsing.
 * - `step-N.text`: the rendered text of step N, when available.
 * - `step-N.report`: the structured report of step N, when available.
 * - an OBJECT of names to refs, when a step needs to COMPOSE its input from more than one
 *   source: `{ document = "initial", extraction = "step-1.report" }` hands the step a JSON
 *   object built from the two refs. Template refs resolve STRICTLY — a ref whose field the
 *   previous step did not produce resolves to `undefined` (which `JSON.stringify` drops)
 *   rather than substituting the whole step state, so a template cannot quietly smuggle the
 *   previous step's spill into a field the consumer treats as a specific thing.
 *
 * A pipeline step may write:
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PipelineStep {
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
   * Override options passed to the step's profile. Merged with the pipeline's
   * shared options; explicit step options win.
   */
  options?: Record<string, unknown>
}

export interface PipelineOptions {
  /** The user input that started the pipeline. */
  initialInput: string
  steps: PipelineStep[]
  /** Shared options passed to every step unless overridden. */
  options?: Record<string, unknown>
  /** A pre-loaded profile map, so the pipeline does not re-import modules. */
  profiles: Map<string, ProfileModule>
  /** A pre-loaded pack map, indexed by profile name. */
  packs: Map<string, Pack | undefined>
  /** Base URLs per profile, from profiles.toml. */
  baseUrls: Map<string, string | undefined>
  /** Trace for the pipeline as a whole; each step writes its own sub-trace. */
  trace?: Trace
  /**
   * Directory to save pipeline state after each step. Enables resuming after a crash
   * and step-by-step execution where only one model is loaded at a time.
   */
  contextDir?: string
  /**
   * Run only this step (0-indexed). Requires `contextDir` for steps > 0,
   * because the state from previous steps must be loaded from disk.
   */
  runStep?: number
  /** A custom LLM provider; defaults to the built-in HTTP client. */
  provider?: Provider
  /** Activity bus for operational events. */
  activity?: Activity
}

/** Serializable checkpoint written to `contextDir` after each step. */
interface PipelineCheckpoint {
  initialInput: string
  results: PipelineStepResult[]
  state: Record<string, unknown>
  completedStep: number
}

const CHECKPOINT_FILE = 'context.json'

const saveCheckpoint = (dir: string, checkpoint: PipelineCheckpoint) => {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, CHECKPOINT_FILE)
  writeFileSync(path, JSON.stringify(checkpoint, null, 2), 'utf8')
  // Also write per-step files so the next step (or a human operator) can read
  // the context message without parsing the full checkpoint.
  for (const result of checkpoint.results) {
    writeFileSync(join(dir, `step-${result.step}.json`), JSON.stringify(result, null, 2), 'utf8')
  }
}

const loadCheckpoint = (dir: string): PipelineCheckpoint | undefined => {
  const path = join(dir, CHECKPOINT_FILE)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PipelineCheckpoint
  } catch {
    return undefined
  }
}

// The highest step result by step number, not by array index. After a re-run the
// array may not be in step order, so the last element is not necessarily the final step.
const highestStepResult = (results: PipelineStepResult[]): PipelineStepResult | undefined =>
  results.length === 0 ? undefined : results.reduce((a, b) => (b.step > a.step ? b : a))

export interface PipelineStepResult {
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

export interface PipelineResult {
  /** All steps that ran, in order. */
  steps: PipelineStepResult[]
  /** The final step's output, whatever its shape. */
  final?: unknown
  /** The pipeline stopped early because a step failed. */
  stoppedEarly: boolean
  /** Total wall time for the pipeline. */
  totalMs: number
}

/** Run a pipeline from step 0 to completion or first failure. */
export const runPipeline = async (o: PipelineOptions): Promise<PipelineResult> => {
  const startedAt = performance.now()
  o.activity?.emit({ kind: 'pipeline.started' })
  // The root node of the decision tree. Steps nest under it (see stepStageId below).
  const rootStageId = o.activity ? nextStageId() : undefined
  o.activity?.emit({
    kind: 'stage',
    stageId: rootStageId,
    name: 'pipeline',
    status: 'started',
    detail: { steps: o.steps.length },
  })
  const rootDone = (stoppedEarly: boolean, totalMs: number) =>
    o.activity?.emit({
      kind: 'stage',
      stageId: rootStageId,
      name: 'pipeline',
      status: 'completed',
      wallMs: totalMs,
      detail: { stoppedEarly },
    })
  let results: PipelineStepResult[] = []
  const state = new Map<string, unknown>()
  let startStep = 0
  let initialInput = o.initialInput

  // Load a saved checkpoint if contextDir is provided.
  if (o.contextDir) {
    const saved = loadCheckpoint(o.contextDir)
    if (saved) {
      // Step 0 is always a fresh start: overwrite any previous checkpoint.
      if (o.runStep !== 0) {
        results = saved.results
        for (const [key, value] of Object.entries(saved.state)) {
          state.set(key, value)
        }
        initialInput = saved.initialInput
        // When re-running a specific step, truncate downstream results and state so the
        // re-run starts from a clean checkpoint. Without this, stale results from later
        // steps survive and corrupt the final output.
        if (o.runStep !== undefined && o.runStep > 0) {
          results = saved.results.filter((r) => r.step < o.runStep!)
          for (const key of Array.from(state.keys())) {
            if (key.startsWith('step-')) {
              const stepNum = parseInt(key.slice('step-'.length), 10)
              if (stepNum >= o.runStep!) state.delete(key)
            }
          }
        }
        if (o.runStep === undefined) {
          const lastResult = highestStepResult(saved.results)
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
        `no checkpoint in '${o.contextDir}' — step ${o.runStep} needs state from previous steps`,
      )
    }
  }

  // If nothing was loaded, initialise from the beginning.
  if (state.size === 0) {
    state.set('initial', initialInput)
  }

  const actualStart = o.runStep !== undefined ? o.runStep : startStep
  const endStep = o.runStep !== undefined ? o.runStep + 1 : o.steps.length

  if (actualStart >= o.steps.length) {
    const totalMs = performance.now() - startedAt
    rootDone(false, totalMs)
    return {
      steps: results,
      stoppedEarly: false,
      final: highestStepResult(results)?.output,
      totalMs,
    }
  }

  for (let i = actualStart; i < endStep; i++) {
    const stepDef = o.steps[i]!
    const stepStart = performance.now()
    const inputRef = stepDef.input ?? (i === 0 ? 'initial' : `step-${i - 1}.output`)
    const input = resolveInput(state, inputRef, stepDef.field)

    const fromProfile = i > 0 ? o.steps[i - 1]!.profile : undefined
    o.activity?.emit({
      kind: 'pipeline.step.started',
      step: i,
      name: stepDef.name,
      profile: stepDef.profile,
      input: { ref: describeInputRef(inputRef), field: stepDef.field, fromProfile },
    })
    // The step as a node in the decision tree, attached under the pipeline root. Everything
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
        error: `profile '${stepDef.profile}' not found in pipeline profile map`,
        wallMs,
      }
      results.push(fail)
      o.activity?.emit({ kind: 'pipeline.step.completed', step: i, name: stepDef.name, profile: stepDef.profile, ok: false, wallMs })
      o.activity?.emit({ kind: 'stage', stageId: stepStageId, parentId: rootStageId, name: stepDef.name, status: 'completed', wallMs, detail: { step: i, ok: false } })
      rootDone(true, performance.now() - startedAt)
      return { steps: results, stoppedEarly: true, totalMs: performance.now() - startedAt }
    }

    const pack = o.packs.get(stepDef.profile)
    const baseUrl = o.baseUrls.get(stepDef.profile)
    const stepOptions = { ...o.options, ...stepDef.options }

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
      const stepResult: PipelineStepResult = {
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
      state.set(`step-${i}`, {
        output: result.output,
        raw: result.raw,
        text: result.text,
        report: result.report,
        document: result.document,
      })

      o.activity?.emit({ kind: 'pipeline.step.completed', step: i, name: stepDef.name, profile: stepDef.profile, ok: result.ok, wallMs })
      o.activity?.emit({ kind: 'stage', stageId: stepStageId, parentId: rootStageId, name: stepDef.name, status: 'completed', wallMs, detail: { step: i, ok: result.ok } })

      if (o.contextDir) {
        saveCheckpoint(o.contextDir, {
          initialInput,
          results,
          state: Object.fromEntries(state),
          completedStep: i,
        })
      }

      if (!result.ok) {
        rootDone(true, performance.now() - startedAt)
        return { steps: results, stoppedEarly: true, totalMs: performance.now() - startedAt }
      }
    } catch (e) {
      const wallMs = performance.now() - stepStart
      const stepResult: PipelineStepResult = {
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
      o.activity?.emit({ kind: 'pipeline.step.completed', step: i, name: stepDef.name, profile: stepDef.profile, ok: false, wallMs })
      o.activity?.emit({ kind: 'stage', stageId: stepStageId, parentId: rootStageId, name: stepDef.name, status: 'completed', wallMs, detail: { step: i, ok: false } })
      if (o.contextDir) {
        saveCheckpoint(o.contextDir, {
          initialInput,
          results,
          state: Object.fromEntries(state),
          completedStep: i,
        })
      }
      rootDone(true, performance.now() - startedAt)
      return { steps: results, stoppedEarly: true, totalMs: performance.now() - startedAt }
    }
  }

  const totalMs = performance.now() - startedAt
  rootDone(false, totalMs)
  o.activity?.emit({ kind: 'pipeline.completed', stoppedEarly: false, totalMs })
  return {
    steps: results,
    stoppedEarly: false,
    final: highestStepResult(results)?.output,
    totalMs,
  }
}

/** Resolve a state reference like `step-0.output` or `initial`. */
const resolveRef = (state: Map<string, unknown>, ref: string, field?: string): unknown => {
  const parts = ref.split('.')
  const key = parts[0]!
  const explicitField = parts[1] ?? field ?? 'output'
  const value = state.get(key)
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
const resolveTemplateRef = (state: Map<string, unknown>, ref: string): unknown => {
  const parts = ref.split('.')
  const key = parts[0]!
  const explicitField = parts[1] ?? 'output'
  const value = state.get(key)
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null) {
    return (value as Record<string, unknown>)[explicitField]
  }
  return value
}

/** Compose a step input from a map of names to refs. */
const resolveTemplate = (state: Map<string, unknown>, template: Record<string, string>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [name, ref] of Object.entries(template)) {
    out[name] = resolveTemplateRef(state, ref)
  }
  return out
}

const resolveInput = (
  state: Map<string, unknown>,
  ref: string | Record<string, string>,
  field?: string,
): unknown => (typeof ref === 'string' ? resolveRef(state, ref, field) : resolveTemplate(state, ref))

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
      input: { kind: 'text', text: textInput, label: 'pipeline-step' },
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
      maxSteps: profile.maxSteps ?? 12,
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

  // Router mode: delegate to the profile's review, which uses its own compiled rules.
  if (profile.mode === 'router' && profile.review) {
    const textInput = typeof input === 'string' ? input : JSON.stringify(input)
    const reviewCtx: ReviewContext = {
      pack,
      baseUrl,
      trace: o.trace ?? nullTrace(),
      input: { kind: 'text', text: textInput, label: 'pipeline-step' },
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

  // Pipeline mode: nested pipeline.
  if (profile.mode === 'pipeline') {
    // Nested pipelines are not supported in the first cut; they require resolving
    // a new set of profiles and packs, which risks infinite recursion.
    throw new Error('nested pipeline mode is not supported in this step')
  }

  // Eval mode is not a step; it is a measurement, not a production path.
  throw new Error(`profile mode '${profile.mode}' cannot be used as a pipeline step`)
}

/** Build a pipeline definition from a simple declarative format. */
export const buildPipeline = (
  steps: Array<{
    name: string
    profile: string
    input?: string | Record<string, string>
    field?: string
    options?: Record<string, unknown>
  }>,
): PipelineStep[] => steps.map((s) => ({ name: s.name, profile: s.profile, input: s.input, field: s.field, options: s.options }))
