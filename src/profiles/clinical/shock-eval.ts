/**
 * The shock eval: one constrained pass per payload, five gates, one reference arm in code.
 *
 * It is built like `eval.ts` and `set-eval.ts` — same transport, same trace, same `TaskResult`
 * — and differs in the one way that matters: the answer key is not written down. `classify`
 * computes it from the payload the model was shown, which makes this the only task in the pack
 * whose expectation can be checked rather than trusted. The case file restates it anyway and
 * `loadShockCases` reconciles the two at load; see `_expectIsCrossChecked`.
 *
 * WHAT THE HEADLINE NUMBER IS. Agreement with a published bedside heuristic (Vazquez et al.,
 * J Hosp Med 2010, 76% in its own cohort), NOT diagnostic accuracy. Every line this file
 * prints says so, because a percentage next to the word "shock" is going to be quoted by
 * somebody who did not read the case file.
 *
 * THE RULE ARM IS PRINTED BESIDE THE MODEL ARM, always. `classify` scores 100% on this corpus
 * by construction and costs nothing, so the honest comparison is not "did the model clear the
 * floor" but "did the model earn its place over twelve lines of TypeScript". A run that only
 * printed the model's number would let a contract ship a 4B model to do a table lookup, which
 * is the specific waste this task exists to expose. What the model can do that the rule cannot
 * is narrate — `indeterminate_reason`, the discordant citations — and that is reported as
 * coverage rather than folded into the gate, because no answer key here can grade a sentence.
 */
import type { Pack } from '../../core/pack.ts'
import type { Trace } from '../../core/trace.ts'
import { identifyServer, UNIDENTIFIED, type ServerIdentity } from '../../core/client.ts'
import { formatBench, summarizeBench, type BenchSample, type BenchSummary } from '../../core/bench.ts'
import { formatStability, summarizeStability, type Observation } from '../../core/stability.ts'
import { HARNESS_VERSION } from '../../core/version.ts'
import { extract } from '../../modes/extract.ts'
import { DIFFICULTY_MAX, DIFFICULTY_MIN, parseDifficultyRange } from './cases.ts'
import { CONTRACTS, buildRequest } from './contracts.ts'
import type { Gate, TaskResult } from './set-eval.ts'
import {
  classify,
  concordance,
  loadShockCases,
  loadShockRule,
  parseShockReply,
  renderExam,
  scoreReply,
  totals,
  type ShockCase,
  type ShockScore,
} from './shock.ts'
import { checkMedprotocolVersion, loadMedprotocolRule } from './medprotocol.ts'

export interface ShockEvalOptions {
  pack: Pack
  baseUrl?: string
  trace: Trace
  constrain: boolean
  runs?: number
  difficulty?: string
  identity?: ServerIdentity
  cachePrompt?: boolean
}

/** A percentage, or `n/a` when the denominator was zero. Never `(0/0) -> 100%`. */
const pct = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(0)}% (${n}/${d})` : `n/a (0/0)`)

export const runShockEval = async (o: ShockEvalOptions): Promise<TaskResult> => {
  const spec = CONTRACTS.shock
  // The same assembly the consuming application runs. Two callers building their own prompt,
  // schema and cap is how a measured path and a used path drift by a line.
  const req = buildRequest(spec, o.pack, o.constrain)
  const rule = loadShockRule(o.pack)
  // Asked ONCE for the whole run, not per case: the installed version is a property of the
  // machine, and twenty subprocesses asking it would be twenty chances to disagree. A mismatch
  // against the pack's declaration refuses the run — this contract's answer key depends on
  // where medprotocol draws its category boundaries.
  const mp = loadMedprotocolRule(o.pack)
  const medprotocolVersion = checkMedprotocolVersion(mp, o.pack.name)
  const { cases: allCases, ...floors } = loadShockCases(o.pack, mp)

  // Filtered here rather than in the loader, so the loader's checks — every expectation
  // reconciled against the rule, both kinds of case present — run over the WHOLE corpus even
  // when a run grades four payloads of it.
  const inScope = o.difficulty ? parseDifficultyRange(o.difficulty) : () => true
  const cases = allCases.filter((c) => inScope(c.difficulty))
  if (!cases.length) throw new Error(`no cases at difficulty '${o.difficulty}' in pack '${o.pack.name}'`)

  const runs = Math.max(1, o.runs ?? 1)
  const cachePrompt = o.cachePrompt ?? true
  const identity = o.identity ?? (await identifyServer(o.baseUrl))
  const served = identity.model ?? UNIDENTIFIED

  const scores: ShockScore[] = []
  const samples: BenchSample[] = []
  const observations: Observation[] = []
  const misses: string[] = []
  /** Replies that never parsed. Counted apart from wrong answers; see `measured` below. */
  let failedRuns = 0
  /**
   * How often the model said WHY it declined, over the times it declined.
   *
   * Reported and never gated, because no answer key in this pack can grade a sentence — the
   * thing being counted is whether one is there at all. It is the only number here that
   * describes what the model offers over the rule arm, so leaving it out would make the
   * comparison below unfair in the model's disfavour.
   */
  let declined = 0
  let declinedWithReason = 0

  const conditions = {
    harness: HARNESS_VERSION,
    model: served,
    declared: o.pack.toml<{ generation?: { id?: string } }>('models').generation?.id,
    baseUrl: o.baseUrl,
    constrained: o.constrain,
    sampling: req.sampling,
    pack: { name: o.pack.name, spec: o.pack.spec },
    task: 'shock',
    cases: cases.length,
    corpusCases: allCases.length,
    difficulty: o.difficulty ?? `${DIFFICULTY_MIN}-${DIFFICULTY_MAX}`,
    runs,
    cachePrompt,
    identified: identity.identified,
    identityWarning: identity.warning,
    // The rule the answer key was generated by, in the trace. A number reproduced against a
    // different cut-point is a number about a different contract, and this is the only record
    // that would say so.
    rule,
    // The CLI that decided every number in this run, by version. A result reproduced against
    // a different build is a result about a different rule.
    medprotocol: { version: medprotocolVersion, command: mp.command },
    floors,
  }
  o.trace.write({ event: 'run', ...conditions })
  if (!o.identity && identity.warning) console.error(`\nwarning: ${identity.warning}`)

  const scope =
    cases.length === allCases.length
      ? `difficulty ${DIFFICULTY_MIN}-${DIFFICULTY_MAX}`
      : `difficulty ${o.difficulty} only — ${cases.length} of ${allCases.length} payloads`
  console.log(`\n=== Shock category — ${cases.length} examination payloads, ${scope} ===`)
  console.log(
    `model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
      `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
      `temp ${req.sampling.temperature} · max_tokens ${req.sampling.max_tokens}${runs > 1 ? ` · ${runs} runs` : ''}`,
  )
  // Printed BEFORE the per-case lines rather than in a footnote. Everything below is a
  // percentage beside the word "shock", and the caveat is worth less after the number.
  console.log(
    `agreement with the Vazquez 2010 bedside rule (76% accurate in its own cohort) — NOT diagnostic accuracy\n`,
  )

  for (const c of cases) {
    // The rendering, not the file. It is the contract's input and it lives in shock.ts so the
    // consuming application sends the same bytes; see `renderExam`.
    const payload = renderExam(c.resolved)
    const truth = classify(c.resolved)

    for (let run = 0; run < runs; run++) {
      const outcome = await extract({
        systemPrompt: req.prompt,
        document: payload,
        parse: parseShockReply,
        schema: req.schema,
        schemaName: req.schemaName,
        maxTokens: req.sampling.max_tokens,
        temperature: req.sampling.temperature,
        timeoutMs: req.sampling.timeout_secs * 1000,
        baseUrl: o.baseUrl,
        cachePrompt,
        label: 'shock',
      })

      const sample: BenchSample | undefined = outcome.cost.length
        ? {
            case: c.name,
            wallMs: outcome.cost.reduce((n, a) => n + a.wallMs, 0) + outcome.lostMs,
            attempts: outcome.attempts,
            promptTokens: outcome.cost.reduce((n, a) => n + (a.timings?.promptTokens ?? 0), 0),
            promptMs: outcome.cost.reduce((n, a) => n + (a.timings?.promptMs ?? 0), 0),
            predictedTokens: outcome.cost.reduce((n, a) => n + (a.timings?.predictedTokens ?? 0), 0),
            predictedMs: outcome.cost.reduce((n, a) => n + (a.timings?.predictedMs ?? 0), 0),
            cachedTokens: outcome.cost.reduce((n, a) => n + (a.timings?.cachedTokens ?? 0), 0),
          }
        : undefined
      if (sample) samples.push(sample)

      // A reply that never parsed is NOT scored as a wrong category. It contributes no score
      // at all, and `failedRuns` carries it into the gate through `measured`: a run where every
      // completion was fenced would otherwise report 0% agreement, which reads as a model that
      // cannot reason when it is a model whose output was never read.
      if (!outcome.parsed) {
        failedRuns++
        misses.push(`parse         ${c.name} — ${outcome.error?.slice(0, 90) ?? 'unknown'}`)
        observations.push({
          case: c.name,
          run,
          completion: outcome.raw ?? `(no completion: ${outcome.error ?? 'unknown'})`,
          score: 'FAILED',
        })
        o.trace.write({
          event: 'case',
          task: 'shock',
          case: c.name,
          class: c.class,
          difficulty: c.difficulty,
          run,
          ok: false,
          error: outcome.error,
          expected: truth,
          cost: sample,
          completion: outcome.raw,
        })
        console.log(`${c.name.padEnd(30)} ${c.class.padEnd(15)} d${c.difficulty}  FAILED: ${outcome.error?.slice(0, 60)}`)
        continue
      }

      const reply = outcome.parsed
      const score = scoreReply(reply, c.resolved)
      scores.push(score)
      if (reply.shock_category === 'indeterminate') {
        declined++
        if (reply.indeterminate_reason) declinedWithReason++
      }

      // Each miss is its own accusation and none is folded into another. A wrong category, a
      // misread finding and an invented citation are three different faults with three
      // different fixes, and a line that said only "sh-04 failed" would need the trace opened
      // to tell which.
      if (!score.categoryAgrees) {
        misses.push(
          `category      ${c.name} — rule says ${truth.category}` +
            `${truth.reason ? ` (${truth.reason})` : ''}, model said ${reply.shock_category}`,
        )
      }
      for (const f of score.echoErrors) {
        const shown = f === 'skin_temperature' ? c.exam.skin_temperature : c.resolved.jvp
        misses.push(`echo          ${c.name} — payload shows ${f} ${shown}, model echoed ${reply[f]}`)
      }
      for (const f of score.inventedFindings) {
        misses.push(`invented      ${c.name} — cited ${f}, which this payload does not record`)
      }

      observations.push({ case: c.name, run, completion: outcome.raw ?? '', score: JSON.stringify(score) })
      o.trace.write({
        event: 'case',
        task: 'shock',
        case: c.name,
        class: c.class,
        difficulty: c.difficulty,
        run,
        ok: true,
        // The rule's answer AND the model's, side by side in the record. A reader checking a
        // disagreement should not have to re-derive the reference arm to see what it said.
        expected: truth,
        // What the rule arm would have cited, so the model's citations can be read against
        // something. Reported, never scored — see the file header.
        expectedConcordance: concordance(c.exam, truth),
        reply,
        score,
        cost: sample,
        completion: outcome.raw,
      })

      const mark = score.categoryAgrees ? ' ' : '✗'
      console.log(
        `${c.name.padEnd(30)} ${c.class.padEnd(15)} d${c.difficulty} ${mark} ` +
          `rule ${truth.category.padEnd(13)} model ${reply.shock_category.padEnd(13)} ` +
          `echo ${score.echoCorrect ? 'ok ' : 'BAD'} ` +
          `invented ${score.inventedFindings.length}`,
      )
    }
  }

  const t = totals(scores)
  // `measured` is what stops a gate clearing itself on an empty run. Every task in this
  // profile answers the same question the same way: a floor cleared by scoring nothing is not
  // a pass, and it used to read as one.
  const measured = scores.length > 0

  /**
   * Over-abstention as its COMPLEMENT, so one comparison decides every gate in this pack.
   *
   * `gatePasses` is `score >= floor` and the pack states a ceiling, so the choice is between a
   * special case in the shared gate and one subtraction here. The subtraction wins: a second
   * comparison direction inside `gatePasses` is a branch every future gate has to be checked
   * against, and the day someone gets it backwards the run reports a pass.
   */
  const restraint = 1 - t.overAbstention
  const gates: Gate[] = [
    { name: 'echoFidelity', score: t.echoFidelity, floor: floors.echoFidelityFloor, measured },
    { name: 'notInvented', score: t.notInvented, floor: floors.notInventedFloor, measured },
    {
      name: 'abstentionRecall',
      score: t.abstentionRecall,
      floor: floors.abstentionRecallFloor,
      // Measured only if the rule actually declined somewhere in SCOPE. `--difficulty 1` grades
      // three textbook cases, all decided, and this number would otherwise report a confident
      // 1.0 for a discipline that tier does not contain.
      measured: measured && scores.some((s) => s.ruleAbstained),
    },
    {
      name: 'restraint',
      score: restraint,
      floor: 1 - floors.overAbstentionCeiling,
      measured: measured && scores.some((s) => !s.ruleAbstained),
    },
  ]

  console.log(`\n${'—'.repeat(78)}`)
  console.log(
    `agreement    ${pct(scores.filter((s) => s.categoryAgrees).length, scores.length)}  <- the gate, floor ${(floors.categoryAgreementFloor * 100).toFixed(0)}%`,
  )
  console.log(
    `echo         ${pct(scores.filter((s) => s.echoCorrect).length, scores.length)}  <- sub-gate, floor ${(floors.echoFidelityFloor * 100).toFixed(0)}% — the two findings the rule acts on, as the payload states them`,
  )
  console.log(
    `not invented ${pct(scores.filter((s) => !s.inventedFindings.length).length, scores.length)}  <- sub-gate, floor ${(floors.notInventedFloor * 100).toFixed(0)}% — every cited finding is one this payload records`,
  )
  const declinedCases = scores.filter((s) => s.ruleAbstained)
  const decidedCases = scores.filter((s) => !s.ruleAbstained)
  console.log(
    `abstention   ${pct(declinedCases.filter((s) => s.abstained).length, declinedCases.length)}  <- sub-gate, floor ${(floors.abstentionRecallFloor * 100).toFixed(0)}% — of the payloads the rule declines`,
  )
  console.log(
    `restraint    ${pct(decidedCases.filter((s) => !s.abstained).length, decidedCases.length)}  <- sub-gate, floor ${((1 - floors.overAbstentionCeiling) * 100).toFixed(0)}% — of the payloads the rule DECIDES, not ducked`,
  )
  console.log(`failed runs  ${failedRuns}`)

  /**
   * The comparison the whole task exists for, printed unconditionally.
   *
   * The rule arm is 100% by construction — it IS the answer key — and saying so plainly is the
   * point rather than a caveat on it: it costs no tokens, no server and no weights, so a model
   * that merely matches it has not earned its place in the product. The narration column is
   * what the model has that the rule does not, and it is the only column where the rule scores
   * zero.
   */
  const bench = samples.length ? summarizeBench(samples) : undefined
  console.log(`\nwhat the model bought over the rule it is graded against:`)
  console.log(`  rule arm     100% agreement by construction, 0 tokens, no server — it is the answer key`)
  console.log(
    `  model arm    ${pct(scores.filter((s) => s.categoryAgrees).length, scores.length)} agreement` +
      (bench ? `, ${(bench.wall.totalMs / 1000).toFixed(1)}s of wall clock` : ''),
  )
  console.log(
    `  narration    ${pct(declinedWithReason, declined)} of the model's own declines carried a reason — ` +
      `the one thing a 2x2 cannot produce, and the only reason to run a model here at all`,
  )
  console.log(`               (reported, never gated: no answer key in this pack can grade a sentence)`)

  if (bench) {
    console.log(`\nwhat it cost:`)
    for (const line of formatBench(bench, identity.props)) console.log(`  ${line}`)
  }

  const stability = summarizeStability(observations)
  if (runs > 1) {
    console.log(`\nwhat repeated (${runs} runs per case):`)
    for (const line of formatStability(stability)) console.log(`  ${line}`)
  }

  if (misses.length) {
    console.log(`\nwhat went wrong (${misses.length}):`)
    for (const m of misses) console.log(`  ${m}`)
  }

  o.trace.write({
    event: 'record',
    task: 'shock',
    harness: HARNESS_VERSION,
    model: served,
    identified: identity.identified,
    constrained: o.constrain,
    contracts: o.pack.digest(),
    rule,
    medprotocol: { version: medprotocolVersion, command: mp.command },
    totals: t,
    failedRuns,
    declined,
    declinedWithReason,
    bench,
    benchSamples: samples,
    stability,
    cachePrompt,
    floors,
    gates,
    measured,
    pass: measured && t.categoryAgreement >= floors.categoryAgreementFloor && gates.every((g) => g.measured && g.score >= g.floor),
  })

  return {
    task: 'shock',
    score: t.categoryAgreement,
    floor: floors.categoryAgreementFloor,
    measured,
    gates,
    summary:
      `agreement ${pct(scores.filter((s) => s.categoryAgrees).length, scores.length)} ` +
      `(floor ${(floors.categoryAgreementFloor * 100).toFixed(0)}%, vs a rule arm that is 100% by construction) · ` +
      `echo ${(t.echoFidelity * 100).toFixed(0)}% · not invented ${(t.notInvented * 100).toFixed(0)}% · ` +
      `abstention ${(t.abstentionRecall * 100).toFixed(0)}% · restraint ${(restraint * 100).toFixed(0)}%` +
      (failedRuns ? ` · ${failedRuns} failed runs` : ''),
    bench,
  }
}

/** The corpus, for `--case` and for anything that wants to name a payload. */
export const shockDocumentNames = (pack: Pack): string[] =>
  loadShockCases(pack, loadMedprotocolRule(pack)).cases.map((c: ShockCase) => c.name)
