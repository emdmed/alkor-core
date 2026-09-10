/**
 * Deterministic verification for one sepsis-screen extraction.
 *
 * The extractor has already made the model call. This profile only parses that completion,
 * recomputes the qSOFA screen through the clinical pack's medprotocol rule, and compares the
 * two. Keeping this as a separate pipeline step makes the verification result useful to a
 * caller without changing the measured clinical extraction contract.
 */
import type { EvalContext, EvalVerdict, ProfileModule, ReviewContext, ReviewResult } from '../../core/profile.ts'
import { checkMedprotocolVersion, loadMedprotocolRule } from '../clinical/medprotocol.ts'
import {
  loadSepsisRule,
  parseSepsis,
  parseSepsisReply,
  resolveSepsis,
  scoreReply,
} from '../clinical/sepsis.ts'

export interface SepsisVerificationReport {
  echoOk: boolean
  criteriaOk: boolean
  screenOk: boolean
  scoreOk: boolean
  issues: string[]
}

const failedReport = (issue: string): SepsisVerificationReport => ({
  echoOk: false,
  criteriaOk: false,
  screenOk: false,
  scoreOk: false,
  issues: [issue],
})

const refusal = (issue: string): ReviewResult => ({
  text: `sepsis verification failed: ${issue}`,
  ok: false,
  report: failedReport(issue),
})

export const PROFILE: ProfileModule = {
  name: 'sepsis-verify',
  mode: 'extract',
  needsPack: true,
  topology: { stages: [{ name: 'verify' }] },

  async review(ctx: ReviewContext): Promise<ReviewResult> {
    if (ctx.input.kind !== 'text') return refusal('sepsis verifier only accepts composed JSON input')
    if (!ctx.pack) return refusal('sepsis verifier requires a contract pack')

    let input: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(ctx.input.text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('expected an object')
      input = parsed as Record<string, unknown>
    } catch (e) {
      return refusal(`input must be JSON with fields "document" and "extraction" — ${(e as Error).message}`)
    }

    const document = input.document
    if (
      typeof document !== 'string' &&
      (typeof document !== 'object' || document === null || Array.isArray(document))
    ) return refusal('input "document" must be an exam JSON string or object')
    if (typeof input.extraction !== 'string') {
      return refusal('input "extraction" must be the raw JSON completion string')
    }

    try {
      const exam = parseSepsis(typeof document === 'string' ? document : JSON.stringify(document), 'sepsis verifier document')
      const reply = parseSepsisReply(input.extraction)
      const medprotocol = loadMedprotocolRule(ctx.pack)
      checkMedprotocolVersion(medprotocol, ctx.pack.name)
      const resolved = resolveSepsis(exam, loadSepsisRule(ctx.pack), medprotocol)
      const score = scoreReply(reply, resolved)

      // `parseSepsisReply` refuses a duplicate criterion outright — the schema declares
      // uniqueItems — so a duplicate surfaces here as a refusal, never as a criteria choice.
      const report: SepsisVerificationReport = {
        echoOk: score.echoCorrect,
        criteriaOk: score.criteriaCorrect,
        screenOk: score.screenAgrees,
        scoreOk: reply.qsofa_score === resolved.screen.score,
        issues: [],
      }
      if (!report.echoOk) report.issues.push(`echo mismatch: ${score.echoErrors.join(', ')}`)
      if (!report.criteriaOk) {
        report.issues.push(`criteria mismatch: ${score.criteriaErrors.join(', ')}`)
      }
      if (!report.screenOk) {
        report.issues.push(`screen mismatch: extraction says ${reply.positive}, medprotocol says ${resolved.screen.positive}`)
      }
      if (!report.scoreOk) {
        report.issues.push(`score mismatch: extraction says ${reply.qsofa_score}, medprotocol says ${resolved.screen.score}`)
      }

      const ok = report.echoOk && report.criteriaOk && report.screenOk && report.scoreOk
      return {
        text: ok ? 'sepsis verification passed' : `sepsis verification failed: ${report.issues.join('; ')}`,
        ok,
        raw: input.extraction,
        report,
      }
    } catch (e) {
      return refusal((e as Error).message)
    }
  },

  async runEval(ctx: EvalContext): Promise<EvalVerdict> {
    if (!ctx.pack) return { pass: false, summary: 'sepsis verifier requires a contract pack' }
    try {
      loadSepsisRule(ctx.pack)
      const medprotocol = loadMedprotocolRule(ctx.pack)
      checkMedprotocolVersion(medprotocol, ctx.pack.name)
      return { pass: true, summary: `sepsis verifier rules validated for pack '${ctx.pack.name}'` }
    } catch (e) {
      return { pass: false, summary: `sepsis verifier rule validation failed: ${(e as Error).message}` }
    }
  },
}
