/**
 * The three set-extraction evals: patient summary, note formatting, dictated transcripts.
 *
 * They live beside the vital-signs eval rather than inside it because they grade a different
 * kind of answer — sets of free text rather than transcribed numbers — but everything around
 * the grading is deliberately the same: the pack supplies prompt, schema, cap and floor, the
 * harness supplies transport, mode and trace, the run is sequential so `cache_prompt` can
 * reuse the system prompt, and every completion goes into the trace next to the tally it
 * produced.
 *
 * The last two share a function rather than a family resemblance. Note formatting and
 * transcript formatting emit the SAME contract and are measured on the same four numbers;
 * only the prompt, the corpus and the kind of document differ. Written twice they would be
 * free to count differently, and the whole reason to run both is that the difference between
 * their scores is a claim about reading speech versus reading prose.
 *
 * All three report cost from the graded pass, through the same `core/bench.ts` the vital-signs
 * eval uses. The summary task is the one place where that matters for a reason other than
 * curiosity: its input is a whole record rather than one note, so it is the task whose prompt
 * cost is not a rounding error.
 */
import type { Pack } from '../../core/pack.ts'
import type { Trace } from '../../core/trace.ts'
import { formatBench, summarizeBench, type BenchSample, type BenchSummary } from '../../core/bench.ts'
import { assembleDocument } from '../../core/assemble.ts'
import { extract, type ExtractOutcome } from '../../modes/extract.ts'
import { loadSettings, medicationName, setMatching } from './settings.ts'
import {
  DIFFICULTY_MAX,
  DIFFICULTY_MIN,
  loadFormatCases,
  loadSummaryCases,
  loadTranscriptCases,
  parseDifficultyRange,
  requiredSetExpectations,
  type FormatCase,
  type QuotedSetCases,
  type SetExpectation,
  type SummaryCase,
  type TranscriptCase
} from './cases.ts'
import { DOCUMENT_KIND, formatRequest, summaryRequest, transcriptRequest, type TaskRequest } from './contracts.ts'
import { ProfileError } from '../../core/profile.ts'
import { UNIDENTIFIED, type ServerIdentity } from '../../core/client.ts'
import { parseNoteFormat, parsePatientSummary } from './extraction.ts'
import type { NoteFormat } from './extraction.ts'
import { readingFromItems, verifyReading, type ReviewedItem } from './review-transcript.ts'
import { repairReading, type RepairOutcome, type RepairTally } from './repair.ts'
import { applyMedication, medicationReading, type MedicationOutcome } from './medication.ts'
import { pct, ratio } from './scorer.ts'
import {
  absorbFormat,
  absorbSet,
  emptyFormatTally,
  emptySetTally,
  scoreFailedFormat,
  scoreFailedSet,
  scoreFormatCase,
  scoreSet,
  summaryTexts,
  type FormatTally,
  type SetMiss,
  type SetTally,
} from './set-scorer.ts'

export interface TaskEvalOptions {
  pack: Pack
  baseUrl?: string
  trace: Trace
  constrain: boolean
  runs?: number
  /** `N` or `N-M`: grade only the cases in that tier, exactly as the vital-signs eval does. */
  difficulty?: string
  /** Who is serving, resolved once for the whole run by the profile. See core/client.ts. */
  identity?: ServerIdentity
  /** Prefix reuse, on by default. Off buys a comparable run with prefill time; see the client. */
  cachePrompt?: boolean
  /**
   * Run the repair pass over failed citations, and report BOTH readings.
   *
   * Opt-in, and the gate is then read off the repaired reading because that is what the pass
   * would ship. The first-pass numbers are printed beside it on every line — a repair reported
   * alone would be a two-call pipeline quoting a one-call number.
   */
  repair?: boolean
  /**
   * Run the medication pass on the shapes the pack names for it.
   *
   * ON unless explicitly false, which is the opposite of `repair` above: the pass is part of
   * the contract rather than an experiment, and a default-off contract is one the application
   * ships unmeasured. False reproduces a number pinned before the pass existed.
   *
   * It leaves ONE defect of its own, counted rather than described: two duplicate drug items
   * over the corpus, which the first pass does not produce. See `duplicateDrugs`.
   */
  medicationPass?: boolean
}

/**
 * Apply `--difficulty` to a task's cases, and say what it selected.
 *
 * Shared by both tasks here rather than written twice, and applied at ALL, which it was not:
 * the flag reached this file, was declared in the options above, and was then read by
 * nothing. `eval --task all --difficulty 5` graded five of twenty-one notes for vital signs
 * and every record and every note for these two, with no line of output saying so. A filter
 * silently not applied is worse than a filter refused — the run reports a number for a corpus
 * nobody asked about, and it looks exactly like the number they wanted.
 */
const inTier = <C extends { difficulty: number }>(
  all: C[],
  difficulty: string | undefined,
  what: string,
  pack: string,
): { cases: C[]; scope: string } => {
  if (!difficulty) return { cases: all, scope: `difficulty ${DIFFICULTY_MIN}-${DIFFICULTY_MAX}` }
  const keep = parseDifficultyRange(difficulty)
  const cases = all.filter((c) => keep(c.difficulty))
  if (!cases.length) throw new ProfileError(`no ${what} cases at difficulty '${difficulty}' in pack '${pack}'`)
  return {
    cases,
    scope:
      cases.length === all.length
        ? `difficulty ${DIFFICULTY_MIN}-${DIFFICULTY_MAX}`
        : `difficulty ${difficulty} only — ${cases.length} of ${all.length}`,
  }
}

/** What every task returns to the profile, so one verdict can be built from three of them. */
export interface TaskResult {
  task: string
  /** The gated number and its floor. */
  score: number
  floor: number
  /**
   * Was there anything to score? A rate over a zero denominator is 1.0 — see `ratio`, where
   * that is correct, because "found none of the zero things there were to find" is not a
   * failure for a CASE that has nothing to extract. It is not correct for a FLOOR.
   *
   * Left as it was, a gate cleared itself by measuring nothing, and the unconstrained
   * gemma-3-4b run showed exactly that: every case failed to parse, no quote was ever
   * checked, and the verdict line still read `provenance 100%, derivation 100%`. A gate that
   * passes when nothing was checked is indistinguishable from one that passed on evidence,
   * which is the single thing a gate exists to tell you apart.
   */
  measured: boolean
  /** Extra gates within the task; each must clear on its own, and each must be measured. */
  gates?: Gate[]
  summary: string
  bench?: BenchSummary
}

export interface Gate {
  name: string
  score: number
  floor: number
  measured: boolean
}

/** One place decides what clearing a floor means, for a task gate and a sub-gate alike. */
export const gatePasses = (g: { score: number; floor: number; measured: boolean }): boolean =>
  g.measured && g.score >= g.floor

/**
 * One sample per case-run that produced a completion. Identical in both tasks below.
 *
 * Takes the whole outcome rather than its `cost` array, because two of the three numbers it
 * needs are not in there: `attempts` counts requests SENT and `cost` counts completions read,
 * and a case whose first attempt died at transport used to report one attempt, no retry, and
 * none of the time it spent failing.
 */
const sampleOf = (name: string, outcome: Pick<ExtractOutcome<unknown>, 'cost' | 'attempts' | 'lostMs'>): BenchSample | undefined => {
  const cost = outcome.cost
  return cost.length
    ? {
        case: name,
        wallMs: cost.reduce((n, a) => n + a.wallMs, 0) + outcome.lostMs,
        attempts: outcome.attempts,
        promptTokens: cost.reduce((n, a) => n + (a.timings?.promptTokens ?? 0), 0),
        promptMs: cost.reduce((n, a) => n + (a.timings?.promptMs ?? 0), 0),
        predictedTokens: cost.reduce((n, a) => n + (a.timings?.predictedTokens ?? 0), 0),
        predictedMs: cost.reduce((n, a) => n + (a.timings?.predictedMs ?? 0), 0),
        cachedTokens: cost.reduce((n, a) => n + (a.timings?.cachedTokens ?? 0), 0),
      }
    : undefined
}

/**
 * A rate for the one-line verdict, which says "not measured" rather than a number when the
 * denominator was zero. `(0/0) → 100%` in the line a CI log keeps is the most misleading
 * output this harness can produce.
 */
const measuredPct = (rate: number, denominator: number): string =>
  denominator > 0 ? `${(rate * 100).toFixed(0)}%` : 'not measured'

/**
 * The cost block, and the conditions it is only valid under.
 *
 * `identity` was threaded in here for the reason the vital-signs eval records it: a timing
 * belongs to a machine, a build and a quantisation, and these two tasks used to print one
 * with no statement of any of them. When the server would not say, the trace's `identified`
 * flag lets a consumer refuse to quote the figure rather than having to notice a placeholder.
 */
const reportBench = (
  samples: BenchSample[],
  trace: Trace,
  task: string,
  identity: ServerIdentity | undefined,
): BenchSummary | undefined => {
  if (!samples.length) return undefined
  const bench = summarizeBench(samples)
  console.log(`\nwhat it cost:`)
  for (const line of formatBench(bench, identity?.props)) console.log(`  ${line}`)
  trace.write({
    event: 'bench',
    task,
    bench,
    samples,
    model: identity?.model ?? UNIDENTIFIED,
    identified: identity?.identified ?? false,
    benchConditions: identity?.props,
  })
  return bench
}

// --- Patient summary ----------------------------------------------------------------------

export const runSummaryEval = async (o: TaskEvalOptions): Promise<TaskResult> => {
  const req = summaryRequest(o.pack, o.constrain)
  const { itemRecallFloor, cases: allCases } = loadSummaryCases(o.pack)
  // Filtering here rather than in the loader keeps the pack's own consistency checks running
  // over the WHOLE case file even when a run grades one record of it.
  const { cases, scope } = inTier(allCases, o.difficulty, 'summary', o.pack.name)
  const assembly = loadSettings(o.pack).summaryAssembly
  // The pack's own negator list, or the documented default. Read here rather than defaulted
  // in the scorer so both set tasks match under the same declared rule.
  const matching = setMatching(o.pack)
  const runs = Math.max(1, o.runs ?? 1)

  const total = emptySetTally()
  const misses: SetMiss[] = []
  const samples: BenchSample[] = []

  console.log(`\n=== Patient summary — ${cases.length} records, ${requiredSetExpectations(cases)} required items, ${scope} ===`)
  console.log(`${o.constrain ? 'constrained' : 'unconstrained'} · temp ${req.sampling.temperature} · max_tokens ${req.sampling.max_tokens}\n`)

  for (const c of cases) {
    for (let run = 0; run < runs; run++) {
      // The record, assembled under the pack's rule rather than joined here. A run whose
      // input silently lost its last notes produces a plausible score for a question the
      // model was never asked, so the truncation is recorded with the case.
      const record = assembleDocument(c.notes.map((n) => o.pack.document(n)), assembly)
      const outcome = await extract({
        systemPrompt: req.prompt,
        document: record.text,
        parse: parsePatientSummary,
        schema: req.schema,
        schemaName: req.schemaName,
        maxTokens: req.sampling.max_tokens,
        temperature: req.sampling.temperature,
        // This task's declared deadline is the longest in the pack because its INPUT is: a
        // whole assembled record spends several times a single note's on prefill alone.
        timeoutMs: req.sampling.timeout_secs * 1000,
        baseUrl: o.baseUrl,
        cachePrompt: o.cachePrompt,
        label: 'patient_summary',
      })

      const scored = outcome.parsed
        ? scoreSet(c.name, c.fields, summaryTexts(outcome.parsed), matching)
        : scoreFailedSet(c.name, c.fields)
      absorbSet(total, scored.tally)
      misses.push(...scored.misses)
      const sample = sampleOf(c.name, outcome)
      if (sample) samples.push(sample)

      o.trace.write({
        event: 'case',
        task: 'summary',
        case: c.name,
        class: c.class,
        difficulty: c.difficulty,
        run,
        notes: c.notes,
        assembled: { chars: record.text.length, notes: record.used, truncated: record.truncated },
        ok: Boolean(outcome.parsed),
        error: outcome.error,
        tally: scored.tally,
        misses: scored.misses,
        cost: sample,
        completion: outcome.raw,
      })

      const t = scored.tally
      const flag = outcome.parsed ? '' : `  FAILED: ${outcome.error?.slice(0, 80)}`
      console.log(
        `${c.name.padEnd(22)} ${c.class.padEnd(13)} d${c.difficulty} ` +
          `items ${pct(t.found, t.required)} emitted ${String(t.items).padStart(3)} ` +
          `halluc ${t.hallucinations}${flag}`,
      )
    }
  }

  const recall = ratio(total.found, total.required)
  console.log(`\n${'—'.repeat(78)}`)
  console.log(`item recall ${pct(total.found, total.required)}  <- the gate, floor ${(itemRecallFloor * 100).toFixed(0)}%`)
  console.log(`items emitted ${total.items}   hallucinations ${total.hallucinations}   failed runs ${total.failedRuns}`)
  const bench = reportBench(samples, o.trace, 'summary', o.identity)
  if (misses.length) {
    console.log(`\nwhat went wrong (${misses.length}):`)
    for (const m of misses) console.log(`  ${m.reason.padEnd(14)} ${m.case} · ${m.field} — ${m.detail}`)
  }

  return {
    task: 'summary',
    score: recall,
    floor: itemRecallFloor,
    measured: total.required > 0,
    summary:
      `item recall ${measuredPct(recall, total.required)} vs floor ${(itemRecallFloor * 100).toFixed(0)}% ` +
      `(${total.found}/${total.required}, halluc ${total.hallucinations}, failed runs ${total.failedRuns})`,
    bench,
  }
}

// --- The quoted set tasks: note formatting, and dictated transcripts ---------------------------

/**
 * What distinguishes one quoted set task from the other. Everything else below is shared.
 *
 * The two tasks emit the SAME contract — four sections, every item carrying the span it came
 * from — over inputs that differ in one respect: one is a written note and the other is a
 * transcript of somebody speaking. So the measurement is identical and only the input,
 * the prompt and the corpus vary, and this descriptor is exactly that list. Running them
 * through one function is not a saving; it is the guarantee that a difference in their
 * numbers is a difference in the models' answers rather than in how two evals counted.
 */
interface QuotedSetTask<C extends { name: string; class: string; difficulty: number; fields: SetExpectation[] }> {
  /** The `--task` word, the trace's `task` field and the verdict line's label. */
  task: string
  /** The heading, the noun for what one case is, and the noun for the document it quotes. */
  heading: string
  unit: string
  source: string
  /** `label` on the request, which is what a server log and a pinned body are read by. */
  requestLabel: string
  /**
   * The request for ONE document, not for the task.
   *
   * A function rather than a value because the transcript task chooses its prompt by the
   * language of the transcript in front of it. Sampling and schema do not vary that way, and
   * the header line below reads them from a representative request rather than re-deriving
   * them per case.
   */
  request: (document: string) => TaskRequest
  floors: QuotedSetCases
  cases: C[]
  /** The document this case is graded over, and what the trace should record about where it came from. */
  document: (c: C) => string
  provenance: (c: C) => Record<string, unknown>
  /**
   * The second pass over the items whose citation failed, when the caller asked for one.
   *
   * Optional and per-task: only the dictated-transcript contract declares a repair, and a note
   * formatting run given this hook would be measuring a pass its pack does not describe.
   * Absent, every line below runs exactly as it did before the repair existed — which is what
   * makes a `--repair` run and a plain one comparable at all.
   */
  repair?: (document: string, items: ReviewedItem[]) => Promise<RepairOutcome>
  /**
   * The medication pass, run BEFORE the repair and on the first pass's reading.
   *
   * Optional and per-task like the repair, and ordered before it deliberately: the pass replaces
   * a whole section, so a repair that ran first would be re-citing items about to be discarded,
   * and its accepted/refused counts would describe work thrown away.
   */
  medication?: (document: string, reading: NoteFormat) => Promise<MedicationOutcome>
}

export const runNoteFormatEval = async (o: TaskEvalOptions): Promise<TaskResult> => {
  const floors = loadFormatCases(o.pack)
  const { cases, scope } = inTier(floors.cases, o.difficulty, 'note-format', o.pack.name)
  return runQuotedSetEval(o, scope, {
    task: 'note-format',
    heading: 'Note formatting',
    unit: 'notes',
    source: 'note',
    requestLabel: 'note_format',
    request: () => formatRequest(o.pack, o.constrain),
    floors,
    cases,
    // The note comes from the vital-signs corpus by name: 30 notes, three tasks, one copy.
    document: (c) => o.pack.document(c.source, DOCUMENT_KIND['note-format']),
    provenance: (c) => ({ source: c.source }),
  })
}

/**
 * The dictated-transcript eval.
 *
 * Deliberately the same measurement as note formatting, over a corpus of speech. The three
 * things it does not share are named in the descriptor: its own prompt (a dictation retracts
 * itself, dictates its own punctuation and talks to the room, and a prompt that says nothing
 * about any of that is measuring whether the model guessed), its own cases, and its own
 * corpus — reached through the `transcript` documents kind rather than `notes/`, because a
 * transcript filed as a note is mislabelled in the one directory where that matters most.
 *
 * Its floors are PROVISIONAL and its case file says so. Nothing here treats them differently:
 * a floor is a floor, and a harness that softened a gate because a comment called it new would
 * be the wrong place to record that fact.
 */
export const runTranscriptEval = async (o: TaskEvalOptions): Promise<TaskResult> => {
  const floors = loadTranscriptCases(o.pack)
  const { cases, scope } = inTier(floors.cases, o.difficulty, 'transcript', o.pack.name)
  return runQuotedSetEval(o, scope, {
    task: 'transcript',
    heading: 'Dictated transcripts',
    unit: 'transcripts',
    source: 'transcript',
    requestLabel: 'transcript',
    request: (document) => transcriptRequest(o.pack, o.constrain, document),
    floors,
    cases,
    // The case IS the document here: there is no written note to point at.
    document: (c) => o.pack.document(c.name, DOCUMENT_KIND.transcript),
    provenance: () => ({}),
    medication:
      o.medicationPass === false
        ? undefined
        : (document, reading) =>
            medicationReading({
              pack: o.pack,
              document,
              reading,
              constrain: o.constrain,
              baseUrl: o.baseUrl,
              trace: o.trace,
              cachePrompt: o.cachePrompt,
            }),
    repair: o.repair
      ? (document, items) =>
          repairReading({
            pack: o.pack,
            document,
            items,
            quoteRule: loadSettings(o.pack).quoteVerification,
            derivationRule: loadSettings(o.pack).textDerivation,
            constrain: o.constrain,
            baseUrl: o.baseUrl,
            trace: o.trace,
            cachePrompt: o.cachePrompt,
          })
      : undefined,
  })
}

const runQuotedSetEval = async <C extends { name: string; class: string; difficulty: number; fields: SetExpectation[] }>(
  o: TaskEvalOptions,
  scope: string,
  def: QuotedSetTask<C>,
): Promise<TaskResult> => {
  // Sampling and schema are properties of the TASK; only the prompt can vary per document.
  const shape = def.request('')
  const { itemRecallFloor, quoteFloor, derivationFloor, fabricationFloor, medicationNameFloor } = def.floors
  const cases = def.cases
  const settings = loadSettings(o.pack)
  const rules = {
    quote: settings.quoteVerification,
    derivation: settings.textDerivation,
    matching: setMatching(o.pack),
    medicationName: medicationName(o.pack),
  }
  const runs = Math.max(1, o.runs ?? 1)

  const total = emptyFormatTally()
  // The same tally over the FIRST pass's reading, kept only when a repair ran. Two tallies
  // rather than one plus a delta: every gate below is a ratio, and a ratio's numerator and
  // denominator both move when a repair lands, so a difference computed from percentages
  // would be a number that no run produced.
  const totalBefore = emptyFormatTally()
  const repairTally: RepairTally = { offered: 0, accepted: 0, refused: 0, confessed: 0, unanswered: 0 }
  // How many transcripts actually took the second call. Counted rather than assumed from the
  // case count: a corpus of dictations and dialogues takes it on some and not others, and a
  // report that said "a second call per transcript" over a mixed corpus would be wrong.
  let medicationRan = 0
  const misses: SetMiss[] = []
  const samples: BenchSample[] = []

  console.log(`\n=== ${def.heading} — ${cases.length} ${def.unit}, ${requiredSetExpectations(cases)} required items, ${scope} ===`)
  console.log(`${o.constrain ? 'constrained' : 'unconstrained'} · temp ${shape.sampling.temperature} · max_tokens ${shape.sampling.max_tokens}\n`)

  for (const c of cases) {
    const note = def.document(c)
    const req = def.request(note)
    for (let run = 0; run < runs; run++) {
      const outcome = await extract({
        systemPrompt: req.prompt,
        document: note,
        parse: parseNoteFormat,
        schema: req.schema,
        schemaName: req.schemaName,
        maxTokens: req.sampling.max_tokens,
        temperature: req.sampling.temperature,
        timeoutMs: req.sampling.timeout_secs * 1000,
        baseUrl: o.baseUrl,
        cachePrompt: o.cachePrompt,
        label: def.requestLabel,
      })

      // The first pass's reading, scored before anything is repaired. This is the number every
      // result this pack has pinned describes, and it is computed on every run — with the
      // repair off the two tallies are identical and the report prints one.
      const firstScored = outcome.parsed
        ? scoreFormatCase(c.name, c.fields, outcome.parsed, note, rules)
        : scoreFailedFormat(c.name, c.fields)
      absorbFormat(totalBefore, firstScored.tally)

      // The medication pass, on the first reading and before the repair. It cannot throw and
      // cannot lose a section: a reply that does not parse leaves `current_medication` exactly
      // as the first pass wrote it, and `applyMedication` is then the identity.
      let medication: MedicationOutcome | null = null
      let read = outcome.parsed
      if (def.medication && read) {
        medication = await def.medication(note, read)
        if (medication.ran) medicationRan++
        read = applyMedication(read, medication)
      }

      // The repair, and the reading it produced. `repairReading` cannot throw and cannot lose
      // items, so `repair.items` is either an improved reading or the one it was handed.
      let repair: RepairOutcome | null = null
      if (def.repair && read) {
        const items = verifyReading(read, note, rules.quote, rules.derivation)
        repair = await def.repair(note, items)
        for (const k of ['offered', 'accepted', 'refused', 'confessed', 'unanswered'] as const) {
          repairTally[k] += repair.tally[k]
        }
      }
      const reading = repair ? readingFromItems(repair.items) : read

      const scored = reading
        ? scoreFormatCase(c.name, c.fields, reading, note, rules)
        : scoreFailedFormat(c.name, c.fields)
      absorbFormat(total, scored.tally)
      misses.push(...scored.misses)
      const sample = sampleOf(c.name, outcome)
      if (sample) samples.push(sample)
      // The repair's own call, sampled under the same case name. Added to the SAME array
      // rather than reported apart, because the cost block prices what a run of this task
      // costs — and with `--repair` on, what it costs is both calls. A block announcing "a
      // SECOND call per transcript" above a token count covering only the first would be
      // describing half its own cost.
      const repairSample = repair ? sampleOf(`${c.name} (repair)`, repair) : undefined
      if (repairSample) samples.push(repairSample)
      // And the medication call, on the same argument: it is a second call this run paid for,
      // so it belongs in the cost block rather than beside it.
      const medicationSample = medication?.ran ? sampleOf(`${c.name} (medication)`, medication) : undefined
      if (medicationSample) samples.push(medicationSample)

      o.trace.write({
        event: 'case',
        task: def.task,
        case: c.name,
        class: c.class,
        difficulty: c.difficulty,
        ...def.provenance(c),
        run,
        ok: Boolean(outcome.parsed),
        error: outcome.error,
        tally: scored.tally,
        misses: scored.misses,
        cost: sample,
        completion: outcome.raw,
        ...(repair
          ? {
              repair: { tally: repair.tally, why: repair.why, error: repair.error, completion: repair.completion },
              tallyBeforeRepair: firstScored.tally,
            }
          : {}),
        ...(medication
          ? {
              // `ran: false` lines are written too, and carry the reason: a dialogue that
              // declined the pass and a dictation whose pass failed are different runs, and a
              // trace that recorded only the successes could not tell them apart later.
              medication: {
                ran: medication.ran,
                why: medication.why,
                error: medication.error,
                before: medication.before,
                after: medication.after,
                completion: medication.completion,
              },
              // Only when the pass actually replaced the section — otherwise this tally is the
              // one above under a name suggesting something changed.
              ...(medication.ran ? { tallyBeforeMedication: firstScored.tally } : {}),
            }
          : {}),
      })

      const t = scored.tally
      const flag = outcome.parsed ? '' : `  FAILED: ${outcome.error?.slice(0, 80)}`
      // The repair's own column, per case, so a run where one transcript carried the whole
      // gain is not reported as a run where the pass worked everywhere.
      const fixed = repair?.tally.offered
        ? `  repair ${repair.tally.accepted}/${repair.tally.offered}` +
          (repair.tally.refused ? ` (${repair.tally.refused} refused)` : '')
        : ''
      console.log(
        `${c.name.padEnd(22)} ${c.class.padEnd(14)} d${c.difficulty} ` +
          `items ${pct(t.found, t.required)} quote ${pct(t.quotesVerified, t.quotes)} ` +
          `deriv ${pct(t.derivationsOk, t.derivations)} halluc ${t.hallucinations} dose ${t.doseErrors}` +
          // Only when the case emitted medication. A column reading `name n/a` on every
          // summary case would be three tasks paying to look at a fourth task's axis.
          (t.names ? ` name ${pct(t.namesOk, t.names)}` : '') +
          `${fixed}${flag}`,
      )
    }
  }

  const recall = ratio(total.found, total.required)
  const quoteRate = ratio(total.quotesVerified, total.quotes)
  const derivationRate = ratio(total.derivationsOk, total.derivations)
  const nameRate = ratio(total.namesOk, total.names)
  // Quotes that are somewhere in the note, under some relaxation of case or accents — so the
  // complement of this is the model INVENTING a span, which is a different accusation from the
  // model tidying one. Derived rather than counted: a strictly-verified quote and an
  // edited-only failure are both spans that exist, and everything else is not.
  const unfabricated = total.quotesVerified + total.quotesEditedOnly
  const fabricationRate = ratio(unfabricated, total.quotes)

  console.log(`\n${'—'.repeat(78)}`)
  console.log(`item recall ${pct(total.found, total.required)}  <- the gate, floor ${(itemRecallFloor * 100).toFixed(0)}%`)
  // `pct` already prints `n/a` for a zero denominator; the note beside it says what that
  // means for the VERDICT, which is the part a reader would otherwise have to guess.
  const unmeasured = ' — nothing was checked, so this gate cannot pass'
  console.log(
    `provenance  ${pct(total.quotesVerified, total.quotes)}  <- sub-gate, floor ${(quoteFloor * 100).toFixed(0)}% — quotes found in the ${def.source}` +
      (total.quotes ? '' : unmeasured),
  )
  console.log(
    `derivation  ${pct(total.derivationsOk, total.derivations)}  <- sub-gate, floor ${(derivationFloor * 100).toFixed(0)}% — text is its quote with words deleted` +
      (total.derivations ? '' : unmeasured),
  )
  // Printed as its own line when the pack gates on it, so the two accusations a provenance
  // failure can be are visible apart rather than only summed in the line below.
  if (fabricationFloor !== undefined) {
    console.log(
      `not invented ${pct(unfabricated, total.quotes)}  <- sub-gate, floor ${(fabricationFloor * 100).toFixed(0)}% — ` +
        'the span exists, even where a capital drifted' +
        (total.quotes ? '' : unmeasured),
    )
  }
  // Printed whenever the task emitted medication, gate or no gate. A pack that has not yet
  // measured this axis still gets to SEE it, which is the whole reason it exists.
  if (total.names) {
    console.log(
      `drug name   ${pct(total.namesOk, total.names)}  <- ` +
        (medicationNameFloor === undefined
          ? 'measured, not gated — `text` is the drug name and nothing else'
          : `sub-gate, floor ${(medicationNameFloor * 100).toFixed(0)}% — \`text\` is the drug name and nothing else`),
    )
  }
  console.log(
    `items emitted ${total.items}   hallucinations ${total.hallucinations}   dose errors ${total.doseErrors}   ` +
      (total.duplicateDrugs ? `duplicate drugs ${total.duplicateDrugs}   ` : '') +
      `edited-only quote failures (a capital or an accent) ${total.quotesEditedOnly}   failed runs ${total.failedRuns}`,
  )

  // What the medication pass was worth, against the same first reading.
  //
  // Printed whenever it ran on anything, and it names HOW MANY transcripts took it rather than
  // implying every one did: on a mixed corpus the dialogues do not, by
  // [clinical.medicationPass].shapes, and a block reading "a second call per transcript" over
  // twenty cases where seventeen made one would be describing a run that did not happen.
  //
  // The four gates are printed before and after together ONLY when no repair also ran. With
  // both passes on, the difference between `totalBefore` and `total` is the two of them
  // together and attributing it to either would be a number nobody measured.
  if (medicationRan) {
    const b = totalBefore
    console.log(
      `\nthe medication pass (a SECOND call on ${medicationRan} of ${cases.length * runs} transcript reading(s) — ` +
        'the numbers above include it):',
    )
    if (def.repair) {
      console.log('  a repair also ran, so the first-pass comparison below covers both passes together')
    }
    console.log(
      `  first pass alone:  item recall ${pct(b.found, b.required)}  provenance ${pct(b.quotesVerified, b.quotes)}  ` +
        `derivation ${pct(b.derivationsOk, b.derivations)}  drug name ${pct(b.namesOk, b.names)}`,
    )
    console.log(
      `  with the pass:     item recall ${pct(total.found, total.required)}  provenance ${pct(total.quotesVerified, total.quotes)}  ` +
        `derivation ${pct(total.derivationsOk, total.derivations)}  drug name ${pct(total.namesOk, total.names)}`,
    )
  }

  // What the second pass was worth, in the same four gates, against the first pass alone.
  //
  // Printed as a BLOCK rather than folded into the lines above, and printed whenever a repair
  // ran even if it changed nothing. Every result this pack has pinned describes one call; a
  // reader comparing a repaired run with those has to be able to see which half of this run is
  // comparable, and a summary that quietly reported a two-call number under the same four
  // headings would make every historical row wrong without editing one of them.
  if (def.repair) {
    const b = totalBefore
    console.log(`\nthe repair pass (a SECOND call per transcript — the numbers above include it):`)
    console.log(
      `  ${repairTally.accepted}/${repairTally.offered} failed citations re-cited · ` +
        `${repairTally.refused} proposed and refused by the verifier · ` +
        `${repairTally.confessed} the model could not find · ${repairTally.unanswered} unanswered`,
    )
    console.log(
      `  first pass alone:  item recall ${pct(b.found, b.required)}  provenance ${pct(b.quotesVerified, b.quotes)}  ` +
        `derivation ${pct(b.derivationsOk, b.derivations)}  ` +
        `not invented ${pct(b.quotesVerified + b.quotesEditedOnly, b.quotes)}`,
    )
    console.log(
      `  with the repair:   item recall ${pct(total.found, total.required)}  provenance ${pct(total.quotesVerified, total.quotes)}  ` +
        `derivation ${pct(total.derivationsOk, total.derivations)}  ` +
        `not invented ${pct(unfabricated, total.quotes)}`,
    )
    // The refusals are the evidence that the verifier is still the authority here, so they get
    // a sentence rather than a column when there are any.
    if (repairTally.refused) {
      console.log(
        `  ${repairTally.refused} repair${repairTally.refused === 1 ? ' was' : 's were'} thrown out for not verifying — ` +
          'those items stand exactly as the first pass left them.',
      )
    }
  }

  const bench = reportBench(samples, o.trace, def.task, o.identity)
  if (misses.length) {
    console.log(`\nwhat went wrong (${misses.length}):`)
    for (const m of misses) console.log(`  ${m.reason.padEnd(14)} ${m.case} · ${m.field} — ${m.detail}`)
  }

  return {
    task: def.task,
    score: recall,
    floor: itemRecallFloor,
    measured: total.required > 0,
    // Sub-gates, not averaged in: a run that cites fabricated spans has not passed, however
    // many expected items it found. Each carries whether it was measured at all, because a
    // run that emitted no items has not proved its provenance — it has avoided the question.
    gates: [
      { name: 'provenance', score: quoteRate, floor: quoteFloor, measured: total.quotes > 0 },
      { name: 'derivation', score: derivationRate, floor: derivationFloor, measured: total.derivations > 0 },
      // Optional, and separate from `provenance` on purpose: it lets a pack say "tidying may
      // cost me five per cent, inventing a sentence may cost me nothing", which is the
      // sentence most packs mean and which one provenance floor cannot express.
      ...(fabricationFloor === undefined
        ? []
        : [{ name: 'not-invented', score: fabricationRate, floor: fabricationFloor, measured: total.quotes > 0 }]),
      // Optional on the same terms, and for the additional reason that this axis is newer than
      // the floors beside it: a pack declares a number here once it has measured one.
      ...(medicationNameFloor === undefined
        ? []
        : [{ name: 'drug-name', score: nameRate, floor: medicationNameFloor, measured: total.names > 0 }]),
    ],
    summary:
      `item recall ${measuredPct(recall, total.required)} vs floor ${(itemRecallFloor * 100).toFixed(0)}% ` +
      `(${total.found}/${total.required}), provenance ${measuredPct(quoteRate, total.quotes)}, ` +
      `derivation ${measuredPct(derivationRate, total.derivations)}, ` +
      (fabricationFloor === undefined ? '' : `not-invented ${measuredPct(fabricationRate, total.quotes)}, `) +
      `halluc ${total.hallucinations}, dose ${total.doseErrors}`,
    bench,
  }
}

export type { FormatCase, FormatTally, SetTally, SummaryCase, TranscriptCase }
