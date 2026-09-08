/**
 * Router confusion-matrix eval.
 *
 * The router is the gate-keeper of the whole pipeline: routing wrong is the most expensive
 * failure mode because it wastes a GPU load and returns garbage the user sees. This eval
 * runs WITHOUT a model call — rule-based routing is deterministic and costs only CPU time —
 * so it can be run on every commit, in CI, and expanded to hundreds of cases without
 * budget constraint.
 *
 * The corpus is synthetic and deliberately adversarial: cases where medical abbreviations
 * appear in code, where verification keywords appear in clinical notes, and where the
 * boundary between two classes is genuinely fuzzy. A router that only tests the happy path
 * ("BP 120/80" → clinical) will miss the expensive mistakes.
 *
 * Difficulty tiers:
 *   1 — exact keyword match, unambiguous context
 *   2 — keyword match with slight variation or an extra class's keyword present but subordinate
 *   3 — competing keywords from two classes, but one dominates by context
 *   4 — keyword from class A appears in a context that strongly suggests class B
 *   5 — two classes have genuinely overlapping keywords, and the correct route requires
 *       understanding the full sentence rather than a single keyword
 *
 * Gates:
 *   overall accuracy ≥ 95%
 *   per-class recall ≥ 90% (no specialist is starved of its cases)
 *   per-class precision ≥ 90% (no specialist is polluted with wrong cases)
 *   difficulty 4-5 accuracy ≥ 85% (the hard cases are where routing wrong costs most)
 */

import { route, type RouteRule, type RouterOptions } from '../../modes/router.ts'
import type { EvalContext, EvalVerdict } from '../../core/profile.ts'

export interface RouterCase {
  input: string
  expected: string
  difficulty: 1 | 2 | 3 | 4 | 5
  /** Human-readable description of what this case discriminates. */
  discriminates: string
}

export const ROUTER_CASES: RouterCase[] = [
  // --- Difficulty 1: unambiguous keyword matches ---
  { input: 'BP 120/80, HR 72, Temp 37.1', expected: 'clinical', difficulty: 1, discriminates: 'vitals abbreviations in clinical context' },
  { input: 'Blood pressure 140/90, heart rate 88 bpm, oxygen saturation 97%', expected: 'clinical', difficulty: 1, discriminates: 'full vital sign names in clinical context' },
  { input: 'Dictation: patient reports chest pain radiating to left arm', expected: 'transcriptor', difficulty: 1, discriminates: 'explicit dictation marker' },
  { input: 'Verify this extraction: the quote is "BP 120/80"', expected: 'verifier', difficulty: 1, discriminates: 'explicit verification request' },
  { input: 'Please give me a summary of the patient history and medications', expected: 'clinical', difficulty: 1, discriminates: 'summary keyword in medical context' },
  { input: 'Transcribed audio: BP 120 over 80, heart rate 72', expected: 'transcriptor', difficulty: 1, discriminates: 'transcribed marker with vitals' },
  { input: 'Check if this quote is in the document: "HR 72"', expected: 'verifier', difficulty: 1, discriminates: 'check keyword with quote' },
  { input: 'Patient weight 68 kg, height 170 cm, BMI 23.5', expected: 'clinical', difficulty: 1, discriminates: 'anthropometric measurements' },
  { input: 'Audio recording: patient says BP 150 over 90, feels dizzy', expected: 'transcriptor', difficulty: 1, discriminates: 'audio recording marker' },
  { input: 'Validate that the provenance of this quote is correct', expected: 'verifier', difficulty: 1, discriminates: 'validate provenance' },
  { input: 'Discharge summary: patient admitted for chest pain, treated with aspirin', expected: 'clinical', difficulty: 1, discriminates: 'discharge summary' },

  // --- Difficulty 2: keyword match with variation or minor overlap ---
  { input: 'The patient has a BP cuff but no reading taken yet', expected: 'clinical', difficulty: 2, discriminates: 'BP keyword in clinical context without reading' },
  { input: 'Dictation: the blood pressure monitor is broken', expected: 'transcriptor', difficulty: 2, discriminates: 'dictation about equipment, not vitals' },
  { input: 'HR department policy on medical leave', expected: 'clinical', difficulty: 2, discriminates: 'HR abbreviation in non-medical context (but medical is more likely)' },
  { input: 'Speech-to-text: doctor says check vitals before discharge', expected: 'transcriptor', difficulty: 2, discriminates: 'speech-to-text with clinical instruction' },
  { input: 'Patient history: no vital signs recorded, patient is coding', expected: 'clinical', difficulty: 2, discriminates: 'coding keyword in medical emergency context' },

  // --- Difficulty 3: competing keywords, one dominates by context ---
  { input: 'Dictation: fix the blood pressure reading in the chart — it says 120/80 but should be 140/90', expected: 'transcriptor', difficulty: 3, discriminates: 'dictation with correction instruction' },
  { input: 'Summary of patient history and list of files in the chart directory', expected: 'clinical', difficulty: 3, discriminates: 'summary + list_files keywords, medical dominates' },
  { input: 'HR is 72 in the patient record, but the HR module in the app shows 0', expected: 'clinical', difficulty: 3, discriminates: 'HR in both medical and code context, medical is primary' },
  { input: 'Audio: the developer says the blood pressure API is returning 500 errors', expected: 'transcriptor', difficulty: 3, discriminates: 'audio about code error, both classes overlap' },
  { input: 'Patient temperature is 38.5, and the temperature sensor is faulty', expected: 'clinical', difficulty: 3, discriminates: 'temperature in both medical and device context' },
  { input: 'Transcription: verify the patient weight is 70 kg before discharge', expected: 'transcriptor', difficulty: 3, discriminates: 'transcription with verification instruction' },
  { input: 'Search for all patients with BP above 140 in the database', expected: 'clinical', difficulty: 3, discriminates: 'search keyword in medical data context' },

  // --- Difficulty 4: keyword from class A appears in strong class B context ---
  { input: 'BP 120/80 in the database schema for the patient table', expected: 'clinical', difficulty: 4, discriminates: 'medical term in data context, but still about patients' },
  { input: 'Dictation: the developer needs to fix the blood pressure monitor bug', expected: 'transcriptor', difficulty: 4, discriminates: 'dictation about code bug' },
  { input: 'Patient says: "I ran npm test and it failed" — document this', expected: 'transcriptor', difficulty: 4, discriminates: 'patient dictation containing code commands' },

  // --- Difficulty 5: genuinely overlapping, requires full sentence understanding ---
  { input: 'Fix the blood pressure: the patient has BP 180/110 and the monitor is not recording', expected: 'clinical', difficulty: 5, discriminates: 'code-like imperative + medical emergency, medical dominates' },
  { input: 'Dictation: run the blood pressure check, then fix the chart, then verify the reading', expected: 'transcriptor', difficulty: 5, discriminates: 'dictation with multiple action verbs' },
  { input: 'The heart rate is 72 bpm and the heart rate service in kubernetes is healthy', expected: 'clinical', difficulty: 5, discriminates: 'medical fact + infrastructure health, medical is primary' },
  { input: 'HR = 72, HR = human resources, HR = high resolution — context needed', expected: 'clinical', difficulty: 5, discriminates: 'multiple HR meanings, no clear context' },
  { input: 'Patient with fever 38.5, and the temperature service is down for maintenance', expected: 'clinical', difficulty: 5, discriminates: 'medical + infrastructure, both significant' },
  { input: 'Verify the extraction: the quote "git commit" is in the patient notes', expected: 'verifier', difficulty: 5, discriminates: 'verification task with code quote in medical notes' },
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
  /** Per-class confusion matrix and derived metrics. */
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
  expected: string
  predicted: string
  correct: boolean
  difficulty: number
  confidence: number
  reason: string
}

/**
 * Run the router eval against a rule set. By default this is pure CPU (rule-based).
 * When a model fallback is provided, ambiguous cases (where no rule matches with
 * confidence 1.0) are sent to the model for classification.
 *
 * @param rules — the rule set to evaluate. Defaults to the compiled-in clinical rules.
 * @param defaultProfile — the fallback profile. Defaults to 'clinical'.
 * @param model — optional model fallback config for ambiguous cases.
 */
export const runRouterEval = async (
  rules: RouteRule[] = ROUTER_CASES[0] ? [] : [], // placeholder to avoid unused, but we use imported rules below
  defaultProfile: string = 'clinical',
  model?: RouterOptions['model'],
): Promise<RouterEvalResult> => {
  // We import the actual rules at call time from the profile, but for this eval
  // we use whatever rules are passed in. The default is the profile's own rules.
  const { ROUTER_RULES } = await import('./profile.ts')
  const effectiveRules = rules.length ? rules : ROUTER_RULES
  const effectiveDefault = defaultProfile

  const cases: RouterCaseResult[] = []
  const confusion = new Map<string, Map<string, number>>()
  const perClass = new Map<string, { tp: number; fp: number; fn: number }>()
  const perDifficulty = new Map<number, { correct: number; total: number }>()

  for (const testCase of ROUTER_CASES) {
    const result = await route({
      input: testCase.input,
      rules: effectiveRules,
      defaultProfile: effectiveDefault,
      model,
    })

    const correct = result.profile === testCase.expected
    cases.push({
      input: testCase.input,
      expected: testCase.expected,
      predicted: result.profile,
      correct,
      difficulty: testCase.difficulty,
      confidence: result.confidence,
      reason: result.reason,
    })

  // Confusion matrix
  if (!confusion.has(testCase.expected)) confusion.set(testCase.expected, new Map())
  const expectedMap = confusion.get(testCase.expected)!
  expectedMap.set(result.profile, (expectedMap.get(result.profile) ?? 0) + 1)

    // Per-class metrics accumulation
    if (!perClass.has(testCase.expected)) perClass.set(testCase.expected, { tp: 0, fp: 0, fn: 0 })
    const actualMetrics = perClass.get(testCase.expected)!
    if (correct) actualMetrics.tp++
    else actualMetrics.fn++

    // False positives: every incorrect prediction is a FP for the predicted class
    if (!correct) {
      if (!perClass.has(result.profile)) perClass.set(result.profile, { tp: 0, fp: 0, fn: 0 })
      perClass.get(result.profile)!.fp++
    }

    // Per-difficulty
    if (!perDifficulty.has(testCase.difficulty)) perDifficulty.set(testCase.difficulty, { correct: 0, total: 0 })
    const diff = perDifficulty.get(testCase.difficulty)!
    diff.total++
    if (correct) diff.correct++
  }

  const total = ROUTER_CASES.length
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

/**
 * Format the router eval result for human reading.
 */
export const formatRouterEval = (r: RouterEvalResult): string => {
  const lines: string[] = []
  lines.push(`=== router confusion matrix · ${r.total} cases ===`)
  lines.push(`overall accuracy: ${(r.accuracy * 100).toFixed(1)}% (${r.correct}/${r.total})`)
  lines.push('')

  // Per-difficulty
  lines.push('per-difficulty:')
  for (const [diff, m] of [...r.perDifficulty.entries()].sort(([a], [b]) => a - b)) {
    const marker = m.accuracy >= (diff >= 4 ? 0.85 : 0.95) ? '✓' : '✗'
    lines.push(`  d${diff}: ${(m.accuracy * 100).toFixed(1)}% (${m.correct}/${m.total}) ${marker}`)
  }
  lines.push('')

  // Per-class metrics
  lines.push('per-class:')
  for (const [cls, m] of [...r.perClass.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const prec = (m.precision * 100).toFixed(1)
    const rec = (m.recall * 100).toFixed(1)
    const f1 = (m.f1 * 100).toFixed(1)
    const pMarker = m.precision >= 0.9 ? '✓' : '✗'
    const rMarker = m.recall >= 0.9 ? '✓' : '✗'
    lines.push(`  ${cls.padEnd(12)} precision ${prec}% ${pMarker}  recall ${rec}% ${rMarker}  f1 ${f1}%  (tp ${m.tp}, fp ${m.fp}, fn ${m.fn})`)
  }
  lines.push('')

  // Confusion matrix
  lines.push('confusion matrix (actual → predicted):')
  const allClasses = [...new Set([...r.perClass.keys(), ...r.cases.map((c) => c.predicted)])].sort()
  lines.push('  ' + 'actual\\pred'.padEnd(14) + allClasses.map((c) => c.padStart(10)).join(''))
  for (const actual of allClasses) {
    const row = r.confusion.get(actual) ?? new Map()
    const counts = allClasses.map((pred) => String(row.get(pred) ?? 0).padStart(10))
    lines.push('  ' + actual.padEnd(14) + counts.join(''))
  }
  lines.push('')

  // Failure cases
  const failures = r.cases.filter((c) => !c.correct)
  if (failures.length) {
    lines.push('failures:')
    for (const f of failures) {
      const short = f.input.slice(0, 60) + (f.input.length > 60 ? '…' : '')
      lines.push(`  [d${f.difficulty}] "${short}" → ${f.predicted} (expected ${f.expected}) [${f.reason}]`)
    }
  }

  return lines.join('\n')
}

/**
 * Gate the router eval result. Returns a verdict and a summary line.
 */
export const gateRouterEval = (r: RouterEvalResult): { pass: boolean; summary: string } => {
  const overallPass = r.accuracy >= 0.95
  const perClassPass = [...r.perClass.values()].every((m) => m.precision >= 0.9 && m.recall >= 0.9)
  const hardPass = (r.perDifficulty.get(4)?.accuracy ?? 1) >= 0.85 && (r.perDifficulty.get(5)?.accuracy ?? 1) >= 0.85

  const pass = overallPass && perClassPass && hardPass
  const parts: string[] = []
  parts.push(`accuracy ${(r.accuracy * 100).toFixed(1)}% vs floor 95% ${overallPass ? '✓' : '✗'}`)
  parts.push(`per-class precision ≥ 90% ${perClassPass ? '✓' : '✗'}`)
  parts.push(`per-class recall ≥ 90% ${perClassPass ? '✓' : '✗'}`)
  parts.push(`d4-5 accuracy ≥ 85% ${hardPass ? '✓' : '✗'}`)

  return { pass, summary: parts.join(' · ') }
}

/**
 * Run the router eval from a profile context. This is the entry point the CLI calls.
 *
 * Model fallback is used when a `baseUrl` is available (from `--url` or profiles.toml)
 * and the caller has not explicitly disabled it with `options.model: false`. When the
 * server is unreachable, the model calls fail gracefully and the eval falls back to
 * rules-only, so CI remains stable.
 */
export const runRouterEvalFromContext = async (ctx: EvalContext): Promise<EvalVerdict> => {
  const { ROUTER_RULES, ROUTER_DEFAULT } = await import('./profile.ts')

  // Allow override of rules from the eval context options
  const rules = (ctx.options.rules as RouteRule[] | undefined) ?? ROUTER_RULES
  const defaultProfile = (ctx.options.defaultProfile as string | undefined) ?? ROUTER_DEFAULT

  // Build model fallback from config unless explicitly disabled.
  let model: RouterOptions['model'] | undefined
  if (ctx.options.model !== false) {
    const baseUrl = ctx.baseUrl ?? (ctx.config.url as string | undefined)
    if (baseUrl) {
      model = {
        baseUrl,
        profiles: ['clinical', 'transcriptor', 'verifier'],
        maxTokens: 128,
      }
    }
  }

  const result = await runRouterEval(rules, defaultProfile, model)
  console.log(formatRouterEval(result))
  const verdict = gateRouterEval(result)

  return {
    pass: verdict.pass,
    summary: verdict.summary,
  }
}
