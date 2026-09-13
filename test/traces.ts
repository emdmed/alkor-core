/**
 * A trace directory of the test file's own.
 *
 * The server records every run it executes, which means a test that drives one writes a real
 * JSONL file — and the default destination is `~/.local/state/alkor/traces/`, the operator's
 * own record of what this machine has run. A suite that scattered fixtures through it would
 * be corrupting the evidence the product exists to keep, and it would do so on a developer's
 * machine rather than in CI where somebody would notice.
 *
 * `TRACE_DIR` is read at every `openTrace` call rather than captured at import, so setting it
 * from a test module is enough — there is no ordering rule to remember about when the server
 * is constructed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Point this process's traces at a throwaway directory, and remove it on exit.
 *
 * Returns the directory, because a test asserting that a run WAS recorded needs to look in
 * it. Cleanup is on `exit` rather than in each test's `finally`: a test that fails partway
 * leaves a server and a trace behind by definition, and that is the case where leaving
 * megabytes in `/tmp` is least excusable.
 */
export const isolateTraces = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `alkor-traces-${label}-`))
  process.env.TRACE_DIR = dir
  // The state root goes with it, and that is not housekeeping: the settings store persists
  // overrides under `stateRoot()/alkor/settings.json`, and a server built in a test reads
  // that file at construction. Left alone, every server test on this machine would inherit
  // whatever the developer had last saved in the dashboard — a suite whose result depends
  // on the host's configuration is a suite that passes or fails for reasons nobody can see.
  // Setting it here reaches all of them, because every test that builds a server calls this.
  process.env.XDG_STATE_HOME = dir
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  return dir
}
