/**
 * The answer keys: what a case file may say, and what this profile refuses to load.
 *
 * Split out of `contracts.ts` because a case is the other half of a contract and reads
 * nothing from the first half. `contracts.ts` assembles what is SENT — prompt, schema, cap;
 * this file loads what the reply is graded AGAINST, and the only thing it borrows from the
 * request side is the gradeable slot list, so that a vital-signs case naming a field the
 * schema does not define is refused rather than silently skipped.
 *
 * Every loader here is mostly refusal, and that is the point. A floor that is absent, a
 * difficulty that is missing, a field name that is mistyped — each of them produces a run
 * that still reports a percentage, of a denominator nobody chose. The comments on each check
 * say which wrong number it prevents; they are the reason the checks are not consolidated
 * into one generic validator.
 */
import { type Pack } from '../../core/pack.ts'
import { ProfileError } from '../../core/profile.ts'
import type { GradedField } from './contracts.ts'
// The section lists live with the parsers that read them: one statement of what a task's
// reply contains, rather than a second copy here that can disagree with it.
import { FORMAT_LIST_FIELDS, SUMMARY_FIELDS } from './extraction.ts'

// --- Vital signs --------------------------------------------------------------------------

export type VitalExpect =
  | { kind: 'value'; value: number; unit: string }
  | { kind: 'bp'; systolic: number; diastolic: number; unit: string }
  | { kind: 'unresolved' }
  | { kind: 'absent' }

export interface VitalExpectation {
  field: string
  expect: VitalExpect
}

export interface VitalCase {
  name: string
  class: string
  /**
   * How hard the NOTE is to read, 1-5. The rubric lives in the case file, where a corpus
   * author reads it; what matters here is that it rates the text rather than the model, so
   * it does not move when the weights do and a per-tier score stays comparable across runs.
   */
  difficulty: number
  note?: string
  fields: VitalExpectation[]
}

/** The tiers a pack may use. Fixed, because a scale that grows is a scale nobody can read. */
export const DIFFICULTY_MIN = 1
export const DIFFICULTY_MAX = 5

/**
 * `--difficulty 4` or `--difficulty 3-5`, as a predicate over tiers.
 *
 * A malformed spec is an error rather than a silently ignored filter: a run that was meant
 * to be the hard tier and quietly graded all 21 notes reports a number for a corpus nobody
 * asked about, and nothing in its output would say so. `ProfileError` rather than a bare
 * throw, so a mistyped flag prints one line and exits 2 like every other setup mistake
 * instead of arriving as a stack trace.
 */
export const parseDifficultyRange = (spec: string): ((d: number) => boolean) => {
  const m = /^\s*([1-5])\s*(?:-\s*([1-5])\s*)?$/.exec(spec)
  if (!m) {
    throw new ProfileError(`--difficulty expects N or N-M within ${DIFFICULTY_MIN}-${DIFFICULTY_MAX}, got '${spec}'`)
  }
  const lo = Number(m[1])
  const hi = m[2] === undefined ? lo : Number(m[2])
  if (hi < lo) throw new ProfileError(`--difficulty range '${spec}' is empty: ${lo} is above ${hi}`)
  return (d: number) => d >= lo && d <= hi
}

export interface VitalCases {
  fieldRecallFloor: number
  /**
   * Sub-gate: of what was detected, the share whose NUMBER was right.
   *
   * Detection alone stopped discriminating. Measured on this pack: 87/88 and 88/88 across
   * two models, saturated at every tier including 5, while value sat at 82/88 against 86/87
   * and unit at 81/88 against 86/87 — so the axis that gated agreed about the models and the
   * two axes that told them apart did not gate at all. A run that reads a fifth of a
   * flowsheet wrong used to pass.
   *
   * Detection stays the headline floor. It is the floor it always was; it is no longer
   * asked to be the discriminator it stopped being.
   */
  valueFloor: number
  /** Sub-gate: of what was detected, the share whose UNIT was right. Counted apart from
   * `valueFloor` for the reason the scorer counts them apart — a right number in the wrong
   * unit is a different bug from a wrong number, and one combined floor would hide which. */
  unitFloor: number
  cases: VitalCase[]
}

/**
 * Load the cases, materialising the implicit `absent` expectations.
 *
 * The case file states the rule (`_implicitAbsent`): a gradeable field a case does not
 * list is expected absent. Expanding it here rather than at grading time is what makes
 * hallucination counting TOTAL rather than sampled — every slot is accounted for in every
 * case — and it is why the scorer never has to know the field list at all.
 *
 * An expectation naming a field the schema does not define is an error rather than a
 * skipped line. It means the two halves of the contract have drifted, and the run that
 * followed would report a percentage of a denominator nobody intended.
 *
 * A missing or out-of-range `difficulty` is an error for the same reason. It is not a
 * decoration: the eval reports detection per tier, and a case that defaulted to some tier
 * would land its slots in a bucket its author never chose.
 */
export const loadVitalCases = (pack: Pack, fields: GradedField[]): VitalCases => {
  const raw = pack.json<VitalCases>('vitalSignsCases')
  for (const [key, value] of [
    ['fieldRecallFloor', raw.fieldRecallFloor],
    ['valueFloor', raw.valueFloor],
    ['unitFloor', raw.unitFloor],
  ] as const) {
    checkFloor(pack, 'vitalSignsCases', key, value)
  }
  const known = new Set(fields.map((f) => f.name))
  const cases = raw.cases.map((c) => {
    checkDifficulty(c.name, c.difficulty)
    for (const e of c.fields) {
      if (!known.has(e.field)) {
        throw new Error(
          `case '${c.name}' expects field '${e.field}', which the schema does not define ` +
            `(gradeable slots: ${[...known].join(', ')})`,
        )
      }
    }
    const listed = new Set(c.fields.map((f) => f.field))
    const implicit = fields
      .filter((f) => !listed.has(f.name))
      .map((f): VitalExpectation => ({ field: f.name, expect: { kind: 'absent' } }))
    return { ...c, fields: [...c.fields, ...implicit] }
  })
  return { fieldRecallFloor: raw.fieldRecallFloor, valueFloor: raw.valueFloor, unitFloor: raw.unitFloor, cases }
}

// --- Set extraction: the shape the summary and note-format tasks share ------------------

/**
 * One expectation over a SET of free-text items.
 *
 * `match` is a list of ALTERNATIVES, each an AND-group of terms. Both levels are load-bearing
 * and both were paid for on a sibling pack. The AND level: `['metformin','850']` matches
 * "metformin 850 mg twice daily" while a bare `['metformin']` would also match "metformin
 * stopped" — the opposite fact. The OR level: a fact has more than one correct spelling, and
 * scoring "essential hypertension" as a miss because the key said "high blood pressure" is a
 * scorer defect wearing a model result's clothing, which is precisely what a floor must never
 * be tuned around.
 */
export type SetExpect =
  | { kind: 'present'; match: string[][]; dose?: string[][]; doseNull?: boolean }
  | { kind: 'absent'; match: string[][] }
  | { kind: 'empty' }

export interface SetExpectation {
  field: string
  expect: SetExpect
}

// --- Patient summary --------------------------------------------------------------------

export interface SummaryCase {
  name: string
  class: string
  difficulty: number
  /** The record, in order. Several notes, because that is the shape of the call. */
  notes: string[]
  note?: string
  fields: SetExpectation[]
}

export interface SummaryCases {
  itemRecallFloor: number
  cases: SummaryCase[]
}

export const loadSummaryCases = (pack: Pack): SummaryCases => {
  const raw = pack.json<SummaryCases>('summaryCases')
  checkFloor(pack, 'summaryCases', 'itemRecallFloor', raw.itemRecallFloor)
  for (const c of raw.cases) {
    checkDifficulty(c.name, c.difficulty)
    if (!c.notes?.length) {
      throw new Error(`summary case '${c.name}' names no notes — this task's input is a record, not a document`)
    }
    checkSetFields(c.name, c.fields, SUMMARY_FIELDS)
  }
  return raw
}

// --- Note formatting ---------------------------------------------------------------------

export interface FormatCase {
  name: string
  class: string
  difficulty: number
  /** The vital-signs case whose note this reads. The corpus is shared, never duplicated. */
  source: string
  note?: string
  fields: SetExpectation[]
}

/**
 * The floors every QUOTED set task gates on — note formatting and dictated transcripts.
 *
 * One declaration for both because the two tasks make the same four claims about an answer,
 * and a second copy would be free to drift in exactly the place a drift is invisible: a task
 * whose `fabricationFloor` was optional in one loader and ignored in the other would report a
 * gate it never applied.
 */
export interface QuotedSetCases {
  itemRecallFloor: number
  /** Sub-gate: the share of emitted quotes that are genuinely in the note. */
  quoteFloor: number
  /** Sub-gate: the share of emitted texts derivable from their quote by deletion. */
  derivationFloor: number
  /**
   * Sub-gate, OPTIONAL: the share of emitted quotes that are not FABRICATIONS — spans found in
   * the note under some relaxation of case or accents, even if the strict rule rejects them.
   *
   * `quoteFloor` covers two accusations at one number, and they are not the same accusation. A
   * quote that differs from the note in a capital is a model tidying while claiming to copy; a
   * quote absent under any relaxation is a model inventing a sentence and attaching evidence
   * to it. Measured on this corpus: of one model's provenance failures, all of them on
   * `vs-en-03` were the first kind, while another model's five failures on the flowsheet note
   * were all the second — every citation invented, with every value correct. One floor scores
   * those runs the same way and describes neither.
   *
   * So a pack may say "tidying may cost me five per cent, fabrication may cost me nothing",
   * which is the sentence most packs actually mean. It is optional because the one-floor
   * reading is legitimate too: a pack whose application shows the quote to a clinician has a
   * real objection to an edited span, and forcing it to declare two numbers where it means one
   * would be the harness inventing a policy. Omitted means only `quoteFloor` gates.
   */
  fabricationFloor?: number
  /**
   * Sub-gate, OPTIONAL: the share of emitted medication items whose `text` is a drug name and
   * nothing else.
   *
   * Optional because a pack whose tasks emit no medication has nothing to gate, and because the
   * three floors above were measured before this axis existed — a corpus that adds it should
   * measure it before declaring a number, exactly as those were. Omitted, the rate is still
   * COMPUTED AND PRINTED; it just does not decide the verdict. That asymmetry is deliberate: an
   * axis nobody can see is an axis nobody fixes, and this one was invisible for long enough to
   * let four interventions be evaluated against a scorer blind to it.
   */
  medicationNameFloor?: number
}

export interface FormatCases extends QuotedSetCases {
  cases: FormatCase[]
}

export const loadFormatCases = (pack: Pack): FormatCases => {
  const raw = pack.json<FormatCases>('noteFormatCases')
  checkQuotedFloors(pack, 'noteFormatCases', raw)
  for (const c of raw.cases) {
    checkDifficulty(c.name, c.difficulty)
    if (!c.source) throw new Error(`note-format case '${c.name}' names no source note`)
    checkSetFields(c.name, c.fields, FORMAT_FIELDS)
  }
  return raw
}

/** The four floors a quoted set task gates on, checked once for both tasks that have them. */
const checkQuotedFloors = (pack: Pack, file: string, raw: QuotedSetCases): void => {
  for (const [key, value] of [
    ['itemRecallFloor', raw.itemRecallFloor],
    ['quoteFloor', raw.quoteFloor],
    ['derivationFloor', raw.derivationFloor],
  ] as const) {
    checkFloor(pack, file, key, value)
  }
  // Optional, so it is checked only when declared — but a DECLARED floor that is not a number
  // is a typo that would gate on `undefined`, which is false, which fails the run and names
  // nothing.
  if (raw.medicationNameFloor !== undefined) {
    checkFloor(pack, file, 'medicationNameFloor', raw.medicationNameFloor)
  }
  if (raw.fabricationFloor === undefined) return
  checkFloor(pack, file, 'fabricationFloor', raw.fabricationFloor)
  if (raw.fabricationFloor < raw.quoteFloor) {
    // Not a matter of taste. Every strictly-verified quote is also un-fabricated, so the
    // fabrication rate is always at least the verification rate: a fabrication floor BELOW
    // the quote floor can never be the binding one, and a pack that wrote the two numbers
    // that way meant the opposite of what it said.
    throw new Error(
      `pack '${pack.name}': ${file} sets fabricationFloor ${raw.fabricationFloor} below quoteFloor ` +
        `${raw.quoteFloor} — the fabrication rate is always at least the verification rate, so this gate could never bind`,
    )
  }
}

// --- Dictated transcripts -----------------------------------------------------------------

/**
 * One dictation. Same expectations as a format case and no `source`, because the document IS
 * the case: transcripts are read through the `transcript` documents kind by the case's own
 * name, and there is no written note they correspond to.
 */
export interface TranscriptCase {
  name: string
  class: string
  difficulty: number
  note?: string
  fields: SetExpectation[]
}

export interface TranscriptCases extends QuotedSetCases {
  cases: TranscriptCase[]
}

export const loadTranscriptCases = (pack: Pack): TranscriptCases => {
  const raw = pack.json<TranscriptCases>('transcriptCases')
  checkQuotedFloors(pack, 'transcriptCases', raw)
  for (const c of raw.cases) {
    checkDifficulty(c.name, c.difficulty)
    checkSetFields(c.name, c.fields, FORMAT_FIELDS)
  }
  return raw
}

// --- Checks the loaders share ---------------------------------------------------------------

/**
 * Every expectation must name a section the contract actually has.
 *
 * The vital-signs loader has always refused an unknown field, and these two did not — a gap
 * that was quiet in exactly the wrong direction. `scoreSet` reads `got[e.field] ?? []`, so a
 * mistyped field on a `present` expectation merely fails, which someone would notice; on an
 * `absent` or `empty` one it is scored as SATISFIED, for ever, in silence. The hallucination
 * check the pack author wrote simply never runs, and the report says the model behaved.
 */
const checkSetFields = (name: string, fields: SetExpectation[], known: readonly string[]): void => {
  for (const e of fields) {
    if (!known.includes(e.field)) {
      throw new Error(
        `case '${name}' expects field '${e.field}', which this task's contract does not define ` +
          `(sections: ${known.join(', ')})`,
      )
    }
  }
}

/** The sections each set task grades, from the parser that reads its replies. */
const FORMAT_FIELDS: readonly string[] = ['presenting_complaint', ...FORMAT_LIST_FIELDS]

/**
 * A floor is the whole point of a case file, so a missing one is a setup error rather than a
 * comparison against `undefined` — which is false, fails the run, and names nothing.
 */
const checkFloor = (pack: Pack, file: string, key: string, value: unknown): void => {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
    throw new Error(`pack '${pack.name}': ${file} declares ${key} as ${JSON.stringify(value)}; a floor is a number 0-1`)
  }
}

/** Shared by all three case loaders, so a task cannot quietly opt out of being rated. */
const checkDifficulty = (name: string, difficulty: unknown): void => {
  if (!Number.isInteger(difficulty) || (difficulty as number) < DIFFICULTY_MIN || (difficulty as number) > DIFFICULTY_MAX) {
    throw new Error(
      `case '${name}' has difficulty ${JSON.stringify(difficulty)}; ` +
        `every case needs an integer ${DIFFICULTY_MIN}-${DIFFICULTY_MAX} rating how hard its NOTE is to read`,
    )
  }
}

// --- Denominators ---------------------------------------------------------------------------

/** The gated denominator for a set-extraction task: `present` expectations. */
export const requiredSetExpectations = (cases: { fields: SetExpectation[] }[]): number =>
  cases.reduce((n, c) => n + c.fields.filter((f) => f.expect.kind === 'present').length, 0)

/** The gated denominator: expectations the model must extract (`value` or `bp`). */
export const gradedExpectations = (cases: VitalCase[]): number =>
  cases.reduce((n, c) => n + c.fields.filter((f) => f.expect.kind === 'value' || f.expect.kind === 'bp').length, 0)
