/**
 * Source controller: pure transitions for the dashboard's backend connection identity.
 *
 * Dependency-free like `state.ts`, so the exact transitions the React hook runs are
 * testable on Node without React or a renderer. A "source" is a normalized origin. Only
 * `connect` commits the draft and bumps the generation; a changed source always resets
 * source-owned state and drops buffered paused events, so a stale payload can never
 * cross an origin boundary. Same-source reconnects keep state (and the paused buffer)
 * intact so SSE replay/dedup can work normally.
 */
import type { ActivityEvent } from '../core/activity-types.ts'

/** Trim whitespace and strip trailing slashes so identity comparison is forgiving. */
export const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, '')

export interface SourceState {
  /** Normalized origin currently owning the dashboard. */
  activeUrl: string
  /** What the connection form displays; touches nothing until connect commits it. */
  draftUrl: string
  /** Monotonic connection generation; async callbacks capture it to ignore stale replies. */
  generation: number
  paused: boolean
  /** Events captured while paused; dropped on a source change, never flushed cross-source. */
  pausedEvents: ActivityEvent[]
}

export type SourceAction =
  | { type: 'draft'; url: string }
  | { type: 'connect' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'queue-paused'; events: ActivityEvent[] }
  | { type: 'drain' }

export const initialSource = (url: string): SourceState => ({
  activeUrl: normalizeUrl(url),
  draftUrl: url,
  generation: 1,
  paused: false,
  pausedEvents: [],
})

export const sourceReducer = (s: SourceState, a: SourceAction): SourceState => {
  switch (a.type) {
    case 'draft':
      // The draft is purely editorial: it must never touch the active source, the
      // generation, or the paused buffer (typing cannot start transient connections).
      return s.draftUrl === a.url ? s : { ...s, draftUrl: a.url }
    case 'connect': {
      const activeUrl = normalizeUrl(s.draftUrl)
      if (!activeUrl) return s
      const changed = activeUrl !== s.activeUrl
      return {
        ...s,
        activeUrl,
        generation: s.generation + 1,
        // Dropping the paused buffer on a source change guarantees events buffered
        // under the old origin are never flushed into the new one's state.
        pausedEvents: changed ? [] : s.pausedEvents,
      }
    }
    case 'pause': return s.paused ? s : { ...s, paused: true }
    case 'resume': return s.paused ? { ...s, paused: false } : s
    case 'queue-paused':
      return s.paused && a.events.length > 0
        ? { ...s, pausedEvents: [...s.pausedEvents, ...a.events] }
        : s
    case 'drain': return s.pausedEvents.length === 0 ? s : { ...s, pausedEvents: [] }
    default: return s
  }
}

/** True when the captured generation still owns the connection (stale replies are dropped). */
export const isCurrentGeneration = (captured: number, source: SourceState): boolean =>
  captured === source.generation