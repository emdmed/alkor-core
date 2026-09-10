import { memo } from 'react'
import type { ProjectState } from '../../../src/tui/state.ts'
import { inFlightCount, tokPerSec } from '../../../src/tui/state.ts'
import { runState, fmtSec } from '../lib/format.ts'
import { Badge } from './ui/badge'
import { Separator } from './ui/separator'
import { Check, Circle, LoaderCircle, X } from 'lucide-react'

const statusVariant = (status: 'active' | 'done' | 'failed' | 'idle'): 'default' | 'secondary' | 'destructive' =>
  status === 'active' ? 'default' : status === 'failed' ? 'destructive' : 'secondary'

const StatusGlyph = ({ status }: { status: 'active' | 'done' | 'failed' | 'idle' }) =>
  status === 'active' ? <LoaderCircle className="status-spin" /> : status === 'done' ? <Check /> : status === 'failed' ? <X /> : <Circle />

export const ActivityPanel = memo(({ state }: { state: ProjectState }) => {
  const active = inFlightCount(state.llmRequests)
  const runs = [...state.runs.values()].slice(-6).reverse()
  const requests = [...state.llmRequests.values()].slice(-6).reverse()

  return (
    <div className="activity-feed">
      <div className="activity-summary">
        <Badge variant={active > 0 ? 'default' : 'secondary'}>
          <StatusGlyph status={active > 0 ? 'active' : 'idle'} />
        </Badge>
        <span className={active > 0 ? 'text-primary' : 'text-muted-foreground'}>
          {active > 0 ? `${active} model request${active === 1 ? '' : 's'} in flight` : 'Standing by for work'}
        </span>
      </div>

      <h3 className="drawer-section-title">Recent runs</h3>
      {state.runs.size === 0 && (
        <div className="text-sm text-foreground">
          <div>No runs have arrived yet.</div>
          <div className="text-muted-foreground text-xs">Completed work will stay visible here.</div>
        </div>
      )}
      {runs.map((run) => {
        const state = runState(run.status)
        return (
          <div key={run.runId} className="drawer-item">
            <div className="drawer-item-row">
              <Badge variant={statusVariant(state)}><StatusGlyph status={state} /></Badge>
              <span className="drawer-item-name">{run.profile}</span>
            </div>
            <div className="drawer-item-detail">
              #{run.runId.slice(0, 6)} · {run.status}
              {run.wallMs != null && <> · {fmtSec(run.wallMs)}</>}
            </div>
          </div>
        )
      })}

      <Separator className="my-2.5" />

      <h3 className="drawer-section-title">Model requests</h3>
      {state.llmRequests.size === 0 && <div className="drawer-empty">No model requests observed.</div>}
      {requests.map((request) => {
        const status = request.status === 'in-flight' ? 'active' : request.status === 'error' ? 'failed' : 'done'
        const tps = request.status === 'completed' ? tokPerSec(request) : undefined
        return (
          <div key={request.requestId} className="drawer-item">
            <div className="drawer-item-row">
              <Badge variant={statusVariant(status)}><StatusGlyph status={status} /></Badge>
              <span className="drawer-item-name">{request.label}</span>
            </div>
            <div className="drawer-item-detail">
              {request.constrained ? 'constrained' : 'unconstrained'}
              {tps != null && <> · {tps.toFixed(0)} tok/s</>}
              {request.wallMs != null && <> · {fmtSec(request.wallMs)}</>}
            </div>
          </div>
        )
      })}
    </div>
  )
})
