/**
 * Shared SSE core: the frame parser, accumulator, and wire policy that both the terminal
 * client (undici) and the browser dashboard (fetch) build on. Pure and dependency-free,
 * so it is tested once here — no transport involved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVITY_SPEC } from '../src/core/activity-types.ts'
import {
  parseSseFrame,
  SseFrameAccumulator,
  decideSseFrame,
} from '../src/tui/sse-core.ts'

const event = (seq: number, instanceId = 'bus-a'): Record<string, unknown> => ({
  activitySpec: ACTIVITY_SPEC,
  seq,
  ts: '2026-01-01T00:00:00.000Z',
  kind: 'server.ready',
  instanceId,
})

test('parseSseFrame extracts id, event, and data fields', () => {
  const frame = parseSseFrame('id: 7\nevent: run.completed\ndata: {"seq":7}')
  assert.equal(frame.id, '7')
  assert.equal(frame.event, 'run.completed')
  assert.equal(frame.data, '{"seq":7}')
})

test('parseSseFrame ignores comment lines', () => {
  const frame = parseSseFrame(': ping\nid: 1\ndata: {}')
  assert.equal(frame.id, '1')
  assert.equal(frame.event, '')
  assert.equal(frame.data, '{}')
})

test('parseSseFrame tolerates missing fields', () => {
  const frame = parseSseFrame(':ok')
  assert.equal(frame.id, '')
  assert.equal(frame.event, '')
  assert.equal(frame.data, '')
})

test('accumulator emits frames split across chunks', () => {
  const acc = new SseFrameAccumulator()
  assert.deepEqual(acc.push('id: 1\n'), [])
  const part = acc.push('data: {"seq":1}\n\nid: 2\n')
  assert.equal(part.length, 1)
  assert.equal(part[0]!.id, '1')
  assert.equal(part[0]!.data, '{"seq":1}')
  const frames = acc.push('data: {"seq":2}\n\n')
  assert.equal(frames.length, 1)
  assert.equal(frames[0]!.id, '2')
})

test('accumulator handles multiple frames in one chunk', () => {
  const acc = new SseFrameAccumulator()
  const frames = acc.push('id: 1\ndata: {}\n\nid: 2\ndata: {}\n\n')
  assert.equal(frames.length, 2)
  assert.equal(frames[0]!.id, '1')
  assert.equal(frames[1]!.id, '2')
})

test('accumulator leaves a trailing partial frame buffered', () => {
  const acc = new SseFrameAccumulator()
  assert.deepEqual(acc.push('id: 1\ndata: '), [])
  const frames = acc.push('{"seq":1}\n\n')
  assert.equal(frames.length, 1)
  assert.equal(frames[0]!.data, '{"seq":1}')
})

/**
 * Field syntax per the SSE grammar, not per this server's exact output. The old parser keyed
 * on the literal prefixes `id: ` / `data: `, so anything between the two ends — a proxy that
 * omits the optional space, or splits a payload over several `data:` lines — read as silence.
 */
test('parseSseFrame accepts the optional-space and multi-line data forms', () => {
  const frame = parseSseFrame('id:7\nevent:run.completed\ndata:{"a":1,\ndata:"b":2}')
  assert.equal(frame.id, '7')
  assert.equal(frame.event, 'run.completed')
  assert.equal(frame.data, '{"a":1,\n"b":2}')
})

test('parseSseFrame treats a field with no colon as an empty value', () => {
  const frame = parseSseFrame('data\nid: 3')
  assert.equal(frame.data, '')
  assert.equal(frame.id, '3')
})

test('accumulator splits frames terminated by CRLF, including across a chunk boundary', () => {
  const acc = new SseFrameAccumulator()
  assert.equal(acc.push('id: 1\r\ndata: {"seq":1}\r\n\r').length, 0, 'boundary is incomplete')
  const frames = acc.push('\nid: 2\r\ndata: {"seq":2}\r\n\r\n')
  assert.equal(frames.length, 2)
  assert.equal(frames[0]!.data, '{"seq":1}')
  assert.equal(frames[1]!.data, '{"seq":2}')
})

test('accumulator does not split a CRLF pair arriving one byte at a time', () => {
  const acc = new SseFrameAccumulator()
  const wire = 'data: {"seq":1}\r\n\r\ndata: {"seq":2}\r\n\r\n'
  const frames = wire.split('').flatMap((byte) => acc.push(byte))
  assert.deepEqual(frames.map((f) => f.data), ['{"seq":1}', '{"seq":2}'])
})

test('decideSseFrame accepts an increasing seq and advances the watermark', () => {
  const d = decideSseFrame({ id: '1', event: 'x', data: JSON.stringify(event(1)) }, { lastSeq: 0 })
  assert.equal(d.kind, 'event')
  if (d.kind === 'event') {
    assert.equal(d.event.seq, 1)
    assert.deepEqual(d.watermark, { lastSeq: 1, instanceId: 'bus-a' })
    assert.equal(d.restarted, false)
  }
})

test('decideSseFrame ignores duplicates and empty data', () => {
  const mark = { lastSeq: 1, instanceId: 'bus-a' }
  assert.equal(decideSseFrame({ id: '1', event: 'x', data: JSON.stringify(event(1)) }, mark).kind, 'ignored')
  assert.equal(decideSseFrame({ id: '2', event: 'x', data: '' }, mark).kind, 'ignored')
})

test('decideSseFrame tolerates seq gaps', () => {
  const d = decideSseFrame({ id: '5', event: 'x', data: JSON.stringify(event(5)) }, { lastSeq: 1 })
  assert.equal(d.kind, 'event')
})

// The restart case: a new server process counts from 1 again. Judged by seq alone every one
// of its events is stale, and the reader goes silent while still calling itself live.
test('decideSseFrame accepts a lower seq from a different instance and says so', () => {
  const d = decideSseFrame(
    { id: '1', event: 'x', data: JSON.stringify(event(1, 'bus-b')) },
    { lastSeq: 400, instanceId: 'bus-a' },
  )
  assert.equal(d.kind, 'event')
  if (d.kind === 'event') {
    assert.equal(d.restarted, true)
    assert.deepEqual(d.watermark, { lastSeq: 1, instanceId: 'bus-b' })
  }
})

test('decideSseFrame keeps deduping within one instance after a restart', () => {
  const first = decideSseFrame(
    { id: '1', event: 'x', data: JSON.stringify(event(1, 'bus-b')) },
    { lastSeq: 400, instanceId: 'bus-a' },
  )
  assert.equal(first.kind, 'event')
  if (first.kind !== 'event') return
  const again = decideSseFrame({ id: '1', event: 'x', data: JSON.stringify(event(1, 'bus-b')) }, first.watermark)
  assert.equal(again.kind, 'ignored')
})

// A stream from a server that predates instanceId must stay readable on seq alone.
test('decideSseFrame falls back to seq when instanceId is absent', () => {
  const older = { activitySpec: ACTIVITY_SPEC, seq: 2, ts: '', kind: 'server.ready' }
  const d = decideSseFrame({ id: '2', event: 'x', data: JSON.stringify(older) }, { lastSeq: 1, instanceId: 'bus-a' })
  assert.equal(d.kind, 'event')
  if (d.kind === 'event') {
    assert.equal(d.restarted, false)
    assert.equal(d.watermark.instanceId, 'bus-a')
  }
})

test('decideSseFrame refuses a mismatched activitySpec with a reason', () => {
  const bad = { activitySpec: 99, seq: 1, ts: '', kind: 'server.ready' }
  const d = decideSseFrame({ id: '1', event: 'x', data: JSON.stringify(bad) }, { lastSeq: 0 })
  assert.equal(d.kind, 'refused')
  if (d.kind === 'refused') assert.ok(d.reason.includes('99'))
})

test('decideSseFrame ignores malformed JSON', () => {
  assert.equal(decideSseFrame({ id: '1', event: 'x', data: 'not json' }, { lastSeq: 0 }).kind, 'ignored')
})