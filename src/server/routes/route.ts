/**
 * `POST /route` — which profile should answer this input.
 *
 * Two paths, and the difference is what a caller supplied. Explicit `rules` or `model` route
 * directly. A request carrying neither goes through the PINNED router profile: its rules
 * catch what rules catch, its model catches the rest.
 *
 * The pinned path brings its backend up and refuses loudly when it cannot. An initial prompt
 * that needs classification must not fall silently to the default because the classifier was
 * never started — a wrong answer that looks like a routing decision is worse than a 503.
 */
import { route, type RouteResult, type RouteRule, type RouterOptions } from '../../modes/router.ts'
import { nullTrace } from '../../core/trace.ts'
import type { RouteContext } from '../deps.ts'

export const routeRequest = async ({ req, reply, done, deps }: RouteContext): Promise<void> => {
    const body = (await deps.readBody(req)) as Record<string, unknown> | undefined
    const input = String(body?.input ?? '')
    if (!input) {
      reply.bad('input is required')
      done(400)
      return
    }

    const rules = body?.rules as RouteRule[] | undefined
    const defaultProfile = String(body?.defaultProfile ?? 'unknown')
    const explicitModel = body?.model as RouterOptions['model'] | undefined

    // The front-door path: a request that carries no explicit rules or model is routed
    // by the pinned router profile — its rules catch what rules catch, and its model
    // catches the rest. The backend is brought up here, loudly refusing when it cannot:
    // an initial prompt that needs classification must not silently fall to the default
    // because the classifier was never started.
    let result: RouteResult
    const pinned = deps.pinnedRouters[0]
    if (!rules && !explicitModel && pinned) {
      const { profile, config: profileConfig } = await deps.loadProfile(pinned.name)
      const routerUrl = profileConfig.url ? deps.backendFor(profileConfig.url) : undefined

      // No URL means this router is intentionally rules-only. A configured URL opts
      // the router into model fallback and therefore into managed-backend preflight.
      if (routerUrl) {
        const ready = await deps.manager.ensure(routerUrl)
        if (!ready) {
          deps.backendReachability.set(routerUrl, false)
          reply.serviceUnavailable(
            `no model backend is reachable at ${routerUrl} — ${deps.manager.describe(routerUrl)}. ` +
              'Start llama-server on it first (scripts/llama-server.sh), or check MEDEXTRACT_MANAGE_MODELS.',
          )
          done(503)
          return
        }
        deps.backendReachability.set(routerUrl, true)
        await deps.emitModelIdentified(routerUrl)
      }

      if (!profile.review) {
        reply.serverError(`pinned router profile '${pinned.name}' exposes no review (mode ${profile.mode})`)
        done(500)
        return
      }
      const review = await profile.review({
        pack: undefined,
        baseUrl: routerUrl,
        trace: nullTrace(),
        input: { kind: 'text', text: input, label: 'server-input' },
        options: {},
        provider: deps.provider,
        activity: deps.activity,
      })
      if (!review.report || typeof review.report !== 'object') {
        reply.serverError(`pinned router profile '${pinned.name}' produced no route report`)
        done(500)
        return
      }
      result = review.report as RouteResult
    } else {
      result = await route({ input, rules, defaultProfile, model: explicitModel })
    }
    deps.activity.emit({
      kind: 'route.decided',
      profile: result.profile,
      confidence: result.confidence,
      reason: result.reason,
      ruleVsModel: result.reason.startsWith('model:') ? 'model' : 'rule',
    })
    reply.ok(result)
    done(200)
}
