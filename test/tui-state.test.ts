/**
 * TUI state reducer: every event kind, dedup, gaps, refusal, orphan stages, failure rate.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyState,
  applyEvent,
  setConnection,
  failureRate,
  inFlightCount,
  cacheHitRatio,
  tokPerSec,
  stageTreeForRun,
  setTopology,
} from '../src/tui/state.ts'
import { ACTIVITY_SPEC, type ActivityEvent } from '../src/core/activity.ts'

const mkEvent = (partial: Record<string, unknown> & { seq: number }): ActivityEvent => ({
  activitySpec: ACTIVITY_SPEC,
  ts: new Date().toISOString(),
  ...partial,
} as ActivityEvent)

// --- Basic profile / model / run / LLM events ------------------------------------------------

test('profile.loaded adds a profile', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'profile.loaded', seq: 1, name: 'clinical', mode: 'extract' }))
  assert.equal(s.profiles.length, 1)
  assert.equal(s.profiles[0]!.name, 'clinical')
  assert.equal(s.profiles[0]!.mode, 'extract')
})

test('profile.loaded updates an existing profile', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'profile.loaded', seq: 1, name: 'clinical', mode: 'extract' }))
  s = applyEvent(s, mkEvent({ kind: 'profile.loaded', seq: 2, name: 'clinical', mode: 'agentic', url: 'http://x' }))
  assert.equal(s.profiles.length, 1)
  assert.equal(s.profiles[0]!.mode, 'agentic')
  assert.equal(s.profiles[0]!.url, 'http://x')
})

test('topology snapshot seeds the configured graph without manufacturing activity events', () => {
  const s = setTopology(emptyState(), {
    profiles: [{ name: 'flow', mode: 'pipeline' }, { name: 'worker', mode: 'extract' }],
    pipelines: [{ name: 'flow', steps: [{ name: 'first', profile: 'worker', input: 'initial' }] }],
  })
  assert.equal(s.lastSeq, 0)
  assert.equal(s.profiles.length, 2)
  assert.equal(s.topology.pipelines[0]!.steps[0]!.profile, 'worker')
})

test('model.identified keyed by baseUrl', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'model.identified', seq: 1, baseUrl: 'http://127.0.0.1:8080', model: 'Qwen3-4B', ctx: 32768, slots: 1, identified: true }))
  const m = s.models.get('http://127.0.0.1:8080')
  assert.ok(m)
  assert.equal(m!.model, 'Qwen3-4B')
  assert.equal(m!.ctx, 32768)
})

test('model.lifecycle merges into the identified entry without dropping identity', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'model.identified', seq: 1, baseUrl: 'http://127.0.0.1:8081', model: 'Qwen3-4B', ctx: 32768, slots: 1, identified: true }))
  s = applyEvent(s, mkEvent({ kind: 'model.lifecycle', seq: 2, baseUrl: 'http://127.0.0.1:8081', state: 'starting', pid: 42 }))
  const m = s.models.get('http://127.0.0.1:8081')
  assert.ok(m)
  assert.equal(m!.state, 'starting')
  assert.equal(m!.managed, true)
  assert.equal(m!.model, 'Qwen3-4B', 'identity survives the lifecycle event')
  assert.equal(m!.identified, true)
})

test('run.started then run.completed', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'run.started', seq: 1, runId: 'r1', profile: 'clinical', inputChars: 100, inputDigest: 'abc' }))
  s = applyEvent(s, mkEvent({ kind: 'run.completed', seq: 2, profile: 'clinical', wallMs: 200 }))
  const r = s.runs.get('r1')
  assert.ok(r)
  assert.equal(r!.status, 'completed')
  assert.equal(r!.wallMs, 200)
})

test('run.failed increments failures', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'run.started', seq: 1, runId: 'r1', profile: 'clinical', inputChars: 100, inputDigest: 'abc' }))
  s = applyEvent(s, mkEvent({ kind: 'run.failed', seq: 2, profile: 'clinical', wallMs: 200, error: 'boom' }))
  const r = s.runs.get('r1')
  assert.ok(r)
  assert.equal(r!.status, 'failed')
  assert.equal(r!.error, 'boom')
  assert.equal(failureRate(s.runs), 1)
})

test('failureRate with mixed runs', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'run.started', seq: 1, runId: 'r1', profile: 'clinical', inputChars: 100, inputDigest: 'a' }))
  s = applyEvent(s, mkEvent({ kind: 'run.completed', seq: 2, profile: 'clinical', wallMs: 100 }))
  s = applyEvent(s, mkEvent({ kind: 'run.started', seq: 3, runId: 'r2', profile: 'clinical', inputChars: 100, inputDigest: 'b' }))
  s = applyEvent(s, mkEvent({ kind: 'run.failed', seq: 4, profile: 'clinical', wallMs: 100, error: 'x' }))
  assert.equal(failureRate(s.runs), 0.5)
})

test('llm.request stays in-flight until response', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'llm.request', seq: 1, requestId: 'q1', label: 'test', baseUrl: 'http://x', constrained: false, messageCount: 2 }))
  const req = s.llmRequests.get('q1')
  assert.ok(req)
  assert.equal(req!.status, 'in-flight')
  assert.equal(inFlightCount(s.llmRequests), 1)
})

test('llm.response before request is tolerated', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({
    kind: 'llm.response',
    seq: 1,
    requestId: 'q1',
    wallMs: 100,
    promptTokens: 50,
    completionTokens: 20,
    cachedTokens: 10,
    finishReason: 'stop',
  }))
  const req = s.llmRequests.get('q1')
  assert.ok(req)
  assert.equal(req!.status, 'completed')
  assert.equal(req!.label, 'q1') // falls back to requestId
  assert.equal(req!.baseUrl, '') // falls back to empty
  assert.equal(req!.messageCount, 0) // falls back to 0
  assert.equal(inFlightCount(s.llmRequests), 0)
})

test('llm.error marks request errored', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'llm.request', seq: 1, requestId: 'q1', label: 'test', baseUrl: 'http://x', constrained: false, messageCount: 2 }))
  s = applyEvent(s, mkEvent({ kind: 'llm.error', seq: 2, requestId: 'q1', wallMs: 50, message: 'timeout' }))
  const req = s.llmRequests.get('q1')
  assert.equal(req!.status, 'error')
  assert.equal(req!.errorMessage, 'timeout')
})

test('tokPerSec and cacheHitRatio', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'llm.request', seq: 1, requestId: 'q1', label: 'a', baseUrl: 'http://x', constrained: false, messageCount: 2 }))
  s = applyEvent(s, mkEvent({ kind: 'llm.response', seq: 2, requestId: 'q1', wallMs: 1000, promptTokens: 100, completionTokens: 50, cachedTokens: 80 }))
  const req = s.llmRequests.get('q1')!
  assert.equal(tokPerSec(req), 150) // 150 tokens in 1s
  assert.equal(cacheHitRatio(s.llmRequests), 0.8) // 80 / 100
})

// --- Dedup and seq handling ------------------------------------------------------------------

test('duplicate seq is ignored', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'profile.loaded', seq: 1, name: 'a', mode: 'extract' }))
  s = applyEvent(s, mkEvent({ kind: 'profile.loaded', seq: 1, name: 'b', mode: 'agentic' }))
  assert.equal(s.profiles.length, 1)
  assert.equal(s.profiles[0]!.name, 'a')
})

test('seq gap is tolerated (events are not dropped)', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'profile.loaded', seq: 1, name: 'a', mode: 'extract' }))
  s = applyEvent(s, mkEvent({ kind: 'profile.loaded', seq: 5, name: 'b', mode: 'agentic' }))
  assert.equal(s.profiles.length, 2)
  assert.equal(s.lastSeq, 5)
})

/**
 * A restart resets the server's seq to 1, so the watermark must be scoped to the instance —
 * otherwise the reducer discards the entire new stream as already-seen.
 */
test('a new instance id restarts the seq space instead of dropping events', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'run.started', seq: 400, instanceId: 'bus-a', runId: 'r1', profile: 'clinical', inputChars: 10, inputDigest: 'a' }))
  assert.equal(s.lastSeq, 400)

  s = applyEvent(s, mkEvent({ kind: 'profile.loaded', seq: 1, instanceId: 'bus-b', name: 'clinical', mode: 'extract' }))
  assert.equal(s.lastSeq, 1)
  assert.equal(s.instanceId, 'bus-b')
  assert.equal(s.profiles.length, 1)
  // The previous server's runs are dropped, not merged: both processes count seq from 1, so
  // the `stage-${seq}` fallback identity would fuse unrelated nodes across restarts.
  assert.equal(s.runs.size, 0)
  // Dedup still applies within the new instance.
  const before = s
  s = applyEvent(s, mkEvent({ kind: 'profile.loaded', seq: 1, instanceId: 'bus-b', name: 'other', mode: 'extract' }))
  assert.equal(s, before)
})

test('an event without an instance id is judged on seq alone', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'profile.loaded', seq: 2, instanceId: 'bus-a', name: 'a', mode: 'extract' }))
  s = applyEvent(s, mkEvent({ kind: 'profile.loaded', seq: 1, name: 'b', mode: 'extract' }))
  assert.equal(s.lastSeq, 2, 'older stream shape must not look like a restart')
  assert.equal(s.profiles.length, 1)
})

// --- ActivitySpec refusal --------------------------------------------------------------------

test('wrong activitySpec sets refused state', () => {
  let s = emptyState()
  const bad = { ...mkEvent({ kind: 'profile.loaded', seq: 1, name: 'a', mode: 'extract' }), activitySpec: 99 } as unknown as ActivityEvent
  s = applyEvent(s, bad)
  assert.equal(s.connection.kind, 'refused')
  assert.equal((s.connection as { kind: 'refused'; reason: string }).reason.includes('99'), true)
  assert.equal(s.activitySpecRefused, true)
})

// --- HTTP log --------------------------------------------------------------------------------

test('http.request and http.completed pair up', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'http.request', seq: 1, method: 'GET', path: '/health' }))
  s = applyEvent(s, mkEvent({ kind: 'http.completed', seq: 2, method: 'GET', path: '/health', status: 200, wallMs: 10 }))
  assert.equal(s.httpLog.length, 1)
  assert.equal(s.httpLog[0]!.status, 200)
  assert.equal(s.httpLog[0]!.wallMs, 10)
})

test('http.completed without matching request leaves orphan', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'http.completed', seq: 1, method: 'GET', path: '/health', status: 200, wallMs: 10 }))
  assert.equal(s.httpLog.length, 1)
  assert.equal(s.httpLog[0]!.status, 200)
})

test('route decisions and tool events remain available to the execution map', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({
    kind: 'route.decided', seq: 1, profile: 'router', confidence: 0.93,
    reason: 'rule matched', ruleVsModel: 'rule',
  }))
  s = applyEvent(s, mkEvent({ kind: 'tool.called', seq: 2, runId: 'r1', name: 'lookup' }))
  s = applyEvent(s, mkEvent({ kind: 'tool.completed', seq: 3, runId: 'r1', name: 'lookup' }))
  s = applyEvent(s, mkEvent({ kind: 'tool.declined', seq: 4, runId: 'r1', name: 'write' }))

  assert.deepEqual(s.routes, [{
    profile: 'router', confidence: 0.93, reason: 'rule matched', ruleVsModel: 'rule', runId: undefined,
  }])
  assert.deepEqual(s.tools, [
    { name: 'lookup', status: 'called', runId: 'r1' },
    { name: 'lookup', status: 'completed', runId: 'r1' },
    { name: 'write', status: 'declined', runId: 'r1' },
  ])
})

test('route.decided carries runId so the dashboard can attach a decision to its run', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'run.started', seq: 1, runId: 'r9', profile: 'flow', inputChars: 50, inputDigest: 'abc' }))
  s = applyEvent(s, mkEvent({
    kind: 'route.decided', seq: 2, runId: 'r9', profile: 'router', confidence: 0.97,
    reason: 'triage', ruleVsModel: 'model',
  }))
  assert.deepEqual(s.routes, [{
    profile: 'router', confidence: 0.97, reason: 'triage', ruleVsModel: 'model', runId: 'r9',
  }])
})

// --- Pipeline events -------------------------------------------------------------------------

test('pipeline.started, step.started, step.completed, pipeline.completed', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'pipeline.started', seq: 1, runId: 'p1' }))
  s = applyEvent(s, mkEvent({ kind: 'pipeline.step.started', seq: 2, runId: 'p1', step: 0, name: 'extract', profile: 'clinical', input: { ref: 'initial' } }))
  s = applyEvent(s, mkEvent({ kind: 'pipeline.step.completed', seq: 3, runId: 'p1', step: 0, name: 'extract', profile: 'clinical', ok: true, wallMs: 150 }))
  s = applyEvent(s, mkEvent({ kind: 'pipeline.completed', seq: 4, runId: 'p1', stoppedEarly: false, totalMs: 500 }))

  const p = s.pipelines.get('p1')
  assert.ok(p)
  assert.equal(p!.steps.length, 1)
  assert.equal(p!.steps[0]!.status, 'completed')
  assert.equal(p!.steps[0]!.ok, true)
  assert.equal(p!.totalMs, 500)
})

// --- Session events --------------------------------------------------------------------------

test('session.created, turn.started, turn.completed, session.destroyed', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'session.created', seq: 1, sessionId: 's1', profile: 'clinical' }))
  s = applyEvent(s, mkEvent({ kind: 'turn.started', seq: 2, sessionId: 's1', turn: 1 }))
  s = applyEvent(s, mkEvent({
    kind: 'turn.completed',
    seq: 3,
    sessionId: 's1',
    turn: 1,
    stop: 'answered',
    steps: 2,
    toolsUsed: ['readFile'],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0 },
  }))
  s = applyEvent(s, mkEvent({ kind: 'session.destroyed', seq: 4, sessionId: 's1' }))

  const sess = s.sessions.get('s1')
  assert.ok(sess)
  assert.equal(sess!.turns.length, 1)
  assert.equal(sess!.turns[0]!.stop, 'answered')
  assert.equal(sess!.turns[0]!.usage!.totalTokens, 15)
  assert.equal(sess!.destroyed, true)
})

// --- Stage tree ------------------------------------------------------------------------------

test('stage events are stored flat; stageTreeForRun builds hierarchy', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'stage', seq: 1, runId: 'r1', stageId: 'root', name: 'run', status: 'started' }))
  s = applyEvent(s, mkEvent({ kind: 'stage', seq: 2, runId: 'r1', stageId: 'child', parentId: 'root', name: 'extract', status: 'started' }))
  s = applyEvent(s, mkEvent({ kind: 'stage', seq: 3, runId: 'r1', stageId: 'child', parentId: 'root', name: 'extract', status: 'completed', wallMs: 100 }))

  const tree = stageTreeForRun(s.stages, 'r1')
  assert.equal(tree.length, 1)
  assert.equal(tree[0]!.name, 'run')
  assert.equal(tree[0]!.children.length, 1)
  assert.equal(tree[0]!.children[0]!.name, 'extract')
  assert.equal(tree[0]!.children[0]!.status, 'completed')
})

test('stage orphans without parent attach to root list', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'stage', seq: 1, runId: 'r1', stageId: 'orphan', name: 'orphan', status: 'started' }))
  const tree = stageTreeForRun(s.stages, 'r1')
  assert.equal(tree.length, 1)
  assert.equal(tree[0]!.name, 'orphan')
})

test('stage without runId is included when runId is undefined', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'stage', seq: 1, stageId: 'x', name: 'global', status: 'started' }))
  const tree = stageTreeForRun(s.stages, undefined)
  assert.equal(tree.length, 1)
})

// --- Connection status -----------------------------------------------------------------------

test('empty state says it is connecting until the SSE endpoint answers', () => {
  assert.equal(emptyState().connection.kind, 'connecting')
})

test('setConnection updates status', () => {
  let s = emptyState()
  s = setConnection(s, { kind: 'reconnecting', attempt: 2, nextMs: 4000 })
  assert.equal(s.connection.kind, 'reconnecting')
})

// --- Event log rolling -----------------------------------------------------------------------

test('eventLog accumulates and rolls', () => {
  let s = emptyState()
  for (let i = 1; i <= 3; i++) {
    s = applyEvent(s, mkEvent({ kind: 'http.request', seq: i, method: 'GET', path: '/health' }))
  }
  assert.equal(s.eventLog.length, 3)
  assert.equal(s.eventLog[0]!.seq, 1)
  assert.equal(s.eventLog[2]!.seq, 3)
})

// --- Edge cases ------------------------------------------------------------------------------

test('run.completed without matching run.started is ignored', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'run.completed', seq: 1, profile: 'clinical', wallMs: 200 }))
  assert.equal(s.runs.size, 0)
})

test('pipeline.step.completed without pipeline is ignored', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'pipeline.step.completed', seq: 1, runId: 'p1', step: 0, name: 'x', profile: 'x', ok: true }))
  assert.equal(s.pipelines.size, 0)
})

test('turn.completed without session is ignored', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'turn.completed', seq: 1, sessionId: 's1', turn: 1, stop: 'done', steps: 1, toolsUsed: [] }))
  assert.equal(s.sessions.size, 0)
})

test('stage event updates existing stage by id', () => {
  let s = emptyState()
  s = applyEvent(s, mkEvent({ kind: 'stage', seq: 1, runId: 'r1', stageId: 's1', name: 'a', status: 'started' }))
  s = applyEvent(s, mkEvent({ kind: 'stage', seq: 2, runId: 'r1', stageId: 's1', name: 'a', status: 'completed', wallMs: 50 }))
  const st = s.stages.get('s1')
  assert.equal(st!.status, 'completed')
  assert.equal(st!.wallMs, 50)
})
