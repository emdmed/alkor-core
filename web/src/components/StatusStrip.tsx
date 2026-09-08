import type { ProjectState } from '../../../src/tui/state.ts'
import { cacheHitRatio, failureRate, inFlightCount } from '../../../src/tui/state.ts'
import { Badge } from './ui/badge'

export const StatusStrip = ({ state }: { state: ProjectState }) => {
  const active = inFlightCount(state.llmRequests)
  const finished = [...state.runs.values()].filter((r) => r.status !== 'started').length
  const failures = failureRate(state.runs)
  const cache = cacheHitRatio(state.llmRequests)
  const sessions = state.sessions.size
  const http = state.httpLog.length
  const events = state.eventLog.length

  return (
    <div className="status-strip flex items-center gap-1.5 px-3 border-b border-border bg-card text-xs">
      <Badge variant={active > 0 ? 'default' : 'secondary'}>
        {active} active request{active === 1 ? '' : 's'}
      </Badge>
      <Badge variant="secondary">
        {finished} completed run{finished === 1 ? '' : 's'}
      </Badge>
      {finished > 0 && (
        <Badge variant={failures > 0 ? 'destructive' : 'secondary'}>
          {Math.round(failures * 100)}% failure
        </Badge>
      )}
      {cache != null && (
        <Badge variant="default">
          {Math.round(cache * 100)}% prompt cache
        </Badge>
      )}
      <Badge variant="secondary">{sessions} session{sessions === 1 ? '' : 's'}</Badge>
      <Badge variant="secondary">{http} http · {events} events</Badge>
    </div>
  )
}
