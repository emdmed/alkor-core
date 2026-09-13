/**
 * `DELETE /run/:runId` — stop a run that is still going.
 *
 * A run cancels itself when its caller's connection goes away, which covers the closed tab
 * and the interrupted curl. This endpoint covers the case that one does not: the operator who
 * wants the run stopped but the answer kept, or who is driving from somewhere other than the
 * connection that started it. On the hardware this product targets — minutes per workflow,
 * one model at a time — the difference is a set of weights loaded for nobody.
 *
 * It answers the CANCEL, not the run. The request that started the run is still open and is
 * the one that will carry the run's ending; this one says only whether there was something to
 * stop. Reporting the run's outcome here would mean holding this response until the other
 * finished, which is the opposite of what was asked for.
 */
import type { RouteContext } from '../deps.ts'

export const cancelRun = async ({ url, reply, done, deps }: RouteContext): Promise<void> => {
  const runId = decodeURIComponent(url.pathname.slice('/run/'.length))
  const entry = deps.inFlightRuns.get(runId)
  if (!entry) {
    // 404 covers both "never existed" and "already finished", and deliberately does not
    // distinguish them: this server keeps no index of run ids it has retired, so claiming
    // to know which one happened would be a guess. `GET /runs/:id` is where a finished run
    // is looked up, and it answers that question with a file rather than with a memory.
    reply.notFound(`no run '${runId}' is in flight`)
    done(404)
    return
  }
  entry.cancel('request')
  reply.ok({ runId, profile: entry.profile, cancelling: true })
  done(200)
}
