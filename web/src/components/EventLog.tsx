import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityEvent } from '../../../src/core/activity-types.ts'
import type { ProjectState } from '../../../src/tui/state.ts'
import { eventClass, KIND_GROUPS, kindMatches, type KindGroup } from '../lib/format.ts'
import { ChevronDown } from 'lucide-react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './ui/dropdown-menu'

const kindBadgeVariant = (kind: string): 'default' | 'secondary' | 'destructive' => {
  if (kind.startsWith('run.') || kind.startsWith('session.') || kind.startsWith('turn.')) return 'secondary'
  if (kind.startsWith('http.') || kind === 'stage') return 'secondary'
  return 'default'
}

export const EventLog = memo(({ state, onToggle }: { state: ProjectState; onToggle: () => void }) => {
  const [group, setGroup] = useState<KindGroup>('all')
  const [pinned, setPinned] = useState<ActivityEvent | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  const events = useMemo(() => {
    const recent = state.eventLog.slice(-600)
    return group === 'all' ? recent : recent.filter((e) => kindMatches(e.kind, group))
  }, [state.eventLog, group])

  useEffect(() => {
    if (atBottom && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [state.eventLog.length, group, atBottom])

  return (
    <section className="eventlog">
      <header
        className="eventlog-top"
        role="button"
        tabIndex={0}
        aria-expanded="true"
        aria-label="Collapse event log"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onToggle()
          }
        }}
      >
        <div className="eventlog-title">
          <ChevronDown size={15} aria-hidden="true" />
          <span>EVENT LOG</span>
        </div>

        <div className="eventlog-filters" onClick={(event) => event.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                {group === 'all' ? 'All kinds' : group}
                <ChevronDown className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {KIND_GROUPS.map((g) => (
                <DropdownMenuItem
                  key={g}
                  onClick={() => setGroup(g)}
                  className={g === group ? 'bg-accent text-accent-foreground' : ''}
                >
                  {g}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {group !== 'all' && (
            <Button variant="ghost" size="sm" onClick={() => setGroup('all')}>
              clear
            </Button>
          )}
        </div>

        <div className="eventlog-aux" onClick={(event) => event.stopPropagation()}>
          {!atBottom && (
            <Button variant="ghost" size="sm" onClick={() => setAtBottom(true)}>
              jump to latest ▾
            </Button>
          )}
          <span className="eventlog-count">{events.length} shown</span>
        </div>
      </header>

      <div
        className="eventlog-list"
        ref={listRef}
        onScroll={() => {
          const el = listRef.current
          if (!el) return
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
        }}
      >
        {events.length === 0 && <div className="text-muted-foreground/60 text-xs p-2">Listening for metadata-only activity events…</div>}
        {events.map((event) => (
          <div
            key={event.seq}
            className={`ev-row${pinned?.seq === event.seq ? ' ev-pinned' : ''}`}
            onClick={() => setPinned(pinned?.seq === event.seq ? null : event)}
          >
            <span className="ev-time">{event.ts.slice(11, 19)}</span>
            <Badge variant={kindBadgeVariant(event.kind)} className="text-xs px-1.5">
              {event.kind}
            </Badge>
            {event.runId && <span className="ev-run">#{event.runId.slice(0, 6)}</span>}
            {event.requestId && <span className="ev-req">req {event.requestId.slice(0, 8)}</span>}
          </div>
        ))}
      </div>

      {pinned && (
        <div className="ev-detail">
          <div className="flex justify-between items-center px-2.5 py-1 text-primary text-xs bg-background">
            <span>event #{pinned.seq} · {pinned.kind} · {pinned.ts}</span>
            <Button variant="ghost" size="sm" onClick={() => setPinned(null)}>close</Button>
          </div>
          <pre>{JSON.stringify(pinned, null, 2)}</pre>
        </div>
      )}
    </section>
  )
})
