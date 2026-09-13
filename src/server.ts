#!/usr/bin/env node
/**
 * alkor server: HTTP entry point for the harness.
 *
 * Receives prompts and routes them internally using the same modes the CLI uses.
 * Profiles, packs, and config are read from profiles.toml exactly as the CLI does.
 *
 * Endpoints:
 *   GET  /health                    — list loaded profiles, active sessions, and activity stats
 *   GET  /events                    — SSE stream of activity events (metadata-only)
 *   GET  /runs                      — recorded runs, newest first
 *   GET  /runs/:id                  — one recorded run, by run id or by listed id
 *   DELETE /run/:id                 — stop a run that is still in flight
 *   POST /route                     — classify input (uses router mode directly)
 *   POST /pipeline                  — route to and execute one workflow
 *   POST /run                       — execute a profile against input
 *   POST /session                   — create a new conversational session
 *   POST /session/:id/send          — send a message to a session
 *   POST /session/:id/reset         — clear session history
 *   POST /session/:id/load          — restore saved conversation
 *   DELETE /session/:id             — destroy a session
 */
import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { corsAllowedOrigin, corsHeaders, json, replyFor, sseWrite, type Reply, type SseWriteVerdict } from './server/reply.ts'
import type { RouteContext, ServerDeps } from './server/deps.ts'
import { health } from './server/routes/health.ts'
import { corpusList, corpusDocument } from './server/routes/corpus.ts'
import { events } from './server/routes/events.ts'
import { runsList, runsDocument } from './server/routes/runs.ts'
import { cancelRun } from './server/routes/cancel.ts'
import { sessionCreate, sessionAction, sessionDelete } from './server/routes/session.ts'
import { routeRequest } from './server/routes/route.ts'
import { runPipeline } from './server/routes/pipeline.ts'
import { createSseHub } from './server/sse.ts'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { statSync } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { loadConfig, requireProfile, ConfigError } from './core/config.ts'
import { loadPack, resolvePackRoot, PackError } from './core/pack.ts'
import { listCorpus, readCorpusDocument, CorpusError } from './core/corpus.ts'
import { loadProfileModule, redactor, resolveProfileModule, ProfileError } from './core/profile.ts'
import { composeRedactors, nullTrace, openTrace, type Redactor, type Trace } from './core/trace.ts'
import type { Session } from './modes/session.ts'
import { defaultProvider } from './core/client.ts'
import { createActivity, withActivity, LLM_CALL_STAGE, type Activity } from './core/activity.ts'
import { EXTRACT_STAGES } from './modes/extract.ts'
import type { Pack } from './core/pack.ts'
import type { ProfileModule } from './core/profile.ts'
import type { ProfileTopology } from './core/topology.ts'
import { identifyServer, probeServer, DEFAULT_URL } from './core/client.ts'
import {
  LlamaManager,
  fmtBytes,
  normalizeBaseUrl,
  withTouching,
  type LlamaManagerOptions,
  type ManagedSpec,
} from './core/llama-manager.ts'

const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')
  } catch {
    return false
  }
})()

/** SHA-256 digest of input text, truncated for event size. */
const inputDigest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

export { sseWrite, type SseWriteVerdict }

export interface ServerOptions {
  /** Process seams used by server tests; production uses the real llama-server lifecycle. */
  llamaManager?: Pick<LlamaManagerOptions, 'binary' | 'pollMs' | 'probe' | 'spawn' | 'startTimeoutMs'>
  /** Per-SSE-client queue cap; a test shrinks it to reach the overflow path deliberately. */
  sseBufferBytes?: number
  /** Resident-model budget in bytes; overrides ALKOR_MODEL_BUDGET. 0 is unbounded. */
  budgetBytes?: number
  /**
   * Trace seam, so a test can reach the RECORDING-FAILURE paths deliberately.
   *
   * The same device as `sseBufferBytes` above and for the same reason: the interesting
   * behaviour is what happens when a write fails, and there is no way to make one fail
   * through the public surface — a full disk and a revoked handle are not things a test can
   * arrange. Two properties depend on it and were otherwise correct only by inspection: a
   * run whose header cannot be written must not leave itself registered as in-flight, and a
   * footer that cannot be written must not also cost the caller their answer.
   */
  openRunTrace?(profileName: string, runId: string): Promise<Trace>
}

/**
 * How many bytes of model this host will hold resident at once.
 *
 * `ALKOR_MODEL_BUDGET` takes `6GiB`, `600MB`, a percentage of total RAM (`50%`), a
 * plain byte count, or `0` for the old unbounded behaviour. The default is 60% of total
 * RAM: the rest of the machine — the browser the dashboard is open in, the editor, the OS
 * — is not free, and a budget that assumed it was would be a budget that swaps.
 */
export const modelBudgetBytes = (raw?: string, total: number = totalmem()): number => {
  const spec = (raw ?? '').trim()
  if (!spec) return Math.floor(total * 0.6)
  const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(spec)
  if (pct) return Math.floor((total * Number(pct[1])) / 100)
  const size = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|kib|mib|gib)?$/i.exec(spec)
  if (!size) return Math.floor(total * 0.6)
  const scale: Record<string, number> = {
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
  }
  return Math.floor(Number(size[1]) * (scale[(size[2] ?? 'b').toLowerCase()] ?? 1))
}

/**
 * What a backend is expected to cost while resident: the weights on disk, plus the KV cache
 * its context window implies.
 *
 * Both halves matter and the second is the one people forget — a 4B model quantised to 2.5
 * GB serves a 32k context out of a KV cache measured in GB of its own, so a budget counting
 * only file sizes would admit two models that cannot both run. The per-token figure is a
 * coarse average across the 3B-8B architectures this project targets rather than a
 * derivation from any one of them; a profile that knows better sets `footprint` itself.
 *
 * A model file that cannot be stat'd (not downloaded yet, wrong path) returns undefined
 * rather than zero. The distinction is the point: zero would mean "free", and the manager
 * would let it in beside anything.
 */
const KV_BYTES_PER_TOKEN = 131_072

export const footprintBytesFor = (
  model?: string,
  ctx?: number,
  override?: string | number,
): number | undefined => {
  if (override !== undefined && override !== null && override !== '') {
    const bytes = typeof override === 'number' ? Math.floor(override) : modelBudgetBytes(String(override), 0)
    if (bytes > 0) return bytes
  }
  if (!model) return undefined
  const expanded = model.startsWith('~/') ? join(homedir(), model.slice(2)) : model
  let weights: number
  try {
    weights = statSync(isAbsolute(expanded) ? expanded : resolve(expanded)).size
  } catch {
    return undefined
  }
  return weights + (ctx ?? 4096) * KV_BYTES_PER_TOKEN
}

export const createServer = async (configPath?: string, options: ServerOptions = {}): Promise<Server> => {
  const cfg = loadConfig(configPath)
  const activity = createActivity()

  // --- Managed llama-server lifecycle --------------------------------------------------
  // On-demand spawn + idle-stop, so an interactive host keeps in RAM only the models it is
  // actually using. This is server-only by construction: the CLI never imports this file.
  // ALKOR_MANAGE_MODELS=0 restores "start them yourself"; ALKOR_LLAMA_ARGS and
  // ALKOR_IDLE_MS tune the spawn flags and the idle window.
  const manageModels = (process.env.ALKOR_MANAGE_MODELS ?? '1') !== '0'
  const idleMs = Number(process.env.ALKOR_IDLE_MS ?? 120_000) || 120_000
  const spawnArgs = (process.env.ALKOR_LLAMA_ARGS ?? '--no-webui --parallel 1')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const budgetBytes = options.budgetBytes ?? modelBudgetBytes(process.env.ALKOR_MODEL_BUDGET)
  // ALKOR_LLAMA_BIN names the engine for a machine that has it off PATH — a source build,
  // most often. `doctor` reports the same variable, so the check and the spawn agree about
  // which binary they are talking about instead of the check passing on one the spawn cannot find.
  const binary = process.env.ALKOR_LLAMA_BIN?.trim() || undefined
  const manager = new LlamaManager({
    idleMs,
    spawnArgs,
    enabled: manageModels,
    budgetBytes,
    ...(binary ? { binary } : {}),
    ...options.llamaManager,
    emit: (e) => {
      activity.emit({
        kind: 'model.lifecycle',
        baseUrl: e.baseUrl,
        state: e.state,
        pid: e.pid,
        model: e.model,
        reason: e.reason,
        error: e.error,
        wallMs: e.wallMs,
        footprintBytes: e.footprintBytes,
      })
    },
  })

  const wrappedProvider = withTouching(
    withActivity(defaultProvider, activity),
    (url) => manager.track(url),
    DEFAULT_URL,
  )

  // Caches for loaded profiles and packs so repeated requests do not re-import.
  const profileCache = new Map<string, { profile: ProfileModule; config: ReturnType<typeof requireProfile> }>()
  const loadingProfiles = new Map<
    string,
    Promise<{ profile: ProfileModule; config: ReturnType<typeof requireProfile> }>
  >()
  const packCache = new Map<string, Pack>()

  // Model identity cache per baseUrl, so the server resolves it once per endpoint.
  const modelIdentityCache = new Map<string, Awaited<ReturnType<typeof identifyServer>>>()

  const emitModelIdentified = async (baseUrl?: string) => {
    const url = backendFor(baseUrl)
    if (modelIdentityCache.has(url)) return
    // Only a backend that answers is identified. A down one would fire a useless
    // model.identified(false) and, once cached, stay silent when it later comes up or is
    // spawned, which would hide a freshly-online model from the dashboard.
    if (!(await probeServer(url))) return
    const id = await identifyServer(url)
    modelIdentityCache.set(url, id)
    activity.emit({
      kind: 'model.identified',
      baseUrl: url,
      model: id.model,
      ctx: id.props?.ctx,
      slots: id.props?.slots,
      identified: id.identified,
    })
  }

  // The endpoint a profile talks to, spelled the one way everything here keys by: the
  // manager's entries, the reachability map, and the identity cache are all read with this.
  const backendFor = (profileUrl?: string): string =>
    normalizeBaseUrl(profileUrl ?? process.env.LLAMA_URL ?? DEFAULT_URL)

  // The distinct llama-server endpoints everything here can talk to: each profile's own
  // `url`, plus the process-wide fallback. This set is what "is a model up?" means.
  const backendUrls = ((): string[] => {
    const seen = new Set<string>()
    const add = (url: string) => {
      const clean = normalizeBaseUrl(url)
      if (clean) seen.add(clean)
    }
    for (const profile of Object.values(cfg.profiles)) {
      add(profile.url ?? process.env.LLAMA_URL ?? DEFAULT_URL)
    }
    add(process.env.LLAMA_URL ?? DEFAULT_URL)
    return [...seen]
  })()

  // What each backend can be spawned with, taken from the first profile that names it.
  // A backend with no `model`/`ctx` in any profile stays unmanaged: the server will not
  // guess how to launch it for you.
  for (const baseUrl of backendUrls) {
    const profile = Object.values(cfg.profiles).find((p) => backendFor(p.url) === baseUrl)
    const model = profile ? (profile.model as string | undefined) : undefined
    const ctx = profile ? Number(profile.ctx) || undefined : undefined
    const spec: ManagedSpec = {
      baseUrl,
      model,
      ctx,
      pinned: Boolean(profile?.pinned),
      // What this backend costs the machine while it is up, so the manager can decide
      // whether it fits beside what is already there. `footprint` on the profile wins:
      // a deployment that has measured its own model knows better than an estimate.
      footprintBytes: footprintBytesFor(model, ctx, profile?.footprint as string | number | undefined),
    }
    manager.register(spec)
  }

  // The front door: the profiles that catch every initial prompt. Only a pinned router
  // qualifies — a classifier is what classifies, and an extract profile pinned instead is
  // simply kept resident, never consulted by /route. `/route` without explicit rules or a
  // model runs through this profile: its rules first, then its model, with the backend
  // guaranteed reachable before the routing call.
  const pinnedRouters = Object.values(cfg.profiles).filter(
    (p) => p.mode === 'router' && Boolean(p.pinned),
  )

  // Reachability per backend, refreshed by one shared probe so a burst of /health or /run
  // calls cannot stampede the model endpoints. The TTL keeps a polled health check cheap;
  // a run asks for a FRESH probe because a llama-server started after this server must be
  // noticed immediately.
  const backendReachability = new Map<string, boolean>()
  let reachProbeInflight: Promise<void> | null = null
  let lastReachProbeAt = 0
  const REACH_PROBE_TTL_MS = 3000

  const refreshReachability = async (force = false): Promise<void> => {
    if (!force && Date.now() - lastReachProbeAt < REACH_PROBE_TTL_MS) return
    if (reachProbeInflight) {
      await reachProbeInflight
      return
    }
    const probe = (async () => {
      const results = await Promise.all(backendUrls.map(async (url) => [url, await probeServer(url)] as const))
      for (const [url, up] of results) backendReachability.set(url, up)
      lastReachProbeAt = Date.now()
    })()
    reachProbeInflight = probe
    try {
      await reachProbeInflight
    } finally {
      reachProbeInflight = null
    }
  }

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
      activity.emit({
        kind: 'profile.loaded',
        name,
        mode: profile.mode,
        url: profileConfig.url as string | undefined,
        pack: profileConfig.pack as string | undefined,
      })
      return entry
    })()

    loadingProfiles.set(name, promise)
    try {
      return await promise
    } finally {
      loadingProfiles.delete(name)
    }
  }

  const topologyCache = new Map<string, ProfileTopology>()
  /**
   * What a profile of this mode does, when the profile itself does not say.
   *
   * The extract shape is read from the mode that emits it rather than restated — a profile
   * with no topology of its own still runs `extract()`, so this describes the same triple by
   * pointing at it.
   */
  const modeTopology = (mode: string): ProfileTopology => {
    if (mode === 'extract') return { stages: EXTRACT_STAGES.map((stage) => ({ ...stage })) }
    if (mode === 'agentic') {
      return {
        stages: [
          { name: LLM_CALL_STAGE, operation: 'model', repeatable: true },
          { name: 'tool-call', kind: 'decision', operation: 'decision', repeatable: true },
        ],
      }
    }
    if (mode === 'router') return { stages: [{ name: 'route', kind: 'decision', operation: 'decision' }] }
    // A `code` profile computes; it does not decide. The operation is what a view reads, so
    // describing one as a decision would draw a branch where there is none.
    if (mode === 'code') return { stages: [{ name: 'compute', operation: 'code' }] }
    return { stages: [] }
  }
  const topologyForProfile = async (name: string, mode: string): Promise<ProfileTopology> => {
    const cached = topologyCache.get(name)
    if (cached) return cached
    let topology = modeTopology(mode)
    try {
      const profileConfig = requireProfile(cfg, name)
      const profile = await loadProfileModule(
        name,
        resolveProfileModule(name, { configured: profileConfig.module, base: cfg.base }),
      )
      topology = profile.topology ?? topology
      if (!profile.topology && profile.mode === 'agentic' && profile.tools?.length) {
        topology = {
          stages: [
            { name: LLM_CALL_STAGE, operation: 'model', repeatable: true },
            {
              name: 'tool-call',
              kind: 'decision',
              operation: 'decision',
              repeatable: true,
              routes: profile.tools.map((tool) => ({ name: tool.name })),
            },
          ],
        }
      }
    } catch {
      // /health must still describe a misconfigured or unavailable profile. Its declared
      // mode is trustworthy even when importing the optional implementation is not.
    }
    topologyCache.set(name, topology)
    return topology
  }

  /**
   * Every pack this config declares, loaded once and shared with the run path's cache.
   *
   * Keyed by pack ROOT rather than by profile: two profiles in one deployment routinely
   * name the same pack directory, and listing its corpus twice would offer the operator
   * the same note under two ids. A pack that fails to load is left out — the corpus list
   * is a browsing aid, and a config with one broken pack should still offer the others.
   */
  const declaredPacks = (): Pack[] => {
    const byRoot = new Map<string, Pack>()
    for (const profileConfig of Object.values(cfg.profiles)) {
      if (!profileConfig.pack) continue
      try {
        const root = resolvePackRoot(profileConfig.name, {
          explicit: undefined,
          configured: profileConfig.pack,
          base: cfg.base,
        })
        if (byRoot.has(root)) continue
        const cached = packCache.get(profileConfig.name)
        byRoot.set(root, cached ?? loadPack(root))
      } catch {
        continue
      }
    }
    return [...byRoot.values()]
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

  // --- Recording what the server runs ----------------------------------------------------
  // A run driven through /pipeline used to be recorded nowhere: it passed `nullTrace()`, so
  // the same assembly left evidence when the CLI ran it and nothing when the dashboard did.
  // That is the one place this server contradicted the rule that a result the repository
  // cannot reproduce is not a measurement. It records by default now; ALKOR_SERVER_TRACE=0
  // is for a deployment that wants the server to hold nothing.
  const serverTrace = (process.env.ALKOR_SERVER_TRACE ?? '1') !== '0'

  /**
   * The redaction hook for a trace opened under `profileName`, including its steps'.
   *
   * A workflow traces under the WORKFLOW's name, and a workflow profile typically declares no
   * redactor — the profiles that touch documents are its steps. Opening that trace with the
   * wrapper's own hook alone would write a step's raw completions to disk while the profile
   * doing the reading appeared to have redaction configured, which is precisely the failure
   * `core/trace.ts` warns about. So every profile that can write into this file contributes
   * its judgement, once: `seen` both breaks a cycle and keeps a redactor from being applied
   * twice, which would digest its own marker.
   */
  const runRedactor = async (profileName: string): Promise<Redactor> => {
    const seen = new Set<string>()
    const collect = async (name: string): Promise<Redactor[]> => {
      if (seen.has(name)) return []
      seen.add(name)
      let entry: Awaited<ReturnType<typeof loadProfile>>
      try {
        entry = await loadProfile(name)
      } catch {
        // A step naming a profile that will not load is the run's problem to report, with
        // the context to report it well. Choosing a redactor is not the place to fail over
        // it — and the safe reading of "I cannot see this profile" is "I have no hook from
        // it", which is what returning nothing here means.
        return []
      }
      let pack: Pack | undefined
      try {
        pack = await loadPackForProfile(name, entry.profile, entry.config)
      } catch {
        pack = undefined
      }
      const own = redactor(entry.profile, pack)
      const hooks = own ? [own] : []
      const steps = Array.isArray(entry.config.steps) ? (entry.config.steps as Array<Record<string, unknown>>) : []
      for (const step of steps) {
        const stepName = String(step?.profile ?? '')
        if (stepName) hooks.push(...(await collect(stepName)))
      }
      return hooks
    }
    return composeRedactors(...(await collect(profileName)))
  }

  const openRunTrace =
    options.openRunTrace ??
    (async (profileName: string, runId: string): Promise<Trace> =>
      serverTrace ? openTrace(profileName, await runRedactor(profileName), runId) : nullTrace())

  /**
   * Runs currently in flight, so one request can stop another's work.
   *
   * A run outlives the handler that started it only in the sense that the handler is awaiting
   * it; what it does NOT outlive is this map, which is why every entry is removed in a
   * `finally`. Keyed by run id because that is the only name the caller has — it is what came
   * back on the response and what `DELETE /run/:id` is spelled with.
   */
  const inFlightRuns = new Map<string, { profile: string; cancel(by: 'disconnect' | 'request'): void }>()

  // In-memory sessions
  const sessions = new Map<string, { profile: string; baseUrl: string; session: Session }>()

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

  // Response helpers take the request's CORS headers so every response (not just the
  // routes that use `ok` directly) can carry them.
  // POST /run has mode-specific detail, but every caller gets one stable place to read the
  // produced value. Keep the existing fields as diagnostics and compatibility surface.
  const runResult = <T extends object>(result: T, output: unknown): T & { output: unknown } => ({
    ...result,
    output: output ?? null,
  })

  // SSE fan-out. A client that stops reading costs this server a bounded amount of memory
  // and nothing else; 1 MiB is thousands of events of slack before the connection is cut.
  const sseBufferBytes = options.sseBufferBytes ?? 1 << 20
  const sse = createSseHub(sseBufferBytes)

  // Idle sweep for managed llama-server backends. Runs on an unref'd timer so it never
  // keeps the process alive on its own; every backend is stopped hard on close. The 15s
  // cadence means an idle backend lingers at most one sweep past its timeout.
  let sweepTimer: ReturnType<typeof setInterval> | null = null
  if (manageModels) {
    sweepTimer = setInterval(() => {
      void manager.sweep()
    }, 15_000)
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
  }

  const activityUnsub = activity.subscribe((event) => {
    for (const res of sse.clients) sse.send(res, event)
  })

  /**
   * The shared state every route handler reads, gathered once.
   *
   * Handing over the live objects — the same manager, the same caches, the same activity bus
   * — rather than copies: a handler with its own reachability map would answer from a second
   * opinion about which backends are up.
   */
  const deps: ServerDeps = {
    cfg,
    activity,
    manager,
    provider: wrappedProvider,
    loadProfile,
    loadPackForProfile,
    declaredPacks,
    topologyForProfile,
    backendFor,
    backendUrls,
    backendReachability,
    refreshReachability,
    emitModelIdentified,
    modelIdentityCache,
    pinnedRouters,
    manageModels,
    openRunTrace,
    inFlightRuns,
    sessions,
    sse,
    readBody,
    runResult,
    inputDigest,
  }

  const server = httpCreateServer(async (req, res) => {
    const startedAt = performance.now()
    const url = new URL(req.url ?? '/', `http://localhost`)
    const method = req.method ?? 'GET'

    // CORS policy is per-request: loopback origins by default (see the helpers above).
    const cors = corsHeaders(corsAllowedOrigin(req.headers.origin))
    // `extra` exists for one fact: the run id. An error that omits it tells a dashboard
    // that something failed but not WHICH run failed, so the feed cannot be searched for
    // what led up to it. Every refusal raised after a run id is minted carries it.
    const reply = replyFor(res, cors)
    const { ok, bad, notFound, serverError, serviceUnavailable } = reply
    /**
     * This request, packaged for a handler that lives outside this closure.
     *
     * Built lazily per matched route rather than once per request: `done` is defined below,
     * after the activity span opens, and a context minted before that would carry a `done`
     * that closes nothing.
     */
    const routeCtx = (): RouteContext => ({ req, res, url, method, reply, done, deps })

    // Preflight for cross-origin PUT-ish requests (the dashboard's POSTs to /run, /session).
    // Resolved before the activity emit so the feed does not log browser noise.
    if (method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }

    activity.emit({ kind: 'http.request', method, path: url.pathname })

    const done = (status: number) => {
      activity.emit({ kind: 'http.completed', method, path: url.pathname, status, wallMs: performance.now() - startedAt })
    }

    try {
      if (method === 'GET' && url.pathname === '/health') return void (await health(routeCtx()))
      if (method === 'GET' && url.pathname === '/corpus') return void (await corpusList(routeCtx()))
      if (method === 'GET' && url.pathname.startsWith('/corpus/')) return void (await corpusDocument(routeCtx()))

      if (method === 'GET' && url.pathname === '/events') return void (await events(routeCtx()))

      if (method === 'GET' && url.pathname === '/runs') return void (await runsList(routeCtx()))
      if (method === 'GET' && url.pathname.startsWith('/runs/')) return void (await runsDocument(routeCtx()))

      if (method === 'POST' && url.pathname === '/route') return void (await routeRequest(routeCtx()))

      if (method === 'POST' && (url.pathname === '/pipeline' || url.pathname === '/run')) {
        return void (await runPipeline(routeCtx()))
      }

      if (method === 'POST' && url.pathname === '/session') return void (await sessionCreate(routeCtx()))

      const sessionMatch = url.pathname.match(/^\/session\/([^/]+)\/(.+)$/)
      if (sessionMatch && method === 'POST') {
        const [, id, action] = sessionMatch
        if (!id) {
          notFound('unknown route')
          done(404)
          return
        }
        return void (await sessionAction(routeCtx(), id, action))
      }

      if (method === 'DELETE' && url.pathname.startsWith('/run/')) {
        return void (await cancelRun(routeCtx()))
      }

      if (method === 'DELETE' && url.pathname.match(/^\/session\/([^/]+)$/)) {
        return void (await sessionDelete(routeCtx()))
      }

      notFound(`unknown route ${method} ${url.pathname}`)
      done(404)
    } catch (e) {
      done(500)
      if (e instanceof ConfigError || e instanceof PackError || e instanceof ProfileError) {
        return bad(e.message)
      }
      console.error('Server error:', e)
      return serverError((e as Error).message)
    }
  })

  // Server-level cleanup
  // `close()` waits for open connections to finish, and an SSE stream never finishes on its
  // own — so a server with a dashboard attached would never close, and the cleanup below
  // (which clears the heartbeat and stops managed backends) would never run. Ending the
  // feeds is part of closing: each client reconnects if the server comes back.
  const nativeClose = server.close.bind(server)
  server.close = ((cb?: (err?: Error) => void) => {
    for (const res of [...sse.clients]) sse.drop(res)
    return nativeClose(cb)
  }) as typeof server.close

  server.on('close', () => {
    activityUnsub()
    sse.shutdown()
    if (sweepTimer) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
    void manager.dispose()
  })

  activity.emit({ kind: 'server.ready' })

  // Startup model availability check. The dashboard and the CLI share "server is up" with
  // "the model is up" nowhere in the middle, so a server that starts before llama.cpp is
  // indistinguishable from a healthy one. Probe once here, say plainly what is reachable,
  // and let the /run pre-flight and /health `models` carry the same facts onward.
  if (manageModels) {
    console.log(
      budgetBytes > 0
        ? `model budget: ${fmtBytes(budgetBytes)} resident at once — a model that does not fit evicts the least recently used one (ALKOR_MODEL_BUDGET)`
        : 'model budget: unbounded — every backend a run needs is started and kept (ALKOR_MODEL_BUDGET=0)',
    )
  }
  await Promise.allSettled([...backendUrls.map((url) => emitModelIdentified(url)), refreshReachability()])
  for (const url of backendUrls) {
    const up = backendReachability.get(url) ?? false
    const id = modelIdentityCache.get(url)
    if (up && id?.identified) {
      console.log(`model backend ${url}: reachable, serving ${id.model}`)
    } else if (up) {
      console.log(`model backend ${url}: REACHABLE but no model identified — is a model loaded?`)
    } else if (manager.status(url).managed) {
      const status = manager.status(url)
      // An idle/down backend the manager can spawn: DORMANT, not broken. It stays off the
      // RAM until the first run that needs it. A pinned one is the front door and stays
      // resident once a prompt has brought it up.
      if (status.pinned) {
        console.log(
          `model backend ${url}: pinned — the front-door model, spawns at the first prompt and stays resident`,
        )
      } else {
        console.log(`model backend ${url}: dormant — will spawn on demand (${status.state})`)
      }
    } else {
      console.error(
        `model backend ${url}: NOT REACHABLE — start llama-server on ${url} before sending prompts (scripts/llama-server.sh)`,
      )
    }
  }

  return server
}

if (isMain) {
  const port = Number(process.env.PORT || 3000)
  const server = await createServer()
  server.listen(port, '127.0.0.1', () => {
    console.log(`alkor server listening on http://127.0.0.1:${port}`)
  })
}
