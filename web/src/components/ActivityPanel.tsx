import { memo } from 'react'
import type { ProjectState } from '../../../src/monitor/state.ts'
import { inFlightCount, tokPerSec } from '../../../src/monitor/state.ts'
import { runState, fmtSec } from '../lib/format.ts'
import { Badge } from './ui/badge'
import { Separator } from './ui/separator'
import { Check, Circle, LoaderCircle, X } from 'lucide-react'

/* The pill variants name run states directly now, so this is the identity map for three of
   the four and only has to decide what "done" and "idle" are told apart as. */
const statusVariant = (status: 'active' | 'done' | 'failed' | 'idle') => status

const StatusGlyph = ({ status }: { status: 'active' | 'done' | 'failed' | 'idle' }) =>
  status === 'active' ? <LoaderCircle className="status-spin" /> : status === 'done' ? <Check /> : status === 'failed' ? <X /> : <Circle />

export const ActivityPanel = memo(({ state }: { state: ProjectState }) => {
  const active = inFlightCount(state.llmRequests)
  const runs = [...state.runs.values()].slice(-6).reverse()
  const requests = [...state.llmRequests.values()].slice(-6).reverse()

  return (
    <div className="activity-feed">
      <div className="activity-summary">
        <Badge variant={active > 0 ? 'active' : 'idle'}>
          <StatusGlyph status={active > 0 ? 'active' : 'idle'} />
        </Badge>
        {/* In-flight work is a measured statement the operator reads, so it is ink rather than
            the accent; the pill beside it is what carries the state, and it carries a glyph. */}
        <span className={active > 0 ? 'text-foreground' : 'text-muted-foreground'}>
          {active > 0 ? `${active} model request${active === 1 ? '' : 's'} in flight` : 'Standing by for work'}
        </span>
      </div>

      <h3 className="drawer-section-title">Recent runs</h3>
      {state.runs.size === 0 && (
        <div className="text-sm text-foreground">
          <div>No runs yet.</div>
          <div className="text-muted-foreground text-xs">The six most recent stay here once they finish.</div>
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

      <Separator className="my-3" />

      <h3 className="drawer-section-title">Model requests</h3>
      {state.llmRequests.size === 0 && <div className="drawer-empty">No model requests yet.</div>}
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
