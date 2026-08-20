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

export const openTrace = (profile: string, redact: Redactor = (e) => e): Trace => {
  const dir = join(defaultTraceRoot(), profile)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${stamp()}.jsonl`)
  closeSync(openSync(path, 'a'))

  return {
    path,
    write(event) {
      appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...redact(event) })}\n`)
    },
    close() {
      console.log(`trace: ${path}`)
    },
  }
}
