/**
 * Activity bus: stamping, seq monotonicity, subscribe/unsubscribe, ring eviction,
 * nullActivity, and the metadata-only invariant (banned-key walk over every emitted
 * event, including inside `stage.detail`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVITY_SPEC,
  createActivity,
  nullActivity,
  withActivityScope,
  type ActivityInput,
  type StageDetail,
} from '../src/core/activity.ts'

const anyEvent = (kind: ActivityInput['kind']): ActivityInput & Record<string, unknown> => {
  switch (kind) {
    case 'server.ready': return { kind: 'server.ready' }
    case 'profile.loaded': return { kind: 'profile.loaded', name: 'clinical', mode: 'extract' }
    case 'model.identified': return { kind: 'model.identified', baseUrl: 'http://127.0.0.1:8080', identified: false }
    case 'model.lifecycle': return { kind: 'model.lifecycle', baseUrl: 'http://127.0.0.1:8081', state: 'ready' }
    case 'llm.request': return { kind: 'llm.request', requestId: 'r1', label: 'test', baseUrl: 'http://127.0.0.1:8080', constrained: false, messageCount: 2 }
    case 'llm.response': return { kind: 'llm.response', requestId: 'r1', wallMs: 100 }
    case 'llm.error': return { kind: 'llm.error', requestId: 'r1', wallMs: 50, message: 'fail' }
    case 'http.request': return { kind: 'http.request', method: 'GET', path: '/health' }
    case 'http.completed': return { kind: 'http.completed', method: 'GET', path: '/health', status: 200, wallMs: 10 }
    case 'route.decided': return { kind: 'route.decided', profile: 'clinical', confidence: 0.9, reason: 'rule: vitals', ruleVsModel: 'rule' }
    case 'run.started': return { kind: 'run.started', profile: 'clinical', inputChars: 100, inputDigest: 'abc123' }
    case 'run.completed': return { kind: 'run.completed', profile: 'clinical', wallMs: 200 }
    case 'run.failed': return { kind: 'run.failed', profile: 'clinical', wallMs: 200, error: 'something went wrong' }
    case 'pipeline.started': return { kind: 'pipeline.started' }
    case 'pipeline.step.started': return { kind: 'pipeline.step.started', step: 0, name: 'extract', profile: 'clinical', input: { ref: 'initial' } }
    case 'pipeline.step.completed': return { kind: 'pipeline.step.completed', step: 0, name: 'extract', profile: 'clinical', ok: true, wallMs: 150 }
    case 'pipeline.completed': return { kind: 'pipeline.completed', stoppedEarly: false, totalMs: 500 }
    case 'session.created': return { kind: 'session.created', sessionId: 's1', profile: 'clinical' }
    case 'turn.started': return { kind: 'turn.started', sessionId: 's1', turn: 1 }
    case 'turn.completed': return { kind: 'turn.completed', sessionId: 's1', turn: 1, stop: 'answered', steps: 1, toolsUsed: [] }
    case 'session.destroyed': return { kind: 'session.destroyed', sessionId: 's1' }
    case 'tool.called': return { kind: 'tool.called', name: 'readFile' }
    case 'tool.completed': return { kind: 'tool.completed', name: 'readFile' }
    case 'tool.declined': return { kind: 'tool.declined', name: 'writeFile' }
    case 'stage': return { kind: 'stage', name: 'route', status: 'started' }
    default: throw new Error(`unknown kind: ${kind}`)
  }
}

test('activity stamps activitySpec, seq, and ts', () => {
  const a = createActivity()
  a.emit(anyEvent('server.ready'))
  const r = a.recent(1)
  assert.equal(r.length, 1)
  assert.equal(r[0]!.activitySpec, ACTIVITY_SPEC)
  assert.equal(r[0]!.seq, 1)
  assert.ok(typeof r[0]!.ts === 'string')
  assert.ok(r[0]!.ts.length > 0)
})

test('seq is monotonic', () => {
  const a = createActivity()
  for (let i = 0; i < 5; i++) a.emit(anyEvent('server.ready'))
  const r = a.recent(5)
  assert.equal(r[0]!.seq, 1)
  assert.equal(r[4]!.seq, 5)
})

test('subscribe receives live events', () => {
  const a = createActivity()
  const received: string[] = []
  const unsub = a.subscribe((e) => received.push(e.kind))
  a.emit(anyEvent('server.ready'))
  a.emit(anyEvent('llm.request'))
  assert.deepEqual(received, ['server.ready', 'llm.request'])
  unsub()
  a.emit(anyEvent('llm.response'))
  assert.deepEqual(received, ['server.ready', 'llm.request'])
})

test('multiple subscribers each receive events', () => {
  const a = createActivity()
  const r1: number[] = []
  const r2: number[] = []
  a.subscribe((e) => r1.push(e.seq))
  a.subscribe((e) => r2.push(e.seq))
  a.emit(anyEvent('server.ready'))
  assert.deepEqual(r1, [1])
  assert.deepEqual(r2, [1])
})

test('subscriber errors do not break the bus', () => {
  const a = createActivity()
  a.subscribe(() => {
    throw new Error('boom')
  })
  const r: number[] = []
  a.subscribe((e) => r.push(e.seq))
  a.emit(anyEvent('server.ready'))
  assert.deepEqual(r, [1])
})

test('ring buffer evicts old events', () => {
  const a = createActivity({ buffer: 3 })
  for (let i = 0; i < 5; i++) a.emit(anyEvent('server.ready'))
  const r = a.recent(10)
  assert.equal(r.length, 3)
  assert.equal(r[0]!.seq, 3)
  assert.equal(r[2]!.seq, 5)
})

test('recent returns the last n events', () => {
  const a = createActivity()
  for (let i = 0; i < 10; i++) a.emit(anyEvent('server.ready'))
  const r = a.recent(5)
  assert.equal(r.length, 5)
  assert.equal(r[0]!.seq, 6)
  assert.equal(r[4]!.seq, 10)
})

test('nullActivity does nothing', () => {
  const a = nullActivity()
  let called = false
  a.subscribe(() => {
    called = true
  })
  a.emit(anyEvent('server.ready'))
  assert.equal(called, false)
  assert.equal(a.recent().length, 0)
})

test('withActivityScope stamps correlation ids', () => {
  const a = createActivity()
  withActivityScope({ runId: 'run-1', sessionId: 'sess-1', stageId: 'stage-1', parentId: 'parent-1' }, () => {
    a.emit(anyEvent('server.ready'))
  })
  const r = a.recent(1)[0]!
  assert.equal(r.runId, 'run-1')
  assert.equal(r.sessionId, 'sess-1')
  assert.equal(r.stageId, 'stage-1')
  assert.equal(r.parentId, 'parent-1')
})

test('events outside a scope have no correlation ids', () => {
  const a = createActivity()
  a.emit(anyEvent('server.ready'))
  const r = a.recent(1)[0]!
  assert.equal(r.runId, undefined)
  assert.equal(r.sessionId, undefined)
})

test('banned key at root throws', () => {
  const a = createActivity()
  assert.throws(
    () => a.emit({ kind: 'server.ready', content: 'secret' } as any),
    /banned key 'content'/,
  )
})

test('banned key nested in object throws', () => {
  const a = createActivity()
  assert.throws(
    () => a.emit({ kind: 'server.ready', extra: { prompt: 'secret' } } as any),
    /banned key 'prompt'/,
  )
})

test('banned key inside stage.detail throws', () => {
  const a = createActivity()
  const detail: StageDetail = { ref: 'step-1', text: 'secret' } as any
  assert.throws(
    () => a.emit({ kind: 'stage', name: 'test', status: 'started', detail } as any),
    /banned key 'text'/,
  )
})

test('banned key inside array throws', () => {
  const a = createActivity()
  assert.throws(
    () => a.emit({ kind: 'server.ready', items: [{ note: 'secret' }] } as any),
    /banned key 'note'/,
  )
})

test('allowed detail shapes pass the metadata-only check', () => {
  const a = createActivity()
  // scalar detail
  a.emit({ kind: 'stage', name: 'route', status: 'started', detail: 'ok' })
  // number detail
  a.emit({ kind: 'stage', name: 'route', status: 'completed', detail: 0.92 })
  // boolean detail
  a.emit({ kind: 'stage', name: 'route', status: 'completed', detail: true })
  // null detail
  a.emit({ kind: 'stage', name: 'route', status: 'completed', detail: null })
  // edge detail
  a.emit({ kind: 'stage', name: 'route', status: 'started', detail: { from: 'step-1', to: 'step-2', via: 'pipeline' } })
  // record detail
  a.emit({ kind: 'stage', name: 'route', status: 'completed', detail: { shape: 'shock-suspicion', confidence: 0.92 } })
  assert.equal(a.recent().length, 6)
})

test('llm.response with chunks and usage is allowed', () => {
  const a = createActivity()
  a.emit({
    kind: 'llm.response',
    requestId: 'r1',
    wallMs: 100,
    promptTokens: 50,
    completionTokens: 20,
    cachedTokens: 10,
    finishReason: 'stop',
    chunks: 1,
  })
  const r = a.recent(1)[0]!
  assert.equal(r.kind, 'llm.response')
})

test('run.failed with truncated error is allowed', () => {
  const a = createActivity()
  a.emit({ kind: 'run.failed', profile: 'clinical', wallMs: 100, error: 'short error' })
  assert.equal(a.recent().length, 1)
})
