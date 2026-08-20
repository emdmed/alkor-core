/**
 * The clinical profile: mode `extract`, one contract pack, no tools.
 *
 * The mode says how it is EVALUATED — one constrained pass over one document, which is the
 * shape a consuming application runs in production and the only shape worth a number.
 *
 * This profile is the reference implementation as much as it is a working extractor. It
 * names no vital sign anywhere: the slot list comes from the pack's schema, the floor from
 * the pack's cases, the sampling from the pack's model declaration. Point it at a
 * different pack with the same file keys and it grades a different set of readings without
 * a line changing here — which is the property a project should copy when writing its own.
 */
import type { EvalContext, EvalVerdict, ProfileModule } from '../../core/profile.ts'
import { runVitalSignsEval } from './eval.ts'

export const PROFILE: ProfileModule = {
  name: 'clinical',
  mode: 'extract',
  needsPack: true,
  async runEval(ctx: EvalContext): Promise<EvalVerdict> {
    const { recall, floor, tally } = await runVitalSignsEval({
      pack: ctx.pack!,
      baseUrl: ctx.baseUrl,
      trace: ctx.trace,
      constrain: Boolean(ctx.options.constrain),
      runs: Number(ctx.options.runs ?? 1),
    })
    // The only gate is detection recall. A missed vital is invisible to the clinician; a
    // spurious one is visible and rejected in a click. Hallucinations and failed runs are
    // reported alongside so a pass is never read as "clean".
    return {
      pass: recall >= floor,
      summary:
        `detection ${(recall * 100).toFixed(0)}% vs floor ${(floor * 100).toFixed(0)}% ` +
        `(value ${tally.valueExact}/${tally.detected}, unit ${tally.unitExact}/${tally.detected}, ` +
        `provenance ${tally.quoteVerified}/${tally.detected}, halluc ${tally.hallucinations}, ` +
        `failed runs ${tally.failedRuns})`,
    }
  },
}
