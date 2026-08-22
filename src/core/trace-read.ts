/**
 * Reading a trace back.
 *
 * The trace exists so that a number does not have to be believed, and until now the writing
 * half was the only half that was implemented. The most useful analysis in this repository's
 * RESULTS.md — "that 0/88 is a format failure, and here is the same run at 84/84 with the
 * fence stripped" — was produced by a hand-written script, twice, both times reaching into
 * scoring internals that are not part of any public surface. A claim about a past run that
 * only its author can check is not much better than a claim with no file behind it.
 *
 * So this is the reader, and it is deliberately in core rather than in a profile: a JSONL file
 * of versioned events is not a medical object. What the events MEAN belongs to whoever wrote
 * them; that they are lines, that a line carries `traceSpec`, and that a spec from the future
 * must be refused rather than guessed at, belong here.
 */
import { readFileSync } from 'node:fs'
import { TRACE_SPEC } from './trace.ts'

export class TraceError extends Error {}

export interface TraceEvent extends Record<string, unknown> {
  event?: string
  traceSpec?: number
}

export interface TraceFile {
  path: string
  /** The highest spec any line declared. Lines predating the field count as 0. */
  spec: number
  events: TraceEvent[]
}

/**
 * Parse a trace file. A malformed LINE is fatal, not skipped.
 *
 * Skipping would be the friendlier behaviour and the wrong one: this file is read in order to
 * re-derive a number, and a re-derivation that quietly dropped the three cases it could not
 * parse would report a percentage of a corpus nobody chose — the same failure the difficulty
 * filter and the zero-denominator gate exist to prevent, arriving through the back door.
 */
export const readTrace = (path: string): TraceFile => {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new TraceError(`cannot read trace ${path}: ${(e as Error).message}`)
  }

  const events: TraceEvent[] = []
  let spec = 0
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue
    let parsed: TraceEvent
    try {
      parsed = JSON.parse(line) as TraceEvent
    } catch (e) {
      // A trace is appended to while a run is in flight, so the LAST line of a file from a
      // killed run is routinely half-written. That one is worth forgiving by name; any other
      // is a corrupt file and re-scoring it would produce a number from part of a run.
      if (i === lines.length - 1) continue
      throw new TraceError(`${path}:${i + 1} is not valid JSON: ${(e as Error).message}`)
    }
    if (typeof parsed.traceSpec === 'number') spec = Math.max(spec, parsed.traceSpec)
    events.push(parsed)
  }

  if (!events.length) throw new TraceError(`${path} holds no events`)
  if (spec > TRACE_SPEC) {
    // Exactly what `loadPack` does with a pack from the future, and for the same reason: a
    // reader that guesses at an event shape it does not know produces a number rather than an
    // error, and a number from a misunderstanding is the one outcome this file exists to
    // prevent.
    throw new TraceError(
      `${path} declares traceSpec ${spec}, but this harness reads ${TRACE_SPEC} — upgrade the harness`,
    )
  }
  return { path, spec, events }
}

/** Every event of one kind, in the order they were written. */
export const eventsOf = (trace: TraceFile, kind: string): TraceEvent[] =>
  trace.events.filter((e) => e.event === kind)

/** The first event of one kind — `run` and `record` occur once each. */
export const eventOf = (trace: TraceFile, kind: string): TraceEvent | undefined =>
  trace.events.find((e) => e.event === kind)

/**
 * The marker `redactClinical` leaves behind, recognised WITHOUT importing the profile that
 * writes it.
 *
 * A redacted trace holds a digest where the completion was, and a digest cannot be re-scored.
 * That has to fail loudly: `[redacted 412 chars, sha256:…]` is a perfectly good string, it
 * parses as prose rather than JSON, and a re-scoring run that treated it as a bad reply would
 * report a corpus of format failures for a model that never emitted one.
 */
export const isRedacted = (completion: unknown): boolean =>
  typeof completion === 'string' && /^\[redacted \d+ chars, sha256:[0-9a-f]+\]$/.test(completion)
