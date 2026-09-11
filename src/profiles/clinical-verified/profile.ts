/**
 * The clinical-verified profile: mode `workflow`, no pack, no tools.
 *
 * A workflow is a composition of other profiles: the clinical specialist routes and
 * extracts the input, and the verifier checks the result. This profile does not run models
 * itself; it is a configuration surface that
 * the CLI and the workflow mode read to know which steps exist and in what order.
 *
 * The workflow definition lives in `profiles.toml` under the `[clinical-verified]` table,
 * as a `steps` array. Each step names a profile and describes what input it reads. The
 * harness loads the profiles, resolves their packs, and runs the steps in order.
 *
 * This profile exists so the workflow can be evaluated (`eval`) and so it has a name in
 * the profile list. Its `runEval` runs a smoke test of the workflow construction by default,
 * and a full workflow fidelity eval when called with `--fidelity` (which requires a GPU and
 * several minutes).
 */

import type { EvalContext, EvalVerdict, ProfileModule } from '../../core/profile.ts'
import { loadConfig, requireProfile } from '../../core/config.ts'
import { loadPack, resolvePackRoot } from '../../core/pack.ts'
import { runWorkflowCaseEval, runWorkflowFidelityEval } from './eval.ts'

export const PROFILE: ProfileModule = {
  name: 'clinical-verified',
  mode: 'workflow',
  needsPack: false,

  async runEval(ctx: EvalContext): Promise<EvalVerdict> {
    // One ad-hoc input through the production workflow. Unlike --fidelity, this performs no
    // shape transform between steps: it exists to catch integration failures hidden by an
    // experimental arm that calls the same profiles manually.
    if (typeof ctx.options.input === 'string' && ctx.options.input.length > 0) {
      return (await runWorkflowCaseEval({
        input: ctx.options.input,
        trace: ctx.trace,
        provider: ctx.provider,
        options: {
          constrain: Boolean(ctx.options.constrain),
          calculate: Boolean(ctx.options.calculate),
        },
      })).verdict
    }

    // Full workflow fidelity eval: run all three arms against the clinical corpus.
    // Requires a GPU and takes several minutes.
    if (ctx.options.fidelity) {
      const cfg = loadConfig()
      const clinicalConfig = requireProfile(cfg, 'clinical')
      const pack =
        ctx.pack ??
        loadPack(
          resolvePackRoot('clinical', {
            explicit: undefined,
            configured: clinicalConfig.pack as string | undefined,
            base: cfg.base,
          }),
        )
      return runWorkflowFidelityEval({
        pack,
        baseUrl: ctx.baseUrl ?? clinicalConfig.url,
        trace: ctx.trace,
        difficulty: ctx.options.difficulty as string | undefined,
        caseLimit: ctx.options.caseLimit as number | undefined,
      })
    }

    // Default: smoke test of the workflow definition.
    const steps = ctx.config.steps as Array<Record<string, unknown>> | undefined
    if (!steps || !Array.isArray(steps)) {
      return { pass: false, summary: 'workflow config has no steps array' }
    }

    const errors: string[] = []
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!
      if (!step.name) errors.push(`step ${i} has no name`)
      if (!step.profile) errors.push(`step ${i} has no profile`)
    }

    if (errors.length > 0) {
      return { pass: false, summary: `workflow validation failed: ${errors.join(', ')}` }
    }

    return {
      pass: true,
      summary: `${steps.length} workflow steps validated successfully (add --fidelity for full eval)`,
    }
  },
}
