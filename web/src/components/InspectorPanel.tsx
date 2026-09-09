import type { ProjectState, StageEntry } from '../../../src/tui/state.ts'
import { stageTreeForRun } from '../../../src/tui/state.ts'
import { fmtSec, type NodeState } from '../lib/format.ts'
import { Badge } from './ui/badge'
import { Check, Circle, LoaderCircle, X } from 'lucide-react'

const nodeVariant = (s: NodeState): 'default' | 'secondary' | 'destructive' =>
  s === 'active' ? 'default' : s === 'failed' ? 'destructive' : 'secondary'

const StatusGlyph = ({ status }: { status: NodeState }) =>
  status === 'active' ? <LoaderCircle className="status-spin" /> : status === 'done' ? <Check /> : status === 'failed' ? <X /> : <Circle />

export const InspectorPanel = ({ state }: { state: ProjectState }) => {
  const sessions = [...state.sessions.values()].slice(-6).reverse()
  const latestRunId = [...state.runs.values()].reverse()[0]?.runId
  const stages = latestRunId ? stageTreeForRun(state.stages, latestRunId) : []
  const tools = state.tools.slice(-12).reverse()
  const routes = state.routes.slice(-10).reverse()
  const http = state.httpLog.slice(-12).reverse()

  return (
    <div className="inspector-feed">
      <p className="drawer-summary">Run structure, routing decisions, and transport metadata.</p>
      <h3 className="drawer-section-title">Sessions</h3>
      {sessions.length === 0 && <div className="drawer-empty">No sessions opened yet.</div>}
      {sessions.map((session) => (
        <div key={session.sessionId} className="drawer-item">
          <div className="drawer-item-row">
            <Badge variant={session.destroyed ? 'secondary' : 'default'}>
              {session.destroyed ? <X /> : <Circle />}
            </Badge>
            <span className="drawer-item-name">{session.profile}</span>
            <span className="drawer-item-id">#{session.sessionId.slice(0, 8)}</span>
            {session.destroyed && <span className="drawer-item-meta">destroyed</span>}
          </div>
          {session.turns.length > 0 && (
            <div className="drawer-item-detail">
              {session.turns.map((t) => `#${t.turn}${t.stop ? ` ${t.stop}` : ''}${t.usage ? ` ${t.usage.totalTokens} tok` : ''}`).join(' · ')}
            </div>
          )}
        </div>
      ))}

      <h3 className="drawer-section-title">Stages {latestRunId ? <span>run #{latestRunId.slice(0, 6)}</span> : null}</h3>
      {stages.length === 0 && <div className="drawer-empty">No stage traffic for the latest run.</div>}
      {stages.map((stage) => (
        <StageNode key={stage.stageId} stage={stage} />
      ))}

      <h3 className="drawer-section-title">Tools</h3>
      {tools.length === 0 && <div className="drawer-empty">No tool calls observed.</div>}
      <div className="drawer-badges">
        {tools.map((tool, i) => {
          const status: NodeState = tool.status === 'called' ? 'active' : tool.status === 'declined' ? 'failed' : 'done'
          return (
            <Badge key={i} variant={nodeVariant(status)}>
              <StatusGlyph status={status} /> {tool.name}
            </Badge>
          )
        })}
      </div>

      <h3 className="drawer-section-title">Routes</h3>
      {routes.length === 0 && <div className="drawer-empty">No routing decisions observed.</div>}
      {routes.map((route, i) => (
        <div key={i} className="drawer-data-row">
          <span className={route.ruleVsModel === 'model' ? 'text-primary' : 'text-foreground'}>{route.profile}</span>
          <span>{Math.round(route.confidence * 100)}% · {route.ruleVsModel} · {route.reason}</span>
        </div>
      ))}

      <h3 className="drawer-section-title">HTTP</h3>
      {http.length === 0 && <div className="drawer-empty">No local HTTP traffic observed.</div>}
      {http.map((req, i) => (
        <div key={i} className="drawer-data-row">
          <span>{req.method}</span> <b>{req.path}</b>
          {req.status != null && <span className={req.status >= 400 ? 'text-destructive' : 'text-primary'}> {req.status}</span>}
          {req.wallMs != null && <span>· {fmtSec(req.wallMs)}</span>}
        </div>
      ))}
    </div>
  )
}

const StageNode = ({ stage }: { stage: StageEntry }) => {
  const status: NodeState = stage.status === 'started' ? 'active' : 'done'
  return (
    <div className="stage-tree-item">
      <div className="drawer-item-row">
        <Badge variant={nodeVariant(status)}><StatusGlyph status={status} /></Badge>
        <span className="drawer-item-name">{stage.name}</span>
        {stage.wallMs != null && <span className="drawer-item-meta">{fmtSec(stage.wallMs)}</span>}
      </div>
      {stage.detail != null && <div className="drawer-item-detail">{stageDetailText(stage.detail)}</div>}
      {stage.children.length > 0 && (
        <div className="stage-tree-children">
          {stage.children.map((child) => (
            <StageNode key={child.stageId} stage={child} />
          ))}
        </div>
      )}
    </div>
  )
}

const stageDetailText = (detail: unknown): string => {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
  return text.length <= 72 ? text : `${text.slice(0, 69)}…`
}
