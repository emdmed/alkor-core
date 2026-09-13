/**
 * Header — the workspace's one permanent band.
 *
 * It carries everything that is true of the session rather than of a run: who we are
 * connected to, whether the feed is live, which model answered, how much work has gone
 * through, and the two controls that act on the feed itself. The server URL is setup,
 * not operation, so it lives behind the host chip instead of holding a text field open
 * across every run.
 */
import { memo, useEffect, useId, useRef, useState } from 'react'
import type { ProjectState } from '../../../src/monitor/state.ts'
import { cacheHitRatio, failureRate, inFlightCount } from '../../../src/monitor/state.ts'
import type { HarnessHealth, ModelHealth } from '../hooks/useAlkor.ts'
import { connMeta, modelName } from '../lib/format.ts'
import { Logotype, StarPair } from './Logotype'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { ChevronDown, CirclePause, CirclePlay, Eraser, Moon, PlugZap, Settings2, Sun } from 'lucide-react'
import { useTheme } from '../hooks/useTheme.ts'

export interface HeaderProps {
  state: ProjectState
  serverUrl: string
  onServerUrlChange: (url: string) => void
  onConnect: () => void
  paused: boolean
  onTogglePause: () => void
  onClear: () => void
  models: ModelHealth[]
  /** What the connected server is running. Absent until /health answers, or on an older server. */
  harness?: HarnessHealth
  /**
   * Enter or leave the settings view.
   *
   * The way in sits up here because this band is the one thing that stays put across both
   * views, and because it already carries everything true of the SERVER rather than of a
   * run — which host, which model, whether the feed is live. What that server is configured
   * to do is the same kind of fact, one level down.
   */
  onToggleSettings: () => void
  /** Whether the settings view is the one on screen, so the control reads as engaged. */
  settingsOpen: boolean
}

const hostOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/+$/, '')

const toneCls = (tone: 'ok' | 'warn' | 'err'): string =>
  tone === 'ok' ? 'tone-ok' : tone === 'warn' ? 'tone-warn' : 'tone-err'

export const Header = memo(({ state, serverUrl, onServerUrlChange, onConnect, paused, onTogglePause, onClear, models, harness, onToggleSettings, settingsOpen }: HeaderProps) => {
  const meta = connMeta(state.connection)
  const model = modelName(state.models)
  const refusedReason = state.connection.kind === 'refused' ? state.connection.reason : ''
  // Every configured backend is dark: the connection badge is about the alkor server,
  // and this one is about whether it can reach a model at all.
  const allBackendsDown = models.length > 0 && models.every((m) => !m.reachable)
  // A backend the server can spawn on demand is DORMANT, not broken — the first run needs
  // it, it comes up, and on an idle clock it stops again. Only an unmanaged, unreachable
  // backend is a wall a user must climb themselves.
  const unmanagedDown = models.filter((m) => !m.reachable && !m.managed)
  const anyDormant = models.some((m) => !m.reachable && m.managed)

  return (

    <header className="topbar">
      <div className="topbar-identity">
        <span className="brand-lockup">
          <StarPair className="brand-stars" />
          <Logotype className="brand-mark" />
          {/* The stage rides on the mark, where a reader already looks to learn what this is.
              It reports the SERVER's stage, not this page's: the dashboard can be pointed at
              any alkor, and a badge describing the build the page came from would be right
              only by coincidence. Silent until /health answers, and silent on a release
              version — an empty space is a truer claim than a stale one. */}
          {harness?.stage && (
            <span
              className="brand-stage"
              title={`alkor ${harness.version} — ${harness.stage} software, released for testing. Interfaces, packs and measured numbers may change.`}
            >
              {harness.stage}
            </span>
          )}
        </span>
        {/* The mark is a word nobody can read the product out of, so the descriptor rides
            beside it for the reader arriving cold. It is the first thing cut when the bar
            runs out of room — by then the operator knows what this is. */}
        <span className="brand-descriptor">local-model orchestration for medical workflows</span>
        {/* The one claim that must never scroll away. The rail's note only stands in the
            empty state, which is the exact moment nobody is reading a result — this sits in
            the permanent band so it is on screen while the output is. Short enough to stay
            out of the way, with the whole sentence in reach on hover. */}
        <span
          className="brand-disclaimer"
          title="Research and educational tool only. Not a medical device, not clinical decision support, and not to be used to make medical decisions."
        >
          Research use only — not for medical decisions
        </span>
        <ConnectionMenu
          serverUrl={serverUrl}
          onServerUrlChange={onServerUrlChange}
          onConnect={onConnect}
        />
      </div>

      {/* Session truth and the work counted so far read as one right-hand instrument rather
          than as two loose groups: hairlines divide the cells, the identity keeps the left. */}
      <div className="topbar-rack">
        <div className="topbar-state" role="status" aria-label="Service status">
          <span className={`health-state ${toneCls(meta.tone)}`} title={meta.label}>
            <span className="health-dot" aria-hidden="true" />
            {meta.label}
          </span>
          {model && <span className="topbar-model" title={model}>{model}</span>}
          {allBackendsDown && unmanagedDown.length > 0 && (
            <Badge
              variant="destructive"
              className="health-chip"
              title={`no model backend reachable (${models.map((m) => m.baseUrl).join(', ')})`}
            >
              MODEL OFFLINE
            </Badge>
          )}
          {allBackendsDown && anyDormant && unmanagedDown.length === 0 && (
            <Badge
              variant="secondary"
              className="health-chip"
              title="managed backends are dormant — they spawn on the next run that needs one"
            >
              MODELS DORMANT
            </Badge>
          )}
          {refusedReason && <span className="topbar-error" title={refusedReason}>{refusedReason}</span>}
        </div>
        <Counters state={state} />
      </div>

      <div className="topbar-actions">
        <Button variant="ghost" size="sm" type="button" onClick={onTogglePause}>
          {paused ? <CirclePlay aria-hidden="true" /> : <CirclePause aria-hidden="true" />}
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <ClearButton onClear={onClear} count={state.runs.size + state.eventLog.length} />
        <Button
          variant="ghost"
          size="icon"
          type="button"
          className={`settings-open${settingsOpen ? ' is-on' : ''}`}
          onClick={onToggleSettings}
          aria-label={settingsOpen ? 'Close server settings' : 'Server settings'}
          aria-pressed={settingsOpen}
          title={settingsOpen ? 'Close server settings' : 'Server settings'}
        >
          <Settings2 aria-hidden="true" />
        </Button>
        <ThemeToggle />
      </div>
    </header>

  )
})

/**
 * Light or dark, as one icon control.
 *
 * The glyph shows what the click will DO rather than what is currently true — a moon on
 * the light theme — because a control that only reports state gives the reader nothing to
 * act on. The accessible name says the same thing in words.
 */
const ThemeToggle = () => {
  const { theme, toggle } = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </Button>
  )
}

/**
 * Clear, with the one guard it was missing.
 *
 * Discarding the feed is not undoable and there is nowhere to recover it from, so it asks
 * once — in place, on the button itself, rather than behind a dialog. A modal would take
 * the screen away from a run that may still be landing, and this decision needs neither
 * interruption nor protected focus. The ask lapses on its own after a few seconds, because
 * a button left reading "Confirm" is a trap for the next person who reaches for it.
 *
 * At zero it is disabled: an always-live control that does nothing still reads as one that
 * might, and this one sits a thumb's width from Pause.
 */
const ClearButton = memo(({ onClear, count }: { onClear: () => void; count: number }) => {
  const [asking, setAsking] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])
  // Nothing left to discard means nothing left to confirm.
  useEffect(() => { if (count === 0) setAsking(false) }, [count])

  const arm = () => {
    setAsking(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setAsking(false), 4000)
  }

  const fire = () => {
    clearTimeout(timer.current)
    setAsking(false)
    onClear()
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      disabled={count === 0}
      className={asking ? 'is-confirming' : undefined}
      onClick={asking ? fire : arm}
      onBlur={() => setAsking(false)}
      title={
        count === 0
          ? 'Nothing collected yet'
          : `Discard ${count} collected run${count === 1 ? '' : 's'} and events — this cannot be undone`
      }
    >
      <Eraser aria-hidden="true" />{asking ? 'Discard them?' : 'Clear'}
    </Button>
  )
})

/**
 * Run counters, inline in the header.
 *
 * Only the figures that change what an operator does next are resident: what is in
 * flight, what has landed, and the two ratios that are silent when they have nothing to
 * report. Feed volume — events, HTTP calls, sessions — is a property of the log, and it
 * is counted where the log is read.
 */
const Counters = memo(({ state }: { state: ProjectState }) => {
  const active = inFlightCount(state.llmRequests)
  const finished = [...state.runs.values()].filter((r) => r.status !== 'started').length
  const failures = failureRate(state.runs)
  const cache = cacheHitRatio(state.llmRequests)

  return (
    <dl className="counters" aria-label="Run counters">
      <Counter value={active} label="active" live={active > 0} />
      <Counter value={finished} label={finished === 1 ? 'run' : 'runs'} />
      {finished > 0 && failures > 0 && <Counter value={`${Math.round(failures * 100)}%`} label="failed" danger />}
      {cache != null && <Counter value={`${Math.round(cache * 100)}%`} label="cached" />}
    </dl>
  )
})

const Counter = ({ value, label, live, danger }: {
  value: string | number
  label: string
  live?: boolean
  danger?: boolean
}) => (
  <div className={`counter${live ? ' is-live' : ''}${danger ? ' is-danger' : ''}`}>
    <dd>{value}</dd>
    <dt>{label}</dt>
  </div>
)

/**
 * The server address, and the only place it can be changed.
 *
 * Kept as a disclosure rather than a resident field: an operator points the dashboard at
 * a server once and then runs notes against it all afternoon, so the address earns a chip
 * that reads at a glance and a form that appears when they mean to move.
 */
const ConnectionMenu = ({ serverUrl, onServerUrlChange, onConnect }: {
  serverUrl: string
  onServerUrlChange: (url: string) => void
  onConnect: () => void
}) => {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fieldId = useId()

  useEffect(() => {
    if (!open) return
    inputRef.current?.select()
    const onPointer = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Claim the key before the shell does: this popover is the topmost surface while
      // it is open, and Escape should close it rather than the rail behind it.
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div className="conn" ref={wrapRef}>
      <button
        type="button"
        className="conn-chip"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        title={`Connected to ${serverUrl} — click to change`}
      >
        {hostOf(serverUrl)}
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <form
          className="conn-pop"
          role="dialog"
          aria-label="alkor server"
          onSubmit={(e) => {
            e.preventDefault()
            onConnect()
            setOpen(false)
          }}
        >
          <label className="conn-pop-label" htmlFor={fieldId}>alkor server</label>
          <div className="conn-pop-row">
            <Input
              id={fieldId}
              ref={inputRef}
              type="text"
              value={serverUrl}
              spellCheck={false}
              className="conn-input"
              onChange={(e) => onServerUrlChange(e.target.value)}
            />
            <Button type="submit" size="sm"><PlugZap aria-hidden="true" />Connect</Button>
          </div>
          <p className="conn-pop-note">Connecting to a different origin drops the runs collected here.</p>
        </form>
      )}
    </div>
  )
}
