import { memo } from 'react'
import type { ProjectState } from '../../../src/tui/state.ts'
import { cacheHitRatio, failureRate, inFlightCount } from '../../../src/tui/state.ts'
import { Activity, CircleCheck, Gauge, Network, Radio, TimerReset } from 'lucide-react'
import type { ReactNode } from 'react'

export const StatusStrip = memo(({ state }: { state: ProjectState }) => {
  const active = inFlightCount(state.llmRequests)
  const finished = [...state.runs.values()].filter((r) => r.status !== 'started').length
  const failures = failureRate(state.runs)
  const cache = cacheHitRatio(state.llmRequests)
  const sessions = state.sessions.size
  const http = state.httpLog.length
  const events = state.eventLog.length

  return (
    <dl className="status-strip" aria-label="Workspace metrics">
      <Metric icon={<Radio />} value={active} label="active" live={active > 0} />
      <Metric icon={<CircleCheck />} value={finished} label="completed" />
      {finished > 0 && <Metric icon={<Gauge />} value={`${Math.round(failures * 100)}%`} label="failure" danger={failures > 0} />}
      {cache != null && <Metric icon={<TimerReset />} value={`${Math.round(cache * 100)}%`} label="cache" />}
      <Metric icon={<Network />} value={sessions} label={sessions === 1 ? 'session' : 'sessions'} />
      <Metric icon={<Activity />} value={http} label="http" detail={`${events} events`} />
    </dl>
  )
})

const Metric = ({ icon, value, label, detail, live, danger }: {
  icon: ReactNode
  value: string | number
  label: string
  detail?: string
  live?: boolean
  danger?: boolean
}) => (
  <div className={`status-metric${live ? ' is-live' : ''}${danger ? ' is-danger' : ''}`}>
    <span className="status-icon" aria-hidden="true">{icon}</span>
    <dd>{value}</dd>
    <dt>{label}</dt>
    {detail && <span className="status-detail">{detail}</span>}
  </div>
)