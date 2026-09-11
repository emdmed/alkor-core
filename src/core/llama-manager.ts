/**
 * On-demand llama-server lifecycle: spawn a backend when a run needs it, stop it when it
 * has sat idle, so an interactive host keeps only the models it is actively using in RAM.
 *
 * THE BUDGET. This product is meant to run on a laptop, where the binding constraint is not
 * whether a model can be started but how many can be resident at once: two 4B models at
 * ctx 32768 are the weights twice over plus two KV caches, and a machine that cannot hold
 * them does not fail cleanly — it swaps, and every model on it becomes unusably slow. So a
 * start is an ADMISSION: the manager holds an estimated footprint per backend, and a model
 * that does not fit beside what is already resident evicts the least-recently-used idle
 * backend until it does. Starts are serialized for the same reason — two models loading
 * concurrently peak at the sum of both, which is exactly the moment a small host dies.
 *
 * The estimate is advisory and known to be rough (llama.cpp mmaps its weights, so the
 * kernel can reclaim pages the accounting still counts). It is a budget, not a measurement:
 * its job is to keep the resident SET small, and being approximately right is enough for
 * that. A model that exceeds the whole budget by itself still runs when nothing else is
 * resident — refusing would make a small machine unable to do the one thing it can do,
 * which is run one model at a time.
 *
 * This is for INTERACTIVE hosts only. The eval path never imports this module — a server's
 * flags are part of a measurement and outlive many runs, which is why `profiles.toml` still
 * says the harness will not start one for you. The same rule makes this manager NOT spawn at
 * server startup: a model loads only at the first run that needs it, and is released back
 * to the OS after the idle timeout. The one exception is pinning: a `pinned` backend is
 * spawned on demand like any other, but the sweep never takes it down, which is how a
 * deployment keeps a single resident front-door model beside a set of on-demand specialists.
 *
 * The spawn seam is injectable so the readiness/stop logic is unit-tested without a real
 * llama-server, and `probeServer` — a checked status, not a model check — is the readiness
 * signal: llama-server answers /health as soon as it binds the port, while the weights are
 * still loading, so a poll is honest without guessing at progress.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { probeServer } from './client.ts'
import type { Provider } from './client.ts'

export type BackendState = 'stopped' | 'starting' | 'running' | 'failed'

export interface ManagedSpec {
  baseUrl: string
  /** .gguf path (profiles.toml `model`). Absent means the backend cannot be spawned. */
  model?: string
  ctx?: number
  /**
   * The front-door backend. Pinned backends load on demand like any other, but are exempt
   * from the idle sweep: once a prompt has brought one up it stays resident until the host
   * shuts down. A deployment with several specialist models keeps its single classifier
   * resident and lets the specialists it names start and stop around it.
   */
  pinned?: boolean
  /**
   * What this backend is expected to cost while resident, in bytes: the weights plus the
   * KV cache its `ctx` implies. The host computes it (it is the only side that can stat a
   * .gguf and read a profile's override); the manager only compares it against the budget.
   * Absent means "unknown", which is admitted as zero — an unmeasured backend never blocks
   * another, because guessing high would refuse work over a number nobody supplied.
   */
  footprintBytes?: number
}

/** The bits of a child process the manager touches, so a test can fake them. */
export interface SpawnResult {
  pid: number
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  kill(signal?: NodeJS.Signals): boolean
  /** Bounded tails of the child's output, quoted in the failure message. */
  stdout(): string
  stderr(): string
}

export type SpawnFn = (command: string, args: string[]) => SpawnResult

/** Lifecycle facts surfaced on the activity feed by the host, kept event-shaped here. */
export interface ManagedEventInput {
  baseUrl: string
  state: 'starting' | 'ready' | 'stopped' | 'failed'
  pid?: number
  model?: string
  /** `evicted` is a stop made to admit another model, not one the idle clock asked for. */
  reason?: 'idle' | 'shutdown' | 'evicted'
  error?: string
  wallMs?: number
  /** The accounted footprint of this backend, so the feed can show what a stop freed. */
  footprintBytes?: number
}

export interface LlamaManagerOptions {
  /** Stop a running backend once it has been unused this long. */
  idleMs: number
  /** Extra spawn-time flags (defaults come from the host, e.g. `--no-webui --parallel 1`). */
  spawnArgs: string[]
  binary?: string
  /** How long `start` waits for the port to answer before giving up. */
  startTimeoutMs?: number
  /** Poll interval while waiting for readiness. */
  pollMs?: number
  enabled?: boolean
  /**
   * How many bytes of model may be resident at once. Zero or undefined is unbounded, which
   * is the old behaviour: start whatever is asked for and let the host cope.
   */
  budgetBytes?: number
  spawn?: SpawnFn
  probe?: typeof probeServer
  emit?: (e: ManagedEventInput) => void
}

interface Entry {
  spec: ManagedSpec
  state: BackendState
  pid?: number
  startedAt: number
  lastUsed: number
  error?: string
  proc?: SpawnResult
  inflight?: Promise<boolean>
  /** Requests currently being served; a backend mid-generation must never be swept. */
  inFlight: number
}

const realSpawn: SpawnFn = (command, args) => {
  const child = nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout?.on('data', (c: Buffer) => (out = `${out}${c.toString()}`.slice(-4000)))
  child.stderr?.on('data', (c: Buffer) => (err = `${err}${c.toString()}`.slice(-4000)))
  return {
    pid: child.pid ?? 0,
    // A spawn that never happens — `llama-server` off PATH, a typo in the binary — reports
    // ENOENT on the 'error' event, asynchronously, and then emits no 'exit' at all. Both
    // halves matter: without this listener the EventEmitter rethrows the error as an
    // uncaught exception (the host dies on the first prompt for a dormant backend, where a
    // 503 naming the reason was the whole intent), and without resolving `exit` here the
    // start loop would wait out its full timeout for a child that does not exist. The
    // error text goes on the stderr tail because that is what the failure message quotes.
    exit: new Promise((onExit) => {
      child.once('exit', (code, signal) => onExit({ code, signal }))
      child.once('error', (e: Error) => {
        err = `${err}${e.message}\n`.slice(-4000)
        onExit({ code: null, signal: null })
      })
    }),
    kill: (signal) => child.kill(signal),
    stdout: () => out,
    stderr: () => err,
  }
}

/**
 * The key a backend is known by: one spelling per endpoint, so `http://host:8081` and
 * `http://host:8081/` are the same entry.
 *
 * Registration used to normalize and the callers did not, which made a single trailing
 * slash in `profiles.toml` silently unmanage that profile: `ensure` missed the entry and
 * refused with "no model is configured to spawn it" while one plainly was, and `track`
 * bumped nothing, so a long generation lost its guard against the idle sweep. Normalizing
 * inside the manager means every method agrees regardless of how a caller spells the URL.
 */
export const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '')

const expandTilde = (p: string): string =>
  p === '~' ? homedir() : p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(2)) : p

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Budget arithmetic is read by people deciding whether to lower `ctx`, so print it as they think of it. */
export const fmtBytes = (bytes: number): string => {
  if (bytes <= 0) return '0'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let n = bytes
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`
}

/** Call the transport with per-call bookkeeping: bump in-flight and touch on entry, return
 * the count and the idle clock on exit. A call can outlive the idle window, so a sweep
 * must not stop a backend with an open request — this is what lets a 15-minute generation
 * run to completion while a quiet 5-minute-old server still gets swept. */
export const withTouching = (
  provider: Provider,
  track: (baseUrl: string) => { acquire(): void; release(): void },
  defaultUrl: string,
): Provider => {
  const urlOf = (o: { baseUrl?: string }): string => o.baseUrl ?? process.env.LLAMA_URL ?? defaultUrl
  const wrap = <A extends { baseUrl?: string }, R>(call: (o: A) => Promise<R>): ((o: A) => Promise<R>) => {
    return async (o: A) => {
      const url = urlOf(o)
      const t = track(url)
      t.acquire()
      try {
        return await call(o)
      } finally {
        t.release()
      }
    }
  }
  return {
    chat: wrap(provider.chat),
    toolChat: wrap(provider.toolChat),
    streamChat: wrap(provider.streamChat),
    identify: (baseUrl) => provider.identify(baseUrl),
  }
}

export class LlamaManager {
  private readonly entries = new Map<string, Entry>()
  private readonly options: Required<LlamaManagerOptions>

  constructor(options: LlamaManagerOptions) {
    this.options = {
      idleMs: options.idleMs,
      spawnArgs: options.spawnArgs,
      startTimeoutMs: options.startTimeoutMs ?? 120_000,
      pollMs: options.pollMs ?? 400,
      enabled: options.enabled ?? true,
      budgetBytes: options.budgetBytes ?? 0,
      binary: options.binary ?? 'llama-server',
      spawn: options.spawn ?? realSpawn,
      probe: options.probe ?? probeServer,
      emit: options.emit ?? (() => {}),
    }
  }

  /** Record a backend the host could manage. Idempotent; latest spec wins. */
  register(spec: ManagedSpec): void {
    const now = Date.now()
    const baseUrl = normalizeBaseUrl(spec.baseUrl)
    const existing = this.entries.get(baseUrl)
    this.entries.set(baseUrl, {
      // A re-register may omit the lifecycle facts; last-known pinning survives it, so
      // the host declaring a gateway once cannot lose the property by re-invoking.
      spec: { ...spec, baseUrl, pinned: spec.pinned ?? existing?.spec.pinned },
      state: existing?.state ?? 'stopped',
      pid: existing?.pid,
      startedAt: existing?.startedAt ?? now,
      lastUsed: existing?.lastUsed ?? now,
      proc: existing?.proc,
      inFlight: existing?.inFlight ?? 0,
    })
  }

  canSpawn(baseUrl: string): boolean {
    const e = this.entries.get(normalizeBaseUrl(baseUrl))
    return Boolean(this.options.enabled && e?.spec.model)
  }

  status(baseUrl: string): {
    managed: boolean
    state: BackendState
    pinned: boolean
    footprintBytes?: number
  } {
    const e = this.entries.get(normalizeBaseUrl(baseUrl))
    if (!e) return { managed: false, state: 'stopped', pinned: false }
    return {
      managed: this.options.enabled && Boolean(e.spec.model),
      state: e.state,
      pinned: Boolean(e.spec.pinned),
      footprintBytes: e.spec.footprintBytes,
    }
  }

  /** What the budget is, and how much of it the resident set is accounted to be using. */
  resources(): { budgetBytes: number; residentBytes: number } {
    return { budgetBytes: this.options.budgetBytes, residentBytes: this.residentBytes() }
  }

  /** Feature description for the 503 message: why a backend could not come up. */
  describe(baseUrl: string): string {
    const e = this.entries.get(normalizeBaseUrl(baseUrl))
    if (e?.state === 'failed' && e.error) return e.error
    if (this.canSpawn(baseUrl)) return 'did not come up in time'
    return 'not reachable, and no model is configured to spawn it'
  }

  touch(baseUrl: string): void {
    const e = this.entries.get(normalizeBaseUrl(baseUrl))
    if (e) e.lastUsed = Date.now()
  }

  /** Bookkeeping for one in-flight transport call: guard against idle-sweep, then clock. */
  track(baseUrl: string): { acquire(): void; release(): void } {
    const key = normalizeBaseUrl(baseUrl)
    const on = () => {
      const e = this.entries.get(key)
      if (!e) return
      e.inFlight++
      e.lastUsed = Date.now()
    }
    const off = () => {
      const e = this.entries.get(key)
      if (!e) return
      e.inFlight = Math.max(0, e.inFlight - 1)
      e.lastUsed = Date.now()
    }
    return { acquire: on, release: off }
  }

  /**
   * Make the backend usable: reachable already is usable; otherwise spawn if we can.
   * Returns false when it is neither reachable nor spawnable.
   */
  async ensure(baseUrl: string): Promise<boolean> {
    const key = normalizeBaseUrl(baseUrl)
    const e = this.entries.get(key)
    if (await this.options.probe(key)) {
      this.touch(key)
      if (e) e.state = 'running'
      return true
    }
    if (!this.canSpawn(key)) return false
    if (e?.inflight) return e.inflight
    const attempt = this.start(key)
    if (e) e.inflight = attempt
    try {
      return await attempt
    } finally {
      if (e) e.inflight = undefined
    }
  }

  /** The accounted cost of everything up or coming up, optionally ignoring one backend. */
  private residentBytes(except?: string): number {
    let total = 0
    for (const [url, e] of this.entries) {
      if (url === except) continue
      if (e.state === 'running' || e.state === 'starting') total += e.spec.footprintBytes ?? 0
    }
    return total
  }

  /**
   * Make room for a backend about to start, or explain why there is none.
   *
   * Eviction order is least-recently-used among backends that can be taken down at all: a
   * pinned front door is exempt by the same rule that exempts it from the idle sweep, and a
   * backend with a request in flight is mid-answer — stopping it would abort work already
   * promised. When only those are in the way the wait is real rather than a refusal, because
   * an in-flight generation ends on its own; a refusal here would fail a workflow at step 2
   * over memory that was about to be free.
   */
  private async admit(key: string, deadline: number): Promise<string | null> {
    const budget = this.options.budgetBytes
    const e = this.entries.get(key)
    if (!budget || !e) return null
    const need = e.spec.footprintBytes ?? 0

    for (;;) {
      const resident = this.residentBytes(key)
      if (resident + need <= budget) return null
      // Nothing else is up and it still does not fit: this model is bigger than the whole
      // budget. Run it anyway — one model at a time is what this machine can do, and
      // refusing would leave it unable to do that.
      if (resident === 0) return null

      const candidates = [...this.entries.entries()]
        .filter(([url, other]) =>
          url !== key && other.state === 'running' && !other.spec.pinned && other.inFlight === 0)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)

      const evict = candidates[0]
      if (evict) {
        await this.stop(evict[0], 'evicted')
        continue
      }
      if (Date.now() >= deadline) {
        return `would need ${fmtBytes(need)} beside ${fmtBytes(resident)} already resident, over the ${fmtBytes(budget)} model budget, and nothing could be freed (pinned or mid-request)`
      }
      await sleep(this.options.pollMs)
    }
  }

  /**
   * Run one startup at a time, host-wide.
   *
   * Loading weights is the memory peak, not serving them, so two models coming up together
   * peak at the sum of both and can take down a host that would have held either. The queue
   * also makes admission decisions meaningful: a start that evicts to make room must not
   * have that room taken by another start in the same instant.
   */
  private startQueue: Promise<unknown> = Promise.resolve()
  private serializeStart<T>(run: () => Promise<T>): Promise<T> {
    const next = this.startQueue.then(run, run)
    this.startQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async start(rawBaseUrl: string): Promise<boolean> {
    return this.serializeStart(() => this.startNow(rawBaseUrl))
  }

  private async startNow(rawBaseUrl: string): Promise<boolean> {
    const baseUrl = normalizeBaseUrl(rawBaseUrl)
    const e = this.entries.get(baseUrl)
    if (!e || !e.spec.model) return false
    e.state = 'starting'
    e.error = undefined

    const startedAt = Date.now()

    // Make room before the weights are read, not after: a start that would have to be
    // rolled back has already cost the machine the load it was meant to prevent.
    const refused = await this.admit(baseUrl, startedAt + this.options.startTimeoutMs)
    if (refused) {
      e.state = 'failed'
      e.error = `llama-server not started: ${refused}`
      this.emit(baseUrl, 'failed', { error: e.error, wallMs: Date.now() - startedAt })
      return false
    }

    const port = new URL(baseUrl).port || '8080'
    const model = expandTilde(e.spec.model)
    const args = ['--model', isAbsolute(model) ? model : resolve(model)]
    args.push('--port', port, '--jinja')
    if (e.spec.ctx) args.push('--ctx-size', String(e.spec.ctx))
    args.push(...this.options.spawnArgs)

    let proc: SpawnResult
    try {
      proc = this.options.spawn!(this.options.binary ?? 'llama-server', args)
    } catch (err) {
      e.state = 'failed'
      e.error = `could not spawn llama-server: ${(err as Error).message}`
      this.emit(baseUrl, 'failed', { error: e.error, wallMs: Date.now() - startedAt })
      return false
    }
    e.proc = proc
    e.pid = proc.pid
    this.emit(baseUrl, 'starting', { pid: proc.pid, model: e.spec.model })

    const deadline = Date.now() + this.options.startTimeoutMs
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let ready = false
    while (Date.now() < deadline && !ready) {
      if (await this.options.probe(baseUrl)) {
        ready = true
        break
      }
      const race = await Promise.race([
        proc.exit.then((r) => ({ exited: r })),
        sleep(this.options.pollMs).then(() => ({ exited: null })),
      ])
      if (race.exited) {
        exited = race.exited
        break
      }
    }

    if (ready) {
      e.state = 'running'
      e.lastUsed = Date.now()
      // When this backend came up, so the `stopped` event can report how long the MODEL
      // was resident. `startedAt` is seeded at registration (host boot), and reporting
      // that on a stop would answer "how long has the server been running" in the one
      // place someone reads to ask whether the idle window is too aggressive.
      e.startedAt = startedAt
      this.emit(baseUrl, 'ready', { pid: proc.pid, model: e.spec.model, wallMs: Date.now() - startedAt })
      return true
    }

    proc.kill('SIGKILL')
    e.state = 'failed'
    // A child that reported neither code nor signal never ran: `realSpawn` resolves the
    // exit that way when the spawn itself failed, and the reason is on the stderr tail.
    e.error = exited
      ? exited.code === null && exited.signal === null
        ? `llama-server could not be started: ${proc.stderr().slice(-400).trim()}`
        : `llama-server exited (code ${exited.code ?? ''}${exited.signal ? `, ${exited.signal}` : ''}): ${proc.stderr().slice(-400)}`
      : `llama-server did not answer /health within ${Math.round(this.options.startTimeoutMs / 1000)}s`
    this.emit(baseUrl, 'failed', { error: e.error, wallMs: Date.now() - startedAt })
    return false
  }

  async stop(rawBaseUrl: string, reason: 'idle' | 'shutdown' | 'evicted' = 'shutdown'): Promise<void> {
    const baseUrl = normalizeBaseUrl(rawBaseUrl)
    const e = this.entries.get(baseUrl)
    if (!e || !e.proc) return
    const proc = e.proc
    const startedAt = e.startedAt
    e.state = 'stopped'
    // Let the child go before the first await. The process this entry owns is the only
    // thing that makes a stop meaningful, so releasing it here is what makes a second
    // stop a no-op: shutdown used to SIGTERM a pid that idle-stop had killed minutes
    // earlier and emit a duplicate `stopped` event naming it.
    e.proc = undefined
    e.pid = undefined
    if (!proc.kill('SIGTERM')) {
      // Already dead — the exit is our signal either way.
    }
    const outcome = await Promise.race([
      proc.exit.then(() => 'exited' as const),
      sleep(5000).then(() => 'timeout' as const),
    ])
    if (outcome === 'timeout') proc.kill('SIGKILL')
    this.emit(baseUrl, 'stopped', {
      pid: proc.pid,
      reason,
      wallMs: Date.now() - startedAt,
      footprintBytes: e.spec.footprintBytes,
    })
  }

  /** Stop every backend idle longer than the timeout and not mid-request. Runs on a host timer. */
  async sweep(): Promise<void> {
    const now = Date.now()
    for (const [baseUrl, e] of this.entries) {
      // A pinned front-door backend is never swept: once resident, it stays until shutdown.
      if (
        e.state === 'running' &&
        !e.spec.pinned &&
        e.inFlight === 0 &&
        now - e.lastUsed > this.options.idleMs
      ) {
        await this.stop(baseUrl, 'idle')
      }
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((url) => this.stop(url, 'shutdown')))
  }

  private emit(baseUrl: string, state: ManagedEventInput['state'], extra: Partial<ManagedEventInput> = {}): void {
    this.options.emit?.({ baseUrl, state, ...extra })
  }
}