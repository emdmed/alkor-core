/** The front-door router: choose one complete workflow for the user's goal. */
import type { EvalContext, EvalVerdict, ProfileModule, ReviewContext, ReviewResult } from '../../core/profile.ts'
import { route, type RouteRule } from '../../modes/router.ts'
import { nextStageId } from '../../core/activity.ts'

export const WORKFLOW_RULES: RouteRule[] = [
  {
    name: 'sepsis-assessment',
    profile: 'sepsis-verified',
    keywords: ['sepsis', 'septic', 'qsofa', 'quick sofa'],
    confidence: 1,
  },
]

export const DEFAULT_WORKFLOW = 'clinical-verified'

/**
 * The workflows this router can name: the default, plus whatever a rule can send elsewhere.
 *
 * Derived from the rules rather than listed beside them, exactly as the `router` profile
 * derives its own fan. The listed form was a second statement of the same thing, and the
 * failure mode of the two disagreeing is silent — a workflow drawn on the dashboard that no
 * rule can reach, or a reachable one the picture never mentions.
 */
const WORKFLOW_TARGETS = [...new Set([DEFAULT_WORKFLOW, ...WORKFLOW_RULES.map((rule) => rule.profile)])]

export const PROFILE: ProfileModule = {
  name: 'workflow-router',
  mode: 'router',
  needsPack: false,
  topology: {
    stages: [
      { name: 'goal-match', operation: 'code' },
      {
        name: 'workflow',
        kind: 'decision',
        operation: 'decision',
        routes: WORKFLOW_TARGETS.map((profile) => ({ name: profile, targetProfile: profile })),
      },
    ],
  },

  async review(ctx: ReviewContext): Promise<ReviewResult> {
    const input = ctx.input.kind === 'text' ? ctx.input.text : ctx.input.name
    const result = await route({ input, rules: WORKFLOW_RULES, defaultProfile: DEFAULT_WORKFLOW })
    ctx.activity?.emit({
      kind: 'stage',
      stageId: nextStageId(),
      name: 'workflow',
      operation: 'decision',
      status: 'completed',
      detail: { profile: result.profile, confidence: Number((result.confidence * 100).toFixed(0)), reason: result.reason },
    })
    return {
      text: `workflow: ${result.profile}`,
      ok: true,
      raw: JSON.stringify(result),
      report: result,
    }
  },

  async runEval(_ctx: EvalContext): Promise<EvalVerdict> {
    const sepsis = await route({ input: 'Assess qSOFA for possible sepsis', rules: WORKFLOW_RULES, defaultProfile: DEFAULT_WORKFLOW })
    const general = await route({ input: 'Extract the clinical note', rules: WORKFLOW_RULES, defaultProfile: DEFAULT_WORKFLOW })
    const pass = sepsis.profile === 'sepsis-verified' && general.profile === 'clinical-verified'
    return { pass, summary: pass ? '2/2 workflow routes correct' : 'workflow routing smoke test failed' }
  },
}
