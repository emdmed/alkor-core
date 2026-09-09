import type { ProjectState } from '../../../src/tui/state.ts'
import type { ModelHealth } from '../hooks/useMedextract.ts'
import { connMeta, modelName } from '../lib/format.ts'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { CirclePause, CirclePlay, Eraser, PlugZap } from 'lucide-react'

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

export const Header = ({ state, serverUrl, onServerUrlChange, onConnect, paused, onTogglePause, onClear, models }: HeaderProps) => {
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
    <header className="app-header">
      <div className="brand-lockup">
        <div className="brand-row">
          <span className="brand-name">medextract</span>
          <span className="brand-sep">/</span>
          <span className="brand-host">{hostOf(serverUrl)}</span>
        </div>
        <span className="brand-context">local extraction workspace</span>
      </div>

      <div className="header-health" aria-label="Service status">
        <Badge variant={meta.tone === 'ok' ? 'default' : meta.tone === 'warn' ? 'secondary' : 'destructive'} className="ml-1">
          {meta.label}
        </Badge>
        {allBackendsDown && unmanagedDown.length > 0 && (
          <Badge
            variant="destructive"
            className="ml-1"
            title={`no model backend reachable (${models.map((m) => m.baseUrl).join(', ')})`}
          >
            MODEL OFFLINE
          </Badge>
        )}
        {allBackendsDown && anyDormant && unmanagedDown.length === 0 && (
          <Badge
            variant="secondary"
            className="ml-1"
            title="managed backends are dormant — they spawn on the next run that needs one"
          >
            MODELS DORMANT
          </Badge>
        )}
        {refusedReason && <span className="header-error">{refusedReason}</span>}
        {model && (
          <span className="header-model">{model}</span>
        )}
      </div>

      <form
        className="connection-form"
        onSubmit={(e) => {
          e.preventDefault()
          onConnect()
        }}
      >
        <Input
          type="text"
          value={serverUrl}
          spellCheck={false}
          aria-label="medextract server URL"
          className="connection-input"
          onChange={(e) => onServerUrlChange(e.target.value)}
        />
        <Button type="submit" size="sm"><PlugZap aria-hidden="true" />Connect</Button>
      </form>

      <div className="header-actions">
        <Button
          variant={paused ? 'secondary' : 'outline'}
          size="sm"
          type="button"
          onClick={onTogglePause}
        >
          {paused ? <CirclePlay aria-hidden="true" /> : <CirclePause aria-hidden="true" />}
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onClear}>
          <Eraser aria-hidden="true" />Clear
        </Button>
      </div>
    </header>
  )
}
