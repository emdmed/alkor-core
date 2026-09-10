/** The front-door router: choose one complete workflow for the user's goal. */
import type { EvalContext, EvalVerdict, ProfileModule, ReviewContext, ReviewResult } from '../../core/profile.ts'
import { route, type RouteRule } from '../../modes/router.ts'
import { nextStageId } from '../../core/activity.ts'

/**
 * The rules that send a goal somewhere other than the default workflow. EMPTY, deliberately.
 *
 * This list held one rule — `sepsis`, `septic`, `qsofa`, `quick sofa` → `sepsis-verified` —
 * and removing it is what moved sepsis back inside the clinical workflow beside shock. The
 * rule was answering a question this router cannot see well enough to answer. A workflow is
 * a PROCESSING SHAPE; which syndrome a document raises is a property of the document, and it
 * is decided one layer down by `routeClinicalShape`, which reads the note rather than the
 * prompt: it counts criteria groups, refuses a shock exam payload that carries no respiratory
 * rate and no GCS to screen, and returns shock, sepsis, or both from a single pass.
 *
 * Keyword-matching the prompt could do none of that. It fired on the word `septic` in
 * "septic shock", sending a note that raises both questions to the workflow for one of them;
 * and the workflow it sent to began by running the whole clinical profile, which routed the
 * note again — correctly, to both arms — making the front door's decision both wrong and
 * redundant in the same run.
 *
 * The mechanism stays because the vocabulary is right: a rule here should name a workflow
 * that processes input DIFFERENTLY — a coding task, a batch summary — not a clinical
 * question asked of the same pipeline.
 */
export const WORKFLOW_RULES: RouteRule[] = []

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
    const routed = await route({ input, rules: WORKFLOW_RULES, defaultProfile: DEFAULT_WORKFLOW })
    // `route` reports the default as confidence 0 with "no rule matched", which is the right
    // answer for a router that had alternatives and found none of them. This one has a single
    // target and no rules: the default is not a fallback it settled for, it is the only
    // workflow there is. Reporting 0 would draw the gateway on the dashboard as an uncertain
    // match for a decision that had nothing to be uncertain about.
    const result = WORKFLOW_TARGETS.length === 1
      ? { profile: DEFAULT_WORKFLOW, confidence: 1, reason: 'sole workflow in the catalogue' }
      : routed
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

  /**
   * With no rules, what is left to assert is that a clinical goal reaches the clinical
   * workflow however it is phrased — including the syndrome phrasings that used to be
   * diverted. A rule that starts intercepting `sepsis` again fails here, at the router that
   * would be answering a question the clinical router owns.
   */
  async runEval(_ctx: EvalContext): Promise<EvalVerdict> {
    const goals = ['Assess qSOFA for possible sepsis', 'Is this septic shock?', 'Extract the clinical note']
    const routed = await Promise.all(
      goals.map((input) => route({ input, rules: WORKFLOW_RULES, defaultProfile: DEFAULT_WORKFLOW })),
    )
    const wrong = routed.filter((result) => result.profile !== DEFAULT_WORKFLOW)
    return wrong.length === 0
      ? { pass: true, summary: `${goals.length}/${goals.length} goals reach '${DEFAULT_WORKFLOW}'; syndrome routing belongs to the clinical router` }
      : { pass: false, summary: `${wrong.length} goal(s) diverted from '${DEFAULT_WORKFLOW}': ${wrong.map((r) => `${r.profile} (${r.reason})`).join(', ')}` }
  },
}
