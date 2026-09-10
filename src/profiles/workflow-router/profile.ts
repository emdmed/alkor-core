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

export const PROFILE: ProfileModule = {
  name: 'workflow-router',
  mode: 'router',
  needsPack: false,
  topology: {
    stages: [
      { name: 'goal-match' },
      {
        name: 'workflow',
        kind: 'decision',
        routes: [
          { name: 'clinical-verified', targetProfile: 'clinical-verified' },
          { name: 'sepsis-verified', targetProfile: 'sepsis-verified' },
        ],
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
