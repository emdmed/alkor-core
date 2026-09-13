/**
 * The shape of the settings, with no way to read or write them.
 *
 * Split from `settings.ts` for the same reason `activity-types.ts` is split from
 * `activity.ts`: the dashboard renders these and must therefore know their shape, and the
 * store that owns them reads files and the environment. A browser bundle that imported the
 * store to borrow one interface would pull `node:fs` across a boundary this project keeps
 * deliberately clean — nothing under `web/` imports anything that touches the host.
 *
 * Types and constants only. If something here ever needs to DO anything, it belongs next
 * door.
 */

/** The writable set: everything a running server can change about itself. */
export interface Settings {
  /**
   * Origins allowed to read this API from a browser page. Empty means the built-in
   * loopback-only default; `['*']` is a blanket allow.
   */
  cors: string[]
  /**
   * Origins allowed to read TRACE CONTENT, which is the stricter of the two lists because a
   * trace quotes the source document. Empty means no browser page may, whatever `cors` says.
   */
  traceCors: string[]
  /** Resident-model budget as a spec string (`6GiB`, `50%`, `0`). Empty means the default. */
  modelBudget: string
  /** How long a managed backend may sit unused before it is stopped. */
  idleMs: number
  /** Whether this server spawns llama-server itself, or expects you to have started it. */
  manageModels: boolean
  /** Whether runs through this server are recorded to a trace file. */
  serverTrace: boolean
}

/** Where a given setting's current value came from. */
export type SettingSource = 'default' | 'env' | 'file'

export type SettingSources = Record<keyof Settings, SettingSource>

/**
 * The environment variable behind each setting.
 *
 * Carried to the client so a saved value can name what it is overriding in the shell that
 * launched the server — the one piece of provenance that turns a confusing screen into an
 * explained one.
 */
export const SETTING_ENV: Record<keyof Settings, string> = {
  cors: 'ALKOR_CORS',
  traceCors: 'ALKOR_TRACE_CORS',
  modelBudget: 'ALKOR_MODEL_BUDGET',
  idleMs: 'ALKOR_IDLE_MS',
  manageModels: 'ALKOR_MANAGE_MODELS',
  serverTrace: 'ALKOR_SERVER_TRACE',
}
