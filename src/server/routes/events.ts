/**
 * `GET /events` — the activity feed as Server-Sent Events.
 *
 * The interesting part is the replay rule. A client resumes from `Last-Event-ID`, but a seq
 * only means something within the process that issued it: a restarted server counts from 1
 * again, so honouring a stale watermark would skip the whole buffer — including the profile
 * and model facts a dashboard renders from. The instance header is what tells the two apart.
 */
import { ACTIVITY_INSTANCE_HEADER } from '../../core/activity.ts'
import type { RouteContext } from '../deps.ts'

export const events = async ({ req, res, reply, done, deps }: RouteContext): Promise<void> => {
  const { activity, sse } = deps
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...reply.cors,
  })
  // A write to a vanished client surfaces as an async 'error' on the response; with
  // no listener that is an uncaught exception taking the server down mid-fan-out.
  res.on('error', () => sse.drop(res))
  res.write(':ok\n\n')

  const header = (name: string): string | undefined => {
    const raw = req.headers[name]
    return Array.isArray(raw) ? raw[0] : raw
  }
  const lastId = Number.parseInt(header('last-event-id') ?? '', 10)
  const claimed = header(ACTIVITY_INSTANCE_HEADER)
  // A seq from a DIFFERENT process says nothing about what this one has sent, so it is
  // discarded. A client that names no instance (a bare EventSource, which cannot set
  // headers) is taken at its word — it has no way to tell us any better.
  const resumable = claimed === undefined || claimed === activity.instanceId
  // An unparseable header means "I don't know where I was", i.e. send everything —
  // not the NaN comparison that silently suppressed every replayed event.
  const startSeq = resumable && Number.isFinite(lastId) ? lastId : 0
  for (const event of activity.recent()) {
    if (event.seq > startSeq) sse.send(res, event)
  }

  sse.clients.add(res)
  sse.startHeartbeat()

  req.on('close', () => {
    sse.clients.delete(res)
    sse.stopHeartbeatIfIdle()
    // The envelope closes when the STREAM does. Reporting it at open told the feed a
    // connection held for hours had completed in two milliseconds.
    done(200)
  })

  // Keep the response open.
}
