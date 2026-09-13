/**
 * The settings a running server will let you change, and where a change survives.
 *
 * Everything here used to be an environment variable read once at boot, which made every
 * one of them a restart: to let a second app talk to this server you edited a shell, killed
 * the process and started it again, and the dashboard could not even tell you what the
 * current value WAS. This store is the same set of knobs with two properties added — they
 * can be read back, and they can be written — and `GET/PATCH /config` is the only thing
 * that consumes it.
 *
 * ## Precedence: the file wins over the environment
 *
 * This is backwards from the usual rule and deliberately so. The usual rule exists because
 * the environment is the more specific, more immediate instruction; here it is the opposite.
 * The file is written by a person who just typed the value into a form on this machine, and
 * the environment is whatever the shell that launched the server happened to be carrying.
 * If the environment won, an operator with `ALKOR_CORS` exported in their profile would
 * edit the origin list, see it save, and watch it do nothing — the worst outcome available,
 * because it is the one that looks like it worked. So the file wins, and `GET /config`
 * reports the per-key source so a value that is overriding an env var says so on its face.
 *
 * ## What is NOT here
 *
 * Anything a running process cannot honestly change: the listen port, the llama binary, the
 * spawn flags, the trace directory, profiles.toml itself. Those are reported by the config
 * route as read-only facts, with the variable that sets them, rather than offered as fields
 * that would need a restart to mean anything. A settings screen whose switches sometimes
 * apply and sometimes do not is worse than one with fewer switches.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateRoot } from './trace.ts'
import { isBudgetSpec } from './budget.ts'
import { SETTING_ENV, type SettingSource, type SettingSources, type Settings } from './settings-types.ts'

// Re-exported so the store stays the one import a server-side caller needs; the split exists
// for the browser's sake (see settings-types.ts), not to make this module harder to use.
export { SETTING_ENV }
export type { Settings, SettingSource, SettingSources }

const SETTINGS_FILE = () => join(stateRoot(), 'alkor', 'settings.json')

/** A comma-separated origin list as the env vars have always spelled it. */
const parseList = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const defaults = (): Settings => ({
  cors: [],
  traceCors: [],
  modelBudget: '',
  idleMs: 120_000,
  manageModels: true,
  serverTrace: true,
})

/** What the environment asks for, field by field, ignoring any variable that is not set. */
const fromEnv = (env: NodeJS.ProcessEnv): Partial<Settings> => {
  const out: Partial<Settings> = {}
  if (env.ALKOR_CORS !== undefined) out.cors = parseList(env.ALKOR_CORS)
  if (env.ALKOR_TRACE_CORS !== undefined) out.traceCors = parseList(env.ALKOR_TRACE_CORS)
  if (env.ALKOR_MODEL_BUDGET !== undefined) out.modelBudget = env.ALKOR_MODEL_BUDGET.trim()
  if (env.ALKOR_IDLE_MS !== undefined) {
    const ms = Number(env.ALKOR_IDLE_MS)
    // Same forgiveness the boot path has always had: an unreadable variable falls back to
    // the default rather than stopping the server from starting.
    if (Number.isFinite(ms) && ms > 0) out.idleMs = ms
  }
  if (env.ALKOR_MANAGE_MODELS !== undefined) out.manageModels = env.ALKOR_MANAGE_MODELS !== '0'
  if (env.ALKOR_SERVER_TRACE !== undefined) out.serverTrace = env.ALKOR_SERVER_TRACE !== '0'
  return out
}

/**
 * Whether this server accepts settings WRITES. On by default; `ALKOR_CONFIG_WRITE=0` off.
 *
 * The default is on because of who this product is for. The operator is running alkor on
 * their own machine, and the settings screen exists so that letting a second app talk to
 * this server is a thing they do in the dashboard rather than by editing a shell profile and
 * restarting a process. A writable server that ships needing a flag to be writable is a
 * feature that most of its audience never finds.
 *
 * What that costs is worth stating plainly rather than burying, because the flag is the only
 * thing between these two facts: this server has no authentication of any kind, and a write
 * route can widen `cors`. A page in the operator's browser can therefore POST to
 * `127.0.0.1:3000/config` — no preflight is required for a simple request, and the response
 * being unreadable cross-origin does not stop the write from landing. It cannot read the
 * result, but it does not need to: the write it just made is what opens the door.
 *
 * `ALKOR_CONFIG_WRITE=0` is the lock, and it belongs on any host where the browser sitting
 * beside this server is used for anything else. The reading of traces is still gated
 * separately by `traceCors`, which this route can change but which starts closed.
 */
export const configWritable = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env.ALKOR_CONFIG_WRITE ?? '1') !== '0'

/** A rejected write, naming the field so a form can mark it rather than alerting a blob. */
export class SettingsError extends Error {
  field: string
  constructor(field: string, message: string) {
    super(message)
    this.name = 'SettingsError'
    this.field = field
  }
}

/**
 * An origin as a browser spells it in the `Origin` header: scheme and host, no path, no
 * trailing slash. Checked strictly because a near-miss is silent — `https://app.example/`
 * never matches the header `https://app.example`, and the operator is left looking at an
 * allowlist that visibly contains the origin it is refusing.
 */
const validateOrigin = (field: string, origin: string): string => {
  if (origin === '*') return origin
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new SettingsError(field, `'${origin}' is not an origin — expected something like https://app.example or *`)
  }
  const spelled = url.origin
  if (spelled === 'null' || `${url.protocol}//${url.host}` !== origin) {
    throw new SettingsError(
      field,
      `'${origin}' is not how a browser spells an origin — use '${spelled}' (scheme and host only, no path or trailing slash)`,
    )
  }
  return spelled
}

const validateOrigins = (field: string, raw: unknown): string[] => {
  if (!Array.isArray(raw)) throw new SettingsError(field, `${field} must be an array of origins`)
  const origins = raw.map((entry) => {
    if (typeof entry !== 'string') throw new SettingsError(field, `${field} must be an array of origins`)
    return validateOrigin(field, entry.trim())
  })
  // A list containing `*` alongside named origins is a list whose named entries do nothing.
  // Saying so beats storing a value that reads as more restrictive than it is.
  if (origins.includes('*') && origins.length > 1) {
    throw new SettingsError(field, `'*' already allows every origin — remove it, or remove the others`)
  }
  return [...new Set(origins)]
}

/** Validate a partial write and return it normalized. Throws `SettingsError` on the first problem. */
export const validatePatch = (raw: Record<string, unknown>): Partial<Settings> => {
  const patch: Partial<Settings> = {}
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'cors':
      case 'traceCors':
        patch[key] = validateOrigins(key, value)
        break
      case 'modelBudget': {
        if (typeof value !== 'string') throw new SettingsError(key, 'modelBudget must be a string like 6GiB, 50% or 0')
        const spec = value.trim()
        if (!isBudgetSpec(spec)) {
          throw new SettingsError(key, `'${spec}' is not a size — expected 6GiB, 600MB, 50%, a byte count, or 0 for unbounded`)
        }
        patch.modelBudget = spec
        break
      }
      case 'idleMs': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new SettingsError(key, 'idleMs must be a number of milliseconds')
        }
        // A sub-second idle window stops a backend between two steps of the same workflow,
        // so the run pays a full model load per step and looks broken rather than slow.
        if (value < 1000) throw new SettingsError(key, 'idleMs must be at least 1000 — a shorter window stops a model mid-workflow')
        patch.idleMs = Math.floor(value)
        break
      }
      case 'manageModels':
      case 'serverTrace':
        if (typeof value !== 'boolean') throw new SettingsError(key, `${key} must be true or false`)
        patch[key] = value
        break
      default:
        throw new SettingsError(key, `'${key}' is not a setting this server has`)
    }
  }
  return patch
}

export interface SettingsStore {
  /** The effective settings: defaults, under the environment, under the persisted file. */
  current(): Settings
  /** Where each effective value came from. */
  sources(): SettingSources
  /** What the environment asked for, so the UI can say what a file value is overriding. */
  env(): Partial<Settings>
  /** Only the keys that have been written here — what is actually in the file. */
  overrides(): Partial<Settings>
  /** Validate, persist and apply a partial write. Returns the new effective settings. */
  patch(raw: Record<string, unknown>): Settings
  /** Drop every override, returning the server to what its environment says. */
  reset(): Settings
  /** Called after every successful patch/reset with the new effective settings. */
  onChange(listener: (settings: Settings) => void): void
  /** Where overrides are persisted, so the UI can name the file it is writing. */
  path: string
}

/**
 * Read the persisted overrides, tolerating every way the file can be unusable.
 *
 * A settings file that has been hand-edited into invalid JSON, or that carries a key from a
 * version of this server that no longer has it, must not stop the process from starting:
 * the recovery for "my server will not boot because of its settings file" requires knowing
 * the file exists, and nothing in the product says so. Unreadable entries are dropped and
 * the rest is kept.
 */
const readOverrides = (file: string): Partial<Settings> => {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Partial<Settings> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    try {
      Object.assign(out, validatePatch({ [key]: value }))
    } catch {
      // One bad key does not discard the others.
    }
  }
  return out
}

export const createSettingsStore = (
  options: { file?: string; env?: NodeJS.ProcessEnv } = {},
): SettingsStore => {
  const file = options.file ?? SETTINGS_FILE()
  const env = options.env ?? process.env
  const envSettings = fromEnv(env)
  let overrides = readOverrides(file)
  const listeners: Array<(settings: Settings) => void> = []

  const current = (): Settings => ({ ...defaults(), ...envSettings, ...overrides })

  const sources = (): SettingSources => {
    const out = {} as SettingSources
    for (const key of Object.keys(defaults()) as Array<keyof Settings>) {
      out[key] = key in overrides ? 'file' : key in envSettings ? 'env' : 'default'
    }
    return out
  }

  const persist = () => {
    mkdirSync(dirname(file), { recursive: true })
    if (Object.keys(overrides).length === 0) {
      try {
        rmSync(file)
      } catch {
        // Already absent, which is the state we wanted.
      }
      return
    }
    writeFileSync(file, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8')
  }

  const announce = (): Settings => {
    const settings = current()
    for (const listener of listeners) listener(settings)
    return settings
  }

  return {
    path: file,
    current,
    sources,
    env: () => ({ ...envSettings }),
    overrides: () => ({ ...overrides }),
    patch: (raw) => {
      // Validated in full BEFORE anything is written: a body setting three fields where the
      // second is invalid must change none of them, or the operator is left reconstructing
      // which half of their edit landed.
      const patched = validatePatch(raw)
      overrides = { ...overrides, ...patched }
      persist()
      return announce()
    },
    reset: () => {
      overrides = {}
      persist()
      return announce()
    },
    onChange: (listener) => void listeners.push(listener),
  }
}
