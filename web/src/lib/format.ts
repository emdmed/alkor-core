/**
 * Formatting helpers ported from the terminal renderer (`src/tui/app.ts`) so both
 * dashboards say the same thing: same marks, same colour connotations, written as CSS
 * classes instead of ANSI fg() spans.
 */
import type { ConnectionStatus, ModelEntry, ProjectState } from '../../../src/tui/state.ts'

export type NodeState = 'active' | 'done' | 'failed' | 'idle'

/** The glyph the terminal uses for each node state; kept identical for continuity. */
export const nodeMark: Record<NodeState, string> = {
  active: '●',
  done: '✓',
  failed: '×',
  idle: '○',
}

export const nodeCls: Record<NodeState, string> = {
  active: 'ok',
  done: 'info',
  failed: 'err',
  idle: 'muted',
}

export const runState = (status: string): NodeState =>
  status === 'started' ? 'active' : status === 'failed' ? 'failed' : 'done'

/** First identified model, with the path and .gguf suffix stripped — as the TUI shows it. */
export const modelName = (models: Map<string, ModelEntry>): string => {
  for (const m of models.values()) {
    if (m.identified && m.model) {
      return (m.model.split('/').at(-1) ?? m.model).replace(/\.gguf$/, '')
    }
  }
  return ''
}

export interface ConnMeta {
  dot: string
  label: string
  tone: 'ok' | 'warn' | 'err'
}

export const connMeta = (c: ConnectionStatus): ConnMeta => {
  switch (c.kind) {
    case 'live': return { dot: '●', label: 'LIVE', tone: 'ok' }
    case 'connecting': return { dot: '◌', label: 'CONNECTING', tone: 'warn' }
    case 'reconnecting': return { dot: '◐', label: `RECONNECTING · attempt ${c.attempt}`, tone: 'warn' }
    case 'refused': return { dot: '○', label: 'REFUSED', tone: 'err' }
  }
}

/** Event-kind → CSS class, mirroring `eventColor` in app.ts (plus the kinds it tuned). */
export const eventClass = (kind: string): string => {
  if (kind.startsWith('llm.')) return 'ev-llm'
  if (kind.startsWith('run.')) return 'ev-run'
  if (kind.startsWith('http.')) return 'ev-http'
  if (kind.startsWith('pipeline.')) return 'ev-pipeline'
  if (kind.startsWith('session.') || kind.startsWith('turn.')) return 'ev-session'
  if (kind === 'stage') return 'ev-stage'
  if (kind.startsWith('route.')) return 'ev-route'
  if (kind.startsWith('tool.')) return 'ev-tool'
  if (kind.startsWith('model.')) return 'ev-model'
  if (kind.startsWith('profile.')) return 'ev-profile'
  if (kind.startsWith('server.')) return 'ev-server'
  return ''
}

/** Filter groups for the event log; `all` matches everything else by prefix. */
export const KIND_GROUPS = [
  'all',
  'llm',
  'run',
  'http',
  'pipeline',
  'session',
  'turn',
  'stage',
  'route',
  'tool',
  'model',
  'profile',
  'server',
] as const

export type KindGroup = (typeof KIND_GROUPS)[number]

export const kindMatches = (kind: string, group: KindGroup): boolean =>
  group === 'all' || kind.startsWith(`${group}.`) || kind === group

/** Milliseconds to a compact seconds figure, as the TUI prints it. */
export const fmtSec = (wallMs?: number): string => (wallMs == null ? '' : `${(wallMs / 1000).toFixed(1)}s`)