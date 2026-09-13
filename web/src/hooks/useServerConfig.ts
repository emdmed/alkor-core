/**
 * `GET/PATCH/DELETE /config` as a hook: what the connected server is configured to do, and
 * the writing of it.
 *
 * Deliberately NOT folded into `useAlkor`. That hook is the live wire — an SSE stream and a
 * reducer that must survive a backend swap without ever showing one server's events under
 * another's topology — and settings are the opposite kind of state: fetched when a person
 * opens a panel, written when they change something, stale the rest of the time. Keeping
 * them apart means the settings screen costs nothing to the dashboard that never opens it.
 *
 * Every write returns the server's own new view of the world rather than merging locally. A
 * patch can change what a value MEANS without changing what was typed — `50%` resolves to a
 * different byte count on a different host, and a `file` source appears the moment the first
 * override is written — and a client that predicted the result would draw a settings screen
 * that disagreed with the server it had just written to.
 */
import { useCallback, useEffect, useState } from 'react'
// The TYPES module, never the store: `core/settings.ts` reads files and the environment,
// and nothing under `web/` imports anything that touches the host.
import type { Settings, SettingSources } from '../../../src/core/settings-types.ts'
import { normalizeUrl } from '../../../src/monitor/source.ts'

export type { Settings, SettingSources }

/** The `/config` payload, as the route assembles it. */
export interface ServerConfig {
  settings: Settings
  sources: SettingSources
  /** What the environment asked for, so a file value can name what it overrides. */
  env: Partial<Settings>
  envNames: Record<keyof Settings, string>
  /** Whether this server accepts writes at all (ALKOR_CONFIG_WRITE=1). */
  writable: boolean
  settingsPath: string
  runtime: {
    profilesPath?: string
    traceDir: string
    llamaBin?: string
    llamaArgs: string
    defaultUrl?: string
    backends: string[]
    profiles: string[]
    budgetBytes: number
    /** Total RAM on the host, which is what turns the budget into a position on a range. */
    totalBytes: number
    resources: { budgetBytes: number; residentBytes: number }
  }
}

/** A refusal that names the field it refused, so a form marks one row rather than all of them. */
export interface ConfigFailure {
  message: string
  field?: keyof Settings
}

export interface UseServerConfig {
  config?: ServerConfig
  loading: boolean
  /** Why the panel could not be loaded at all — an unreachable server, or an older one. */
  error?: string
  /** A write in progress, named, so the row that is saving can say so and not the whole panel. */
  saving?: keyof Settings
  /** The last refusal. Cleared by the next successful write. */
  failure?: ConfigFailure
  save: (patch: Partial<Settings>) => Promise<boolean>
  reset: () => Promise<boolean>
  reload: () => void
}

export const useServerConfig = (baseUrl: string, active: boolean): UseServerConfig => {
  const [config, setConfig] = useState<ServerConfig | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState<keyof Settings | undefined>(undefined)
  const [failure, setFailure] = useState<ConfigFailure | undefined>(undefined)
  const [nonce, setNonce] = useState(0)

  const base = normalizeUrl(baseUrl)

  // Fetched when the panel is opened rather than on mount, and re-fetched when the server
  // changes under it. A dashboard pointed at a second host must never show the first host's
  // settings for the moment before the request lands, so the old config is dropped up front.
  useEffect(() => {
    if (!active) return
    let live = true
    setLoading(true)
    setError(undefined)
    fetch(`${base}/config`, { cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 404) {
          // A server old enough to predate this route is a real thing to meet, and saying so
          // beats "HTTP 404" on a screen whose whole subject is what the server supports.
          throw new Error(`${base} has no /config — it is running a version of alkor from before settings were readable`)
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as ServerConfig
      })
      .then((next) => {
        if (!live) return
        setConfig(next)
        setLoading(false)
      })
      .catch((e: Error) => {
        if (!live) return
        setConfig(undefined)
        setError(e.message.startsWith('Failed to fetch') ? `could not reach ${base}` : e.message)
        setLoading(false)
      })
    return () => {
      live = false
    }
  }, [base, active, nonce])

  /** One write, shared by `save` and `reset` because only the method and body differ. */
  const write = useCallback(
    async (method: 'PATCH' | 'DELETE', patch?: Partial<Settings>): Promise<boolean> => {
      const field = patch ? (Object.keys(patch)[0] as keyof Settings | undefined) : undefined
      setSaving(field)
      setFailure(undefined)
      try {
        const res = await fetch(`${base}/config`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(patch ? { body: JSON.stringify(patch) } : {}),
        })
        const body = (await res.json().catch(() => ({}))) as ServerConfig & { error?: string; field?: keyof Settings }
        if (!res.ok) {
          setFailure({ message: body.error ?? `HTTP ${res.status}`, field: body.field ?? field })
          return false
        }
        setConfig(body)
        return true
      } catch (e) {
        setFailure({ message: `could not reach ${base} — ${(e as Error).message}`, field })
        return false
      } finally {
        setSaving(undefined)
      }
    },
    [base],
  )

  return {
    config,
    loading,
    error,
    saving,
    failure,
    save: useCallback((patch: Partial<Settings>) => write('PATCH', patch), [write]),
    reset: useCallback(() => write('DELETE'), [write]),
    reload: useCallback(() => setNonce((n) => n + 1), []),
  }
}
