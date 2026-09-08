/**
 * The shock-category contract: a fixed physical-examination payload in, a category out.
 *
 * This is the first contract in the pack whose input is not a document. The other four read
 * prose a human wrote and pull facts out of it; this one is handed a CLOSED set of findings
 * that have already been decided, and asks the model to reason from them. Extraction — how
 * five findings get out of a ward-round note and into this payload — is a separate contract
 * and deliberately not here: a reasoning number measured over an extraction's mistakes is not
 * a reasoning number.
 *
 * WHAT IT IS BUILT ON. Vazquez R, Gheorghe C, Kaufman D, Manthous CA. "Accuracy of bedside
 * physical examination in distinguishing categories of shock: a pilot study." J Hosp Med
 * 2010;5(8):471-4. PMID 20945471. Sixty-eight patients hypotensive for more than thirty
 * minutes: 37 septic, 18 cardiogenic, 13 hypovolemic. Skin temperature and jugular venous
 * pressure, taken together and alone, put 52 of the 68 in the right category — 76%.
 *
 * THAT 76% IS THE CEILING AND IT IS THE MOST IMPORTANT NUMBER IN THIS FILE. The rule below
 * is not a diagnosis; it is a bedside heuristic whose own authors called it a pilot. So the
 * eval built on it cannot be read as "the model diagnoses shock correctly N% of the time".
 * It measures one thing: does the model apply a published rule to a payload it was given, or
 * does it substitute clinical intuition the payload does not support. Those are different
 * questions and only the second one is answerable from five findings.
 *
 * WHY THE RULE IS CODE AND THE MODEL IS GRADED AGAINST IT. `classify` is twelve lines and it
 * is exact. Nothing is gained by asking a 4B model to perform a table lookup, and something is
 * lost: a lookup the model gets right 95% of the time is strictly worse than a lookup, and a
 * contract that shipped the model here without measuring it against the table would never
 * find that out. So the table is the answer key, generated mechanically from the same payload
 * the model sees, and the headline number is AGREEMENT. If agreement is high the honest
 * conclusion is that the table should ship alone; if it is low the model is wrong, because on
 * this input there is nothing else for it to be. Either way the run says something.
 *
 * What the model is actually for is the residue: the payloads where the table abstains, the
 * findings that contradict each other, and the reason a case is undecidable — none of which
 * a 2x2 can express and all of which a clinician needs said out loud.
 */
import { type Pack } from '../../core/pack.ts'
import { ProfileError } from '../../core/profile.ts'
// The difficulty scale is the pack's, not this task's: a tier means the same thing across
// every contract or a per-tier comparison between them is meaningless.
import { DIFFICULTY_MAX, DIFFICULTY_MIN } from './cases.ts'
// The JSON gate every task in this profile shares. A fence, a truncation and a prose reply
// must fail identically across contracts, or two tasks' failure counts stop being comparable.
import { parseJson } from './extraction.ts'
// Every numeric decision in this contract goes through the CLI the consuming application uses.
// See the header of medprotocol.ts for why that is a subprocess and not twenty lines here.
import { evaluateVitals, type MedprotocolRule, type Vitals } from './medprotocol.ts'

// --- The vocabulary -----------------------------------------------------------------------
//
// Every finding is a CLOSED set with `not_assessed` in it, and that member is the one doing
// the work. A bedside examination is not a form that gets filled in: a jugular venous pressure
// is not assessable in an obese neck, and a capillary refill is not assessable through nail
// varnish. Without a word for it the payload author writes the finding they half-saw, and the
// rule below then classifies confidently from an observation nobody made. It is the same
// argument the vital-signs schema makes for permitting `null` — there has to be exactly one
// way to say a thing was not observed, or the absence is spelled as a weak positive.

export type SkinTemperature = 'warm' | 'cool' | 'not_assessed'
export type JugularVenousPressure = 'elevated' | 'normal_or_low' | 'not_assessed'
export type CapillaryRefill = 'brisk' | 'delayed' | 'not_assessed'
export type PulseVolume = 'bounding' | 'normal' | 'thready' | 'not_assessed'
export type LungExam = 'clear' | 'bilateral_crackles' | 'not_assessed'

export const SKIN_TEMPERATURE: readonly SkinTemperature[] = ['warm', 'cool', 'not_assessed']
export const JVP: readonly JugularVenousPressure[] = ['elevated', 'normal_or_low', 'not_assessed']
export const CAPILLARY_REFILL: readonly CapillaryRefill[] = ['brisk', 'delayed', 'not_assessed']
export const PULSE_VOLUME: readonly PulseVolume[] = ['bounding', 'normal', 'thready', 'not_assessed']
export const LUNG_EXAM: readonly LungExam[] = ['clear', 'bilateral_crackles', 'not_assessed']

/**
 * The categories, and `indeterminate` is a MEMBER rather than the absence of one.
 *
 * A model that cannot say "I do not know" from inside the grammar will say something else,
 * and on a closed enum of three the something else is a coin flip among named diseases. Making
 * abstention an answer is what lets the scorer count it — both when it was right to abstain
 * and, just as importantly, when it was not.
 *
 * The three named ones are the paper's three arms. Obstructive shock is deliberately absent:
 * the cohort did not contain it, the 2x2 cannot separate it from cardiogenic (both raise the
 * jugular venous pressure), and a category the rule can never emit would be a slot in the
 * schema that only the model can fill — which is a place for it to guess, dressed as coverage.
 */
export type ShockCategory = 'septic' | 'cardiogenic' | 'hypovolemic' | 'indeterminate'
export const SHOCK_CATEGORIES: readonly ShockCategory[] = ['septic', 'cardiogenic', 'hypovolemic', 'indeterminate']

/** The five findings, in the order the payload states them and the prompt lists them. */
export const FINDING_NAMES = [
  'skin_temperature',
  'jugular_venous_pressure',
  'capillary_refill',
  'pulse_volume',
  'lung_exam',
] as const
export type FindingName = (typeof FINDING_NAMES)[number]

/**
 * The two findings the rule acts on, named once.
 *
 * Read off this rather than restated in the scorer and the renderer. The distinction between a
 * finding the rule USES and a finding it merely carries is the whole shape of this contract,
 * and two lists of it could disagree in the direction that matters: a scorer grading the echo
 * of a finding the rule ignores reports a fidelity number about nothing.
 */
export const PRIMARY_FINDINGS = ['skin_temperature', 'jugular_venous_pressure'] as const satisfies readonly FindingName[]
export type PrimaryFinding = (typeof PRIMARY_FINDINGS)[number]

// --- The payload --------------------------------------------------------------------------

/**
 * What the model is handed. Fixed shape, five findings, and the precondition that makes them
 * mean anything.
 *
 * `hypotension` is not decoration. The paper's rule was derived in patients hypotensive for
 * more than thirty minutes, and every accuracy it reports is conditional on that. Warm skin
 * and a low jugular venous pressure in a normotensive patient is a warm normotensive patient;
 * it is the 2x2's septic cell and it is not septic shock. The precondition is in the payload so
 * that `classify` can refuse rather than answer, and so that a corpus can hold the case that
 * catches a model reasoning from the table instead of from the patient.
 */
export interface ShockExam {
  hypotension: {
    /** mmHg. The paper's entry criterion is below 90. */
    systolic: number
    /**
     * mmHg. Not used by the cohort gate — which is systolic-only, as the study was — but
     * REQUIRED, because medprotocol will not parse a blood pressure without one and this
     * contract no longer parses blood pressures itself. It also carries real information the
     * rendered payload shows the model: a wide pulse pressure is the vasodilated patient.
     */
    diastolic: number
    /** How long it has persisted. The paper's entry criterion is more than 30. */
    duration_minutes: number
  }
  /** bpm. Feeds medprotocol's own heart-rate category and the derived shock index. */
  heart_rate: number
  skin_temperature: SkinTemperature
  /**
   * The categorical finding, which is what an examiner records.
   *
   * A payload that carries a measurement instead sets this `not_assessed` and fills
   * `jugular_venous_pressure_cm_h2o`; `resolveJvp` bins it by the pack's declared threshold.
   * The threshold is DATA rather than a 7 written here for the reason every other rule in this
   * pack is data: the consuming application bins its own measurements, and an application that
   * cut at 8 while the eval cut at 7 would be shipping a different contract from the measured
   * one and no test in either runtime would notice.
   */
  jugular_venous_pressure: JugularVenousPressure
  /** cmH2O, when the examination produced a number rather than an impression. */
  jugular_venous_pressure_cm_h2o?: number
  capillary_refill: CapillaryRefill
  pulse_volume: PulseVolume
  lung_exam: LungExam
}

// --- What the pack declares -----------------------------------------------------------------

/**
 * `[clinical.shockExam]`, the numbers the rule turns on.
 *
 * All three are the paper's, and all three are here rather than in the code because they are
 * the contract. A runtime that admitted a patient at 95 mmHg into a rule derived below 90 is
 * running a different rule; a runtime that cut the jugular venous pressure at 8 cmH2O is
 * running a different rule. Both would still produce a category, and neither would produce a
 * complaint.
 */
export interface ShockExamRule {
  /** Systolic below this is the paper's cohort. mmHg. */
  hypotensionSystolicBelow: number
  /** For at least this long. Minutes. */
  hypotensionMinutesAtLeast: number
  /** Above this is `elevated`. cmH2O. The paper's cut is 7. */
  jvpElevatedAboveCmH2O: number
  /** Shock index (HR / SBP) above this confirms shock. The paper's cut is 0.7. */
  shockIndexAbove: number
}

/**
 * The rule, or a refusal naming what the pack left out.
 *
 * REQUIRED rather than defaulted, on `[clinical.quoteVerification]`'s terms rather than
 * `[clinical.setMatching]`'s. A defaulted threshold is not a missing feature that degrades to
 * the previous behaviour — there is no previous behaviour — it is a silent decision about where
 * cardiogenic starts, made by this file, reported as the pack's.
 */
export const loadShockRule = (pack: Pack): ShockExamRule => {
  const manifest = pack.manifest as { clinical?: { shockExam?: Partial<ShockExamRule> } }
  const r = manifest.clinical?.shockExam
  const missing = (
    ['hypotensionSystolicBelow', 'hypotensionMinutesAtLeast', 'jvpElevatedAboveCmH2O', 'shockIndexAbove'] as const
  ).filter((k) => typeof r?.[k] !== 'number')
  if (!r || missing.length) {
    throw new ProfileError(
      `pack '${pack.name}': [clinical.shockExam] is missing or incomplete (${missing.join(', ')}) — ` +
        'these are the cut-points the published rule was derived at, and a harness that supplied ' +
        'its own would classify by a rule the pack does not state and report the number as the pack’s',
    )
  }
  return r as ShockExamRule
}

// --- The reference rule ---------------------------------------------------------------------

/** Why the rule declined, when it did. `null` when it did not decline. */
export type IndeterminateReason =
  /** Systolic at or above the cut, or not sustained. The rule was never derived here. */
  | 'outside_studied_cohort'
  /** One of the two findings the rule acts on was not assessable. */
  | 'primary_finding_not_assessed'
  /**
   * Warm skin with an elevated jugular venous pressure: the 2x2's fourth cell.
   *
   * The paper assigns three cells and is silent on this one, and the silence is not an
   * oversight — a vasodilated patient who is also volume-overloaded is the presentation the
   * bedside cannot separate, and it is where obstructive shock and mixed pictures live. The
   * honest output is the name of the ambiguity and a request for an echocardiogram, and this
   * is the cell where a model that has learned to always pick something will show it.
   */
  | 'discordant_primary_findings'

export interface ShockAssessment {
  category: ShockCategory
  reason: IndeterminateReason | null
}

/**
 * The published rule, exactly: skin temperature by jugular venous pressure, and nothing else.
 *
 * THE OTHER THREE FINDINGS DO NOT VOTE, and that is a decision rather than an omission. The
 * paper measured capillary refill and skin temperature together as a septic predictor (89%
 * sensitive, 68% specific) and found bilateral crackles WORSE than the jugular venous pressure
 * for cardiogenic. The 76% that this contract is built on is the two findings alone. Letting
 * the other three break a tie would be a rule nobody has measured, reported under a citation
 * that measured a different one — which is the exact move this repository exists to make
 * visible when someone else makes it.
 *
 * They stay in the payload because they are what CORROBORATION is made of: the model is asked
 * to cite them, `concordance` scores whether they point the same way, and a case where they do
 * not is a case a clinician should be told about rather than a case the rule should silently
 * resolve.
 */
export const classify = (resolved: ResolvedExam): ShockAssessment => {
  if (!resolved.cohort.ok) return { category: 'indeterminate', reason: 'outside_studied_cohort' }
  const skin = resolved.exam.skin_temperature
  const jvp = resolved.jvp
  if (skin === 'not_assessed' || jvp === 'not_assessed') {
    return { category: 'indeterminate', reason: 'primary_finding_not_assessed' }
  }
  if (skin === 'warm' && jvp === 'normal_or_low') return { category: 'septic', reason: null }
  if (skin === 'cool' && jvp === 'elevated') return { category: 'cardiogenic', reason: null }
  if (skin === 'cool' && jvp === 'normal_or_low') return { category: 'hypovolemic', reason: null }
  return { category: 'indeterminate', reason: 'discordant_primary_findings' }
}

/**
 * A payload with every NUMERIC question already answered, so that nothing downstream — the
 * rule, the renderer, the scorer or the model — has to compare a number against a threshold.
 *
 * This type is the whole point of the medprotocol change. Before it, `classify` did its own
 * arithmetic and the PROMPT asked the model to do the same arithmetic independently; the model
 * got it right at a systolic of 104 and wrong at exactly 90 and at a ten-minute duration,
 * across three prompt formulations. Now the comparison happens once, in one place, and both the
 * reference arm and the model read the ANSWER rather than re-deriving it.
 */
export interface ResolvedExam {
  exam: ShockExam
  /** What medprotocol said, plus the two composites derived from its parse. */
  vitals: Vitals
  /** The jugular venous pressure as a category, after any measurement has been binned. */
  jvp: JugularVenousPressure
  /** Whether the study's entry criterion is met, and — when it is not — which half failed. */
  cohort: { ok: boolean; why: string }
}

/**
 * Resolve a payload: ask medprotocol about the vitals, bin the jugular venous pressure, and
 * decide the cohort gate.
 *
 * THE DIVISION OF LABOUR IS THE DESIGN. medprotocol parses and categorises the blood pressure
 * and the heart rate — it is the tool the consuming application already uses, so the eval and
 * the product read a blood pressure the same way. The PACK then decides what that means for
 * this contract, because `[clinical.shockExam].hypotensionSystolicBelow` is a study's entry
 * criterion and not a general fact about blood pressure. Conflating the two is not hypothetical:
 * medprotocol's `Low` fires on systolic < 90 OR diastolic < 60, so it would admit a patient at
 * 120/55 — and `sh-17-systolic-at-cut`, whose systolic is exactly 90.
 *
 * The DURATION half stays here for a simpler reason: medprotocol evaluates measurements, and
 * "sustained for thirty minutes" is not a measurement it has any concept of.
 */
export const resolveExam = (exam: ShockExam, rule: ShockExamRule, mp: MedprotocolRule): ResolvedExam => {
  const vitals = evaluateVitals(mp, { systolic: exam.hypotension.systolic, diastolic: exam.hypotension.diastolic }, exam.heart_rate)
  const belowCut = vitals.systolic < rule.hypotensionSystolicBelow
  const longEnough = exam.hypotension.duration_minutes >= rule.hypotensionMinutesAtLeast
  const why = belowCut
    ? longEnough
      ? `systolic ${vitals.systolic} is below ${rule.hypotensionSystolicBelow} and it has lasted ${exam.hypotension.duration_minutes} minutes`
      : `hypotension has lasted ${exam.hypotension.duration_minutes} minutes, under the ${rule.hypotensionMinutesAtLeast} the rule requires`
    : `systolic ${vitals.systolic} is not below ${rule.hypotensionSystolicBelow}`
  return { exam, vitals, jvp: resolveJvp(exam, rule), cohort: { ok: belowCut && longEnough, why } }
}

/**
 * The jugular venous pressure as a category, from whichever of the two forms the payload has.
 *
 * The categorical finding WINS when both are present. An examiner who wrote both has made a
 * judgement and recorded the number they made it from, and the judgement is the observation;
 * silently preferring the number would let a measurement taken at the wrong angle overrule the
 * person who took it.
 */
export const resolveJvp = (exam: ShockExam, rule: ShockExamRule): JugularVenousPressure => {
  if (exam.jugular_venous_pressure !== 'not_assessed') return exam.jugular_venous_pressure
  const cm = exam.jugular_venous_pressure_cm_h2o
  if (typeof cm !== 'number') return 'not_assessed'
  return cm > rule.jvpElevatedAboveCmH2O ? 'elevated' : 'normal_or_low'
}

// --- Corroboration ---------------------------------------------------------------------------

/**
 * Which category each of the three secondary findings points at, where it points at one.
 *
 * Used for the concordance report and by nothing that decides an answer. Every entry is from
 * the paper's own discussion of the physiology it measured: vasodilation gives a brisk refill
 * and a bounding pulse, a failing pump backs fluid into the lungs, and an empty circulation
 * gives a thready pulse and a slow refill. `normal` and `clear` point nowhere — a normal
 * finding excludes less than it seems to, and a lung that is clear is equally the septic and
 * the hypovolemic patient.
 */
const SECONDARY_SUGGESTS: Record<string, ShockCategory | null> = {
  'capillary_refill:brisk': 'septic',
  'capillary_refill:delayed': null, // cool and slow: cardiogenic OR hypovolemic, and it cannot say which
  'pulse_volume:bounding': 'septic',
  'pulse_volume:thready': null, // the same ambiguity from the other side
  'pulse_volume:normal': null,
  'lung_exam:bilateral_crackles': 'cardiogenic',
  'lung_exam:clear': null,
}

export interface Concordance {
  /** Secondary findings pointing at the rule's category. */
  supporting: FindingName[]
  /** Secondary findings pointing at a different one. Never changes the answer; always reported. */
  discordant: FindingName[]
}

/**
 * Which secondary findings agree with the rule, and which argue against it.
 *
 * The `discordant` list is the output a clinician actually needs and the one a 2x2 has no room
 * for: a cool patient with a low jugular venous pressure is hypovolemic by the rule, and a cool
 * patient with a low jugular venous pressure AND bilateral crackles is a rule being applied to
 * someone it does not fit. Reported rather than resolved, for the reason in `classify`.
 */
// --- Deterministic shock confirmation -------------------------------------------------------

/**
 * Simple deterministic confirmation of shock from an extracted (or supplied) exam.
 *
 * Uses the SAME medprotocol evaluation as the full classification pipeline, so the
 * numbers the confirmation reports are the numbers the downstream rule consumes.
 *
 * Criteria: systolic < 90 mmHg OR shock index (HR / SBP) > 0.7.
 * Either criterion alone confirms shock, catching both overt hypotension and early
 * compensated shock where pressure is maintained by tachycardia.
 */
export interface ShockConfirmation {
  confirmed: boolean
  systolic: number
  shockIndex: number
  reason: string
}

export const confirmShock = (exam: ShockExam, mp: MedprotocolRule, rule: ShockExamRule): ShockConfirmation => {
  const vitals = evaluateVitals(
    mp,
    { systolic: exam.hypotension.systolic, diastolic: exam.hypotension.diastolic },
    exam.heart_rate,
  )
  const reasons: string[] = []
  if (vitals.systolic < rule.hypotensionSystolicBelow) reasons.push(`systolic ${vitals.systolic} < ${rule.hypotensionSystolicBelow} mmHg`)
  if (vitals.shockIndex > rule.shockIndexAbove) reasons.push(`shock index ${vitals.shockIndex} > ${rule.shockIndexAbove}`)
  const confirmed = reasons.length > 0
  return {
    confirmed,
    systolic: vitals.systolic,
    shockIndex: vitals.shockIndex,
    reason: confirmed ? reasons.join(', ') : 'no shock criteria met',
  }
}

export const concordance = (exam: ShockExam, assessment: ShockAssessment): Concordance => {
  const supporting: FindingName[] = []
  const discordant: FindingName[] = []
  for (const name of ['capillary_refill', 'pulse_volume', 'lung_exam'] as const) {
    const points = SECONDARY_SUGGESTS[`${name}:${exam[name]}`]
    if (!points) continue // not_assessed, or a finding that excludes nothing
    if (assessment.category === 'indeterminate') continue // nothing to agree or disagree with
    ;(points === assessment.category ? supporting : discordant).push(name)
  }
  return { supporting, discordant }
}

// --- The payload as the model sees it ---------------------------------------------------------

/**
 * The payload rendered to the exact text that goes in the `user` message.
 *
 * IT IS HERE AND NOT IN THE EVAL, for the reason `[clinical.summaryAssembly]` exists: two
 * runtimes that render the same findings differently are grading different inputs while
 * appearing to share a prompt, and the difference need only be a line break to move a small
 * model's answer. The consuming application will hold these five findings in a form of its own
 * — a UI, a flowsheet row, the output of an extraction pass that does not exist yet — and this
 * is the one function that turns any of them into the bytes that were measured.
 *
 * Deliberately NOT `JSON.stringify(exam)`. The payload's job is to be unambiguous to a model
 * that has to reason from it, and the field a rule turns on should not be discoverable only by
 * counting braces. Findings are listed one per line, primary first, in `FINDING_NAMES` order —
 * the same order as the prompt and the schema, so a reader comparing the three sees one
 * sequence.
 */
export const renderExam = (r: ResolvedExam): string => {
  const e = r.exam
  const v = r.vitals
  // The measurement is shown ALONGSIDE the category it produced when the payload carried one,
  // rather than instead of it. The model is asked to echo the category, and a payload that
  // showed only `9 cmH2O` would be asking it to apply the threshold as well — a second thing to
  // get wrong, folded into the number that was meant to measure the first.
  const cm = e.jugular_venous_pressure === 'not_assessed' && typeof e.jugular_venous_pressure_cm_h2o === 'number'
  const lines = [
    `blood_pressure: ${v.systolic}/${v.diastolic} mmHg (medprotocol: ${v.bloodPressureCategory})`,
    `mean_arterial_pressure: ${v.meanArterialPressure} mmHg`,
    `heart_rate: ${v.heartRate} bpm (medprotocol: ${v.heartRateCategory})`,
    `shock_index: ${v.shockIndex}`,
    `hypotension_duration: ${e.hypotension.duration_minutes} minutes`,
    // THE LINE THE WHOLE medprotocol CHANGE EXISTS FOR. The cohort gate is a comparison of two
    // numbers against two thresholds, and three prompt formulations failed to make a 4B model
    // do it reliably — right at a systolic of 104, wrong at exactly 90 and at ten minutes. It is
    // now decided before the request is built and stated as a fact, with the reason attached so
    // the model can quote it rather than reconstruct it.
    `in_studied_cohort: ${r.cohort.ok ? 'yes' : 'no'} (${r.cohort.why})`,
    `skin_temperature: ${e.skin_temperature}`,
    `jugular_venous_pressure: ${r.jvp}${cm ? ` (measured ${e.jugular_venous_pressure_cm_h2o} cmH2O)` : ''}`,
    `capillary_refill: ${e.capillary_refill}`,
    `pulse_volume: ${e.pulse_volume}`,
    `lung_exam: ${e.lung_exam}`,
  ]
  return `PHYSICAL EXAMINATION\n${lines.join('\n')}\n`
}

// --- Loading a payload ------------------------------------------------------------------------

/**
 * A payload file, parsed and refused if it is not one.
 *
 * Every check here prevents a run that would otherwise still report a percentage. A misspelled
 * finding value — `"cold"` for `"cool"` — is the one worth naming: `classify` would fall
 * through to the fourth cell and return `indeterminate`, the model would probably say
 * `hypovolemic`, and the case would be recorded as a model failure. A typo in the corpus,
 * charged to the weights.
 */
export const parseExam = (raw: string, where: string): ShockExam => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new ProfileError(`${where}: not valid JSON — ${(e as Error).message}`)
  }
  const o = parsed as Record<string, unknown>
  if (!o || typeof o !== 'object') throw new ProfileError(`${where}: expected an object`)

  const h = o.hypotension as Record<string, unknown> | undefined
  if (!h || typeof h.systolic !== 'number' || typeof h.diastolic !== 'number' || typeof h.duration_minutes !== 'number') {
    throw new ProfileError(
      `${where}: 'hypotension' must state systolic, diastolic and duration_minutes as numbers — ` +
        'the gate is conditional on the systolic and the duration, and the diastolic is required ' +
        'because medprotocol will not parse a blood pressure without one',
    )
  }
  if (typeof o.heart_rate !== 'number') {
    throw new ProfileError(
      `${where}: 'heart_rate' must be a number — medprotocol categorises it and the shock index ` +
        'is derived from it, so a payload without one cannot be evaluated',
    )
  }
  const enums: Record<FindingName, readonly string[]> = {
    skin_temperature: SKIN_TEMPERATURE,
    jugular_venous_pressure: JVP,
    capillary_refill: CAPILLARY_REFILL,
    pulse_volume: PULSE_VOLUME,
    lung_exam: LUNG_EXAM,
  }
  for (const name of FINDING_NAMES) {
    const v = o[name]
    if (typeof v !== 'string' || !enums[name].includes(v)) {
      throw new ProfileError(
        `${where}: '${name}' is ${JSON.stringify(v)}, which is not one of ${enums[name].join(', ')} — ` +
          'a finding outside the vocabulary falls through to indeterminate and is scored as a ' +
          'model failure, so a typo in the corpus arrives as a number about the weights',
      )
    }
  }
  const cm = o.jugular_venous_pressure_cm_h2o
  if (cm !== undefined && typeof cm !== 'number') {
    throw new ProfileError(`${where}: 'jugular_venous_pressure_cm_h2o' must be a number, got ${JSON.stringify(cm)}`)
  }
  return o as unknown as ShockExam
}

// --- Scoring one reply --------------------------------------------------------------------------

/**
 * What the model is asked to return, in SCHEMA ORDER — which is the order the grammar makes it
 * emit them, so it is the order this interface has to be read in too.
 *
 * The two echoes come first and the category immediately after, because on this contract the
 * echo IS the reasoning: the rule is a lookup on those two findings, so a model that has just
 * written them down has everything it needs and nothing to gain from a further slot. The
 * justification follows the commitment rather than preceding it — `supporting_findings` is
 * defined relative to a category, and asking for it first would be asking which findings
 * support an answer that has not been given.
 */
export interface ShockReply {
  skin_temperature: SkinTemperature
  jugular_venous_pressure: JugularVenousPressure
  shock_category: ShockCategory
  supporting_findings: FindingName[]
  discordant_findings: FindingName[]
  indeterminate_reason: string | null
  assessment_confidence: number
  notes: string | null
}

export interface ShockScore {
  /**
   * Did the model reach the rule's category? The gated number.
   *
   * Read as agreement with a published heuristic, never as diagnostic accuracy. See the note
   * on the 76% at the top of this file.
   */
  categoryAgrees: boolean
  /**
   * Did the model repeat the two findings the rule acts on as the payload states them?
   *
   * SEPARATE from agreement because they are different failures and one number would merge
   * them. A model that read `cool` as `warm` and then said `septic` applied the rule perfectly
   * to a patient it invented; a model that echoed both findings correctly and still said
   * `septic` cannot read the table. The first is a grounding failure and gets worse with a
   * longer payload; the second is a reasoning failure and gets better with a worked example.
   * A run that scored them together would prescribe the wrong fix for whichever it had.
   */
  echoCorrect: boolean
  /** Which of the two it got wrong, for the trace. */
  echoErrors: PrimaryFinding[]
  /**
   * Findings cited that are not in the payload, or are `not_assessed` in it.
   *
   * The direct analogue of quote verification on the extraction contracts, and it exists for
   * the same reason: a citation nobody checked is worse than no citation, because the answer
   * ships looking grounded. A model that supports `septic` with "mottled skin" has examined a
   * patient it does not have — and the payload is closed, so unlike a note there is no
   * relaxation under which the finding might be there and the check might be too strict.
   */
  inventedFindings: string[]
  /** Did the model abstain? Counted apart from agreement; see `ShockTotals`. */
  abstained: boolean
  /** Did the RULE abstain? The denominator abstention is judged against. */
  ruleAbstained: boolean
}

export const scoreReply = (reply: ShockReply, r: ResolvedExam): ShockScore => {
  const exam = r.exam
  const truth = classify(r)
  const echoErrors: PrimaryFinding[] = []
  if (reply.skin_temperature !== exam.skin_temperature) echoErrors.push('skin_temperature')
  if (reply.jugular_venous_pressure !== r.jvp) echoErrors.push('jugular_venous_pressure')

  // A cited finding is invented unless the payload both KNOWS the name and has an observation
  // under it. `not_assessed` counts as invented on purpose: "the jugular venous pressure
  // supports cardiogenic" is a false statement about a finding nobody obtained, and it is the
  // more dangerous of the two errors because the name is real and a reader will not query it.
  const assessed = new Set<string>(FINDING_NAMES.filter((n) => (n === 'jugular_venous_pressure' ? r.jvp : exam[n]) !== 'not_assessed'))
  const cited = [...(reply.supporting_findings ?? []), ...(reply.discordant_findings ?? [])]
  const inventedFindings = [...new Set(cited.filter((f) => !assessed.has(f)))]

  return {
    categoryAgrees: reply.shock_category === truth.category,
    echoCorrect: echoErrors.length === 0,
    echoErrors,
    inventedFindings,
    abstained: reply.shock_category === 'indeterminate',
    ruleAbstained: truth.category === 'indeterminate',
  }
}

// --- Totals over a corpus -------------------------------------------------------------------------

export interface ShockTotals {
  cases: number
  categoryAgreement: number
  echoFidelity: number
  /** Share of cases citing nothing the payload does not contain. */
  notInvented: number
  /**
   * Of the payloads the RULE declined, the share the model also declined.
   *
   * The fourth cell and the unassessable findings are where this contract's value is, and a
   * model that never abstains scores zero here while looking respectable on agreement — the
   * indeterminate cases are the minority, so agreement absorbs them.
   */
  abstentionRecall: number
  /**
   * Of the payloads the rule DECIDED, the share the model declined anyway.
   *
   * The other half, and it has to be reported separately because the trivial way to make
   * `abstentionRecall` 1.0 is to answer `indeterminate` every time. Lower is better; it is the
   * only number in this file with that direction, which is why it is named for the failure
   * rather than for the success.
   */
  overAbstention: number
}

/**
 * Whether a run clears every floor the case file states.
 *
 * Each is checked SEPARATELY and one number is never averaged into another, for the reason
 * spelled out on `ShockTotals`: agreement, grounding and abstention discipline fail for
 * different causes and are fixed by different edits, and a mean of the three describes none of
 * them. `overAbstention` is compared the other way round because it is the one measure here
 * whose good direction is down.
 */
export const gate = (t: ShockTotals, floors: ShockFloors): { pass: boolean; failed: string[] } => {
  const failed: string[] = []
  if (t.categoryAgreement < floors.categoryAgreementFloor) failed.push('categoryAgreement')
  if (t.echoFidelity < floors.echoFidelityFloor) failed.push('echoFidelity')
  if (t.notInvented < floors.notInventedFloor) failed.push('notInvented')
  if (t.abstentionRecall < floors.abstentionRecallFloor) failed.push('abstentionRecall')
  if (t.overAbstention > floors.overAbstentionCeiling) failed.push('overAbstention')
  return { pass: failed.length === 0, failed }
}

export const totals = (scores: ShockScore[]): ShockTotals => {
  const n = scores.length
  const share = (xs: ShockScore[], p: (s: ShockScore) => boolean) => (xs.length ? xs.filter(p).length / xs.length : 1)
  const declined = scores.filter((s) => s.ruleAbstained)
  const decided = scores.filter((s) => !s.ruleAbstained)
  return {
    cases: n,
    categoryAgreement: share(scores, (s) => s.categoryAgrees),
    echoFidelity: share(scores, (s) => s.echoCorrect),
    notInvented: share(scores, (s) => s.inventedFindings.length === 0),
    // An empty denominator is 1.0 rather than 0: a corpus with no indeterminate cases has not
    // failed abstention, it has not tested it. The case file's floors are what make that
    // distinction enforceable — see `_floors` in evals/shock-cases.json.
    abstentionRecall: share(declined, (s) => s.abstained),
    overAbstention: decided.length ? decided.filter((s) => s.abstained).length / decided.length : 0,
  }
}

// --- The answer key ------------------------------------------------------------------------------

export interface ShockFloors {
  categoryAgreementFloor: number
  echoFidelityFloor: number
  notInventedFloor: number
  abstentionRecallFloor: number
  /** A CEILING. See `ShockTotals.overAbstention` for why this one runs the other way. */
  overAbstentionCeiling: number
}

export interface ShockCase {
  name: string
  class: string
  difficulty: number
  /** The category, restated. Cross-checked against `classify` at load; see `loadShockCases`. */
  expect: ShockCategory
  expectReason: IndeterminateReason | null
  discriminates?: string
  /** The payload itself, loaded and validated alongside the expectation. */
  exam: ShockExam
  /** The payload with every numeric question already answered by medprotocol and the pack. */
  resolved: ResolvedExam
}

export interface ShockCases extends ShockFloors {
  cases: ShockCase[]
}

const REASONS: readonly IndeterminateReason[] = [
  'outside_studied_cohort',
  'primary_finding_not_assessed',
  'discordant_primary_findings',
]

/**
 * The cases, their payloads, and the refusals that make the pair trustworthy.
 *
 * THE CROSS-CHECK IS THE POINT OF THIS FUNCTION. `expect` restates what `classify` computes
 * from the same payload, and a disagreement refuses the pack. That duplication is deliberate
 * and it is the schema-golden argument applied to an answer key: derived alone, a bug in the
 * twelve-line rule silently redefines truth for every case and the run stays green — the
 * corpus and the harness agreeing about a rule neither is implementing. Written alone, a typo
 * in the key is charged to the weights. Written twice and reconciled here, the disagreement
 * becomes a load error naming the case, which is the only place anybody can act on it.
 */
export const loadShockCases = (pack: Pack, mp: MedprotocolRule, key = 'shockCases'): ShockCases => {
  const rule = loadShockRule(pack)
  const raw = JSON.parse(pack.read(key)) as Partial<ShockCases> & { cases?: unknown }

  const floorKeys = [
    'categoryAgreementFloor',
    'echoFidelityFloor',
    'notInventedFloor',
    'abstentionRecallFloor',
    'overAbstentionCeiling',
  ] as const
  for (const k of floorKeys) {
    const v = raw[k]
    if (typeof v !== 'number' || v < 0 || v > 1) {
      throw new ProfileError(
        `pack '${pack.name}': ${key} must state ${k} as a number in 0..1 — ` +
          'an absent floor is a gate that passes whatever it is handed, and it passes silently',
      )
    }
  }
  if (!Array.isArray(raw.cases) || !raw.cases.length) {
    throw new ProfileError(`pack '${pack.name}': ${key} declares no cases`)
  }

  const seen = new Set<string>()
  const cases: ShockCase[] = (raw.cases as ShockCase[]).map((c) => {
    if (typeof c.name !== 'string' || !c.name) throw new ProfileError(`pack '${pack.name}': ${key} has a case with no name`)
    // Duplicate names would each read the SAME payload file and be counted twice, which moves
    // every share in this file by weighting one route through the rule double.
    if (seen.has(c.name)) throw new ProfileError(`pack '${pack.name}': ${key} names case '${c.name}' twice`)
    seen.add(c.name)
    if (!SHOCK_CATEGORIES.includes(c.expect)) {
      throw new ProfileError(
        `pack '${pack.name}': case '${c.name}' expects ${JSON.stringify(c.expect)}, ` +
          `which is not one of ${SHOCK_CATEGORIES.join(', ')}`,
      )
    }
    if (c.expectReason !== null && !REASONS.includes(c.expectReason)) {
      throw new ProfileError(
        `pack '${pack.name}': case '${c.name}' gives reason ${JSON.stringify(c.expectReason)}, ` +
          `which is not one of ${REASONS.join(', ')} (or null)`,
      )
    }
    if (typeof c.difficulty !== 'number' || c.difficulty < DIFFICULTY_MIN || c.difficulty > DIFFICULTY_MAX) {
      throw new ProfileError(
        `pack '${pack.name}': case '${c.name}' has difficulty ${JSON.stringify(c.difficulty)}, ` +
          `expected ${DIFFICULTY_MIN}-${DIFFICULTY_MAX} — an unrated case makes a per-tier score a number about a corpus nobody chose`,
      )
    }

    const exam = parseExam(pack.document(c.name, 'exam'), `pack '${pack.name}' exam payload for case '${c.name}'`)
    // Resolved AT LOAD, so the cross-check below compares the answer key against the same
    // medprotocol verdict the model will be shown rather than against a second derivation.
    const resolved = resolveExam(exam, rule, mp)
    const truth = classify(resolved)
    if (truth.category !== c.expect || truth.reason !== c.expectReason) {
      throw new ProfileError(
        `pack '${pack.name}': case '${c.name}' expects ${c.expect}/${c.expectReason ?? 'null'} ` +
          `but the rule computes ${truth.category}/${truth.reason ?? 'null'} from its payload — ` +
          'the answer key and the reference rule disagree, and until they are reconciled every ' +
          'number this task reports is about whichever of the two is wrong',
      )
    }
    return { ...c, exam, resolved }
  })

  // A corpus with no indeterminate case makes `abstentionRecall` an empty-denominator 1.0 —
  // a gate that reports success for a discipline it never tested — and a corpus with no decided
  // case does the same to `overAbstention` from the other side. Both are refused rather than
  // reported, because both produce a full green table.
  const declined = cases.filter((c) => c.expect === 'indeterminate').length
  if (!declined || declined === cases.length) {
    throw new ProfileError(
      `pack '${pack.name}': ${key} has ${declined} indeterminate case(s) out of ${cases.length} — ` +
        'a corpus needs both kinds, or abstentionRecall and overAbstention each report 1.0 and 0 ' +
        'for a discipline nothing in the run exercised',
    )
  }

  return { ...(raw as ShockFloors), cases }
}

// --- Parsing a reply ------------------------------------------------------------------------------

/**
 * The completion, as a reply or as a named refusal.
 *
 * STRICTER than the other tasks' parsers, and the input is why. `parseVitalSigns` tolerates a
 * missing slot because a note may genuinely say nothing about weight; here every property is
 * required, every value is drawn from a closed enum, and the grammar can emit nothing else. So
 * anything this function rejects came from an UNCONSTRAINED run, which is exactly the arm the
 * strictness is measuring — how much of this contract the grammar was carrying.
 *
 * The refusals name the field rather than the object. A run where a 4B model omitted
 * `discordant_findings` on nineteen of twenty cases and a run where it answered `"unclear"` for
 * the category are different findings about the same model, and one message saying "malformed
 * reply" makes them the same number.
 */
export const parseShockReply = (raw: string): ShockReply => {
  const o = parseJson(raw, 'shock')

  const member = <T extends string>(field: string, allowed: readonly T[]): T => {
    const v = o[field]
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      throw new Error(`${field} was ${JSON.stringify(v)}, expected one of ${allowed.join(', ')}`)
    }
    return v as T
  }
  const names = (field: string): FindingName[] => {
    const v = o[field]
    // Absent is NOT read as empty. An empty array is the model saying it has nothing to cite,
    // and a missing key is the model not answering the question — on a contract whose subject
    // is whether citations are grounded, silently conflating the two would credit the omission
    // as restraint.
    if (!Array.isArray(v)) throw new Error(`${field} was ${JSON.stringify(v)}, expected an array of finding names`)
    for (const x of v) {
      if (typeof x !== 'string' || !(FINDING_NAMES as readonly string[]).includes(x)) {
        throw new Error(`${field} contains ${JSON.stringify(x)}, which is not one of ${FINDING_NAMES.join(', ')}`)
      }
    }
    return v as FindingName[]
  }
  const nullableString = (field: string): string | null => {
    const v = o[field]
    if (v === null || typeof v === 'string') return v
    throw new Error(`${field} was ${JSON.stringify(v)}, expected a string or null`)
  }

  const confidence = o.assessment_confidence
  if (typeof confidence !== 'number') {
    throw new Error(`assessment_confidence was ${JSON.stringify(confidence)}, expected a number`)
  }

  // Built in schema order, because the object this returns is written to the trace and a
  // reader comparing a completion with its parse should see one sequence.
  return {
    skin_temperature: member('skin_temperature', SKIN_TEMPERATURE),
    jugular_venous_pressure: member('jugular_venous_pressure', JVP),
    shock_category: member('shock_category', SHOCK_CATEGORIES),
    supporting_findings: names('supporting_findings'),
    discordant_findings: names('discordant_findings'),
    indeterminate_reason: nullableString('indeterminate_reason'),
    assessment_confidence: confidence,
    notes: nullableString('notes'),
  }
}
