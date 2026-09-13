/**
 * Activity event shapes, dependency-free.
 *
 * `activity.ts` owns the bus and the banned-key walk; this module exists so a browser
 * dashboard can import the event contract without pulling in `node:async_hooks`. Nothing
 * here may import Node — server and dashboard must agree on one schema.
 *
 * The shape rules live in `spec/activity.md` and are stamped by `createActivity`: a view
 * must trust `seq` monotonicity, ignore duplicates, and refuse a stream whose
 * `activitySpec` does not match `ACTIVITY_SPEC`.
 */
export const ACTIVITY_SPEC = 2

/**
 * Request header carrying the stream identity a resuming client's `Last-Event-ID` belongs
 * to. Lives with the event contract because both ends of the wire need it: the client sends
 * it, and the server replays its whole buffer when the id is not its own.
 */
export const ACTIVITY_INSTANCE_HEADER = 'x-activity-instance'

/** Correlation ids stamped by `withActivityScope`; dashboards group events by them. */
export interface ActivityScope {
  runId?: string
  sessionId?: string
  requestId?: string
  stageId?: string
  parentId?: string
}

/**
 * What PERFORMS a stage.
 *
 * The one fact a reader needs to tell a model boundary from deterministic code, and the one
 * a dashboard cannot infer: `verify` and `gateway` are arithmetic, `medication-pass` is a
 * second model call, and nothing about either name says so. Emitted on the event and
 * published on the topology by whatever owns the stage, so a view never has to keep a list
 * of names it recognises — a list that goes stale silently every time a profile adds a pass.
 *
 * `orchestrator` is the honest answer for a stage that only brackets other work.
 */
export type StageOperation = 'model' | 'code' | 'orchestrator' | 'decision'

/** Allowed scalar types in `StageDetail`. Prose is not representable. */
export type StageDetail =
  | string
  | number
  | boolean
  | null
  | { from: string; to: string; via: string; confirmed?: boolean }
  | Record<string, string | number | boolean | null>

/** Fields every event carries. No content-bearing field may ever appear here or below. */
interface BaseActivityEvent {
  activitySpec: typeof ACTIVITY_SPEC
  seq: number
  ts: string
  kind: string
  /**
   * Which bus produced this event — a fresh id per `createActivity`, so per server process.
   *
   * `seq` is only monotonic WITHIN one bus: a restarted server counts from 1 again, and a
   * watermark that cannot tell the two apart discards the new stream as stale while still
   * reporting itself live. Optional so a stream from an older server stays readable; a
   * reader that sees it change must reset its watermark (see `spec/activity.md`).
   */
  instanceId?: string
  runId?: string
  sessionId?: string
  requestId?: string
  stageId?: string
  parentId?: string
}

export interface ServerReadyEvent extends BaseActivityEvent {
  kind: 'server.ready'
}

export interface ProfileLoadedEvent extends BaseActivityEvent {
  kind: 'profile.loaded'
  name: string
  mode: string
  url?: string
  pack?: string
}

export interface ModelIdentifiedEvent extends BaseActivityEvent {
  kind: 'model.identified'
  baseUrl: string
  model?: string
  ctx?: number
  slots?: number
  identified: boolean
}

/**
 * A managed backend's lifecycle: spawn on demand, idle-stop to free memory.
 * `stopped` carries the reason so a dashboard can show "stopped idle" rather than a
 * failure. Emitted only for backends the server itself manages.
 */
export interface ModelLifecycleEvent extends BaseActivityEvent {
  kind: 'model.lifecycle'
  baseUrl: string
  state: 'starting' | 'ready' | 'stopped' | 'failed'
  pid?: number
  model?: string
  /** `evicted`: stopped to make room for another model under the resident-memory budget. */
  reason?: 'idle' | 'shutdown' | 'evicted'
  error?: string
  wallMs?: number
  /** The accounted resident cost of this backend, so a feed can show what a stop freed. */
  footprintBytes?: number
}

export interface LlmRequestEvent extends BaseActivityEvent {
  kind: 'llm.request'
  requestId: string
  label: string
  baseUrl: string
  model?: string
  constrained: boolean
  messageCount: number
}

export interface LlmResponseEvent extends BaseActivityEvent {
  kind: 'llm.response'
  requestId: string
  wallMs: number
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
  finishReason?: string
  chunks?: number
}

export interface LlmErrorEvent extends BaseActivityEvent {
  kind: 'llm.error'
  requestId: string
  wallMs: number
  message: string
}

export interface HttpRequestEvent extends BaseActivityEvent {
  kind: 'http.request'
  method: string
  path: string
}

export interface HttpCompletedEvent extends BaseActivityEvent {
  kind: 'http.completed'
  method: string
  path: string
  status: number
  wallMs: number
}

export interface RouteDecidedEvent extends BaseActivityEvent {
  kind: 'route.decided'
  profile: string
  confidence: number
  reason: string
  ruleVsModel: 'rule' | 'model'
}

export interface RunStartedEvent extends BaseActivityEvent {
  kind: 'run.started'
  profile: string
  inputChars: number
  inputDigest: string
  /**
   * Where this run is being recorded, so a live surface can name the durable half of itself.
   *
   * A path, not content — the feed's rule is unchanged. It is here because the feed is a ring
   * buffer and the file is not: a reader watching a run needs to know, while it is still on
   * screen, where to look for it once it has scrolled off. `(not recorded)` when the server
   * is running with ALKOR_SERVER_TRACE=0.
   */
  trace?: string
}

export interface RunCompletedEvent extends BaseActivityEvent {
  kind: 'run.completed'
  profile: string
  wallMs: number
}

export interface RunFailedEvent extends BaseActivityEvent {
  kind: 'run.failed'
  profile: string
  wallMs: number
  error: string
}

/**
 * A run stopped by whoever started it, which is not a run that failed.
 *
 * Its own kind rather than a `run.failed` with a recognisable message: a surface counting
 * failures would otherwise count the operator pressing stop, and the two belong in different
 * columns. `by` says which way it was asked for — the caller's connection going away, or an
 * explicit `DELETE /run/:id` — because those are different situations for a reader chasing
 * why a run ended.
 */
export interface RunCancelledEvent extends BaseActivityEvent {
  kind: 'run.cancelled'
  profile: string
  wallMs: number
  by: 'disconnect' | 'request'
}

export interface WorkflowStartedEvent extends BaseActivityEvent {
  kind: 'workflow.started'
}

/**
 * One mapping inside a COMPOSED step input: `name` is the field the workflow hands the
 * next step, `ref` is where it resolves from. Held as (name, ref) pairs rather than as the
 * template object itself so the event survives the banned-key walk — a template maps a
 * field named `document`, and a field NAME is exactly what `emit()` refuses.
 */
export interface TemplateRefEntry {
  /** The field of the composed input this ref fills (e.g. `extraction`). */
  name: string
  /** The source ref it resolves from (e.g. `step-1.report`). */
  ref: string
}

export interface WorkflowStepStartedEvent extends BaseActivityEvent {
  kind: 'workflow.step.started'
  step: number
  name: string
  profile: string
  input?: { ref: string | TemplateRefEntry[]; field?: string; fromProfile?: string }
}

export interface WorkflowStepCompletedEvent extends BaseActivityEvent {
  kind: 'workflow.step.completed'
  step: number
  name: string
  profile: string
  ok: boolean
  wallMs?: number
}

export interface WorkflowCompletedEvent extends BaseActivityEvent {
  kind: 'workflow.completed'
  stoppedEarly: boolean
  totalMs: number
}

export interface SessionCreatedEvent extends BaseActivityEvent {
  kind: 'session.created'
  sessionId: string
  profile: string
}

export interface TurnStartedEvent extends BaseActivityEvent {
  kind: 'turn.started'
  sessionId: string
  turn: number
}

export interface TurnCompletedEvent extends BaseActivityEvent {
  kind: 'turn.completed'
  sessionId: string
  turn: number
  stop: string
  iterations: number
  toolsUsed: string[]
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number }
}

export interface SessionDestroyedEvent extends BaseActivityEvent {
  kind: 'session.destroyed'
  sessionId: string
}

export interface ToolCalledEvent extends BaseActivityEvent {
  kind: 'tool.called'
  name: string
}

export interface ToolCompletedEvent extends BaseActivityEvent {
  kind: 'tool.completed'
  name: string
}

export interface ToolDeclinedEvent extends BaseActivityEvent {
  kind: 'tool.declined'
  name: string
}

export interface StageEvent extends BaseActivityEvent {
  kind: 'stage'
  name: string
  status: 'started' | 'completed'
  detail?: StageDetail
  wallMs?: number
  /**
   * What performs this stage. Optional, and additive rather than a spec bump: a stream that
   * omits it is a valid stream, and a view falls back to whatever it inferred before.
   */
  operation?: StageOperation
  stageId?: string
  parentId?: string
}

export type ActivityEvent =
  | ServerReadyEvent
  | ProfileLoadedEvent
  | ModelIdentifiedEvent
  | ModelLifecycleEvent
  | LlmRequestEvent
  | LlmResponseEvent
  | LlmErrorEvent
  | HttpRequestEvent
  | HttpCompletedEvent
  | RouteDecidedEvent
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | WorkflowStartedEvent
  | WorkflowStepStartedEvent
  | WorkflowStepCompletedEvent
  | WorkflowCompletedEvent
  | SessionCreatedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | SessionDestroyedEvent
  | ToolCalledEvent
  | ToolCompletedEvent
  | ToolDeclinedEvent
  | StageEvent

/** What goes into `emit` — the bus stamps `activitySpec`, `seq`, `ts`. Correlation ids may come from the scope or the caller. */
export type ActivityInput = Omit<ActivityEvent, 'activitySpec' | 'seq' | 'ts'>