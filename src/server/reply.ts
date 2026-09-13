/**
 * How this server answers: CORS policy, JSON status replies, and the one SSE write rule.
 *
 * All of it is pure — no config, no caches, no model lifecycle — which is why it can live
 * outside the `createServer` closure that holds those. A route handler needs a `Reply` and
 * nothing else to refuse a request properly, and keeping the refusal vocabulary in one file
 * is what stops a new endpoint inventing its own shape for "not found".
 */
import type { ServerResponse } from 'node:http'
import { ACTIVITY_INSTANCE_HEADER } from '../core/activity.ts'

/**
 * CORS is loopback-only by default. A browser dashboard is cross-origin by definition
 * (`localhost:5173` vs `127.0.0.1:3000`), but opening the feed to every website would let
 * any page you visit read it. Only loopback origins are accepted unless ALKOR_CORS
 * names others, or is `*` for an explicit blanket.
 */
export const corsAllowedOrigin = (rawOrigin: string | undefined): string | undefined => {
  if (!rawOrigin) return undefined
  const configured = (process.env.ALKOR_CORS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (configured.includes('*')) return '*'
  if (configured.length > 0) return configured.includes(rawOrigin) ? rawOrigin : undefined
  try {
    const host = new URL(rawOrigin).hostname
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return rawOrigin
  } catch {
    // Not a URL — a non-browser client; nobody reads it in a page, so no CORS contract.
  }
  return undefined
}

/**
 * Whether a browser page may read TRACE CONTENT, which is a stricter question than CORS.
 *
 * The activity feed is metadata-only by construction — `emit()` throws on a content-bearing
 * key — so opening it to every loopback origin risks nothing but operational noise. A trace
 * is the opposite: it holds what the model was asked and what it answered, and for an
 * extraction that answer quotes the document verbatim. `GET /runs/:id` is therefore the first
 * endpoint on this server that can hand a page real content, and the loopback default is too
 * generous for it: *any* local dev server, Electron app or page on a localhost port counts as
 * a loopback origin, and none of them are this operator's dashboard.
 *
 * The redaction hook still stands behind this, and for a pack that declares its corpus real
 * it elides the completion before it ever reaches disk. But that hook was written to protect
 * a file on your own machine; making it the only thing between a trace and a cross-origin
 * reader is a bigger job than it was given, and only one profile in this repository supplies
 * one at all.
 *
 * So: a request with NO `Origin` is not a browser page — curl, a script, a cron job, all
 * first-class callers here — and is allowed. A request WITH one is a page, and must be named
 * in `ALKOR_TRACE_CORS` (or `*`) to read content. Metadata is unaffected: the listing and
 * `?events=0` answer any loopback origin, which is what a dashboard's run history needs.
 */
export const traceContentAllowed = (rawOrigin: string | undefined): boolean => {
  if (!rawOrigin) return true
  const configured = (process.env.ALKOR_TRACE_CORS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return configured.includes('*') || configured.includes(rawOrigin)
}

export const corsHeaders = (origin: string | undefined): Record<string, string> => {
  if (!origin) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': `Content-Type, Accept, Last-Event-ID, ${ACTIVITY_INSTANCE_HEADER}`,
    'Access-Control-Max-Age': '86400',
  }
}

export const json = (
  res: ServerResponse,
  status: number,
  data: unknown,
  cors: Record<string, string> = {},
): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...cors })
  res.end(JSON.stringify(data, null, 2))
}

/**
 * `extra` exists for one fact: the run id. An error that omits it tells a dashboard that
 * something failed but not WHICH run failed, so the feed cannot be searched for what led up
 * to it. Every refusal raised after a run id is minted carries it.
 */
export type ErrorExtra = Record<string, unknown> | undefined

/** Every status this server answers with, bound to one request's CORS headers. */
export interface Reply {
  ok(data: unknown): void
  bad(message: string, extra?: ErrorExtra): void
  notFound(message: string): void
  /** The caller is known and is not allowed this, as distinct from the thing not existing. */
  forbidden(message: string): void
  serverError(message: string, extra?: ErrorExtra): void
  serviceUnavailable(message: string, extra?: ErrorExtra): void
  /**
   * A run the CALLER stopped: 499, nginx's "client closed request".
   *
   * Non-standard, and chosen anyway because every standard alternative says something false.
   * A 500 blames the harness for a button the operator pressed, a 200 claims a result that
   * was never produced, and a 4xx in the registered range describes a request that was
   * malformed — this one was fine, it simply did not get to finish. A log filtered for
   * server faults must not surface these, and 499 is the one code readers already parse
   * that way.
   */
  cancelled(message: string, extra?: ErrorExtra): void
  /** The resolved CORS headers, for the handlers that write their own head (SSE). */
  cors: Record<string, string>
}

export const replyFor = (res: ServerResponse, cors: Record<string, string>): Reply => ({
  ok: (data) => json(res, 200, data, cors),
  bad: (message, extra) => json(res, 400, { error: message, ...extra }, cors),
  notFound: (message) => json(res, 404, { error: message }, cors),
  forbidden: (message) => json(res, 403, { error: message }, cors),
  serverError: (message, extra) => json(res, 500, { error: message, ...extra }, cors),
  serviceUnavailable: (message, extra) => json(res, 503, { error: message, ...extra }, cors),
  cancelled: (message, extra) => json(res, 499, { error: message, cancelled: true, ...extra }, cors),
  cors,
})

/** The bounded-buffer part of an SSE response: what a fan-out may still use it for. */
export type SseWriteVerdict = 'ok' | 'gone' | 'overflow'

/**
 * One write to one SSE client, with the two facts a fan-out must respect.
 *
 * A write to a response that has already gone away fails on a LATER tick, as an 'error'
 * event rather than a throw, so the state is checked before writing instead of wrapped in a
 * `try`. And an unread response queues in this process: past the cap the caller ends it, and
 * the client recovers through the same reconnect-and-replay path as any dropped connection.
 * Kept out of the server closure so the overflow branch can be tested without arranging a
 * megabyte of real backpressure.
 */
export const sseWrite = (
  res: Pick<ServerResponse, 'write' | 'writableEnded' | 'destroyed' | 'writableLength'>,
  payload: string,
  bufferBytes: number,
): SseWriteVerdict => {
  if (res.writableEnded || res.destroyed) return 'gone'
  res.write(payload)
  return res.writableLength > bufferBytes ? 'overflow' : 'ok'
}
