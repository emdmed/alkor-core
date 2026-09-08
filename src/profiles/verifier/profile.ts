/**
 * The verifier profile: mode `extract`, one contract pack, no tools.
 *
 * A verifier is a second model that checks the output of a first model. It takes an
 * original document and an extraction result, and it verifies that every quote is present
 * in the document, that every value is supported by the text, and that no information was
 * invented. This is the "trust but verify" layer of a multi-model pipeline: the extractor
 * produces the reading, and the verifier grades it.
 *
 * The verifier is deliberately small — 1.8B parameters with a constrained schema — because
 * its task is simpler than extraction. It is not asked to find information in noise; it is
 * asked to confirm that a given span appears in a given text. A constrained yes/no/maybe
 * task over known text is exactly what a grammar-constrained small model excels at.
 *
 * The verifier profile is the reference implementation. A project that needs its own
 * verification rules (e.g. checking against a drug database, or a temporal ordering
 * constraint) writes a new profile and a new pack, keeping the same harness.
 */

import type { EvalContext, EvalVerdict, ProfileModule, ReviewContext, ReviewResult } from '../../core/profile.ts'
import type { Pack } from '../../core/pack.ts'
import { extract, type ExtractOutcome } from '../../modes/extract.ts'
import { runVerifierEval } from './eval.ts'

export const PROFILE: ProfileModule = {
  name: 'verifier',
  mode: 'extract',
  needsPack: true,

  async review(ctx: ReviewContext): Promise<ReviewResult> {
    if (ctx.input.kind !== 'text') {
      return {
        text: 'verifier only accepts text input, not case names',
        ok: false,
      }
    }

    const text = ctx.input.text
    // The input is expected to be a JSON string containing {document, extraction}.
    let document: string
    let extraction: unknown
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      document = String(parsed.document ?? '')
      extraction = parsed.extraction
    } catch {
      return {
        text: 'verifier input must be JSON with fields "document" and "extraction"',
        ok: false,
      }
    }

    if (!document) {
      return { text: 'verifier input missing "document" field', ok: false }
    }

    const pack = ctx.pack!
    const prompt = pack.read('prompt')
    const schema = pack.json('schema') as object
    const schemaName = String(pack.name ?? 'verification')

    const userPrompt = `${prompt}\n\n--- ORIGINAL DOCUMENT ---\n${document}\n\n--- EXTRACTION TO VERIFY ---\n${JSON.stringify(extraction, null, 2)}\n\n--- END ---`

    const outcome: ExtractOutcome<unknown> = await extract({
      systemPrompt: pack.read('system') ?? 'You are a verification assistant.',
      document: userPrompt,
      parse: (raw: string) => JSON.parse(raw),
      schema,
      schemaName,
      baseUrl: ctx.baseUrl,
      maxTokens: 2048,
      temperature: 0,
      chatTemplateKwargs: { enable_thinking: true },
      provider: ctx.provider,
    })

    if (!outcome.parsed) {
      return {
        text: `verification failed: ${outcome.error ?? 'no parse'}`,
        ok: false,
        raw: outcome.raw,
      }
    }

    const parsed = outcome.parsed as Record<string, unknown>
    const verified = Boolean(parsed.verified)
    const issues = Array.isArray(parsed.issues) ? parsed.issues : []
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5

    const lines = [
      `=== verifier · ${ctx.input.label ?? 'input'} ===`,
      `verified:   ${verified ? 'YES' : 'NO'}`,
      `confidence: ${(confidence * 100).toFixed(0)}%`,
      `issues:     ${issues.length}`,
    ]

    for (const issue of issues) {
      const i = issue as Record<string, unknown>
      lines.push(`  - ${i.field ?? 'unknown'}: ${i.issue ?? 'unknown'} (${i.severity ?? 'unknown'})`)
    }

    return {
      text: lines.join('\n'),
      ok: verified && issues.length === 0,
      raw: outcome.raw,
      report: parsed,
    }
  },

  async runEval(ctx: EvalContext): Promise<EvalVerdict> {
    return runVerifierEval({ pack: ctx.pack!, baseUrl: ctx.baseUrl })
  },
}
