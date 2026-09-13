/**
 * The runs this harness has recorded, enumerated for a reader.
 *
 * A trace is written so that a number does not have to be believed. Until now the only way to
 * reach one was to know the path it was printed to — which is fine for the verb that printed
 * it and useless to anyone who came back an hour later, or to a dashboard that was not open
 * at the time. The activity feed is not that reader either: it is metadata-only by
 * construction and bounded by a ring buffer, so a run that has scrolled out of it is gone
 * from every surface even though its recording is sitting on disk.
 *
 * This module is the index over that disk. It reads the trace directory and nothing else —
 * no database, no sidecar manifest — because a second record of what ran is a second record
 * that can disagree with the first, and the traces are the ones that carry the evidence.
 *
 * Nothing here interprets a run. What the events MEAN belongs to whoever wrote them, as
 * `trace-read.ts` says; this knows only that traces are files, that a file is named after its
 * profile and its moment, and that the server writes an envelope around what it ran.
 */
import { closeSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { traceRoot } from './trace.ts'
import { readTrace, type TraceFile } from './trace-read.ts'

export class RunError extends Error {}

/**
 * The envelope the SERVER writes around a run, as two trace events.
 *
 * Deliberately not `run`: profiles already write `event: 'run'` — once per review, so several
 * times in one workflow file — and a server header sharing that name would make `eventOf`
 * return whichever came first. The prefix says who wrote the line, which is the fact a reader
 * of a mixed file actually needs.
 */
export const RUN_HEADER_EVENT = 'server-run'
export const RUN_FOOTER_EVENT = 'server-result'

/**
 * How much of a trace's tail is read to find its outcome.
 *
 * A listing has to say which runs failed or it is a list of undifferentiated slugs, and the
 * footer is the last line of the file — so the whole file never needs reading to find it.
 * 64 KiB is many times the longest footer this writes and still a bounded read per entry,
 * which matters because a clinical trace routinely runs to megabytes of prompts.
 */
const TAIL_BYTES = 64 * 1024

/** What the server's footer records about how a run ended. */
export interface RunOutcome {
  ok: boolean
  wallMs?: number
  error?: string
  /**
   * The run was stopped by whoever started it.
   *
   * Carried beside `ok` rather than folded into it: a cancelled run did not succeed, so `ok`
   * is false, but it did not fail either — nothing about it is a statement about the model or
   * the contract. A reader totting up failures needs to be able to leave these out, and
   * before this field existed the only way to spot one was to recognise a message.
   */
  cancelled?: boolean
}

/** One recorded run, as its file and its footer describe it. */
export interface RunSummary {
  /** `<profile>/<filename stem>` — stable, and the path segment that fetches it. */
  id: string
  /** The server's run id, when the filename carries one. Absent for a CLI trace. */
  runId?: string
  /** The directory the trace sits in, which is the profile the run was opened under. */
  profile: string
  /** Absolute path on disk, so an operator can reach the file directly. */
  path: string
  /** Decoded from the filename stamp. Absent if the name predates the convention. */
  startedAt?: string
  bytes: number
  /**
   * How the run ended, from the footer.
   *
   * ABSENT IS NOT "SUCCEEDED". No footer means no footer was written: the run is still in
   * flight, or the process died under it, or a CLI verb wrote this trace and never had an
   * envelope to close. A reader that rendered absence as a pass would report a completion
   * for a run that was killed.
   */
  outcome?: RunOutcome
}

/**
 * The ISO instant a stamped filename encodes, or undefined if it is not one.
 *
 * `openTrace` builds the name by replacing every `:` and `.` of an ISO string with a dash, so
 * this reverses exactly that and refuses anything else rather than guessing. A trace named by
 * hand is still listable; it simply has no start time to report, which is the truth.
 */
const startedAtOf = (stem: string): string | undefined => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stem)
  if (!m) return undefined
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`
}

/** The last `bytes` of a file, as text. Opened once and closed on every path. */
const tail = (path: string, bytes: number): { text: string; size: number } => {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, bytes)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, size - length)
    return { text: buf.toString('utf8'), size }
  } finally {
    closeSync(fd)
  }
}

/**
 * The footer, found by scanning the tail backwards.
 *
 * Backwards because the footer is the last thing written, and a line that does not parse is
 * skipped rather than fatal here — unlike `readTrace`, which is re-deriving a number and must
 * refuse a file it only half understands. This is a listing: the first line of a tail read is
 * cut mid-JSON by definition, and the honest answer to a file whose end is unreadable is "no
 * outcome recorded", not an exception that hides every other run in the directory.
 */
const outcomeOf = (text: string): RunOutcome | undefined => {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (!line) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (parsed.event !== RUN_FOOTER_EVENT) continue
    return {
      ok: parsed.ok === true,
      wallMs: typeof parsed.wallMs === 'number' ? parsed.wallMs : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      ...(parsed.cancelled === true ? { cancelled: true } : {}),
    }
  }
  return undefined
}

/** One trace file, described. Returns undefined if it vanished between listing and reading. */
const summarize = (root: string, profile: string, file: string): RunSummary | undefined => {
  const path = join(root, profile, file)
  const stem = file.slice(0, -'.jsonl'.length)
  // `--` is the boundary `openTrace` writes; the stamp's own dashes are all single.
  const cut = stem.indexOf('--')
  const stamp = cut === -1 ? stem : stem.slice(0, cut)
  const runId = cut === -1 ? undefined : stem.slice(cut + 2)
  let read: { text: string; size: number }
  try {
    read = tail(path, TAIL_BYTES)
  } catch {
    return undefined
  }
  return {
    id: `${profile}/${stem}`,
    runId: runId || undefined,
    profile,
    path,
    startedAt: startedAtOf(stamp),
    bytes: read.size,
    outcome: outcomeOf(read.text),
  }
}

export interface ListRunsOptions {
  /** Only runs traced under this profile directory. */
  profile?: string
  /** How many to return, newest first. */
  limit?: number
}

/**
 * Every recorded run, newest first.
 *
 * Sorted by the FILENAME rather than by mtime: the name carries the moment the run started,
 * and mtime carries the moment its last line was appended — so ordering by mtime would file a
 * slow run that began at noon after a fast one that began at one. A reader scanning for "what
 * did I run this morning" wants the first of those. Traces sort lexically because the stamp
 * is fixed-width ISO, which is the reason it is written that way.
 *
 * A directory that is not there is an empty list, not an error: a fresh clone that has never
 * run anything is the ordinary case, and a dashboard asking what has run should be told
 * "nothing" rather than shown a failure.
 */
export const listRuns = (options: ListRunsOptions = {}): RunSummary[] => {
  const root = traceRoot()
  let profiles: string[]
  try {
    profiles = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  if (options.profile) profiles = profiles.filter((name) => name === options.profile)

  const found: Array<{ profile: string; file: string }> = []
  for (const profile of profiles) {
    let files: string[]
    try {
      files = readdirSync(join(root, profile))
    } catch {
      continue
    }
    for (const file of files) {
      if (file.endsWith('.jsonl')) found.push({ profile, file })
    }
  }

  // Ordered before it is summarized, so a `limit` bounds the number of files OPENED and not
  // just the number returned. On a machine with a year of traces that is the difference
  // between a listing and a directory scan that reads every one of them.
  found.sort((a, b) => b.file.localeCompare(a.file))
  const limit = options.limit !== undefined && options.limit >= 0 ? options.limit : found.length

  const runs: RunSummary[] = []
  for (const entry of found) {
    if (runs.length >= limit) break
    const summary = summarize(root, entry.profile, entry.file)
    if (summary) runs.push(summary)
  }
  return runs
}

/**
 * One recorded run, by the id `listRuns` gave it or by the run id the server minted.
 *
 * Resolved by ENUMERATING the runs and matching, never by joining the id onto a path — the
 * same rule `readCorpusDocument` follows and for the same reason. The id arrives over HTTP,
 * and a path built from it is a file read an outside caller chooses the target of. Matching
 * against the listing means the only readable files are ones this harness wrote.
 *
 * `events` is opt-out because a clinical trace is large and a caller that only wants to know
 * whether a run passed should not have to parse megabytes of prompts to find out.
 */
export const readRun = (
  id: string,
  options: { events?: boolean } = {},
): { summary: RunSummary; trace?: TraceFile } => {
  const summary = listRuns().find((run) => run.id === id || run.runId === id)
  if (!summary) throw new RunError(`no recorded run '${id}'`)
  if (options.events === false) return { summary }
  return { summary, trace: readTrace(summary.path) }
}
