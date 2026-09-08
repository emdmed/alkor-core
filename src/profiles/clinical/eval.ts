/**
 * The clinical profile's eval: one constrained pass per note, one gate.
 *
 * Everything domain-specific comes from the pack — the prompt, the schema, the cases, the
 * sampling and the floor. The harness supplied the transport, the mode and the trace. That
 * separation is what makes the same command meaningful against somebody else's contracts.
 *
 * The run is deliberately sequential rather than concurrent. `cache_prompt` reuses the KV
 * cache of the system prompt across notes, which is worth more than parallelism on a
 * single-slot server, and interleaved traces from a parallel run are much harder to read
 * when a case fails.
 */
import type { Pack } from '../../core/pack.ts'
import type { Trace } from '../../core/trace.ts'
import type { Provider } from '../../core/client.ts'
import { identifyServer, UNIDENTIFIED, type ServerIdentity } from '../../core/client.ts'
import { formatBench, summarizeBench, type BenchSample, type BenchSummary } from '../../core/bench.ts'
import { formatStability, summarizeStability, type Observation, type StabilitySummary } from '../../core/stability.ts'
import { HARNESS_VERSION } from '../../core/version.ts'
import { extract } from '../../modes/extract.ts'
import { loadSettings } from './settings.ts'
import { DIFFICULTY_MAX, DIFFICULTY_MIN, gradedExpectations, loadVitalCases, parseDifficultyRange } from './cases.ts'
import { vitalRequest } from './contracts.ts'
import { parseVitalSigns } from './extraction.ts'
import { absorb, emptyTally, pct, ratio, scoreCase, scoreFailure, type Miss, type VitalTally } from './scorer.ts'

export interface VitalEvalResult {
  tally: VitalTally
  misses: Miss[]
  floor: number
  recall: number
  /**
   * The two sub-gates, with the floors the pack declared for them. Reported here rather than
   * folded into `recall` because the profile gates on each separately: detection is the
   * headline, and a model that finds every reading and transcribes a fifth of them wrong has
   * not passed.
   */
  valueFloor: number
  valueRate: number
  unitFloor: number
  unitRate: number
  /**
   * What a repeated run bought: which cases returned a different answer, and which of those
   * flipped a grade. Meaningful only above one run, and it says so rather than reporting a
   * reassuring 100% for a question nobody asked.
   */
  stability: StabilitySummary
  cases: number
  /** Detection per difficulty tier, keyed by rating. Reported, never gated. */
  byDifficulty: Map<number, VitalTally>
  /**
   * What the run cost. Absent when the server reported no `timings` at all — a gap says
   * "not measured", where zeros would aggregate into a throughput figure that looks
   * measured and is not.
   */
  bench?: BenchSummary
}

export interface VitalEvalOptions {
  pack: Pack
  baseUrl?: string
  trace: Trace
  constrain: boolean
  /** Run each case N times. Above 1 only means something off temperature 0. */
  runs?: number
  /**
   * `N` or `N-M`: grade only the notes in that difficulty tier. A scoped run is for
   * iterating on the hard end without paying for the whole corpus every time — the number
   * it produces describes that tier and NOT the contract, which is why the header and the
   * trace both say which tiers were graded.
   */
  difficulty?: string
  /**
   * Who is serving, resolved once for the whole run. Absent means resolve it here, which is
   * what a caller running this eval on its own does.
   */
  identity?: ServerIdentity
  /**
   * Let the server reuse the KV cache of the shared system prompt across notes. On by default,
   * because it is worth 60-88% of prefill on this corpus and the sequential run is arranged
   * around it.
   *
   * Turn it OFF to buy reproducibility with that time. Prefix reuse is exactly why the same
   * bytes can come back differently: a different set of preceding notes leaves a different KV
   * prefix, which changes how the batch is split, which changes the last bits of the logits,
   * which flips a near-tied argmax. This harness has MEASURED that — one capital letter, and
   * under a case-sensitive quote rule that is a verified span against a fabricated one. A run
   * with the cache off is slower and can be compared with another run byte for byte.
   */
  cachePrompt?: boolean
  provider?: Provider
}

export const runVitalSignsEval = async (o: VitalEvalOptions): Promise<VitalEvalResult> => {
  // The same assembly the interactive path runs. Two callers building their own prompt,
  // schema and cap is how a measured path and a used path drift by a line.
  const req = vitalRequest(o.pack, o.constrain)
  const { fields, sampling } = req
  const { fieldRecallFloor, valueFloor, unitFloor, cases: allCases } = loadVitalCases(o.pack, fields)
  // The pack's quote rule, the same one note formatting verifies under. Read here rather
  // than assumed in the scorer: a rule the pack declares and a task ignores is a rule that
  // ships unverified, which is the arrangement this pack exists to demonstrate.
  const quoteRule = loadSettings(o.pack).quoteVerification

  // Filtering here rather than inside the loader keeps the pack's own consistency checks —
  // every slot accounted for, every difficulty rated — running over the WHOLE case file
  // even when a run grades four notes of it.
  const inScope = o.difficulty ? parseDifficultyRange(o.difficulty) : () => true
  const cases = allCases.filter((c) => inScope(c.difficulty))
  if (!cases.length) throw new Error(`no cases at difficulty '${o.difficulty}' in pack '${o.pack.name}'`)

  const total = emptyTally()
  /** Detection by tier. The point of rating the notes: one aggregate says a model works,
   * the same runs split by tier say where it stops working. */
  const byTier = new Map<number, VitalTally>()
  /** One entry per case-run that produced a completion. See core/bench.ts. */
  const samples: BenchSample[] = []
  /**
   * One entry per case-run, for the stability report. Collected unconditionally and reported
   * only above one run: the cost is a string per case and the alternative is a flag that has
   * to be remembered before the run rather than after it.
   */
  const observations: Observation[] = []
  const misses: Miss[] = []
  const runs = Math.max(1, o.runs ?? 1)
  const cachePrompt = o.cachePrompt ?? true

  // Ask the server what it is serving rather than reporting what the pack declares. The
  // two differ the moment anyone points --url at a second model, and a result that names
  // the wrong weights is worse than one that names none. Resolved by the caller when there
  // is one, so three tasks in one run agree about what they measured.
  const identity = o.identity ?? (await identifyServer(o.baseUrl))
  const served = identity.model ?? UNIDENTIFIED
  // The flags a SPEED is only valid under, from the same source and for the same reason.
  const benchConditions = identity.props
  const conditions = {
    harness: HARNESS_VERSION,
    model: served,
    declared: o.pack.toml<{ generation?: { id?: string } }>('models').generation?.id,
    baseUrl: o.baseUrl,
    constrained: o.constrain,
    sampling,
    pack: { name: o.pack.name, spec: o.pack.spec },
    cases: cases.length,
    gradedSlots: gradedExpectations(cases),
    // Which tiers this number covers. A saved result that does not say so is a percentage
    // of an unknown corpus, and the whole file exists so nothing has to be taken on faith.
    difficulty: o.difficulty ?? `${DIFFICULTY_MIN}-${DIFFICULTY_MAX}`,
    corpusCases: allCases.length,
    runs,
    cachePrompt,
    benchConditions,
    /**
     * Whether this run can name what produced it.
     *
     * `false` means the server would not say which weights it was serving, so the numbers
     * below describe a model nobody can identify. The flag is here rather than left implicit
     * in `model === '(server did not say)'` so a consumer can REFUSE to quote the run — string
     * matching on a placeholder is how a caveat gets lost the first time the placeholder is
     * reworded.
     */
    identified: identity.identified,
    identityWarning: identity.warning,
  }
  o.trace.write({ event: 'run', ...conditions })
  // Printed by the profile when it resolves the identity for all three tasks; printed here
  // when this eval is called on its own, so neither entry point can produce an unattributable
  // number quietly.
  if (!o.identity && identity.warning) console.error(`\nwarning: ${identity.warning}`)

  const scope =
    cases.length === allCases.length
      ? `difficulty ${DIFFICULTY_MIN}-${DIFFICULTY_MAX}`
      : `difficulty ${o.difficulty} only — ${cases.length} of ${allCases.length} notes`
  console.log(`\n=== Vital signs — ${cases.length} notes, ${gradedExpectations(cases)} graded slots, ${scope} ===`)
  console.log(`model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
    `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
    `temp ${sampling.temperature} · max_tokens ${sampling.max_tokens}${runs > 1 ? ` · ${runs} runs` : ''}\n`)

  for (const c of cases) {
    const note = o.pack.document(c.name)
    for (let run = 0; run < runs; run++) {
      const outcome = await extract({
        systemPrompt: req.prompt,
        document: note,
        parse: (raw) => parseVitalSigns(raw, fields),
        schema: req.schema,
        schemaName: req.schemaName,
        // All three from the pack's declaration, not from a harness default. A number
        // printed in the header and recorded in the trace must be the one that was sent.
        maxTokens: sampling.max_tokens,
        temperature: sampling.temperature,
        timeoutMs: sampling.timeout_secs * 1000,
        baseUrl: o.baseUrl,
        cachePrompt,
        label: 'vital_signs',
        provider: o.provider,
      })

      // Summed over attempts: a case that had to be retried cost the caller both passes.
      // A run whose every attempt failed to reach the server contributes no sample at all,
      // which is why this is guarded rather than pushed unconditionally.
      const sample: BenchSample | undefined = outcome.cost.length
        ? {
            case: c.name,
            // Completions AND the attempts that produced none. A first attempt lost at
            // transport is time the caller waited, and it used to appear in neither number.
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

      const scored = outcome.parsed ? scoreCase(c, outcome.parsed, note, quoteRule) : scoreFailure(c)
      // The completion AND the tally, so a run that repeated its text can be told from a run
      // that repeated its grade. `JSON.stringify` over a tally whose keys are declared in one
      // literal is stable; see VitalTally.
      observations.push({
        case: c.name,
        run,
        completion: outcome.raw ?? `(no completion: ${outcome.error ?? 'unknown'})`,
        score: JSON.stringify(scored.tally),
      })
      absorb(total, scored.tally)
      const tier = byTier.get(c.difficulty) ?? emptyTally()
      absorb(tier, scored.tally)
      byTier.set(c.difficulty, tier)
      misses.push(...scored.misses)

      // The completion itself, not only the tally it produced. A harness whose claim is
      // that nothing has to be taken on faith cannot report 46/46 and keep no record of
      // what the model said — checking a suspiciously perfect score should be reading a
      // file, not re-running the model by hand. What makes this safe to leave on for a pack
      // whose notes are real is the profile's redactor, which elides this field and the two
      // others that quote it unless the pack declares its corpus synthetic; see
      // profiles/clinical/redact.ts. That hook was named here before it existed.
      o.trace.write({
        event: 'case',
        case: c.name,
        class: c.class,
        difficulty: c.difficulty,
        run,
        ok: Boolean(outcome.parsed),
        error: outcome.error,
        tally: scored.tally,
        misses: scored.misses,
        cost: sample,
        completion: outcome.raw,
      })

      const t = scored.tally
      const flag = outcome.parsed ? '' : `  FAILED: ${outcome.error?.slice(0, 80)}`
      console.log(
        `${c.name.padEnd(28)} ${c.class.padEnd(17)} d${c.difficulty} ` +
          `detected ${pct(t.detected, t.gradedTotal)} value ${pct(t.valueExact, t.detected)} ` +
          `unit ${pct(t.unitExact, t.detected)} quote ${pct(t.quoteVerified, t.detected)} ` +
          `halluc ${t.hallucinations}${flag}`,
      )
    }
  }

  const recall = ratio(total.detected, total.gradedTotal)

  console.log(`\n${'—'.repeat(78)}`)
  console.log(`detection   ${pct(total.detected, total.gradedTotal)}  <- the gate, floor ${(fieldRecallFloor * 100).toFixed(0)}%`)
  // Sub-gates as of today. They were printed for months as commentary while detection
  // saturated at every difficulty tier, which meant the number that gated had stopped
  // separating two models the numbers beside it separated clearly.
  const unmeasured = ' — nothing was detected, so this gate cannot pass'
  console.log(
    `value       ${pct(total.valueExact, total.detected)}  <- sub-gate, floor ${(valueFloor * 100).toFixed(0)}% — of what was detected` +
      (total.detected ? '' : unmeasured),
  )
  console.log(
    `unit        ${pct(total.unitExact, total.detected)}  <- sub-gate, floor ${(unitFloor * 100).toFixed(0)}% — of what was detected` +
      (total.detected ? '' : unmeasured),
  )
  console.log(`provenance  ${pct(total.quoteVerified, total.detected)}  raw_text found in the note`)
  console.log(
    `hallucinations ${total.hallucinations}   edited-only quote failures (a capital or an accent) ${total.quotesEditedOnly}   ` +
      `failed runs ${total.failedRuns}`,
  )

  // The breakdown does not gate — the contract ships as one thing, so the floor is one
  // number over the whole corpus. It is printed because an aggregate that passes while the
  // top tier collapses is the result a reader most needs to be shown rather than to derive.
  console.log(`\ndetection by difficulty (the note, not the model — 1 labelled and canonical, 5 the text fights the reader):`)
  for (const tier of [...byTier.keys()].sort((a, b) => a - b)) {
    const t = byTier.get(tier)!
    console.log(
      `  d${tier}  detected ${pct(t.detected, t.gradedTotal)} value ${pct(t.valueExact, t.detected)} ` +
        `unit ${pct(t.unitExact, t.detected)} quote ${pct(t.quoteVerified, t.detected)} halluc ${t.hallucinations}`,
    )
  }

  // Cost, from the graded pass itself rather than from a separate timing run. Printed after
  // the correctness block and never near the gate: a contract that extracts the wrong
  // numbers quickly has not partly succeeded, and a layout that puts tok/s beside a floor
  // invites reading them as two halves of one verdict.
  const bench = samples.length ? summarizeBench(samples) : undefined
  if (bench) {
    console.log(`\nwhat it cost:`)
    for (const line of formatBench(bench, benchConditions)) console.log(`  ${line}`)
  }

  // What a repeated run actually bought. Printed only when there was one: for a single run the
  // honest report is that stability was not measured, and a block saying so on every run would
  // be noise on the 99% of runs that never asked.
  const stability = summarizeStability(observations)
  if (runs > 1) {
    console.log(`\nwhat repeated (${runs} runs per case):`)
    for (const line of formatStability(stability)) console.log(`  ${line}`)
    if (cachePrompt) {
      console.log(
        '  note        cache_prompt is ON, so each case inherits the KV prefix of the ones before it —\n' +
          '              pass --no-cache-prompt for a run two machines can compare byte for byte',
      )
    }
  }

  if (misses.length) {
    console.log(`\nwhat went wrong (${misses.length}):`)
    for (const m of misses) console.log(`  ${m.reason.padEnd(14)} ${m.case} · ${m.field} — ${m.detail}`)
  }

  // Written LAST, because it states which bytes were actually read — every prompt, schema,
  // case file and note the run opened, hashed. With the `run` event at the top of the same
  // trace, a saved result names the harness, the model, the conditions and the contracts,
  // which is the difference between a number that can be reproduced and one that has to be
  // believed.
  o.trace.write({
    event: 'record',
    harness: HARNESS_VERSION,
    model: served,
    // Repeated from the `run` event on purpose. The record is the event a consumer reads to
    // quote a number, and a caveat that lives only in a line 200 above it is a caveat that
    // gets read second.
    identified: identity.identified,
    constrained: o.constrain,
    contracts: o.pack.digest(),
    tally: total,
    byDifficulty: Object.fromEntries([...byTier].sort((a, b) => a[0] - b[0])),
    // The summary AND the per-case samples it came from. A throughput figure whose samples
    // were thrown away is a number that has to be believed rather than checked — the same
    // objection this file raises to a tally kept without its completions.
    bench,
    benchConditions,
    benchSamples: samples,
    // What repeated, and what did not. Recorded even for a single run, where it says exactly
    // that: `runs: 1` and nothing measured. A consumer reading a number out of this file is
    // entitled to know whether asking twice would have produced it again.
    stability,
    cachePrompt,
    floor: fieldRecallFloor,
    recall,
    // The record states every gate, not only the headline one. A consumer reading this file
    // to check a claim should not have to recompute the two floors that can also fail it.
    valueFloor,
    valueRate: ratio(total.valueExact, total.detected),
    unitFloor,
    unitRate: ratio(total.unitExact, total.detected),
    pass:
      recall >= fieldRecallFloor &&
      total.detected > 0 &&
      ratio(total.valueExact, total.detected) >= valueFloor &&
      ratio(total.unitExact, total.detected) >= unitFloor,
  })

  return {
    tally: total,
    misses,
    floor: fieldRecallFloor,
    recall,
    valueFloor,
    valueRate: ratio(total.valueExact, total.detected),
    unitFloor,
    unitRate: ratio(total.unitExact, total.detected),
    stability,
    cases: cases.length,
    byDifficulty: byTier,
    bench,
  }
}
