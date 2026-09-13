/**
 * What the route handlers share, stated rather than captured.
 *
 * Every field here was already reachable from every handler — they were one closure, so the
 * dependency was total and invisible. Writing it down does not add coupling; it makes the
 * coupling that exists countable, and it is the thing that lets a handler be called from a
 * test without a socket, a config file and a model lifecycle behind it.
 *
 * It is deliberately NOT a class. These are the live objects `createServer` built — the same
 * manager, the same caches, the same activity bus — handed over by reference, because a
 * handler that got its own copy of the reachability map would answer from a second opinion
 * about which backends are up.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Activity } from '../core/activity.ts'
import type { Pack } from '../core/pack.ts'
import type { ProfileModule } from '../core/profile.ts'
import type { ProfileTopology } from '../core/topology.ts'
import type { Provider, ServerIdentity } from '../core/client.ts'
import type { loadConfig, requireProfile } from '../core/config.ts'
import type { Session } from '../modes/session.ts'
import type { Trace } from '../core/trace.ts'
import type { LlamaManager } from '../core/llama-manager.ts'
import type { Reply } from './reply.ts'
import type { SseHub } from './sse.ts'

export interface ServerDeps {
  cfg: ReturnType<typeof loadConfig>
  activity: Activity
  manager: LlamaManager
  /** The provider every model call goes through: touches the manager so idle-stop is honest. */
  provider: Provider
  loadProfile(name: string): Promise<{ profile: ProfileModule; config: ReturnType<typeof requireProfile> }>
  loadPackForProfile(
    profileName: string,
    profile: ProfileModule,
    profileConfig: ReturnType<typeof requireProfile>,
  ): Promise<Pack | undefined>
  /** Every pack named by a profile that loads, deduplicated by root. */
  declaredPacks(): Pack[]
  topologyForProfile(name: string, mode: string): Promise<ProfileTopology>
  /** The endpoint a profile talks to, spelled the one way everything here keys by. */
  backendFor(profileUrl?: string): string
  backendUrls: string[]
  backendReachability: Map<string, boolean>
  refreshReachability(force?: boolean): Promise<void>
  emitModelIdentified(baseUrl?: string): Promise<void>
  modelIdentityCache: Map<string, ServerIdentity>
  /** Profiles pinned as the front door. Only a pinned router qualifies. */
  pinnedRouters: ReturnType<typeof loadConfig>['profiles'][string][]
  manageModels: boolean
  /**
   * A trace for one run, named after its run id and redacted by every profile that can write
   * into it. Returns the null trace when ALKOR_SERVER_TRACE=0, so a handler never branches on
   * whether recording is on — it writes either way and one of the two writes goes nowhere.
   */
  openRunTrace(profileName: string, runId: string): Promise<Trace>
  /**
   * Runs in flight, keyed by run id, each able to stop itself.
   *
   * Mutable and shared for the same reason the SSE client set is: a handler holding a copy
   * could register a run nobody can reach, and `DELETE /run/:id` would answer 404 for a run
   * that is very much running.
   */
  inFlightRuns: Map<string, { profile: string; cancel(by: 'disconnect' | 'request'): void }>
  /** Live sessions, each remembering which profile and backend it was opened against. */
  sessions: Map<string, { profile: string; baseUrl: string; session: Session }>
  /** The SSE fan-out: mutable, shared, and the reason this is an object and not a copy. */
  sse: SseHub
  readBody(req: IncomingMessage): Promise<unknown>
  runResult<T extends object>(result: T, output: unknown): T & { output: unknown }
  inputDigest(text: string): string
}

/** One request, resolved far enough that a handler can answer it. */
export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  method: string
  reply: Reply
  /** Closes the activity span for this request with a status. Every exit path calls it. */
  done(status: number): void
  deps: ServerDeps
}

export type RouteHandler = (ctx: RouteContext) => Promise<void>
