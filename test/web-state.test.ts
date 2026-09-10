/**
 * Source-lifecycle tests: the pure controller behind the dashboard connection logic.
 *
 * The identical transitions the React hook executes (`src/tui/source.ts`) are driven
 * directly here, plus the reducer helpers they compose. No React, no renderer, no server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialSource,
  isCurrentGeneration,
  normalizeUrl,
  sourceReducer,
} from '../src/tui/source.ts'
import {
  applyEvent,
  clearExecutionHistory,
  emptyState,
  setTopology,
  type TopologySnapshot,
} from '../src/tui/state.ts'
import { ACTIVITY_SPEC } from '../src/core/activity.ts'
import type { ActivityEvent } from '../src/core/activity.ts'

const mkEvent = (partial: Record<string, unknown> & { seq: number }): ActivityEvent => ({
  activitySpec: ACTIVITY_SPEC,
  ts: new Date().toISOString(),
  ...partial,
} as ActivityEvent)

const topology: TopologySnapshot = {
  profiles: [{ name: 'workflow-router', mode: 'router' }],
  pipeline: { router: 'workflow-router', workflows: ['wf'], defaultWorkflow: 'wf' },
  pipelines: [{ name: 'wf', steps: [{ name: 'work', profile: 'worker' }] }],
}

test('typing a draft URL never alters the active source', () => {
  let source = initialSource('http://a:3000/')
  const generation = source.generation

  source = sourceReducer(source, { type: 'draft', url: '   http://totally-different:8080/  ' })
  assert.equal(source.draftUrl, '   http://totally-different:8080/  ', 'the draft echoes the input untrimmed until connect')
  assert.equal(source.activeUrl, 'http://a:3000', 'the active origin is untouched by keystrokes')
  assert.equal(source.generation, generation, 'typing does not open a connection generation')
  assert.equal(source.pausedEvents.length, 0)

  source = sourceReducer(source, { type: 'connect' })
  assert.equal(source.activeUrl, 'http://totally-different:8080', 'only connect commits the draft')
  assert.equal(source.generation, generation + 1)
})

test('a new source resets the sequence watermark and accepts seq 1', () => {
  // Old backend has already reached seq 168 in the reducer.
  let state = emptyState()
  state = applyEvent(state, mkEvent({ kind: 'profile.loaded', seq: 168, name: 'a', mode: 'extract' }))
  assert.equal(state.lastSeq, 168)

  // Same-source bump first, then a different origin.
  let source = initialSource('http://a')
  source = sourceReducer(source, { type: 'connect' })
  source = sourceReducer(source, { type: 'draft', url: 'http://b' })
  const connected = sourceReducer(source, { type: 'connect' })
  assert.notEqual(connected.activeUrl, source.activeUrl, 'the origin changed')

  // The hook contract for a changed origin: reset all source-owned state.
  state = emptyState()
  assert.equal(state.lastSeq, 0)

  const after = applyEvent(state, mkEvent({ kind: 'profile.loaded', seq: 1, name: 'b', mode: 'extract' }))
  assert.equal(after.lastSeq, 1, 'seq 1 from the new backend is accepted immediately')
  assert.equal(after.profiles[0]?.name, 'b')
})

test('events captured under an old generation are ignored', () => {
  const source = initialSource('http://a')
  assert.equal(isCurrentGeneration(source.generation, source), true)

  const reconnected = sourceReducer(source, { type: 'connect' })
  assert.equal(reconnected.generation, source.generation + 1, 'a reconnect allocates a fresh generation')
  assert.equal(isCurrentGeneration(source.generation, reconnected), false, 'the old SSE callback is stale')
  assert.equal(isCurrentGeneration(reconnected.generation, reconnected), true)
})

test('a late old backend /health response is ignored after reconnect', () => {
  // /health captured the current generation before it awaited; a reconnect bumps the
  // generation, so that reply is dropped by the same guard the hook's .then uses.
  const source = initialSource('http://a')
  const healthCaptured = source.generation

  const reconnected = sourceReducer(source, { type: 'connect' })
  assert.equal(isCurrentGeneration(healthCaptured, reconnected), false, 'the old /health reply is stale')

  const current = initialSource('http://b')
  assert.equal(isCurrentGeneration(current.generation, current), true, 'the active generation still accepts its own reply')
})

test('same-source reconnect preserves reducer dedup state', () => {
  let source = initialSource('http://a')
  let state = emptyState()
  state = applyEvent(state, mkEvent({ kind: 'profile.loaded', seq: 10, name: 'a', mode: 'extract' }))

  source = sourceReducer(source, { type: 'connect' })
  assert.equal(source.activeUrl, 'http://a', 'same origin, no identity swap')
  assert.equal(source.generation, 2, 'the transport re-establishes under a fresh generation')
  assert.equal(state.lastSeq, 10, 'the reducer watermark is not reset by a same-source reconnect')

  const after = applyEvent(state, mkEvent({ kind: 'run.started', seq: 11, profile: 'wf', runId: 'r1' }))
  assert.equal(after.lastSeq, 11, 'SSE replay/dedup continues normally on preserved state')
})

test('clear removes run history but keeps topology, models, and connection', () => {
  let state = setTopology(emptyState(), topology)
  state.models.set('http://m', { baseUrl: 'http://m', identified: true, managed: true, state: 'running' })
  state.connection = { kind: 'live' }
  state = applyEvent(state, mkEvent({ kind: 'run.started', seq: 1, profile: 'wf', runId: 'r1', inputDigest: 'abc' }))
  state = applyEvent(state, mkEvent({ kind: 'stage', seq: 2, runId: 'r1', stageId: 's1', name: 'llm-call', status: 'completed', wallMs: 5 }))
  const lastSeq = state.lastSeq

  const cleared = clearExecutionHistory(state)
  assert.equal(cleared.runs.size, 0)
  assert.equal(cleared.pipelines.size, 0)
  assert.equal(cleared.stages.size, 0)
  assert.equal(cleared.llmRequests.size, 0)
  assert.equal(cleared.sessions.size, 0)
  assert.equal(cleared.eventLog.length, 0)
  assert.equal(cleared.httpLog.length, 0)
  assert.equal(cleared.routes.length, 0)
  assert.equal(cleared.tools.length, 0)

  assert.equal(cleared.topology, state.topology, 'the workflow catalogue survives Clear')
  assert.equal(cleared.profiles.length, topology.profiles.length)
  assert.equal(cleared.connection.kind, 'live', 'the active connection is untouched')
  assert.equal(cleared.models.get('http://m')?.state, 'running', 'backend model health is untouched')
  assert.equal(cleared.lastSeq, lastSeq, 'the sequence watermark survives so dedup keeps counting')

  const after = applyEvent(cleared, mkEvent({ kind: 'run.started', seq: lastSeq + 1, profile: 'wf', runId: 'r2' }))
  assert.equal(after.runs.size, 1, 'new runs apply after Clear')
})

test('paused events cannot cross a source boundary', () => {
  let source = initialSource('http://a')
  source = sourceReducer(source, { type: 'pause' })
  assert.equal(source.paused, true)

  const e1 = mkEvent({ kind: 'profile.loaded', seq: 1, name: 'a', mode: 'extract' })
  const e2 = mkEvent({ kind: 'run.started', seq: 2, profile: 'wf', runId: 'r1' })
  source = sourceReducer(source, { type: 'queue-paused', events: [e1, e2] })
  assert.equal(source.pausedEvents.length, 2)

  source = sourceReducer(source, { type: 'draft', url: 'http://b' })
  source = sourceReducer(source, { type: 'connect' })
  assert.equal(source.pausedEvents.length, 0, 'a source change drops the paused buffer')

  const queuedWhileLive = sourceReducer(initialSource('http://a'), {
    type: 'queue-paused',
    events: [e1],
  })
  assert.equal(queuedWhileLive.pausedEvents.length, 0, 'events only buffer while paused')
})

test('same-source reconnect keeps the paused buffer intact', () => {
  let source = initialSource('http://a')
  source = sourceReducer(source, { type: 'pause' })
  source = sourceReducer(source, {
    type: 'queue-paused',
    events: [mkEvent({ kind: 'profile.loaded', seq: 1, name: 'a', mode: 'extract' })],
  })
  assert.equal(source.pausedEvents.length, 1)

  source = sourceReducer(source, { type: 'connect' })
  assert.equal(source.activeUrl, 'http://a')
  assert.equal(source.pausedEvents.length, 1, 'a reconnect to the same source keeps the buffer')

  source = sourceReducer(source, { type: 'resume' })
  assert.equal(source.paused, false)
  assert.equal(source.pausedEvents.length, 1, 'resume does not itself discard events; the hook drains them')
})

test('normalizeUrl strips trailing slashes for identity comparison', () => {
  assert.equal(normalizeUrl('http://a:3000///'), 'http://a:3000')
  assert.equal(normalizeUrl('  http://b  '), 'http://b')
  assert.equal(normalizeUrl('http://a/'), 'http://a')
})