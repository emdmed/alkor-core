/**
 * SSE client on `undici` (already a dep). The intelligence — frame parsing, dedup by
 * `seq`, spec refusal — lives in `sse-core.ts`, which the browser dashboard imports too;
 * this file is only the undici transport plus the reconnect/backoff loop.
 */
import { request } from 'undici'
import { SseFrameAccumulator, decideSseFrame } from './sse-core.ts'

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
}

export const createSseClient = (o: SseOptions): SseClient => {
  const { url, onEvent, onConnection } = o
  const backoffMs = o.backoffMs ?? 1000
  const maxBackoffMs = o.maxBackoffMs ?? 30_000

  let lastSeq = 0
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
    if (lastSeq > 0) {
      headers['Last-Event-ID'] = String(lastSeq)
    }

    currentAbort = new AbortController()

    try {
      const res = await request(url, { headers, signal: currentAbort.signal })

      if (res.statusCode !== 200) {
        throw new Error(`HTTP ${res.statusCode}`)
      }

      reconnectAttempt = 0
      onConnection?.({ kind: 'live' })

      const accumulator = new SseFrameAccumulator()

      for await (const chunk of res.body) {
        if (closed) break
        for (const frame of accumulator.push(chunk.toString('utf8'))) {
          const decision = decideSseFrame(frame, lastSeq)
          if (decision.kind === 'event') {
            lastSeq = decision.nextSeq
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
      // Connection error — schedule reconnect.
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