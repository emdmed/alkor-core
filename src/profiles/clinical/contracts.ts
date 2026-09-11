/**
 * The clinical profile's contracts: what one pass SENDS, assembled from the pack.
 *
 * Everything vital-signs-shaped lives here rather than in `src/core/`: the gradeable slot
 * list, the per-task sampling key, the prompt-and-schema pairing each task is run under.
 * Core hands this module a `Pack` and knows nothing else about the domain.
 *
 * This file is one third of what the pack reading used to be, and the split is by question
 * rather than by size. `settings.ts` holds what the pack DECLARES and the refusals that make
 * a declaration trustworthy; this file assembles requests out of what survived; `cases.ts`
 * loads the answer keys those requests are graded against. The dependency runs one way —
 * cases may know about a slot list, contracts never know about a case.
 *
 * **A contract is a row in `CONTRACTS`, not a function.** That is the one structural
 * difference from how this file was first built. Six contracts each used to spell out their
 * own prompt key, schema key, golden key, label field and sampling key across five separate
 * places — a `SAMPLING_KEY` map, a `DOCUMENT_KIND` map, an accessor triple, a `*Request`
 * builder and, for the two optional ones, a hand-copied refusal. Adding a seventh meant
 * finding all five, and the failure mode of missing one is not a compile error: a contract
 * wired to another's sampling key runs at the wrong cap and reports a number for it.
 *
 * It is the same argument the slot list below already makes one level down. A hardcoded list
 * of nine field names is a second statement of something the schema already says; six
 * hand-written builders are a second statement of something the manifest already says.
 *
 * **The slot list is derived from the schema, not written down here.** A hardcoded list is
 * the one order that is load-bearing for the grammar, stated twice, and two statements that
 * can disagree is how a denominator goes quietly wrong: the eval keeps reporting a
 * percentage, just of the wrong total. Deriving it also means a pack can add a tenth vital
 * sign by editing its schema and its cases, without touching this repository.
 *
 * What makes a property gradeable is its SHAPE, not its name: a slot is a reading if its
 * schema is `anyOf` with a `$ref` in it. `extraction_confidence` is a bare number and
 * `notes` is a nullable string, so both fall out as metadata without either being named.
 */
import { type Pack } from '../../core/pack.ts'
import { ProfileError } from '../../core/profile.ts'
import {
  detectLanguage,
  isDialogue,
  isRoutedPromptKey,
  loadSampling,
  loadSettings,
  type RoutedPromptKey,
  type Sampling,
  type SchemaNameField,
} from './settings.ts'

/** How a reading is shaped. A blood pressure is one reading with two numbers, not two. */
export type FieldShape = 'measurement' | 'bloodPressure'

export interface GradedField {
  name: string
  shape: FieldShape
}

// --- The contract table -------------------------------------------------------------------

/**
 * One contract, as the five manifest facts a pass needs to be assembled from.
 *
 * Everything a contract IS lives in one row: which prompt it reads, which schema constrains
 * it, which golden pins that schema's bytes, which label goes in the request body, and which
 * `[sampling.*]` table sets its cap. Nothing else in this file may name those keys.
 */
export interface ContractSpec {
  /** The contract's own name, used in refusals. Four of the six are also `--task` words. */
  id: string
  /**
   * Pack file key of the default prompt — and, when the format has a table for it, the name
   * of that table too. `isRoutedPromptKey` is what decides which, so the routing a contract
   * gets is a property of the pack format rather than a second declaration here.
   */
  promptKey: string
  /**
   * The prompt this contract takes when its input is a two-speaker consultation rather than a
   * dictation. Only the transcript contract has one: a dialogue is not a separate contract —
   * same schema, same label, same cap — it is the same contract asked in a different voice.
   */
  dialoguePromptKey?: RoutedPromptKey
  /** Pack file key of the JSON Schema. Two contracts legitimately name the same one. */
  schemaKey: string
  /** Pack file key of the golden serialization that pins that schema's bytes. */
  goldenKey: string
  /** Which `[clinical].*SchemaName` supplies `json_schema.name` for this contract. */
  schemaNameField: SchemaNameField
  /** The `[sampling.*]` table. A manifest key, deliberately not the same word as `id`. */
  samplingKey: string
  /**
   * Which `documents` kind this contract's input comes from. Absent for the two passes that
   * have no corpus of their own — they read the transcript their caller already had.
   */
  documentKind?: string
  /**
   * A contract a pack may legitimately not have. Absence is reported as "no such pass",
   * which is a state every caller already handles, because it is the state every pack was in
   * before the contract existed. A REQUIRED contract's label is checked by `loadSettings`
   * instead, at load, so a pack missing one never reaches assembly.
   */
  optional?: boolean
}

/**
 * Every contract this profile knows how to send, keyed by name.
 *
 * The four with a `documentKind` are the graded tasks; the two without are second calls
 * inside the transcript task. Neither of those is in `TASKS`, because nothing invokes them by
 * name, they have no corpus of their own and they produce no score of their own — putting
 * them there would add words to `--task` that nobody can run.
 */
export const CONTRACTS = {
  'vital-signs': {
    id: 'vital-signs',
    promptKey: 'vitalSignsPrompt',
    schemaKey: 'vitalSignsSchema',
    goldenKey: 'vitalSignsSchemaGolden',
    schemaNameField: 'vitalSignsSchemaName',
    samplingKey: 'vital_signs',
    documentKind: 'default',
  },
  summary: {
    id: 'summary',
    promptKey: 'summaryPrompt',
    schemaKey: 'summarySchema',
    goldenKey: 'summarySchemaGolden',
    schemaNameField: 'summarySchemaName',
    samplingKey: 'patient_summary',
    documentKind: 'default',
  },
  'note-format': {
    id: 'note-format',
    promptKey: 'noteFormatPrompt',
    schemaKey: 'noteFormatSchema',
    goldenKey: 'noteFormatSchemaGolden',
    schemaNameField: 'noteFormatSchemaName',
    samplingKey: 'note_format',
    documentKind: 'default',
  },
  /**
   * The dictated-transcript task: its own prompt, label and cap, the note-format SCHEMA.
   *
   * Sharing the schema is the design rather than a saving. The two tasks answer the same
   * question about the same encounter — what are the four sections a clinician reads — and the
   * only thing that differs is whether the source was typed or spoken. A second schema would be
   * a second statement of one contract, free to drift in property order, which is the one part
   * of it that is compiled into a grammar. The LABEL is its own, so a server log can still say
   * which of the two tasks produced a completion.
   */
  transcript: {
    id: 'transcript',
    promptKey: 'transcriptPrompt',
    dialoguePromptKey: 'dialoguePrompt',
    schemaKey: 'noteFormatSchema',
    goldenKey: 'noteFormatSchemaGolden',
    schemaNameField: 'transcriptSchemaName',
    samplingKey: 'transcript',
    documentKind: 'transcript',
  },
  /** The medication pass: the same transcript, asked for one section. */
  medication: {
    id: 'medication',
    promptKey: 'medicationPrompt',
    schemaKey: 'medicationSchema',
    goldenKey: 'medicationSchemaGolden',
    schemaNameField: 'medicationSchemaName',
    samplingKey: 'medication',
    optional: true,
  },
  /**
   * The shock-category pass: a fixed examination payload in, a category out.
   *
   * The first contract in this table that extracts nothing, and the row is unremarkable
   * because of it — which is the argument for the table. A contract whose input is a closed
   * set of findings rather than prose, whose reply is graded against a rule in code rather
   * than a hand-written key, and whose corpus is JSON rather than notes, still declares the
   * same five facts in the same five columns, and needed no new concept anywhere in assembly.
   *
   * Its `documentKind` is `exam`, so the harness reads exams/{case}.exam.json; what reaches the
   * model is `renderExam`'s rendering of that file, not the file. The rendering lives in
   * shock.ts for the reason [clinical.summaryAssembly] exists — two runtimes that render the
   * same findings differently grade different inputs while appearing to share a prompt.
   */
  shock: {
    id: 'shock',
    promptKey: 'shockPrompt',
    schemaKey: 'shockSchema',
    goldenKey: 'shockSchemaGolden',
    schemaNameField: 'shockSchemaName',
    samplingKey: 'shock',
    documentKind: 'exam',
  },
  /**
   * The sepsis-screening pass: a fixed Quick SOFA payload in, whether the screen is positive out.
   *
   * The second contract in this table that extracts nothing, and it shares the shock contract's
   * shape for the same reason they are separate: a closed payload of already-decided numerics in,
   * a verdict out, with the numeric screen computed by the medprotocol CLI and the model graded
   * against it. Its `documentKind` is `exam`, so the harness reads exams/{case}.exam.json; what
   * reaches the model is `renderSepsis`'s rendering of that file, not the file, for the same
   * reason shock's rendering lives in code and not in the eval.
   */
  sepsis: {
    id: 'sepsis',
    promptKey: 'sepsisPrompt',
    schemaKey: 'sepsisSchema',
    goldenKey: 'sepsisSchemaGolden',
    schemaNameField: 'sepsisSchemaName',
    samplingKey: 'sepsis',
    documentKind: 'exam',
  },
  /**
   * The shock-extraction pass: a free-text clinical note in, the structured ShockExam payload
   * the reasoning contract consumes out. This is the upstream half of a pipeline that ends
   * with the shock task: prose → extraction → reasoning. It shares the same output shape as
   * the exam files, and the downstream contract reads the same schema-shaped bytes whether
   * they were written by a human or extracted by this pass.
   */
  'shock-extraction': {
    id: 'shock-extraction',
    promptKey: 'shockExtractionPrompt',
    schemaKey: 'shockExtractionSchema',
    goldenKey: 'shockExtractionSchemaGolden',
    schemaNameField: 'shockExtractionSchemaName',
    samplingKey: 'shock_extraction',
    documentKind: 'default',
  },
  /**
   * The sepsis-extraction pass: a free-text clinical note in, the SepsisExam payload the
   * screening contract consumes out. It stands to `sepsis` exactly as `shock-extraction`
   * stands to `shock`, and it exists for a reason the router made unavoidable: `reviewSepsis`
   * calls `parseSepsis`, which requires all three qSOFA numbers, so a note routed straight to
   * the screening contract does not screen a patient — it throws. Prose reaches qSOFA through
   * here or it does not reach it at all.
   *
   * It cannot borrow the shock extraction's output either, and that is worth stating because
   * the two passes read the same note: `ShockExam` carries a systolic, but it carries no
   * respiratory rate and no GCS, and a screen missing two of its three criteria is a screen
   * that never ran.
   */
  'sepsis-extraction': {
    id: 'sepsis-extraction',
    promptKey: 'sepsisExtractionPrompt',
    schemaKey: 'sepsisExtractionSchema',
    goldenKey: 'sepsisExtractionSchemaGolden',
    schemaNameField: 'sepsisExtractionSchemaName',
    samplingKey: 'sepsis_extraction',
    documentKind: 'default',
  },
  /**
   * The shock-pipeline pass: prose note → extraction → shock classification, end-to-end.
   *
   * Chains two LLM calls under one `--task` flag: the extraction contract produces a
   * ShockExam payload, and the shock contract classifies it. What is graded is the FINAL
   * category agreement — extraction errors that cause a wrong category are counted as a
   * single pipeline failure. A sub-gate on exact-match extraction measures whether the
   * pipeline fails because the model cannot read prose or because it cannot apply the rule.
   *
   * Its own `samplingKey` and `schemaNameField` are unique by the tasks.test.ts contract.
   * The prompt, schema and golden keys resolve to the existing shock pack files — the
   * pipeline reuses the shock contracts, not new ones.
   */
  'shock-pipeline': {
    id: 'shock-pipeline',
    promptKey: 'shockPrompt',
    schemaKey: 'shockSchema',
    goldenKey: 'shockSchemaGolden',
    schemaNameField: 'shockPipelineSchemaName',
    samplingKey: 'shock_pipeline',
    documentKind: 'default',
  },
  /** The repair pass: the failed items of a reading, handed back with the transcript. */
  'transcript-repair': {
    id: 'transcript-repair',
    promptKey: 'transcriptRepairPrompt',
    schemaKey: 'transcriptRepairSchema',
    goldenKey: 'transcriptRepairSchemaGolden',
    schemaNameField: 'transcriptRepairSchemaName',
    samplingKey: 'transcript_repair',
    optional: true,
  },
} as const satisfies Record<string, ContractSpec>

// --- The tasks, as a view of the table ----------------------------------------------------

/**
 * The graded tasks, in the order a pack author meets them.
 *
 * `shock` is last and is the only one that is not an extraction. It is in this list rather
 * than beside it because `--task all` has to reach it: a graded task nobody can run is a
 * contract that sits looking complete and reports nothing, which is the state it was in for
 * exactly as long as it took to write an eval mode for it.
 */
export type Task = 'vital-signs' | 'summary' | 'note-format' | 'transcript' | 'shock' | 'shock-extraction' | 'shock-pipeline' | 'sepsis' | 'sepsis-extraction'
export const TASKS: Task[] = ['vital-signs', 'summary', 'note-format', 'transcript', 'shock', 'shock-extraction', 'shock-pipeline', 'sepsis', 'sepsis-extraction']

/**
 * Tasks that are REVIEWABLE but not GRADED: the profile can run them over a document, and no
 * eval mode scores them, because the pack declares no answer key for them.
 *
 * Stated here, once, because two things read it and they must not disagree: `--task all`
 * skips these rather than dying on them, and the eval dispatch refuses them by name rather
 * than by falling off the end of its chain into whatever branch happens to be last.
 *
 * `sepsis-extraction` is the first and currently the only member. It ships a prompt, a schema
 * and a parser, and the routed task runs it — but nobody has measured whether a small
 * model reads three qSOFA numbers off prose correctly, so it reports no percentage. The day a
 * corpus arrives, it comes off this list in the same commit as its eval.
 */
export const UNGRADED_TASKS: Task[] = ['sepsis-extraction']

/** The tasks `--task all` runs: every task that can actually report a number. */
export const GRADED_TASKS: Task[] = TASKS.filter((t) => !UNGRADED_TASKS.includes(t))

/**
 * The tasks that are DOCUMENT TOOLING rather than clinical questions.
 *
 * Transcribing a consultation, laying a note out in four sections, and summarising a record
 * are things you do TO a document. None of them names a syndrome, decides a diagnosis, or
 * has a clinical answer to be right or wrong about — the run ends with a formatted document,
 * not with something established about the patient. So the router does not select them:
 * routing is the question "what does this document raise about this patient", and a document
 * being a dialogue is an answer to a different question entirely.
 *
 * They are NOT removed, and the distinction matters. Each keeps its contract, its corpus,
 * its eval and its stages, and each remains runnable by name — `--task transcript` is how a
 * caller who wants a transcript asks for one, and `--task all` still grades them. What they
 * lost is the ability to be chosen FOR a caller by the clinical router.
 *
 * The consequence worth stating is what now happens to a consultation: it is routed by what
 * it says. A dialogue in which a patient is hypotensive and tachycardic used to be
 * transcribed and nothing else, because modality won outright; it now runs the front door
 * and reaches the shock arm like any other prose that states those two findings.
 */
export const TOOLING_TASKS: Task[] = ['summary', 'note-format', 'transcript']

/** Every task that answers a clinical question — the complement of `TOOLING_TASKS`. */
export const CLINICAL_TASKS: Task[] = TASKS.filter((t) => !TOOLING_TASKS.includes(t))

export type ClinicalShape = 'exam-json' | 'qsofa-json' | 'shock-suspicion' | 'sepsis-suspicion' | 'vitals-note' | 'note'

/**
 * The task each shape routes to.
 *
 * Every shape here is a clinical question or the prose that raises one. The three modality
 * shapes this table used to carry — `dialogue`, `dictation`, `summary-input` — are gone with
 * the tooling tasks they pointed at: see `TOOLING_TASKS`. A document's modality decides which
 * PROMPT a contract takes (`[clinical.dialogueDetection]`, read in `settings.ts`), which is
 * where that fact was always load-bearing; it no longer decides which question is asked.
 */
export const DEFAULT_TASK_FOR_SHAPE: Record<ClinicalShape, Task> = {
  'exam-json': 'shock',
  'qsofa-json': 'sepsis',
  'shock-suspicion': 'shock-extraction',
  'sepsis-suspicion': 'sepsis-extraction',
  'vitals-note': 'vital-signs',
  note: 'vital-signs',
}

/**
 * Which task consumes which other task's output, when prose takes the long path.
 *
 * The two prose arms are two-contract workflows: extract the closed payload first, then hand
 * that payload to the contract that reasons over it. A structured payload — an exam or a
 * qSOFA screen — enters the downstream contract directly, which is why the downstream task
 * remains a valid entry of its own rather than being folded into its extraction.
 *
 * One statement, because the router walks it to expand a plan and the topology draws it as
 * an edge, and a graph that disagreed with the plan would be drawing a chain nobody runs.
 */
export const TASK_FEEDS: Partial<Record<Task, Task>> = {
  'shock-extraction': 'shock',
  'sepsis-extraction': 'sepsis',
}

/**
 * Dependency order over the tasks: what a multi-question plan runs first.
 *
 * Read by the router to sort a plan and by the topology to order the route fan, so the
 * picture a reader sees is the order the work happens in.
 */
export const TASK_ORDER: Task[] = [
  'shock-extraction',
  'shock',
  'sepsis-extraction',
  'sepsis',
  'vital-signs',
]

/**
 * Tasks the profile can GRADE but cannot RUN over one document.
 *
 * Summary reads a whole record assembled from many notes, so `extract` refuses it by name.
 * It is tooling and therefore not a route either, so this no longer has a drawn route to
 * agree with — it is now only the refusal, stated once, where `review` reads it.
 */
export const UNREVIEWABLE_TASKS: Task[] = ['summary']

/**
 * Every task the internal router can select, in dependency order.
 *
 * Derived rather than listed: a shape's task and whatever that task feeds. This is the
 * profile's route fan — adding a shape adds a route without anyone remembering to, and no
 * tooling task can appear in it, because no shape names one.
 */
export const ROUTED_TASKS: Task[] = (() => {
  const entry = [...new Set(Object.values(DEFAULT_TASK_FOR_SHAPE))]
  const reached = new Set<Task>()
  for (const task of entry) {
    let current: Task | undefined = task
    while (current && !reached.has(current)) {
      reached.add(current)
      current = TASK_FEEDS[current]
    }
  }
  return [...reached].sort((a, b) => TASK_ORDER.indexOf(a) - TASK_ORDER.indexOf(b))
})()

/**
 * The `[sampling.*]` key each task reads. Separate from the task name because one is a
 * command-line word and the other is a manifest key, and a rename of either is not a rename
 * of the other — but read off the contract rather than restated, so the two cannot drift.
 */
export const SAMPLING_KEY: Record<Task, string> = Object.fromEntries(
  TASKS.map((t) => [t, CONTRACTS[t].samplingKey]),
) as Record<Task, string>

/** The `[sampling.*]` key the repair pass reads. */
export const REPAIR_SAMPLING_KEY = CONTRACTS['transcript-repair'].samplingKey

/** The `[sampling.*]` key the medication pass reads. */
export const MEDICATION_SAMPLING_KEY = CONTRACTS.medication.samplingKey

/**
 * Which `documents` kind a task's input comes from — the manifest table added in spec 3.
 *
 * Three tasks read written notes and one reads dictated transcripts, and the two corpora are
 * not interchangeable. Read off the contract rather than decided inside each eval so that a
 * task cannot quietly read the wrong corpus: a transcript case whose name collides with a note
 * would otherwise grade a written note against a dictation answer key and report a number.
 */
export const DOCUMENT_KIND: Record<Task, string> = Object.fromEntries(
  TASKS.map((t) => [t, CONTRACTS[t].documentKind]),
) as Record<Task, string>

// --- The schema, and the slots it defines ---------------------------------------------

interface SchemaShape {
  properties?: Record<string, { anyOf?: { $ref?: string }[] }>
}

/**
 * The gradeable slots, in SCHEMA order — which is the order the grammar makes the model
 * emit them, so it is also the order everything downstream should read them in.
 */
export const gradedFields = (pack: Pack): GradedField[] => {
  const schema = pack.json<SchemaShape>(CONTRACTS['vital-signs'].schemaKey)
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

// --- Assembly -------------------------------------------------------------------------

/**
 * Everything one pass needs, assembled in ONE place.
 *
 * Both callers go through this: the eval that produces a number and the review that produces
 * a reading for a document somebody actually has. That is the point of it existing. If the
 * two assembled their own prompt, schema and cap, the measured path and the used path could
 * drift apart by a line — and the harness's whole claim is that the number describes the
 * thing production runs, not something near it.
 */
export interface TaskRequest {
  prompt: string
  /** Absent when the caller asked for the unconstrained arm. */
  schema?: object
  schemaName: string
  sampling: Sampling
}

/** The vital-signs pass, which also carries the slot list its scorer grades against. */
export interface VitalRequest extends TaskRequest {
  fields: GradedField[]
}

/**
 * Assemble one contract into one request.
 *
 * `constrain` is honoured rather than assumed, for every contract including the two passes.
 * An unconstrained arm exists to measure what the grammar is worth, and a pass that quietly
 * forced a schema would make that arm report a number about a run nobody can reproduce
 * without it.
 *
 * `text` is the input the prompt may be routed by — a transcript, for the contracts whose
 * prompt has a language or a shape variant. Omitted, every contract resolves to its default
 * prompt, which is what this profile did before routing existed.
 */
export const buildRequest = (
  spec: ContractSpec,
  pack: Pack,
  constrain: boolean,
  text?: string,
): TaskRequest => ({
  prompt: promptFor(spec, pack, text),
  schema: constrain ? pack.json<object>(spec.schemaKey) : undefined,
  schemaName: schemaNameFor(spec, pack),
  sampling: loadSampling(pack, spec.samplingKey),
})

/**
 * The label that goes in the request body, or a refusal naming the contract that wanted it.
 *
 * A required contract cannot reach this without a label — `loadSettings` refuses the pack at
 * load — so in practice this fires for the two optional ones, where a pack has committed the
 * prompts and not the label. Refused rather than defaulted, because a label the two runtimes
 * guess differently is a pinned body they disagree about, for no reason a reader could find.
 */
const schemaNameFor = (spec: ContractSpec, pack: Pack): string => {
  const name = loadSettings(pack)[spec.schemaNameField]
  if (!name) {
    throw new ProfileError(
      `pack '${pack.name}' declares ${spec.id} prompts but no ${spec.schemaNameField} — ` +
        'the label is part of the request body, and two runtimes that guess it differently ' +
        'pin different bytes for the same contract',
    )
  }
  return name
}

/**
 * The prompt a contract takes for this input: shape first, then language.
 *
 * A consultation with two speakers is a different input from a dictation — the facts are not
 * all in the record-keeper's voice — and the two families of prompt say different things about
 * corrections, questions and what a turn is worth. The language table then picks a member of
 * whichever family the shape chose.
 *
 * Both fall back rather than fail. A pack that declares the dialogue detector without shipping
 * the prompt gets the dictation one; a language table naming a file the pack ships without gets
 * the default. The fallback for everything this routing cannot answer is what the contract did
 * before it had any.
 */
const promptFor = (spec: ContractSpec, pack: Pack, text?: string): string => {
  if (spec.dialoguePromptKey && text !== undefined && isDialogue(pack, text) && pack.has(spec.dialoguePromptKey)) {
    return promptForLanguage(pack, spec.dialoguePromptKey, text)
  }
  return isRoutedPromptKey(spec.promptKey) ? promptForLanguage(pack, spec.promptKey, text) : pack.read(spec.promptKey)
}

/**
 * A prompt file key, resolved through the language table that names it.
 *
 * `defaultKey` is both the fallback and the name of the table: the pack keys its per-language
 * variants under the same word the default file is filed under, so one string answers "which
 * table" and "what if it says nothing", and the two cannot be wired to disagree.
 */
const promptForLanguage = (pack: Pack, defaultKey: RoutedPromptKey, text?: string): string => {
  const byLang = loadSettings(pack).languageDetection?.[defaultKey]
  if (!byLang || text === undefined) return pack.read(defaultKey)
  const lang = detectLanguage(pack, text)
  const key = lang ? byLang[lang] : undefined
  // `has` rather than a bare read: a language table may name a key whose file a pack ships
  // without, and falling back is the behaviour the table's comment promises.
  return pack.read(key && pack.has(key) ? key : defaultKey)
}

/**
 * Whether a pack has an OPTIONAL contract at all.
 *
 * All three file keys plus the label, not one: a pack half-way through gaining the contract —
 * prompt committed, schema not — would otherwise pass a one-key check and fail at assembly, in
 * the middle of a run, on a transcript.
 */
export const hasContract = (spec: ContractSpec, pack: Pack): boolean =>
  pack.has(spec.promptKey) &&
  pack.has(spec.schemaKey) &&
  pack.has(spec.goldenKey) &&
  Boolean(loadSettings(pack)[spec.schemaNameField])

// --- The named entry points -----------------------------------------------------------
//
// One line each, over the table above. They exist because a caller reaching for the repair
// pass should not have to know it is spelled `transcript-repair`, and because a name in a
// stack trace is worth more than a key lookup — not because any of them does anything the
// row does not already say.

export const vitalSchema = (pack: Pack): object => pack.json<object>(CONTRACTS['vital-signs'].schemaKey)
export const vitalSchemaGolden = (pack: Pack): string => pack.read(CONTRACTS['vital-signs'].goldenKey)
export const vitalPrompt = (pack: Pack): string => pack.read(CONTRACTS['vital-signs'].promptKey)

export const vitalRequest = (pack: Pack, constrain: boolean): VitalRequest => ({
  ...buildRequest(CONTRACTS['vital-signs'], pack, constrain),
  fields: gradedFields(pack),
})

export const summarySchema = (pack: Pack): object => pack.json<object>(CONTRACTS.summary.schemaKey)
export const summarySchemaGolden = (pack: Pack): string => pack.read(CONTRACTS.summary.goldenKey)
export const summaryPrompt = (pack: Pack): string => pack.read(CONTRACTS.summary.promptKey)

export const summaryRequest = (pack: Pack, constrain: boolean): TaskRequest =>
  buildRequest(CONTRACTS.summary, pack, constrain)

export const formatSchema = (pack: Pack): object => pack.json<object>(CONTRACTS['note-format'].schemaKey)
export const formatSchemaGolden = (pack: Pack): string => pack.read(CONTRACTS['note-format'].goldenKey)
export const formatPrompt = (pack: Pack): string => pack.read(CONTRACTS['note-format'].promptKey)

export const formatRequest = (pack: Pack, constrain: boolean): TaskRequest =>
  buildRequest(CONTRACTS['note-format'], pack, constrain)

/**
 * The transcript prompt, chosen by the shape and the language of the transcript itself.
 *
 * A prompt is instructions in some language, and a small model under pressure answers in the
 * language it was instructed in. The rule "the transcript decides the language" holds while
 * every item is a quote with words DELETED — and stops holding the moment the model invents an
 * item, because invented text has no quote to stay in the language of. `tr-es-13-control` is
 * that case: the observed failure is a plan item nobody dictated, arriving in English out of a
 * Spanish consultation.
 */
export const transcriptPrompt = (pack: Pack, transcript?: string): string =>
  promptFor(CONTRACTS.transcript, pack, transcript)

export const transcriptRequest = (pack: Pack, constrain: boolean, transcript?: string): TaskRequest =>
  buildRequest(CONTRACTS.transcript, pack, constrain, transcript)

export const medicationSchema = (pack: Pack): object => pack.json<object>(CONTRACTS.medication.schemaKey)
export const medicationSchemaGolden = (pack: Pack): string => pack.read(CONTRACTS.medication.goldenKey)

/** The medication prompt, routed by language exactly as the other three families are. */
export const medicationPrompt = (pack: Pack, transcript?: string): string =>
  promptFor(CONTRACTS.medication, pack, transcript)

export const hasMedicationContract = (pack: Pack): boolean => hasContract(CONTRACTS.medication, pack)

export const medicationRequest = (pack: Pack, constrain: boolean, transcript?: string): TaskRequest =>
  buildRequest(CONTRACTS.medication, pack, constrain, transcript)

/**
 * Does THIS transcript take the second call?
 *
 * Shape is decided by the pack's own dialogue detector, and the answer by the pack's own list
 * of shapes — so the eval and the consuming application ask one question of one contract. A
 * runtime that decided this for itself would ship the pass over consultations, where it is
 * measurably worse, while the eval reported the dictation numbers.
 */
export const takesMedicationPass = (pack: Pack, transcript: string): boolean => {
  if (!hasMedicationContract(pack)) return false
  const shapes = loadSettings(pack).medicationPass?.shapes
  if (!shapes?.length) return false
  return shapes.includes(isDialogue(pack, transcript) ? 'dialogue' : 'dictation')
}

export const repairSchema = (pack: Pack): object => pack.json<object>(CONTRACTS['transcript-repair'].schemaKey)
export const repairSchemaGolden = (pack: Pack): string => pack.read(CONTRACTS['transcript-repair'].goldenKey)

/**
 * The repair prompt, chosen by the same detector over the same transcript.
 *
 * Deliberately routed by the TRANSCRIPT and not by the language of the first pass's output.
 * The reading being repaired may be in the wrong language — that is one of the failures this
 * pack has measured — and routing off it would send the repair after a translation in the
 * language of the translation, which is the one way to make the fault permanent.
 */
export const transcriptRepairPrompt = (pack: Pack, transcript?: string): string =>
  promptFor(CONTRACTS['transcript-repair'], pack, transcript)

export const hasRepairContract = (pack: Pack): boolean => hasContract(CONTRACTS['transcript-repair'], pack)

export const repairRequest = (pack: Pack, constrain: boolean, transcript?: string): TaskRequest =>
  buildRequest(CONTRACTS['transcript-repair'], pack, constrain, transcript)
