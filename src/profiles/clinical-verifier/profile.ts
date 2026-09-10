/**
 * Prepare a clinical workflow report for the generic provenance verifier.
 *
 * A clinical report contains two different kinds of claims: observations extracted from the
 * source document, and values derived from those observations. The generic verifier can check
 * the first kind against prose; the clinical profile owns the rules needed to check the second.
 * This adapter enforces the derived shock contract deterministically, then removes those fields
 * from the model verifier's input so a correct calculation cannot be called a hallucination for
 * not appearing literally in the source.
 */
import type { EvalContext, EvalVerdict, ProfileModule, ReviewContext, ReviewResult } from '../../core/profile.ts'
import {
  classify,
  concordance,
  confirmShock,
  loadShockRule,
  parseExam,
  parseShockReply,
  resolveExam,
  scoreReply,
} from '../clinical/shock.ts'
import { checkMedprotocolVersion, loadMedprotocolRule } from '../clinical/medprotocol.ts'

type JsonObject = Record<string, unknown>

const object = (value: unknown): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined

const sameNames = (actual: string[], expected: string[]): boolean =>
  actual.length === expected.length && [...actual].sort().every((value, i) => value === [...expected].sort()[i])

const prepare = (ctx: ReviewContext, document: string, extraction: JsonObject): ReviewResult => {
  const routes = Array.isArray(extraction.routes) ? extraction.routes.filter((v): v is string => typeof v === 'string') : undefined
  const results = object(extraction.results)

  // Non-composite clinical results already are source-extraction shaped. Preserve them.
  if (!routes || !results) {
    const report = { document, extraction }
    return { text: 'clinical verification input prepared', ok: true, report }
  }

  const sourceExtraction: JsonObject = {}
  const issues: Array<{ field: string; issue: string }> = []
  let shockExam: ReturnType<typeof parseExam> | undefined

  for (const route of routes) {
    const result = object(results[route])
    const output = object(result?.output)
    if (!output) {
      issues.push({ field: `results.${route}.output`, issue: 'missing structured output' })
      continue
    }
    if (route === 'shock-extraction') {
      const examValue = object(output.exam)
      if (!examValue) {
        issues.push({ field: 'results.shock-extraction.output.exam', issue: 'missing exam' })
        continue
      }
      try {
        shockExam = parseExam(JSON.stringify(examValue), 'clinical verifier input')
        sourceExtraction[route] = { exam: shockExam }

        const mp = loadMedprotocolRule(ctx.pack!)
        checkMedprotocolVersion(mp, ctx.pack!.name)
        const expected = confirmShock(shockExam, mp, loadShockRule(ctx.pack!))
        const actual = object(output.confirmation)
        if (!actual || actual.confirmed !== expected.confirmed || actual.systolic !== expected.systolic ||
          typeof actual.shockIndex !== 'number' || Math.abs(actual.shockIndex - expected.shockIndex) > 1e-12) {
          issues.push({ field: 'results.shock-extraction.output.confirmation', issue: 'does not match deterministic confirmation' })
        }
      } catch (error) {
        issues.push({ field: 'results.shock-extraction.output.exam', issue: (error as Error).message })
      }
      continue
    }
    if (route !== 'shock') sourceExtraction[route] = output
  }

  if (routes.includes('shock')) {
    const result = object(results.shock)
    const output = object(result?.output)
    if (!shockExam) {
      issues.push({ field: 'results.shock.output', issue: 'cannot verify shock result without extracted exam' })
    } else if (!output) {
      issues.push({ field: 'results.shock.output', issue: 'missing structured output' })
    } else {
      try {
        const reply = parseShockReply(JSON.stringify(output))
        const mp = loadMedprotocolRule(ctx.pack!)
        const resolved = resolveExam(shockExam, loadShockRule(ctx.pack!), mp)
        const truth = classify(resolved)
        const score = scoreReply(reply, resolved)
        const citations = concordance(shockExam, truth)
        if (!score.echoCorrect) issues.push({ field: 'results.shock.output', issue: `incorrect finding echo: ${score.echoErrors.join(', ')}` })
        if (!score.categoryAgrees) issues.push({ field: 'results.shock.output.shock_category', issue: `expected ${truth.category}` })
        if (score.inventedFindings.length) issues.push({ field: 'results.shock.output', issue: `unassessed citations: ${score.inventedFindings.join(', ')}` })
        if (!sameNames(reply.supporting_findings, citations.supporting)) {
          issues.push({ field: 'results.shock.output.supporting_findings', issue: `expected ${citations.supporting.join(', ') || 'none'}` })
        }
        if (!sameNames(reply.discordant_findings, citations.discordant)) {
          issues.push({ field: 'results.shock.output.discordant_findings', issue: `expected ${citations.discordant.join(', ') || 'none'}` })
        }
        if (reply.indeterminate_reason !== truth.reason) {
          issues.push({ field: 'results.shock.output.indeterminate_reason', issue: `expected ${truth.reason ?? 'null'}` })
        }
      } catch (error) {
        issues.push({ field: 'results.shock.output', issue: (error as Error).message })
      }
    }
  }

  if (issues.length) {
    const report = { verified: false, confidence: 1, issues }
    return {
      text: `clinical derivation verification failed: ${issues.map((issue) => `${issue.field}: ${issue.issue}`).join('; ')}`,
      ok: false,
      report,
    }
  }

  const report = { document, extraction: sourceExtraction }
  return { text: 'clinical derivations verified; source assertions prepared', ok: true, report }
}

export const PROFILE: ProfileModule = {
  name: 'clinical-verifier',
  mode: 'router',
  needsPack: true,
  topology: { stages: [{ name: 'verify-derived' }, { name: 'prepare-source-verification' }] },

  async review(ctx: ReviewContext): Promise<ReviewResult> {
    if (ctx.input.kind !== 'text') return { text: 'clinical verifier accepts text input only', ok: false }
    let input: JsonObject
    try {
      input = JSON.parse(ctx.input.text) as JsonObject
    } catch {
      return { text: 'clinical verifier input must be JSON', ok: false }
    }
    const document = typeof input.document === 'string' ? input.document : ''
    const extraction = object(input.extraction)
    if (!document || !extraction) return { text: 'clinical verifier requires document and extraction objects', ok: false }
    return prepare(ctx, document, extraction)
  },

  async runEval(_ctx: EvalContext): Promise<EvalVerdict> {
    return { pass: true, summary: 'deterministic clinical verification adapter loaded' }
  },
}
