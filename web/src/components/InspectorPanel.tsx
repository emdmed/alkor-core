import type { ProjectState, StageEntry } from '../../../src/tui/state.ts'
import { stageTreeForRun } from '../../../src/tui/state.ts'
import { fmtSec, type NodeState } from '../lib/format.ts'
import { Panel } from './Panel.tsx'
import { Badge } from './ui/badge'

const nodeVariant = (s: NodeState): 'default' | 'secondary' | 'destructive' =>
  s === 'active' ? 'default' : s === 'failed' ? 'destructive' : 'secondary'

const nodeGlyph = (s: NodeState): string =>
  s === 'active' ? '●' : s === 'done' ? '✓' : s === 'failed' ? '×' : '○'

export const InspectorPanel = ({ state }: { state: ProjectState }) => {
  const sessions = [...state.sessions.values()].slice(-6).reverse()
  const latestRunId = [...state.runs.values()].reverse()[0]?.runId
  const stages = latestRunId ? stageTreeForRun(state.stages, latestRunId) : []
  const tools = state.tools.slice(-12).reverse()
  const routes = state.routes.slice(-10).reverse()
  const http = state.httpLog.slice(-12).reverse()

  return (
    <Panel title="INSPECTOR" subtitle="sessions · stages · tools · routes · http">
      <h3 className="text-xs font-semibold text-primary tracking-wide uppercase mb-1 mt-1 first:mt-0">SESSIONS</h3>
      {sessions.length === 0 && <div className="text-muted-foreground/60 text-xs">No sessions opened yet.</div>}
      {sessions.map((session) => (
        <div key={session.sessionId} className="mb-1.5">
          <div className="flex items-center gap-1.5">
            <Badge variant={session.destroyed ? 'secondary' : 'default'}>
              {session.destroyed ? '×' : '●'}
            </Badge>
            <span className="text-foreground text-sm">{session.profile}</span>
            <span className="text-muted-foreground/60 text-xs">#{session.sessionId.slice(0, 8)}</span>
            {session.destroyed && <span className="text-muted-foreground/60 text-xs">· destroyed</span>}
          </div>
          {session.turns.length > 0 && (
            <div className="text-xs text-muted-foreground ml-6">
              {session.turns.map((t) => `#${t.turn}${t.stop ? ` ${t.stop}` : ''}${t.usage ? ` ${t.usage.totalTokens} tok` : ''}`).join(' · ')}
            </div>
          )}
        </div>
      ))}

      <h3 className="text-xs font-semibold text-primary tracking-wide uppercase mb-1 mt-2">STAGES {latestRunId ? `· run ${latestRunId.slice(0, 6)}` : ''}</h3>
      {stages.length === 0 && <div className="text-muted-foreground/60 text-xs">No stage traffic for the latest run.</div>}
      {stages.map((stage) => (
        <StageNode key={stage.stageId} stage={stage} />
      ))}

      <h3 className="text-xs font-semibold text-primary tracking-wide uppercase mb-1 mt-2">TOOLS</h3>
      {tools.length === 0 && <div className="text-muted-foreground/60 text-xs">No tool calls observed.</div>}
      <div className="flex flex-wrap gap-1.5">
        {tools.map((tool, i) => {
          const status: NodeState = tool.status === 'called' ? 'active' : tool.status === 'declined' ? 'failed' : 'done'
          return (
            <Badge key={i} variant={nodeVariant(status)}>
              {nodeGlyph(status)} {tool.name}
            </Badge>
          )
        })}
      </div>

      <h3 className="text-xs font-semibold text-primary tracking-wide uppercase mb-1 mt-2">ROUTES</h3>
      {routes.length === 0 && <div className="text-muted-foreground/60 text-xs">No routing decisions observed.</div>}
      {routes.map((route, i) => (
        <div key={i} className="text-xs">
          <span className={route.ruleVsModel === 'model' ? 'text-primary' : 'text-foreground'}>{route.profile}</span>
          <span className="text-muted-foreground"> · {Math.round(route.confidence * 100)}% · {route.ruleVsModel} · {route.reason}</span>
        </div>
      ))}

      <h3 className="text-xs font-semibold text-primary tracking-wide uppercase mb-1 mt-2">HTTP</h3>
      {http.length === 0 && <div className="text-muted-foreground/60 text-xs">No local HTTP traffic observed.</div>}
      {http.map((req, i) => (
        <div key={i} className="text-xs">
          <span className="text-muted-foreground">{req.method}</span> {req.path}
          {req.status != null && <span className={req.status >= 400 ? 'text-destructive' : 'text-primary'}> {req.status}</span>}
          {req.wallMs != null && <span className="text-muted-foreground/60"> · {fmtSec(req.wallMs)}</span>}
        </div>
      ))}
    </Panel>
  )
}

const StageNode = ({ stage }: { stage: StageEntry }) => {
  const status: NodeState = stage.status === 'started' ? 'active' : 'done'
  return (
    <div className="my-0.5">
      <div className="flex items-center gap-1.5">
        <Badge variant={nodeVariant(status)}>{nodeGlyph(status)}</Badge>
        <span className="text-foreground text-sm">{stage.name}</span>
        {stage.wallMs != null && <span className="text-muted-foreground text-xs"> · {fmtSec(stage.wallMs)}</span>}
        {stage.detail != null && <span className="text-muted-foreground/60 text-xs"> · {stageDetailText(stage.detail)}</span>}
      </div>
      {stage.children.length > 0 && (
        <div className="ml-3.5 border-l border-border pl-2">
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