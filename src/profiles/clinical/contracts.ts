/**
 * The clinical profile's reading of its contract pack.
 *
 * Everything vital-signs-shaped lives here rather than in `src/core/`: the gradeable slot
 * list, the case format, the per-task sampling. Core hands this module a `Pack` and knows
 * nothing else about the domain.
 *
 * **The slot list is derived from the schema, not written down here.** That is the one
 * structural difference from how this task was first built, and it is deliberate. A
 * hardcoded list of nine field names is a second statement of something the schema already
 * says — in the one order that is load-bearing for the grammar — and two statements that
 * can disagree is how a denominator goes quietly wrong: the eval keeps reporting a
 * percentage, just of the wrong total. Deriving it also means a pack can add a tenth vital
 * sign by editing its schema and its cases, without touching this repository.
 *
 * What makes a property gradeable is its SHAPE, not its name: a slot is a reading if its
 * schema is `anyOf` with a `$ref` in it. `extraction_confidence` is a bare number and
 * `notes` is a nullable string, so both fall out as metadata without either being named.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { specGap, SPEC_VERSION, type Pack } from '../../core/pack.ts'
import { ProfileError } from '../../core/profile.ts'
import type { AssemblyRule } from '../../core/assemble.ts'
import type { DerivationRule, QuoteRule } from '../../core/verify.ts'
// The section lists live with the parsers that read them: one statement of what a task's
// reply contains, rather than a second copy here that can disagree with it.
import { FORMAT_LIST_FIELDS, SUMMARY_FIELDS } from './extraction.ts'
import { DEFAULT_SET_MATCHING, type SetMatchRule } from './set-scorer.ts'

/** How a reading is shaped. A blood pressure is one reading with two numbers, not two. */
export type FieldShape = 'measurement' | 'bloodPressure'

export interface GradedField {
  name: string
  shape: FieldShape
}

// --- [clinical] settings --------------------------------------------------------------

/** The four graded tasks, in the order a pack author meets them. */
export type Task = 'vital-signs' | 'summary' | 'note-format' | 'transcript'
export const TASKS: Task[] = ['vital-signs', 'summary', 'note-format', 'transcript']

/** The `[sampling.*]` key each task reads. Separate from the task name because one is a
 * command-line word and the other is a manifest key, and a rename of either is not a rename
 * of the other. */
export const SAMPLING_KEY: Record<Task, string> = {
  'vital-signs': 'vital_signs',
  summary: 'patient_summary',
  'note-format': 'note_format',
  transcript: 'transcript',
}

/**
 * Which `documents` kind a task's input comes from — the manifest table added in spec 3.
 *
 * Three tasks read written notes and one reads dictated transcripts, and the two corpora are
 * not interchangeable. Stated as a map rather than decided inside each eval so that a task
 * cannot quietly read the wrong corpus: a transcript case whose name collides with a note
 * would otherwise grade a written note against a dictation answer key and report a number.
 */
export const DOCUMENT_KIND: Record<Task, string> = {
  'vital-signs': 'default',
  summary: 'default',
  'note-format': 'default',
  transcript: 'transcript',
}

export interface ClinicalSettings {
  defaultTask: string
  /**
   * Does this pack's corpus consist of documents written FOR it?
   *
   * Read by the profile to decide whether trace lines may hold the completion verbatim. It
   * is deliberately not defaulted to true and deliberately not an environment variable: it is
   * a fact about the corpus, it travels with the pack to whoever runs it next, and a pack
   * that does not say is treated as real records. See profiles/clinical/redact.ts.
   */
  corpusSynthetic?: boolean
  vitalSignsSchemaName: string
  summarySchemaName: string
  noteFormatSchemaName: string
  /**
   * `json_schema.name` for the transcript task, which sends the note-format SCHEMA under a
   * label of its own. The schema is shared on purpose — a clinician reads one structure — but
   * a pinned request body that could not tell the two tasks apart would make a server log
   * useless for saying which of them produced a completion.
   */
  transcriptSchemaName: string
  quoteVerification: QuoteRule
  textDerivation: DerivationRule
  summaryAssembly: AssemblyRule
  /**
   * How a set item is matched against the answer key. OPTIONAL, unlike the three rules above,
   * and the asymmetry is deliberate.
   *
   * Those three default to nothing because a defaulted verification rule is a check nobody
   * ran — a pack whose `deletionOnly` silently came out false would report a perfect
   * derivation rate having checked nothing. This one is different: its only member is a list
   * of negators, and an ABSENT list does not fake a passing check, it makes the scan find
   * nothing and every negated item score as a find. Which is bad, but it is bad in a way a
   * default fixes rather than hides.
   *
   * So the list has a default and the default is stated in the pack format. It is English and
   * Spanish because the reference corpus is, and a pack in another language must say so —
   * see DEFAULT_NEGATORS in set-scorer.ts, where the whole argument lives.
   */
  setMatching?: SetMatchRule
}

export const loadSettings = (pack: Pack): ClinicalSettings => {
  // `[clinical]` is inert to core/pack.ts, which acts only on spec/name/files/documents/
  // include. Reading it here rather than adding a core concept keeps the harness free of
  // this domain's vocabulary, which is the arrangement's whole rule.
  const manifest = parseToml(readFileSync(join(pack.root, 'pack.toml'), 'utf8')) as { clinical?: ClinicalSettings }
  if (!manifest.clinical) throw new Error(`pack '${pack.name}' has no [clinical] table in its manifest`)
  const s = manifest.clinical
  // The verification rules are REQUIRED rather than defaulted, and this is the one place a
  // default would be actively dangerous: a pack whose `deletionOnly` silently defaulted to
  // false would report a perfect derivation rate having checked nothing, and the number
  // would look exactly like a model that never paraphrases.
  for (const [key, present] of [
    [
      'quoteVerification',
      s.quoteVerification &&
        typeof s.quoteVerification.collapseWhitespace === 'boolean' &&
        typeof s.quoteVerification.caseSensitive === 'boolean' &&
        // Required for the same reason the other two are, and added after the two quoting
        // tasks were found to be applying opposite unstated answers to it.
        typeof s.quoteVerification.accentSensitive === 'boolean',
    ],
    ['textDerivation', s.textDerivation && typeof s.textDerivation.deletionOnly === 'boolean'],
    ['summaryAssembly', s.summaryAssembly && typeof s.summaryAssembly.totalChars === 'number'],
  ] as const) {
    if (!present) {
      // Name the FORMAT VERSION, not only the key. A pack written the day before
      // `accentSensitive` became required fails here, and "a table is incomplete" leaves its
      // author to guess whether they mistyped something or whether the harness moved
      // underneath them. `specGap` answers that in the pack format's own words.
      const gap = specGap(pack.spec)
      throw new Error(
        `pack '${pack.name}': [clinical.${key}] is missing or incomplete — ` +
          'a verification rule that defaults is a check nobody ran' +
          (gap.length
            ? `\n  this pack declares spec ${pack.spec} and this harness reads spec ${SPEC_VERSION}; since then:\n` +
              gap.map((c) => `    - ${c}`).join('\n') +
              `\n  set 'spec = ${SPEC_VERSION}' in pack.toml once the keys above are present`
            : ''),
      )
    }
  }
  // A pack that DECLARES the table must fill it. An empty `negators` is not a language with no
  // negations, it is a typo, and it scores every "no diabetes" as a find.
  if (s.setMatching && !(Array.isArray(s.setMatching.negators) && s.setMatching.negators.length)) {
    throw new Error(
      `pack '${pack.name}': [clinical.setMatching] declares no negators — ` +
        'omit the table to inherit the English+Spanish default, or state the list this corpus needs',
    )
  }
  return s
}

/** The matching rule for this pack, defaulted in ONE place so no task can pick its own. */
export const setMatching = (pack: Pack): SetMatchRule => loadSettings(pack).setMatching ?? DEFAULT_SET_MATCHING

// --- models.default.toml --------------------------------------------------------------

export interface Sampling {
  temperature: number
  max_tokens: number
  timeout_secs: number
}

/**
 * Per-task sampling, from the same declaration a consuming application would seed from.
 *
 * Not defaulted: the harness's own cap is a backstop sized for an unbounded array, and a
 * pack whose application runs a smaller one must be measured at the cap it runs, or a
 * truncation that happens in production cannot happen in the eval. Reading it is the
 * difference between measuring the product and measuring something near it.
 */
export const loadSampling = (pack: Pack, task: string): Sampling => {
  const models = pack.toml<{ sampling?: Record<string, Partial<Sampling>> }>('models')
  const s = models.sampling?.[task]
  if (!s || typeof s.max_tokens !== 'number') {
    throw new Error(
      `pack '${pack.name}' declares no [sampling.${task}] with a max_tokens in its models file — ` +
        'the harness will not guess a cap the application does not run',
    )
  }
  return { temperature: s.temperature ?? 0, max_tokens: s.max_tokens, timeout_secs: s.timeout_secs ?? 300 }
}

// --- The schema, and the slots it defines ---------------------------------------------

interface SchemaShape {
  properties?: Record<string, { anyOf?: { $ref?: string }[] }>
}

export const vitalSchema = (pack: Pack): object => pack.json<object>('vitalSignsSchema')
export const vitalSchemaGolden = (pack: Pack): string => pack.read('vitalSignsSchemaGolden')
export const vitalPrompt = (pack: Pack): string => pack.read('vitalSignsPrompt')

/**
 * Everything one vital-signs pass needs, assembled in ONE place.
 *
 * Both callers go through this: the eval that produces a number and the review that
 * produces a reading for a note somebody actually has. That is the point of it existing.
 * If the two assembled their own prompt, schema and cap, the measured path and the used
 * path could drift apart by a line — and the harness's whole claim is that the number
 * describes the thing production runs, not something near it.
 */
export interface VitalRequest {
  fields: GradedField[]
  prompt: string
  /** Absent when the caller asked for the unconstrained arm. */
  schema?: object
  schemaName: string
  sampling: Sampling
}

export const vitalRequest = (pack: Pack, constrain: boolean): VitalRequest => ({
  fields: gradedFields(pack),
  prompt: vitalPrompt(pack),
  schema: constrain ? vitalSchema(pack) : undefined,
  schemaName: loadSettings(pack).vitalSignsSchemaName,
  sampling: loadSampling(pack, SAMPLING_KEY['vital-signs']),
})

/**
 * The same assembly, for the other two tasks. One shape rather than three ad-hoc ones: a
 * task that built its own prompt/schema/cap trio would be free to differ from what an
 * application runs, which is the drift this indirection exists to prevent.
 */
export interface TaskRequest {
  prompt: string
  schema?: object
  schemaName: string
  sampling: Sampling
}

export const summaryRequest = (pack: Pack, constrain: boolean): TaskRequest => ({
  prompt: summaryPrompt(pack),
  schema: constrain ? summarySchema(pack) : undefined,
  schemaName: loadSettings(pack).summarySchemaName,
  sampling: loadSampling(pack, SAMPLING_KEY.summary),
})

export const formatRequest = (pack: Pack, constrain: boolean): TaskRequest => ({
  prompt: formatPrompt(pack),
  schema: constrain ? formatSchema(pack) : undefined,
  schemaName: loadSettings(pack).noteFormatSchemaName,
  sampling: loadSampling(pack, SAMPLING_KEY['note-format']),
})

/**
 * The dictated-transcript task: its own prompt and cap, the note-format SCHEMA.
 *
 * Sharing the schema is the design rather than a saving. The two tasks answer the same
 * question about the same encounter — what are the four sections a clinician reads — and the
 * only thing that differs is whether the source was typed or spoken. A second schema would be
 * a second statement of one contract, free to drift in property order, which is the one part
 * of it that is compiled into a grammar.
 */
export const transcriptRequest = (pack: Pack, constrain: boolean): TaskRequest => ({
  prompt: transcriptPrompt(pack),
  schema: constrain ? formatSchema(pack) : undefined,
  schemaName: loadSettings(pack).transcriptSchemaName,
  sampling: loadSampling(pack, SAMPLING_KEY.transcript),
})

/**
 * The gradeable slots, in SCHEMA order — which is the order the grammar makes the model
 * emit them, so it is also the order everything downstream should read them in.
 */
export const gradedFields = (pack: Pack): GradedField[] => {
  const schema = pack.json<SchemaShape>('vitalSignsSchema')
  const props = schema.properties
  if (!props) throw new Error(`pack '${pack.name}': the vital-signs schema declares no properties`)

  const fields: GradedField[] = []
  for (const [name, spec] of Object.entries(props)) {
    const ref = spec.anyOf?.find((a) => a.$ref)?.$ref
    if (!ref) continue // metadata: a bare number, or a nullable string
    fields.push({ name, shape: ref.endsWith('bloodPressure') ? 'bloodPressure' : 'measurement' })
  }
  if (!fields.length) {
    throw new Error(`pack '${pack.name}': no gradeable slots in the vital-signs schema — every property is metadata`)
  }
  return fields
}

// --- Cases ------------------------------------------------------------------------------

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

export const summarySchema = (pack: Pack): object => pack.json<object>('summarySchema')
export const summarySchemaGolden = (pack: Pack): string => pack.read('summarySchemaGolden')
export const summaryPrompt = (pack: Pack): string => pack.read('summaryPrompt')

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
}

export interface FormatCases extends QuotedSetCases {
  cases: FormatCase[]
}

export const formatSchema = (pack: Pack): object => pack.json<object>('noteFormatSchema')
export const formatSchemaGolden = (pack: Pack): string => pack.read('noteFormatSchemaGolden')
export const formatPrompt = (pack: Pack): string => pack.read('noteFormatPrompt')

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

export const transcriptPrompt = (pack: Pack): string => pack.read('transcriptPrompt')

export const loadTranscriptCases = (pack: Pack): TranscriptCases => {
  const raw = pack.json<TranscriptCases>('transcriptCases')
  checkQuotedFloors(pack, 'transcriptCases', raw)
  for (const c of raw.cases) {
    checkDifficulty(c.name, c.difficulty)
    checkSetFields(c.name, c.fields, FORMAT_FIELDS)
  }
  return raw
}

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

/** The gated denominator for a set-extraction task: `present` expectations. */
export const requiredSetExpectations = (cases: { fields: SetExpectation[] }[]): number =>
  cases.reduce((n, c) => n + c.fields.filter((f) => f.expect.kind === 'present').length, 0)

/** The gated denominator: expectations the model must extract (`value` or `bp`). */
export const gradedExpectations = (cases: VitalCase[]): number =>
  cases.reduce((n, c) => n + c.fields.filter((f) => f.expect.kind === 'value' || f.expect.kind === 'bp').length, 0)
