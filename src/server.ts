#!/usr/bin/env node
/**
 * medextract server: HTTP entry point for the harness.
 *
 * Receives prompts and routes them internally using the same modes the CLI uses.
 * Profiles, packs, and config are read from profiles.toml exactly as the CLI does.
 *
 * Endpoints:
 *   GET  /health                    — list loaded profiles, active sessions, and activity stats
 *   GET  /events                    — SSE stream of activity events (metadata-only)
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
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { statSync } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { loadConfig, requireProfile, ConfigError, callsModel } from './core/config.ts'
import { loadPack, resolvePackRoot, PackError } from './core/pack.ts'
import { listCorpus, readCorpusDocument, CorpusError } from './core/corpus.ts'
import { loadProfileModule, resolveProfileModule, ProfileError } from './core/profile.ts'
import { nullTrace } from './core/trace.ts'
import { route, type RouteResult, type RouteRule, type RouterOptions } from './modes/router.ts'
import { runAgent } from './modes/agentic.ts'
import { createSession, type Session, type TurnResult } from './modes/session.ts'
import { runWorkflow, buildWorkflow } from './modes/workflow.ts'
import { defaultProvider } from './core/client.ts'
import { createActivity, withActivity, withActivityScope, LLM_CALL_STAGE, ACTIVITY_INSTANCE_HEADER, type Activity, type ActivityEvent } from './core/activity.ts'
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

/**
 * CORS is loopback-only by default. A browser dashboard is cross-origin by definition
 * (`localhost:5173` vs `127.0.0.1:3000`), but opening the feed to every website would let
 * any page you visit read it. Only loopback origins are accepted unless MEDEXTRACT_CORS
 * names others, or is `*` for an explicit blanket.
 */
const corsAllowedOrigin = (rawOrigin: string | undefined): string | undefined => {
  if (!rawOrigin) return undefined
  const configured = (process.env.MEDEXTRACT_CORS ?? '')
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

const corsHeaders = (origin: string | undefined): Record<string, string> => {
  if (!origin) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': `Content-Type, Accept, Last-Event-ID, ${ACTIVITY_INSTANCE_HEADER}`,
    'Access-Control-Max-Age': '86400',
  }
}

export interface ServerOptions {
  /** Process seams used by server tests; production uses the real llama-server lifecycle. */
  llamaManager?: Pick<LlamaManagerOptions, 'binary' | 'pollMs' | 'probe' | 'spawn' | 'startTimeoutMs'>
  /** Per-SSE-client queue cap; a test shrinks it to reach the overflow path deliberately. */
  sseBufferBytes?: number
  /** Resident-model budget in bytes; overrides MEDEXTRACT_MODEL_BUDGET. 0 is unbounded. */
  budgetBytes?: number
}

/** The bounded-buffer part of an SSE response: what a fan-out may still use it for. */
export type SseWriteVerdict = 'ok' | 'gone' | 'overflow'

/**
 * One write to one SSE client, with the two facts a fan-out must respect.
 *
 * A write to a response that has already gone away fails on a LATER tick, as an 'error'
 * event rather than a throw, so the state is checked before writing instead of wrapped in a
 * `try`. And an unread response queues in this process: past the cap the caller ends it, and
 * the client recovers through the same reconnect-and-replay path as any dropped connection.
 * Kept separate from the server closure so the overflow branch can be tested without
 * arranging a megabyte of real backpressure.
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

/**
 * How many bytes of model this host will hold resident at once.
 *
 * `MEDEXTRACT_MODEL_BUDGET` takes `6GiB`, `600MB`, a percentage of total RAM (`50%`), a
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
  // MEDEXTRACT_MANAGE_MODELS=0 restores "start them yourself"; MEDEXTRACT_LLAMA_ARGS and
  // MEDEXTRACT_IDLE_MS tune the spawn flags and the idle window.
  const manageModels = (process.env.MEDEXTRACT_MANAGE_MODELS ?? '1') !== '0'
  const idleMs = Number(process.env.MEDEXTRACT_IDLE_MS ?? 120_000) || 120_000
  const spawnArgs = (process.env.MEDEXTRACT_LLAMA_ARGS ?? '--no-webui --parallel 1')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const budgetBytes = options.budgetBytes ?? modelBudgetBytes(process.env.MEDEXTRACT_MODEL_BUDGET)
  const manager = new LlamaManager({
    idleMs,
    spawnArgs,
    enabled: manageModels,
    budgetBytes,
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
  const json = (res: ServerResponse, status: number, data: unknown, cors: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...cors })
    res.end(JSON.stringify(data, null, 2))
  }

  // POST /run has mode-specific detail, but every caller gets one stable place to read the
  // produced value. Keep the existing fields as diagnostics and compatibility surface.
  const runResult = <T extends object>(result: T, output: unknown): T & { output: unknown } => ({
    ...result,
    output: output ?? null,
  })

  // SSE helpers. A client that stops reading costs this server a bounded amount of memory
  // and nothing else; 1 MiB is thousands of events of slack before the connection is cut.
  const sseBufferBytes = options.sseBufferBytes ?? 1 << 20
  const sseClients = new Set<ServerResponse>()
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

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

  const dropClient = (res: ServerResponse) => {
    sseClients.delete(res)
    if (!res.writableEnded) res.end()
  }

  /** One write to one SSE client, acting on the verdict from `sseWrite`. */
  const writeToClient = (res: ServerResponse, payload: string) => {
    const verdict = sseWrite(res, payload, sseBufferBytes)
    if (verdict === 'gone') sseClients.delete(res)
    else if (verdict === 'overflow') dropClient(res)
  }

  const startHeartbeat = () => {
    if (heartbeatTimer) return
    heartbeatTimer = setInterval(() => {
      for (const res of sseClients) {
        writeToClient(res, ': ping\n\n')
      }
    }, 15_000)
    // Unref'd like the idle sweep: a heartbeat must never be the reason the process lives.
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
  }

  const sendEvent = (res: ServerResponse, event: ActivityEvent) => {
    writeToClient(res, `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)
  }

  const activityUnsub = activity.subscribe((event) => {
    for (const res of sseClients) {
      sendEvent(res, event)
    }
  })

  const server = httpCreateServer(async (req, res) => {
    const startedAt = performance.now()
    const url = new URL(req.url ?? '/', `http://localhost`)
    const method = req.method ?? 'GET'

    // CORS policy is per-request: loopback origins by default (see the helpers above).
    const cors = corsHeaders(corsAllowedOrigin(req.headers.origin))
    // `extra` exists for one fact: the run id. An error that omits it tells a dashboard
    // that something failed but not WHICH run failed, so the feed cannot be searched for
    // what led up to it. Every refusal raised after a run id is minted carries it.
    type ErrorExtra = Record<string, unknown> | undefined
    const ok = (res: ServerResponse, data: unknown) => json(res, 200, data, cors)
    const bad = (res: ServerResponse, message: string, extra?: ErrorExtra) => json(res, 400, { error: message, ...extra }, cors)
    const notFound = (res: ServerResponse, message: string) => json(res, 404, { error: message }, cors)
    const serverError = (res: ServerResponse, message: string, extra?: ErrorExtra) => json(res, 500, { error: message, ...extra }, cors)
    const serviceUnavailable = (res: ServerResponse, message: string, extra?: ErrorExtra) => json(res, 503, { error: message, ...extra }, cors)

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
      // --- Health --------------------------------------------------------------
      if (method === 'GET' && url.pathname === '/health') {
        await refreshReachability()
        const topologyProfiles = await Promise.all(
          Object.values(cfg.profiles).map(async ({ name, mode, url, pack, pinned }) => ({
            name,
            mode,
            url,
            pack,
            pinned: Boolean(pinned),
            topology: await topologyForProfile(name, mode),
          })),
        )
        ok(res, {
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
          models: backendUrls.map((baseUrl) => {
            const id = modelIdentityCache.get(baseUrl)
            const status = manager.status(baseUrl)
            return {
              baseUrl,
              reachable: backendReachability.get(baseUrl) ?? false,
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
            subscribers: sseClients.size,
            // The stream identity stamped on every event: a poller that sees it change knows
            // the seq space restarted, without waiting for an event to prove it.
            instance: activity.instanceId,
          },
        })
        done(200)
        return
      }

      // --- Corpus --------------------------------------------------------------
      // The notes and transcripts the packs grade against, offered as input rather than as
      // measurement. The dashboard loads one into its run box so an operator drives the
      // harness with the same bytes the eval reads. Reads here never touch a pack's
      // opened-file set, so browsing cannot write itself into a later run's digest.
      if (method === 'GET' && url.pathname === '/corpus') {
        const documents = listCorpus(declaredPacks())
        ok(res, {
          documents,
          // Stated rather than counted by the client: a reader deciding whether to paste
          // one of these into a clinical tool should be told what they are, next to them.
          synthetic: true,
          note: 'Synthetic source documents from the contract packs. No patient data.',
        })
        done(200)
        return
      }

      if (method === 'GET' && url.pathname.startsWith('/corpus/')) {
        const id = decodeURIComponent(url.pathname.slice('/corpus/'.length))
        try {
          const { document, text } = readCorpusDocument(declaredPacks(), id)
          ok(res, { ...document, text })
          done(200)
        } catch (e) {
          if (!(e instanceof CorpusError)) throw e
          notFound(res, (e as Error).message)
          done(404)
        }
        return
      }

      // --- Events (SSE) --------------------------------------------------------
      if (method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...cors,
        })
        // A write to a vanished client surfaces as an async 'error' on the response; with
        // no listener that is an uncaught exception taking the server down mid-fan-out.
        res.on('error', () => dropClient(res))
        res.write(':ok\n\n')

        // Replay: resume from Last-Event-ID only when the seq it names was issued by THIS
        // process. A restarted server counts from 1 again, so a stale watermark would skip
        // the whole buffer — including the profile and model facts a dashboard renders from.
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
          if (event.seq > startSeq) sendEvent(res, event)
        }

        sseClients.add(res)
        startHeartbeat()

        req.on('close', () => {
          sseClients.delete(res)
          if (sseClients.size === 0 && heartbeatTimer) {
            clearInterval(heartbeatTimer)
            heartbeatTimer = null
          }
          // The envelope closes when the STREAM does. Reporting it at open told the feed a
          // connection held for hours had completed in two milliseconds.
          done(200)
        })

        // Keep the response open.
        return
      }

      // --- Route ---------------------------------------------------------------
      if (method === 'POST' && url.pathname === '/route') {
        const body = (await readBody(req)) as Record<string, unknown> | undefined
        const input = String(body?.input ?? '')
        if (!input) {
          bad(res, 'input is required')
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
        const pinned = pinnedRouters[0]
        if (!rules && !explicitModel && pinned) {
          const { profile, config: profileConfig } = await loadProfile(pinned.name)
          const routerUrl = profileConfig.url ? backendFor(profileConfig.url) : undefined

          // No URL means this router is intentionally rules-only. A configured URL opts
          // the router into model fallback and therefore into managed-backend preflight.
          if (routerUrl) {
            const ready = await manager.ensure(routerUrl)
            if (!ready) {
              backendReachability.set(routerUrl, false)
              serviceUnavailable(
                res,
                `no model backend is reachable at ${routerUrl} — ${manager.describe(routerUrl)}. ` +
                  'Start llama-server on it first (scripts/llama-server.sh), or check MEDEXTRACT_MANAGE_MODELS.',
              )
              done(503)
              return
            }
            backendReachability.set(routerUrl, true)
            await emitModelIdentified(routerUrl)
          }

          if (!profile.review) {
            serverError(res, `pinned router profile '${pinned.name}' exposes no review (mode ${profile.mode})`)
            done(500)
            return
          }
          const review = await profile.review({
            pack: undefined,
            baseUrl: routerUrl,
            trace: nullTrace(),
            input: { kind: 'text', text: input, label: 'server-input' },
            options: {},
            provider: wrappedProvider,
            activity,
          })
          if (!review.report || typeof review.report !== 'object') {
            serverError(res, `pinned router profile '${pinned.name}' produced no route report`)
            done(500)
            return
          }
          result = review.report as RouteResult
        } else {
          result = await route({ input, rules, defaultProfile, model: explicitModel })
        }
        activity.emit({
          kind: 'route.decided',
          profile: result.profile,
          confidence: result.confidence,
          reason: result.reason,
          ruleVsModel: result.reason.startsWith('model:') ? 'model' : 'rule',
        })
        ok(res, result)
        done(200)
        return
      }

      // --- Run the product pipeline or one profile directly --------------------
      if (method === 'POST' && (url.pathname === '/pipeline' || url.pathname === '/run')) {
        const body = (await readBody(req)) as Record<string, unknown> | undefined
        const input = String(body?.input ?? '')
        const automatic = url.pathname === '/pipeline'
        let profileName = String(body?.profile ?? '')
        let pipelineRoute: RouteResult | undefined
        if (!automatic && !profileName) {
          bad(res, 'profile is required')
          done(400)
          return
        }
        if (!input) {
          bad(res, 'input is required')
          done(400)
          return
        }

        const runId = randomUUID()
        if (automatic) {
          if (!cfg.pipeline) {
            bad(res, 'no product pipeline is configured', { runId })
            done(400)
            return
          }
          const forcedWorkflow = typeof body?.workflow === 'string' ? body.workflow : undefined
          if (forcedWorkflow) {
            if (!cfg.pipeline.workflows.includes(forcedWorkflow)) {
              bad(res, `workflow '${forcedWorkflow}' is not in the pipeline catalogue`, { runId })
              done(400)
              return
            }
            pipelineRoute = { profile: forcedWorkflow, confidence: 1, reason: 'manual workflow override' }
          } else {
            const router = await loadProfile(cfg.pipeline.router)
            if (!router.profile.review) {
              serverError(res, `pipeline router '${cfg.pipeline.router}' exposes no review`, { runId })
              done(500)
              return
            }
            // A workflow router without a URL is deliberately rules-only. Supplying a URL
            // opts it into the same model fallback lifecycle as any other router profile.
            const routerUrl = router.config.url ? backendFor(router.config.url as string) : undefined
            if (routerUrl) {
              const ready = await manager.ensure(routerUrl)
              backendReachability.set(routerUrl, ready)
              if (!ready) {
                serviceUnavailable(
                  res,
                  `no model backend is reachable at ${routerUrl} — ${manager.describe(routerUrl)}. ` +
                    'Start llama-server on it first (scripts/llama-server.sh), or check MEDEXTRACT_MANAGE_MODELS.',
                  { runId },
                )
                done(503)
                return
              }
              await emitModelIdentified(routerUrl)
            }
            const review = await withActivityScope({ runId }, () => router.profile.review!({
              pack: undefined,
              baseUrl: routerUrl,
              trace: nullTrace(),
              input: { kind: 'text', text: input, label: 'pipeline-input' },
              options: {},
              provider: wrappedProvider,
              activity,
            }))
            if (!review.report || typeof review.report !== 'object') {
              serverError(res, `pipeline router '${cfg.pipeline.router}' produced no workflow route`, { runId })
              done(500)
              return
            }
            pipelineRoute = review.report as RouteResult
          }
          if (!cfg.pipeline.workflows.includes(pipelineRoute.profile)) {
            serverError(res, `pipeline router selected workflow '${pipelineRoute.profile}' outside its catalogue`, { runId })
            done(500)
            return
          }
          profileName = pipelineRoute.profile
          activity.emit({
            kind: 'route.decided',
            runId,
            profile: profileName,
            confidence: pipelineRoute.confidence,
            reason: pipelineRoute.reason,
            ruleVsModel: pipelineRoute.reason.startsWith('model:') ? 'model' : 'rule',
          })
        }

        const { profile, config: profileConfig } = await loadProfile(profileName)
        const pack = await loadPackForProfile(profileName, profile, profileConfig)
        const baseUrl = profileConfig.url ? backendFor(profileConfig.url as string) : undefined
        const options = (body?.options ?? {}) as Record<string, unknown>
        // `runId` is on the response for the same reason it is on every event this run
        // emits: it is the only key that ties the answer a caller holds to the feed that
        // explains how it was produced. A dashboard uses it to assemble the run's log.
        const respond = <T extends object>(result: T, output: unknown) => ok(
          res,
          automatic
            ? { ...runResult(result, output), runId, workflow: profileName, route: pipelineRoute }
            : { ...runResult(result, output), runId },
        )

        // A run that would need a model can see the check coming: a backend that can never
        // answer the FIRST step would fail with a buried "cannot reach server" message and
        // the dashboard would read as "nothing happened". Refuse loudly instead. A router
        // run is rules-only and a workflow whose every step is a router runs on rules too,
        // so those keep working with no model at all. A backend the manager can spawn is
        // brought up here rather than refused.
        const neededBackends = new Set<string>()
        const hasSteps = Array.isArray(profileConfig.steps) && profileConfig.steps.length > 0
        const needsModel = await (async (): Promise<boolean> => {
          const profileUrl = backendFor(baseUrl)
          if (profile.mode === 'extract' || profile.mode === 'agentic') {
            neededBackends.add(profileUrl)
            return true
          }
          if (profile.mode !== 'workflow' || !hasSteps) return false
          for (const step of profileConfig.steps as Array<Record<string, unknown>>) {
            const stepName = String(step?.profile ?? '')
            if (!stepName) continue
            // Router steps run on compiled rules; only a step that might call a model
            // obligates a usable backend. Configs are cached, so this costs nothing.
            const stepEntry = await loadProfile(stepName)
            if (callsModel(stepEntry.config.mode)) {
              neededBackends.add(backendFor(stepEntry.config.url as string | undefined))
            }
          }
          return neededBackends.size > 0
        })()
        // A workflow's models are loaded ONE AT A TIME, at the step that needs each.
        //
        // Preflight used to start every step's backend before step 0 and hold them all for
        // the run. That is the wrong shape for the machine this product targets: a two-model
        // workflow then peaks at both sets of weights plus both KV caches, and the loads race
        // each other on the way up. Nothing about the recipe requires it — step 2 cannot run
        // until step 1 has finished, so its model is dead weight until then. `ensureBackend`
        // below brings each up at its turn, and a backend the budget needs room for is
        // evicted between steps rather than kept beside its successor.
        //
        // What preflight was RIGHT about is failing before the prompt is consumed, so that
        // survives as a check on the configuration rather than on the memory: a backend that
        // is neither reachable nor spawnable can never answer, and that is knowable now.
        const ensureOrExplain = async (needed: string): Promise<string | null> => {
          const ready = await manager.ensure(needed)
          backendReachability.set(needed, ready)
          return ready
            ? null
            : `no model backend is reachable at ${needed} — ${manager.describe(needed)}. ` +
              'Start llama-server on it first (scripts/llama-server.sh), or check MEDEXTRACT_MANAGE_MODELS.'
        }
        if (needsModel) {
          const isWorkflow = profile.mode === 'workflow' && hasSteps
          const unusable: string[] = []
          for (const needed of neededBackends) {
            // A single-profile run needs its one model now, so start it now — deferring it
            // would only move the same load a few lines later.
            if (!isWorkflow) {
              const problem = await ensureOrExplain(needed)
              if (problem) unusable.push(problem)
              continue
            }
            if (manager.canSpawn(needed)) continue
            const reachable = await probeServer(needed)
            backendReachability.set(needed, reachable)
            if (!reachable) {
              unusable.push(
                `no model backend is reachable at ${needed} — ${manager.describe(needed)}. ` +
                  'Start llama-server on it first (scripts/llama-server.sh), or check MEDEXTRACT_MANAGE_MODELS.',
              )
            }
          }
          if (unusable[0]) {
            serviceUnavailable(res, unusable[0], { runId })
            done(503)
            return
          }
        }

        await emitModelIdentified(baseUrl)

        return withActivityScope({ runId }, async () => {
          activity.emit({
            kind: 'run.started',
            profile: profileName,
            inputChars: input.length,
            inputDigest: inputDigest(input),
          })

          const runStartedAt = performance.now()

          try {
            // Extract / router / code — one review call, three declared shapes.
            if (profile.mode === 'extract' || profile.mode === 'router' || profile.mode === 'code') {
              if (!profile.review) {
                serverError(res, `profile '${profileName}' has no review implementation`, { runId })
                done(500)
                return
              }
              const result = await profile.review({
                pack,
                baseUrl,
                trace: nullTrace(),
                input: { kind: 'text', text: input, label: 'server-input' },
                options,
                provider: wrappedProvider,
                activity,
              })
              activity.emit({
                kind: 'run.completed',
                profile: profileName,
                wallMs: performance.now() - runStartedAt,
              })
              respond(result, result.report ?? result.raw ?? result.text)
              done(200)
              return
            }

            // Agentic
            if (profile.mode === 'agentic') {
              if (!profile.tools) {
                serverError(res, `profile '${profileName}' declares no tools`, { runId })
                done(500)
                return
              }
              const result = await runAgent({
                systemPrompt: profile.systemPrompt ?? '',
                task: input,
                workspace: String(options.workspace ?? '/tmp'),
                tools: profile.tools,
                maxIterations: Number(options.iterations ?? profile.maxIterations ?? 12),
                baseUrl,
                trace: nullTrace(),
                provider: wrappedProvider,
                activity,
              })
              activity.emit({
                kind: 'run.completed',
                profile: profileName,
                wallMs: performance.now() - runStartedAt,
              })
              respond(result, result.answer ?? result.error ?? result)
              done(200)
              return
            }

            // Workflow
            if (profile.mode === 'workflow') {
              const steps = profileConfig.steps as Array<Record<string, unknown>> | undefined
              if (!steps || !Array.isArray(steps)) {
                serverError(res, `profile '${profileName}' has no 'steps' array in its config`, { runId })
                done(500)
                return
              }

              const workflowSteps = buildWorkflow(
                steps.map((s) => ({
                  name: String(s.name ?? 'unnamed'),
                  profile: String(s.profile ?? ''),
                  input: s.input as string | Record<string, string> | undefined,
                  field: s.field as string | undefined,
                  options: s.options as Record<string, unknown> | undefined,
                  final: s.final === true,
                })),
              )

              const profiles = new Map<string, ProfileModule>()
              const packs = new Map<string, Pack | undefined>()
              const baseUrls = new Map<string, string | undefined>()

              for (const step of workflowSteps) {
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

              // Each step's model comes up at that step, and no sooner. No reservation is
              // needed to protect a later backend from the idle sweep any more, because a
              // later backend is not running yet: the thing the reservation defended
              // against — a long step 1 letting step 2's model be reclaimed out from under
              // it — cannot happen to a model that has not been loaded.
              const result = await runWorkflow({
                initialInput: input,
                steps: workflowSteps,
                profiles,
                packs,
                baseUrls,
                trace: nullTrace(),
                contextDir: options.contextDir as string | undefined,
                runStep: options.step !== undefined ? Number(options.step) : undefined,
                provider: wrappedProvider,
                activity,
                ensureBackend: async (stepBaseUrl) => ensureOrExplain(backendFor(stepBaseUrl)),
              })
              activity.emit({
                kind: 'run.completed',
                profile: profileName,
                wallMs: performance.now() - runStartedAt,
              })
              // The run's ending, named rather than left for a client to sniff out of the
              // step list. A workflow with a terminal step has written the one part of the
              // response meant for a person to read, and a client should not have to guess
              // which step that was — nor fall back to shape-matching a report.
              const terminalIndex = workflowSteps.findIndex((step) => step.final)
              const ending = terminalIndex === -1
                ? undefined
                : result.steps.find((step) => step.step === terminalIndex)?.text
              respond({ ...result, ending }, result.final)
              done(200)
              return
            }

            serverError(res, `mode '${profile.mode}' is not supported by the server`, { runId })
            done(500)
          } catch (e) {
            activity.emit({
              kind: 'run.failed',
              profile: profileName,
              wallMs: performance.now() - runStartedAt,
              error: (e as Error).message,
            })
            // Answered here rather than rethrown to the generic handler: that handler knows
            // the request but not the run, so its response could not name the run id the
            // caller needs to read the feed. The console line is kept for the operator.
            console.error(`Run ${runId} (${profileName}) failed:`, e)
            const status = e instanceof ConfigError || e instanceof PackError || e instanceof ProfileError ? 400 : 500
            json(res, status, { error: (e as Error).message, runId, profile: profileName }, cors)
            done(status)
            return
          }
        })
      }

      // --- Create session ------------------------------------------------------
      if (method === 'POST' && url.pathname === '/session') {
        const body = (await readBody(req)) as Record<string, unknown> | undefined
        const profileName = String(body?.profile ?? '')
        if (!profileName) {
          bad(res, 'profile is required')
          done(400)
          return
        }

        const { profile, config: profileConfig } = await loadProfile(profileName)
        const baseUrl = profileConfig.url ? backendFor(profileConfig.url as string) : undefined

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
          provider: wrappedProvider,
        })

        const id = randomUUID()
        const effectiveBaseUrl = backendFor(baseUrl)
        // Session creation carries no user prompt, so it must not wake a dormant model.
        // Retaining the URL here lets the first (and every post-idle) send wait for it.
        sessions.set(id, { profile: profileName, baseUrl: effectiveBaseUrl, session })
        activity.emit({ kind: 'session.created', sessionId: id, profile: profileName })
        ok(res, { id, profile: profileName })
        done(200)
        return
      }

      // --- Session operations --------------------------------------------------
      const sessionMatch = url.pathname.match(/^\/session\/([^/]+)\/(.+)$/)
      if (sessionMatch && method === 'POST') {
        const [, id, action] = sessionMatch
        if (!id) {
          notFound(res, 'unknown route')
          done(404)
          return
        }
        const entry = sessions.get(id)
        if (!entry) {
          notFound(res, `session '${id}' not found`)
          done(404)
          return
        }

        const body = (await readBody(req)) as Record<string, unknown> | undefined

        if (action === 'send') {
          const text = String(body?.text ?? '')
          if (!text) {
            bad(res, 'text is required')
            done(400)
            return
          }

          // `text` is now owned by this request and remains in memory while a dormant
          // llama-server starts. Concurrent sends share LlamaManager.ensure's one startup
          // promise; no prompt reaches the transport until the readiness probe succeeds.
          const ready = await manager.ensure(entry.baseUrl)
          backendReachability.set(entry.baseUrl, ready)
          if (!ready) {
            serviceUnavailable(
              res,
              `no model backend is reachable at ${entry.baseUrl} — ${manager.describe(entry.baseUrl)}. ` +
                'Start llama-server on it first (scripts/llama-server.sh), or check MEDEXTRACT_MANAGE_MODELS.',
            )
            done(503)
            return
          }
          await emitModelIdentified(entry.baseUrl)

          const controller = new AbortController()
          res.on('close', () => {
            if (!res.writableFinished) controller.abort()
          })

          const turn = entry.session.messages.filter((m: any) => m?.role === 'user').length + 1

          return withActivityScope({ sessionId: id }, async () => {
            activity.emit({ kind: 'turn.started', sessionId: id, turn })

            const turnStart = performance.now()
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
            ok(res, result)
            done(200)
          })
        }

        if (action === 'reset') {
          entry.session.reset()
          ok(res, { ok: true })
          done(200)
          return
        }

        if (action === 'load') {
          const messages = body?.messages as unknown[] | undefined
          if (!messages || !Array.isArray(messages)) {
            bad(res, 'messages array is required')
            done(400)
            return
          }
          entry.session.load(messages)
          ok(res, { ok: true })
          done(200)
          return
        }

        notFound(res, `unknown session action '${action}'`)
        done(404)
        return
      }

      if (method === 'DELETE' && url.pathname.match(/^\/session\/([^/]+)$/)) {
        const match = url.pathname.match(/^\/session\/([^/]+)$/)
        const id = match?.[1]
        if (!id || !sessions.has(id)) {
          notFound(res, `session '${id}' not found`)
          done(404)
          return
        }
        sessions.delete(id)
        activity.emit({ kind: 'session.destroyed', sessionId: id })
        ok(res, { ok: true })
        done(200)
        return
      }

      notFound(res, `unknown route ${method} ${url.pathname}`)
      done(404)
    } catch (e) {
      done(500)
      if (e instanceof ConfigError || e instanceof PackError || e instanceof ProfileError) {
        return bad(res, e.message)
      }
      console.error('Server error:', e)
      return serverError(res, (e as Error).message)
    }
  })

  // Server-level cleanup
  // `close()` waits for open connections to finish, and an SSE stream never finishes on its
  // own — so a server with a dashboard attached would never close, and the cleanup below
  // (which clears the heartbeat and stops managed backends) would never run. Ending the
  // feeds is part of closing: each client reconnects if the server comes back.
  const nativeClose = server.close.bind(server)
  server.close = ((cb?: (err?: Error) => void) => {
    for (const res of [...sseClients]) dropClient(res)
    return nativeClose(cb)
  }) as typeof server.close

  server.on('close', () => {
    activityUnsub()
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
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
        ? `model budget: ${fmtBytes(budgetBytes)} resident at once — a model that does not fit evicts the least recently used one (MEDEXTRACT_MODEL_BUDGET)`
        : 'model budget: unbounded — every backend a run needs is started and kept (MEDEXTRACT_MODEL_BUDGET=0)',
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
    console.log(`medextract server listening on http://127.0.0.1:${port}`)
  })
}
