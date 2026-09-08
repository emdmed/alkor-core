import type { ProjectState } from '../../../src/tui/state.ts'
import { inFlightCount, tokPerSec } from '../../../src/tui/state.ts'
import { runState, fmtSec } from '../lib/format.ts'
import { Panel } from './Panel.tsx'
import { Badge } from './ui/badge'
import { Separator } from './ui/separator'

const statusVariant = (status: 'active' | 'done' | 'failed' | 'idle'): 'default' | 'secondary' | 'destructive' =>
  status === 'active' ? 'default' : status === 'failed' ? 'destructive' : 'secondary'

const statusLabel = (status: 'active' | 'done' | 'failed' | 'idle'): string =>
  status === 'active' ? '●' : status === 'done' ? '✓' : status === 'failed' ? '×' : '○'

export const ActivityPanel = ({ state }: { state: ProjectState }) => {
  const active = inFlightCount(state.llmRequests)
  const runs = [...state.runs.values()].slice(-6).reverse()
  const requests = [...state.llmRequests.values()].slice(-6).reverse()

  return (
    <Panel title="LIVE ACTIVITY">
      <div className="flex items-center gap-1 pb-2">
        <Badge variant={active > 0 ? 'default' : 'secondary'}>
          {statusLabel(active > 0 ? 'active' : 'idle')}
        </Badge>
        <span className={active > 0 ? 'text-primary' : 'text-muted-foreground'}>
          {active > 0 ? `${active} model request${active === 1 ? '' : 's'} in flight` : 'Standing by for work'}
        </span>
      </div>

      <h3 className="text-xs font-semibold text-primary tracking-wide uppercase mb-1 mt-2 first:mt-1">
        RECENT RUNS
      </h3>
      {state.runs.size === 0 && (
        <div className="text-sm text-foreground">
          <div>No runs have arrived yet.</div>
          <div className="text-muted-foreground text-xs">Completed work will stay visible here.</div>
        </div>
      )}
      {runs.map((run) => {
        const state = runState(run.status)
        return (
          <div key={run.runId} className="mb-1.5">
            <div className="flex items-center gap-1.5">
              <Badge variant={statusVariant(state)}>{statusLabel(state)}</Badge>
              <span className="text-foreground text-sm">{run.profile}</span>
            </div>
            <div className="text-xs text-muted-foreground ml-6">
              #{run.runId.slice(0, 6)} · {run.status}
              {run.wallMs != null && <> · {fmtSec(run.wallMs)}</>}
            </div>
          </div>
        )
      })}

      <Separator className="my-2.5" />

      <h3 className="text-xs font-semibold text-primary tracking-wide uppercase mb-1">
        MODEL REQUESTS
      </h3>
      {state.llmRequests.size === 0 && <div className="text-muted-foreground text-xs">No model requests observed.</div>}
      {requests.map((request) => {
        const status = request.status === 'in-flight' ? 'active' : request.status === 'error' ? 'failed' : 'done'
        const tps = request.status === 'completed' ? tokPerSec(request) : undefined
        return (
          <div key={request.requestId} className="mb-1.5">
            <div className="flex items-center gap-1.5">
              <Badge variant={statusVariant(status)}>{statusLabel(status)}</Badge>
              <span className="text-foreground text-sm">{request.label}</span>
            </div>
            <div className="text-xs text-muted-foreground ml-6">
              {request.constrained ? 'constrained' : 'unconstrained'}
              {tps != null && <> · {tps.toFixed(0)} tok/s</>}
              {request.wallMs != null && <> · {fmtSec(request.wallMs)}</>}
            </div>
          </div>
        )
      })}
    </Panel>
  )
}