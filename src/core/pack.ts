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
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
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
export const SPEC_VERSION = 3

/**
 * What each version of the format ADDED, in the words a pack author needs.
 *
 * This table exists because the alternative was measured and is bad. Two keys were added to
 * the reference pack in one afternoon — `[clinical.quoteVerification].accentSensitive`, which
 * the profile REQUIRES, and `[clinical].corpusSynthetic`, which decides whether traces hold
 * patient text — and `spec` was left at 1. Every pack written against the format the day
 * before stopped loading, and what it got for its trouble was a message about a missing TOML
 * key with no statement anywhere that the format had moved underneath it.
 *
 * A version number that nobody bumps is not a version number. Bumping it is only half the
 * job: a reader who is told "this is spec 2 and yours is spec 1" and not told what changed
 * has been given a different way to be stuck. So the harness carries the changelog, and any
 * loader — core's, or a profile reading its own table out of the manifest — can name the
 * version a key arrived in rather than merely that the key is absent.
 *
 * Keyed by the version that INTRODUCED each requirement. Nothing is ever removed from here:
 * the entries are what a pack author reads when their pack is older than the harness, and
 * that gap only grows.
 */
export const SPEC_CHANGES: Record<number, string[]> = {
  2: [
    '[clinical.quoteVerification].accentSensitive is REQUIRED — the two tasks that verify quotes ' +
      'silently disagreed about accents, so one pack produced two different provenance measurements',
    '[clinical].corpusSynthetic decides whether a trace may hold completions verbatim; a pack that ' +
      'does not set it is treated as holding real records and its traces are elided to a digest',
  ],
  3: [
    '`documents` may be a TABLE of kind -> template as well as a single template — a pack whose ' +
      'tasks read different kinds of source document (a written note and a dictated transcript) ' +
      'used to have to file both under one filename convention. A string still means what it did: ' +
      'the `default` kind, which is what `document(case)` reads.',
  ],
}

/**
 * What a pack of version `spec` is missing relative to what this harness reads, as prose.
 *
 * Empty when the pack is current. Exported so a profile that finds one of its own required
 * keys absent can say WHICH VERSION it arrived in, which is the difference between "add this
 * key" and "your pack predates a format change, here is the whole of it".
 */
export const specGap = (spec: number): string[] =>
  Object.entries(SPEC_CHANGES)
    .filter(([v]) => Number(v) > spec)
    .sort(([a], [b]) => Number(a) - Number(b))
    .flatMap(([v, changes]) => changes.map((c) => `spec ${v}: ${c}`))

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
   *
   * A TABLE of kind -> template when a pack's tasks read different KINDS of source document.
   * The reference pack grades three tasks over written notes and a fourth over dictated
   * transcripts, and the two corpora are not interchangeable: a transcript filed as
   * `notes/x.note.txt` is mislabelled in the one directory of this repository where what a
   * document is matters most. A bare string is the `default` kind and means exactly what it
   * meant in spec 1 and 2, so no existing pack changes.
   */
  documents?: string | Record<string, string>
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
  /** The parsed manifest itself, so a profile can read its own tables without re-parsing. */
  manifest: Record<string, unknown>
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
  /**
   * Contents of the per-case document named by `documents`. `kind` selects a template when
   * the manifest declares a table of them; omitted, it reads the `default` kind, which is
   * what a bare `documents` string declares.
   */
  document(caseName: string, kind?: string): string
  /**
   * Read the file at `key` and substitute `{{PLACEHOLDER}}` markers: first every entry
   * in the manifest's `include` table, then the caller's `vars`. Substitution is literal
   * and single-pass per key, so an included file containing `{{X}}` is left alone.
   */
  render(key: string, vars?: Record<string, string>): string
  /**
   * sha256 of every file this pack has actually READ, keyed by path relative to the pack
   * root. Sorted, so two runs of the same contracts produce byte-identical records.
   *
   * Read rather than declared, and that distinction is the whole value. A record listing
   * the manifest's keys would claim coverage of files this run never opened, and would
   * silently omit the per-case documents, which are named by a template rather than by a
   * key — the notes are the measured input, so a record that pins the answer key and not
   * the notes pins the wrong half. Call it at the END of a run.
   */
  digest(): Record<string, string>
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

  // Absent means 1, NOT "whatever this harness reads". Defaulting to the current version
  // would make every unversioned pack claim to be current on whatever harness opened it, and
  // the one thing `spec` exists to do — let a reader know the pack predates a change — would
  // be answered with the reader's own version number.
  const spec = manifest.spec ?? 1
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

  // One shape downstream, whichever shape the manifest used: a bare string is the `default`
  // kind. Normalised HERE rather than at every call site, so `document()` has one code path
  // and a pack cannot mean two things by the same key.
  const documents: Record<string, string> =
    typeof manifest.documents === 'string'
      ? { default: manifest.documents }
      : { ...(manifest.documents ?? {}) }
  for (const [kind, template] of Object.entries(documents)) {
    if (typeof template !== 'string') {
      throw new PackError(`${manifestPath}: documents.${kind} must be a path template, got ${JSON.stringify(template)}`)
    }
    // A template with no `{case}` resolves to the same file for every case, which is a corpus
    // of one note graded N times reporting a number for N. Refused rather than read: the run
    // it produces looks exactly like the run the author wanted.
    if (!template.includes('{case}')) {
      throw new PackError(
        `${manifestPath}: documents.${kind} = '${template}' contains no '{case}', ` +
          'so every case would read the same file',
      )
    }
  }

  const files = manifest.files ?? {}
  // Every file handed out, so `digest` can state what was read rather than what was offered.
  const opened = new Set<string>()
  opened.add(manifestPath)

  const path = (key: string): string => {
    const rel = files[key]
    if (!rel) {
      throw new PackError(
        `pack '${manifest.name}' declares no file for '${key}' — ` +
          `add it under [files] in ${manifestPath} (declared: ${Object.keys(files).join(', ') || 'none'})`,
      )
    }
    const abs = resolve(root, rel)
    opened.add(abs)
    return abs
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
    manifest: manifest as unknown as Record<string, unknown>,
    path,
    read,
    has: (key) => Boolean(files[key]) && existsSync(resolve(root, files[key]!)),
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
    document: (caseName: string, kind = 'default') => {
      const template = documents[kind]
      if (!template) {
        // Name the kinds that ARE declared, for the reason `path` does: the usual cause is a
        // profile reading a corpus the pack files under another name, and a bare "no template"
        // leaves the author to guess whether they misspelled the kind or never wrote it.
        const declared = Object.keys(documents)
        throw new PackError(
          declared.length
            ? `pack '${manifest.name}' declares no '${kind}' documents template (declared: ${declared.join(', ')})`
            : `pack '${manifest.name}' declares no 'documents' template, so it has no per-case documents`,
        )
      }
      const abs = resolve(root, template.replaceAll('{case}', caseName))
      opened.add(abs)
      try {
        return readFileSync(abs, 'utf8')
      } catch (e) {
        throw new PackError(`pack '${manifest.name}' ${kind} document for case '${caseName}' -> ${abs}: ${(e as Error).message}`)
      }
    },
    digest: () => {
      const out: Record<string, string> = {}
      for (const abs of [...opened].sort()) {
        if (!existsSync(abs)) continue
        out[relative(root, abs)] = createHash('sha256').update(readFileSync(abs)).digest('hex')
      }
      return out
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
