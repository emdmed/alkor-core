/**
 * The sepsis eval: one constrained pass per payload, four gates, one reference arm in code.
 *
 * It is built like `shock-eval.ts` — same transport, same trace, same `TaskResult` — and the
 * only difference is what is measured. The shock contract grades where a heuristic draws its
 * boundaries; this one grades whether the model reports the screen medprotocol computed. The
 * answer key is not a hand-written table: `assess` computes it from the payload the model was
 * shown, which makes this the pack's second rule-borne answer key.
 *
 * WHAT THE HEADLINE NUMBER IS. Agreement with the medprotocol `sepsis qsofa` command on whether
 * a fixed payload is a positive qSOFA screen — a screening trigger for sepsis suspicion, NOT a
 * diagnosis of sepsis and not a claim about any patient. Every line this file prints says so,
 * because a percentage next to the word "sepsis" is going to be quoted by somebody who did not
 * read the case file, and this is the case file's own warning restated at the point of impact.
 *
 * THE RULE ARM IS PRINTED BESIDE THE MODEL ARM, always. `resolveSepsis` scores 100% on this
 * corpus by construction and costs nothing, so the honest comparison is not "did the model clear
 * the floor" but "did the model earn its place over a subprocess". A run that only printed the
 * model's number would let a contract ship a 4B model to echo a computed verdict, which is the
 * specific waste this task exists to expose. What the model can do that the CLI cannot is narrate
 * — `screen_reason`, the criteria in its own words — and that is reported as coverage rather than
 * folded into the gate, because no answer key here can grade a sentence.
 */
import type { Pack } from '../../core/pack.ts'
import type { Trace } from '../../core/trace.ts'
import type { Provider } from '../../core/client.ts'
import { identifyServer, UNIDENTIFIED, type ServerIdentity } from '../../core/client.ts'
import { formatBench, summarizeBench, type BenchSample, type BenchSummary } from '../../core/bench.ts'
import { formatStability, summarizeStability, type Observation } from '../../core/stability.ts'
import { HARNESS_VERSION } from '../../core/version.ts'
import { extract } from '../../modes/extract.ts'
import { DIFFICULTY_MAX, DIFFICULTY_MIN, parseDifficultyRange } from './cases.ts'
import { CONTRACTS, buildRequest } from './contracts.ts'
import type { Gate, TaskResult } from './set-eval.ts'
import {
  assess,
  loadSepsisCases,
  loadSepsisRule,
  parseSepsisReply,
  renderSepsis,
  scoreReply,
  totals,
  type SepsisCase,
  type SepsisScore,
} from './sepsis.ts'
import { checkMedprotocolVersion, loadMedprotocolRule } from './medprotocol.ts'

export interface SepsisEvalOptions {
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

export const runSepsisEval = async (o: SepsisEvalOptions): Promise<TaskResult> => {
  const spec = CONTRACTS.sepsis
  // The same assembly the consuming application runs. Two callers building their own prompt,
  // schema and cap is how a measured path and a used path drift by a line.
  const req = buildRequest(spec, o.pack, o.constrain)
  const rule = loadSepsisRule(o.pack)
  // Asked ONCE for the whole run, not per case: the installed version is a property of the
  // machine, and twenty subprocesses asking it would be twenty chances to disagree. A mismatch
  // against the pack's declaration refuses the run — this contract's answer key depends on where
  // medprotocol draws its qSOFA cut-points.
  const mp = loadMedprotocolRule(o.pack)
  const medprotocolVersion = checkMedprotocolVersion(mp, o.pack.name)
  const { cases: allCases, ...floors } = loadSepsisCases(o.pack, mp)

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

  const scores: SepsisScore[] = []
  const samples: BenchSample[] = []
  const observations: Observation[] = []
  const misses: string[] = []
  /** Replies that never parsed. Counted apart from wrong answers; see `measured` below. */
  let failedRuns = 0

  const conditions = {
    harness: HARNESS_VERSION,
    model: served,
    declared: o.pack.toml<{ generation?: { id?: string } }>('models').generation?.id,
    baseUrl: o.baseUrl,
    constrained: o.constrain,
    sampling: req.sampling,
    pack: { name: o.pack.name, spec: o.pack.spec },
    task: 'sepsis',
    cases: cases.length,
    corpusCases: allCases.length,
    difficulty: o.difficulty ?? `${DIFFICULTY_MIN}-${DIFFICULTY_MAX}`,
    runs,
    cachePrompt,
    identified: identity.identified,
    identityWarning: identity.warning,
    // The threshold rule the criteria breakdown was derived under, in the trace. A number
    // reproduced against a different cut-point is a number about a different contract, and this
    // is the only record that would say so.
    rule,
    // The CLI that decided every number in this run, by version. A result reproduced against a
    // different build is a result about a different rule.
    medprotocol: { version: medprotocolVersion, command: mp.command },
    floors,
  }
  o.trace.write({ event: 'run', ...conditions })
  if (!o.identity && identity.warning) console.error(`\nwarning: ${identity.warning}`)

  const scope =
    cases.length === allCases.length
      ? `difficulty ${DIFFICULTY_MIN}-${DIFFICULTY_MAX}`
      : `difficulty ${o.difficulty} only — ${cases.length} of ${allCases.length} payloads`
  console.log(`\n=== Sepsis screen — ${cases.length} qSOFA payloads, ${scope} ===`)
  console.log(
    `model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
      `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
      `temp ${req.sampling.temperature} · max_tokens ${req.sampling.max_tokens}${runs > 1 ? ` · ${runs} runs` : ''}`,
  )
  // Printed BEFORE the per-case lines rather than in a footnote. Everything below is a
  // percentage beside the word "sepsis", and the caveat is worth less after the number.
  console.log(`\nagreement with the medprotocol "sepsis qsofa" verdict — a POSITIVE SCREEN IS NOT A DIAGNOSIS OF SEPSIS\n`)

  for (const c of cases) {
    // The rendering, not the file. It is the contract's input and it lives in sepsis.ts so the
    // consuming application sends the same bytes; see `renderSepsis`.
    const payload = renderSepsis(c.resolved)
    const truth = assess(c.resolved)

    for (let run = 0; run < runs; run++) {
      const outcome = await extract({
        systemPrompt: req.prompt,
        document: payload,
        parse: parseSepsisReply,
        schema: req.schema,
        schemaName: req.schemaName,
        maxTokens: req.sampling.max_tokens,
        temperature: req.sampling.temperature,
        timeoutMs: req.sampling.timeout_secs * 1000,
        baseUrl: o.baseUrl,
        cachePrompt,
        label: 'sepsis',
        provider: o.provider,
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

      // A reply that never parsed is NOT scored as a wrong verdict. It contributes no score at
      // all, and `failedRuns` carries it into the gate through `measured`: a run where every
      // completion was fenced would otherwise report 0% agreement, which reads as a model that
      // cannot read a screen when it is a model whose output was never read.
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
          task: 'sepsis',
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

      // Each miss is its own accusation and none is folded into another. A wrong verdict, a
      // misread input and an invented criterion are three different faults with three different
      // fixes, and a line that said only "sp-04 failed" would need the trace opened to tell which.
      if (!score.screenAgrees) {
        misses.push(
          `screen        ${c.name} — medprotocol says ${truth.positive ? 'POSITIVE' : 'negative'}, model said ${reply.positive}`,
        )
      }
      for (const f of score.echoErrors) {
        const shown = f === 'altered_mental_status' ? c.exam.gcs : f === 'respiratory_rate' ? c.exam.respiratory_rate : c.exam.systolic_bp
        misses.push(`echo          ${c.name} — payload shows ${f} ${shown}, model echoed ${reply[f === 'altered_mental_status' ? 'gcs' : f]}`)
      }
      for (const f of score.criteriaErrors) {
        misses.push(`criteria      ${c.name} — ${f} is ${c.resolved.criteria[f] ? 'met' : 'not met'}, model listed ${reply.criteria_met.includes(f) ? 'it' : 'it not'}`)
      }
      if (!score.scoreCorrect) {
        misses.push(`score         ${c.name} — medprotocol scores it ${truth.score}, model said ${reply.qsofa_score}`)
      }

      observations.push({ case: c.name, run, completion: outcome.raw ?? '', score: JSON.stringify(score) })
      o.trace.write({
        event: 'case',
        task: 'sepsis',
        case: c.name,
        class: c.class,
        difficulty: c.difficulty,
        run,
        ok: true,
        expected: truth,
        reply,
        score,
        cost: sample,
        completion: outcome.raw,
      })

      const mark = score.screenAgrees ? ' ' : '✗'
      console.log(
        `${c.name.padEnd(30)} ${c.class.padEnd(15)} d${c.difficulty} ${mark} ` +
          `rule ${truth.positive ? 'POSITIVE ' : 'negative '} model ${reply.positive ? 'POSITIVE ' : 'negative '} ` +
          `echo ${score.echoCorrect ? 'ok ' : 'BAD '} ` +
          `criteria ${score.criteriaCorrect ? 'ok' : 'BAD'} ` +
          `score ${score.scoreCorrect ? 'ok' : 'BAD'}`,
      )
    }
  }

  const t = totals(scores)
  // `measured` is what stops a gate clearing itself on an empty run. Every task in this profile
  // answers the same question the same way: a floor cleared by scoring nothing is not a pass,
  // and it used to read as one.
  const measured = scores.length > 0

  const gates: Gate[] = [
    { name: 'screenAgreement', score: t.screenAgreement, floor: floors.screenAgreementFloor, measured },
    { name: 'echoFidelity', score: t.echoFidelity, floor: floors.echoFidelityFloor, measured },
    { name: 'criteriaFidelity', score: t.criteriaFidelity, floor: floors.criteriaFidelityFloor, measured },
    { name: 'scoreFidelity', score: t.scoreFidelity, floor: floors.scoreFidelityFloor, measured },
  ]

  console.log(`\n${'—'.repeat(78)}`)
  console.log(
    `screen        ${pct(scores.filter((s) => s.screenAgrees).length, scores.length)}  <- the gate, floor ${(floors.screenAgreementFloor * 100).toFixed(0)}% — did the model report the CLI's verdict`,
  )
  console.log(
    `echo          ${pct(scores.filter((s) => s.echoCorrect).length, scores.length)}  <- sub-gate, floor ${(floors.echoFidelityFloor * 100).toFixed(0)}% — the three inputs, as the payload states them`,
  )
  console.log(
    `criteria      ${pct(scores.filter((s) => s.criteriaCorrect).length, scores.length)}  <- sub-gate, floor ${(floors.criteriaFidelityFloor * 100).toFixed(0)}% — exactly the criteria the payload meets`,
  )
  console.log(
    `score         ${pct(scores.filter((s) => s.scoreCorrect).length, scores.length)}  <- sub-gate, floor ${(floors.scoreFidelityFloor * 100).toFixed(0)}% — the CLI's qsofa_score, stated exactly`,
  )
  console.log(`failed runs  ${failedRuns}`)

  /**
   * The comparison the whole task exists for, printed unconditionally.
   *
   * The rule arm is 100% by construction — it IS the answer key — and saying so plainly is the
   * point rather than a caveat on it: it costs no tokens, no server and no weights, so a model
   * that merely matches it has not earned its place in the product. The narration column is what
   * the model has that the CLI does not, and it is the only column where the rule scores zero.
   */
  const bench = samples.length ? summarizeBench(samples) : undefined
  console.log(`\nwhat the model bought over the rule it is graded against:`)
  console.log(`  rule arm     100% agreement by construction, 0 tokens, no server — it is the answer key`)
  console.log(
    `  model arm    ${pct(scores.filter((s) => s.screenAgrees).length, scores.length)} agreement` +
      (bench ? `, ${(bench.wall.totalMs / 1000).toFixed(1)}s of wall clock` : ''),
  )
  console.log(`  narration    the model's screen_reason and criteria are reported, never gated — no answer key here can grade a sentence`)

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
    task: 'sepsis',
    harness: HARNESS_VERSION,
    model: served,
    identified: identity.identified,
    constrained: o.constrain,
    contracts: o.pack.digest(),
    rule,
    medprotocol: { version: medprotocolVersion, command: mp.command },
    totals: t,
    failedRuns,
    bench,
    benchSamples: samples,
    stability,
    cachePrompt,
    floors,
    gates,
    measured,
    pass: measured && t.screenAgreement >= floors.screenAgreementFloor && gates.every((g) => g.measured && g.score >= g.floor),
  })

  return {
    task: 'sepsis',
    score: t.screenAgreement,
    floor: floors.screenAgreementFloor,
    measured,
    gates,
    summary:
      `screen ${pct(scores.filter((s) => s.screenAgrees).length, scores.length)} ` +
      `(floor ${(floors.screenAgreementFloor * 100).toFixed(0)}%, vs a rule arm that is 100% by construction) · ` +
      `echo ${(t.echoFidelity * 100).toFixed(0)}% · criteria ${(t.criteriaFidelity * 100).toFixed(0)}% · score ${(t.scoreFidelity * 100).toFixed(0)}%` +
      (failedRuns ? ` · ${failedRuns} failed runs` : ''),
    bench,
  }
}

/** The corpus, for `--case` and for anything that wants to name a payload. */
export const sepsisDocumentNames = (pack: Pack): string[] =>
  loadSepsisCases(pack, loadMedprotocolRule(pack)).cases.map((c: SepsisCase) => c.name)