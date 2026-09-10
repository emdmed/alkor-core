/**
 * What a pack DECLARES: the `[clinical]` table, the per-task sampling, and the two
 * detectors those settings configure.
 *
 * Split out of `contracts.ts` because this half answers a different question. Here a pack
 * states its rules and this file refuses the incoherent ones; `contracts.ts` then assembles
 * requests out of what survived, and `cases.ts` loads the answer keys those requests are
 * graded against. Nothing in this file reads a prompt, a schema or a case.
 *
 * The detectors live here rather than beside the prompts they route because they are
 * settings-shaped: `detectLanguage` and `isDialogue` are the pack's own tables applied to a
 * string, and the validation that makes those tables trustworthy is `loadSettings` above
 * them. A detector whose markers overlapped would answer confidently and mean nothing, so
 * the refusal and the reading belong in one file.
 */
import { specGap, SPEC_VERSION, type Pack } from '../../core/pack.ts'
import type { AssemblyRule } from '../../core/assemble.ts'
import type { DerivationRule, QuoteRule } from '../../core/verify.ts'
import {
  DEFAULT_MEDICATION_NAME,
  DEFAULT_SET_MATCHING,
  type MedicationNameRule,
  type SetMatchRule,
} from './set-scorer.ts'

// --- [clinical] settings --------------------------------------------------------------

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
  /**
   * `json_schema.name` for the repair pass. OPTIONAL, and its absence is how a pack says it
   * has no repair contract: `repairRequest` refuses to assemble without it rather than
   * defaulting, because a label the two runtimes disagree about is a pinned body they
   * disagree about, for no reason a reader could ever find.
   */
  transcriptRepairSchemaName?: string
  /**
   * `json_schema.name` for the medication pass, on the same terms as the repair's: absent means
   * the pack has no medication contract, and `medicationRequest` refuses to assemble rather
   * than defaulting to a label the two runtimes would disagree about.
   */
  medicationSchemaName?: string
  /**
   * `json_schema.name` for the shock-category pass, on the same terms again: absent means the
   * pack has no shock contract, and assembly refuses rather than guessing a label.
   */
  shockSchemaName?: string
  /**
   * `json_schema.name` for the shock-extraction pass, on the same terms: absent means the pack
   * has no extraction contract, and assembly refuses rather than guessing a label.
   */
  shockExtractionSchemaName?: string
  /**
   * `json_schema.name` for the shock-pipeline pass (extraction → classification), on the same
   * terms: absent means the pack has no pipeline contract, and assembly refuses rather than
   * guessing a label.
   */
  shockPipelineSchemaName?: string
  /**
   * `json_schema.name` for the sepsis-screening pass, on the same terms: absent means the pack
   * has no sepsis contract, and assembly refuses rather than guessing a label.
   */
  sepsisSchemaName?: string
  /**
   * `json_schema.name` for the sepsis-extraction pass, on the same terms: absent means the pack
   * has no sepsis extraction contract, and assembly refuses rather than guessing a label.
   */
  sepsisExtractionSchemaName?: string
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
  /**
   * What a medication item's `text` may contain — a drug name, and nothing else.
   *
   * OPTIONAL on `setMatching`'s terms rather than `quoteVerification`'s: an absent table fakes
   * no passing check, it inherits a list. The list is the part that has to be data, and for the
   * same reason the negators are — the words that mark a dose are the language's, not this
   * code's, and a pack in a third language inheriting `mg`/`daily`/`cada` would find none of its
   * own and pass every dose-laden name.
   *
   * See DEFAULT_MEDICATION_NAME in set-scorer.ts, where the argument for the check lives.
   */
  medicationName?: MedicationNameRule
  /**
   * Which language a transcript is in, and which prompt file key that chooses.
   *
   * OPTIONAL, for the reason `setMatching` is optional rather than the reason
   * `quoteVerification` is not: an absent table fakes no check. Every transcript resolves to
   * `transcriptPrompt` and this harness measures exactly what it measured before.
   */
  languageDetection?: LanguageDetection
  /**
   * Which transcripts are conversations rather than dictations.
   *
   * OPTIONAL on the same terms as `languageDetection`, and orthogonal to it: this decides which
   * FAMILY of prompt an input takes, the language table decides which member of that family.
   * Absent, every transcript is read as a dictation and this harness measures exactly what it
   * measured before.
   */
  dialogueDetection?: DialogueDetection
  /**
   * Which input shapes take the medication pass — see `[clinical.medicationPass]`.
   *
   * OPTIONAL, and its absence turns the pass off everywhere: a transcript is read by one call
   * and this profile behaves exactly as it did before the pass existed. That is the safe
   * default in the only direction that matters, because the pass costs a second call and
   * changes what a shipped note contains.
   */
  medicationPass?: MedicationPass
}

/**
 * Which shapes take the second call. See `[clinical.medicationPass]` in pack.toml, where the
 * measurement behind the boundary is written out.
 *
 * A LIST rather than a boolean, because the question is not "on or off" — it is which of the
 * two input shapes this pack already distinguishes gains from the pass. Dictations do and
 * dialogues do not, measured; a pack whose corpus is all dictation writes `["dictation"]` and
 * gets the same behaviour without having to know why the word is there.
 */
export interface MedicationPass {
  shapes: string[]
}

/**
 * The `*SchemaName` fields, as a type a contract can name one of.
 *
 * Written out rather than derived with `keyof`, because only six of this table's fields are
 * a `json_schema.name` and a contract that could point at `quoteVerification` would be a
 * contract that typechecks into a request body nobody can read.
 */
export type SchemaNameField =
  | 'vitalSignsSchemaName'
  | 'summarySchemaName'
  | 'noteFormatSchemaName'
  | 'transcriptSchemaName'
  | 'transcriptRepairSchemaName'
  | 'medicationSchemaName'
  | 'shockSchemaName'
  | 'shockExtractionSchemaName'
  | 'shockPipelineSchemaName'
  | 'sepsisSchemaName'
  | 'sepsisExtractionSchemaName'

/**
 * The four names a pack must state, as data rather than as four type annotations.
 *
 * `ClinicalSettings` types these `string`, but a manifest is TOML read at runtime and the
 * type is a promise nothing checked: a pack that omitted `vitalSignsSchemaName` typechecked
 * fine and sent `json_schema.name: undefined`, which llama-server accepts. The label is part
 * of the pinned request body, so that is a run whose body cannot be reproduced from the pack
 * that produced it. Checked here, where every other unfillable declaration is refused.
 */
const REQUIRED_SCHEMA_NAMES: SchemaNameField[] = [
  'vitalSignsSchemaName',
  'summarySchemaName',
  'noteFormatSchemaName',
  'transcriptSchemaName',
]

/**
 * The prompt keys that may be routed by language — which is exactly the set of tables
 * `LanguageDetection` declares below, and is stated once by being read off it.
 *
 * A contract's prompt is language-routed if and only if this pack format has a table for it.
 * Two lists could disagree, and the way they would disagree is silent: a contract naming a
 * key with no table would quietly stop routing and serve the default prompt for every
 * language, reporting a number for a translation nobody read.
 */
export type RoutedPromptKey = 'transcriptPrompt' | 'transcriptRepairPrompt' | 'dialoguePrompt' | 'medicationPrompt'

const ROUTED_PROMPT_KEYS: readonly string[] = [
  'transcriptPrompt',
  'transcriptRepairPrompt',
  'dialoguePrompt',
  'medicationPrompt',
] satisfies readonly RoutedPromptKey[]

export const isRoutedPromptKey = (key: string): key is RoutedPromptKey => ROUTED_PROMPT_KEYS.includes(key)

/** The detector, as the pack states it. See `[clinical.languageDetection]` in pack.toml. */
export interface LanguageDetection {
  markers: Record<string, string[]>
  thresholds: { minHits: number; minRatio: number }
  /** language -> the FILE KEY of the prompt that language gets. */
  transcriptPrompt: Record<string, string>
  /**
   * The same, for the repair pass. Its own map rather than a reuse of the one above: the two
   * prompts are separate files, and a pack that has translated the first pass but not the
   * repair should run the repair in the default language rather than not run it at all.
   */
  transcriptRepairPrompt?: Record<string, string>
  /** The same again, for the dialogue prompt, and its own map for the same reason. */
  dialoguePrompt?: Record<string, string>
  /** And for the medication pass, its own map for the same reason again. */
  medicationPrompt?: Record<string, string>
}

/**
 * How a two-speaker transcript is told from a dictation. See `[clinical.dialogueDetection]`.
 *
 * The signal is turn LABELS rather than anything about the prose, because that is the one mark a
 * transcriber puts on a conversation and never on a dictation — and because the labels a given
 * transcriber writes are a property of that project, not of this code.
 */
export interface DialogueDetection {
  labels: string[]
  /** How many labelled turns before the answer is worth giving. */
  minTurns: number
  /** How many DISTINCT labels. One voice is a dictation however it is punctuated. */
  minSpeakers: number
}

export const loadSettings = (pack: Pack): ClinicalSettings => {
  // `[clinical]` is inert to core/pack.ts, which acts only on spec/name/files/documents/
  // include. Reading it here rather than adding a core concept keeps the harness free of
  // this domain's vocabulary, which is the arrangement's whole rule.
  const manifest = pack.manifest as { clinical?: ClinicalSettings }
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
  // The four labels every pack must state. See REQUIRED_SCHEMA_NAMES: the type says `string`
  // and the manifest is TOML, so without this a missing one reaches the request body as
  // `undefined` and pins bytes nobody can reproduce.
  for (const key of REQUIRED_SCHEMA_NAMES) {
    if (typeof s[key] !== 'string' || !s[key]) {
      throw new Error(
        `pack '${pack.name}': [clinical].${key} is missing — ` +
          'the label is part of the request body, and a body that names no schema is one no ' +
          'server log can attribute to a contract',
      )
    }
  }
  // A pack that DECLARES the table must fill it — the same argument as `setMatching` below.
  // Two marker sets that OVERLAP are the specific typo worth refusing: a word that scores for
  // both sides scores for neither, so the ratio it feeds is measuring nothing, and the
  // detector goes on answering.
  if (s.languageDetection) {
    const d = s.languageDetection
    const langs = Object.keys(d.markers ?? {})
    if (langs.length < 2) {
      throw new Error(
        `pack '${pack.name}': [clinical.languageDetection.markers] declares ${langs.length} language(s) — ` +
          'a detector needs at least two sides to have a lead over, or omit the table',
      )
    }
    if (!(d.thresholds && typeof d.thresholds.minHits === 'number' && typeof d.thresholds.minRatio === 'number')) {
      throw new Error(
        `pack '${pack.name}': [clinical.languageDetection.thresholds] must state minHits and minRatio — ` +
          'a detector with no floor calls a two-word fragment for whichever side it grazed',
      )
    }
    for (const [a, b] of langs.flatMap((a, i) => langs.slice(i + 1).map((b) => [a, b] as const))) {
      const bs = (d.markers[b] ?? []).map(foldMarker)
      const overlap = (d.markers[a] ?? []).map(foldMarker).filter((w) => bs.includes(w))
      if (overlap.length) {
        throw new Error(
          `pack '${pack.name}': [clinical.languageDetection.markers] '${a}' and '${b}' share ` +
            `${overlap.map((w) => `'${w}'`).join(', ')} — a marker that scores for both sides scores for neither`,
        )
      }
    }
    // Both prompt maps, by the same rule and with the same message: a table naming a language
    // the markers cannot produce is a translation that will never be read, and it is worth
    // more as a load error than as a file nobody notices going unused.
    for (const table of ['transcriptPrompt', 'transcriptRepairPrompt', 'dialoguePrompt', 'medicationPrompt'] as const) {
      for (const [lang, key] of Object.entries(d[table] ?? {})) {
        if (!langs.includes(lang)) {
          throw new Error(
            `pack '${pack.name}': [clinical.languageDetection.${table}] names language '${lang}', ` +
              `which has no markers — the detector can never return it, so the prompt at '${key}' would never be read`,
          )
        }
      }
    }
  }
  // A pack that DECLARES the table must fill it, and here the empty version is worse than
  // useless: no labels means no line is ever a turn, so every consultation is read as a
  // dictation while the pack's manifest says it has a dialogue contract. A floor of zero is the
  // same failure from the other side — every dictation becomes a dialogue on a stray colon.
  if (s.dialogueDetection) {
    const d = s.dialogueDetection
    if (!(Array.isArray(d.labels) && d.labels.length)) {
      throw new Error(
        `pack '${pack.name}': [clinical.dialogueDetection] declares no labels — ` +
          'no label means no line is ever a turn, and every consultation would be read as a dictation',
      )
    }
    if (!(typeof d.minTurns === 'number' && d.minTurns > 0 && typeof d.minSpeakers === 'number' && d.minSpeakers > 1)) {
      throw new Error(
        `pack '${pack.name}': [clinical.dialogueDetection] must state minTurns > 0 and minSpeakers > 1 — ` +
          'one voice is a dictation however it is punctuated',
      )
    }
  }
  // A pack that DECLARES the table must fill it — and an EMPTY `shapes` is the version worth
  // refusing loudly, because it reads as "the pass is configured" while turning it off. A pack
  // that wants no pass omits the table or drops the prompt keys.
  if (s.medicationPass) {
    const shapes = s.medicationPass.shapes
    if (!(Array.isArray(shapes) && shapes.length)) {
      throw new Error(
        `pack '${pack.name}': [clinical.medicationPass] declares no shapes — ` +
          'omit the table to run one call per transcript, or name the shapes that take the second one',
      )
    }
    for (const shape of shapes) {
      if (shape !== 'dictation' && shape !== 'dialogue') {
        throw new Error(
          `pack '${pack.name}': [clinical.medicationPass] names shape '${shape}', which is not one this ` +
            'harness can detect — the shapes are `dictation` and `dialogue`, decided by [clinical.dialogueDetection]',
        )
      }
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
  // The same rule for the same reason: an empty `doseTokens` is not a language whose doses have
  // no words, it is a typo, and it passes "metformin 500 mg twice daily" as a drug name. The
  // word cap gets a floor of 1 rather than 0, since a name is at least one word.
  if (s.medicationName) {
    const m = s.medicationName
    if (!(Array.isArray(m.doseTokens) && m.doseTokens.length)) {
      throw new Error(
        `pack '${pack.name}': [clinical.medicationName] declares no doseTokens — ` +
          'omit the table to inherit the English+Spanish default, or state the words this corpus needs',
      )
    }
    if (!(typeof m.maxWords === 'number' && m.maxWords >= 1)) {
      throw new Error(
        `pack '${pack.name}': [clinical.medicationName] must state maxWords >= 1 — ` +
          'a drug name is at least one word',
      )
    }
  }
  return s
}

/** The matching rule for this pack, defaulted in ONE place so no task can pick its own. */
export const setMatching = (pack: Pack): SetMatchRule => loadSettings(pack).setMatching ?? DEFAULT_SET_MATCHING

/** The medication-name rule for this pack, defaulted in ONE place for the same reason. */
export const medicationName = (pack: Pack): MedicationNameRule =>
  loadSettings(pack).medicationName ?? DEFAULT_MEDICATION_NAME

// --- The detectors those settings configure ---------------------------------------------

/** Lower-case and drop combining marks, so `está` and `esta` are one marker. */
const foldMarker = (s: string): string => s.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase()

/**
 * The language of a transcript, or `null` when it is too short or too mixed to call.
 *
 * `null` is a real answer and the caller falls back to the default prompt rather than to a
 * guess: a harness that named a language for a two-word fragment would pick a prompt on a coin
 * flip and then pin the completion it produced.
 *
 * The markers and the floors come from the PACK, not from this file, because the consuming
 * application detects too — and two runtimes that detect separately grade different inputs
 * while appearing to share a contract.
 */
export const detectLanguage = (pack: Pack, text: string): string | null => {
  const d = loadSettings(pack).languageDetection
  if (!d) return null

  const hits: Record<string, number> = {}
  const folded = new Map<string, string[]>()
  for (const [lang, words] of Object.entries(d.markers)) {
    hits[lang] = 0
    folded.set(lang, words.map(foldMarker))
  }
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue
    const w = foldMarker(raw)
    // A word can only score once per side, and the sides are disjoint by construction (the
    // loader refuses an overlap), so this is a plain count rather than a first-match chain.
    for (const [lang, words] of folded) if (words.includes(w)) hits[lang] = (hits[lang] ?? 0) + 1
  }

  const ranked = Object.entries(hits).sort((a, b) => b[1] - a[1])
  const top = ranked[0]
  if (!top) return null
  const [lang, hi] = top
  const lo = ranked[1]?.[1] ?? 0
  if (hi < d.thresholds.minHits || hi < Math.max(lo, 1) * d.thresholds.minRatio) return null
  return lang
}

/**
 * Is this transcript a conversation between two people, rather than one person dictating?
 *
 * Counts LABELLED TURNS: a line whose first token, up to a colon, is one of the labels the pack
 * declares. Both floors have to clear — enough turns that a stray `plan:` cannot carry it, and
 * enough distinct speakers that a labelled monologue stays a dictation.
 *
 * `false` is the fallback for everything it cannot call, and that is the safe direction: an
 * unrecognised transcript takes the prompt this pack has always used for transcripts.
 */
export const isDialogue = (pack: Pack, text: string): boolean => {
  const d = loadSettings(pack).dialogueDetection
  if (!d) return false
  const labels = d.labels.map(foldMarker)
  const seen = new Set<string>()
  let turns = 0
  for (const line of text.split('\n')) {
    // The label is what precedes the FIRST colon on the line, and only when nothing but the
    // label precedes it. `dr: and the citalopram` is a turn; `plan: repeat the hba1c in three
    // months, colon` inside a dictated sentence is not, because the words before the colon are
    // a sentence rather than a name.
    const m = /^\s*([^\s:]{1,12})\s*:/.exec(line)
    if (!m) continue
    const label = foldMarker(m[1] ?? '')
    if (!labels.includes(label)) continue
    turns++
    seen.add(label)
  }
  return turns >= d.minTurns && seen.size >= d.minSpeakers
}

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
