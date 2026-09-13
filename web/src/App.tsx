import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react'
import { Header } from './components/Header.tsx'
import { ActivityPanel } from './components/ActivityPanel.tsx'
import { InspectorPanel } from './components/InspectorPanel.tsx'
import { EventLog } from './components/EventLog.tsx'
import { RunPanel } from './components/RunPanel.tsx'
import { SideRail, readRailWidth, type RailTab } from './components/SideRail.tsx'
import { useAlkor } from './hooks/useAlkor.ts'
import type { GraphNodeData } from './lib/graph/index.ts'

// The ReactFlow graph is the heavy part of the shell. Lazy-load it into its own chunk
// so the shell paints fast and the graph chunk arrives behind it (preloaded below).
const PipelineGraph = lazy(async () => {
  const mod = await import('./components/graph/PipelineGraph.tsx')
  return { default: mod.PipelineGraph }
})

const DEFAULT_URL = (import.meta.env.VITE_ALKOR_URL as string | undefined) ?? 'http://127.0.0.1:3000'

const NARROW = '(max-width: 899px)'

/** Match a media query against the live viewport and keep listening for changes. */
const useMedia = (query: string) => {
  const [matches, setMatches] = useState(
    () => typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    setMatches(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/**
 * The workspace is two zones: the canvas, and one rail beside it.
 *
 * Everything that is not the graph — sending a run, watching requests, inspecting a node,
 * reading the feed — is a tab in that rail. The rail collapses to a strip of icons, so
 * the canvas can have the whole window without any of it becoming unreachable.
 */
export const App = () => {
  const { state, serverUrl, activeUrl, setServerUrl, connect, paused, setPaused, clear, run, models, harness } = useAlkor(DEFAULT_URL)
  const isNarrow = useMedia(NARROW)

  const [railOpen, setRailOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia(NARROW).matches)
  const [railTab, setRailTab] = useState<RailTab>('run')
  const [railWidth, setRailWidth] = useState(readRailWidth)
  const [inspected, setInspected] = useState<GraphNodeData | null>(null)
  const [selectedWorkflow, setSelectedWorkflow] = useState('')
  const lastFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const pipelines = state.topology.workflows
    if (pipelines.some((pipeline) => pipeline.name === selectedWorkflow)) return
    setSelectedWorkflow(pipelines[0]?.name ?? '')
  }, [selectedWorkflow, state.topology.workflows])

  // On a narrow viewport the rail overlays the canvas, so it starts out of the way.
  useEffect(() => {
    if (isNarrow) setRailOpen(false)
  }, [isNarrow])

  // Declared here rather than inline at the call site: the log tab renders conditionally,
  // and a hook inside that branch would be a hook called conditionally.
  const clearInspected = useCallback(() => setInspected(null), [])

  // Clicking a node is a question about that node: answer it in the inspector, and
  // remember where the click came from so Escape can hand focus back.
  const openInspector = useCallback((data: GraphNodeData) => {
    const el = document.activeElement
    if (el instanceof HTMLElement) lastFocus.current = el
    setInspected(data)
    setRailTab('inspector')
    setRailOpen(true)
  }, [])

  // The graph is primary: warm its chunk as soon as the shell mounts so the first
  // topology frame is always rendered by the real component, never a long spinner.
  useEffect(() => {
    void import('./components/graph/PipelineGraph.tsx')
  }, [])

  // Escape collapses the rail and returns focus to whoever opened it.
  useEffect(() => {
    if (!railOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setRailOpen(false)
      lastFocus.current?.focus()
      lastFocus.current = null
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [railOpen])

  return (
    <div className="app">
      <Header
        state={state}
        serverUrl={serverUrl}
        onServerUrlChange={setServerUrl}
        onConnect={connect}
        paused={paused}
        onTogglePause={useCallback(() => setPaused(!paused), [paused])}
        onClear={clear}
        models={models}
        harness={harness}
      />
      <main className={`workspace${isNarrow && railOpen ? ' is-rail-overlay' : ''}`}>
        <div className="stage">
          <Suspense fallback={<GraphLoadingSurface />}>
            <PipelineGraph
              state={state}
              selectedWorkflow={selectedWorkflow}
              onSelectedWorkflowChange={setSelectedWorkflow}
              onInspect={openInspector}
            />
          </Suspense>
        </div>
        <SideRail
          open={railOpen}
          tab={railTab}
          width={railWidth}
          onTabChange={setRailTab}
          onOpenChange={setRailOpen}
          onWidthChange={setRailWidth}
          logCount={state.eventLog.length}
        >
          {railTab === 'run' && <RunPanel state={state} run={run} serverUrl={activeUrl} />}
          {railTab === 'activity' && (
            <div className="rail-scroll"><ActivityPanel state={state} /></div>
          )}
          {railTab === 'inspector' && (
            <div className="rail-scroll">
              {inspected ? <InspectedHeader data={inspected} /> : <p className="rail-hint">Click any node on the canvas to inspect it.</p>}
              <InspectorPanel state={state} />
            </div>
          )}
          {/* One selection, three surfaces: the canvas highlights the node, the inspector
              describes it, and the feed narrows to what it produced. */}
          {railTab === 'log' && (
            <EventLog state={state} selected={inspected} onClearSelection={clearInspected} />
          )}
        </SideRail>
      </main>
    </div>
  )
}

/** Labelled surface shown while the graph chunk loads. */
const GraphLoadingSurface = () => (
  <div className="graph-loading-surface" role="status" aria-live="polite" aria-label="Loading graph">
    <div className="graph-loading-copy">
      <span className="graph-loading-title">Loading workflow graph</span>
      <span className="graph-loading-note">rendering topology…</span>
    </div>
  </div>
)

const InspectedHeader = ({ data }: { data: GraphNodeData }) => (
  <div className="inspected">
    <div className="inspected-kind">
      {data.kind} · {data.status}
    </div>
    <div className="inspected-label">{data.label}</div>
    {data.profile && <div className="inspected-meta">profile {data.profile}</div>}
    {data.stepNo != null && <div className="inspected-meta">step {data.stepNo + 1}</div>}
    {data.wallMs != null && <div className="inspected-meta">{(data.wallMs / 1000).toFixed(1)}s</div>}
    {data.confidence != null && <div className="inspected-meta">confidence {(data.confidence * 100).toFixed(0)}%</div>}
    {data.inputRef && <div className="inspected-meta">uses {data.inputRef === 'initial' ? 'original input' : data.inputRef}</div>}
    {data.shape && <div className="inspected-meta">shape {data.shape}</div>}
    {data.task && <div className="inspected-meta">task {data.task}</div>}
    {data.runId && <div className="inspected-meta muted">run {data.runId.slice(0, 8)}</div>}
    {data.detail != null && <pre className="inspected-json">{JSON.stringify(data.detail, null, 2)}</pre>}
  </div>
)
