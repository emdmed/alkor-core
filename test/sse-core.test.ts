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

const event = (seq: number): Record<string, unknown> => ({
  activitySpec: ACTIVITY_SPEC,
  seq,
  ts: '2026-01-01T00:00:00.000Z',
  kind: 'server.ready',
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

test('decideSseFrame accepts an increasing seq and reports nextSeq', () => {
  const d = decideSseFrame({ id: '1', event: 'x', data: JSON.stringify(event(1)) }, 0)
  assert.equal(d.kind, 'event')
  if (d.kind === 'event') {
    assert.equal(d.event.seq, 1)
    assert.equal(d.nextSeq, 1)
  }
})

test('decideSseFrame ignores duplicates and empty data', () => {
  assert.equal(decideSseFrame({ id: '1', event: 'x', data: JSON.stringify(event(1)) }, 1).kind, 'ignored')
  assert.equal(decideSseFrame({ id: '2', event: 'x', data: '' }, 1).kind, 'ignored')
})

test('decideSseFrame tolerates seq gaps', () => {
  const d = decideSseFrame({ id: '5', event: 'x', data: JSON.stringify(event(5)) }, 1)
  assert.equal(d.kind, 'event')
})

test('decideSseFrame refuses a mismatched activitySpec with a reason', () => {
  const bad = { activitySpec: 99, seq: 1, ts: '', kind: 'server.ready' }
  const d = decideSseFrame({ id: '1', event: 'x', data: JSON.stringify(bad) }, 0)
  assert.equal(d.kind, 'refused')
  if (d.kind === 'refused') assert.ok(d.reason.includes('99'))
})

test('decideSseFrame ignores malformed JSON', () => {
  assert.equal(decideSseFrame({ id: '1', event: 'x', data: 'not json' }, 0).kind, 'ignored')
})