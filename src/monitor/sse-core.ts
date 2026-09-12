/**
 * Transport-agnostic SSE core: frame parsing, splitting, and the wire policy
 * (spec refusal + seq dedup). The web client (fetch) consumes this module directly,
 * because nothing here touches Node. Keep it dependency-free.
 */
import { ACTIVITY_SPEC, ACTIVITY_INSTANCE_HEADER, type ActivityEvent } from '../core/activity-types.ts'

// Re-exported so a client needs one import for the whole wire policy.
export { ACTIVITY_INSTANCE_HEADER }

/** Connection states a client reports to a dashboard. */
export type SseConnectionStatus =
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'reconnecting'; attempt: number; nextMs: number }
  | { kind: 'refused'; reason: string }

/** One complete SSE frame: the `id:`, `event:`, `data:` fields before a blank line. */
export interface SseFrame {
  id: string
  event: string
  data: string
}

/**
 * Parse a complete frame (already split on blank lines). Comments are ignored.
 *
 * Field syntax follows the SSE grammar rather than this server's exact output: the colon
 * separates name from value, one leading space is optional, and repeated `data:` lines join
 * with newlines. Our own frames are single-line JSON written with `: `, but a parser that
 * only understands its own sender is a parser that breaks the day anything sits in between.
 */
export const parseSseFrame = (frame: string): SseFrame => {
  let id = ''
  let event = ''
  const data: string[] = []
  for (const line of frame.split('\n')) {
    // Comments (`:ok`, `: ping`) have an empty field name.
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const name = colon === -1 ? line : line.slice(0, colon)
    // A line with no colon is a field with an empty value; one leading space is syntax.
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (name === 'id') id = value
    else if (name === 'event') event = value
    else if (name === 'data') data.push(value)
    // Any other field (`retry`, unknown names) is not part of this contract.
  }
  return { id, event, data: data.join('\n') }
}

/** Incremental splitter: feed it raw chunks, read the completed frames it yields. */
export class SseFrameAccumulator {
  private buffer = ''
  /** A trailing CR is held back: it may be the first half of a CRLF split across chunks. */
  private pendingCr = false

  /** Append a chunk and return the frames completed by it. */
  push(chunk: string): SseFrame[] {
    let text = (this.pendingCr ? '\r' : '') + chunk
    this.pendingCr = text.endsWith('\r')
    if (this.pendingCr) text = text.slice(0, -1)
    // Normalize CRLF and lone-CR terminators so the frame boundary is always one shape.
    this.buffer += text.replace(/\r\n?/g, '\n')

    const frames: SseFrame[] = []
    let cut: number
    while ((cut = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, cut)
      this.buffer = this.buffer.slice(cut + 2)
      frames.push(parseSseFrame(frame))
    }
    return frames
  }
}

/**
 * How far a reader has got, and in WHICH stream. `seq` alone is not a watermark: it counts
 * from 1 again in a restarted server, so a reader holding `lastSeq: 400` would discard the
 * whole new stream as already-seen while still calling itself live.
 */
export interface SseWatermark {
  lastSeq: number
  instanceId?: string
}

export type SseDecision =
  | { kind: 'event'; event: ActivityEvent; watermark: SseWatermark; restarted: boolean }
  | { kind: 'refused'; reason: string }
  | { kind: 'ignored' }

/**
 * The wire policy for one parsed frame: refuse a stream whose spec does not match
 * (per `spec/activity.md`, the connection is dropped), ignore duplicate or empty frames,
 * accept anything with a strictly increasing seq. Gaps are tolerated deliberately.
 *
 * A changed `instanceId` means a different bus, so the seq comparison does not apply and
 * the caller is told (`restarted`) that history before this event belongs to another server.
 */
export const decideSseFrame = (frame: SseFrame, mark: SseWatermark): SseDecision => {
  if (!frame.data) return { kind: 'ignored' }
  let event: ActivityEvent
  try {
    event = JSON.parse(frame.data) as ActivityEvent
  } catch {
    return { kind: 'ignored' }
  }
  if (event.activitySpec !== ACTIVITY_SPEC) {
    return { kind: 'refused', reason: `activitySpec ${event.activitySpec} !== ${ACTIVITY_SPEC}` }
  }
  const restarted =
    mark.instanceId !== undefined &&
    event.instanceId !== undefined &&
    event.instanceId !== mark.instanceId
  if (!restarted && event.seq <= mark.lastSeq) return { kind: 'ignored' }
  return {
    kind: 'event',
    event,
    // An older server omits `instanceId`; keep whatever we knew rather than forgetting it.
    watermark: { lastSeq: event.seq, instanceId: event.instanceId ?? mark.instanceId },
    restarted,
  }
}