/**
 * SideRail — the one companion surface beside the graph.
 *
 * Everything that is not the canvas lives here under four tabs: the run you are sending,
 * the work in flight, the node you clicked, and the raw feed. It replaces three separate
 * regions — a left run panel, a right drawer, and a bottom event dock — that used to
 * surround the graph and take its width from three directions at once.
 *
 * Collapsed, it keeps its full vocabulary as a strip of icons, so nothing here is ever
 * more than one click away and the canvas still gets the whole window.
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { Activity, ChevronsRight, ScrollText, SendHorizonal, SquareDashedMousePointer } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export type RailTab = 'run' | 'activity' | 'inspector' | 'log'

interface TabSpec {
  id: RailTab
  label: string
  icon: LucideIcon
}

const TABS: TabSpec[] = [
  { id: 'run', label: 'Run', icon: SendHorizonal },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'inspector', label: 'Inspector', icon: SquareDashedMousePointer },
  { id: 'log', label: 'Log', icon: ScrollText },
]

const MIN_WIDTH = 280
const MAX_WIDTH = 720
const STORAGE_KEY = 'medextract.rail.width'

export const readRailWidth = (): number => {
  if (typeof window === 'undefined') return 340
  const stored = Number(window.localStorage.getItem(STORAGE_KEY))
  return Number.isFinite(stored) && stored >= MIN_WIDTH ? Math.min(stored, MAX_WIDTH) : 340
}

export interface SideRailProps {
  open: boolean
  tab: RailTab
  width: number
  onTabChange: (tab: RailTab) => void
  onOpenChange: (open: boolean) => void
  onWidthChange: (width: number) => void
  /** Rendered beside the log tab's label — the feed volume, counted where it is read. */
  logCount: number
  children: ReactNode
}

export const SideRail = memo(({ open, tab, width, onTabChange, onOpenChange, onWidthChange, logCount, children }: SideRailProps) => {
  const [dragging, setDragging] = useState(false)

  const clamp = useCallback((next: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)), [])

  // Persist on release rather than per frame: a drag writes sixty values a second and
  // only the one the operator let go of is the width they chose.
  const commit = useCallback((next: number) => {
    window.localStorage.setItem(STORAGE_KEY, String(next))
  }, [])

  useEffect(() => {
    if (!dragging) return
    // `is-rail-resizing` suppresses the panel's own transition and the text selection a
    // drag across the canvas would otherwise paint behind the cursor.
    document.body.classList.add('is-rail-resizing')
    const onMove = (e: PointerEvent) => onWidthChange(clamp(window.innerWidth - e.clientX))
    const onUp = (e: PointerEvent) => {
      setDragging(false)
      commit(clamp(window.innerWidth - e.clientX))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      document.body.classList.remove('is-rail-resizing')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, clamp, commit, onWidthChange])

  const nudge = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const next = clamp(width + step)
      onWidthChange(next)
      commit(next)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      const next = clamp(width - step)
      onWidthChange(next)
      commit(next)
    }
  }

  if (!open) {
    return (
      <nav className="rail-strip" aria-label="Workspace panels">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="rail-strip-btn"
            title={label}
            aria-label={`Open ${label}`}
            onClick={() => {
              onTabChange(id)
              onOpenChange(true)
            }}
          >
            <Icon aria-hidden="true" />
          </button>
        ))}
      </nav>
    )
  }

  return (
    <aside className="rail" style={{ width }}>
      <div
        className="rail-grip"
        role="separator"
        aria-label="Resize panel"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onPointerDown={() => setDragging(true)}
        onKeyDown={nudge}
      />
      <div className="rail-tabs" role="tablist" aria-label="Workspace panels">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`rail-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="rail-panel"
            tabIndex={tab === id ? 0 : -1}
            // The label is hidden on unselected tabs to keep four of them in a narrow
            // rail, so the name has to be carried here or the tab has none at all.
            aria-label={id === 'log' && logCount > 0 ? `${label}, ${logCount} events` : label}
            title={label}
            className={`rail-tab${tab === id ? ' is-on' : ''}`}
            onClick={() => onTabChange(id)}
            onKeyDown={(e) => {
              const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
              if (dir === 0) return
              e.preventDefault()
              const at = TABS.findIndex((t) => t.id === tab)
              const next = TABS[(at + dir + TABS.length) % TABS.length]
              if (!next) return
              onTabChange(next.id)
              document.getElementById(`rail-tab-${next.id}`)?.focus()
            }}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
            {id === 'log' && logCount > 0 && <span className="rail-tab-count">{logCount}</span>}
          </button>
        ))}
        <button
          type="button"
          className="rail-collapse"
          aria-label="Collapse panel"
          title="Collapse panel"
          onClick={() => onOpenChange(false)}
        >
          <ChevronsRight aria-hidden="true" />
        </button>
      </div>
      <div className="rail-body" role="tabpanel" id="rail-panel" aria-labelledby={`rail-tab-${tab}`}>
        {children}
      </div>
    </aside>
  )
})
