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
   * What this step reads as its input. Defaults to `initial` for the first step,
   * and `step-${n-1}.output` for subsequent steps.
   */
  input?: string
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
    return {
      steps: results,
      stoppedEarly: false,
      final: highestStepResult(results)?.output,
      totalMs: performance.now() - startedAt,
    }
  }

  for (let i = actualStart; i < endStep; i++) {
    const stepDef = o.steps[i]!
    const stepStart = performance.now()
    const inputRef = stepDef.input ?? (i === 0 ? 'initial' : `step-${i - 1}.output`)
    const input = resolveInput(state, inputRef, stepDef.field)

    const profile = o.profiles.get(stepDef.profile)
    if (!profile) {
      const fail = {
        step: i,
        name: stepDef.name,
        profile: stepDef.profile,
        ok: false,
        error: `profile '${stepDef.profile}' not found in pipeline profile map`,
        wallMs: performance.now() - stepStart,
      }
      results.push(fail)
      return { steps: results, stoppedEarly: true, totalMs: performance.now() - startedAt }
    }

    const pack = o.packs.get(stepDef.profile)
    const baseUrl = o.baseUrls.get(stepDef.profile)
    const stepOptions = { ...o.options, ...stepDef.options }

    try {
      const result = await runStep({
        profile,
        pack,
        baseUrl,
        input,
        options: stepOptions,
        trace: o.trace,
        provider: o.provider,
      })

      const stepResult: PipelineStepResult = {
        step: i,
        name: stepDef.name,
        profile: stepDef.profile,
        ok: result.ok,
        output: result.output,
        raw: result.raw,
        text: result.text,
        report: result.report,
        wallMs: performance.now() - stepStart,
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

      if (o.contextDir) {
        saveCheckpoint(o.contextDir, {
          initialInput,
          results,
          state: Object.fromEntries(state),
          completedStep: i,
        })
      }

      if (!result.ok) {
        return { steps: results, stoppedEarly: true, totalMs: performance.now() - startedAt }
      }
    } catch (e) {
      const stepResult: PipelineStepResult = {
        step: i,
        name: stepDef.name,
        profile: stepDef.profile,
        ok: false,
        error: (e as Error).message,
        wallMs: performance.now() - stepStart,
      }
      const existingIdx = results.findIndex((r) => r.step === i)
      if (existingIdx !== -1) {
        results.splice(existingIdx, 1)
      }
      results.push(stepResult)
      if (o.contextDir) {
        saveCheckpoint(o.contextDir, {
          initialInput,
          results,
          state: Object.fromEntries(state),
          completedStep: i,
        })
      }
      return { steps: results, stoppedEarly: true, totalMs: performance.now() - startedAt }
    }
  }

  return {
    steps: results,
    stoppedEarly: false,
    final: highestStepResult(results)?.output,
    totalMs: performance.now() - startedAt,
  }
}

/** Resolve a state reference like `step-0.output` or `initial`. */
const resolveInput = (state: Map<string, unknown>, ref: string, field?: string): unknown => {
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
export const buildPipeline = (steps: Array<{ name: string; profile: string; input?: string; field?: string; options?: Record<string, unknown> }>): PipelineStep[] =>
  steps.map((s) => ({ name: s.name, profile: s.profile, input: s.input, field: s.field, options: s.options }))
