/**
 * The front door: read the vital signs FIRST, calculate everything the CLI can, then route.
 *
 * WHY THE ORDER CHANGED. The router reads words. `hypotensive` is a criterion to it and
 * `BP 76/44` is not, so a note that states shock in numbers — which is how a flowsheet states
 * it — met one criterion and went to the vital-signs contract as an ordinary set of readings.
 * The syndrome eval carries that case; it was a known gap, and it was not a gap in the word
 * list. No list of synonyms reads a blood pressure.
 *
 * What reads a blood pressure is the vital-signs contract, which this profile already has and
 * already measures, followed by the medprotocol CLI, which already owns every numeric decision
 * here. So the order is: detect that there ARE vitals (cheap, no model), extract them (one
 * pass), hand them to the CLI (no model), and route on the numbers it returns as well as on
 * the words. A note saying `BP 76/44, HR 128` now reaches the shock arm because a systolic of
 * 76 is below the pack's cut and a shock index of 1.68 is above it — decided by the tool, at
 * the thresholds the pack publishes, not by this file.
 *
 * WHAT THIS COSTS, STATED PLAINLY. Routing used to be free: rules over bytes, no GPU, so the
 * wrong schema was never sent. It is no longer free for prose that carries vitals — those
 * documents buy one extraction pass before the route is decided. Three things keep that
 * honest:
 *
 *   - It is GATED on `hasVitalSigns`, which is still rules over bytes. A note with no vitals
 *     in it routes exactly as it did before, at the same cost.
 *   - The pass is not speculative work. Its output is a reading the caller wanted anyway, it
 *     is reported, and `vital-signs` is named in the plan, so nothing runs twice.
 *   - Structured payloads skip it. An exam or a qSOFA payload already IS the numbers; sending
 *     it through a prose extractor would be asking a model to copy JSON.
 *
 * WHAT THE CLI IS ASKED AND WHAT IT IS NOT. `vitals --bp --hr` gives the blood-pressure and
 * heart-rate categories, and MAP and shock index are derived from ITS parse — one parse of a
 * blood pressure in this pipeline, as `medprotocol.ts` requires. The qSOFA screen is NOT run
 * here: it needs a GCS, the vital-signs contract has no GCS slot, and a screen missing one of
 * its three criteria is a screen that never ran. The sepsis arm still gets its GCS from
 * `sepsis-extraction`, which is where it has always come from.
 */

import type { Pack } from '../../core/pack.ts'
import { calculateDerived, type CalculatedReadings } from './calculations.ts'
import { isBloodPressure, type Measurement, type Reading, type VitalSigns } from './extraction.ts'
import { evaluateVitals, loadMedprotocolRule, checkMedprotocolVersion, type MedprotocolRule } from './medprotocol.ts'
import { loadShockRule } from './shock.ts'
import { loadSepsisRule } from './sepsis.ts'

// --- Detection ------------------------------------------------------------------------------

/**
 * Numeric vitals as they are actually written in a note, one pattern per reading.
 *
 * Deliberately NOT the same thing as `isVitalsNote` in the router. That rule asks "is reading
 * vitals what this document is FOR", and answers it by counting abbreviations, so the word
 * `weight` in a discharge summary counts. This asks "is there a number here worth spending a
 * pass on", which is a lower bar and a different question: a septic-shock note is not a vitals
 * note, and it is full of vitals.
 */
const VITALS_PATTERNS: { name: string; pattern: RegExp }[] = [
  // A blood pressure is two numbers over a slash, with or without a label in front.
  { name: 'blood_pressure', pattern: /\b(?:bp|b\.p\.|blood pressure)\b[^.\n]{0,20}?\b\d{2,3}\s*\/\s*\d{2,3}\b|\b\d{2,3}\s*\/\s*\d{2,3}\s*(?:mmhg|mm hg)\b/i },
  { name: 'heart_rate', pattern: /\b(?:hr|heart rate|pulse)\b[^.\n]{0,20}?\b\d{2,3}\b|\b\d{2,3}\s*(?:bpm|beats per minute|beats\/min)\b/i },
  { name: 'respiratory_rate', pattern: /\b(?:rr|resp rate|respiratory rate)\b[^.\n]{0,20}?\b\d{1,2}\b|\b\d{1,2}\s*(?:breaths per minute|breaths\/min)\b/i },
  { name: 'temperature', pattern: /\b(?:temp|temperature|t)\b[^.\n]{0,12}?\b\d{2}(?:\.\d)?\s*(?:°|deg|c\b|f\b)|\b\d{2}\.\d\s*°?\s*[cf]\b|\bfebrile to \d{2}(?:\.\d)?/i },
  { name: 'oxygen_saturation', pattern: /\b(?:spo2|sats?|o2 sats?|oxygen saturation)\b[^.\n]{0,20}?\b\d{2,3}\s*%?/i },
  { name: 'weight', pattern: /\b\d{2,3}(?:\.\d)?\s*(?:kg|kilograms?|lbs?|pounds)\b/i },
  { name: 'height', pattern: /\b\d{2,3}(?:\.\d)?\s*(?:cm|centimet(?:er|re)s?)\b|\b\d\s*(?:ft|feet)\s*\d{1,2}\s*(?:in|inches)\b/i },
  { name: 'blood_glucose', pattern: /\b(?:glucose|bm|bsl|blood sugar)\b[^.\n]{0,20}?\b\d{1,3}(?:\.\d)?\b/i },
]

/**
 * Is there a vital sign written in this document at all?
 *
 * ONE is enough, and that is the point of the threshold being different from the router's. A
 * single `BP 76/44` is the whole reason this path exists: it is one reading, it is not a vitals
 * note, and it is the reading that decides whether the patient is in shock.
 */
export const hasVitalSigns = (input: string): boolean =>
  VITALS_PATTERNS.some(({ pattern }) => pattern.test(input))

/** Which readings the detector saw, for the trace — so a skipped pass can say what it saw. */
export const vitalsDetected = (input: string): string[] =>
  VITALS_PATTERNS.filter(({ pattern }) => pattern.test(input)).map(({ name }) => name)

// --- Measurement ----------------------------------------------------------------------------

/**
 * The numbers, after the CLI has had them.
 *
 * Every field is optional because every one of them depends on a reading the note may not
 * carry, and the whole contract of this module is that a partial answer is reported rather than
 * guessed at. A missing systolic is not a systolic of zero, and `undefined < 90` is `false` —
 * which is the silent-cohort-gate failure `medprotocol.ts` opens by warning about.
 */
export interface MeasuredVitals {
  systolic?: number
  diastolic?: number
  heartRate?: number
  respiratoryRate?: number
  temperatureC?: number
  oxygenSaturation?: number
  /** medprotocol's own label for the blood pressure. Reported, never a cohort gate. */
  bloodPressureCategory?: string
  heartRateCategory?: string
  /** Derived from the CLI's parse, per `medprotocol.ts` — not from the note's raw text. */
  meanArterialPressure?: number
  shockIndex?: number
  /** BMI, PaO2/FiO2 and the categorical readings this repository derives itself. */
  derived: CalculatedReadings
  /** True when `vitals` actually ran. False means the note carried no blood pressure or no rate. */
  cliRan: boolean
  /** Why the CLI was not asked, when it was not. */
  cliSkipped?: string
}

const numberOf = (r: Reading | undefined): number | undefined => {
  if (r === null || r === undefined || isBloodPressure(r)) return undefined
  const value = (r as Measurement).value
  return typeof value === 'number' ? value : undefined
}

/** A temperature in Celsius, converting the reading only when it says it is Fahrenheit. */
const celsiusOf = (r: Reading | undefined): number | undefined => {
  const value = numberOf(r)
  if (value === undefined) return undefined
  if (r === null || r === undefined || isBloodPressure(r)) return undefined
  const unit = (r as Measurement).unit?.toLowerCase().replace(/[°\s]/g, '')
  if (unit === 'f' || unit === 'fahrenheit') return Math.round(((value - 32) * 5 / 9) * 10) / 10
  return value
}

/** Both thresholds tables, read from the pack that publishes them rather than restated here. */
export interface RouteThresholds {
  /** `[clinical.shockExam].hypotensionSystolicBelow` — the study's entry criterion. */
  hypotensionSystolicBelow: number
  /** `[clinical.shockExam].shockIndexAbove` — HR/SBP above this confirms circulatory compromise. */
  shockIndexAbove: number
  /** `[clinical.sepsisScreen].respiratoryRateAtLeast` — the first qSOFA criterion. */
  respiratoryRateAtLeast: number
  /** `[clinical.sepsisScreen].systolicAtMost` — the second. */
  systolicAtMost: number
}

/**
 * The cut-points the router compares numbers against, assembled from the pack's own tables.
 *
 * Not a new table and deliberately not defaulted. These are the same numbers the shock rule and
 * the qSOFA screen turn on downstream; a router screening at a systolic of 95 while the contract
 * classifies at 90 would send notes to an arm that then declines to reason about them, and it
 * would look like a model failure.
 */
export const routeThresholds = (pack: Pack): RouteThresholds => {
  const shock = loadShockRule(pack)
  const sepsis = loadSepsisRule(pack)
  return {
    hypotensionSystolicBelow: shock.hypotensionSystolicBelow,
    shockIndexAbove: shock.shockIndexAbove,
    respiratoryRateAtLeast: sepsis.respiratoryRateAtLeast,
    systolicAtMost: sepsis.systolicAtMost,
  }
}

/**
 * Run every calculation this pack's CLI can perform on the readings that came back.
 *
 * The CLI is asked ONCE, for the one command whose inputs the vital-signs contract supplies in
 * full. A blood pressure without a heart rate is not sent: `vitals --bp 78` exits non-zero, and
 * a refusal caught and swallowed here would be indistinguishable from a patient with no
 * tachycardia.
 */
export const measureVitals = (vitals: VitalSigns, rule: MedprotocolRule): MeasuredVitals => {
  const bp = vitals.blood_pressure
  const systolic = bp && isBloodPressure(bp) ? bp.systolic : undefined
  const diastolic = bp && isBloodPressure(bp) ? bp.diastolic : undefined
  const heartRate = numberOf(vitals.heart_rate)

  const base: MeasuredVitals = {
    systolic,
    diastolic,
    heartRate,
    respiratoryRate: numberOf(vitals.respiratory_rate),
    temperatureC: celsiusOf(vitals.temperature),
    oxygenSaturation: numberOf(vitals.oxygen_saturation),
    derived: calculateDerived(vitals),
    cliRan: false,
  }

  if (systolic === undefined || diastolic === undefined || heartRate === undefined) {
    const absent = [
      systolic === undefined || diastolic === undefined ? 'blood pressure' : undefined,
      heartRate === undefined ? 'heart rate' : undefined,
    ].filter(Boolean)
    return { ...base, cliSkipped: `medprotocol vitals needs both; the note gave no ${absent.join(' and no ')}` }
  }

  const evaluated = evaluateVitals(rule, { systolic, diastolic }, heartRate)
  return {
    ...base,
    // The CLI's parse wins over the extractor's, deliberately: every downstream number is a
    // function of one parse, and that parse is medprotocol's.
    systolic: evaluated.systolic,
    diastolic: evaluated.diastolic,
    heartRate: evaluated.heartRate,
    bloodPressureCategory: evaluated.bloodPressureCategory,
    heartRateCategory: evaluated.heartRateCategory,
    meanArterialPressure: evaluated.meanArterialPressure,
    shockIndex: evaluated.shockIndex,
    cliRan: true,
  }
}

/** The rule, version-checked once, or `undefined` for a pack that declares no CLI. */
export const medprotocolFor = (pack: Pack): MedprotocolRule => {
  const rule = loadMedprotocolRule(pack)
  checkMedprotocolVersion(rule, pack.name)
  return rule
}

// --- Reporting and seeding --------------------------------------------------------------------

export const renderMeasured = (m: MeasuredVitals): string[] => {
  const lines: string[] = []
  if (m.cliRan) {
    lines.push(`blood pressure       ${m.systolic}/${m.diastolic} mmHg (${m.bloodPressureCategory})`)
    lines.push(`heart rate           ${m.heartRate} bpm (${m.heartRateCategory})`)
    lines.push(`mean arterial press. ${m.meanArterialPressure} mmHg`)
    lines.push(`shock index          ${m.shockIndex!.toFixed(2)}`)
  } else {
    lines.push(`medprotocol vitals   not run — ${m.cliSkipped}`)
  }
  if (m.respiratoryRate !== undefined) lines.push(`respiratory rate     ${m.respiratoryRate} breaths/min`)
  if (m.temperatureC !== undefined) lines.push(`temperature          ${m.temperatureC} °C`)
  if (m.oxygenSaturation !== undefined) lines.push(`oxygen saturation    ${m.oxygenSaturation}%`)
  // `m.derived` is deliberately NOT rendered here. The front door runs the vital-signs pass with
  // calculations on, so `reviewVitalSigns` has already printed them under its own heading —
  // repeating them makes the same two lines appear twice in one report, which reads as two
  // different calculations that happen to agree. The values still travel in `m.derived` for the
  // trace and the structured report.
  return lines
}

/**
 * The measured numbers, as a block appended to the prose an extraction arm reads.
 *
 * The arms still run — they need findings the vital-signs contract has no slot for: a jugular
 * venous pressure, a lung exam, a GCS. What they should not be doing is reading a blood
 * pressure out of prose a second time, with a second chance to read it differently, when the
 * CLI has already parsed it. So the numbers arrive as facts and the prose stays underneath
 * them, because the prose is where the rest of the findings are.
 *
 * Appended rather than substituted, and labelled as already decided. An extractor handed only
 * the numbers would have nothing to extract; one handed numbers without a label would have two
 * sources for the same field and no reason to prefer either.
 */
export const seedWithMeasured = (document: string, m: MeasuredVitals): string => {
  const facts: string[] = []
  if (m.systolic !== undefined && m.diastolic !== undefined) facts.push(`- blood pressure: ${m.systolic}/${m.diastolic} mmHg`)
  if (m.heartRate !== undefined) facts.push(`- heart rate: ${m.heartRate} bpm`)
  if (m.respiratoryRate !== undefined) facts.push(`- respiratory rate: ${m.respiratoryRate} breaths/min`)
  if (m.temperatureC !== undefined) facts.push(`- temperature: ${m.temperatureC} °C`)
  if (m.oxygenSaturation !== undefined) facts.push(`- oxygen saturation: ${m.oxygenSaturation}%`)
  if (!facts.length) return document
  return (
    `${document}\n\n` +
    '--- MEASURED VITAL SIGNS (already extracted and verified; use these values as written, ' +
    'do not re-read them from the note above) ---\n' +
    facts.join('\n') +
    '\n'
  )
}
