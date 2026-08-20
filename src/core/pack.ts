/**
 * Contract packs.
 *
 * A pack is a DIRECTORY belonging to some other project, containing that project's
 * prompts, schemas, vocabularies and eval cases. It is described by a `pack.toml`
 * manifest inside it, and nothing about its contents is known to this harness: core
 * reads files by manifest KEY, never by path.
 *
 * That indirection is the whole point. The harness is the runtime; the pack is the
 * domain. A project that wants to be evaluated here drops a manifest next to its
 * contracts and points a profile at the directory — no harness code changes, and no
 * consuming project's name appears anywhere in `src/core/`.
 *
 * Packs are deliberately NOT copied into this repo. The typical consumer is another
 * runtime evaluating the same model against the same contracts, and a copy is a
 * divergence waiting to happen: what actually drifts between two implementations is
 * prompts, schemas and scoring rules — all data. Share the data, keep the runtime
 * native to each side.
 */
import { readFileSync, existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { envSuffix } from './config.ts'

export const MANIFEST_NAME = 'pack.toml'

/**
 * The pack format this harness reads.
 *
 * The format is an interface with implementors the harness cannot see — a pack is normally
 * also read by the consuming project's own runtime — so it carries a version and refuses a
 * future one rather than silently misreading it. Absent means 1: every pack written before
 * this existed is a valid `spec = 1` pack, and none of them should have to be edited.
 */
export const SPEC_VERSION = 1

export interface PackManifest {
  /** Format version. Absent means 1. */
  spec?: number
  /** Identifies the pack in errors and trace lines. Free-form. */
  name: string
  /**
   * Manifest key -> path relative to the pack directory. `..` is allowed: a pack usually
   * sits in a `contracts/` subdirectory and needs to reach sibling data.
   */
  files?: Record<string, string>
  /**
   * Per-case documents, as a path template containing `{case}`. Used by eval modes that
   * run one document per case.
   */
  documents?: string
  /**
   * Placeholder -> file key, substituted into a rendered prompt by `render`. These are
   * whole-file includes; computed values are passed by the profile instead.
   */
  include?: Record<string, string>
}

export class PackError extends Error {}

export interface Pack {
  name: string
  /** Resolved format version — `spec` in the manifest, or 1. Reported in a run record. */
  spec: number
  root: string
  /** Absolute path for a manifest key. Throws if the key is not declared. */
  path(key: string): string
  /** File contents for a manifest key. */
  read(key: string): string
  /** Parsed JSON for a manifest key. */
  json<T = unknown>(key: string): T
  /** Parsed TOML for a manifest key. */
  toml<T = unknown>(key: string): T
  /** Whether a key is declared AND the file it names exists on disk. */
  has(key: string): boolean
  /** Contents of the per-case document named by `documents`. */
  document(caseName: string): string
  /**
   * Read the file at `key` and substitute `{{PLACEHOLDER}}` markers: first every entry
   * in the manifest's `include` table, then the caller's `vars`. Substitution is literal
   * and single-pass per key, so an included file containing `{{X}}` is left alone.
   */
  render(key: string, vars?: Record<string, string>): string
}

/**
 * Resolve where a pack lives. Precedence: explicit argument (CLI `--pack`), then
 * `PACK_ROOT_<PROFILE>`, then the profile's `pack` entry in profiles.toml. Relative
 * paths resolve against `base` — the directory of whichever file declared them — so a
 * config entry means the same thing regardless of the shell's cwd.
 */
export const resolvePackRoot = (
  profile: string,
  opts: { explicit?: string; configured?: string; base: string },
): string => {
  const env = process.env[`PACK_ROOT_${envSuffix(profile)}`]
  const chosen = opts.explicit ?? env ?? opts.configured
  if (!chosen) {
    throw new PackError(
      `profile '${profile}' needs a contract pack, but none is configured — ` +
        `set 'pack' for [${profile}] in profiles.toml, export PACK_ROOT_${envSuffix(profile)}, or pass --pack DIR`,
    )
  }
  // An explicit flag and an env var come from a shell, so they resolve against cwd;
  // a configured value resolves against the config file that declared it.
  const relativeTo = (opts.explicit ?? env) !== undefined ? process.cwd() : opts.base
  return isAbsolute(chosen) ? chosen : resolve(relativeTo, chosen)
}

export const loadPack = (root: string): Pack => {
  const manifestPath = join(root, MANIFEST_NAME)
  if (!existsSync(manifestPath)) {
    // Name both the directory we looked in and the file we wanted: the usual cause is a
    // pack root pointing one level up or down from the manifest.
    throw new PackError(
      `no ${MANIFEST_NAME} in '${root}' — a contract pack must carry a manifest naming its files`,
    )
  }

  let manifest: PackManifest
  try {
    manifest = parseToml(readFileSync(manifestPath, 'utf8')) as unknown as PackManifest
  } catch (e) {
    throw new PackError(`${manifestPath} is not valid TOML: ${(e as Error).message}`)
  }
  if (!manifest.name) throw new PackError(`${manifestPath} is missing 'name'`)

  const spec = manifest.spec ?? SPEC_VERSION
  if (!Number.isInteger(spec) || spec < 1) {
    throw new PackError(`${manifestPath}: spec must be a positive integer, got ${JSON.stringify(manifest.spec)}`)
  }
  if (spec > SPEC_VERSION) {
    // Refuse rather than try. A newer pack may declare keys with meanings this harness does
    // not have, and reading it under the old rules produces a number rather than an error —
    // which is the one outcome an eval must never produce from a misunderstanding.
    throw new PackError(
      `pack '${manifest.name}' declares spec ${spec}, but this harness reads spec ${SPEC_VERSION} — upgrade the harness`,
    )
  }

  const files = manifest.files ?? {}

  const path = (key: string): string => {
    const rel = files[key]
    if (!rel) {
      throw new PackError(
        `pack '${manifest.name}' declares no file for '${key}' — ` +
          `add it under [files] in ${manifestPath} (declared: ${Object.keys(files).join(', ') || 'none'})`,
      )
    }
    return resolve(root, rel)
  }

  const read = (key: string): string => {
    const abs = path(key)
    try {
      return readFileSync(abs, 'utf8')
    } catch (e) {
      throw new PackError(`pack '${manifest.name}' key '${key}' -> ${abs}: ${(e as Error).message}`)
    }
  }

  return {
    name: manifest.name,
    spec,
    root,
    path,
    read,
    has: (key) => Boolean(files[key]) && existsSync(resolve(root, files[key])),
    json: <T,>(key: string) => {
      try {
        return JSON.parse(read(key)) as T
      } catch (e) {
        throw new PackError(`pack '${manifest.name}' key '${key}' is not valid JSON: ${(e as Error).message}`)
      }
    },
    toml: <T,>(key: string) => {
      try {
        return parseToml(read(key)) as T
      } catch (e) {
        throw new PackError(`pack '${manifest.name}' key '${key}' is not valid TOML: ${(e as Error).message}`)
      }
    },
    document: (caseName: string) => {
      if (!manifest.documents) {
        throw new PackError(`pack '${manifest.name}' declares no 'documents' template, so it has no per-case documents`)
      }
      const abs = resolve(root, manifest.documents.replaceAll('{case}', caseName))
      try {
        return readFileSync(abs, 'utf8')
      } catch (e) {
        throw new PackError(`pack '${manifest.name}' document for case '${caseName}' -> ${abs}: ${(e as Error).message}`)
      }
    },
    render: (key: string, vars: Record<string, string> = {}) => {
      let out = read(key)
      for (const [placeholder, fileKey] of Object.entries(manifest.include ?? {})) {
        out = out.replaceAll(`{{${placeholder}}}`, read(fileKey))
      }
      for (const [placeholder, value] of Object.entries(vars)) {
        out = out.replaceAll(`{{${placeholder}}}`, value)
      }
      // A surviving marker means the prompt silently loses a section it was written to
      // carry, and the eval that follows would be measuring a different prompt.
      const leftover = out.match(/\{\{[A-Z0-9_]+\}\}/)
      if (leftover) {
        throw new PackError(
          `pack '${manifest.name}' key '${key}': placeholder ${leftover[0]} was never substituted — ` +
            'declare it under [include] in the manifest or pass it as a render variable',
        )
      }
      return out
    },
  }
}
