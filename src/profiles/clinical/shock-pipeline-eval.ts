/**
 * The shock-pipeline eval: prose note → extraction → classification, end-to-end.
 *
 * Chains two LLM calls under one `--task` flag: the extraction contract produces a ShockExam
 * payload, and the shock contract classifies it. What is graded is the FINAL category
 * agreement — extraction errors that cause a wrong category are counted as a single pipeline
 * failure. A sub-gate on exact-match extraction separates "the model cannot read prose" from
 * "the model cannot apply the rule", which is the only way to know which prompt edit fixed
 * which failure.
 *
 * The two calls share the same transport, trace and bench infrastructure as the standalone
 * evals. Each call builds its own request from the shock and shock-extraction contracts
 * respectively, so the measured path is the same as the standalone paths chained together.
 */
import type { Pack } from '../../core/pack.ts'
import type { Trace } from '../../core/trace.ts'
import type { Provider } from '../../core/client.ts'
import { identifyServer, UNIDENTIFIED, type ServerIdentity } from '../../core/client.ts'
import { formatBench, summarizeBench, type BenchSample, type BenchSummary } from '../../core/bench.ts'
import { HARNESS_VERSION } from '../../core/version.ts'
import { extract } from '../../modes/extract.ts'
import { ProfileError } from '../../core/profile.ts'
import { buildRequest, CONTRACTS } from './contracts.ts'
import { parseJson } from './extraction.ts'
import { DIFFICULTY_MAX, DIFFICULTY_MIN, parseDifficultyRange } from './cases.ts'
import {
  classify,
  loadShockCases,
  loadShockRule,
  parseExam,
  parseShockReply,
  renderExam,
  resolveExam,
  scoreReply,
  totals,
  type ShockExam,
  type ShockScore,
} from './shock.ts'
import { checkMedprotocolVersion, loadMedprotocolRule } from './medprotocol.ts'
import type { Gate, TaskResult } from './set-eval.ts'

export interface ShockPipelineEvalOptions {
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

/** A percentage, or `n/a` when the denominator was zero. Never `(0/0) -> 100%`. */
const pct = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(0)}% (${n}/${d})` : `n/a (0/0)`)

/**
 * Parse the extraction contract's output. Strict: the grammar enforces this shape on a
 * constrained run, and an unconstrained run that produces anything else is measured as a
 * pipeline failure at the extraction step.
 */
const parseShockExam = (raw: string): ShockExam => {
  const obj = parseJson(raw, 'shock-pipeline')
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

/** Exact-match comparison for ShockExam payloads. */
const examEqual = (a: ShockExam, b: ShockExam): boolean =>
  a.hypotension.systolic === b.hypotension.systolic &&
  a.hypotension.diastolic === b.hypotension.diastolic &&
  a.hypotension.duration_minutes === b.hypotension.duration_minutes &&
  a.heart_rate === b.heart_rate &&
  a.skin_temperature === b.skin_temperature &&
  a.jugular_venous_pressure === b.jugular_venous_pressure &&
  a.capillary_refill === b.capillary_refill &&
  a.pulse_volume === b.pulse_volume &&
  a.lung_exam === b.lung_exam

export const runShockPipelineEval = async (o: ShockPipelineEvalOptions): Promise<TaskResult> => {
  const extractionReq = buildRequest(CONTRACTS['shock-extraction'], o.pack, o.constrain)
  const classificationReq = buildRequest(CONTRACTS.shock, o.pack, o.constrain)
  const rule = loadShockRule(o.pack)
  const mp = loadMedprotocolRule(o.pack)
  const medprotocolVersion = checkMedprotocolVersion(mp, o.pack.name)
  const { cases: allCases, ...shockFloors } = loadShockCases(o.pack, mp)

  // Load the extraction cases (prose notes), cross-referenced against the shock cases
  // (which carry the classification expectation in shock-cases.json). The two share case
  // names by design: each extraction note restates the findings of one exam payload.
  const extractionRaw = JSON.parse(o.pack.read('shockExtractionCases')) as {
    cases?: Array<{ name: string; difficulty: number }>
  }
  if (!Array.isArray(extractionRaw.cases) || !extractionRaw.cases.length) {
    throw new ProfileError(`pack '${o.pack.name}': shockExtractionCases has no cases`)
  }
  const extractionCases = new Map(
    extractionRaw.cases.map((c) => [c.name, c]),
  )

  // Filter by difficulty
  const inScope = o.difficulty ? parseDifficultyRange(o.difficulty) : () => true
  const shockCases = allCases.filter((c) => inScope(c.difficulty))
  if (!shockCases.length) {
    throw new Error(`no cases at difficulty '${o.difficulty}' in pack '${o.pack.name}'`)
  }

  const runs = Math.max(1, o.runs ?? 1)
  const cachePrompt = o.cachePrompt ?? true
  const identity = o.identity ?? (await identifyServer(o.baseUrl))
  const served = identity.model ?? UNIDENTIFIED

  let exactMatches = 0
  let failedExtractions = 0
  let failedClassifications = 0
  const scores: ShockScore[] = []
  const samples: BenchSample[] = []
  const misses: string[] = []

  console.log(
    `\n=== Shock pipeline — ${shockCases.length} notes, difficulty ${o.difficulty ?? `${DIFFICULTY_MIN}-${DIFFICULTY_MAX}`} ===`,
  )
  console.log(
    `model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
      `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
      `temp ${classificationReq.sampling.temperature} · max_tokens ${classificationReq.sampling.max_tokens}${runs > 1 ? ` · ${runs} runs` : ''}`,
  )
  console.log(`\nend-to-end: prose note → extraction → shock classification\n`)

  for (const c of shockCases) {
    const ec = extractionCases.get(c.name)
    if (!ec) {
      misses.push(`case ${c.name} has no extraction entry in shockExtractionCases`)
      continue
    }

    const note = o.pack.document(c.name)
    const truth = classify(c.resolved)

    for (let run = 0; run < runs; run++) {
      // --- Step 1: extract ShockExam from prose ---
      const extractionOutcome = await extract({
        systemPrompt: extractionReq.prompt,
        document: note,
        parse: parseShockExam,
        schema: extractionReq.schema,
        schemaName: extractionReq.schemaName,
        maxTokens: extractionReq.sampling.max_tokens,
        temperature: extractionReq.sampling.temperature,
        timeoutMs: extractionReq.sampling.timeout_secs * 1000,
        baseUrl: o.baseUrl,
        cachePrompt,
        label: 'shock-extraction',
        provider: o.provider,
      })

      if (!extractionOutcome.parsed) {
        failedExtractions++
        misses.push(`extraction    ${c.name} — ${extractionOutcome.error?.slice(0, 90) ?? 'unknown'}`)
        console.log(`${c.name.padEnd(30)} d${c.difficulty}  EXTRACTION FAILED: ${extractionOutcome.error?.slice(0, 60)}`)
        continue
      }

      const extractedExam = extractionOutcome.parsed as ShockExam
      const extractedExact = examEqual(extractedExam, c.exam)
      if (extractedExact) exactMatches++

      // --- Step 2: classify the extracted exam ---
      const resolved = resolveExam(extractedExam, rule, mp)
      const payload = renderExam(resolved)

      const classificationOutcome = await extract({
        systemPrompt: classificationReq.prompt,
        document: payload,
        parse: parseShockReply,
        schema: classificationReq.schema,
        schemaName: classificationReq.schemaName,
        maxTokens: classificationReq.sampling.max_tokens,
        temperature: classificationReq.sampling.temperature,
        timeoutMs: classificationReq.sampling.timeout_secs * 1000,
        baseUrl: o.baseUrl,
        cachePrompt,
        label: 'shock',
        provider: o.provider,
      })

      if (!classificationOutcome.parsed) {
        failedClassifications++
        misses.push(`classification ${c.name} — ${classificationOutcome.error?.slice(0, 90) ?? 'unknown'}`)
        console.log(`${c.name.padEnd(30)} d${c.difficulty}  EXTRACT ${extractedExact ? 'ok' : 'BAD'}  CLASS FAILED`)
        continue
      }

      const reply = classificationOutcome.parsed
      const score = scoreReply(reply, resolved)
      scores.push(score)

      if (!score.categoryAgrees) {
        misses.push(
          `category      ${c.name} — rule says ${truth.category}` +
            `${truth.reason ? ` (${truth.reason})` : ''}, model said ${reply.shock_category}`,
        )
      }
      if (!extractedExact) {
        for (const f of score.echoErrors) {
          const shown = f === 'skin_temperature' ? c.exam.skin_temperature : c.resolved.jvp
          misses.push(`echo          ${c.name} — payload shows ${f} ${shown}, model echoed ${reply[f]}`)
        }
      }

      const mark = score.categoryAgrees ? ' ' : '✗'
      console.log(
        `${c.name.padEnd(30)} d${c.difficulty} ${mark} ` +
          `extract ${extractedExact ? 'exact' : 'differs'} ` +
          `rule ${truth.category.padEnd(13)} model ${reply.shock_category.padEnd(13)}`,
      )
    }
  }

  const t = totals(scores)
  const measured = scores.length > 0
  const extractedMeasured = scores.length > 0 || exactMatches > 0

  const gates: Gate[] = [
    {
      name: 'extractionExact',
      score: extractedMeasured ? exactMatches / (exactMatches + (scores.length - exactMatches) + failedExtractions) : 0,
      floor: 0.67,
      measured: extractedMeasured,
    },
    { name: 'echoFidelity', score: t.echoFidelity, floor: shockFloors.echoFidelityFloor, measured },
    { name: 'notInvented', score: t.notInvented, floor: shockFloors.notInventedFloor, measured },
  ]

  const bench = samples.length ? summarizeBench(samples) : undefined

  console.log(`\n${'—'.repeat(78)}`)
  console.log(
    `agreement    ${pct(scores.filter((s) => s.categoryAgrees).length, scores.length)}  <- pipeline gate`,
  )
  console.log(
    `extraction   ${exactMatches}/${scores.length + failedExtractions} exact  <- sub-gate, floor 67%`,
  )
  console.log(
    `echo         ${pct(scores.filter((s) => s.echoCorrect).length, scores.length)}  <- sub-gate`,
  )
  console.log(
    `not invented ${pct(scores.filter((s) => !s.inventedFindings.length).length, scores.length)}  <- sub-gate`,
  )
  console.log(`failed extractions ${failedExtractions}`)
  console.log(`failed classifications ${failedClassifications}`)

  if (misses.length) {
    console.log(`\nwhat went wrong (${misses.length}):`)
    for (const m of misses) console.log(`  ${m}`)
  }

  o.trace.write({
    event: 'record',
    task: 'shock-pipeline',
    harness: HARNESS_VERSION,
    model: served,
    identified: identity.identified,
    constrained: o.constrain,
    contracts: o.pack.digest(),
    rule,
    medprotocol: { version: medprotocolVersion, command: mp.command },
    totals: t,
    exactMatches,
    failedExtractions,
    failedClassifications,
    bench,
    benchSamples: samples,
    cachePrompt,
    floors: { ...shockFloors, extractionExactFloor: 0.67 },
    gates,
    measured,
    pass:
      measured &&
      scores.length > 0 &&
      scores.every((s) => s.categoryAgrees) &&
      gates.every((g) => g.measured && g.score >= g.floor),
  })

  return {
    task: 'shock-pipeline',
    score: scores.length ? scores.filter((s) => s.categoryAgrees).length / scores.length : 0,
    floor: shockFloors.categoryAgreementFloor,
    measured,
    gates,
    summary:
      `agreement ${pct(scores.filter((s) => s.categoryAgrees).length, scores.length)} ` +
      `(floor ${(shockFloors.categoryAgreementFloor * 100).toFixed(0)}%) · ` +
      `extraction ${exactMatches}/${scores.length + failedExtractions} exact · ` +
      `echo ${(t.echoFidelity * 100).toFixed(0)}% · not invented ${(t.notInvented * 100).toFixed(0)}%` +
      (failedExtractions ? ` · ${failedExtractions} failed extractions` : '') +
      (failedClassifications ? ` · ${failedClassifications} failed classifications` : ''),
    bench,
  }
}

/** The corpus, for `--case` and for anything that wants to name a note. */
export const shockPipelineDocumentNames = (pack: Pack): string[] => {
  const raw = JSON.parse(pack.read('shockExtractionCases')) as { cases?: Array<{ name: string }> }
  return (raw.cases ?? []).map((c) => c.name)
}
