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
 * `stageId` is the one that makes this interaction worth having: it narrows the feed to
 * what a single node actually did, where `runId` narrows it to the whole run — which, for
 * a four-step workflow, is every line the reader already had. Stage and route nodes carry
 * it from the activity record they were drawn from, and a stage row inspected out of a
 * compact card carries it too.
 *
 * A node assembled from configuration rather than observed from a run has no stage to
 * point at, so the run is the honest granularity and the bar below says so in words rather
 * than claiming a precision the filter does not have.
 */
const focusOf = (node: GraphNodeData | null): { runId?: string; stageId?: string } => {
  if (!node) return {}
  return { runId: node.runId, stageId: node.stageId }
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

  /*
   * Selecting a node is a question about that node, and this is the third surface that
   * answers it: the canvas highlights it, the inspector describes it, and the feed narrows
   * to what it produced.
   *
   * The narrowing degrades rather than failing. A stage id is the sharpest filter, but the
   * feed only holds a window of recent events and a stage that ran early in a long run can
   * have scrolled out of it — in which case filtering to the stage yields an empty panel,
   * which tells the reader nothing and looks like a bug. So an empty stage match falls back
   * to the run, and `scope` below carries which one actually applied so the bar can say so
   * instead of claiming a precision the result does not have.
   */
  const { events, scope } = useMemo(() => {
    const recent = state.eventLog.slice(-600)
    const byKind = group === 'all' ? recent : recent.filter((e) => kindMatches(e.kind, group))

    if (focus.stageId) {
      const byStage = byKind.filter((e) => e.stageId === focus.stageId)
      if (byStage.length > 0) return { events: byStage, scope: 'stage' as const }
    }
    if (focus.runId) return { events: byKind.filter((e) => e.runId === focus.runId), scope: 'run' as const }
    return { events: byKind, scope: 'none' as const }
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
            {scope === 'stage' ? 'Showing' : 'Showing run for'}
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
