/**
 * JSONL tracing.
 *
 * SAFETY: for a clinical profile a trace line contains the raw prompt and completion —
 * that is patient data. So traces default to a path OUTSIDE any repository
 * (`$XDG_STATE_HOME/medextract/traces/`), never a `logs/` directory inside the
 * project, because the failure mode is not "an untidy repo" but "PHI committed to
 * GitHub". Override with TRACE_DIR only if you know where it is pointing.
 *
 * A profile supplies a `redact` hook; a profile handling patient data must set one before this is
 * ever pointed at real records. Today's example patients are synthetic, so the default
 * hook is identity — that is a statement about the corpus, not a safe default for
 * production.
 */
import { appendFileSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type Redactor = (event: Record<string, unknown>) => Record<string, unknown>

/**
 * The trace format a reader is looking at.
 *
 * Consumers parse `run` / `case` / `bench` / `record` events BY SHAPE, which works exactly
 * until the shape changes: a field renamed here becomes a field silently absent there, and the
 * consumer goes on producing a number from the half of the event it still recognises. A pack
 * carries `spec` for the same reason and refuses a version it does not read; a trace is the
 * other half of the same claim — that nothing has to be taken on faith — and it had no way to
 * say what it was.
 *
 * Written on EVERY line rather than in a header, because the unit of a JSONL file is the line.
 * One `grep` pulls a single event out of a trace and hands it to something that never saw the
 * top of the file, and a self-describing line survives that where a header does not.
 *
 * Bump this when an event's fields change meaning or disappear. Adding a field is not a bump:
 * a reader that ignores what it does not know is unharmed, which is the same rule the pack
 * format states for itself.
 */
export const TRACE_SPEC = 1

export interface Trace {
  path: string
  write(event: Record<string, unknown>): void
  close(): void
}

/**
 * Everything this harness writes about a run goes under here, OUTSIDE any repository, for
 * the reason at the top of this file. Exported so that anything else persisting
 * conversation content — which is the same data wearing a different name — cannot
 * accidentally choose a friendlier-looking directory inside the project.
 */
export const stateRoot = () =>
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')

const defaultTraceRoot = () =>
  process.env.TRACE_DIR ?? join(stateRoot(), 'medextract', 'traces')

/** Deterministic, filesystem-safe stamp. Callers pass one in to keep runs comparable. */
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

/**
 * A trace that records nothing, for a verb that produces no run.
 *
 * `eval --from-trace` READS a recording and contacts no server, so opening a second file to
 * write nothing into would leave a dated empty trace on disk for every re-score — and a
 * directory of empty traces is a directory in which the real ones are harder to find. It is a
 * value rather than an optional parameter because every consumer of `Trace` should be able to
 * assume there is one.
 */
export const nullTrace = (): Trace => ({ path: '(not recorded)', write: () => {}, close: () => {} })

export const openTrace = (profile: string, redact: Redactor = (e) => e): Trace => {
  const dir = join(defaultTraceRoot(), profile)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${stamp()}.jsonl`)
  closeSync(openSync(path, 'a'))

  return {
    path,
    write(event) {
      // `traceSpec` and `ts` lead the line, and neither an event nor a redactor can displace
      // them — the reassignment after the spread keeps their values while leaving them in
      // their original positions. A redactor is a profile's judgement about CONTENT, and a
      // line that could lose its own version number to one is a line no reader can refuse.
      const line = { traceSpec: TRACE_SPEC, ts: new Date().toISOString(), ...redact(event) }
      line.traceSpec = TRACE_SPEC
      appendFileSync(path, `${JSON.stringify(line)}\n`)
    },
    close() {
      // stderr, not stdout. Where the trace went is a diagnostic about the run; stdout is
      // the run's RESULT, and `extract --json` is meant to be piped into the application
      // that would consume the reading. A path printed into that stream is a parse error
      // in somebody else's program.
      console.error(`trace: ${path}`)
    },
  }
}
