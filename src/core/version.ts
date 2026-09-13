/**
 * What version of the harness produced a result.
 *
 * Read from package.json rather than written as a constant, because a constant is a second
 * statement of the version and the two disagree the moment one of them is bumped. A run
 * record naming the wrong harness is worse than one naming none: it looks reproducible.
 *
 * Resolved once at import. If package.json cannot be read — an unusual bundling, a stripped
 * install — the version is `unknown` rather than a throw, since failing an eval over a
 * label would be the wrong trade.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export const HARNESS_VERSION = read()

/**
 * The release stage — absent today, on a plain `0.1.1` — read off the version rather than
 * declared beside it.
 *
 * Same reason the version is not a constant: a stage written down separately is a second
 * claim about the same thing, and the day the version is bumped out of alpha the banner
 * that says "alpha" keeps saying it. A semver prerelease tag already carries this, so the
 * tag is the statement and everything that shows a stage reads it from here.
 *
 * `undefined` on a plain release version, which is what lets every caller render the badge
 * conditionally without testing for a magic string.
 */
export const HARNESS_STAGE: string | undefined =
  /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(HARNESS_VERSION)?.[1]

/** What the stage means for the reader, in one sentence. Empty when there is no stage. */
export const STAGE_NOTICE = HARNESS_STAGE
  ? `alkor ${HARNESS_VERSION} — ${HARNESS_STAGE} software, released for testing. Interfaces, packs and measured numbers may change.`
  : ''
