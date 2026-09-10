/**
 * Prepare a clinical workflow report for the generic provenance verifier.
 *
 * A clinical report contains two different kinds of claims: observations extracted from the
 * source document, and values derived from those observations. The generic verifier can check
 * the first kind against prose; the clinical profile owns the rules needed to check the second.
 * This adapter enforces the derived shock AND qSOFA contracts deterministically, then removes
 * those fields from the model verifier's input so a correct calculation cannot be called a
 * hallucination for not appearing literally in the source.
 */
import type { EvalContext, EvalVerdict, ProfileModule, ReviewContext, ReviewResult } from '../../core/profile.ts'
import type { Pack } from '../../core/pack.ts'
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
import {
  assess,
  loadSepsisRule,
  parseSepsis,
  parseSepsisReply,
  resolveSepsis,
  scoreReply as scoreSepsisReply,
  type SepsisExam,
  type SepsisReply,
} from '../clinical/sepsis.ts'
import { checkMedprotocolVersion, loadMedprotocolRule } from '../clinical/medprotocol.ts'

type JsonObject = Record<string, unknown>

const object = (value: unknown): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined

const sameNames = (actual: string[], expected: string[]): boolean =>
  actual.length === expected.length && [...actual].sort().every((value, i) => value === [...expected].sort()[i])

/** The raw initial input as text, whether it arrived as a string or a parsed object. */
const documentText = (document: string | JsonObject): string =>
  typeof document === 'string' ? document : JSON.stringify(document)

/**
 * The deterministic qSOFA check, per-axis. `parseSepsisReply` has already refused a duplicate
 * criterion — the schema declares uniqueItems — so four axes are enough; a duplicate surfaces
 * as a parse refusal, never as a criteria choice.
 */
const sepsisDerivedIssues = (pack: Pack, exam: SepsisExam, reply: SepsisReply): string[] => {
  const mp = loadMedprotocolRule(pack)
  checkMedprotocolVersion(mp, pack.name)
  const resolved = resolveSepsis(exam, loadSepsisRule(pack), mp)
  const score = scoreSepsisReply(reply, resolved)
  const issues: string[] = []
  if (!score.echoCorrect) issues.push(`incorrect qSOFA echo: ${score.echoErrors.join(', ')}`)
  if (!score.criteriaCorrect) issues.push(`criteria list does not match the payload: ${score.criteriaErrors.join(', ')}`)
  if (!score.screenAgrees) issues.push(`verdict disagrees with medprotocol (screen says ${resolved.screen.positive})`)
  if (!score.scoreCorrect) issues.push(`score disagrees with medprotocol (screen scores ${resolved.screen.score}, extraction says ${reply.qsofa_score})`)
  return issues
}

const failed = (issues: Array<{ field: string; issue: string }>): ReviewResult => ({
  report: { verified: false, confidence: 1, issues },
  text: `clinical derivation verification failed: ${issues.map((issue) => `${issue.field}: ${issue.issue}`).join('; ')}`,
  ok: false,
})

/**
 * Is the initial input a qSOFA payload? Shock exam payloads never carry a `gcs`, so this cannot
 * fire on a shock-shaped document; that is what makes it a safe way to recognise a sepsis route
 * whose completion arrives without the `routes`/`results` wrapper (a single-task route).
 */
const sepsisExamOrUndefined = (document: string | JsonObject): SepsisExam | undefined => {
  try {
    return parseSepsis(documentText(document), 'clinical verifier input')
  } catch {
    return undefined
  }
}

const parseReply = (extraction: string | JsonObject): SepsisReply => {
  // The sepsis reply may arrive as the raw completion string (single-task route, where
  // `step-0.output` is the bare completion) or as the parsed reply object (inside a
  // `results.sepsis.output`). Round-tripping through the parser keeps ONE validation path —
  // including the duplicate-criterion refusal — for both shapes.
  return parseSepsisReply(typeof extraction === 'string' ? extraction : JSON.stringify(extraction))
}

const prepare = (ctx: ReviewContext, document: string | JsonObject, extraction: string | JsonObject): ReviewResult => {
  const composite = object(extraction)
  const routes = composite ? Array.isArray(composite.routes) ? composite.routes.filter((v): v is string => typeof v === 'string') : undefined : undefined
  const results = composite ? object(composite.results) : undefined

  // Non-composite clinical results are either source-extraction shaped or a bare single-task
  // sepsis completion. A sepsis-shaped initial input is the second kind: every claim it made is
  // derived from closed numerics, so it is verified here and nothing reaches the model verifier.
  if (!routes || !results) {
    const exam = sepsisExamOrUndefined(document)
    if (exam) {
      try {
        const reply = parseReply(extraction)
        const derived = sepsisDerivedIssues(ctx.pack!, exam, reply)
        if (derived.length) {
          return failed(derived.map((issue) => ({ field: 'sepsis', issue })))
        }
        const report = { document, extraction: {} }
        return { text: 'clinical sepsis reply verified; no source assertions', ok: true, report }
      } catch (error) {
        return failed([{ field: 'sepsis', issue: (error as Error).message }])
      }
    }
    const report = { document, extraction }
    return { text: 'clinical verification input prepared', ok: true, report }
  }

  const sourceExtraction: JsonObject = {}
  const issues: Array<{ field: string; issue: string }> = []
  let shockExam: ReturnType<typeof parseExam> | undefined
  /**
   * The qSOFA payload the sepsis screen was actually run on.
   *
   * `undefined` until a `sepsis-extraction` route supplies one, and the reason it must be
   * tracked at all is the same reason `shockExam` is: on the PROSE arm the payload is a model
   * output, not the input. Falling back to the document — which is what this adapter used to
   * do unconditionally — only works for a `qsofa-json` input that already is the payload.
   */
  let sepsisExam: SepsisExam | undefined

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
    if (route === 'sepsis-extraction') {
      const examValue = object(output.exam)
      if (!examValue) {
        issues.push({ field: 'results.sepsis-extraction.output.exam', issue: 'missing exam' })
        continue
      }
      try {
        sepsisExam = parseSepsis(JSON.stringify(examValue), 'clinical verifier input')
        // The three numbers ARE assertions about the prose, so they go on to the model
        // verifier. The screen beside them is arithmetic and is checked here instead — the
        // same split `shock-extraction` makes between its exam and its confirmation.
        sourceExtraction[route] = { exam: sepsisExam }

        const mp = loadMedprotocolRule(ctx.pack!)
        checkMedprotocolVersion(mp, ctx.pack!.name)
        const expected = assess(resolveSepsis(sepsisExam, loadSepsisRule(ctx.pack!), mp))
        const actual = object(output.screen)
        if (!actual || actual.positive !== expected.positive || actual.score !== expected.score) {
          issues.push({ field: 'results.sepsis-extraction.output.screen', issue: 'does not match the deterministic qSOFA screen' })
        }
      } catch (error) {
        issues.push({ field: 'results.sepsis-extraction.output.exam', issue: (error as Error).message })
      }
      continue
    }
    // `sepsis` is verified after this loop, beside `shock`, because both read a payload an
    // earlier route produced and neither may depend on the order routes arrive in.
    if (route === 'sepsis') continue
    if (route !== 'shock') sourceExtraction[route] = output
  }

  if (routes.includes('sepsis')) {
    const result = object(results.sepsis)
    const output = object(result?.output)
    // The extracted payload first, the document second. A prose note reaches the screen
    // through `sepsis-extraction`; a qSOFA payload IS the document and arrives with no
    // extraction route in front of it. Both are legitimate ways to reach this contract, and
    // reading only the second accused every prose sepsis note of claiming a route it had.
    const exam = sepsisExam ?? sepsisExamOrUndefined(document)
    if (!output) {
      issues.push({ field: 'results.sepsis.output', issue: 'missing structured output' })
    } else if (!exam) {
      issues.push({ field: 'results.sepsis.output', issue: 'no qSOFA payload: neither the initial input nor a sepsis-extraction route supplied one' })
    } else {
      try {
        const reply = parseReply(output)
        for (const issue of sepsisDerivedIssues(ctx.pack!, exam, reply)) {
          issues.push({ field: 'results.sepsis.output', issue })
        }
      } catch (error) {
        issues.push({ field: 'results.sepsis.output', issue: (error as Error).message })
      }
    }
    // Every claim a qSOFA reply can carry is derived; nothing source-shaped remains.
    sourceExtraction.sepsis = {}
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

  if (issues.length) return failed(issues)

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
    const document = input.document
    const extraction = typeof input.extraction === 'string' ? input.extraction : object(input.extraction)
    if (document === undefined || document === null || document === '' || extraction === undefined) {
      return { text: 'clinical verifier requires document and extraction objects', ok: false }
    }
    return prepare(ctx, document as string | JsonObject, extraction)
  },

  async runEval(_ctx: EvalContext): Promise<EvalVerdict> {
    return { pass: true, summary: 'deterministic clinical verification adapter loaded' }
  },
}
