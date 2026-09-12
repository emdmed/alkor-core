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
import type { ProjectState } from '../../../src/tui/state.ts'
import { cacheHitRatio, failureRate, inFlightCount } from '../../../src/tui/state.ts'
import type { ModelHealth } from '../hooks/useMedextract.ts'
import { connMeta, modelName } from '../lib/format.ts'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { ChevronDown, CirclePause, CirclePlay, Eraser, PlugZap } from 'lucide-react'

export interface HeaderProps {
  state: ProjectState
  serverUrl: string
  onServerUrlChange: (url: string) => void
  onConnect: () => void
  paused: boolean
  onTogglePause: () => void
  onClear: () => void
  models: ModelHealth[]
}

const hostOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/+$/, '')

const toneCls = (tone: 'ok' | 'warn' | 'err'): string =>
  tone === 'ok' ? 'tone-ok' : tone === 'warn' ? 'tone-warn' : 'tone-err'

export const Header = memo(({ state, serverUrl, onServerUrlChange, onConnect, paused, onTogglePause, onClear, models }: HeaderProps) => {
  const meta = connMeta(state.connection)
  const model = modelName(state.models)
  const refusedReason = state.connection.kind === 'refused' ? state.connection.reason : ''
  // Every configured backend is dark: the connection badge is about the medextract server,
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
        <span className="brand-name">medextract</span>
        <ConnectionMenu
          serverUrl={serverUrl}
          onServerUrlChange={onServerUrlChange}
          onConnect={onConnect}
        />
      </div>

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

      <div className="topbar-actions">
        <Button variant="ghost" size="sm" type="button" onClick={onTogglePause}>
          {paused ? <CirclePlay aria-hidden="true" /> : <CirclePause aria-hidden="true" />}
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onClear} title="Discard the runs and events collected so far">
          <Eraser aria-hidden="true" />Clear
        </Button>
      </div>
    </header>
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
          aria-label="medextract server"
          onSubmit={(e) => {
            e.preventDefault()
            onConnect()
            setOpen(false)
          }}
        >
          <label className="conn-pop-label" htmlFor={fieldId}>medextract server</label>
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
