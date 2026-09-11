/**
 * The dashboard's run log: one run's HTTP answer joined to the events that produced it.
 *
 * The failing cases are the point. A log that silently swallowed another run's events, or
 * that dropped the un-scoped transport events a setup failure lives in, would read as a
 * complete account while being wrong — and it is pasted into bug reports as if it were one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventsForRun, formatEventLine, formatRunLog, type RunLogRequest } from '../web/src/lib/runlog.ts'
import { ACTIVITY_SPEC } from '../src/core/activity.ts'
import type { ActivityEvent } from '../src/core/activity.ts'

const at = (seq: number, partial: Record<string, unknown>): ActivityEvent => ({
  activitySpec: ACTIVITY_SPEC,
  seq,
  ts: new Date(Date.parse('2026-09-11T10:00:00.000Z') + seq * 1000).toISOString(),
  ...partial,
} as ActivityEvent)

const base: RunLogRequest = {
  input: 'BP 82/40, HR 128',
  workflow: 'clinical-shock',
  runId: 'run-a',
  startedAt: '2026-09-11T10:00:00.000Z',
  status: 'done',
  serverUrl: 'http://127.0.0.1:3000',
  fromSeq: 10,
}

test('the window keeps this run and the transport around it, and drops another run', () => {
  const events = [
    at(9, { kind: 'run.started', profile: 'other', runId: 'run-a' }), // below the watermark
    at(11, { kind: 'http.request', method: 'POST', path: '/pipeline' }), // no run id: kept
    at(12, { kind: 'run.started', profile: 'clinical-shock', runId: 'run-a' }),
    at(13, { kind: 'run.started', profile: 'somethingelse', runId: 'run-b' }), // another run
    at(14, { kind: 'run.completed', profile: 'clinical-shock', runId: 'run-a', wallMs: 20 }),
    at(20, { kind: 'run.started', profile: 'later', runId: 'run-c' }), // above the upper bound
  ]
  const kept = eventsForRun(events, { runId: 'run-a', fromSeq: 10, toSeq: 15 })
  assert.deepEqual(kept.map((e) => e.seq), [11, 12, 14])
})

test('an open-ended window has no upper bound, so a running run fills in live', () => {
  const events = [at(11, { kind: 'run.started', profile: 'x', runId: 'run-a' }), at(99, { kind: 'stage', name: 'verify', status: 'started', runId: 'run-a' })]
  assert.equal(eventsForRun(events, { runId: 'run-a', fromSeq: 10 }).length, 2)
})

test('a run with no id of its own still gets its window, rather than nothing', () => {
  // The server refused before minting a run id; the transport events are all there is.
  const events = [at(11, { kind: 'http.request', method: 'POST', path: '/pipeline' })]
  assert.equal(eventsForRun(events, { runId: undefined, fromSeq: 10 }).length, 1)
})

test('an event line prints the fields it actually carries, including a new one', () => {
  const line = formatEventLine(
    at(12, { kind: 'llm.error', requestId: 'abcdefgh-1234', wallMs: 4000, message: 'connect ECONNREFUSED' }),
    Date.parse('2026-09-11T10:00:00.000Z'),
  )
  assert.match(line, /llm\.error/)
  assert.match(line, /req=abcdefgh/)
  assert.match(line, /message=connect ECONNREFUSED/)
  assert.match(line, /wallMs=4000/)
  // Reflection, not a per-kind case: a field nobody wrote a branch for still shows up.
  assert.match(formatEventLine(at(13, { kind: 'stage', name: 'shock', status: 'started', somethingNew: 7 }), 0), /somethingNew=7/)
  // The stamped envelope is in the prefix, not repeated as fields.
  assert.doesNotMatch(line, /activitySpec=/)
})

test('a failed run leads with its error and still carries the events it managed to emit', () => {
  const events = [
    at(11, { kind: 'run.started', profile: 'clinical-shock', runId: 'run-a' }),
    at(12, { kind: 'llm.error', requestId: 'r1', wallMs: 3, message: 'connect ECONNREFUSED 127.0.0.1:8081', runId: 'run-a' }),
    at(13, { kind: 'run.failed', profile: 'clinical-shock', wallMs: 40, error: 'connect ECONNREFUSED 127.0.0.1:8081', runId: 'run-a' }),
  ]
  const log = formatRunLog(
    { ...base, status: 'error', error: 'HTTP 500: connect ECONNREFUSED 127.0.0.1:8081', endedAt: '2026-09-11T10:00:02.000Z' },
    events,
  )
  assert.ok(log.indexOf('--- error ---') < log.indexOf('--- events'), 'the error must be above the transcript')
  assert.match(log, /status {4}error/)
  assert.match(log, /run id {4}run-a/)
  assert.match(log, /duration {2}2\.00s/)
  assert.match(log, /events \(3\)/)
  assert.match(log, /run\.failed/)
  assert.match(log, /BP 82\/40, HR 128/)
  // No response section on a run that produced nothing.
  assert.doesNotMatch(log, /--- response ---/)
})

test('an empty feed says why it is empty instead of reading as a clean run', () => {
  const pending = formatRunLog({ ...base, status: 'pending' }, [])
  assert.match(pending, /has not emitted an event/)
  const settled = formatRunLog({ ...base, status: 'error', error: 'HTTP 503: backend down' }, [])
  assert.match(settled, /disconnected, cleared, or the run failed before it started/)
})

test('a run the server never named says so rather than printing an empty field', () => {
  const log = formatRunLog({ ...base, runId: undefined, status: 'error', error: 'could not reach http://127.0.0.1:3000' }, [])
  assert.match(log, /run id {4}\(none/)
})

test('a successful run carries its response and the workflow that produced it', () => {
  const log = formatRunLog(
    { ...base, result: { workflow: 'clinical-shock', ending: 'Shock: indeterminate', totalMs: 900 }, endedAt: '2026-09-11T10:00:01.000Z' },
    [at(11, { kind: 'run.completed', profile: 'clinical-shock', wallMs: 900, runId: 'run-a' })],
  )
  assert.match(log, /--- response ---/)
  assert.match(log, /Shock: indeterminate/)
  assert.match(log, /workflow {2}clinical-shock/)
  assert.doesNotMatch(log, /forced/)
})

test('a forced workflow is recorded, because it means the router never ran', () => {
  const log = formatRunLog({ ...base, forcedWorkflow: 'clinical-shock' }, [])
  assert.match(log, /forced — router bypassed/)
})
