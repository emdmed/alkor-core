/**
 * Transport-agnostic SSE core: frame parsing, splitting, and the wire policy
 * (spec refusal + seq dedup). The terminal client (undici) and the web client (fetch)
 * both consume this module; a browser can import it directly because nothing here
 * touches Node. Keep it dependency-free.
 */
import { ACTIVITY_SPEC, type ActivityEvent } from '../core/activity-types.ts'

/** Connection states reported by both clients to a dashboard. */
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

/** Parse a complete frame (already split on blank lines). Comments are ignored. */
export const parseSseFrame = (frame: string): SseFrame => {
  let id = ''
  let event = ''
  let data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('id: ')) id = line.slice(4)
    else if (line.startsWith('event: ')) event = line.slice(7)
    else if (line.startsWith('data: ')) data = line.slice(6)
    // Comments (:ok, : ping) are ignored by construction — no handler.
  }
  return { id, event, data }
}

/** Incremental splitter: feed it raw chunks, read the completed frames it yields. */
export class SseFrameAccumulator {
  private buffer = ''

  /** Append a chunk and return the frames completed by it. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk
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

export type SseDecision =
  | { kind: 'event'; event: ActivityEvent; nextSeq: number }
  | { kind: 'refused'; reason: string }
  | { kind: 'ignored' }

/**
 * The wire policy for one parsed frame: refuse a stream whose spec does not match
 * (per `spec/activity.md`, the connection is dropped), ignore duplicate or empty frames,
 * accept anything with a strictly increasing seq. Gaps are tolerated deliberately.
 */
export const decideSseFrame = (frame: SseFrame, lastSeq: number): SseDecision => {
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
  if (event.seq <= lastSeq) return { kind: 'ignored' }
  return { kind: 'event', event, nextSeq: event.seq }
}