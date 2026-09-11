/**
 * Syndrome-routing eval: does a prompt reach the shock arm, the sepsis arm, or BOTH?
 *
 * The shape eval next door (`router-eval.ts`) grades the WINNER — one expected shape, one
 * expected task — which is the right question to ask of a document's modality and the wrong
 * one to ask of its clinical questions. A note can raise two. Septic shock is the case the
 * router was rebuilt for: it meets the shock criteria and the qSOFA criteria at once, and a
 * grader that only reads `result.task` scores a plan that answered half the question as
 * correct, because the half it answered is the half it looks at.
 *
 * So this eval grades the PLAN AS A SET. Each case declares which arms should run — `shock`,
 * `sepsis`, both, or neither — and the plan is read back into arms by asking which workflows
 * it contains. Dropping an arm and inventing one are counted separately, per arm, because they
 * cost different things: a dropped arm is a syndrome nobody screened for, an invented one is
 * two GPU passes bought for a note that never raised the question.
 *
 * Deterministic and model-free, like every rule-based eval here: it costs CPU time, so it can
 * run on every commit and grow to hundreds of cases without a budget conversation.
 */

import { routeClinicalShape } from './clinical-router.ts'
import { TASK_FEEDS, type Task } from './contracts.ts'
import { routeThresholds, type MeasuredVitals, type RouteThresholds } from './vitals-first.ts'
import type { EvalContext, EvalVerdict } from '../../core/profile.ts'

/**
 * The cut-points this corpus was written against, used when no pack is at hand.
 *
 * A restatement of pack data, which everything else in this profile is arranged to avoid, and
 * the exception is narrow enough to state precisely: these cases are SYNTHETIC prose written by
 * hand, and each one is written to sit clearly on one side of a threshold — a systolic of 76
 * against a cut of 90, not 89 against 90. They exist to check that a number is read at all, not
 * to pin where the line falls; `sepsis.test.ts` and `shock.test.ts` pin the line, against the
 * pack, against the CLI.
 *
 * `runSyndromeRoutingEvalFromContext` uses the PACK's numbers when a run supplies a pack, so the
 * gate a real run clears is the pack's rule and this is only the default for `npm test`.
 */
export const CORPUS_THRESHOLDS: RouteThresholds = {
  hypotensionSystolicBelow: 90,
  shockIndexAbove: 0.7,
  respiratoryRateAtLeast: 22,
  systolicAtMost: 100,
}

/** A clinical question a plan can answer. `neither` is the absence of both, not a third arm. */
export type SyndromeArm = 'shock' | 'sepsis'

/**
 * Which tasks mean an arm ran, derived from `TASK_FEEDS` rather than listed.
 *
 * An arm is its terminal contract plus whatever feeds it: prose reaches `shock` through
 * `shock-extraction`, and a plan carrying only the extraction has still committed to the arm.
 * Reading the feed table means a third arm — or a third contract in front of an existing one —
 * is graded here the day it is routable, without anyone remembering to extend a list.
 */
export const TASKS_FOR_ARM: Record<SyndromeArm, Task[]> = {
  shock: ['shock', ...(Object.entries(TASK_FEEDS) as [Task, Task][]).filter(([, to]) => to === 'shock').map(([from]) => from)],
  sepsis: ['sepsis', ...(Object.entries(TASK_FEEDS) as [Task, Task][]).filter(([, to]) => to === 'sepsis').map(([from]) => from)],
}

/** The arms a route plan actually commits to, in a fixed order so two sets compare as strings. */
export const armsOfPlan = (tasks: Task[]): SyndromeArm[] =>
  (['shock', 'sepsis'] as SyndromeArm[]).filter((arm) => tasks.some((task) => TASKS_FOR_ARM[arm].includes(task)))

/** The label a set of arms is reported under: one of four, so the confusion matrix is 4×4. */
export const armLabel = (arms: SyndromeArm[]): string =>
  arms.length === 0 ? 'neither' : arms.length === 2 ? 'both' : arms[0]!

export interface SyndromeCase {
  input: string
  /** Every arm that SHOULD run. Empty means the note raises neither question. */
  expectedArms: SyndromeArm[]
  difficulty: 1 | 2 | 3
  /** What this case discriminates — read out loud when it fails. */
  discriminates: string
  /**
   * What the front door measured, for a case that routes on NUMBERS rather than on words.
   *
   * Supplied here rather than extracted, because this eval must stay model-free: the vital-signs
   * pass that produces these in a real run is graded by its own eval against its own corpus, and
   * what is under test here is only whether the router reads what that pass returns. A case with
   * no `measured` is a case the words alone must answer, which is every case that was here
   * before the front door existed.
   */
  measured?: MeasuredVitals
  /**
   * Why this case is expected to FAIL today, if it is.
   *
   * A known gap is graded like any other case and printed like any other failure; it just does
   * not hold the gate red. The point is that the case stays in the corpus stating the clinically
   * correct answer, instead of being deleted or quietly re-labelled to whatever the router
   * currently does — which is how a corpus stops being able to tell you anything.
   *
   * The gate fails if a known gap starts PASSING, because the annotation is then describing a
   * router that no longer exists and the case belongs in the gated set.
   */
  knownGap?: string
}

// --- The corpus -----------------------------------------------------------------------------
//
// Written rather than generated, because what is being graded is a clinical judgement about a
// sentence and not a number in a template. The counts stay small and the wording varies: ten
// copies of one note with an index appended measure one case ten times.

const SHOCK_ONLY: SyndromeCase[] = [
  {
    input: 'BP 76/44, heart rate 128, cool clammy peripheries with delayed capillary refill. Urine output 10 mL/hr over the last three hours.',
    expectedArms: ['shock'],
    difficulty: 1,
    discriminates: 'circulatory failure stated in NUMBERS — the case the front door was built for',
    // What the vital-signs pass reads off that sentence, and what medprotocol says about it.
    // Without this the note meets one criterion (delayed capillary refill) and goes to the
    // vital-signs contract as an ordinary set of readings: `BP 76/44` is hypotension to a
    // clinician and nothing at all to a word list.
    measured: {
      systolic: 76,
      diastolic: 44,
      heartRate: 128,
      bloodPressureCategory: 'Low',
      heartRateCategory: 'Elevated',
      meanArterialPressure: 54.7,
      shockIndex: 128 / 76,
      derived: {},
      cliRan: true,
    },
  },
  {
    input: 'Hypotensive since arrival, tachycardic at 118, mottled skin over the knees. Bedside echo shows a poorly contracting left ventricle — cardiogenic shock suspected.',
    expectedArms: ['shock'],
    difficulty: 1,
    discriminates: 'named cardiogenic shock, no infective source',
  },
  {
    input: 'Trauma call: pelvic fracture with ongoing blood loss. Low blood pressure despite two units, tachycardia 130, cold extremities, oliguria.',
    expectedArms: ['shock'],
    difficulty: 2,
    discriminates: 'haemorrhagic shock — organ failure without infection must not reach the sepsis screen',
  },
  {
    input: JSON.stringify({
      hypotension: true,
      heart_rate: 124,
      capillary_refill: 'delayed',
      skin_temperature: 'cold',
      jugular_venous_pressure: 'raised',
      mental_status: 'altered',
    }),
    expectedArms: ['shock'],
    difficulty: 2,
    discriminates: 'shock exam payload carries no respiratory rate and no GCS, so it cannot be screened for sepsis',
  },
  {
    input: 'Post-operative day 1. Sustained hypotension with a shock index above 1.0, peripheries cool to the elbow.',
    expectedArms: ['shock'],
    difficulty: 2,
    discriminates: 'shock index phrasing without the word hypoperfusion',
  },
]

const SEPSIS_ONLY: SyndromeCase[] = [
  {
    input: 'Febrile to 39.1 with a productive cough and right basal crepitations. Pneumonia suspected. Respiratory rate 26, alert and oriented, BP 124/78.',
    expectedArms: ['sepsis'],
    difficulty: 1,
    discriminates: 'infection with tachypnoea and a normal blood pressure — sepsis question only',
  },
  {
    input: 'Nursing home resident with a urinary tract infection, now drowsy and confused. Started on antibiotics. Blood pressure 118/70, breathing comfortably.',
    expectedArms: ['sepsis'],
    difficulty: 1,
    discriminates: 'infection plus altered mental status, perfusion intact',
  },
  {
    input: JSON.stringify({ respiratory_rate: 24, systolic_bp: 96, gcs: 13 }),
    expectedArms: ['sepsis'],
    difficulty: 1,
    discriminates: 'qSOFA payload goes straight to the screen and raises no shock question',
  },
  {
    input: 'Please run a qSOFA screen on this admission: cellulitis of the left leg, spreading despite oral flucloxacillin, temperature 38.4.',
    expectedArms: ['sepsis'],
    difficulty: 2,
    discriminates: 'the screen named explicitly alongside a source, with no circulatory finding',
  },
]

const BOTH: SyndromeCase[] = [
  {
    input: 'Septic shock from a urinary source. BP 78/40 after 30 mL/kg, heart rate 132, mottled skin, lactate 4.8, confused and tachypnoeic at 30.',
    expectedArms: ['shock', 'sepsis'],
    difficulty: 1,
    discriminates: 'the canonical case: one note, both syndromes, four passes',
  },
  {
    input: 'Perforated diverticulitis with faeculent peritonitis. Hypotensive at 84/48 despite fluids, tachycardic, cold peripheries, GCS 13, respiratory rate 28.',
    expectedArms: ['shock', 'sepsis'],
    difficulty: 1,
    discriminates: 'both syndromes without the word "sepsis" or "shock" appearing anywhere',
  },
  {
    input: 'Known bacteraemia on day 3 of admission. Now obtunded, low blood pressure, poor peripheral perfusion, urine output falling.',
    expectedArms: ['shock', 'sepsis'],
    difficulty: 2,
    discriminates: 'infection already established, deteriorating perfusion — neither arm may be dropped',
  },
  {
    input: 'Dictation: patient with pneumonia, now hypotensive and tachycardic with cool extremities and rising lactate. Query septic shock.',
    expectedArms: ['shock', 'sepsis'],
    difficulty: 3,
    discriminates: 'a dictation marker in front of a septic-shock note must not demote it to a transcript',
    knownGap:
      'modality beats question by design — `dictation` at 0.95 wins outright, so the plan is ' +
      '[transcript] and both syndromes go unscreened. Defensible if the dictation is meant to be ' +
      'transcribed and re-routed, indefensible if this is the only pass the note gets; the case ' +
      'stays here stating the clinical answer until that is decided',
  },
]

const NEITHER: SyndromeCase[] = [
  {
    input: 'Patient BP 122/78 mmHg, HR 72 bpm, SpO2 98% on room air, temperature 36.8 C, weight 71 kg.',
    expectedArms: [],
    difficulty: 1,
    discriminates: 'a routine vitals note raises neither question',
  },
  {
    input: 'Doctor: How has the knee been since the injection?\nPatient: Much better, I can climb stairs again.\nDoctor: Any swelling?\nPatient: None at all.',
    expectedArms: [],
    difficulty: 1,
    discriminates: 'a consultation transcript is a modality, not a syndrome',
  },
  {
    input: 'Patient admitted for an elective hernia repair. Treated with simple analgesia and discharged the same day with a follow-up in six weeks.',
    expectedArms: [],
    difficulty: 1,
    discriminates: 'ordinary clinical prose with no criteria met',
  },
  {
    input: 'Reviewed in clinic. Ongoing confusion attributed to long-standing dementia, no change from baseline. Observations stable throughout.',
    expectedArms: [],
    difficulty: 3,
    discriminates: 'one criterion alone — chronic confusion — is not a screen, and buys no GPU pass',
  },
  {
    input: 'Afebrile, no source of infection identified, wound clean and dry. Blood pressure and heart rate within normal limits.',
    expectedArms: [],
    difficulty: 3,
    discriminates: 'infection vocabulary used to rule infection OUT, with no other criterion',
  },
]

/**
 * Notes whose syndrome is stated only in numbers — the arm the front door opened.
 *
 * Each of these is deliberately thin on vocabulary: take the `measured` block away and none of
 * them meets two criteria, which is what makes them a test of the numbers rather than of the
 * words that happen to surround them.
 */
const MEASURED: SyndromeCase[] = [
  {
    input: 'Observations on arrival: 84/50, 122, 26. Peripheries cool. Wound from last week looks infected.',
    expectedArms: ['shock', 'sepsis'],
    difficulty: 2,
    discriminates: 'bare flowsheet numbers plus a source of infection: both arms, no syndrome named',
    measured: {
      systolic: 84,
      diastolic: 50,
      heartRate: 122,
      respiratoryRate: 26,
      bloodPressureCategory: 'Low',
      heartRateCategory: 'Elevated',
      meanArterialPressure: 61.3,
      shockIndex: 122 / 84,
      derived: {},
      cliRan: true,
    },
  },
  {
    input: 'Post-op check. Comfortable, eating, mobilising. Observations: 118/72, 76, 14.',
    expectedArms: [],
    difficulty: 1,
    discriminates: 'ordinary numbers meet no criterion — measuring is not the same as suspecting',
    measured: {
      systolic: 118,
      diastolic: 72,
      heartRate: 76,
      respiratoryRate: 14,
      bloodPressureCategory: 'Normal',
      heartRateCategory: 'Normal',
      meanArterialPressure: 87.3,
      shockIndex: 76 / 118,
      derived: {},
      cliRan: true,
    },
  },
  {
    input: 'Chest infection, temperature 38.6. Observations: 98/64, 88, 24.',
    expectedArms: ['sepsis'],
    difficulty: 3,
    discriminates: 'a normotensive infection with a measured respiratory rate: sepsis alone, no shock arm',
    measured: {
      systolic: 98,
      diastolic: 64,
      heartRate: 88,
      respiratoryRate: 24,
      temperatureC: 38.6,
      bloodPressureCategory: 'Normal',
      heartRateCategory: 'Normal',
      meanArterialPressure: 75.3,
      shockIndex: 88 / 98,
      derived: {},
      cliRan: true,
    },
  },
  {
    input: 'Seen on the ward round. Blood pressure not recorded, patient declined observations. Looks comfortable.',
    expectedArms: [],
    difficulty: 2,
    discriminates: 'the CLI could not run — an absent systolic is not a systolic of zero',
    measured: { derived: {}, cliRan: false, cliSkipped: 'the note gave no blood pressure and no heart rate' },
  },
]

export const SYNDROME_ROUTING_CASES: SyndromeCase[] = [...SHOCK_ONLY, ...SEPSIS_ONLY, ...BOTH, ...NEITHER, ...MEASURED]

// --- Results --------------------------------------------------------------------------------

export interface ArmMetrics {
  /** Cases where the arm was expected and ran. */
  tp: number
  /** Cases where the arm ran and was not expected — a workflow bought for nothing. */
  fp: number
  /** Cases where the arm was expected and did not run — a syndrome nobody screened for. */
  fn: number
  precision: number
  recall: number
  f1: number
}

export interface SyndromeCaseResult {
  input: string
  expectedArms: SyndromeArm[]
  predictedArms: SyndromeArm[]
  /** The full ordered plan, so a failure report can show what actually would have run. */
  tasks: Task[]
  correct: boolean
  /** Expected arms the plan dropped. */
  missing: SyndromeArm[]
  /** Arms the plan added. */
  extra: SyndromeArm[]
  difficulty: number
  confidence: number
  reason: string
  discriminates: string
  knownGap?: string
}

/**
 * The numbers, computed over the GATED cases only — every case without a `knownGap`.
 *
 * Known gaps are reported beside these rather than mixed into them. An accuracy that averages
 * the router's real behaviour with cases it is already documented to fail measures neither: it
 * cannot go up when a gap is closed, and it hides a regression behind a gap's headroom.
 */
export interface SyndromeEvalResult {
  total: number
  correct: number
  /** Exact-set accuracy: every expected arm ran and no other did. */
  accuracy: number
  /** Per-arm precision and recall over the gated cases, computed as a multi-label problem. */
  perArm: Map<SyndromeArm, ArmMetrics>
  perDifficulty: Map<number, { correct: number; total: number; accuracy: number }>
  /** 4×4 over the labels `shock`, `sepsis`, `both`, `neither`: expected → predicted → count. */
  confusion: Map<string, Map<string, number>>
  /** Every case result, gated and gap alike, in corpus order. */
  cases: SyndromeCaseResult[]
  /** The annotated gaps, and whether each is still failing. */
  knownGaps: SyndromeCaseResult[]
  /** Gaps that now PASS: the annotation is stale and the case should join the gated set. */
  closedGaps: SyndromeCaseResult[]
  /** Plans whose task order contradicts the feed table — an extraction that runs after its consumer. */
  outOfOrder: SyndromeCaseResult[]
}

export const ARM_LABELS = ['shock', 'sepsis', 'both', 'neither'] as const

export const runSyndromeRoutingEval = (
  cases: SyndromeCase[] = SYNDROME_ROUTING_CASES,
  thresholds: RouteThresholds = CORPUS_THRESHOLDS,
): SyndromeEvalResult => {
  const results: SyndromeCaseResult[] = []
  const confusion = new Map<string, Map<string, number>>()
  const perArmCounts = new Map<SyndromeArm, { tp: number; fp: number; fn: number }>([
    ['shock', { tp: 0, fp: 0, fn: 0 }],
    ['sepsis', { tp: 0, fp: 0, fn: 0 }],
  ])
  const perDifficulty = new Map<number, { correct: number; total: number }>()
  const outOfOrder: SyndromeCaseResult[] = []

  for (const testCase of cases) {
    // Evidence only when the case carries a measurement, so a word-routed case is still routed
    // by an evidence-free call — the same call every other caller makes.
    const route = routeClinicalShape(
      testCase.input,
      undefined,
      testCase.measured ? { measured: testCase.measured, thresholds } : undefined,
    )
    const predictedArms = armsOfPlan(route.tasks)
    const missing = testCase.expectedArms.filter((arm) => !predictedArms.includes(arm))
    const extra = predictedArms.filter((arm) => !testCase.expectedArms.includes(arm))
    const correct = missing.length === 0 && extra.length === 0

    const result: SyndromeCaseResult = {
      input: testCase.input,
      expectedArms: testCase.expectedArms,
      predictedArms,
      tasks: route.tasks,
      correct,
      missing,
      extra,
      difficulty: testCase.difficulty,
      confidence: route.confidence,
      reason: route.reason,
      discriminates: testCase.discriminates,
      knownGap: testCase.knownGap,
    }
    results.push(result)
    // Order is checked for every case, gap or not: a gap excuses a wrong ARM SET, never a plan
    // that cannot execute.

    // An extraction that lands after the contract it feeds is a plan that cannot run, and it
    // would not show up in the arm counts: both arms are present, in an impossible order.
    for (const [from, to] of Object.entries(TASK_FEEDS) as [Task, Task][]) {
      const iFrom = route.tasks.indexOf(from)
      const iTo = route.tasks.indexOf(to)
      if (iFrom !== -1 && iTo !== -1 && iFrom > iTo) outOfOrder.push(result)
    }

    if (testCase.knownGap !== undefined) continue

    for (const arm of ['shock', 'sepsis'] as SyndromeArm[]) {
      const counts = perArmCounts.get(arm)!
      const expected = testCase.expectedArms.includes(arm)
      const predicted = predictedArms.includes(arm)
      if (expected && predicted) counts.tp++
      else if (predicted) counts.fp++
      else if (expected) counts.fn++
    }

    const expectedLabel = armLabel(testCase.expectedArms)
    const predictedLabel = armLabel(predictedArms)
    if (!confusion.has(expectedLabel)) confusion.set(expectedLabel, new Map())
    const row = confusion.get(expectedLabel)!
    row.set(predictedLabel, (row.get(predictedLabel) ?? 0) + 1)

    if (!perDifficulty.has(testCase.difficulty)) perDifficulty.set(testCase.difficulty, { correct: 0, total: 0 })
    const diff = perDifficulty.get(testCase.difficulty)!
    diff.total++
    if (correct) diff.correct++
  }

  const perArm = new Map<SyndromeArm, ArmMetrics>()
  for (const [arm, m] of perArmCounts) {
    const precision = m.tp + m.fp > 0 ? m.tp / (m.tp + m.fp) : 1
    const recall = m.tp + m.fn > 0 ? m.tp / (m.tp + m.fn) : 1
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
    perArm.set(arm, { ...m, precision, recall, f1 })
  }

  const perDifficultyAccuracy = new Map<number, { correct: number; total: number; accuracy: number }>()
  for (const [diff, m] of perDifficulty) {
    perDifficultyAccuracy.set(diff, { ...m, accuracy: m.total > 0 ? m.correct / m.total : 0 })
  }

  const gated = results.filter((r) => r.knownGap === undefined)
  const correct = gated.filter((r) => r.correct).length
  const knownGaps = results.filter((r) => r.knownGap !== undefined)
  return {
    total: gated.length,
    correct,
    accuracy: gated.length > 0 ? correct / gated.length : 0,
    perArm,
    perDifficulty: perDifficultyAccuracy,
    confusion,
    cases: results,
    knownGaps,
    closedGaps: knownGaps.filter((r) => r.correct),
    outOfOrder,
  }
}

// --- Reporting ------------------------------------------------------------------------------

export const formatSyndromeRoutingEval = (r: SyndromeEvalResult): string => {
  const lines: string[] = []
  lines.push(`=== syndrome routing · shock / sepsis / both · ${r.total} gated cases, ${r.knownGaps.length} known gaps ===`)
  lines.push(`exact-plan accuracy: ${(r.accuracy * 100).toFixed(1)}% (${r.correct}/${r.total})`)
  lines.push('')

  lines.push('per-arm (multi-label):')
  for (const [arm, m] of r.perArm) {
    lines.push(
      `  ${arm.padEnd(7)} precision ${(m.precision * 100).toFixed(1)}%  recall ${(m.recall * 100).toFixed(1)}%  ` +
        `f1 ${(m.f1 * 100).toFixed(1)}%  (ran-and-wanted ${m.tp}, ran-unwanted ${m.fp}, dropped ${m.fn})`,
    )
  }
  lines.push('')

  lines.push('per-difficulty:')
  for (const [diff, m] of [...r.perDifficulty.entries()].sort(([a], [b]) => a - b)) {
    lines.push(`  d${diff}: ${(m.accuracy * 100).toFixed(1)}% (${m.correct}/${m.total})`)
  }
  lines.push('')

  lines.push('confusion (expected → predicted):')
  lines.push('  ' + 'expected\\pred'.padEnd(16) + ARM_LABELS.map((l) => l.padStart(10)).join(''))
  for (const expected of ARM_LABELS) {
    const row = r.confusion.get(expected)
    if (!row) continue
    lines.push('  ' + expected.padEnd(16) + ARM_LABELS.map((pred) => String(row.get(pred) ?? 0).padStart(10)).join(''))
  }

  const failures = r.cases.filter((c) => !c.correct && c.knownGap === undefined)
  if (failures.length) {
    lines.push('')
    lines.push('failures:')
    for (const f of failures) {
      const short = f.input.slice(0, 64).replace(/\n/g, ' ⏎ ') + (f.input.length > 64 ? '…' : '')
      const delta = [
        ...f.missing.map((arm) => `dropped ${arm}`),
        ...f.extra.map((arm) => `ran ${arm} unasked`),
      ].join(', ')
      lines.push(`  [d${f.difficulty}] "${short}"`)
      lines.push(`        ${delta} — plan [${f.tasks.join(' → ')}] (${f.reason})`)
      lines.push(`        discriminates: ${f.discriminates}`)
    }
  }

  if (r.knownGaps.length) {
    lines.push('')
    lines.push('known gaps (stated, not gated):')
    for (const g of r.knownGaps) {
      const short = g.input.slice(0, 64).replace(/\n/g, ' ⏎ ') + (g.input.length > 64 ? '…' : '')
      const delta = g.correct
        ? 'NOW PASSES — annotation is stale, promote it into the gated set'
        : [...g.missing.map((arm) => `dropped ${arm}`), ...g.extra.map((arm) => `ran ${arm} unasked`)].join(', ')
      lines.push(`  [d${g.difficulty}] "${short}"`)
      lines.push(`        ${delta} — plan [${g.tasks.join(' → ')}] (${g.reason})`)
      lines.push(`        why: ${g.knownGap}`)
    }
  }

  if (r.outOfOrder.length) {
    lines.push('')
    lines.push('impossible plans (an extraction scheduled after the contract it feeds):')
    for (const f of r.outOfOrder) lines.push(`  [${f.tasks.join(' → ')}]`)
  }

  return lines.join('\n')
}

/**
 * The gate, with the two arms held to different floors on purpose.
 *
 * RECALL IS THE EXPENSIVE SIDE. A dropped arm is a syndrome the pipeline silently did not
 * screen for, reported as a completed run, so both arms must be perfect — and the `both` row is
 * checked separately as well, because a septic-shock note losing an arm is the exact regression
 * this router exists to prevent, and it is one case in a corpus where an accuracy floor could
 * absorb it.
 *
 * Precision is floored lower. An unasked arm costs two GPU passes and a screen that reports
 * "criteria not met", which is wasteful rather than wrong.
 */
export const gateSyndromeRoutingEval = (r: SyndromeEvalResult): { pass: boolean; summary: string } => {
  const recallPass = [...r.perArm.values()].every((m) => m.recall >= 1)
  const precisionPass = [...r.perArm.values()].every((m) => m.precision >= 0.85)
  const accuracyPass = r.accuracy >= 0.9
  const bothRow = r.confusion.get('both')
  const bothTotal = [...(bothRow?.values() ?? [])].reduce((a, b) => a + b, 0)
  const bothKept = bothRow?.get('both') ?? 0
  const bothPass = bothTotal === 0 || bothKept === bothTotal
  const orderPass = r.outOfOrder.length === 0
  const gapsPass = r.closedGaps.length === 0

  const parts = [
    `exact-plan accuracy ${(r.accuracy * 100).toFixed(1)}% vs floor 90% ${accuracyPass ? '✓' : '✗'}`,
    `per-arm recall 100% ${recallPass ? '✓' : '✗'}`,
    `per-arm precision ≥ 85% ${precisionPass ? '✓' : '✗'}`,
    `septic-shock notes keep both arms (${bothKept}/${bothTotal}) ${bothPass ? '✓' : '✗'}`,
    `plans in dependency order ${orderPass ? '✓' : '✗'}`,
    `known gaps still open (${r.knownGaps.length - r.closedGaps.length}/${r.knownGaps.length}) ${gapsPass ? '✓' : '✗'}`,
  ]
  return {
    pass: recallPass && precisionPass && accuracyPass && bothPass && orderPass && gapsPass,
    summary: parts.join(' · '),
  }
}

/**
 * The eval, run against the PACK's cut-points when a run supplies a pack.
 *
 * `npm test` has no pack and falls back to `CORPUS_THRESHOLDS`; a real `eval` run does have one,
 * and the numbers it routes at should be the ones its contracts classify at.
 */
export const runSyndromeRoutingEvalFromContext = async (ctx: EvalContext): Promise<EvalVerdict> => {
  const result = runSyndromeRoutingEval(
    SYNDROME_ROUTING_CASES,
    ctx.pack ? routeThresholds(ctx.pack) : CORPUS_THRESHOLDS,
  )
  console.log(formatSyndromeRoutingEval(result))
  const verdict = gateSyndromeRoutingEval(result)
  return { pass: verdict.pass, summary: verdict.summary }
}
