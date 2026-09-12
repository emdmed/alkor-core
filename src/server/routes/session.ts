/**
 * The session endpoints: create one, send a turn to it, reset it, load a history, destroy it.
 *
 * A session is the only thing this server keeps BETWEEN requests, which is what makes the
 * backend rule here different from every other route's. Creation carries no user prompt, so
 * it must not wake a dormant model; the URL is retained instead, and the first send — and
 * every send after an idle-stop — is what waits for the backend to come up.
 */
import { randomUUID } from 'node:crypto'
import { createSession, type TurnResult } from '../../modes/session.ts'
import { withActivityScope } from '../../core/activity.ts'
import type { RouteContext } from '../deps.ts'

export const sessionCreate = async ({ req, reply, done, deps }: RouteContext): Promise<void> => {
  const { activity, sessions } = deps
  const body = (await deps.readBody(req)) as Record<string, unknown> | undefined
  const profileName = String(body?.profile ?? '')
  if (!profileName) {
    reply.bad('profile is required')
    done(400)
    return
  }

  const { profile, config: profileConfig } = await deps.loadProfile(profileName)
  const baseUrl = profileConfig.url ? deps.backendFor(profileConfig.url as string) : undefined

  const rawPrompt = profile.chatSystemPrompt ?? profile.systemPrompt ?? ''
  const systemPrompt = typeof rawPrompt === 'function' ? rawPrompt(undefined) : rawPrompt
  const tools = profile.tools ?? []
  const workspace = String(body?.workspace ?? '/tmp')
  const stream = Boolean(body?.stream ?? false)

  const session = createSession({
    systemPrompt,
    workspace,
    tools,
    baseUrl,
    stream,
    provider: deps.provider,
  })

  const id = randomUUID()
  const effectiveBaseUrl = deps.backendFor(baseUrl)
  // Session creation carries no user prompt, so it must not wake a dormant model.
  // Retaining the URL here lets the first (and every post-idle) send wait for it.
  sessions.set(id, { profile: profileName, baseUrl: effectiveBaseUrl, session })
  activity.emit({ kind: 'session.created', sessionId: id, profile: profileName })
  reply.ok({ id, profile: profileName })
  done(200)
}

/** `POST /session/:id/:action` — send, reset or load. */
export const sessionAction = async (
  ctx: RouteContext,
  id: string,
  action: string | undefined,
): Promise<void> => {
  const { req, res, reply, done, deps } = ctx
  const { activity, manager, sessions } = deps
  const entry = sessions.get(id)
  if (!entry) {
    reply.notFound(`session '${id}' not found`)
    done(404)
    return
  }

  const body = (await deps.readBody(req)) as Record<string, unknown> | undefined

  if (action === 'send') {
    const text = String(body?.text ?? '')
    if (!text) {
      reply.bad('text is required')
      done(400)
      return
    }

    // `text` is now owned by this request and remains in memory while a dormant
    // llama-server starts. Concurrent sends share LlamaManager.ensure's one startup
    // promise; no prompt reaches the transport until the readiness probe succeeds.
    const ready = await manager.ensure(entry.baseUrl)
    deps.backendReachability.set(entry.baseUrl, ready)
    if (!ready) {
      reply.serviceUnavailable(
        `no model backend is reachable at ${entry.baseUrl} — ${manager.describe(entry.baseUrl)}. ` +
          'Start llama-server on it first (scripts/llama-server.sh), or check MEDEXTRACT_MANAGE_MODELS.',
      )
      done(503)
      return
    }
    await deps.emitModelIdentified(entry.baseUrl)

    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })

    const turn = entry.session.messages.filter((m: any) => m?.role === 'user').length + 1

    return withActivityScope({ sessionId: id }, async () => {
      activity.emit({ kind: 'turn.started', sessionId: id, turn })

      let result: TurnResult
      try {
        result = await entry.session.send(text, controller.signal)
      } catch (e) {
        activity.emit({
          kind: 'turn.completed',
          sessionId: id,
          turn,
          stop: 'error',
          iterations: 0,
          toolsUsed: [],
        })
        throw e
      }
      activity.emit({
        kind: 'turn.completed',
        sessionId: id,
        turn,
        stop: result.stop,
        iterations: result.iterations,
        toolsUsed: result.toolsUsed,
        usage: result.usage
          ? {
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
              totalTokens: result.usage.totalTokens,
              cachedTokens: result.usage.cachedTokens,
            }
          : undefined,
      })
      reply.ok(result)
      done(200)
    })
  }

  if (action === 'reset') {
    entry.session.reset()
    reply.ok({ ok: true })
    done(200)
    return
  }

  if (action === 'load') {
    const messages = body?.messages as unknown[] | undefined
    if (!messages || !Array.isArray(messages)) {
      reply.bad('messages array is required')
      done(400)
      return
    }
    entry.session.load(messages)
    reply.ok({ ok: true })
    done(200)
    return
  }

  reply.notFound(`unknown session action '${action}'`)
  done(404)
}

export const sessionDelete = async ({ url, reply, done, deps }: RouteContext): Promise<void> => {
  const id = url.pathname.match(/^\/session\/([^/]+)$/)?.[1]
  if (!id || !deps.sessions.has(id)) {
    reply.notFound(`session '${id}' not found`)
    done(404)
    return
  }
  deps.sessions.delete(id)
  deps.activity.emit({ kind: 'session.destroyed', sessionId: id })
  reply.ok({ ok: true })
  done(200)
}
