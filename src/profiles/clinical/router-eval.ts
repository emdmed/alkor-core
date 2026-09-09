/**
 * Clinical internal-router confusion-matrix eval.
 *
 * Runs WITHOUT a model call — rule-based routing is deterministic and costs only CPU time —
 * so it can be run on every commit, in CI, and expanded to hundreds of cases without budget
 * constraint.
 *
 * The corpus is synthetic and deliberately adversarial: cases where dictation markers appear
 * in notes, where vitals abbreviations appear in transcripts, and where the boundary between
 * two shapes is genuinely fuzzy. A router that only tests the happy path will miss the
 * expensive mistakes.
 */

import { routeClinicalShape, taskForShape } from './clinical-router.ts'
import type { ClinicalShape } from './contracts.ts'
import type { EvalContext, EvalVerdict } from '../../core/profile.ts'

export interface RouterCase {
  input: string
  expectedShape: ClinicalShape
  expectedTask: string
  difficulty: 1 | 2 | 3
  /** Human-readable description of what this case discriminates. */
  discriminates: string
}

export const CLINICAL_ROUTER_CASES: RouterCase[] = [
  // --- Difficulty 1: unambiguous shape matches ---
  ...Array.from({ length: 10 }, (_, i) => ({
    input: JSON.stringify({
      systolic_bp: 80 + i,
      heart_rate: 60 + i,
      capillary_refill: 'delayed',
      skin_appearance: 'pale',
    }),
    expectedShape: 'exam-json' as ClinicalShape,
    expectedTask: 'shock',
    difficulty: 1 as 1 | 2 | 3,
    discriminates: 'shock exam JSON payload',
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    input: `Doctor: How are you feeling today?\nPatient: I have chest pain and shortness of breath.\nDoctor: When did it start?\nPatient: About two hours ago, case ${i}.`,
    expectedShape: 'dialogue' as ClinicalShape,
    expectedTask: 'transcript',
    difficulty: 1 as 1 | 2 | 3,
    discriminates: 'two-speaker dialogue transcript',
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    input: `Dictation: Patient reports chest pain radiating to the left arm. Associated symptoms include sweating and nausea. Case ${i}.`,
    expectedShape: 'dictation' as ClinicalShape,
    expectedTask: 'transcript',
    difficulty: 1 as 1 | 2 | 3,
    discriminates: 'dictated monologue transcript',
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    input: `Patient BP ${120 + i}/${80 + i} mmHg, HR ${70 + i} bpm, SpO2 98% on room air, temperature 37.0 C.`,
    expectedShape: 'vitals-note' as ClinicalShape,
    expectedTask: 'vital-signs',
    difficulty: 1 as 1 | 2 | 3,
    discriminates: 'vitals abbreviations in clinical prose',
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    input: `Patient admitted for chest pain. Treated with aspirin and discharged with follow-up in one week. Case ${i}.`,
    expectedShape: 'note' as ClinicalShape,
    expectedTask: 'vital-signs',
    difficulty: 1 as 1 | 2 | 3,
    discriminates: 'clinical prose without vitals abbreviations',
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    input: `Patient hypotensive for ${30 + i} minutes, BP ${78 + i}/${40 + i}, heart rate ${110 + i} bpm, cool peripheries, delayed capillary refill.`,
    expectedShape: 'shock-suspicion' as ClinicalShape,
    expectedTask: 'shock-extraction',
    difficulty: 1 as 1 | 2 | 3,
    discriminates: 'shock suspicion criteria in clinical prose',
  })),

  ...Array.from({ length: 10 }, (_, i) => ({
    input: JSON.stringify({
      respiratory_rate: 18 + (i % 9),
      systolic_bp: 90 + (i % 11),
      gcs: 13 + (i % 3),
    }),
    expectedShape: 'qsofa-json' as ClinicalShape,
    expectedTask: 'sepsis',
    difficulty: 1 as 1 | 2 | 3,
    discriminates: 'qSOFA payload JSON',
  })),

  // --- Difficulty 2: competing markers, one dominates ---
  ...Array.from({ length: 5 }, (_, i) => ({
    input: `Dictation: BP ${130 + i}/${85 + i}, HR ${75 + i}. Patient also reports dizziness.`,
    expectedShape: 'dictation' as ClinicalShape,
    expectedTask: 'transcript',
    difficulty: 2 as 1 | 2 | 3,
    discriminates: 'dictation marker with vitals (dictation wins)',
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    input: `Doctor: BP ${140 + i}/${90 + i}.\nPatient: HR feels fast, maybe ${100 + i}.\nDoctor: Any other symptoms?`,
    expectedShape: 'dialogue' as ClinicalShape,
    expectedTask: 'transcript',
    difficulty: 2 as 1 | 2 | 3,
    discriminates: 'dialogue with vitals (dialogue wins)',
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    input: `Patient BP ${80 + i}/${50 + i}, HR ${115 + i} bpm, hypotensive, tachycardic, oliguria.`,
    expectedShape: 'shock-suspicion' as ClinicalShape,
    expectedTask: 'shock-extraction',
    difficulty: 2 as 1 | 2 | 3,
    discriminates: 'shock-suspicion with vitals abbreviations (shock-suspicion wins)',
  })),

  // --- Difficulty 3: ambiguous, one vital sign only ---
  ...Array.from({ length: 5 }, (_, i) => ({
    input: `Patient admitted with chest pain. BP ${150 + i}/${95 + i} noted on admission. No other vitals recorded.`,
    expectedShape: 'note' as ClinicalShape,
    expectedTask: 'vital-signs',
    difficulty: 3 as 1 | 2 | 3,
    discriminates: 'clinical prose with only one vital sign (falls through to note -> vital-signs)',
  })),
]

export interface ClassMetrics {
  tp: number
  fp: number
  fn: number
  precision: number
  recall: number
  f1: number
}

export interface RouterEvalResult {
  total: number
  correct: number
  accuracy: number
  /** Per-shape confusion matrix and derived metrics. */
  perClass: Map<string, ClassMetrics>
  /** Per-difficulty accuracy: difficulty -> { correct, total, accuracy }. */
  perDifficulty: Map<number, { correct: number; total: number; accuracy: number }>
  /** Raw confusion matrix: actual -> predicted -> count. */
  confusion: Map<string, Map<string, number>>
  /** Every case result, in order. */
  cases: RouterCaseResult[]
}

export interface RouterCaseResult {
  input: string
  expectedShape: ClinicalShape
  expectedTask: string
  predictedShape: ClinicalShape
  predictedTask: string
  correct: boolean
  difficulty: number
  confidence: number
  reason: string
}

export const runClinicalRouterEval = (): RouterEvalResult => {
  const cases: RouterCaseResult[] = []
  const confusion = new Map<string, Map<string, number>>()
  const perClass = new Map<string, { tp: number; fp: number; fn: number }>()
  const perDifficulty = new Map<number, { correct: number; total: number }>()

  for (const testCase of CLINICAL_ROUTER_CASES) {
    const result = routeClinicalShape(testCase.input)

    const correct = result.shape === testCase.expectedShape && result.task === testCase.expectedTask
    cases.push({
      input: testCase.input,
      expectedShape: testCase.expectedShape,
      expectedTask: testCase.expectedTask,
      predictedShape: result.shape,
      predictedTask: result.task,
      correct,
      difficulty: testCase.difficulty,
      confidence: result.confidence,
      reason: result.reason,
    })

    // Confusion matrix by shape
    if (!confusion.has(testCase.expectedShape)) confusion.set(testCase.expectedShape, new Map())
    const expectedMap = confusion.get(testCase.expectedShape)!
    expectedMap.set(result.shape, (expectedMap.get(result.shape) ?? 0) + 1)

    // Per-class metrics by shape
    if (!perClass.has(testCase.expectedShape)) perClass.set(testCase.expectedShape, { tp: 0, fp: 0, fn: 0 })
    const actualMetrics = perClass.get(testCase.expectedShape)!
    if (correct) actualMetrics.tp++
    else actualMetrics.fn++

    if (!correct) {
      if (!perClass.has(result.shape)) perClass.set(result.shape, { tp: 0, fp: 0, fn: 0 })
      perClass.get(result.shape)!.fp++
    }

    // Per-difficulty
    if (!perDifficulty.has(testCase.difficulty)) perDifficulty.set(testCase.difficulty, { correct: 0, total: 0 })
    const diff = perDifficulty.get(testCase.difficulty)!
    diff.total++
    if (correct) diff.correct++
  }

  const total = CLINICAL_ROUTER_CASES.length
  const correct = cases.filter((c) => c.correct).length

  // Compute derived metrics per class
  const perClassMetrics = new Map<string, ClassMetrics>()
  for (const [cls, m] of perClass) {
    const precision = m.tp + m.fp > 0 ? m.tp / (m.tp + m.fp) : 0
    const recall = m.tp + m.fn > 0 ? m.tp / (m.tp + m.fn) : 0
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
    perClassMetrics.set(cls, { tp: m.tp, fp: m.fp, fn: m.fn, precision, recall, f1 })
  }

  // Compute per-difficulty accuracy
  const perDifficultyAccuracy = new Map<number, { correct: number; total: number; accuracy: number }>()
  for (const [diff, m] of perDifficulty) {
    perDifficultyAccuracy.set(diff, { correct: m.correct, total: m.total, accuracy: m.total > 0 ? m.correct / m.total : 0 })
  }

  return {
    total,
    correct,
    accuracy: total > 0 ? correct / total : 0,
    perClass: perClassMetrics,
    perDifficulty: perDifficultyAccuracy,
    confusion,
    cases,
  }
}

export const formatClinicalRouterEval = (r: RouterEvalResult): string => {
  const lines: string[] = []
  lines.push(`=== clinical router confusion matrix · ${r.total} cases ===`)
  lines.push(`overall accuracy: ${(r.accuracy * 100).toFixed(1)}% (${r.correct}/${r.total})`)
  lines.push('')

  // Per-difficulty
  lines.push('per-difficulty:')
  for (const [diff, m] of [...r.perDifficulty.entries()].sort(([a], [b]) => a - b)) {
    const marker = m.accuracy >= (diff >= 3 ? 0.85 : 0.95) ? '✓' : '✗'
    lines.push(`  d${diff}: ${(m.accuracy * 100).toFixed(1)}% (${m.correct}/${m.total}) ${marker}`)
  }
  lines.push('')

  // Per-class metrics
  lines.push('per-shape:')
  for (const [cls, m] of [...r.perClass.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const prec = (m.precision * 100).toFixed(1)
    const rec = (m.recall * 100).toFixed(1)
    const f1 = (m.f1 * 100).toFixed(1)
    const pMarker = m.precision >= 0.9 ? '✓' : '✗'
    const rMarker = m.recall >= 0.9 ? '✓' : '✗'
    lines.push(`  ${cls.padEnd(14)} precision ${prec}% ${pMarker}  recall ${rec}% ${rMarker}  f1 ${f1}%  (tp ${m.tp}, fp ${m.fp}, fn ${m.fn})`)
  }
  lines.push('')

  // Confusion matrix
  lines.push('confusion matrix (expected → predicted):')
  const allShapes = [...new Set([...r.perClass.keys(), ...r.cases.map((c) => c.predictedShape)])].sort()
  lines.push('  ' + 'expected\\pred'.padEnd(16) + allShapes.map((c) => c.padStart(14)).join(''))
  for (const expected of allShapes) {
    const row = r.confusion.get(expected) ?? new Map()
    const counts = allShapes.map((pred) => String(row.get(pred) ?? 0).padStart(14))
    lines.push('  ' + expected.padEnd(16) + counts.join(''))
  }
  lines.push('')

  // Failure cases
  const failures = r.cases.filter((c) => !c.correct)
  if (failures.length) {
    lines.push('failures:')
    for (const f of failures) {
      const short = f.input.slice(0, 60) + (f.input.length > 60 ? '…' : '')
      lines.push(
        `  [d${f.difficulty}] "${short}" → ${f.predictedShape}/${f.predictedTask} (expected ${f.expectedShape}/${f.expectedTask}) [${f.reason}]`,
      )
    }
  }

  return lines.join('\n')
}

export const gateClinicalRouterEval = (r: RouterEvalResult): { pass: boolean; summary: string } => {
  const overallPass = r.accuracy >= 0.95
  const perClassPass = [...r.perClass.values()].every((m) => m.precision >= 0.9 && m.recall >= 0.9)
  const hardPass = (r.perDifficulty.get(3)?.accuracy ?? 1) >= 0.85

  const pass = overallPass && perClassPass && hardPass
  const parts: string[] = []
  parts.push(`accuracy ${(r.accuracy * 100).toFixed(1)}% vs floor 95% ${overallPass ? '✓' : '✗'}`)
  parts.push(`per-shape precision ≥ 90% ${perClassPass ? '✓' : '✗'}`)
  parts.push(`per-shape recall ≥ 90% ${perClassPass ? '✓' : '✗'}`)
  parts.push(`d3 accuracy ≥ 85% ${hardPass ? '✓' : '✗'}`)

  return { pass, summary: parts.join(' · ') }
}

export const runClinicalRouterEvalFromContext = async (ctx: EvalContext): Promise<EvalVerdict> => {
  const result = runClinicalRouterEval()
  console.log(formatClinicalRouterEval(result))
  const verdict = gateClinicalRouterEval(result)

  return {
    pass: verdict.pass,
    summary: verdict.summary,
  }
}
