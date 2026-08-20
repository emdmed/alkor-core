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
