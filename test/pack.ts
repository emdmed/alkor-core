/**
 * Test-side pack resolution.
 *
 * The harness must be checkable without any consuming project on disk, so tests that need
 * a real contract pack SKIP when none is configured rather than fail. A skipped parity
 * test is honest — it says the comparison was not run — where a failing one would say the
 * contracts disagree, which is a different and much more alarming claim.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/core/config.ts'
import { loadPack, resolvePackRoot, MANIFEST_NAME, type Pack } from '../src/core/pack.ts'

export const packFor = (profile: string): { pack?: Pack; skip: string | false } => {
  let cfg
  try {
    cfg = loadConfig()
  } catch (e) {
    return { skip: `no profiles.toml: ${(e as Error).message}` }
  }
  const configured = cfg.profiles[profile]?.pack as string | undefined
  let root: string
  try {
    root = resolvePackRoot(profile, { configured, base: cfg.base })
  } catch (e) {
    return { skip: (e as Error).message }
  }
  if (!existsSync(join(root, MANIFEST_NAME))) {
    return { skip: `no contract pack at ${root} (set PACK_ROOT_${profile.toUpperCase()})` }
  }
  return { pack: loadPack(root), skip: false }
}
