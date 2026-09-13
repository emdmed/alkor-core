/**
 * What a model costs to hold, and how much of that this host will hold at once.
 *
 * These two functions were `src/server.ts`'s, and they stayed there for as long as the
 * server was the only thing that had to answer "does this fit". The settings store has to
 * answer it too — a budget typed into the dashboard is a string that must be rejected
 * before it is persisted, not after it has been applied — and a core module reaching back
 * into the HTTP entry point for the parser would be a cycle. So the parser lives here and
 * the server re-exports it, which keeps `modelBudgetBytes` importable from both places
 * without either one owning the other.
 */
import { statSync } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * How many bytes of model this host will hold resident at once.
 *
 * `ALKOR_MODEL_BUDGET` takes `6GiB`, `600MB`, a percentage of total RAM (`50%`), a
 * plain byte count, or `0` for the old unbounded behaviour. The default is 60% of total
 * RAM: the rest of the machine — the browser the dashboard is open in, the editor, the OS
 * — is not free, and a budget that assumed it was would be a budget that swaps.
 */
export const modelBudgetBytes = (raw?: string, total: number = totalmem()): number => {
  const spec = (raw ?? '').trim()
  if (!spec) return Math.floor(total * 0.6)
  const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(spec)
  if (pct) return Math.floor((total * Number(pct[1])) / 100)
  const size = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|kib|mib|gib)?$/i.exec(spec)
  if (!size) return Math.floor(total * 0.6)
  const scale: Record<string, number> = {
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
  }
  return Math.floor(Number(size[1]) * (scale[(size[2] ?? 'b').toLowerCase()] ?? 1))
}

/**
 * Whether a budget spec is one `modelBudgetBytes` can read, as opposed to one it falls
 * back on.
 *
 * The fallback is right for an environment variable — a server that refused to boot over a
 * typo in `ALKOR_MODEL_BUDGET` would be a worse server — and wrong for a settings write,
 * where the caller is a person watching a form and silently storing "60% of RAM" under the
 * label they typed `6 GB` into is how a setting comes to mean something nobody chose.
 */
export const isBudgetSpec = (raw: string): boolean => {
  const spec = raw.trim()
  if (!spec) return true
  return /^(\d+(?:\.\d+)?)\s*%$/.test(spec) || /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|kib|mib|gib)?$/i.test(spec)
}

/**
 * What a backend is expected to cost while resident: the weights on disk, plus the KV cache
 * its context window implies.
 *
 * Both halves matter and the second is the one people forget — a 4B model quantised to 2.5
 * GB serves a 32k context out of a KV cache measured in GB of its own, so a budget counting
 * only file sizes would admit two models that cannot both run. The per-token figure is a
 * coarse average across the 3B-8B architectures this project targets rather than a
 * derivation from any one of them; a profile that knows better sets `footprint` itself.
 *
 * A model file that cannot be stat'd (not downloaded yet, wrong path) returns undefined
 * rather than zero. The distinction is the point: zero would mean "free", and the manager
 * would let it in beside anything.
 */
const KV_BYTES_PER_TOKEN = 131_072

export const footprintBytesFor = (
  model?: string,
  ctx?: number,
  override?: string | number,
): number | undefined => {
  if (override !== undefined && override !== null && override !== '') {
    const bytes = typeof override === 'number' ? Math.floor(override) : modelBudgetBytes(String(override), 0)
    if (bytes > 0) return bytes
  }
  if (!model) return undefined
  const expanded = model.startsWith('~/') ? join(homedir(), model.slice(2)) : model
  let weights: number
  try {
    weights = statSync(isAbsolute(expanded) ? expanded : resolve(expanded)).size
  } catch {
    return undefined
  }
  return weights + (ctx ?? 4096) * KV_BYTES_PER_TOKEN
}
