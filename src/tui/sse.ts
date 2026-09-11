/**
 * SSE client on `undici` (already a dep). The intelligence — frame parsing, dedup by
 * `seq`, spec refusal — lives in `sse-core.ts`, which the browser dashboard imports too;
 * this file is only the undici transport plus the reconnect/backoff loop.
 */
import { request } from 'undici'
import {
  ACTIVITY_INSTANCE_HEADER,
  SseFrameAccumulator,
  decideSseFrame,
  type SseWatermark,
} from './sse-core.ts'

export type { SseConnectionStatus } from './sse-core.ts'

export interface SseClient {
  /** Close the connection and stop reconnecting. */
  close(): void
}

export interface SseOptions {
  url: string
  /** Called for every parsed ActivityEvent. */
  onEvent: (event: import('../core/activity-types.ts').ActivityEvent) => void
  /** Called when connection status changes. */
  onConnection?: (status: import('./sse-core.ts').SseConnectionStatus) => void
  /** Initial backoff in ms; doubles each attempt, capped at maxBackoffMs. */
  backoffMs?: number
  maxBackoffMs?: number
  /**
   * Drop and reconnect after this long with no bytes at all. The server pings every 15s,
   * so silence past a few ping intervals means the connection is dead rather than quiet —
   * the distinction the heartbeat exists to make, and which nothing else measures.
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
  let currentAbort: AbortController | null = null

  const connect = async () => {
    if (closed) return

    // Say what we are doing before the request resolves. A blank dashboard is
    // indistinguishable from a disconnected one, especially while the server starts.
    onConnection?.({ kind: 'connecting' })

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
    }
    if (mark.lastSeq > 0) {
      headers['Last-Event-ID'] = String(mark.lastSeq)
      // The seq is only meaningful to the process that issued it; say which one that was.
      if (mark.instanceId) headers[ACTIVITY_INSTANCE_HEADER] = mark.instanceId
    }

    const abort = new AbortController()
    currentAbort = abort
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => abort.abort(), idleTimeoutMs)
      if (typeof idleTimer.unref === 'function') idleTimer.unref()
    }

    try {
      const res = await request(url, { headers, signal: abort.signal })

      if (res.statusCode !== 200) {
        throw new Error(`HTTP ${res.statusCode}`)
      }

      reconnectAttempt = 0
      onConnection?.({ kind: 'live' })

      const accumulator = new SseFrameAccumulator()
      armIdleTimer()

      for await (const chunk of res.body) {
        if (closed) break
        // Any traffic counts as alive, comments included — that is what a ping is for.
        armIdleTimer()
        for (const frame of accumulator.push(chunk.toString('utf8'))) {
          const decision = decideSseFrame(frame, mark)
          if (decision.kind === 'event') {
            mark = decision.watermark
            onEvent(decision.event)
          } else if (decision.kind === 'refused') {
            onConnection?.({ kind: 'refused', reason: decision.reason })
            closed = true
            break
          }
        }
      }
    } catch (e) {
      if (closed) return
      // Connection error (or the idle abort above) — schedule reconnect.
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
    }

    if (closed) return

    // Reconnect with backoff.
    reconnectAttempt++
    const nextMs = Math.min(backoffMs * 2 ** (reconnectAttempt - 1), maxBackoffMs)
    onConnection?.({ kind: 'reconnecting', attempt: reconnectAttempt, nextMs })
    setTimeout(connect, nextMs)
  }

  connect()

  return {
    close() {
      closed = true
      currentAbort?.abort()
    },
  }
}