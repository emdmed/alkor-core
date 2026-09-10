/**
 * Dashboard state wired to the activity feed. The intelligence is the shared harness
 * reducer in `src/tui/state.ts` (the same one the terminal TUI runs); this hook only
 * transports frames and batches them into renders, so a busy feed re-paints once per
 * tick rather than once per event.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  applyEvent,
  emptyState,
  setConnection,
  setTopology,
  type ConnectionStatus,
  type ProjectState,
  type TopologySnapshot,
} from '../../../src/tui/state.ts'
import type { ActivityEvent } from '../../../src/core/activity-types.ts'
import { createSseClient } from '../lib/sse.ts'

type Action =
  | { type: 'events'; events: ActivityEvent[] }
  | { type: 'connection'; status: ConnectionStatus }
  | { type: 'topology'; topology: TopologySnapshot }
  | { type: 'clear' }

const reducer = (state: ProjectState, action: Action): ProjectState => {
  switch (action.type) {
    case 'events': return action.events.reduce((s, e) => applyEvent(s, e), state)
    case 'connection': return setConnection(state, action.status)
    case 'topology': return setTopology(state, action.topology)
    case 'clear': return emptyState()
  }
}

export interface UseMedextract {
  state: ProjectState
  serverUrl: string
  setServerUrl: (url: string) => void
  connect: () => void
  paused: boolean
  setPaused: (paused: boolean) => void
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

/** Normalise a server URL for concatenation (strip trailing slash). */
export const trimBase = (url: string): string => url.replace(/\/+$/, '')

export const useMedextract = (initialUrl: string): UseMedextract => {
  const [serverUrl, setServerUrl] = useState(initialUrl)
  const [nonce, setNonce] = useState(0)
  const [paused, setPaused] = useState(false)
  const [models, setModels] = useState<ModelHealth[]>([])
  const [state, dispatch] = useReducer(reducer, undefined, emptyState)

  const pausedRef = useRef(paused)
  const pausedEventsRef = useRef<ActivityEvent[]>([])
  pausedRef.current = paused

  useEffect(() => {
    if (paused || pausedEventsRef.current.length === 0) return
    const events = pausedEventsRef.current.splice(0, pausedEventsRef.current.length)
    dispatch({ type: 'events', events })
  }, [paused])

  useEffect(() => {
    // Events are RMC-batched (rendered once per macrotask). A single feed tick can carry
    // several frames per LLM call; rendering per frame would thrash on a busy server.
    const pending: ActivityEvent[] = []
    let flushScheduled = false

    const flush = () => {
      flushScheduled = false
      if (pending.length === 0) return
      const batch = pending.splice(0, pending.length)
      if (pausedRef.current) pausedEventsRef.current.push(...batch)
      else dispatch({ type: 'events', events: batch })
    }
    const schedule = () => {
      if (flushScheduled) return
      flushScheduled = true
      setTimeout(flush, 0)
    }

    const base = trimBase(serverUrl)
    const client = createSseClient({
      url: `${base}/events`,
      onEvent: (event) => {
        pending.push(event)
        schedule()
      },
      onConnection: (status) => dispatch({ type: 'connection', status }),
    })

    // Seed the configured graph from /health once; the SSE stream is the source of truth
    // for everything after. Best-effort: a server that is still starting has no topology.
    fetch(`${base}/health`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { topology?: TopologySnapshot; models?: ModelHealth[] }) => {
        if (Array.isArray(data.models)) setModels(data.models)
        if (data.topology?.profiles && data.topology?.pipelines) {
          dispatch({ type: 'topology', topology: data.topology })
        }
      })
      .catch(() => {})

    return () => client.close()
  }, [serverUrl, nonce])

  const connect = useCallback(() => setNonce((n) => n + 1), [])
  const clear = useCallback(() => {
    pausedEventsRef.current.length = 0
    dispatch({ type: 'clear' })
  }, [])

  // POST /pipeline owns both decisions: the router chooses a workflow, then the server
  // executes that recipe under one run id. `workflow` is an explicit diagnostic override.
  const run = useCallback(async (input: string, workflow?: string): Promise<unknown> => {
    const res = await fetch(`${trimBase(serverUrl)}/pipeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, ...(workflow ? { workflow } : {}) }),
    })
    if (!res.ok) {
      // The server answers 4xx/5xx with { error: … }; surface that sentence instead of a
      // bare "HTTP 503". The run pre-flight uses 503 exactly so a dark model port becomes
      // "start llama-server …" rather than a loading spinner that never resolves.
      const raw = await res.text().catch(() => '')
      let message = raw || 'run failed'
      try {
        const body = JSON.parse(raw) as { error?: string }
        if (typeof body.error === 'string') message = body.error
      } catch {
        // Not JSON; keep the raw text.
      }
      throw new Error(`HTTP ${res.status}: ${message.slice(0, 300)}`)
    }
    return res.json()
  }, [serverUrl])

  return { state, serverUrl, setServerUrl, connect, paused, setPaused, clear, run, models }
}
