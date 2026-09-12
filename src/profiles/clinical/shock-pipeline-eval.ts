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
 *
 * THE CORPUS IS THE PROSE CORPUS. This task iterates the notes, not the payloads: a payload
 * with no note beside it is not a pipeline case, because there is no prose to start from. The
 * standalone `shock` task grades all twenty payloads and this one grades the notes that exist,
 * and conflating the two would report a denominator of twenty for a measurement that ran on
 * three. Each note's expected category is stated in the case file and cross-checked against
 * the rule at load — see `loadShockExtractionCases`.
 */
import type { Pack } from '../../core/pack.ts'
import type { Trace } from '../../core/trace.ts'
import type { Provider } from '../../core/client.ts'
import { identifyServer, UNIDENTIFIED, type ServerIdentity } from '../../core/client.ts'
import { formatBench, summarizeBench, type BenchSample } from '../../core/bench.ts'
import { HARNESS_VERSION } from '../../core/version.ts'
import { extract } from '../../modes/extract.ts'
import { ProfileError } from '../../core/profile.ts'
import { buildRequest, CONTRACTS } from './contracts.ts'
import { costOf, pct } from './eval-run.ts'
import { DIFFICULTY_MAX, DIFFICULTY_MIN, parseDifficultyRange } from './cases.ts'
import { examEqual, loadShockExtractionCases, parseShockExam } from './shock-extraction-eval.ts'
import {
  classify,
  loadShockCases,
  loadShockRule,
  parseShockReply,
  renderExam,
  resolveExam,
  scoreReply,
  totals,
  type ShockExam,
  type ShockScore,
} from './shock.ts'
import { checkMedprotocolVersion, loadMedprotocolRule } from './medprotocol.ts'
import { gatePasses, type Gate, type TaskResult } from './set-eval.ts'

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

/**
 * The floors this task gates on, from the pack.
 *
 * SEPARATE from the standalone shock floors and not derived from them. `shock-cases.json`
 * gates twenty payloads and can afford a floor stated to a hundredth; this corpus is three
 * notes and moves in steps of a third, so a floor borrowed from the other file would be a
 * precision this corpus cannot express. They are stated where the corpus they describe lives.
 */
interface PipelineFloors {
  categoryAgreementFloor: number
  extractionExactFloor: number
  completionFloor: number
}

const loadPipelineFloors = (pack: Pack): PipelineFloors => {
  const raw = JSON.parse(pack.read('shockExtractionCases')) as { pipeline?: Record<string, unknown> }
  const p = raw.pipeline
  if (!p || typeof p !== 'object') {
    throw new ProfileError(
      `pack '${pack.name}': shockExtractionCases must state a [pipeline] floor block — ` +
        'an absent floor is a gate that passes whatever it is handed, and it passes silently',
    )
  }
  const keys = ['categoryAgreementFloor', 'extractionExactFloor', 'completionFloor'] as const
  for (const k of keys) {
    const v = p[k]
    if (typeof v !== 'number' || v < 0 || v > 1) {
      throw new ProfileError(
        `pack '${pack.name}': shockExtractionCases.pipeline.${k} must be a number in 0..1, got ${JSON.stringify(v)}`,
      )
    }
  }
  return {
    categoryAgreementFloor: p.categoryAgreementFloor as number,
    extractionExactFloor: p.extractionExactFloor as number,
    completionFloor: p.completionFloor as number,
  }
}

export const runShockPipelineEval = async (o: ShockPipelineEvalOptions): Promise<TaskResult> => {
  const extractionReq = buildRequest(CONTRACTS['shock-extraction'], o.pack, o.constrain)
  const classificationReq = buildRequest(CONTRACTS.shock, o.pack, o.constrain)
  const rule = loadShockRule(o.pack)
  const mp = loadMedprotocolRule(o.pack)
  const medprotocolVersion = checkMedprotocolVersion(mp, o.pack.name)
  const floors = loadPipelineFloors(o.pack)
  // Loaded WITH medprotocol, so each note's stated category is cross-checked against the rule
  // before a single token is spent. The shock floors come along for the echo and invention
  // sub-gates, which are properties of the classification contract and not of this corpus.
  const { cases: allCases } = loadShockExtractionCases(o.pack, mp)
  const { cases: _payloadCases, ...shockFloors } = loadShockCases(o.pack, mp)

  const inScope = o.difficulty ? parseDifficultyRange(o.difficulty) : () => true
  const cases = allCases.filter((c) => inScope(c.difficulty))
  if (!cases.length) {
    throw new ProfileError(`no cases at difficulty '${o.difficulty}' in pack '${o.pack.name}'`)
  }

  const runs = Math.max(1, o.runs ?? 1)
  const cachePrompt = o.cachePrompt ?? true
  const identity = o.identity ?? (await identifyServer(o.baseUrl))
  const served = identity.model ?? UNIDENTIFIED

  /** Every note × every run: the denominator the completion and extraction gates are shares of. */
  let attempts = 0
  let exactMatches = 0
  let failedExtractions = 0
  let failedClassifications = 0
  /** Completed runs that reached the category the NOTE describes. See the note at `agrees`. */
  let pipelineAgreed = 0
  const scores: ShockScore[] = []
  const samples: BenchSample[] = []
  const misses: string[] = []

  console.log(
    `\n=== Shock pipeline — ${cases.length} notes, difficulty ${o.difficulty ?? `${DIFFICULTY_MIN}-${DIFFICULTY_MAX}`} ===`,
  )
  console.log(
    `model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
      `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
      `temp ${classificationReq.sampling.temperature} · max_tokens ${classificationReq.sampling.max_tokens}${runs > 1 ? ` · ${runs} runs` : ''}`,
  )
  console.log(`\nend-to-end: prose note → extraction → shock classification\n`)

  for (const c of cases) {
    const note = o.pack.document(c.name)

    for (let run = 0; run < runs; run++) {
      attempts++

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
      const extractionCost = extractionOutcome.cost.length ? costOf(extractionOutcome) : undefined

      if (!extractionOutcome.parsed) {
        failedExtractions++
        // The cost of a failed stage still counts. A pipeline that spends thirty seconds
        // producing nothing has spent thirty seconds, and a bench that dropped those samples
        // would report a faster pipeline the worse the model got.
        if (extractionCost) samples.push({ case: `${c.name}/extraction`, ...extractionCost })
        misses.push(`extraction    ${c.name} — ${extractionOutcome.error?.slice(0, 90) ?? 'unknown'}`)
        console.log(`${c.name.padEnd(30)} d${c.difficulty}  EXTRACTION FAILED: ${extractionOutcome.error?.slice(0, 60)}`)
        continue
      }

      const extractedExam = extractionOutcome.parsed as ShockExam
      const extractedExact = examEqual(extractedExam, c.expect)
      if (extractedExact) exactMatches++

      // --- Step 2: classify the extracted exam ---
      // The EXTRACTED payload is resolved and rendered, not the gold one. That is the whole
      // point of the task: the classifier sees what the extractor produced, so a misread
      // systolic reaches the rule the way it would in the product.
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
      const classificationCost = classificationOutcome.cost.length ? costOf(classificationOutcome) : undefined

      // One sample per ATTEMPT, both stages summed. The pipeline is the thing being measured
      // and its latency is what a caller waits for; two half-samples would halve the median.
      if (extractionCost || classificationCost) {
        const a = extractionCost ?? { wallMs: 0, attempts: 0, promptTokens: 0, promptMs: 0, predictedTokens: 0, predictedMs: 0, cachedTokens: 0 }
        const b = classificationCost ?? { wallMs: 0, attempts: 0, promptTokens: 0, promptMs: 0, predictedTokens: 0, predictedMs: 0, cachedTokens: 0 }
        samples.push({
          case: c.name,
          wallMs: a.wallMs + b.wallMs,
          attempts: a.attempts + b.attempts,
          promptTokens: a.promptTokens + b.promptTokens,
          promptMs: a.promptMs + b.promptMs,
          predictedTokens: a.predictedTokens + b.predictedTokens,
          predictedMs: a.predictedMs + b.predictedMs,
          cachedTokens: a.cachedTokens + b.cachedTokens,
        })
      }

      if (!classificationOutcome.parsed) {
        failedClassifications++
        misses.push(`classification ${c.name} — ${classificationOutcome.error?.slice(0, 90) ?? 'unknown'}`)
        console.log(`${c.name.padEnd(30)} d${c.difficulty}  EXTRACT ${extractedExact ? 'ok' : 'BAD'}  CLASS FAILED`)
        continue
      }

      const reply = classificationOutcome.parsed
      const score = scoreReply(reply, resolved)
      scores.push(score)

      // AGREEMENT IS AGAINST THE NOTE'S EXPECTED CATEGORY, not against the rule's reading of
      // whatever the extractor happened to produce. `scoreReply` compares the reply to the
      // extracted payload, which is the right comparison for the echo and invention sub-gates
      // — they ask whether the model read the payload in front of it. It is the WRONG
      // comparison for the pipeline gate: a model that misextracts and then classifies its own
      // mistake faithfully would score a perfect agreement on a patient nobody described.
      const agrees = reply.shock_category === c.expectCategory
      if (agrees) pipelineAgreed++
      if (!agrees) {
        misses.push(
          `category      ${c.name} — the note describes ${c.expectCategory}, model said ${reply.shock_category}` +
            (extractedExact ? '' : ' (extraction differed, so the classifier may have been reasoning correctly about the wrong payload)'),
        )
      }
      if (!extractedExact) {
        misses.push(`extraction    ${c.name} — payload differs from the note's expectation`)
      }

      const mark = agrees ? ' ' : '✗'
      console.log(
        `${c.name.padEnd(30)} d${c.difficulty} ${mark} ` +
          `extract ${extractedExact ? 'exact' : 'differs'} ` +
          `expected ${c.expectCategory.padEnd(13)} model ${reply.shock_category.padEnd(13)}`,
      )
    }
  }

  const t = totals(scores)
  const completed = scores.length
  const measured = completed > 0

  /**
   * Every gate's denominator is stated here rather than inferred, because the three differ.
   *
   * Completion and extraction are shares of ATTEMPTS: a run that never produced a payload is
   * exactly the failure they exist to catch, and dropping it from their denominator would let a
   * pipeline that failed nineteen times out of twenty report on the one that worked. Agreement
   * and the two classification sub-gates are shares of COMPLETED runs, because a completion
   * that was never read is not a wrong answer and scoring it as one would read as a model that
   * cannot reason when it is a model whose output never arrived. The completion gate is what
   * stops that distinction from becoming a hiding place.
   */
  const gates: Gate[] = [
    {
      name: 'pipelineCompletion',
      score: attempts ? completed / attempts : 0,
      floor: floors.completionFloor,
      measured: attempts > 0,
    },
    {
      name: 'extractionExact',
      score: attempts ? exactMatches / attempts : 0,
      floor: floors.extractionExactFloor,
      measured: attempts > 0,
    },
    { name: 'echoFidelity', score: t.echoFidelity, floor: shockFloors.echoFidelityFloor, measured },
    { name: 'notInvented', score: t.notInvented, floor: shockFloors.notInventedFloor, measured },
  ]

  const bench = samples.length ? summarizeBench(samples) : undefined

  console.log(`\n${'—'.repeat(78)}`)
  console.log(
    `agreement    ${pct(pipelineAgreed, completed)}  <- the gate, floor ${(floors.categoryAgreementFloor * 100).toFixed(0)}% — the category the NOTE describes`,
  )
  console.log(
    `completion   ${pct(completed, attempts)}  <- sub-gate, floor ${(floors.completionFloor * 100).toFixed(0)}% — attempts that reached a scored classification`,
  )
  console.log(
    `extraction   ${pct(exactMatches, attempts)}  <- sub-gate, floor ${(floors.extractionExactFloor * 100).toFixed(0)}% — payload matches the note's expectation exactly`,
  )
  console.log(
    `echo         ${pct(scores.filter((s) => s.echoCorrect).length, completed)}  <- sub-gate, floor ${(shockFloors.echoFidelityFloor * 100).toFixed(0)}% — as the EXTRACTED payload states them`,
  )
  console.log(
    `not invented ${pct(scores.filter((s) => !s.inventedFindings.length).length, completed)}  <- sub-gate, floor ${(shockFloors.notInventedFloor * 100).toFixed(0)}%`,
  )
  console.log(`failed extractions ${failedExtractions} · failed classifications ${failedClassifications}`)

  if (bench) {
    console.log(`\ncost, both stages summed per note:`)
    for (const line of formatBench(bench, identity.props)) console.log(`  ${line}`)
  }

  if (misses.length) {
    console.log(`\nwhat went wrong (${misses.length}):`)
    for (const m of misses) console.log(`  ${m}`)
  }

  const score = completed ? pipelineAgreed / completed : 0
  const primary = { score, floor: floors.categoryAgreementFloor, measured }
  // ONE definition of passing, shared with the TaskResult below. The trace previously demanded
  // a clean sweep while the summary gated on the floor, so a run could be a pass in the
  // console and a fail in the record it was supposed to be evidence for.
  const pass = gatePasses(primary) && gates.every(gatePasses)

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
    attempts,
    completed,
    exactMatches,
    agreed: pipelineAgreed,
    failedExtractions,
    failedClassifications,
    bench,
    benchSamples: samples,
    cachePrompt,
    floors: { ...shockFloors, ...floors },
    gates,
    measured,
    pass,
  })

  return {
    task: 'shock-pipeline',
    score,
    floor: floors.categoryAgreementFloor,
    measured,
    gates,
    summary:
      `agreement ${pct(pipelineAgreed, completed)} ` +
      `(floor ${(floors.categoryAgreementFloor * 100).toFixed(0)}%) · ` +
      `completion ${pct(completed, attempts)} · ` +
      `extraction ${pct(exactMatches, attempts)} exact · ` +
      `echo ${(t.echoFidelity * 100).toFixed(0)}% · not invented ${(t.notInvented * 100).toFixed(0)}%` +
      (failedExtractions ? ` · ${failedExtractions} failed extractions` : '') +
      (failedClassifications ? ` · ${failedClassifications} failed classifications` : ''),
    bench,
  }
}

/** The corpus, for `--case` and for anything that wants to name a note. */
export const shockPipelineDocumentNames = (pack: Pack): string[] =>
  loadShockExtractionCases(pack).cases.map((c) => c.name)
