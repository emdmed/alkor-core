/**
 * The SSE fan-out: who is listening, what they get, and when a slow one is cut loose.
 *
 * It is an object rather than loose functions because two of its five members are MUTABLE
 * and shared — the client set and the heartbeat timer — and a handler that received copies
 * would add itself to a set nobody broadcasts to. `/events` needs exactly this and none of
 * the rest of the server, which is why it is worth separating from the config, the model
 * lifecycle and the pack caches it used to sit beside.
 */
import type { ServerResponse } from 'node:http'
import type { ActivityEvent } from '../core/activity.ts'
import { sseWrite } from './reply.ts'

export interface SseHub {
  clients: Set<ServerResponse>
  /** Send one event to one client, acting on the backpressure verdict. */
  send(res: ServerResponse, event: ActivityEvent): void
  /** Remove a client and close its response. */
  drop(res: ServerResponse): void
  /** Start the keep-alive ping if it is not already running. Idempotent. */
  startHeartbeat(): void
  /** Stop it when the last client leaves, so an idle server holds no timer. */
  stopHeartbeatIfIdle(): void
  /** Cut every client loose and stop the timer. Called on server close. */
  shutdown(): void
}

export const createSseHub = (bufferBytes: number): SseHub => {
  const clients = new Set<ServerResponse>()
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  const drop = (res: ServerResponse) => {
    clients.delete(res)
    if (!res.writableEnded) res.end()
  }

  /** One write to one SSE client, acting on the verdict from `sseWrite`. */
  const writeToClient = (res: ServerResponse, payload: string) => {
    const verdict = sseWrite(res, payload, bufferBytes)
    if (verdict === 'gone') clients.delete(res)
    else if (verdict === 'overflow') drop(res)
  }

  const stopHeartbeat = () => {
    if (!heartbeatTimer) return
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }

  return {
    clients,
    send: (res, event) =>
      writeToClient(res, `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`),
    drop,
    startHeartbeat: () => {
      if (heartbeatTimer) return
      heartbeatTimer = setInterval(() => {
        for (const res of clients) writeToClient(res, ': ping\n\n')
      }, 15_000)
      // Unref'd like the idle sweep: a heartbeat must never be the reason the process lives.
      if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
    },
    stopHeartbeatIfIdle: () => {
      if (clients.size === 0) stopHeartbeat()
    },
    shutdown: () => {
      stopHeartbeat()
      for (const res of clients) {
        if (!res.writableEnded) res.end()
      }
      clients.clear()
    },
  }
}
