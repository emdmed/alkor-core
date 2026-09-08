#!/usr/bin/env node
/**
 * medextract server: HTTP entry point for the harness.
 *
 * Receives prompts and routes them internally using the same modes the CLI uses.
 * Profiles, packs, and config are read from profiles.toml exactly as the CLI does.
 *
 * Endpoints:
 *   GET  /health                    — list loaded profiles and active sessions
 *   POST /route                     — classify input (uses router mode directly)
 *   POST /run                       — execute a profile against input
 *   POST /session                   — create a new conversational session
 *   POST /session/:id/send          — send a message to a session
 *   POST /session/:id/reset         — clear session history
 *   POST /session/:id/load          — restore saved conversation
 *   DELETE /session/:id             — destroy a session
 */
import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { loadConfig, requireProfile, ConfigError } from './core/config.ts'
import { loadPack, resolvePackRoot, PackError } from './core/pack.ts'
import { loadProfileModule, resolveProfileModule, ProfileError } from './core/profile.ts'
import { nullTrace } from './core/trace.ts'
import { route, type RouteResult } from './modes/router.ts'
import { runAgent } from './modes/agentic.ts'
import { createSession, type Session, type TurnResult } from './modes/session.ts'
import { runPipeline, buildPipeline } from './modes/pipeline.ts'
import type { Pack } from './core/pack.ts'
import type { ProfileModule } from './core/profile.ts'

const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')
  } catch {
    return false
  }
})()

export const createServer = async (configPath?: string): Promise<Server> => {
  const cfg = loadConfig(configPath)

  // Caches for loaded profiles and packs so repeated requests do not re-import.
  const profileCache = new Map<string, { profile: ProfileModule; config: ReturnType<typeof requireProfile> }>()
  const loadingProfiles = new Map<
    string,
    Promise<{ profile: ProfileModule; config: ReturnType<typeof requireProfile> }>
  >()
  const packCache = new Map<string, Pack>()

  const loadProfile = async (name: string) => {
    const cached = profileCache.get(name)
    if (cached) return cached

    const loading = loadingProfiles.get(name)
    if (loading) return loading

    const promise = (async () => {
      const profileConfig = requireProfile(cfg, name)
      const profile = await loadProfileModule(
        name,
        resolveProfileModule(name, { configured: profileConfig.module, base: cfg.base }),
      )
      const entry = { profile, config: profileConfig }
      profileCache.set(name, entry)
      return entry
    })()

    loadingProfiles.set(name, promise)
    try {
      return await promise
    } finally {
      loadingProfiles.delete(name)
    }
  }

  const loadPackForProfile = async (
    profileName: string,
    profile: ProfileModule,
    profileConfig: ReturnType<typeof requireProfile>,
  ) => {
    if (!profile.needsPack && !profileConfig.pack) return undefined
    const cacheKey = profileName
    if (packCache.has(cacheKey)) return packCache.get(cacheKey)!

    const pack = loadPack(
      resolvePackRoot(profileName, {
        explicit: undefined,
        configured: profileConfig.pack as string | undefined,
        base: cfg.base,
      }),
    )
    packCache.set(cacheKey, pack)
    return pack
  }

  // In-memory sessions
  const sessions = new Map<string, { profile: string; session: Session }>()

  // JSON body parser
  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(chunks).toString('utf8')
    if (!body) return undefined
    try {
      return JSON.parse(body)
    } catch (e) {
      throw new Error(`Invalid JSON: ${(e as Error).message}`)
    }
  }

  // Response helpers
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data, null, 2))
  }

  const ok = (res: ServerResponse, data: unknown) => json(res, 200, data)
  const bad = (res: ServerResponse, message: string) => json(res, 400, { error: message })
  const notFound = (res: ServerResponse, message: string) => json(res, 404, { error: message })
  const serverError = (res: ServerResponse, message: string) => json(res, 500, { error: message })

  const server = httpCreateServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost`)
      const method = req.method ?? 'GET'

      // --- Health --------------------------------------------------------------
      if (method === 'GET' && url.pathname === '/health') {
        return ok(res, {
          profiles: Object.keys(cfg.profiles),
          sessions: sessions.size,
        })
      }

      // --- Route ---------------------------------------------------------------
      if (method === 'POST' && url.pathname === '/route') {
        const body = (await readBody(req)) as Record<string, unknown> | undefined
        const input = String(body?.input ?? '')
        if (!input) return bad(res, 'input is required')

        const rules = body?.rules as any[] | undefined
        const defaultProfile = String(body?.defaultProfile ?? 'unknown')
        const model = body?.model as any

        const result = await route({
          input,
          rules: rules ?? undefined,
          defaultProfile,
          model: model ?? undefined,
        })
        return ok(res, result)
      }

      // --- Run a profile -------------------------------------------------------
      if (method === 'POST' && url.pathname === '/run') {
        const body = (await readBody(req)) as Record<string, unknown> | undefined
        const profileName = String(body?.profile ?? '')
        const input = String(body?.input ?? '')
        if (!profileName) return bad(res, 'profile is required')
        if (!input) return bad(res, 'input is required')

        const { profile, config: profileConfig } = await loadProfile(profileName)
        const pack = await loadPackForProfile(profileName, profile, profileConfig)
        const baseUrl = profileConfig.url as string | undefined
        const options = (body?.options ?? {}) as Record<string, unknown>

        // Extract / router
        if (profile.mode === 'extract' || profile.mode === 'router') {
          if (!profile.review) {
            return serverError(res, `profile '${profileName}' has no review implementation`)
          }
          const result = await profile.review({
            pack,
            baseUrl,
            trace: nullTrace(),
            input: { kind: 'text', text: input, label: 'server-input' },
            options,
          })
          return ok(res, result)
        }

        // Agentic
        if (profile.mode === 'agentic') {
          if (!profile.tools) {
            return serverError(res, `profile '${profileName}' declares no tools`)
          }
          const result = await runAgent({
            systemPrompt: profile.systemPrompt ?? '',
            task: input,
            workspace: String(options.workspace ?? '/tmp'),
            tools: profile.tools,
            maxSteps: Number(options.steps ?? profile.maxSteps ?? 12),
            baseUrl,
            trace: nullTrace(),
          })
          return ok(res, result)
        }

        // Pipeline
        if (profile.mode === 'pipeline') {
          const steps = profileConfig.steps as Array<Record<string, unknown>> | undefined
          if (!steps || !Array.isArray(steps)) {
            return serverError(res, `profile '${profileName}' has no 'steps' array in its config`)
          }

          const pipelineSteps = buildPipeline(
            steps.map((s) => ({
              name: String(s.name ?? 'unnamed'),
              profile: String(s.profile ?? ''),
              input: s.input as string | undefined,
              field: s.field as string | undefined,
              options: s.options as Record<string, unknown> | undefined,
            })),
          )

          const profiles = new Map<string, ProfileModule>()
          const packs = new Map<string, Pack | undefined>()
          const baseUrls = new Map<string, string | undefined>()

          for (const step of pipelineSteps) {
            if (!profiles.has(step.profile)) {
              const stepProfile = await loadProfile(step.profile)
              profiles.set(step.profile, stepProfile.profile)
              baseUrls.set(step.profile, stepProfile.config.url)
              if (stepProfile.profile.needsPack || stepProfile.config.pack) {
                const stepPack = await loadPackForProfile(step.profile, stepProfile.profile, stepProfile.config)
                packs.set(step.profile, stepPack)
              } else {
                packs.set(step.profile, undefined)
              }
            }
          }

          profiles.set(profileName, profile)
          packs.set(profileName, pack)
          baseUrls.set(profileName, baseUrl)

          const result = await runPipeline({
            initialInput: input,
            steps: pipelineSteps,
            profiles,
            packs,
            baseUrls,
            trace: nullTrace(),
            contextDir: options.contextDir as string | undefined,
            runStep: options.step !== undefined ? Number(options.step) : undefined,
          })
          return ok(res, result)
        }

        return serverError(res, `mode '${profile.mode}' is not supported by the server`)
      }

      // --- Create session ------------------------------------------------------
      if (method === 'POST' && url.pathname === '/session') {
        const body = (await readBody(req)) as Record<string, unknown> | undefined
        const profileName = String(body?.profile ?? '')
        if (!profileName) return bad(res, 'profile is required')

        const { profile, config: profileConfig } = await loadProfile(profileName)
        const baseUrl = profileConfig.url as string | undefined

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
        })

        const id = randomUUID()
        sessions.set(id, { profile: profileName, session })
        return ok(res, { id, profile: profileName })
      }

      // --- Session operations --------------------------------------------------
      const sessionMatch = url.pathname.match(/^\/session\/([^/]+)\/(.+)$/)
      if (sessionMatch && method === 'POST') {
        const [, id, action] = sessionMatch
        if (!id) return notFound(res, 'unknown route')
        const entry = sessions.get(id)
        if (!entry) return notFound(res, `session '${id}' not found`)

        const body = (await readBody(req)) as Record<string, unknown> | undefined

        if (action === 'send') {
          const text = String(body?.text ?? '')
          if (!text) return bad(res, 'text is required')
          const controller = new AbortController()
          res.on('close', () => {
            if (!res.writableFinished) controller.abort()
          })
          const result = await entry.session.send(text, controller.signal)
          return ok(res, result)
        }

        if (action === 'reset') {
          entry.session.reset()
          return ok(res, { ok: true })
        }

        if (action === 'load') {
          const messages = body?.messages as unknown[] | undefined
          if (!messages || !Array.isArray(messages)) {
            return bad(res, 'messages array is required')
          }
          entry.session.load(messages)
          return ok(res, { ok: true })
        }

        return notFound(res, `unknown session action '${action}'`)
      }

      if (method === 'DELETE' && url.pathname.match(/^\/session\/([^/]+)$/)) {
        const match = url.pathname.match(/^\/session\/([^/]+)$/)
        const id = match?.[1]
        if (!id || !sessions.has(id)) {
          return notFound(res, `session '${id}' not found`)
        }
        sessions.delete(id)
        return ok(res, { ok: true })
      }

      return notFound(res, `unknown route ${method} ${url.pathname}`)
    } catch (e) {
      if (e instanceof ConfigError || e instanceof PackError || e instanceof ProfileError) {
        return bad(res, e.message)
      }
      console.error('Server error:', e)
      return serverError(res, (e as Error).message)
    }
  })

  return server
}

if (isMain) {
  const port = Number(process.env.PORT || 3000)
  const server = await createServer()
  server.listen(port, '127.0.0.1', () => {
    console.log(`medextract server listening on http://127.0.0.1:${port}`)
  })
}
