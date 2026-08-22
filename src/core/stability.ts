/**
 * How much a repeated run MOVES — as opposed to what it averages to.
 *
 * `--runs N` used to mean "grade every case N times and report the mean", and its own docstring
 * admitted that this is near-useless at temperature 0: N identical answers averaged N times is
 * the first answer with more decimal places. The flag looked like a confidence interval and was
 * arithmetic on a constant.
 *
 * It is not a constant, and the harness has measured that. The same note, the same model, the
 * same bytes, scored twice — once inside a 21-note run and once inside a five-note
 * `--difficulty 5` run — returned `"weight 61.4 kg"` and `"Weight 61.4 kg"`. `cache_prompt` is
 * why: a different set of preceding notes leaves a different KV prefix, which changes how the
 * batch is split, which changes the last bits of the logits, which flips a near-tied argmax.
 * Under a case-sensitive quote rule that one capital is the difference between a verified span
 * and a fabricated one, and on the day it was measured it happened to land on the passing side.
 *
 * So this module reports the thing worth reporting: WHICH cases moved, and in what. A mean over
 * runs hides a case that flipped by averaging it with the runs where it did not; a count of
 * distinct answers per case cannot hide it, because two distinct answers is two distinct
 * answers however many times you divide.
 *
 * Nothing here is medical, and nothing here knows what a case is scored on. An observation is a
 * key and two digests, which is the generic shape of "the same question, asked twice".
 */
import { createHash } from 'node:crypto'

/** One case-run: what came back, and what it scored. */
export interface Observation {
  case: string
  run: number
  /**
   * The completion, digested. Two runs that differ HERE and agree on `score` are the
   * interesting quiet case: the model said something different and the grade did not notice,
   * which means the corpus has a slot where it could.
   */
  completion: string
  /**
   * The scored outcome, digested. Callers pass a stable serialisation of the tally rather than
   * the tally, so this module never has to know what a tally is.
   */
  score: string
}

export interface CaseStability {
  case: string
  runs: number
  /** Distinct completions across runs. 1 is a case that reproduced. */
  distinctCompletions: number
  /** Distinct scored outcomes across runs. Above 1 is a case whose GRADE flipped. */
  distinctScores: number
}

export interface StabilitySummary {
  cases: number
  /** The number of runs per case, or 0 when they disagreed — which is itself worth saying. */
  runs: number
  /** Cases whose completion was not byte-identical across runs. */
  variedInText: CaseStability[]
  /** Cases whose SCORE was not identical across runs. A subset of the above, in practice. */
  variedInScore: CaseStability[]
  /** Share of cases that reproduced exactly, in text. The headline number of a repeated run. */
  reproducibleShare: number
}

const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

export const summarizeStability = (observations: Observation[]): StabilitySummary => {
  const byCase = new Map<string, Observation[]>()
  for (const o of observations) byCase.set(o.case, [...(byCase.get(o.case) ?? []), o])

  const per: CaseStability[] = [...byCase.entries()].map(([name, os]) => ({
    case: name,
    runs: os.length,
    distinctCompletions: new Set(os.map((o) => digest(o.completion))).size,
    distinctScores: new Set(os.map((o) => digest(o.score))).size,
  }))

  const runCounts = new Set(per.map((p) => p.runs))
  return {
    cases: per.length,
    // A single number only if every case was asked the same number of times. Reporting a mean
    // run count would be the same mistake this file exists to correct, one level up.
    runs: runCounts.size === 1 ? [...runCounts][0]! : 0,
    variedInText: per.filter((p) => p.distinctCompletions > 1),
    variedInScore: per.filter((p) => p.distinctScores > 1),
    reproducibleShare: per.length ? per.filter((p) => p.distinctCompletions === 1).length / per.length : 1,
  }
}

/**
 * The printed block. Says what reproduced, then names what did not — a list of case names is
 * the only form of this report anyone can act on, because the fix is to go and read those
 * notes.
 */
export const formatStability = (s: StabilitySummary): string[] => {
  if (s.runs === 1) {
    return ['stability   not measured — one run per case says nothing about whether it repeats']
  }
  const lines = [
    `reproduced  ${(s.reproducibleShare * 100).toFixed(0)}% of ${s.cases} cases returned byte-identical text across ` +
      (s.runs ? `${s.runs} runs` : 'their runs'),
  ]
  if (!s.variedInText.length) {
    lines.push('every case repeated exactly — at temperature 0 that is the expected result, not a strong one')
    return lines
  }
  lines.push(
    `varied      ${s.variedInText.length} case(s) did not: ` +
      s.variedInText.map((c) => `${c.case} (${c.distinctCompletions} answers)`).join(', '),
  )
  // The line that decides whether the variation matters. Text that moved and a grade that did
  // not is a corpus that cannot see the movement; a grade that moved is a number that depends
  // on which run you quoted.
  lines.push(
    s.variedInScore.length
      ? `scored      ${s.variedInScore.length} of those flipped a GRADE: ` +
        s.variedInScore.map((c) => `${c.case} (${c.distinctScores} outcomes)`).join(', ') +
        ' — the aggregate above is one draw from that, not a measurement'
      : 'scored      none of the variation changed a grade, so the score reproduced even where the text did not',
  )
  return lines
}
