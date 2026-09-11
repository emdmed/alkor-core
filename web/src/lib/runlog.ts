/**
 * The run log: everything the server said about one dashboard run, as plain text.
 *
 * A run produces two separate accounts — the HTTP answer the caller holds, and the
 * activity events the feed carried while it was produced — and neither is enough on its
 * own. A failure is the case that proves it: the response says "HTTP 500: connect
 * ECONNREFUSED" and the feed says which step was running, which backend it was talking to,
 * and how long it had been waiting. This module joins them into one block of text a person
 * can select, copy, and paste into a bug report.
 *
 * Pure and dependency-free, so it is unit-tested without a renderer or a server.
 *
 * Scoping: a run's own events carry its `runId`, but the events that bracket it (the HTTP
 * request itself, a backend spawning) are emitted outside the run's activity scope and
 * carry no id at all. Dropping them would hide exactly the setup failures worth reading, so
 * the window is sequence-based — events between the send and the next send — and the id is
 * used to exclude events belonging to a DIFFERENT run inside that window.
 */
import type { ActivityEvent } from '../../../src/core/activity-types.ts'

export interface RunLogRequest {
  /** What was sent. Kept whole: the log is for the operator who typed it. */
  input: string
  /** The workflow, once known; before that, whatever the UI was showing. */
  workflow: string
  /** Set when the caller forced a workflow instead of letting the router choose. */
  forcedWorkflow?: string
  runId?: string
  /** Wall-clock start, ISO, from the browser. */
  startedAt: string
  endedAt?: string
  status: 'pending' | 'done' | 'error'
  /** The response body on success. */
  result?: unknown
  /** The failure message as the client saw it, including any HTTP status. */
  error?: string
  /** The server this ran against. */
  serverUrl: string
  /** Sequence watermark when the run was sent; events at or below it are older. */
  fromSeq: number
  /** Watermark of the next run, when one exists. Open-ended for the newest run. */
  toSeq?: number
}

/** Keys stamped on every event; they are rendered by the line's own prefix, not as fields. */
const BASE_KEYS = new Set(['activitySpec', 'seq', 'ts', 'kind', 'instanceId', 'runId', 'sessionId', 'requestId', 'parentId'])

/**
 * The events belonging to one run, in order.
 *
 * An event inside the window with a DIFFERENT `runId` belongs to another run and is left
 * out; one with no id at all is transport or backend lifecycle that happened during this
 * run, and is kept.
 */
export const eventsForRun = (events: readonly ActivityEvent[], req: Pick<RunLogRequest, 'runId' | 'fromSeq' | 'toSeq'>): ActivityEvent[] =>
  events.filter((e) => {
    if (e.seq <= req.fromSeq) return false
    if (req.toSeq != null && e.seq > req.toSeq) return false
    if (e.runId == null) return true
    return req.runId == null || e.runId === req.runId
  })

/** `12:04:09.812` — the wall time an event was stamped with, as the event log shows it. */
const clockOf = (ts: string): string => (ts.length >= 23 ? ts.slice(11, 23) : ts)

/** Elapsed since the first line of the run, so a stall is visible without doing arithmetic. */
const elapsedOf = (ts: string, originMs: number): string => {
  const ms = Date.parse(ts) - originMs
  if (!Number.isFinite(ms)) return ''
  return `+${(ms / 1000).toFixed(2)}s`
}

const scalar = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  if (typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * One event as one line, by reflection rather than by a per-kind case.
 *
 * A switch over kinds is a list that goes stale silently: the day a profile emits a new
 * field, the log is the last place anyone notices it is missing. Printing whatever the
 * event carries means a new field appears in the log the moment it appears on the wire.
 */
export const formatEventLine = (event: ActivityEvent, originMs: number): string => {
  const fields = Object.entries(event as unknown as Record<string, unknown>)
    .filter(([key, value]) => !BASE_KEYS.has(key) && key !== 'stageId' && value !== undefined)
    .map(([key, value]) => `${key}=${scalar(value)}`)
  const req = event.requestId ? ` req=${event.requestId.slice(0, 8)}` : ''
  return `${clockOf(event.ts)}  ${elapsedOf(event.ts, originMs).padStart(8)}  ${String(event.kind).padEnd(22)}${req} ${fields.join(' ')}`.trimEnd()
}

/** The response body, rendered whole. It is the run's product; nothing is summarised away. */
const formatValue = (value: unknown): string => {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const section = (title: string, body: string): string => `--- ${title} ---\n${body}\n`

/**
 * The whole run as copyable text.
 *
 * Ordered by what a reader needs first: the verdict, then the error if there was one, then
 * the timeline that explains it, then the payloads. A failing run's message is above the
 * fold and never buried under a successful-looking transcript.
 */
export const formatRunLog = (req: RunLogRequest, events: readonly ActivityEvent[]): string => {
  const scoped = eventsForRun(events, req)
  const originMs = Date.parse(req.startedAt)
  const durationMs = req.endedAt ? Date.parse(req.endedAt) - Date.parse(req.startedAt) : undefined

  const head = [
    `medextract run log`,
    `server    ${req.serverUrl}`,
    `started   ${req.startedAt}`,
    `status    ${req.status}`,
    `workflow  ${req.workflow}${req.forcedWorkflow ? ' (forced — router bypassed)' : ''}`,
    `run id    ${req.runId ?? '(none — the server never named a run)'}`,
    durationMs != null && Number.isFinite(durationMs) ? `duration  ${(durationMs / 1000).toFixed(2)}s` : undefined,
  ].filter((line): line is string => line !== undefined)

  const parts = [head.join('\n') + '\n']

  if (req.error) parts.push(section('error', req.error))

  parts.push(
    section(
      `events (${scoped.length})`,
      scoped.length === 0
        ? req.status === 'pending'
          ? '(nothing yet — the run has not emitted an event)'
          : '(no events — the feed was disconnected, cleared, or the run failed before it started)'
        : scoped.map((e) => formatEventLine(e, Number.isFinite(originMs) ? originMs : Date.parse(e.ts))).join('\n'),
    ),
  )

  parts.push(section(`prompt (${req.input.length} chars)`, req.input))

  if (req.result !== undefined) parts.push(section('response', formatValue(req.result)))

  return parts.join('\n')
}
