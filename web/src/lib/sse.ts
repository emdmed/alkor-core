/**
 * SSE client for the browser, on `fetch` + ReadableStream. The intelligence — frame
 * parsing, seq dedup, spec refusal — is shared with the terminal client via `sse-core.ts`;
 * this file is only the transport and the reconnect/backoff loop, mirroring `src/tui/sse.ts`.
 */
import type { ActivityEvent } from '../../../src/core/activity-types.ts'
import { SseFrameAccumulator, decideSseFrame, type SseConnectionStatus } from '../../../src/tui/sse-core.ts'

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
}

export const createSseClient = (o: SseOptions): SseClient => {
  const { url, onEvent, onConnection } = o
  const backoffMs = o.backoffMs ?? 1000
  const maxBackoffMs = o.maxBackoffMs ?? 30_000

  let lastSeq = 0
  let closed = false
  let reconnectAttempt = 0
  let controller: AbortController | null = null

  const connect = async () => {
    if (closed) return

    onConnection?.({ kind: 'connecting' })

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
    }
    if (lastSeq > 0) {
      // Resume from the last seen seq instead of replaying the whole ring buffer.
      headers['Last-Event-ID'] = String(lastSeq)
    }

    controller = new AbortController()

    try {
      const res = await fetch(url, {
        headers,
        signal: controller.signal,
        cache: 'no-store',
      })

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      reconnectAttempt = 0
      onConnection?.({ kind: 'live' })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const accumulator = new SseFrameAccumulator()

      while (true) {
        if (closed) break
        const { done, value } = await reader.read()
        if (done) {
          // A multi-byte character may span chunks; flush the decoder tail.
          for (const frame of accumulator.push(decoder.decode())) {
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
          break
        }
        for (const frame of accumulator.push(decoder.decode(value, { stream: true }))) {
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
    } catch {
      if (closed) return
      // Connection error — schedule reconnect.
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