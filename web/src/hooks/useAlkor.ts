/**
 * Dashboard state wired to the activity feed. The intelligence is the shared harness
 * reducer in `src/tui/state.ts` (the same one the terminal TUI runs); this hook only
 * transports frames and batches them into renders, so a busy feed re-paints once per
 * tick rather than once per event.
 *
 * Source-safe: the pure controller in `src/tui/source.ts` owns connection identity and
 * generation, so stale async responses from a previous backend cannot overwrite the
 * current topology or connection state. `draftUrl` is purely editorial; only `connect()`
 * commits the draft, and a changed origin resets all source-owned state.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  applyEvent,
  clearExecutionHistory,
  emptyState,
  setConnection,
  setTopology,
  type ConnectionStatus,
  type ProjectState,
  type TopologySnapshot,
} from '../../../src/tui/state.ts'
import {
  isCurrentGeneration,
  normalizeUrl,
  sourceReducer,
  initialSource,
} from '../../../src/tui/source.ts'
import type { ActivityEvent } from '../../../src/core/activity-types.ts'
import { createSseClient } from '../lib/sse.ts'

type Action =
  | { type: 'events'; events: ActivityEvent[] }
  | { type: 'connection'; status: ConnectionStatus }
  | { type: 'topology'; topology: TopologySnapshot }
  | { type: 'clear' }
  | { type: 'reset' }

const reducer = (state: ProjectState, action: Action): ProjectState => {
  switch (action.type) {
    case 'events': return action.events.reduce((s, e) => applyEvent(s, e), state)
    case 'connection': return setConnection(state, action.status)
    case 'topology': return setTopology(state, action.topology)
    case 'clear': return clearExecutionHistory(state)
    case 'reset': return emptyState()
  }
}

/**
 * A refused run, carrying what the server said about it.
 *
 * `runId` is the point: a failed POST still names the run it failed, so the dashboard can
 * assemble that run's log out of the feed instead of showing a status code alone. Absent
 * when the failure happened before the server minted one (or never reached it).
 */
export class RunFailure extends Error {
  // Declared as fields rather than constructor parameters: this repository runs TypeScript
  // by stripping types, so syntax that emits code (a parameter property) is not available.
  status?: number
  runId?: string
  constructor(message: string, status?: number, runId?: string) {
    super(message)
    this.name = 'RunFailure'
    this.status = status
    this.runId = runId
  }
}

export interface UseAlkor {
  state: ProjectState
  /** What the URL input currently displays (the draft). */
  serverUrl: string
  /** The URL runs actually go to — the committed one, which the draft may not be yet. */
  activeUrl: string
  setServerUrl: (url: string) => void
  /** Validate, normalize, and activate the candidate URL atomically. */
  connect: () => void
  paused: boolean
  setPaused: (paused: boolean) => void
  /** Remove run/activity history but retain topology, connection state, and models. */
  clear: () => void
  /** Route input through the product pipeline and execute its chosen workflow. */
  run: (input: string, workflow?: string) => Promise<unknown>
  /** Live backend status from /health, as the server reports it. */
  models: ModelHealth[]
}

/** One llama-server endpoint the server would talk to, as /health reports it. */
export interface ModelHealth {
  baseUrl: string
  reachable: boolean
  model?: string
  identified: boolean
  /** A backend the interactive server can spawn on demand. */
  managed?: boolean
  /** Lifecycle state for managed backends: stopped/starting/running/failed. */
  state?: string
}

export const useAlkor = (initialUrl: string): UseAlkor => {
  const [source, dispatchSource] = useReducer(sourceReducer, initialUrl, initialSource)
  const sourceRef = useRef(source)
  sourceRef.current = source
  const [models, setModels] = useState<ModelHealth[]>([])
  const [state, dispatch] = useReducer(reducer, undefined, emptyState)

  const activeUrl = source.activeUrl
  const generation = source.generation
  const paused = source.paused

  // Flush paused events when un-pausing, back through the controller's own buffer so
  // a drained batch still obeys the "never cross a source boundary" rule.
  useEffect(() => {
    if (paused || source.pausedEvents.length === 0) return
    const events = source.pausedEvents
    dispatch({ type: 'events', events })
    dispatchSource({ type: 'drain' })
  }, [paused, source.pausedEvents])

  // SSE + /health connection lifecycle — re-runs only when the active URL or generation
  // changes (i.e. when `connect()` is called), NOT when the draft changes.
  useEffect(() => {
    let flushScheduled = false
    const pending: ActivityEvent[] = []

    const flush = () => {
      flushScheduled = false
      if (pending.length === 0) return
      if (!isCurrentGeneration(generation, sourceRef.current)) return
      const batch = pending.splice(0, pending.length)
      if (sourceRef.current.paused) dispatchSource({ type: 'queue-paused', events: batch })
      else dispatch({ type: 'events', events: batch })
    }
    const schedule = () => {
      if (flushScheduled) return
      flushScheduled = true
      setTimeout(flush, 0)
    }

    const base = normalizeUrl(activeUrl)
    const client = createSseClient({
      url: `${base}/events`,
      onEvent: (event) => {
        if (!isCurrentGeneration(generation, sourceRef.current)) return
        pending.push(event)
        schedule()
      },
      onConnection: (status) => {
        if (!isCurrentGeneration(generation, sourceRef.current)) return
        dispatch({ type: 'connection', status })
      },
    })

    // Seed the configured graph from /health once; the SSE stream is the source of truth
    // for everything after. Best-effort: a server that is still starting has no topology.
    fetch(`${base}/health`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { topology?: TopologySnapshot; models?: ModelHealth[] }) => {
        if (!isCurrentGeneration(generation, sourceRef.current)) return
        if (Array.isArray(data.models)) setModels(data.models)
        if (data.topology?.profiles && data.topology?.workflows) {
          dispatch({ type: 'topology', topology: data.topology })
        }
      })
      .catch(() => {})

    return () => client.close()
  }, [activeUrl, generation])

  /** Connect: validate, normalize, reset if source changed, and activate. */
  const connect = useCallback(() => {
    const current = sourceRef.current
    const next = sourceReducer(current, { type: 'connect' })
    if (next.activeUrl === current.activeUrl && next.generation === current.generation) return
    dispatchSource({ type: 'connect' })
    // A changed origin owns fresh state; the same origin just re-establishes the
    // transport and keeps SSE replay/dedup working on existing state.
    if (next.activeUrl !== current.activeUrl) dispatch({ type: 'reset' })
  }, [])

  /** Clear: remove run/activity history but keep topology, connection, and models. */
  const clear = useCallback(() => {
    dispatch({ type: 'clear' })
  }, [])

  /**
   * POST /pipeline owns both decisions: the router chooses a workflow, then the server
   * executes that recipe under one run id. `workflow` is an explicit diagnostic override.
   */
  const run = useCallback(async (input: string, workflow?: string): Promise<unknown> => {
    const base = normalizeUrl(sourceRef.current.activeUrl)
    let res: Response
    try {
      res = await fetch(`${base}/pipeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, ...(workflow ? { workflow } : {}) }),
      })
    } catch (e) {
      // The request never reached a server: no status, no run id, and no events will ever
      // arrive for it. Said plainly, because the browser's own message ("Failed to fetch")
      // does not mention the address it failed to reach.
      throw new RunFailure(`could not reach ${base} — ${(e as Error).message}`)
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      let message = raw || 'run failed'
      let runId: string | undefined
      try {
        const body = JSON.parse(raw) as { error?: string; runId?: string }
        if (typeof body.error === 'string') message = body.error
        if (typeof body.runId === 'string') runId = body.runId
      } catch {
        // Not JSON; keep the raw text.
      }
      // The message is NOT truncated: a failure from deep in a workflow carries the only
      // description of what went wrong, and a 300-character cut lands in the middle of it.
      throw new RunFailure(`HTTP ${res.status}: ${message}`, res.status, runId)
    }
    return res.json()
  }, [])

  return {
    state,
    serverUrl: source.draftUrl,
    activeUrl: normalizeUrl(source.activeUrl),
    setServerUrl: (url: string) => dispatchSource({ type: 'draft', url }),
    connect,
    paused,
    setPaused: (nextPaused: boolean) => dispatchSource(nextPaused ? { type: 'pause' } : { type: 'resume' }),
    clear,
    run,
    models,
  }
}