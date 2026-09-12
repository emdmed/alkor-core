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
import type { GraphNodeData } from '../lib/graph/index.ts'
import { eventClass, KIND_GROUPS, kindMatches, type KindGroup } from '../lib/format.ts'
import { ChevronDown, X } from 'lucide-react'
import { Button } from './ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem } from './ui/dropdown-menu'

/**
 * The correlation ids a clicked node can narrow the feed by.
 *
 * A node carries its `runId` directly. A stage node was built from an underlying activity
 * record, and when that record kept its `stageId` the feed can be narrowed to the one
 * stage rather than the whole run — which is the difference between forty lines and four.
 * When it did not, the run is the honest granularity, and the chip below says so rather
 * than claiming a precision the filter does not have.
 */
const focusOf = (node: GraphNodeData | null): { runId?: string; stageId?: string } => {
  if (!node) return {}
  const detail = node.detail
  const stageId =
    detail != null && typeof detail === 'object' && 'stageId' in detail && typeof (detail as { stageId?: unknown }).stageId === 'string'
      ? (detail as { stageId: string }).stageId
      : undefined
  return { runId: node.runId, stageId }
}

export const EventLog = memo(({ state, selected, onClearSelection }: {
  state: ProjectState
  /** The node the operator clicked on the canvas, or null. */
  selected?: GraphNodeData | null
  onClearSelection?: () => void
}) => {
  const [group, setGroup] = useState<KindGroup>('all')
  const [pinned, setPinned] = useState<ActivityEvent | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  const focus = focusOf(selected ?? null)
  const focused = Boolean(focus.stageId || focus.runId)

  const events = useMemo(() => {
    const recent = state.eventLog.slice(-600)
    const byKind = group === 'all' ? recent : recent.filter((e) => kindMatches(e.kind, group))
    // Selecting a node is a question about that node, and this is the third surface that
    // answers it — the canvas highlights it and the inspector describes it, and here the
    // feed narrows to the events it actually produced.
    if (focus.stageId) return byKind.filter((e) => e.stageId === focus.stageId)
    if (focus.runId) return byKind.filter((e) => e.runId === focus.runId)
    return byKind
  }, [state.eventLog, group, focus.stageId, focus.runId])

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

      {/* A filter the operator did not set here has to announce itself, and has to be
          removable from where it is visible — otherwise a feed that has gone quiet because
          of a click on the canvas reads as a feed that has gone quiet. */}
      {focused && selected && (
        <div className="eventlog-focus">
          <span className="eventlog-focus-label">
            {focus.stageId ? 'Showing' : 'Showing run for'}
          </span>
          <span className="eventlog-focus-name">{selected.label}</span>
          {onClearSelection && (
            <button
              type="button"
              className="eventlog-focus-clear"
              onClick={onClearSelection}
              aria-label={`Stop filtering the feed to ${selected.label}`}
            >
              <X aria-hidden="true" />
            </button>
          )}
        </div>
      )}

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
              : focused && selected
                ? `Nothing in the feed for ${selected.label} yet.`
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
