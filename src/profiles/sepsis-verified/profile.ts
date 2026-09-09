/** A named two-step pipeline: clinical sepsis extraction, then deterministic verification. */
import type { EvalContext, EvalVerdict, ProfileModule } from '../../core/profile.ts'

export const PROFILE: ProfileModule = {
  name: 'sepsis-verified',
  mode: 'pipeline',
  needsPack: false,

  async runEval(ctx: EvalContext): Promise<EvalVerdict> {
    const steps = ctx.config.steps as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(steps)) return { pass: false, summary: 'pipeline config has no steps array' }

    const errors: string[] = []
    for (let i = 0; i < steps.length; i++) {
      if (!steps[i]?.name) errors.push(`step ${i} has no name`)
      if (!steps[i]?.profile) errors.push(`step ${i} has no profile`)
    }
    return errors.length
      ? { pass: false, summary: `pipeline validation failed: ${errors.join(', ')}` }
      : { pass: true, summary: `${steps.length} pipeline steps validated successfully` }
  },
}
