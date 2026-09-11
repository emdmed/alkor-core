/**
 * The clinical-assessment profile: mode `code`, one pack, no model.
 *
 * It is the terminal step of the `clinical-verified` workflow — the step that turns a chain of
 * machine artifacts into a statement about the patient. `mode = "code"` rather than `router`
 * because it chooses nothing; see `spec/nomenclature.md`, which reserves *router* for the thing
 * that chooses and makes a name that contradicts it a bug.
 *
 * It reaches no server, so a deployment with every model stopped still ends its runs with a
 * readable page — including the runs that ended in a refusal, which is the case the ending
 * exists for.
 */

import type { EvalContext, EvalVerdict, ProfileModule, ReviewContext, ReviewResult } from '../../core/profile.ts'
import type { Pack } from '../../core/pack.ts'
import { loadMedprotocolRule } from '../clinical/medprotocol.ts'
import { composeAssessment, renderAssessment, type PackView, type RunView, type StepView } from './assessment.ts'
import { runAssessmentEval } from './eval.ts'

type JsonObject = Record<string, unknown>

const object = (value: unknown): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined

/**
 * The pack's identity, for the footer.
 *
 * The medprotocol VERSION is read from the manifest rather than by running the CLI, because
 * this profile computes nothing and shelling out to a binary would be computing something. The
 * clinical step already ran `checkMedprotocolVersion` against the same declaration, so the
 * number printed here is one the run has already proven.
 */
const packView = (pack: Pack | undefined, label?: string): PackView => {
  if (!pack) return { label }
  let medprotocol: string | undefined
  try {
    medprotocol = loadMedprotocolRule(pack).version
  } catch {
    medprotocol = undefined
  }
  return { name: pack.name, spec: pack.spec, medprotocol, label }
}

const stepViews = (value: unknown): StepView[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const step = object(entry)
    if (!step) return []
    return [{
      step: typeof step.step === 'number' ? step.step : -1,
      name: String(step.name ?? 'unnamed'),
      profile: String(step.profile ?? 'unknown'),
      ok: step.ok !== false,
      output: step.output,
      report: step.report,
      text: typeof step.text === 'string' ? step.text : undefined,
      error: typeof step.error === 'string' ? step.error : undefined,
    }]
  })
}

export const PROFILE: ProfileModule = {
  name: 'clinical-assessment',
  mode: 'code',
  needsPack: true,
  topology: { stages: [{ name: 'compose-assessment' }] },

  async review(ctx: ReviewContext): Promise<ReviewResult> {
    if (ctx.input.kind !== 'text') {
      return { text: 'clinical assessment accepts text input only', ok: false }
    }
    let parsed: JsonObject | undefined
    try {
      parsed = object(JSON.parse(ctx.input.text))
    } catch {
      parsed = undefined
    }
    if (!parsed || !Array.isArray(parsed.steps)) {
      // Loud, because the only way to reach this is a workflow that pointed the terminal step
      // at something other than `run`, and a soft fallback would print a confident empty page.
      return {
        text: "clinical assessment expects the workflow's `run` value — an object with initialInput, steps and stoppedEarly",
        ok: false,
      }
    }

    const run: RunView = {
      initialInput: typeof parsed.initialInput === 'string' ? parsed.initialInput : '',
      steps: stepViews(parsed.steps),
      stoppedEarly: parsed.stoppedEarly === true,
    }

    const assessment = composeAssessment(run, packView(ctx.pack, ctx.input.label === 'workflow-step' ? undefined : ctx.input.label))
    return { text: renderAssessment(assessment), ok: true, report: assessment }
  },

  async runEval(ctx: EvalContext): Promise<EvalVerdict> {
    return runAssessmentEval({ pack: ctx.pack! })
  },
}
