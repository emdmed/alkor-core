/**
 * Re-scoring a recorded run, with no server.
 *
 * `eval --from-trace FILE` reads the completions a past run wrote down and grades them again
 * under today's scorer, today's pack and — optionally — a transformation of the reply. It
 * answers the question the trace was always for: is this number still the number?
 *
 * It exists because the most useful analysis this repository has produced was unrepeatable by
 * anyone else. RESULTS.md says of the unconstrained gemma-3-4b arm: "the 0/88 is a format
 * failure, not a comprehension failure — here is the same run at 84/84 with the fence
 * stripped." That was true, and it was produced by a script written by hand, twice, reaching
 * into scorer internals nobody else could reach. A harness whose premise is that nothing has to
 * be taken on faith cannot make its own most interesting claim un-checkable.
 *
 * `--strip-fences` is the transformation that argument needs, and it is offered HERE rather
 * than in the parser on purpose. The graded path refuses a fenced reply, deliberately, because
 * an application that does not strip fences receives exactly nothing — the eval must report
 * what a caller actually gets. This verb is the other question: what would the same bytes have
 * scored if the application did strip them? Two different questions, two different commands,
 * and neither one quietly answering for the other.
 *
 * Nothing here re-runs a model, and nothing here can. A re-score over completions that were
 * never recorded is not a re-score.
 */
import type { Pack } from '../../core/pack.ts'
import { eventOf, eventsOf, isRedacted, readTrace, TraceError, type TraceEvent } from '../../core/trace-read.ts'
import {
  loadSettings,
  loadVitalCases,
  medicationName,
  setMatching,
  vitalRequest,
  type VitalCase,
} from './contracts.ts'
import { parseNoteFormat, parsePatientSummary, parseVitalSigns } from './extraction.ts'
import { absorb, emptyTally, pct, ratio, scoreCase, scoreFailure, type VitalTally } from './scorer.ts'
import { DOCUMENT_KIND, loadFormatCases, loadSummaryCases, loadTranscriptCases, type SetExpectation } from './contracts.ts'
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
} from './set-scorer.ts'

export interface RescoreOptions {
  pack: Pack
  path: string
  /**
   * Unwrap a markdown code fence before parsing.
   *
   * Off by default, and the default is the point: on, this verb answers a HYPOTHETICAL — what
   * these bytes would have scored for an application that strips fences — and a hypothetical
   * that ran by default would quietly replace the measurement.
   */
  stripFences?: boolean
}

export interface RescoreResult {
  task: string
  /** What the trace says the run scored, when the record event carried it. */
  recorded?: { detected: number; gradedTotal: number }
  /** What the same completions score today. */
  rescored: { detected: number; gradedTotal: number }
  cases: number
  /** Cases whose recorded outcome and re-scored outcome disagree. The whole point. */
  changed: string[]
  lines: string[]
}

/**
 * A fenced reply, unwrapped. Literal rather than clever: the failure mode measured on this
 * corpus is a whole reply wrapped in ```json … ```, not a fence somewhere in the middle, and a
 * greedy pattern that reached into a completion would start editing content.
 */
export const stripFence = (raw: string): string => {
  const m = /^\s*```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(raw)
  return m ? m[1]! : raw
}

/**
 * Re-score every `case` event in a trace.
 *
 * The task is read from the event rather than assumed: the vital-signs eval writes a `case`
 * event with no `task` field and the two set evals write one with it, so a trace of
 * `--task all` holds four kinds of case interleaved and each has to be graded by its own
 * scorer. Guessing here would produce a number for a task nobody asked about.
 */
export const rescoreTrace = (o: RescoreOptions): RescoreResult[] => {
  const trace = readTrace(o.path)
  const run = eventOf(trace, 'run')
  const record = eventOf(trace, 'record')
  const cases = eventsOf(trace, 'case')
  if (!cases.length) throw new TraceError(`${o.path} holds no case events — there is nothing to re-score`)

  const redacted = cases.filter((c) => isRedacted(c.completion)).length
  if (redacted) {
    // A digest cannot be graded, and grading it as prose would report a corpus of format
    // failures for a model that never emitted one.
    throw new TraceError(
      `${o.path}: ${redacted} of ${cases.length} case events hold a redacted completion, so this run cannot be ` +
        're-scored — its pack does not declare [clinical].corpusSynthetic, which is the setting that decides ' +
        'whether a trace may hold note-derived text at all',
    )
  }

  const header = [
    `re-scoring ${o.path}`,
    `  recorded: model '${String(run?.model ?? record?.model ?? '(not stated)')}' · ` +
      `harness ${String(run?.harness ?? '(not stated)')} · ` +
      `${run?.constrained ? 'constrained' : 'unconstrained'}` +
      // A run that could not name what produced it must not be quoted, and a re-score of it
      // inherits that exactly. See identifyServer.
      (run?.identified === false ? ' · UNIDENTIFIED — this run names no model, do not quote it' : ''),
    `  today:    pack '${o.pack.name}' spec ${o.pack.spec}` + (o.stripFences ? ' · fences stripped before parsing' : ''),
  ]

  const byTask = new Map<string, TraceEvent[]>()
  for (const c of cases) {
    const task = typeof c.task === 'string' ? c.task : 'vital-signs'
    byTask.set(task, [...(byTask.get(task) ?? []), c])
  }

  const results: RescoreResult[] = []
  for (const [task, events] of byTask) {
    if (task === 'vital-signs') results.push(rescoreVital(o, events, record))
    else if (task === 'summary') results.push(rescoreSummary(o, events))
    else if (task === 'note-format') results.push(rescoreFormat(o, events))
    else if (task === 'transcript') results.push(rescoreTranscript(o, events))
    else throw new TraceError(`${o.path} holds case events for an unknown task '${task}'`)
  }
  if (results[0]) results[0].lines = [...header, '', ...results[0].lines]
  return results
}

/** The completion as this re-score will read it, or undefined when there was none. */
const completionOf = (e: TraceEvent, stripFences: boolean | undefined): string | undefined => {
  if (typeof e.completion !== 'string') return undefined
  return stripFences ? stripFence(e.completion) : e.completion
}

const rescoreVital = (o: RescoreOptions, events: TraceEvent[], record: TraceEvent | undefined): RescoreResult => {
  const { fields } = vitalRequest(o.pack, false)
  const quoteRule = loadSettings(o.pack).quoteVerification
  const byName = new Map(loadVitalCases(o.pack, fields).cases.map((c) => [c.name, c]))

  const total = emptyTally()
  const changed: string[] = []
  const lines: string[] = ['=== Vital signs, re-scored from the trace ===']

  for (const e of events) {
    const name = String(e.case)
    const c: VitalCase | undefined = byName.get(name)
    if (!c) {
      // The corpus moved under the trace. Fatal rather than skipped: a re-score missing three
      // notes is a percentage of a different corpus, printed in the format of this one.
      throw new TraceError(
        `${o.path} scores case '${name}', which this pack no longer defines — the trace and the corpus have ` +
          'diverged, so nothing derived from both would describe either',
      )
    }
    const raw = completionOf(e, o.stripFences)
    let scored
    try {
      scored = raw === undefined ? scoreFailure(c) : scoreCase(c, parseVitalSigns(raw, fields), o.pack.document(name), quoteRule)
    } catch {
      // A reply that will not parse today scores as the total loss it is, exactly as it did
      // in the graded run. This is the branch `--strip-fences` exists to move cases OUT of.
      scored = scoreFailure(c)
    }
    absorb(total, scored.tally)

    // The comparison is the whole product. `was` is what the run recorded for this case, which
    // is the only way to see that a re-score moved something rather than merely landing near
    // where the summary said it would.
    const was = e.tally as VitalTally | undefined
    if (was && (was.detected !== scored.tally.detected || was.valueExact !== scored.tally.valueExact)) {
      changed.push(name)
      lines.push(
        `  ${name.padEnd(28)} detected ${was.detected}/${was.gradedTotal} -> ${scored.tally.detected}/${scored.tally.gradedTotal}` +
          `   value ${was.valueExact} -> ${scored.tally.valueExact}`,
      )
    }
  }

  const recorded = record?.tally as VitalTally | undefined
  lines.push(
    `  detection ${pct(total.detected, total.gradedTotal)}` +
      (recorded ? `   recorded ${pct(recorded.detected, recorded.gradedTotal)}` : '   (the trace recorded no total)'),
    `  value ${pct(total.valueExact, total.detected)}   unit ${pct(total.unitExact, total.detected)}   ` +
      `provenance ${pct(total.quoteVerified, total.detected)}`,
    changed.length
      ? `  ${changed.length} case(s) scored differently than the run recorded`
      : '  every case scored exactly what the run recorded',
  )

  return {
    task: 'vital-signs',
    recorded: recorded ? { detected: recorded.detected, gradedTotal: recorded.gradedTotal } : undefined,
    rescored: { detected: total.detected, gradedTotal: total.gradedTotal },
    cases: events.length,
    changed,
    lines,
  }
}

const rescoreSummary = (o: RescoreOptions, events: TraceEvent[]): RescoreResult => {
  const byName = new Map(loadSummaryCases(o.pack).cases.map((c) => [c.name, c]))
  const matching = setMatching(o.pack)
  const total = emptySetTally()
  const changed: string[] = []

  for (const e of events) {
    const name = String(e.case)
    const c = byName.get(name)
    if (!c) throw new TraceError(`${o.path} scores summary case '${name}', which this pack no longer defines`)
    const raw = completionOf(e, o.stripFences)
    let scored
    try {
      scored = raw === undefined ? scoreFailedSet(name, c.fields) : scoreSet(name, c.fields, summaryTexts(parsePatientSummary(raw)), matching)
    } catch {
      scored = scoreFailedSet(name, c.fields)
    }
    absorbSet(total, scored.tally)
    const was = e.tally as { found?: number } | undefined
    if (was && was.found !== scored.tally.found) changed.push(name)
  }

  return {
    task: 'summary',
    rescored: { detected: total.found, gradedTotal: total.required },
    cases: events.length,
    changed,
    lines: [
      '=== Patient summary, re-scored from the trace ===',
      `  item recall ${pct(total.found, total.required)}   items emitted ${total.items}   halluc ${total.hallucinations}`,
      changed.length ? `  ${changed.length} case(s) moved` : '  every case scored what the run recorded',
    ],
  }
}

const rescoreFormat = (o: RescoreOptions, events: TraceEvent[]): RescoreResult =>
  rescoreQuoted(o, events, {
    task: 'note-format',
    heading: 'Note formatting, re-scored from the trace',
    cases: loadFormatCases(o.pack).cases,
    // The note this case was graded over, resolved the way the eval resolved it.
    document: (c) => o.pack.document(c.source, DOCUMENT_KIND['note-format']),
  })

/**
 * The same re-scoring for dictated transcripts, which are graded by the same scorer over the
 * same contract. Written once for both, because a trace of `--task all` now holds four kinds
 * of case event and two of them are graded identically — two copies of this would be free to
 * disagree about the one thing a re-score exists to establish, which is whether the number in
 * the trace is the number the current answer key produces.
 */
const rescoreTranscript = (o: RescoreOptions, events: TraceEvent[]): RescoreResult =>
  rescoreQuoted(o, events, {
    task: 'transcript',
    heading: 'Dictated transcripts, re-scored from the trace',
    cases: loadTranscriptCases(o.pack).cases,
    // The case IS the document: there is no written note behind a dictation.
    document: (c) => o.pack.document(c.name, DOCUMENT_KIND.transcript),
  })

const rescoreQuoted = <C extends { name: string; fields: SetExpectation[] }>(
  o: RescoreOptions,
  events: TraceEvent[],
  t: { task: string; heading: string; cases: C[]; document: (c: C) => string },
): RescoreResult => {
  const byName = new Map(t.cases.map((c) => [c.name, c]))
  const settings = loadSettings(o.pack)
  const rules = {
    quote: settings.quoteVerification,
    derivation: settings.textDerivation,
    matching: setMatching(o.pack),
    medicationName: medicationName(o.pack),
  }
  const total = emptyFormatTally()
  const changed: string[] = []

  for (const e of events) {
    const name = String(e.case)
    const c = byName.get(name)
    if (!c) throw new TraceError(`${o.path} scores ${t.task} case '${name}', which this pack no longer defines`)
    const raw = completionOf(e, o.stripFences)
    let scored
    try {
      scored =
        raw === undefined
          ? scoreFailedFormat(name, c.fields)
          : scoreFormatCase(name, c.fields, parseNoteFormat(raw), t.document(c), rules)
    } catch {
      scored = scoreFailedFormat(name, c.fields)
    }
    absorbFormat(total, scored.tally)
    const was = e.tally as { found?: number } | undefined
    if (was && was.found !== scored.tally.found) changed.push(name)
  }

  return {
    task: t.task,
    rescored: { detected: total.found, gradedTotal: total.required },
    cases: events.length,
    changed,
    lines: [
      `=== ${t.heading} ===`,
      `  item recall ${pct(total.found, total.required)}   provenance ${pct(total.quotesVerified, total.quotes)}   ` +
        `derivation ${pct(total.derivationsOk, total.derivations)}` +
        // Only when the task emitted medication, so the three tasks without it read exactly as
        // they did before this axis existed. Re-scoring a RECORDED run against a new check is
        // most of the point of having one: the trace holds the completions, so an axis added
        // today can be measured over every run this pack has already stored.
        (total.names ? `   drug name ${pct(total.namesOk, total.names)}` : ''),
      changed.length ? `  ${changed.length} case(s) moved` : '  every case scored what the run recorded',
    ],
  }
}

/**
 * The one line a re-score ends on.
 *
 * It reports agreement with the trace, NOT a pass. A re-score has no gate of its own on
 * purpose: the floors belong to a graded run against a server, and a verb that could turn a
 * saved file into a PASS would be a way to pass CI without running anything.
 */
export const rescoreSummaryLine = (results: RescoreResult[]): string =>
  results
    .map(
      (r) =>
        `${r.task}: ${r.rescored.detected}/${r.rescored.gradedTotal} over ${r.cases} recorded case(s)` +
        (r.recorded ? ` (the run recorded ${r.recorded.detected}/${r.recorded.gradedTotal})` : '') +
        (r.changed.length ? ` — ${r.changed.length} moved` : ' — unchanged'),
    )
    .join('\n       ')

export { ratio }
