/**
 * Pure reducer: `applyEvent(state, ActivityEvent) → state`.
 *
 * All intelligence is here. The OpenTUI layer only renders what this produces.
 * No clinical concept is named — the view is generic over event kinds.
 */
import { ACTIVITY_SPEC, type ActivityEvent, type StageOperation, type TemplateRefEntry } from '../core/activity-types.ts'
import type { ProfileTopology } from '../core/topology.ts'

export interface ProfileEntry {
  name: string
  mode: string
  url?: string
  pack?: string
  /** The configured front-door profile that receives unclassified input. */
  pinned?: boolean
  /** Static internal execution shape published by the profile module. */
  topology?: ProfileTopology
}

export interface ModelEntry {
  baseUrl: string
  model?: string
  ctx?: number
  slots?: number
  identified: boolean
  /** Present once the backend reports a lifecycle (spawn/stop); merged on each event. */
  managed?: boolean
  state?: BackendState
}

type BackendState = 'stopped' | 'starting' | 'running' | 'ready' | 'failed'

export interface RunEntry {
  runId: string
  profile: string
  status: 'started' | 'completed' | 'failed'
  wallMs?: number
  inputChars?: number
  inputDigest?: string
  error?: string
}

export interface LlmRequestEntry {
  requestId: string
  /** Correlates the request with its run when the activity scope supplied one. */
  runId?: string
  label: string
  baseUrl: string
  model?: string
  constrained: boolean
  messageCount: number
  status: 'in-flight' | 'completed' | 'error'
  wallMs?: number
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
  finishReason?: string
  chunks?: number
  errorMessage?: string
  startedAt?: number // epoch ms for in-flight age
}

export interface WorkflowStepEntry {
  step: number
  name: string
  profile: string
  status: 'started' | 'completed'
  ok?: boolean
  wallMs?: number
  input?: { ref: string | TemplateRefEntry[]; field?: string; fromProfile?: string }
}

export interface WorkflowEntry {
  runId: string
  steps: WorkflowStepEntry[]
  stoppedEarly?: boolean
  totalMs?: number
}

export interface SessionEntry {
  sessionId: string
  profile: string
  turns: TurnEntry[]
  destroyed?: boolean
}

export interface TurnEntry {
  turn: number
  stop?: string
  iterations?: number
  toolsUsed?: string[]
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    cachedTokens?: number
  }
}

export interface StageEntry {
  stageId: string
  runId?: string
  parentId?: string
  name: string
  status: 'started' | 'completed'
  detail?: unknown
  wallMs?: number
  /** What performed it, as the emitter said. Absent on a stream that does not say. */
  operation?: StageOperation
  children: StageEntry[]
}

export interface HttpEntry {
  method: string
  path: string
  status?: number
  wallMs?: number
}

/** A routing decision explains an execution branch without retaining input data. */
export interface RouteEntry {
  profile: string
  confidence: number
  reason: string
  ruleVsModel: 'rule' | 'model'
  /** The run that produced this decision, when the activity scope supplied one. */
  runId?: string
}

/** The recent tool edge of an agentic run, retained as names only. */
export interface ToolEntry {
  name: string
  status: 'called' | 'completed' | 'declined'
  runId?: string
}

/** Static wiring read from the server once; activity events only paint its state. */
export interface WorkflowDefinition {
  name: string
  steps: Array<{
    name: string
    profile: string
    /** Plain context ref or the metadata-safe form of a composed input template. */
    input?: string | TemplateRefEntry[]
    field?: string
    /** The terminal step: the ending, which runs on every exit including a refusal. */
    final?: boolean
  }>
}

export interface TopologySnapshot {
  /** The product-level front door that owns routing and the workflow catalogue. */
  pipeline?: { router: string; workflows: string[]; defaultWorkflow: string }
  profiles: ProfileEntry[]
  /** Workflow recipes: the `mode = "workflow"` profiles the pipeline may select. */
  workflows: WorkflowDefinition[]
}

export type ConnectionStatus =
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'reconnecting'; attempt: number; nextMs: number }
  | { kind: 'refused'; reason: string }

export interface ProjectState {
  profiles: ProfileEntry[]
  models: Map<string, ModelEntry>
  runs: Map<string, RunEntry>
  llmRequests: Map<string, LlmRequestEntry>
  workflows: Map<string, WorkflowEntry>
  sessions: Map<string, SessionEntry>
  stages: Map<string, StageEntry>
  httpLog: HttpEntry[]
  routes: RouteEntry[]
  tools: ToolEntry[]
  topology: TopologySnapshot
  eventLog: ActivityEvent[]
  connection: ConnectionStatus
  lastSeq: number
  /** Which server process `lastSeq` counts in; a change means the seq space restarted. */
  instanceId?: string
  activitySpecRefused?: boolean
}

export const emptyState = (): ProjectState => ({
  profiles: [],
  models: new Map(),
  runs: new Map(),
  llmRequests: new Map(),
  workflows: new Map(),
  sessions: new Map(),
  stages: new Map(),
  httpLog: [],
  routes: [],
  tools: [],
  topology: { profiles: [], workflows: [] },
  eventLog: [],
  connection: { kind: 'connecting' },
  lastSeq: 0,
})

/** Seed the full configured graph without manufacturing activity events. */
export const setTopology = (state: ProjectState, topology: TopologySnapshot): ProjectState => ({
  ...state,
  topology,
  // Health gives the dashboard the full configuration before lazy profile loading.
  profiles: topology.profiles,
})

/** Derive rolling failure rate from runs. */
export const failureRate = (runs: Map<string, RunEntry>): number => {
  let total = 0
  let failed = 0
  for (const r of runs.values()) {
    if (r.status === 'completed' || r.status === 'failed') {
      total++
      if (r.status === 'failed') failed++
    }
  }
  return total === 0 ? 0 : failed / total
}

/** Derive in-flight count from LLM requests. */
export const inFlightCount = (requests: Map<string, LlmRequestEntry>): number => {
  let n = 0
  for (const r of requests.values()) {
    if (r.status === 'in-flight') n++
  }
  return n
}

/** Derive cache-hit ratio from completed LLM requests that have cachedTokens. */
export const cacheHitRatio = (requests: Map<string, LlmRequestEntry>): number | undefined => {
  let totalPrompt = 0
  let totalCached = 0
  for (const r of requests.values()) {
    if (r.status === 'completed' && r.promptTokens != null && r.cachedTokens != null) {
      totalPrompt += r.promptTokens
      totalCached += r.cachedTokens
    }
  }
  return totalPrompt === 0 ? undefined : totalCached / totalPrompt
}

/** Derive tok/s for a completed LLM request. */
export const tokPerSec = (r: LlmRequestEntry): number | undefined => {
  if (r.status !== 'completed' || r.wallMs == null || r.wallMs <= 0) return undefined
  const tokens = (r.promptTokens ?? 0) + (r.completionTokens ?? 0)
  return tokens / (r.wallMs / 1000)
}

export const applyEvent = (state: ProjectState, event: ActivityEvent): ProjectState => {
  // A different bus is a different seq space, so the watermark below does not apply to it.
  // Its history is dropped rather than merged: stage ids fall back to `stage-${seq}`, which
  // two processes both counting from 1 would collide on, fusing unrelated nodes into one.
  const restarted =
    state.instanceId !== undefined &&
    event.instanceId !== undefined &&
    event.instanceId !== state.instanceId
  const from = restarted ? clearExecutionHistory(state) : state

  // Defensive: seq should be monotonic, but tolerate gaps and ignore duplicates.
  if (!restarted && event.seq <= state.lastSeq) {
    return state // duplicate or out of order — ignore
  }

  // Refuse on activitySpec mismatch.
  if (event.activitySpec !== ACTIVITY_SPEC) {
    return {
      ...state,
      connection: { kind: 'refused', reason: `activitySpec ${event.activitySpec} !== ${ACTIVITY_SPEC}` },
      activitySpecRefused: true,
      lastSeq: event.seq,
    }
  }

  const next: ProjectState = {
    ...from,
    lastSeq: event.seq,
    instanceId: event.instanceId ?? from.instanceId,
    eventLog: [...from.eventLog, event].slice(-1000),
  }

  switch (event.kind) {
    case 'server.ready': {
      return next
    }
    case 'profile.loaded': {
      const existing = next.profiles.findIndex((p) => p.name === event.name)
      const profiles = [...next.profiles]
      if (existing >= 0) {
        profiles[existing] = { name: event.name, mode: event.mode, url: event.url, pack: event.pack }
      } else {
        profiles.push({ name: event.name, mode: event.mode, url: event.url, pack: event.pack })
      }
      return { ...next, profiles }
    }
    case 'model.identified': {
      const models = new Map(next.models)
      models.set(event.baseUrl, {
        baseUrl: event.baseUrl,
        model: event.model,
        ctx: event.ctx,
        slots: event.slots,
        identified: event.identified,
      })
      return { ...next, models }
    }
    case 'model.lifecycle': {
      const models = new Map(next.models)
      const existing = models.get(event.baseUrl)
      // Merge, holding onto identity facts the /health poll gathered, so a spawn
      // lifecycle does not replace "identified with model X" with a lifecycle-only shell.
      models.set(event.baseUrl, {
        baseUrl: event.baseUrl,
        model: event.model ?? existing?.model,
        ctx: existing?.ctx,
        slots: existing?.slots,
        identified: existing?.identified ?? false,
        managed: true,
        state: event.state,
      })
      return { ...next, models }
    }
    case 'llm.request': {
      const llmRequests = new Map(next.llmRequests)
      llmRequests.set(event.requestId, {
        requestId: event.requestId,
        runId: event.runId,
        label: event.label,
        baseUrl: event.baseUrl,
        model: event.model,
        constrained: event.constrained,
        messageCount: event.messageCount,
        status: 'in-flight',
        startedAt: Date.now(),
      })
      return { ...next, llmRequests }
    }
    case 'llm.response': {
      const llmRequests = new Map(next.llmRequests)
      const existing = llmRequests.get(event.requestId)
      llmRequests.set(event.requestId, {
        requestId: event.requestId,
        runId: existing?.runId ?? event.runId,
        label: existing?.label ?? event.requestId,
        baseUrl: existing?.baseUrl ?? '',
        model: existing?.model,
        constrained: existing?.constrained ?? false,
        messageCount: existing?.messageCount ?? 0,
        status: 'completed',
        wallMs: event.wallMs,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        cachedTokens: event.cachedTokens,
        finishReason: event.finishReason,
        chunks: event.chunks,
      })
      return { ...next, llmRequests }
    }
    case 'llm.error': {
      const llmRequests = new Map(next.llmRequests)
      const existing = llmRequests.get(event.requestId)
      llmRequests.set(event.requestId, {
        requestId: event.requestId,
        runId: existing?.runId ?? event.runId,
        label: existing?.label ?? event.requestId,
        baseUrl: existing?.baseUrl ?? '',
        model: existing?.model,
        constrained: existing?.constrained ?? false,
        messageCount: existing?.messageCount ?? 0,
        status: 'error',
        wallMs: event.wallMs,
        errorMessage: event.message,
      })
      return { ...next, llmRequests }
    }
    case 'http.request': {
      return { ...next, httpLog: [...next.httpLog, { method: event.method, path: event.path }].slice(-100) }
    }
    case 'http.completed': {
      const httpLog = [...next.httpLog]
      let matched = false
      // Match the most recent unmatched request with same method/path.
      for (let i = httpLog.length - 1; i >= 0; i--) {
        if (httpLog[i]!.method === event.method && httpLog[i]!.path === event.path && httpLog[i]!.status == null) {
          httpLog[i] = { ...httpLog[i]!, status: event.status, wallMs: event.wallMs }
          matched = true
          break
        }
      }
      if (!matched) {
        // Orphan completion — append as a standalone entry.
        httpLog.push({ method: event.method, path: event.path, status: event.status, wallMs: event.wallMs })
      }
      return { ...next, httpLog: httpLog.slice(-100) }
    }
    case 'route.decided': {
      return {
        ...next,
        routes: [...next.routes, {
          profile: event.profile,
          confidence: event.confidence,
          reason: event.reason,
          ruleVsModel: event.ruleVsModel,
          runId: event.runId,
        }].slice(-20),
      }
    }
    case 'run.started': {
      const runs = new Map(next.runs)
      const runId = event.runId ?? `run-${event.seq}`
      runs.set(runId, {
        runId,
        profile: event.profile,
        status: 'started',
        inputChars: event.inputChars,
        inputDigest: event.inputDigest,
      })
      return { ...next, runs }
    }
    case 'run.completed': {
      const runs = new Map(next.runs)
      // Find the most recent run for this profile that is still started.
      let runId: string | undefined
      for (const [id, r] of [...runs.entries()].reverse()) {
        if (r.profile === event.profile && r.status === 'started') {
          runId = id
          break
        }
      }
      if (runId) {
        runs.set(runId, { ...runs.get(runId)!, status: 'completed', wallMs: event.wallMs })
      }
      return { ...next, runs }
    }
    case 'run.failed': {
      const runs = new Map(next.runs)
      let runId: string | undefined
      for (const [id, r] of [...runs.entries()].reverse()) {
        if (r.profile === event.profile && r.status === 'started') {
          runId = id
          break
        }
      }
      if (runId) {
        runs.set(runId, { ...runs.get(runId)!, status: 'failed', wallMs: event.wallMs, error: event.error })
      }
      return { ...next, runs }
    }
    case 'workflow.started': {
      const runId = event.runId ?? `workflow-${event.seq}`
      const workflows = new Map(next.workflows)
      workflows.set(runId, { runId, steps: [] })
      return { ...next, workflows }
    }
    case 'workflow.step.started': {
      const runId = event.runId ?? `workflow-${event.seq}`
      const workflows = new Map(next.workflows)
      const workflow = workflows.get(runId) ?? { runId, steps: [] }
      const steps = [...workflow.steps, {
        step: event.step,
        name: event.name,
        profile: event.profile,
        status: 'started' as const,
        input: event.input,
      }]
      workflows.set(runId, { ...workflow, steps })
      return { ...next, workflows }
    }
    case 'workflow.step.completed': {
      const runId = event.runId ?? `workflow-${event.seq}`
      const workflows = new Map(next.workflows)
      const workflow = workflows.get(runId)
      if (!workflow) return next
      const steps = workflow.steps.map((s) =>
        s.step === event.step && s.status === 'started' ? { ...s, status: 'completed' as const, ok: event.ok, wallMs: event.wallMs } : s,
      )
      workflows.set(runId, { ...workflow, steps })
      return { ...next, workflows }
    }
    case 'workflow.completed': {
      const runId = event.runId ?? `workflow-${event.seq}`
      const workflows = new Map(next.workflows)
      const workflow = workflows.get(runId)
      if (!workflow) return next
      workflows.set(runId, { ...workflow, stoppedEarly: event.stoppedEarly, totalMs: event.totalMs })
      return { ...next, workflows }
    }
    case 'session.created': {
      const sessions = new Map(next.sessions)
      sessions.set(event.sessionId, { sessionId: event.sessionId, profile: event.profile, turns: [] })
      return { ...next, sessions }
    }
    case 'turn.started': {
      const sessions = new Map(next.sessions)
      const session = sessions.get(event.sessionId)
      if (!session) return next
      sessions.set(event.sessionId, {
        ...session,
        turns: [...session.turns, { turn: event.turn }],
      })
      return { ...next, sessions }
    }
    case 'turn.completed': {
      const sessions = new Map(next.sessions)
      const session = sessions.get(event.sessionId)
      if (!session) return next
      const turns = session.turns.map((t) =>
        t.turn === event.turn ? { ...t, stop: event.stop, iterations: event.iterations, toolsUsed: event.toolsUsed, usage: event.usage } : t,
      )
      sessions.set(event.sessionId, { ...session, turns })
      return { ...next, sessions }
    }
    case 'session.destroyed': {
      const sessions = new Map(next.sessions)
      const session = sessions.get(event.sessionId)
      if (session) {
        sessions.set(event.sessionId, { ...session, destroyed: true })
      }
      return { ...next, sessions }
    }
    case 'tool.called': {
      return { ...next, tools: [...next.tools, { name: event.name, status: 'called' as const, runId: event.runId }].slice(-30) }
    }
    case 'tool.completed': {
      return { ...next, tools: [...next.tools, { name: event.name, status: 'completed' as const, runId: event.runId }].slice(-30) }
    }
    case 'tool.declined': {
      return { ...next, tools: [...next.tools, { name: event.name, status: 'declined' as const, runId: event.runId }].slice(-30) }
    }
    case 'stage': {
      const stages = new Map(next.stages)
      const stageId = event.stageId ?? `stage-${event.seq}`
      const runId = event.runId
      const parentId = event.parentId
      const entry: StageEntry = {
        stageId,
        runId,
        parentId,
        name: event.name,
        status: event.status,
        detail: event.detail,
        wallMs: event.wallMs,
        operation: event.operation,
        children: [],
      }
      // If a stage with this id already exists, merge (update status / wallMs / detail).
      const existing = stages.get(stageId)
      if (existing) {
        // `operation` is a property of the stage, not of the event: a `completed` that omits
        // it must not erase what the `started` said.
        stages.set(stageId, { ...existing, status: event.status, wallMs: event.wallMs ?? existing.wallMs, detail: event.detail ?? existing.detail, operation: event.operation ?? existing.operation })
      } else {
        stages.set(stageId, entry)
      }
      return { ...next, stages }
    }
    default: {
      // Unknown kind — keep the event in the log but don't mutate state.
      return next
    }
  }
}

/** Build a stage tree (parent → children) for a given runId. */
export const stageTreeForRun = (stages: Map<string, StageEntry>, runId?: string): StageEntry[] => {
  const roots: StageEntry[] = []
  const byParent = new Map<string, StageEntry[]>()
  for (const s of stages.values()) {
    if (runId != null && s.runId !== runId) continue
    if (s.parentId) {
      const list = byParent.get(s.parentId) ?? []
      list.push(s)
      byParent.set(s.parentId, list)
    } else {
      roots.push(s)
    }
  }
  // Attach children recursively.
  const attach = (node: StageEntry): StageEntry => ({
    ...node,
    children: (byParent.get(node.stageId) ?? []).map(attach),
  })
  return roots.map(attach)
}

/** Set connection status explicitly (e.g. from SSE layer). */
export const setConnection = (state: ProjectState, connection: ConnectionStatus): ProjectState => ({
  ...state,
  connection,
})

/**
 * "Clear" removes run/activity history but keeps everything that describes the active
 * backend: configured topology, loaded profiles, model health, connection state, and
 * the SSE sequence watermark (dedup must keep counting on the same source).
 */
export const clearExecutionHistory = (state: ProjectState): ProjectState => ({
  ...state,
  runs: new Map(),
  llmRequests: new Map(),
  workflows: new Map(),
  sessions: new Map(),
  stages: new Map(),
  httpLog: [],
  routes: [],
  tools: [],
  eventLog: [],
})
