/**
 * JSONL tracing.
 *
 * SAFETY: for a clinical profile a trace line contains the raw prompt and completion —
 * that is patient data. So traces default to a path OUTSIDE any repository
 * (`$XDG_STATE_HOME/alkor/traces/`), never a `logs/` directory inside the
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

/**
 * The directory every trace is written under, and therefore the only directory anything
 * reads them back from. Exported so the reader and the writer cannot disagree about where
 * a run went: a lister that hardcoded this path would go blind the moment TRACE_DIR is set.
 */
export const traceRoot = () =>
  process.env.TRACE_DIR ?? join(stateRoot(), 'alkor', 'traces')

/** Deterministic, filesystem-safe stamp. Callers pass one in to keep runs comparable. */
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

/**
 * Several profiles' redaction judgements, applied in turn as one hook.
 *
 * A workflow traces under the WORKFLOW's name, but the lines in that file are written by its
 * steps — so the redactor of the profile that opened the trace is not the only one with an
 * opinion about the content in it. Composing them is what stops a workflow wrapper with no
 * redactor of its own writing a step's raw completions to disk.
 *
 * Each redactor must appear ONCE. `redactClinical` replaces a completion with a digest of it,
 * and a second application would digest the marker instead — still redacted, but a hash of
 * the wrong string, which is worse than useless to a reader comparing two runs. Callers
 * deduplicate by profile, which is the boundary that means something: one profile, one
 * judgement about its own content.
 */
export const composeRedactors = (...redactors: readonly Redactor[]): Redactor =>
  redactors.length === 0
    ? (event) => event
    : (event) => redactors.reduce((acc, redact) => redact(acc), event)

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

/**
 * Open a trace for one run.
 *
 * `runId` is the server's id for the run, and naming the file after it is what lets a caller
 * holding only that id find the recording later. The separator is a DOUBLE dash: the stamp is
 * an ISO timestamp with its colons and dots turned into single dashes, so a single one would
 * not be a boundary any reader could split on. A trace opened without an id — every CLI verb —
 * keeps the plain stamped name it always had.
 */
export const openTrace = (profile: string, redact: Redactor = (e) => e, runId?: string): Trace => {
  const dir = join(traceRoot(), profile)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, runId ? `${stamp()}--${runId}.jsonl` : `${stamp()}.jsonl`)
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
