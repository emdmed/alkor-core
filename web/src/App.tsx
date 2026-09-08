import { useState } from 'react'
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

export const App = () => {
  const { state, serverUrl, setServerUrl, connect, paused, setPaused, clear, run, models } = useMedextract(DEFAULT_URL)
  // The graph is the primary workspace. Keep the supporting drawer available,
  // but do not take a third of the canvas before the operator asks for it.
  const [rightOpen, setRightOpen] = useState(false)
  const [rightTab, setRightTab] = useState<'activity' | 'inspector'>('activity')
  const [chatOpen, setChatOpen] = useState(true)
  const [logOpen, setLogOpen] = useState(true)
  const [inspected, setInspected] = useState<GraphNodeData | null>(null)

  const openInspector = (data: GraphNodeData) => {
    setInspected(data)
    setRightTab('inspector')
    setRightOpen(true)
  }

  const toggleActivity = () => {
    if (!rightOpen || rightTab !== 'activity') {
      setRightTab('activity')
      setRightOpen(true)
    } else {
      setRightOpen(false)
    }
  }

  const toggleInspector = () => {
    if (!rightOpen || rightTab !== 'inspector') {
      setRightTab('inspector')
      setRightOpen(true)
    } else {
      setRightOpen(false)
    }
  }

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
        <ChatPanel open={chatOpen} onToggle={() => setChatOpen((v) => !v)} state={state} run={run} />
        <div className="graph-area">
          <PipelineGraph
            state={state}
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
            ▂ EVENT LOG · reopen
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
