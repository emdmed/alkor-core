/**
 * EventLog — the raw feed, as the rail's last tab.
 *
 * It used to be a full-width dock below the graph with its own collapse header. The rail
 * owns opening and closing now, so what is left here is the log itself: a filter, the
 * volume it is drawn from, the rows, and the one row you pinned.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityEvent } from '../../../src/core/activity-types.ts'
import type { ProjectState } from '../../../src/tui/state.ts'
import { eventClass, KIND_GROUPS, kindMatches, type KindGroup } from '../lib/format.ts'
import { ChevronDown, X } from 'lucide-react'
import { Button } from './ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem } from './ui/dropdown-menu'

export const EventLog = memo(({ state }: { state: ProjectState }) => {
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
    <div className="eventlog">
      <div className="eventlog-bar">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {group === 'all' ? 'All kinds' : group}
              <ChevronDown className="text-muted-foreground" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            {KIND_GROUPS.map((g) => (
              <DropdownMenuCheckboxItem key={g} checked={g === group} onCheckedChange={() => setGroup(g)}>
                {g}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Feed volume reads where the feed is read, not in the header. Sessions are not
            counted here — the inspector lists them, and this line has to survive a rail
            narrow enough to be worth having. */}
        <span className="eventlog-volume">
          {events.length} of {state.eventLog.length} · {state.httpLog.length} http
        </span>

        {!atBottom && (
          <Button variant="ghost" size="sm" className="eventlog-jump" onClick={() => setAtBottom(true)}>
            Latest
          </Button>
        )}
      </div>

      <div
        className="eventlog-list"
        ref={listRef}
        onScroll={() => {
          const el = listRef.current
          if (!el) return
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
        }}
      >
        {events.length === 0 && (
          <p className="eventlog-empty">
            {state.eventLog.length === 0
              ? 'Listening for activity. Events appear here as the server emits them.'
              : `No ${group} events in the last ${state.eventLog.length}.`}
          </p>
        )}
        {events.map((event) => (
          <button
            type="button"
            key={event.seq}
            className={`ev-row${pinned?.seq === event.seq ? ' ev-pinned' : ''}`}
            aria-pressed={pinned?.seq === event.seq}
            onClick={() => setPinned(pinned?.seq === event.seq ? null : event)}
          >
            <span className="ev-time">{event.ts.slice(11, 19)}</span>
            <span className={`ev-kind ${eventClass(event.kind)}`}>{event.kind}</span>
            {event.runId && <span className="ev-id">#{event.runId.slice(0, 6)}</span>}
            {event.requestId && <span className="ev-id">req {event.requestId.slice(0, 8)}</span>}
          </button>
        ))}
      </div>

      {pinned && (
        <div className="ev-detail">
          <div className="ev-detail-head">
            <span>event #{pinned.seq} · {pinned.kind}</span>
            <button type="button" className="ev-detail-close" onClick={() => setPinned(null)} aria-label="Close event detail">
              <X aria-hidden="true" />
            </button>
          </div>
          <pre>{JSON.stringify(pinned, null, 2)}</pre>
        </div>
      )}
    </div>
  )
})
