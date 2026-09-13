/** The front-door router: choose one complete workflow for the user's goal. */
import type { EvalContext, EvalVerdict, ProfileModule, ReviewContext, ReviewResult } from '../../core/profile.ts'
import { route, type RouteRule } from '../../modes/router.ts'
import { nextStageId } from '../../core/activity.ts'
import { ConfigError, loadConfig, type PipelineConfig } from '../../core/config.ts'

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
 * that processes input DIFFERENTLY — a batch summary over many records — not a clinical
 * question asked of the same pipeline.
 */
export const WORKFLOW_RULES: RouteRule[] = []

/**
 * The name this router's decision is emitted and published under.
 *
 * `route`, as every other routing decision in this harness is named — the specialist router
 * beside it, and the blueprint the server falls back to for any profile in `router` mode. It
 * was `workflow` once, which put a SECOND parentless stage of that name in every product run:
 * the choice of workflow, and the workflow mode's own root that the run's steps hang off. A
 * reader with only a name to go on got the choice, which has no steps under it, and the whole
 * middle of a run — every pass, every branch — became invisible to it. Two unrelated things
 * may not share one name in a stream whose consumers are told to match on names.
 */
const DECISION_STAGE = 'route'

/**
 * The catalogue this router chooses from, read from `[pipeline]` in profiles.toml.
 *
 * NOT restated here. The deployment already declares `workflows` and `default`, and
 * `loadConfig` already refuses a catalogue that names an undeclared profile, one whose mode
 * is not `workflow`, or a default outside its own list. A `DEFAULT_WORKFLOW` constant beside
 * that was a second statement of the same fact in a second language, with nothing checking
 * the two agreed — and the drift is silent in the worst direction: the config would name a
 * new default, every validation would pass, and this router would go on sending every goal
 * to the old one.
 *
 * Read per call rather than at module load. The value is deployment data, so the catalogue a
 * long-lived server routes against should be the one on disk, not the one that happened to be
 * there when the module was first imported; and a throwing import would take down `/health`,
 * which exists precisely to describe a deployment that is misconfigured.
 */
const catalogue = (): PipelineConfig => {
  const { pipeline } = loadConfig()
  if (!pipeline) {
    throw new ConfigError(
      `profile 'workflow-router' is the front door of a deployment that declares no [pipeline] — ` +
        `add a [pipeline] table naming this router, its workflows, and a default`,
    )
  }
  return pipeline
}

export const PROFILE: ProfileModule = {
  name: 'workflow-router',
  mode: 'router',
  needsPack: false,

  /**
   * A getter because the fan is the deployment's catalogue, and a static object literal
   * would have frozen it at import time. The server reads this through a `try` and falls back
   * to the mode-level blueprint, so an unreadable config still describes a router.
   */
  get topology() {
    return {
      stages: [
        { name: 'goal-match' as const, operation: 'code' as const },
        {
          name: DECISION_STAGE,
          kind: 'decision' as const,
          operation: 'decision' as const,
          routes: catalogue().workflows.map((profile) => ({ name: profile, targetProfile: profile })),
        },
      ],
    }
  },

  async review(ctx: ReviewContext): Promise<ReviewResult> {
    const input = ctx.input.kind === 'text' ? ctx.input.text : ctx.input.name
    const { workflows, defaultWorkflow } = catalogue()
    const routed = await route({ input, rules: WORKFLOW_RULES, defaultProfile: defaultWorkflow })
    // `route` reports the default as confidence 0 with "no rule matched", which is the right
    // answer for a router that had alternatives and found none of them. A single-entry
    // catalogue is a different case: the default is not a fallback it settled for, it is the
    // only workflow there is. Reporting 0 would draw the gateway on the dashboard as an
    // uncertain match for a decision that had nothing to be uncertain about.
    const result = workflows.length === 1
      ? { profile: defaultWorkflow, confidence: 1, reason: 'sole workflow in the catalogue' }
      : routed
    ctx.activity?.emit({
      kind: 'stage',
      stageId: nextStageId(),
      name: DECISION_STAGE,
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
   * Two assertions, because the catalogue and the rules now come from different places.
   *
   * The first is the one `loadConfig` cannot make: a rule lives in this file and names a
   * workflow by string, so nothing at config-load time notices a rule pointing at a workflow
   * the deployment does not declare. That rule is dead in the most confusing way — it matches,
   * it wins, and the run then fails looking up a profile the user never wrote.
   *
   * The second is that a clinical goal reaches the clinical workflow however it is phrased —
   * including the syndrome phrasings that used to be diverted. A rule that starts intercepting
   * `sepsis` again fails here, at the router that would be answering a question the clinical
   * router owns.
   */
  async runEval(_ctx: EvalContext): Promise<EvalVerdict> {
    const { workflows, defaultWorkflow } = catalogue()

    const unreachable = WORKFLOW_RULES.filter((rule) => !workflows.includes(rule.profile))
    if (unreachable.length > 0) {
      return {
        pass: false,
        summary:
          `${unreachable.length} rule(s) name a workflow outside the catalogue: ` +
          `${unreachable.map((rule) => `${rule.name} → ${rule.profile}`).join(', ')} ` +
          `(declared: ${workflows.join(', ')})`,
      }
    }

    const goals = ['Assess qSOFA for possible sepsis', 'Is this septic shock?', 'Extract the clinical note']
    const routed = await Promise.all(
      goals.map((input) => route({ input, rules: WORKFLOW_RULES, defaultProfile: defaultWorkflow })),
    )
    const wrong = routed.filter((result) => result.profile !== defaultWorkflow)
    return wrong.length === 0
      ? { pass: true, summary: `${goals.length}/${goals.length} goals reach '${defaultWorkflow}'; syndrome routing belongs to the clinical router` }
      : { pass: false, summary: `${wrong.length} goal(s) diverted from '${defaultWorkflow}': ${wrong.map((r) => `${r.profile} (${r.reason})`).join(', ')}` }
  },
}
