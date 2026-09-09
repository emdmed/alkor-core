import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronUp } from 'lucide-react'
import { Header } from './components/Header.tsx'
import { StatusStrip } from './components/StatusStrip.tsx'
import { PipelineGraph } from './components/graph/PipelineGraph.tsx'
import { ActivityPanel } from './components/ActivityPanel.tsx'
import { InspectorPanel } from './components/InspectorPanel.tsx'
import { Drawer } from './components/Drawer.tsx'
import { EventLog } from './components/EventLog.tsx'
import { ChatPanel } from './components/ChatPanel.tsx'
import { useMedextract } from './hooks/useMedextract.ts'
import type { GraphNodeData } from './lib/graph.ts'

const DEFAULT_URL = (import.meta.env.VITE_MEDEXTRACT_URL as string | undefined) ?? 'http://127.0.0.1:3000'

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

const WIDE = '(min-width: 1360px)'
const NARROW = '(max-width: 759px)'

export const App = () => {
  const { state, serverUrl, setServerUrl, connect, paused, setPaused, clear, run, models } = useMedextract(DEFAULT_URL)
  const isWide = useMedia(WIDE)
  const isNarrow = useMedia(NARROW)

  // Shell modes (see dashboard_improvement.md):
  //  wide      — run panel may stay open; the drawer may reserve its footprint.
  //  intermediate — the drawer overlays; the run panel defaults collapsed.
  //  narrow    — the run panel and drawer are coordinated overlays: one open, one closed.
  const [chatOpen, setChatOpen] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(WIDE).matches,
  )
  const [rightOpen, setRightOpen] = useState(false)
  const [rightTab, setRightTab] = useState<'activity' | 'inspector'>('activity')
  const [logOpen, setLogOpen] = useState(false)
  const [inspected, setInspected] = useState<GraphNodeData | null>(null)
  const [selectedPipeline, setSelectedPipeline] = useState('')
  const lastFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const pipelines = state.topology.pipelines
    if (pipelines.some((pipeline) => pipeline.name === selectedPipeline)) return
    setSelectedPipeline(pipelines[0]?.name ?? '')
  }, [selectedPipeline, state.topology.pipelines])

  // The run panel can no longer lean on the graph once the viewport stops being wide.
  useEffect(() => {
    if (!isWide) setChatOpen(false)
  }, [isWide])

  const rememberFocus = () => {
    const el = document.activeElement
    if (el instanceof HTMLElement) lastFocus.current = el
  }

  const openInspector = (data: GraphNodeData) => {
    if (isNarrow && chatOpen) setChatOpen(false)
    rememberFocus()
    setInspected(data)
    setRightTab('inspector')
    setRightOpen(true)
  }

  const toggleActivity = () => {
    if (!rightOpen || rightTab !== 'activity') {
      if (isNarrow && chatOpen) setChatOpen(false)
      rememberFocus()
      setRightTab('activity')
      setRightOpen(true)
    } else {
      setRightOpen(false)
    }
  }

  const toggleInspector = () => {
    if (!rightOpen || rightTab !== 'inspector') {
      if (isNarrow && chatOpen) setChatOpen(false)
      rememberFocus()
      setRightTab('inspector')
      setRightOpen(true)
    } else {
      setRightOpen(false)
    }
  }

  const toggleChat = () => {
    if (!chatOpen) {
      if (isNarrow && rightOpen) setRightOpen(false)
      rememberFocus()
      setChatOpen(true)
    } else {
      setChatOpen(false)
    }
  }

  // Escape closes the topmost overlay and returns focus to whoever opened it.
  const closePanel = useCallback((close: 'top' | 'chat') => {
    if (close === 'chat') setChatOpen(false)
    setRightOpen(false)
    lastFocus.current?.focus()
    lastFocus.current = null
  }, [])

  useEffect(() => {
    if (!rightOpen && !chatOpen && !logOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (chatOpen) closePanel('chat')
      else if (rightOpen) closePanel('top')
      else setLogOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rightOpen, chatOpen, logOpen, closePanel])

  return (
    <div className="app">
      <Header
        state={state}
        serverUrl={serverUrl}
        onServerUrlChange={setServerUrl}
        onConnect={connect}
        paused={paused}
        onTogglePause={() => setPaused(!paused)}
        onClear={clear}
        models={models}
      />
      <StatusStrip state={state} />
      <main className="graph-main">
        <ChatPanel
          open={chatOpen}
          onToggle={toggleChat}
          state={state}
          run={run}
          selectedProfile={selectedPipeline}
          onSelectedProfileChange={setSelectedPipeline}
          onOpenActivity={isNarrow ? toggleActivity : undefined}
        />
        <div className="graph-area">
          <PipelineGraph
            state={state}
            selectedPipeline={selectedPipeline}
            onSelectedPipelineChange={setSelectedPipeline}
            onInspect={openInspector}
            onToggleActivity={toggleActivity}
            onToggleLog={() => setLogOpen((v) => !v)}
            activityOpen={rightOpen && rightTab === 'activity'}
            logOpen={logOpen}
          />
        </div>
        <Drawer open={rightOpen} onClose={() => setRightOpen(false)} title={rightTab === 'activity' ? 'LIVE ACTIVITY' : 'INSPECTOR'}>
          {rightTab === 'activity' ? (
            <ActivityPanel state={state} />
          ) : (
            <>
              {inspected && <InspectedHeader data={inspected} />}
              <InspectorPanel state={state} />
            </>
          )}
        </Drawer>
      </main>
      <div className="graph-logbar">
        {logOpen ? (
          <EventLog state={state} onToggle={() => setLogOpen(false)} />
        ) : (
          <button className="log-reopen" onClick={() => setLogOpen(true)}>
            <ChevronUp aria-hidden="true" /> Event log <span>Open</span>
          </button>
        )}
      </div>
    </div>
  )
}

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
