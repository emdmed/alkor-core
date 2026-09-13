/**
 * `GET /runs` and `GET /runs/:id` — what this harness has recorded, offered back.
 *
 * The run id in a `/pipeline` response is the only key tying an answer a caller holds to the
 * feed that explains how it was produced, and until this endpoint existed that key pointed at
 * nothing durable: the activity ring rolls, the browser tab closes, and the run was
 * unreachable even though its trace was on disk. These two routes are the other end of that
 * id.
 *
 * They read the trace directory, which is not the same set as "runs this server ran" — a CLI
 * verb writes there too, and those are listed beside the server's own. That is deliberate.
 * The question a reader has is "what has been run on this machine", and a listing that hid
 * half the answer because a different process produced it would be answering a question about
 * this server rather than about the work.
 *
 * THE TWO ROUTES ARE NOT THE SAME KIND OF THING, and they are guarded differently. `/runs` is
 * metadata — ids, times, outcomes — and answers any loopback origin, because that is what a
 * dashboard's run history needs. `/runs/:id` hands back a trace's events, which is what the
 * model was asked and what it answered, and a browser page needs naming in `ALKOR_TRACE_CORS`
 * before it may read that. See `traceContentAllowed`.
 */
import { listRuns, readRun, RunError } from '../../core/runs.ts'
import { TraceError } from '../../core/trace-read.ts'
import { traceContentAllowed } from '../reply.ts'
import type { RouteContext } from '../deps.ts'

/** How many runs a listing returns when the caller does not say. */
const DEFAULT_LIMIT = 50

export const runsList = async ({ url, reply, done }: RouteContext): Promise<void> => {
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 0) {
    reply.bad(`limit must be a non-negative integer, not '${rawLimit}'`)
    done(400)
    return
  }
  const profile = url.searchParams.get('profile') ?? undefined
  const runs = listRuns({ limit, ...(profile ? { profile } : {}) })
  reply.ok({
    runs,
    // Stated rather than counted by the client: a listing capped at the default looks
    // exactly like a machine that has run 50 things, and the two are not the same fact.
    limit,
    // A trace holds raw prompts and completions under whatever redaction its profile
    // supplied, so a reader deciding what to do with one should be told what it is.
    note: 'Recorded runs from the trace directory, written by this server and by the CLI alike.',
  })
  done(200)
}

export const runsDocument = async ({ req, url, reply, done, deps }: RouteContext): Promise<void> => {
  const id = decodeURIComponent(url.pathname.slice('/runs/'.length))
  // Opt-out rather than opt-in: the whole point of fetching one run is to read it, and a
  // caller that wants the summary alone is the unusual one.
  const events = url.searchParams.get('events') !== '0'
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
  // Content, unlike the listing, is not for any page that happens to be on a local port.
  // Refused rather than silently returned without the events: a reader handed a run with an
  // empty `events` array would conclude the run recorded nothing, which is a lie about the
  // file. See `traceContentAllowed`.
  if (events && !traceContentAllowed(origin, deps.settings.current().traceCors)) {
    reply.forbidden(
      `a browser page at ${origin} may read this run's metadata but not its contents — ` +
        'a trace holds what the model was asked and what it answered. Add the origin to ' +
        "ALKOR_TRACE_CORS (or the trace origins in Settings) to allow it, or request " +
        '?events=0 for the summary alone.',
    )
    done(403)
    return
  }
  try {
    const { summary, trace } = readRun(id, { events })
    reply.ok({
      ...summary,
      spec: trace?.spec,
      events: trace?.events,
    })
    done(200)
  } catch (e) {
    if (e instanceof RunError) {
      reply.notFound(e.message)
      done(404)
      return
    }
    // A trace that is corrupt, or that declares a spec from the future, is a 500 rather than
    // a 404: the run is there and this harness refuses to read it, and telling the caller it
    // does not exist would send them looking for a file that is in front of them.
    if (e instanceof TraceError) {
      reply.serverError(e.message)
      done(500)
      return
    }
    throw e
  }
}
