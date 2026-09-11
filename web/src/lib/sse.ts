/**
 * SSE client for the browser, on `fetch` + ReadableStream. The intelligence — frame
 * parsing, seq dedup, spec refusal — is shared with the terminal client via `sse-core.ts`;
 * this file is only the transport and the reconnect/backoff loop, mirroring `src/tui/sse.ts`.
 */
import type { ActivityEvent } from '../../../src/core/activity-types.ts'
import {
  ACTIVITY_INSTANCE_HEADER,
  SseFrameAccumulator,
  decideSseFrame,
  type SseConnectionStatus,
  type SseWatermark,
} from '../../../src/tui/sse-core.ts'

export interface SseClient {
  /** Close the connection and stop reconnecting. */
  close(): void
}

export interface SseOptions {
  url: string
  /** Called for every parsed ActivityEvent. */
  onEvent: (event: ActivityEvent) => void
  /** Called when connection status changes. */
  onConnection?: (status: SseConnectionStatus) => void
  /** Initial backoff in ms; doubles each attempt, capped at maxBackoffMs. */
  backoffMs?: number
  maxBackoffMs?: number
  /**
   * Drop and reconnect after this long with no bytes at all. `fetch` has no read timeout,
   * so a half-open connection otherwise leaves the dashboard reading "live" forever — the
   * server pings every 15s precisely so silence is diagnosable.
   */
  idleTimeoutMs?: number
}

export const createSseClient = (o: SseOptions): SseClient => {
  const { url, onEvent, onConnection } = o
  const backoffMs = o.backoffMs ?? 1000
  const maxBackoffMs = o.maxBackoffMs ?? 30_000
  const idleTimeoutMs = o.idleTimeoutMs ?? 45_000

  let mark: SseWatermark = { lastSeq: 0 }
  let closed = false
  let reconnectAttempt = 0
  let controller: AbortController | null = null

  const connect = async () => {
    if (closed) return

    onConnection?.({ kind: 'connecting' })

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
    }
    if (mark.lastSeq > 0) {
      // Resume from the last seen seq instead of replaying the whole ring buffer.
      headers['Last-Event-ID'] = String(mark.lastSeq)
      // A seq only means something to the process that issued it; name that process, so a
      // restarted server replays from the start instead of the client dropping its stream.
      if (mark.instanceId) headers[ACTIVITY_INSTANCE_HEADER] = mark.instanceId
    }

    const abort = new AbortController()
    controller = abort
    let idleTimer: number | null = null
    const armIdleTimer = () => {
      if (idleTimer !== null) window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => abort.abort(), idleTimeoutMs)
    }

    const accumulator = new SseFrameAccumulator()

    /** Apply the wire policy to whatever frames a chunk completed. Returns false to stop. */
    const consume = (chunk: string): boolean => {
      for (const frame of accumulator.push(chunk)) {
        const decision = decideSseFrame(frame, mark)
        if (decision.kind === 'event') {
          mark = decision.watermark
          onEvent(decision.event)
        } else if (decision.kind === 'refused') {
          onConnection?.({ kind: 'refused', reason: decision.reason })
          closed = true
          return false
        }
      }
      return true
    }

    try {
      const res = await fetch(url, {
        headers,
        signal: abort.signal,
        cache: 'no-store',
      })

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      reconnectAttempt = 0
      onConnection?.({ kind: 'live' })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      armIdleTimer()

      while (true) {
        if (closed) break
        const { done, value } = await reader.read()
        if (done) {
          // A multi-byte character may span chunks; flush the decoder tail.
          consume(decoder.decode())
          break
        }
        // Any traffic counts as alive, comments included — that is what a ping is for.
        armIdleTimer()
        if (!consume(decoder.decode(value, { stream: true }))) break
      }
    } catch {
      if (closed) return
      // Connection error (or the idle abort above) — schedule reconnect.
    } finally {
      if (idleTimer !== null) window.clearTimeout(idleTimer)
    }

    if (closed) return

    reconnectAttempt++
    const nextMs = Math.min(backoffMs * 2 ** (reconnectAttempt - 1), maxBackoffMs)
    onConnection?.({ kind: 'reconnecting', attempt: reconnectAttempt, nextMs })
    window.setTimeout(connect, nextMs)
  }

  connect()

  return {
    close() {
      closed = true
      controller?.abort()
    },
  }
}