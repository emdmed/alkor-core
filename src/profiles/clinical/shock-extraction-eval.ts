/**
 * The shock-extraction eval: a prose note in, a ShockExam payload out, graded against the
 * fixed payload the downstream reasoning task already consumes.
 *
 * The upstream half of the end-to-end pipeline. Each case is a synthetic note that restates
 * the findings of an existing shock case in prose, and the expectation is the SAME exam.json
 * the reasoning task already grades against. The two tasks share an expectation file rather
 * than a corpus, because the expectation is the payload — a closed set of findings — and the
 * note is just one of many ways a clinician might have recorded them.
 */
import type { Pack } from '../../core/pack.ts'
import type { Trace } from '../../core/trace.ts'
import type { Provider } from '../../core/client.ts'
import { identifyServer, UNIDENTIFIED, type ServerIdentity } from '../../core/client.ts'
import { HARNESS_VERSION } from '../../core/version.ts'
import { extract } from '../../modes/extract.ts'
import { ProfileError } from '../../core/profile.ts'
import { buildRequest, CONTRACTS } from './contracts.ts'
import { parseJson } from './extraction.ts'
import { DIFFICULTY_MAX, DIFFICULTY_MIN, parseDifficultyRange } from './cases.ts'
import { classify, loadShockRule, resolveExam, SHOCK_CATEGORIES, type ShockCategory, type ShockExam } from './shock.ts'
import type { MedprotocolRule } from './medprotocol.ts'
import type { TaskResult } from './set-eval.ts'

export interface ShockExtractionEvalOptions {
  pack: Pack
  baseUrl?: string
  trace: Trace
  constrain: boolean
  runs?: number
  difficulty?: string
  identity?: ServerIdentity
  cachePrompt?: boolean
  provider?: Provider
}

export interface ShockExtractionCase {
  name: string
  difficulty: number
  /** The expected payload, loaded from the existing exam file. */
  expect: ShockExam
  /**
   * The category the shock rule computes from that payload, as the case file states it.
   *
   * Read by `shock-pipeline`, which grades the category this note's extraction ends at. The
   * extraction task itself ignores it: what it measures is the payload, and the payload is the
   * expectation above. See `loadShockExtractionCases` for why the file states it at all.
   */
  expectCategory: ShockCategory
}

export interface ShockExtractionCases {
  cases: ShockExtractionCase[]
  /** Exact-match floor: share of cases whose every field matches the expectation. */
  exactMatchFloor: number
}

export const shockExtractionDocumentNames = (pack: Pack): string[] => {
  const raw = loadShockExtractionCases(pack)
  return raw.cases.map((c) => c.name)
}

/**
 * The prose corpus, its payload expectations and the category each payload classifies to.
 *
 * `expect` in this file is a SECOND statement of what `classify` computes from the payload,
 * and it is checked against the rule at load for the reason `shock-cases.json` gives at
 * length: an expectation derived only from the harness cannot disagree with the harness, so a
 * bug in the twelve-line rule would silently redefine truth and every number would stay green.
 * The cross-check lives here, at load, because that is the only place a disagreement can be
 * reported as a pack error naming the case rather than charged to the weights.
 */
export const loadShockExtractionCases = (pack: Pack, mp?: MedprotocolRule): ShockExtractionCases => {
  const raw = JSON.parse(pack.read('shockExtractionCases')) as {
    cases?: unknown[]
    exactMatchFloor?: number
  }
  if (!Array.isArray(raw.cases) || !raw.cases.length) {
    throw new ProfileError(`pack '${pack.name}': shockExtractionCases has no cases`)
  }
  if (typeof raw.exactMatchFloor !== 'number' || raw.exactMatchFloor < 0 || raw.exactMatchFloor > 1) {
    throw new ProfileError(
      `pack '${pack.name}': shockExtractionCases.exactMatchFloor must be a number in 0..1`,
    )
  }
  const cases: ShockExtractionCase[] = []
  const seen = new Set<string>()
  const rule = mp ? loadShockRule(pack) : undefined
  for (const c of raw.cases) {
    const o = c as Record<string, unknown>
    if (typeof o.name !== 'string' || !o.name) {
      throw new ProfileError(`pack '${pack.name}': shockExtractionCases has a case with no name`)
    }
    // A name listed twice would read the same note and the same payload twice and be counted
    // twice, weighting one route through the rule double — the argument loadShockCases makes.
    if (seen.has(o.name)) throw new ProfileError(`pack '${pack.name}': shockExtractionCases names case '${o.name}' twice`)
    seen.add(o.name)
    if (typeof o.difficulty !== 'number' || o.difficulty < DIFFICULTY_MIN || o.difficulty > DIFFICULTY_MAX) {
      throw new ProfileError(
        `pack '${pack.name}': case '${o.name}' has difficulty ${o.difficulty}, expected ${DIFFICULTY_MIN}-${DIFFICULTY_MAX}`,
      )
    }
    if (!SHOCK_CATEGORIES.includes(o.expect as ShockCategory)) {
      throw new ProfileError(
        `pack '${pack.name}': case '${o.name}' expects ${JSON.stringify(o.expect)}, ` +
          `which is not one of ${SHOCK_CATEGORIES.join(', ')} — shock-pipeline grades the category ` +
          'this note ends at, and a case that does not name one is a case it cannot grade',
      )
    }
    const expectCategory = o.expect as ShockCategory
    const exam = JSON.parse(pack.document(o.name, 'exam')) as ShockExam
    // Only when a caller supplied medprotocol. The cross-check needs a resolved payload and
    // resolving one is a subprocess, so the extraction task — which never asks about the
    // category — is not made to spawn one to load its own corpus.
    if (mp && rule) {
      const truth = classify(resolveExam(exam, rule, mp))
      if (truth.category !== expectCategory) {
        throw new ProfileError(
          `pack '${pack.name}': case '${o.name}' expects ${expectCategory} but the rule computes ` +
            `${truth.category} from its payload — the answer key and the reference rule disagree, and ` +
            'until they are reconciled every number shock-pipeline reports is about whichever is wrong',
        )
      }
    }
    cases.push({ name: o.name, difficulty: o.difficulty, expect: exam, expectCategory })
  }
  return { cases, exactMatchFloor: raw.exactMatchFloor }
}

export const parseShockExam = (raw: string): ShockExam => {
  const obj = parseJson(raw, 'shock-extraction')
  const h = obj.hypotension as Record<string, unknown> | undefined
  if (!h || typeof h.systolic !== 'number' || typeof h.diastolic !== 'number' || typeof h.duration_minutes !== 'number') {
    throw new Error('hypotension must be an object with systolic, diastolic and duration_minutes as numbers')
  }
  if (typeof obj.heart_rate !== 'number') {
    throw new Error('heart_rate must be a number')
  }
  const enums: Record<string, readonly string[]> = {
    skin_temperature: ['warm', 'cool', 'not_assessed'],
    jugular_venous_pressure: ['elevated', 'normal_or_low', 'not_assessed'],
    capillary_refill: ['brisk', 'delayed', 'not_assessed'],
    pulse_volume: ['bounding', 'normal', 'thready', 'not_assessed'],
    lung_exam: ['clear', 'bilateral_crackles', 'not_assessed'],
  }
  for (const [name, allowed] of Object.entries(enums)) {
    const v = obj[name]
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      throw new Error(`${name} was ${JSON.stringify(v)}, expected one of ${allowed.join(', ')}`)
    }
  }
  return obj as unknown as ShockExam
}

export const examEqual = (a: ShockExam, b: ShockExam): boolean => {
  if (a.hypotension.systolic !== b.hypotension.systolic) return false
  if (a.hypotension.diastolic !== b.hypotension.diastolic) return false
  if (a.hypotension.duration_minutes !== b.hypotension.duration_minutes) return false
  if (a.heart_rate !== b.heart_rate) return false
  if (a.skin_temperature !== b.skin_temperature) return false
  if (a.jugular_venous_pressure !== b.jugular_venous_pressure) return false
  if (a.capillary_refill !== b.capillary_refill) return false
  if (a.pulse_volume !== b.pulse_volume) return false
  if (a.lung_exam !== b.lung_exam) return false
  return true
}

export const runShockExtractionEval = async (o: ShockExtractionEvalOptions): Promise<TaskResult> => {
  const req = buildRequest(CONTRACTS['shock-extraction'], o.pack, o.constrain)
  const { cases: allCases, exactMatchFloor } = loadShockExtractionCases(o.pack)

  const inScope = o.difficulty ? parseDifficultyRange(o.difficulty) : () => true
  const cases = allCases.filter((c) => inScope(c.difficulty))
  if (!cases.length) throw new Error(`no cases at difficulty '${o.difficulty}' in pack '${o.pack.name}'`)

  const runs = Math.max(1, o.runs ?? 1)
  const cachePrompt = o.cachePrompt ?? true
  const identity = o.identity ?? (await identifyServer(o.baseUrl))
  const served = identity.model ?? UNIDENTIFIED

  let exactMatches = 0
  let failedRuns = 0

  console.log(
    `\n=== Shock extraction — ${cases.length} notes, difficulty ${o.difficulty ?? `${DIFFICULTY_MIN}-${DIFFICULTY_MAX}`} ===`,
  )
  console.log(
    `model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
      `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
      `temp ${req.sampling.temperature} · max_tokens ${req.sampling.max_tokens}${runs > 1 ? ` · ${runs} runs` : ''}`,
  )

  for (const c of cases) {
    const note = o.pack.document(c.name)
    let caseExact = false
    for (let run = 0; run < runs; run++) {
      const outcome = await extract({
        systemPrompt: req.prompt,
        document: note,
        parse: parseShockExam,
        schema: req.schema,
        schemaName: req.schemaName,
        maxTokens: req.sampling.max_tokens,
        temperature: req.sampling.temperature,
        timeoutMs: req.sampling.timeout_secs * 1000,
        baseUrl: o.baseUrl,
        cachePrompt,
        label: 'shock-extraction',
        provider: o.provider,
      })
      if (!outcome.parsed) {
        failedRuns++
        o.trace.write({
          event: 'case',
          task: 'shock-extraction',
          case: c.name,
          difficulty: c.difficulty,
          run,
          ok: false,
          error: outcome.error,
          completion: outcome.raw,
        })
        console.log(`${c.name.padEnd(30)} d${c.difficulty}  FAILED: ${outcome.error?.slice(0, 60)}`)
        continue
      }
      if (examEqual(outcome.parsed, c.expect)) {
        caseExact = true
      }
      o.trace.write({
        event: 'case',
        task: 'shock-extraction',
        case: c.name,
        difficulty: c.difficulty,
        run,
        ok: true,
        exact: caseExact,
        completion: outcome.raw,
      })
    }
    if (caseExact) exactMatches++
    console.log(`${c.name.padEnd(30)} d${c.difficulty}  ${caseExact ? 'exact' : 'differs'}`)
  }

  const score = cases.length ? exactMatches / cases.length : 0
  const pass = score >= exactMatchFloor

  o.trace.write({
    event: 'record',
    harness: HARNESS_VERSION,
    model: served,
    constrained: o.constrain,
    task: 'shock-extraction',
    cases: cases.length,
    exactMatches,
    exactMatchFloor,
    pass,
  })

  return {
    task: 'shock-extraction',
    score,
    floor: exactMatchFloor,
    measured: cases.length > 0,
    summary: `${exactMatches}/${cases.length} exact (${(score * 100).toFixed(0)}% vs floor ${(exactMatchFloor * 100).toFixed(0)}%)`,
  }
}
