/**
 * profiles.toml — where a deployment says which profiles exist, what pack each one
 * reads, and which server it talks to.
 *
 * This file is the ONLY place a consuming project's name or path appears in the harness.
 * Everything under `src/core/` and `src/modes/` reads config; nothing hardcodes a
 * sibling repository. Keeping the wiring in data rather than in imports is what lets the
 * same checkout serve two unrelated projects without a fork.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'

export const CONFIG_NAME = 'profiles.toml'

/**
 * A profile name as it appears inside an env var: `PACK_ROOT_<X>`, `PROFILE_MODULE_<X>`.
 *
 * Hyphens become underscores because a profile name may carry one and an env var may not —
 * without this, `note-format` is a profile whose overrides are unsettable from a shell.
 */
export const envSuffix = (profile: string): string => profile.toUpperCase().replaceAll('-', '_')

/** Execution shapes the harness knows. A profile picks one; it does not invent one. */
export type Mode = 'extract' | 'agentic' | 'router' | 'pipeline'

export interface ProfileConfig {
  name: string
  mode: Mode
  /** Pack directory, relative to profiles.toml. Optional: agentic profiles may have none. */
  pack?: string
  /**
   * The profile's module, relative to profiles.toml. Optional: without it the built-in
   * `src/profiles/<name>/profile.ts` is used. A domain whose pack is private keeps its
   * scorer beside it rather than in this repository.
   */
  module?: string
  /** Default llama-server for this profile; --url overrides. */
  url?: string
  /**
   * Gateway profile: its model is the front door that catches every initial prompt. The
   * interactive server routes an unpinned `/route` request through it, brings its backend
   * up at the first prompt that needs it, and never idle-stops it — the specialists it
   * names are the ones that start and stop on demand. One deployment keeps one resident.
   */
  pinned?: boolean
  /** Free-form, passed through to the profile module (e.g. a model hint). */
  [key: string]: unknown
}

/**
 * The deployment's front door. A pipeline owns the router and the complete catalogue of
 * workflows it may select; the entries themselves remain profile-backed recipes so old
 * out-of-tree `mode = "pipeline"` definitions keep loading unchanged.
 */
export interface PipelineConfig {
  router: string
  workflows: string[]
  defaultWorkflow: string
}

export interface Config {
  /** Directory holding profiles.toml — the base for resolving relative pack paths. */
  base: string
  profiles: Record<string, ProfileConfig>
  /** Present when this deployment exposes an automatic route-then-run front door. */
  pipeline?: PipelineConfig
}

export class ConfigError extends Error {}

/** Walk up from `start` looking for profiles.toml, so the CLI works from any subdirectory. */
export const findConfig = (start = process.cwd()): string | undefined => {
  let dir = resolve(start)
  for (;;) {
    const candidate = join(dir, CONFIG_NAME)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export const loadConfig = (explicitPath?: string): Config => {
  const path = explicitPath ?? findConfig() ?? join(import.meta.dirname, '../..', CONFIG_NAME)
  if (!existsSync(path)) {
    throw new ConfigError(`no ${CONFIG_NAME} found (looked from ${process.cwd()} upwards, then at ${path})`)
  }

  let raw: Record<string, unknown>
  try {
    raw = parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (e) {
    throw new ConfigError(`${path} is not valid TOML: ${(e as Error).message}`)
  }

  const profiles: Record<string, ProfileConfig> = {}
  let pipelineRaw: Record<string, unknown> | undefined
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ConfigError(`${path}: '${name}' is not a profile table`)
    }
    const t = value as Record<string, unknown>
    if (name === 'pipeline' && t.mode === undefined) {
      pipelineRaw = t
      continue
    }
    if (t.mode !== 'extract' && t.mode !== 'agentic' && t.mode !== 'router' && t.mode !== 'pipeline') {
      throw new ConfigError(`${path}: profile '${name}' has mode '${t.mode}' (expected 'extract', 'agentic', 'router', or 'pipeline')`)
    }
    profiles[name] = { ...t, name, mode: t.mode }
  }
  if (!Object.keys(profiles).length) throw new ConfigError(`${path} declares no profiles`)

  let pipeline: PipelineConfig | undefined
  if (pipelineRaw) {
    const router = typeof pipelineRaw.router === 'string' ? pipelineRaw.router : ''
    const workflows = Array.isArray(pipelineRaw.workflows)
      ? pipelineRaw.workflows.filter((name): name is string => typeof name === 'string')
      : []
    const defaultWorkflow = typeof pipelineRaw.default === 'string' ? pipelineRaw.default : workflows[0] ?? ''
    if (!router) throw new ConfigError(`${path}: pipeline.router must name a router profile`)
    if (!profiles[router] || profiles[router].mode !== 'router') {
      throw new ConfigError(`${path}: pipeline router '${router}' is not a declared router profile`)
    }
    if (workflows.length === 0) throw new ConfigError(`${path}: pipeline.workflows must name at least one workflow`)
    for (const workflow of workflows) {
      if (!profiles[workflow] || profiles[workflow].mode !== 'pipeline') {
        throw new ConfigError(`${path}: pipeline workflow '${workflow}' is not a declared pipeline-mode profile`)
      }
    }
    if (!workflows.includes(defaultWorkflow)) {
      throw new ConfigError(`${path}: pipeline default '${defaultWorkflow}' is not in pipeline.workflows`)
    }
    pipeline = { router, workflows, defaultWorkflow }
  }

  return { base: dirname(path), profiles, pipeline }
}

export const requireProfile = (cfg: Config, name: string): ProfileConfig => {
  const p = cfg.profiles[name]
  if (!p) {
    throw new ConfigError(
      `unknown profile '${name}' — ${CONFIG_NAME} declares: ${Object.keys(cfg.profiles).join(', ')}`,
    )
  }
  return p
}
