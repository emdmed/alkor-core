/**
 * `GET /health` — everything a dashboard needs to draw this server without guessing.
 *
 * It answers three separate questions in one payload, and they are separate on purpose: what
 * profiles exist and what shape each one runs in (`topology`), which model endpoints are
 * actually up (`models`), and what the host is holding right now (`resources`, `sessions`,
 * `activity`). A client that could only ask the first would render a pipeline as LIVE over a
 * dark model port.
 */
import type { RouteContext } from '../deps.ts'
import { HARNESS_STAGE, HARNESS_VERSION } from '../../core/version.ts'

export const health = async ({ reply, done, deps }: RouteContext): Promise<void> => {
  const { cfg, manager, activity, sessions, sse } = deps
  await deps.refreshReachability()
  const topologyProfiles = await Promise.all(
    Object.values(cfg.profiles).map(async ({ name, mode, url, pack, pinned }) => ({
      name,
      mode,
      url,
      pack,
      pinned: Boolean(pinned),
      topology: await deps.topologyForProfile(name, mode),
    })),
  )
  reply.ok({
    // What is answering, and what stage it is at. A dashboard can be pointed at any server,
    // so the badge it shows must describe the host that did the work rather than the build
    // the page was served from — those are the same thing only by coincidence.
    harness: { version: HARNESS_VERSION, stage: HARNESS_STAGE },
    profiles: Object.keys(cfg.profiles),
    topology: {
      pipeline: cfg.pipeline,
      profiles: topologyProfiles,
      workflows: Object.values(cfg.profiles)
        .filter((profile) => profile.mode === 'workflow')
        .map((profile) => ({
          name: profile.name,
          steps: Array.isArray(profile.steps)
            ? profile.steps.map((raw) => {
              const step = raw as Record<string, unknown>
              return {
                name: String(step.name ?? 'unnamed'),
                profile: String(step.profile ?? ''),
                input: typeof step.input === 'string'
                  ? step.input
                  : step.input && typeof step.input === 'object' && !Array.isArray(step.input)
                    ? Object.entries(step.input as Record<string, unknown>)
                        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
                        .map(([name, ref]) => ({ name, ref }))
                    : undefined,
                field: typeof step.field === 'string' ? step.field : undefined,
                // The terminal step, so a view can draw the ending as the ending rather
                // than as one more link in the chain. It is reached from every step
                // above it, not only from the one before.
                final: step.final === true ? true : undefined,
              }
            })
            : [],
        })),
    },
    // One entry per llama-server endpoint this server would talk to, so the dashboard
    // can say "MODEL OFFLINE" rather than claiming LIVE over a dark model port.
    // `managed`/`state` report the on-demand lifecycle: a managed backend that is
    // down is DORMANT, not broken — it spawns at the next run that needs it.
    models: deps.backendUrls.map((baseUrl) => {
      const id = deps.modelIdentityCache.get(baseUrl)
      const status = manager.status(baseUrl)
      return {
        baseUrl,
        reachable: deps.backendReachability.get(baseUrl) ?? false,
        model: id?.model,
        identified: Boolean(id?.identified),
        managed: status.managed,
        // The front-door flag: a pinned backend is resident once brought up, never
        // idle-stopped, so a consumer can render it distinctly from a dormant one.
        pinned: status.pinned,
        state: status.state,
        // What holding this model costs, which is what decides whether it can be up
        // at the same time as the next one. Absent when the model file is not there
        // to measure — unknown, which the budget treats as free rather than guessing.
        footprintBytes: status.footprintBytes,
      }
    }),
    // The resident-model budget: how much this host will hold at once, and how much
    // of it is spoken for. A dashboard showing a model starting and another stopping
    // in the same second can say WHY from these two numbers.
    resources: manager.resources(),
    sessions: sessions.size,
    activity: {
      buffered: activity.recent().length,
      subscribers: sse.clients.size,
      // The stream identity stamped on every event: a poller that sees it change knows
      // the seq space restarted, without waiting for an event to prove it.
      instance: activity.instanceId,
    },
  })
  done(200)
}
