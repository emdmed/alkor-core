/**
 * The sepsis-screen contract: a fixed Quick SOFA payload in, whether the screen is positive out.
 *
 * The second contract in the pack whose input is not a document. Like shock, it is handed a
 * CLOSED set of already-measured numerics and asked to report a result, and — also like shock —
 * the numeric decision is delegated to the medprotocol CLI rather than left to the model or to
 * a second implementation here.
 *
 * WHAT IT MEASURES. Sepsis suspicion per qSOFA is three threshold comparisons (respiratory rate
 * >= 22, systolic blood pressure <= 100, GCS < 15) and a positive screen is any two of them.
 * The three comparisons and the two-of-three rule are exact and are entirely medprotocol's
 * `sepsis qsofa` command's. Nothing is gained by asking a 4B model to perform them, so the
 * answer key is the CLI's own `positive`, generated from the same payload the model sees.
 *
 * WHAT THE MODEL IS FOR. The residue, exactly as in shock: the payload is rendered with the
 * CLI's score and positive/negative already decided, and the model is asked to read them
 * faithfully — to echo the three inputs and the criteria they meet, and to narrate why. The
 * measured claim is whether the model applies the declared screen rather than re-deriving the
 * thresholds and substituting arithmetic the payload does not support.
 *
 * WHY THE PER-CRITERION FLAGS ARE DERIVED AND NOT TAKEN FROM THE CLI. The medprotocol qsofa
 * command returns `score` and `positive` but not which criteria were individually met, and the
 * model needs that breakdown to narrate. So this module derives it from the raw inputs under
 * `[clinical.sepsisScreen]` — and then CROSS-CHECKS the derived count against the CLI's score
 * at load, refusing the pack when they disagree. It is the same `_expectIsCrossChecked` argument
 * the shock answer key makes: a derivation that silently drifted from the CLI would redefine
 * truth for every case while every number stayed green.
 */
import { type Pack } from '../../core/pack.ts'
import { ProfileError } from '../../core/profile.ts'
import { DIFFICULTY_MAX, DIFFICULTY_MIN } from './cases.ts'
import { parseJson } from './extraction.ts'
import { evaluateQSOFA, type MedprotocolRule, type QSOFAScreen } from './medprotocol.ts'

// --- The vocabulary -----------------------------------------------------------------------
//
// qSOFA is three numbers and one boolean result, so there is less closed vocabulary here than
// in shock. The only enum is the criteria the model may cite, and it is closed because a
// qSOFA screen has exactly three criteria and no others exist.

/**
 * The three qSOFA criteria, named once.
 *
 * Read off this rather than restated in the renderer, the scorer and the prompt, so the
 * criterion list cannot drift between them. `altered_mental_status` is GCS below the pack's
 * threshold, which is the standard reading and the one medprotocol implements.
 */
export const CRITERIA = ['respiratory_rate', 'systolic_bp', 'altered_mental_status'] as const
export type Criterion = (typeof CRITERIA)[number]

// --- The payload --------------------------------------------------------------------------

/**
 * What the model is handed: one patient's three qSOFA inputs.
 *
 * All three are REQUIRED, and that is a property of the delegation rather than of a preference
 * for completeness: the medprotocol `sepsis qsofa` command requires `--rr`, `--sbp` and `--gcs`,
 * and a payload missing any of them is a screen that never ran. There is deliberately no
 * `not_assessed` member — the tool that decides the screen cannot say anything about it without
 * all three, so neither can this contract.
 */
export interface SepsisExam {
  /** Breaths per minute. */
  respiratory_rate: number
  /** mmHg. The qSOFA criterion is at or below 100. */
  systolic_bp: number
  /** Glasgow Coma Scale, 3-15. Altered mental status is below the pack's threshold. */
  gcs: number
}

// --- What the pack declares -----------------------------------------------------------------

/**
 * `[clinical.sepsisScreen]`, the thresholds qSOFA turns on.
 *
 * All four are the published criteria and all four are DATA for the reason every other rule in
 * this pack is: a consuming application that screened at a different respiratory rate or a
 * different systolic cut is running a different screen while quoting the same name. They are
 * REQUIRED, on `[clinical.shockExam]`'s terms — a defaulted threshold is a silent decision about
 * where sepsis suspicion begins, made here and reported as the pack's.
 *
 * They are also the pack's statement of what the CLI does, and the loader cross-checks the
 * derivation against the CLI's authoritative `score` so the two cannot drift in silence.
 */
export interface SepsisScreenRule {
  /** Respiratory rate at or above this meets the criterion. */
  respiratoryRateAtLeast: number
  /** Systolic at or below this meets the criterion. */
  systolicAtMost: number
  /** GCS below this is altered mental status. */
  gcsBelow: number
  /** A positive screen requires at least this many criteria. */
  criteriaForPositive: number
}

export const loadSepsisRule = (pack: Pack): SepsisScreenRule => {
  const manifest = pack.manifest as { clinical?: { sepsisScreen?: Partial<SepsisScreenRule> } }
  const r = manifest.clinical?.sepsisScreen
  const missing = (
    ['respiratoryRateAtLeast', 'systolicAtMost', 'gcsBelow', 'criteriaForPositive'] as const
  ).filter((k) => typeof r?.[k] !== 'number')
  if (!r || missing.length) {
    throw new ProfileError(
      `pack '${pack.name}': [clinical.sepsisScreen] is missing or incomplete (${missing.join(', ')}) — ` +
        'these are the qSOFA cut-points, and a harness that supplied its own would screen by a ' +
        'rule the pack does not state and report the number as the pack’s',
    )
  }
  return r as SepsisScreenRule
}

// --- The reference rule ---------------------------------------------------------------------

export interface SepsisAssessment {
  positive: boolean
  score: number
  criteria: Record<Criterion, boolean>
}

/**
 * The reference screen: the CLI's own verdict, plus the per-criterion breakdown.
 *
 * `positive` and `score` ARE the CLI's. `criteria` is derived from the raw inputs under the
 * pack's thresholds — it is what the model is asked to narrate — and it is reconciled against
 * the CLI's score by the loader, so a derivation medprotocol's arithmetic would not produce
 * refuses the pack rather than being charged to the weights.
 */
export const assess = (r: ResolvedSepsis): SepsisAssessment => ({
  positive: r.screen.positive,
  score: r.screen.score,
  criteria: r.criteria,
})

/**
 * A payload with the numeric screen already answered by medprotocol, so nothing downstream has
 * to compare a number against a threshold.
 *
 * The same split shock uses: the CLI decides the screen, and the pack's thresholds are only
 * consulted to say WHICH criteria were met — for the model to echo — never to decide the score
 * the model is graded against.
 */
export interface ResolvedSepsis {
  exam: SepsisExam
  /** The CLI's authoritative screen. */
  screen: QSOFAScreen
  /** Which criteria the inputs meet, derived under `[clinical.sepsisScreen]`. */
  criteria: Record<Criterion, boolean>
}

/** Which criteria the raw inputs meet, under the pack's declared thresholds. */
export const resolveCriteria = (exam: SepsisExam, rule: SepsisScreenRule): Record<Criterion, boolean> => ({
  respiratory_rate: exam.respiratory_rate >= rule.respiratoryRateAtLeast,
  systolic_bp: exam.systolic_bp <= rule.systolicAtMost,
  altered_mental_status: exam.gcs < rule.gcsBelow,
})

/**
 * Resolve a payload: ask medprotocol for the screen, then derive the per-criterion breakdown.
 *
 * The screen — `score` and `positive` — comes entirely from the CLI. The criteria breakdown is
 * derived for the model to narrate, and the loader checks that the number of derived criteria
 * equals the CLI's score so a silent drift between the pack and the CLI is a load error rather
 * than a corpus-wide lie.
 */
export const resolveSepsis = (exam: SepsisExam, rule: SepsisScreenRule, mp: MedprotocolRule): ResolvedSepsis => ({
  exam,
  screen: evaluateQSOFA(mp, exam.respiratory_rate, exam.systolic_bp, exam.gcs),
  criteria: resolveCriteria(exam, rule),
})

// --- The payload as the model sees it ---------------------------------------------------------

/**
 * The payload rendered to the exact text that goes in the `user` message.
 *
 * IT IS HERE AND NOT IN THE EVAL, for the reason `renderExam` is in shock.ts: two runtimes that
 * render the same payload differently are grading different inputs while appearing to share a
 * prompt. The numbers the model must not re-derive are shown as facts — the CLI's score, which
 * criteria were met, and the positive/negative verdict — the same way shock shows
 * `in_studied_cohort` pre-decided.
 */
export const renderSepsis = (r: ResolvedSepsis): string => {
  const e = r.exam
  const met = CRITERIA.filter((c) => r.criteria[c])
  const lines = [
    `respiratory_rate: ${e.respiratory_rate} breaths/min`,
    `systolic_bp: ${e.systolic_bp} mmHg`,
    `gcs: ${e.gcs}`,
    `qsofa_score: ${r.screen.score} (medprotocol: ${r.screen.positive ? 'positive' : 'negative'})`,
    `criteria_met: ${met.length ? met.join(', ') : 'none'}`,
    `positive_screen: ${r.screen.positive ? 'yes' : 'no'}`,
  ]
  return `QUICK SOFA SCREEN\n${lines.join('\n')}\n`
}

// --- Loading a payload ------------------------------------------------------------------------

/**
 * A payload file, parsed and refused if it is not one.
 *
 * Every check here prevents a run that would otherwise still report a percentage. The three
 * numbers are required because the CLI requires them, and each is range-checked so a payload
 * outside the physiological range fails loudly rather than being scored as a screen.
 */
export const parseSepsis = (raw: string, where: string): SepsisExam => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new ProfileError(`${where}: not valid JSON — ${(e as Error).message}`)
  }
  const o = parsed as Record<string, unknown>
  if (!o || typeof o !== 'object') throw new ProfileError(`${where}: expected an object`)

  if (typeof o.respiratory_rate !== 'number' || o.respiratory_rate < 0 || o.respiratory_rate > 100) {
    throw new ProfileError(
      `${where}: 'respiratory_rate' must be a number in 0..100 — the qSOFA threshold is 22 and ` +
        `the CLI refuses a missing value, so a payload without one is a screen that never ran`,
    )
  }
  if (typeof o.systolic_bp !== 'number' || o.systolic_bp < 0 || o.systolic_bp > 300) {
    throw new ProfileError(
      `${where}: 'systolic_bp' must be a number in 0..300 — the qSOFA threshold is 100 and the CLI ` +
        `requires it, so a payload without one is a screen that never ran`,
    )
  }
  if (typeof o.gcs !== 'number' || o.gcs < 3 || o.gcs > 15) {
    throw new ProfileError(
      `${where}: 'gcs' must be a number in 3..15 — 15 is alert and the qSOFA threshold is below it, ` +
        `and the CLI requires it, so a payload without one is a screen that never ran`,
    )
  }
  return o as unknown as SepsisExam
}

// --- Scoring one reply --------------------------------------------------------------------------

/**
 * What the model is asked to return, in SCHEMA ORDER — which is the order the grammar makes it
 * emit them, so it is the order this interface has to be read in too.
 *
 * The three echoes come first because on this contract the echo IS the reasoning: the screen is
 * a lookup on those three numbers, so a model that has just written them down has everything it
 * needs. The result follows immediately, and the criteria and narration follow the commitment
 * rather than preceding it.
 */
export interface SepsisReply {
  respiratory_rate: number
  systolic_bp: number
  gcs: number
  qsofa_score: number
  positive: boolean
  criteria_met: Criterion[]
  screen_reason: string | null
  assessment_confidence: number
  notes: string | null
}

export interface SepsisScore {
  /** Did the model report the CLI's positive/negative verdict? The gated number. */
  screenAgrees: boolean
  /** Did the model echo all three inputs as the payload states them? */
  echoCorrect: boolean
  /** Which of the three it misread, for the trace. */
  echoErrors: Criterion[]
  /** Did the model's cited criteria equal the ones the inputs actually meet? */
  criteriaCorrect: boolean
  /** Criteria the model named that were not met, or met criteria it omitted. */
  criteriaErrors: Criterion[]
  /** The model's score, when it stated one, for the trace. */
  statedScore?: number
}

export const scoreReply = (reply: SepsisReply, r: ResolvedSepsis): SepsisScore => {
  const exam = r.exam
  const truth = assess(r)

  const echoErrors: Criterion[] = []
  if (reply.respiratory_rate !== exam.respiratory_rate) echoErrors.push('respiratory_rate')
  if (reply.systolic_bp !== exam.systolic_bp) echoErrors.push('systolic_bp')
  if (reply.gcs !== exam.gcs) echoErrors.push('altered_mental_status')

  const met = new Set<Criterion>(CRITERIA.filter((c) => truth.criteria[c]))
  const cited = new Set(reply.criteria_met ?? [])
  const criteriaErrors: Criterion[] = []
  for (const c of CRITERIA) {
    const shouldBe = met.has(c)
    const is = cited.has(c)
    if (shouldBe !== is) criteriaErrors.push(c)
  }

  return {
    screenAgrees: reply.positive === truth.positive,
    echoCorrect: echoErrors.length === 0,
    echoErrors,
    criteriaCorrect: criteriaErrors.length === 0,
    criteriaErrors,
    statedScore: reply.qsofa_score,
  }
}

// --- Totals over a corpus -------------------------------------------------------------------------

export interface SepsisTotals {
  cases: number
  screenAgreement: number
  echoFidelity: number
  criteriaFidelity: number
}

/**
 * Whether a run clears every floor the case file states.
 *
 * Each is checked separately and one number is never averaged into another, for the reason
 * `gate` in shock.ts spells out: agreement, grounding and criteria discipline fail for
 * different causes and are fixed by different edits.
 */
export const gate = (t: SepsisTotals, floors: SepsisFloors): { pass: boolean; failed: string[] } => {
  const failed: string[] = []
  if (t.screenAgreement < floors.screenAgreementFloor) failed.push('screenAgreement')
  if (t.echoFidelity < floors.echoFidelityFloor) failed.push('echoFidelity')
  if (t.criteriaFidelity < floors.criteriaFidelityFloor) failed.push('criteriaFidelity')
  return { pass: failed.length === 0, failed }
}

export const totals = (scores: SepsisScore[]): SepsisTotals => {
  const n = scores.length
  const share = (xs: SepsisScore[], p: (s: SepsisScore) => boolean) => (xs.length ? xs.filter(p).length / xs.length : 1)
  return {
    cases: n,
    screenAgreement: share(scores, (s) => s.screenAgrees),
    echoFidelity: share(scores, (s) => s.echoCorrect),
    criteriaFidelity: share(scores, (s) => s.criteriaCorrect),
  }
}

// --- The answer key ------------------------------------------------------------------------------

export interface SepsisFloors {
  screenAgreementFloor: number
  echoFidelityFloor: number
  criteriaFidelityFloor: number
}

export interface SepsisCase {
  name: string
  class: string
  difficulty: number
  /** The verdict, restated. Cross-checked against the CLI at load; see `loadSepsisCases`. */
  expect: boolean
  /** The payload itself, loaded and validated alongside the expectation. */
  exam: SepsisExam
  /** The payload with the screen already answered by medprotocol and the derivation. */
  resolved: ResolvedSepsis
}

export interface SepsisCases extends SepsisFloors {
  cases: SepsisCase[]
}

/**
 * The cases, their payloads, and the refusals that make the pair trustworthy.
 *
 * THE CROSS-CHECK IS THE POINT OF THIS FUNCTION. `expect` restates whether the CLI screen is
 * positive, and a disagreement refuses the pack. And independently, the derived criteria count
 * is reconciled against the CLI's `score` so that a pack threshold that drifted from the tool
 * that decides the screen is a load error naming the case.
 */
export const loadSepsisCases = (pack: Pack, mp: MedprotocolRule, key = 'sepsisCases'): SepsisCases => {
  const rule = loadSepsisRule(pack)
  const raw = JSON.parse(pack.read(key)) as Partial<SepsisCases> & { cases?: unknown }

  const floorKeys = ['screenAgreementFloor', 'echoFidelityFloor', 'criteriaFidelityFloor'] as const
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
  const cases: SepsisCase[] = (raw.cases as SepsisCase[]).map((c) => {
    if (typeof c.name !== 'string' || !c.name) throw new ProfileError(`pack '${pack.name}': ${key} has a case with no name`)
    if (seen.has(c.name)) throw new ProfileError(`pack '${pack.name}': ${key} names case '${c.name}' twice`)
    seen.add(c.name)
    if (typeof c.expect !== 'boolean') {
      throw new ProfileError(
        `pack '${pack.name}': case '${c.name}' expects ${JSON.stringify(c.expect)}, ` +
          'which is not a boolean — a screen verdict is positive or negative',
      )
    }
    if (typeof c.difficulty !== 'number' || c.difficulty < DIFFICULTY_MIN || c.difficulty > DIFFICULTY_MAX) {
      throw new ProfileError(
        `pack '${pack.name}': case '${c.name}' has difficulty ${JSON.stringify(c.difficulty)}, ` +
          `expected ${DIFFICULTY_MIN}-${DIFFICULTY_MAX} — an unrated case makes a per-tier score a number about a corpus nobody chose`,
      )
    }

    const exam = parseSepsis(pack.document(c.name, 'exam'), `pack '${pack.name}' exam payload for case '${c.name}'`)
    // Resolved AT LOAD, so the cross-check compares the answer key against the same medprotocol
    // verdict the model will be shown rather than against a second derivation.
    const resolved = resolveSepsis(exam, rule, mp)
    const truth = assess(resolved)
    if (truth.positive !== c.expect) {
      throw new ProfileError(
        `pack '${pack.name}': case '${c.name}' expects ${c.expect} but the medprotocol screen is ` +
          `${truth.positive} from its payload — the answer key and the reference rule disagree, and ` +
          'until they are reconciled every number this task reports is about whichever of the two is wrong',
      )
    }
    // The derived criteria must be consistent with the CLI's authoritative score. A derivation
    // that sums to a different count has drifted from the tool that decides the screen.
    const metCount = CRITERIA.filter((cc) => resolved.criteria[cc]).length
    if (metCount !== truth.score) {
      throw new ProfileError(
        `pack '${pack.name}': case '${c.name}' derives ${metCount} qSOFA criteria from its payload but ` +
          `medprotocol scores it ${truth.score} — the pack thresholds and the CLI disagree, and a model ` +
          'narrating criteria against a score it can reconcile with neither would be graded by both',
      )
    }
    return { ...c, exam, resolved }
  })

  // A corpus with no negative case — or no positive one — screens every patient the same way,
  // which makes `screenAgreement` a single-column test that cannot tell a model reading the
  // screen from one answering 'yes' to everything.
  const positive = cases.filter((c) => c.expect).length
  if (!positive || positive === cases.length) {
    throw new ProfileError(
      `pack '${pack.name}': ${key} has ${positive} positive case(s) out of ${cases.length} — ` +
        'a screen corpus needs both verdicts, or agreement is a number about a model that never ' +
        'had to say no',
    )
  }

  return { ...(raw as SepsisFloors), cases }
}

// --- Parsing a reply ------------------------------------------------------------------------------

/**
 * The completion, as a reply or as a named refusal.
 *
 * STRICTER than the extraction tasks' parsers, and the input is why: every property is
 * required, the echoes are numbers from a closed physiological range, and the grammar can emit
 * nothing else. Anything this function rejects came from an UNCONSTRAINED run, which is exactly
 * the arm the strictness is measuring — how much of the contract the grammar was carrying.
 */
export const parseSepsisReply = (raw: string): SepsisReply => {
  const o = parseJson(raw, 'sepsis')

  const numberIn = (field: string, lo: number, hi: number): number => {
    const v = o[field]
    if (typeof v !== 'number' || v < lo || v > hi) {
      throw new Error(`${field} was ${JSON.stringify(v)}, expected a number in ${lo}..${hi}`)
    }
    return v
  }
  const criteria = (field: string): Criterion[] => {
    const v = o[field]
    if (!Array.isArray(v)) throw new Error(`${field} was ${JSON.stringify(v)}, expected an array of criteria`)
    for (const x of v) {
      if (typeof x !== 'string' || !(CRITERIA as readonly string[]).includes(x)) {
        throw new Error(`${field} contains ${JSON.stringify(x)}, which is not one of ${CRITERIA.join(', ')}`)
      }
    }
    return v as Criterion[]
  }
  const nullableString = (field: string): string | null => {
    const v = o[field]
    if (v === null || typeof v === 'string') return v
    throw new Error(`${field} was ${JSON.stringify(v)}, expected a string or null`)
  }

  const respiratoryRate = numberIn('respiratory_rate', 0, 100)
  const systolicBp = numberIn('systolic_bp', 0, 300)
  const gcs = numberIn('gcs', 3, 15)
  const score = o.qsofa_score
  if (typeof score !== 'number' || score < 0 || score > 3) {
    throw new Error(`qsofa_score was ${JSON.stringify(score)}, expected 0..3`)
  }
  if (typeof o.positive !== 'boolean') {
    throw new Error(`positive was ${JSON.stringify(o.positive)}, expected a boolean`)
  }
  const confidence = o.assessment_confidence
  if (typeof confidence !== 'number') {
    throw new Error(`assessment_confidence was ${JSON.stringify(confidence)}, expected a number`)
  }

  return {
    respiratory_rate: respiratoryRate,
    systolic_bp: systolicBp,
    gcs,
    qsofa_score: score,
    positive: o.positive,
    criteria_met: criteria('criteria_met'),
    screen_reason: nullableString('screen_reason'),
    assessment_confidence: confidence,
    notes: nullableString('notes'),
  }
}
