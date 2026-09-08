import type { ProjectState } from '../../../src/tui/state.ts'
import type { ModelHealth } from '../hooks/useMedextract.ts'
import { connMeta, modelName } from '../lib/format.ts'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'

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
    <header className="app-header flex items-center gap-3 px-3 border-b border-border bg-card text-card-foreground">
      <div className="flex items-baseline gap-1.5 min-w-0 flex-1 text-sm">
        <span className="font-semibold text-foreground">medextract</span>
        <span className="text-muted-foreground/50">/</span>
        <span className="text-muted-foreground whitespace-nowrap">{hostOf(serverUrl)}</span>
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
        {refusedReason && <span className="text-destructive text-xs ml-1">{refusedReason}</span>}
        {model && (
          <>
            <span className="text-muted-foreground/50">│</span>
            <span className="text-primary whitespace-nowrap">{model}</span>
          </>
        )}
      </div>

      <form
        className="flex gap-1.5"
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
          className="w-56"
          onChange={(e) => onServerUrlChange(e.target.value)}
        />
        <Button type="submit" size="sm">Connect</Button>
      </form>

      <div className="flex gap-1.5">
        <Button
          variant={paused ? 'secondary' : 'outline'}
          size="sm"
          type="button"
          onClick={onTogglePause}
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onClear}>
          Clear
        </Button>
      </div>
    </header>
  )
}
