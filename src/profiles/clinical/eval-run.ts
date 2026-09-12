/**
 * The parts every rule-borne task eval does identically.
 *
 * `shock-eval.ts` and `sepsis-eval.ts` were the same program twice: after renaming the
 * syndrome, `diff` reported 200 changed lines out of 761. The three quarters that did not
 * change are here. What stayed in each eval is what actually differs between the two — the
 * contract, the answer key, the scoring, and the prose that explains what the number means.
 *
 * WHY HELPERS AND NOT A TEMPLATE METHOD. The obvious shape is `runTaskEval(spec)` with the
 * loop inverted into a dozen callbacks. It was tried and it is worse: the head and tail of
 * these files are mechanical and identical, but the MIDDLE — which misses to accuse, which
 * columns to print, which fields to put in the case record — is bespoke prose in every task,
 * and the callback version turns deliberate output into template soup nobody can read at the
 * point where it is decided. The duplication that actually drifts is mechanical (the bench
 * reduce, the identity preamble, the parse-failure branch, the cost/stability trailer), and
 * that is exactly what this file takes.
 */
import type { Pack } from '../../core/pack.ts'
import type { Trace } from '../../core/trace.ts'
import { identifyServer, UNIDENTIFIED, type ServerIdentity } from '../../core/client.ts'
import { formatBench, type BenchSample, type BenchSummary } from '../../core/bench.ts'
import { formatStability, type Observation, type StabilitySummary } from '../../core/stability.ts'
import { HARNESS_VERSION } from '../../core/version.ts'
import type { ExtractOutcome } from '../../modes/extract.ts'
import { DIFFICULTY_MAX, DIFFICULTY_MIN, parseDifficultyRange } from './cases.ts'
import type { TaskRequest } from './contracts.ts'

/**
 * A percentage, or `n/a` when the denominator was zero. Never `(0/0) -> 100%`.
 *
 * NOT the `pct` in `scorer.ts`, which pads both halves to a fixed width and prints a bare
 * `n/a` — that one lines up the vital-signs miss table and this one reads inside a sentence.
 * Two formatters with one name in one directory is how the copies here got made; they are
 * distinguished by import site rather than merged, because merging them would re-align a
 * table that is aligned on purpose.
 */
export const pct = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(0)}% (${n}/${d})` : `n/a (0/0)`)

/** What every task eval is handed, whatever it grades. */
export interface EvalRunOptions {
  pack: Pack
  baseUrl?: string
  trace: Trace
  constrain: boolean
  runs?: number
  difficulty?: string
  identity?: ServerIdentity
  cachePrompt?: boolean
}

/**
 * One attempt's cost, as a bench sample — or nothing, when the attempt never reached a
 * server to cost anything.
 *
 * `lostMs` is added to the wall clock and no other field, deliberately: a request that failed
 * generated no tokens, so folding it into the token counts would drag throughput down with an
 * attempt that produced none, while dropping its wall clock would report a run as faster than
 * the caller waited. See `ExtractOutcome.cost`.
 */
export const costOf = (
  outcome: Pick<ExtractOutcome<unknown>, 'cost' | 'attempts' | 'lostMs'>,
): Omit<BenchSample, 'case'> => ({
  // Completions AND the attempts that produced none. A first attempt lost at transport is
  // time the caller waited, and it used to appear in neither number.
  wallMs: outcome.cost.reduce((n, a) => n + a.wallMs, 0) + outcome.lostMs,
  attempts: outcome.attempts,
  promptTokens: outcome.cost.reduce((n, a) => n + (a.timings?.promptTokens ?? 0), 0),
  promptMs: outcome.cost.reduce((n, a) => n + (a.timings?.promptMs ?? 0), 0),
  predictedTokens: outcome.cost.reduce((n, a) => n + (a.timings?.predictedTokens ?? 0), 0),
  predictedMs: outcome.cost.reduce((n, a) => n + (a.timings?.predictedMs ?? 0), 0),
  cachedTokens: outcome.cost.reduce((n, a) => n + (a.timings?.cachedTokens ?? 0), 0),
})

/**
 * The same cost, named after the case that paid it — or nothing, when the attempt never
 * reached a server to cost anything.
 *
 * Split from `costOf` because a MULTI-STAGE task sums two of these into one sample and has no
 * per-stage case name to give; `shock-pipeline-eval.ts` is that caller.
 */
export const benchSampleOf = (
  name: string,
  outcome: Pick<ExtractOutcome<unknown>, 'cost' | 'attempts' | 'lostMs'>,
): BenchSample | undefined => (outcome.cost.length ? { case: name, ...costOf(outcome) } : undefined)

export interface EvalScope<C> {
  /** The cases this run grades, after `--difficulty`. */
  cases: C[]
  runs: number
  cachePrompt: boolean
  identity: ServerIdentity
  /** `identity.model`, or `UNIDENTIFIED` — never an empty field. */
  served: string
  /** One phrase naming what was graded, for the header line. */
  scope: string
}

/**
 * Everything a run needs to decide before it calls anything: which cases, how many times,
 * against which server.
 *
 * The difficulty filter is applied HERE rather than in each pack loader, so a loader's
 * checks — every expectation reconciled against the rule, both kinds of case present — run
 * over the WHOLE corpus even when a run grades four payloads of it.
 */
export const evalScope = async <C extends { difficulty: number }>(
  o: EvalRunOptions,
  allCases: C[],
  unit: string,
): Promise<EvalScope<C>> => {
  const inScope = o.difficulty ? parseDifficultyRange(o.difficulty) : () => true
  const cases = allCases.filter((c) => inScope(c.difficulty))
  if (!cases.length) throw new Error(`no cases at difficulty '${o.difficulty}' in pack '${o.pack.name}'`)
  // Asked once per run, and only when the caller has not already asked. `runEval` in
  // `profile.ts` asks ONCE for a whole `--task all` sweep and hands the answer down: seven
  // tasks asking the same server the same two questions is seven round-trips for one answer
  // and seven chances to disagree about what the run was measured against.
  const identity = o.identity ?? (await identifyServer(o.baseUrl))
  return {
    cases,
    runs: Math.max(1, o.runs ?? 1),
    cachePrompt: o.cachePrompt ?? true,
    identity,
    served: identity.model ?? UNIDENTIFIED,
    scope:
      cases.length === allCases.length
        ? `difficulty ${DIFFICULTY_MIN}-${DIFFICULTY_MAX}`
        : `difficulty ${o.difficulty} only — ${cases.length} of ${allCases.length} ${unit}`,
  }
}

/**
 * The conditions a run was measured under, for the trace's opening `run` event.
 *
 * Every field here is something that changes what the numbers below it mean. A result
 * reproduced under a different model, a different pack spec, a different cut-point or a
 * different medprotocol build is a result about a different contract, and this record is what
 * would say so.
 */
export const runConditions = (
  o: EvalRunOptions,
  s: EvalScope<unknown>,
  req: TaskRequest,
  extra: {
    task: string
    corpusCases: number
    rule: unknown
    medprotocol: { version: string; command: string[] }
    floors: Record<string, unknown>
  },
): Record<string, unknown> => ({
  harness: HARNESS_VERSION,
  model: s.served,
  declared: o.pack.toml<{ generation?: { id?: string } }>('models').generation?.id,
  baseUrl: o.baseUrl,
  constrained: o.constrain,
  sampling: req.sampling,
  pack: { name: o.pack.name, spec: o.pack.spec },
  task: extra.task,
  cases: s.cases.length,
  corpusCases: extra.corpusCases,
  difficulty: o.difficulty ?? `${DIFFICULTY_MIN}-${DIFFICULTY_MAX}`,
  runs: s.runs,
  cachePrompt: s.cachePrompt,
  identified: s.identity.identified,
  identityWarning: s.identity.warning,
  rule: extra.rule,
  medprotocol: extra.medprotocol,
  floors: extra.floors,
})

/**
 * The three lines above the per-case table: what was graded, under what, and what the number
 * below is not.
 *
 * `caveat` is passed as finished text, newlines and all, rather than as a sentence this
 * function wraps. Each of these tasks prints a percentage next to a word — "shock", "sepsis"
 * — that will be quoted by somebody who did not read the case file, and the exact wording and
 * placement of the disclaimer is the task's own decision, not a formatting default.
 */
export const announceRun = (
  o: EvalRunOptions,
  s: EvalScope<unknown>,
  req: TaskRequest,
  head: { title: string; unit: string; caveat: string },
): void => {
  if (!o.identity && s.identity.warning) console.error(`\nwarning: ${s.identity.warning}`)
  console.log(`\n=== ${head.title} — ${s.cases.length} ${head.unit}, ${s.scope} ===`)
  console.log(
    `model '${s.served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
      `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
      `temp ${req.sampling.temperature} · max_tokens ${req.sampling.max_tokens}${s.runs > 1 ? ` · ${s.runs} runs` : ''}`,
  )
  console.log(head.caveat)
}

/**
 * A reply that never parsed: recorded everywhere, scored nowhere.
 *
 * It contributes NO score, and the caller's `failedRuns` carries it into the gate through
 * `measured` instead. A run where every completion was fenced would otherwise report 0%
 * agreement, which reads as a model that cannot reason when it is a model whose output was
 * never read.
 *
 * The accumulators are mutated rather than returned because the caller owns them and there is
 * exactly one call site per eval; handing back four arrays to spread would be ceremony around
 * the same mutation.
 */
export const recordParseFailure = (
  into: { misses: string[]; observations: Observation[]; trace: Trace },
  what: {
    task: string
    case: { name: string; class: string; difficulty: number }
    run: number
    outcome: Pick<ExtractOutcome<unknown>, 'raw' | 'error'>
    sample?: BenchSample
    expected: unknown
  },
): void => {
  const { case: c, outcome } = what
  into.misses.push(`parse         ${c.name} — ${outcome.error?.slice(0, 90) ?? 'unknown'}`)
  into.observations.push({
    case: c.name,
    run: what.run,
    completion: outcome.raw ?? `(no completion: ${outcome.error ?? 'unknown'})`,
    score: 'FAILED',
  })
  into.trace.write({
    event: 'case',
    task: what.task,
    case: c.name,
    class: c.class,
    difficulty: c.difficulty,
    run: what.run,
    ok: false,
    error: outcome.error,
    expected: what.expected,
    cost: what.sample,
    completion: outcome.raw,
  })
  console.log(`${c.name.padEnd(30)} ${c.class.padEnd(15)} d${c.difficulty}  FAILED: ${outcome.error?.slice(0, 60)}`)
}

/**
 * What it cost, what repeated, what went wrong — the trailer under every task's own numbers.
 *
 * Each section is printed only when it has something to say: no bench without a completion to
 * time, no stability without a repeat to compare, no miss list when nothing missed. A heading
 * over an empty section reads as a section that found nothing wrong, which is a different
 * claim from one that was never run.
 */
export const reportTrailer = (t: {
  bench?: BenchSummary
  identity: ServerIdentity
  stability: StabilitySummary
  runs: number
  misses: string[]
}): void => {
  if (t.bench) {
    console.log(`\nwhat it cost:`)
    for (const line of formatBench(t.bench, t.identity.props)) console.log(`  ${line}`)
  }
  if (t.runs > 1) {
    console.log(`\nwhat repeated (${t.runs} runs per case):`)
    for (const line of formatStability(t.stability)) console.log(`  ${line}`)
  }
  if (t.misses.length) {
    console.log(`\nwhat went wrong (${t.misses.length}):`)
    for (const m of t.misses) console.log(`  ${m}`)
  }
}

/**
 * The rule arm beside the model arm, which is the comparison these tasks exist for.
 *
 * Printed unconditionally and with the rule's 100% stated plainly rather than footnoted: the
 * rule IS the answer key, it costs no tokens, no server and no weights, so a model that merely
 * matches it has not earned its place in the product. `narration` is the one column where the
 * rule scores zero, and the task supplies its own line for it because what the model narrates
 * — a decline reason, a criteria list — differs by contract.
 */
export const reportRuleArm = (r: { agreement: string; bench?: BenchSummary; narration: string[] }): void => {
  console.log(`\nwhat the model bought over the rule it is graded against:`)
  console.log(`  rule arm     100% agreement by construction, 0 tokens, no server — it is the answer key`)
  console.log(`  model arm    ${r.agreement} agreement` + (r.bench ? `, ${(r.bench.wall.totalMs / 1000).toFixed(1)}s of wall clock` : ''))
  for (const line of r.narration) console.log(line)
}
