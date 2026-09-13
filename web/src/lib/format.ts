/**
 * Formatting helpers for the dashboard: the marks and colour connotations the whole
 * board shares, written as CSS classes.
 */
import type { ConnectionStatus, ModelEntry, ProjectState } from '../../../src/monitor/state.ts'

export type NodeState = 'active' | 'done' | 'failed' | 'idle'

/** The glyph for each node state. */
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

/** First identified model, with the path and .gguf suffix stripped. */
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
  if (kind.startsWith('workflow.')) return 'ev-workflow'
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

/** Milliseconds to a compact seconds figure. */
export const fmtSec = (wallMs?: number): string => (wallMs == null ? '' : `${(wallMs / 1000).toFixed(1)}s`)

/**
 * Bytes at the scale a person reads them, which for model weights is GB.
 *
 * Deliberately re-stated here rather than imported from `core/llama-manager.ts`, which owns
 * the identical helper: that module spawns processes and reaches for `node:child_process`,
 * and pulling it into the browser bundle to borrow one formatter would drag the whole model
 * lifecycle across the boundary this dashboard is careful to keep.
 */
export const fmtBytes = (bytes: number): string => {
  if (bytes <= 0) return 'unbounded'
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

/**
 * A duration in the words an operator would use for it, not in milliseconds.
 *
 * The idle window is the one setting here whose stored unit and whose readable unit differ
 * by three orders of magnitude: `120000` is the value the server takes and "2 minutes" is
 * the thing being decided, and a panel showing the first is asking a non-engineer to do the
 * division themselves every time they look at it.
 */
export const fmtDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = seconds / 60
  if (minutes < 60) {
    const rounded = Number(minutes.toFixed(minutes % 1 === 0 ? 0 : 1))
    return `${rounded} minute${rounded === 1 ? '' : 's'}`
  }
  const hours = Number((minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1))
  return `${hours} hour${hours === 1 ? '' : 's'}`
}