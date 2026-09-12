/**
 * Whether this machine can run anything at all, asked before a verb goes and finds out.
 *
 * A fresh clone has neither an inference engine nor weights, and the first thing anyone
 * types is a command that needs both. Without this the answer arrives from the bottom of
 * the transport as `fetch failed` — which names the symptom, not the cause, and reads the
 * same whether llama.cpp was never installed, the weights were never fetched, or the server
 * is simply not running. Those are three different next commands.
 *
 * This module only LOOKS. It installs nothing, downloads nothing and starts nothing: the
 * harness does not start servers, because a server's flags are part of a measurement (see
 * the README). What it produces is the sentence that names the missing piece and the command
 * that supplies it.
 *
 * Order matters. A reachable server settles the question by itself — the weights may live on
 * another machine entirely, and a run pointed at one with `--url` must not be refused over a
 * cache directory that was never going to be read. So the probe comes first and everything
 * below it is only consulted when nothing is listening.
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { DEFAULT_URL, probeServer } from './client.ts'
import { expandTilde } from './llama-manager.ts'
import type { Pack } from './pack.ts'

/** The binary this harness talks to. Named once so a check and a hint cannot disagree. */
export const ENGINE = 'llama-server'

/**
 * The weights a pack declares as its default — as much of the declaration as a check reads.
 *
 * Core does not parse the pack's models file itself: which key holds it is the pack's
 * business, and this module would otherwise have to know a layout it has no stake in.
 */
export interface DeclaredWeights {
  hfRepo?: string
  hfFile?: string
  sizeBytes?: number
}

export interface PreflightResult {
  /** The URL the run would actually use, after `--url` and the profile's entry. */
  url: string
  /** Anything listening there. When true, nothing below blocks. */
  serverUp: boolean
  /** Absolute path to the engine, or undefined when it could not be found at all. */
  binary?: string
  /**
   * Whether the engine is reachable by NAME. False means it was found somewhere specific but
   * PATH does not resolve it — `scripts/llama-server.sh` execs the bare name, so this is the
   * difference between "installed" and "the documented commands will work".
   */
  binaryOnPath?: boolean
  /**
   * Where the declared weights were found, and how.
   *
   * Undefined means NOT FOUND, which is weaker than absent: a machine may hold the file
   * somewhere none of the four sources name, and `-hf` would fetch it anyway. So a miss is
   * reported as something to expect a download for, never as a refusal in its own right.
   */
  weights?: WeightsFound
  declared?: DeclaredWeights
  /**
   * Offload devices the engine reports, when asked. Undefined means NOT ASKED rather than
   * none — the question costs a subprocess, so only the verbs a human is reading pay for it.
   */
  devices?: string[]
}

/**
 * The first executable named `name` on PATH.
 *
 * Written out rather than shelling to `which`: a spawn to answer "is this installed" is a
 * process and a shell on a path that runs before every command, and it reports the same
 * thing this does.
 */
export const findOnPath = (name: string, env: NodeJS.ProcessEnv = process.env): string | undefined => {
  if (!env.PATH) return undefined
  // PATHEXT only means anything on Windows; elsewhere the name is the whole filename.
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE').split(';') : ['']
  for (const dir of env.PATH.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not there, or there and not executable. Either way it is not what we are looking for.
      }
    }
  }
  return undefined
}

/**
 * The places a build or a package manager leaves the engine when PATH does not have it.
 *
 * Separated out and injectable because it is the one part of this module whose answer depends
 * on the machine rather than on its arguments — a test that could not switch it off would be
 * asserting against whatever happens to be installed on the box running it.
 */
export const engineCandidates = (): string[] => {
  const home = homedir()
  return [
    // A source build, which is how most people have llama.cpp at all.
    join(home, 'llama.cpp', 'build', 'bin', ENGINE),
    join(home, 'llama.cpp', ENGINE),
    join(home, 'src', 'llama.cpp', 'build', 'bin', ENGINE),
    // Package managers that install outside a default PATH on some setups.
    `/opt/homebrew/bin/${ENGINE}`,
    `/usr/local/bin/${ENGINE}`,
    `/usr/bin/${ENGINE}`,
  ]
}

/**
 * The engine, wherever it is.
 *
 * PATH is the documented contract — the README asks for `llama-server` on it, and
 * `scripts/llama-server.sh` execs the bare name — but "installed" and "on PATH" are not the
 * same claim, and the usual way to get llama.cpp is to build it, which leaves the binary in
 * a build tree nobody exports. Reporting "not installed" to someone who built it an hour ago
 * is the same class of mistake as telling them to re-download weights they already have.
 *
 * So: an explicit override first, then PATH, then the places a build or a package manager
 * actually leaves it. `onPath` is reported separately because it is a real distinction — the
 * launch script needs the name resolvable, not merely a file existing somewhere.
 */
export const findEngine = (
  env: NodeJS.ProcessEnv = process.env,
  candidates: string[] = engineCandidates(),
): { path: string; onPath: boolean } | undefined => {
  const usable = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  // Set by someone who knows where it is. Honoured even off PATH, and `./start` passes it
  // through to the interactive server so the override actually spawns that binary.
  const onPath = findOnPath(ENGINE, env)
  const override = env.ALKOR_LLAMA_BIN
  if (override) {
    const expanded = expandTilde(override)
    // `onPath` describes the NAME, not this path: an override pointing at the same binary PATH
    // already resolves is on PATH, and warning that it is not would be advice to fix nothing.
    if (usable(expanded)) return { path: expanded, onPath: onPath === expanded }
  }
  if (onPath) return { path: onPath, onPath: true }
  for (const c of candidates) if (usable(c)) return { path: c, onPath: false }
  return undefined
}

/**
 * Where llama.cpp keeps what `-hf` downloaded.
 *
 * `LLAMA_CACHE` overrides, as it does there, and `XDG_CACHE_HOME` is honoured because
 * llama.cpp honours it — hardcoding `~/.cache` would look in the wrong place on exactly the
 * machines that moved it.
 */
export const cacheDirs = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const home = homedir()
  const xdg = env.XDG_CACHE_HOME ?? join(home, '.cache')
  return [
    env.LLAMA_CACHE,
    join(xdg, 'llama.cpp'),
    join(home, 'Library', 'Caches', 'llama.cpp'),
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'llama.cpp') : undefined,
  ].filter((d): d is string => Boolean(d))
}

/**
 * Ask the engine something and get its stdout, or undefined if it would not answer.
 *
 * Every question here is a flag that exits immediately — no model is loaded and nothing is
 * downloaded. An engine too old for the flag, or one that will not run at all, is reported as
 * "did not answer" rather than as a failure: not knowing is the state we were already in.
 */
const engineQuery = (enginePath: string, args: string[]): string | undefined => {
  try {
    return execFileSync(enginePath, args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
}

/**
 * The quantisation a declared filename names, e.g. `Q4_0` from `gemma-4-E4B-it-Q4_0.gguf`.
 *
 * Undefined when the name does not carry one, in which case a caller matching against the
 * engine's cache listing has to fall back to the repository alone and accept the looser claim.
 */
export const declaredQuant = (hfFile?: string): string | undefined =>
  hfFile?.match(/-((?:IQ|Q)\d+[_A-Z0-9]*|BF16|F16|F32)\.gguf$/i)?.[1]

/**
 * The compute devices the engine can offload to, as it reports them.
 *
 * Worth asking because of what its absence costs on this pack specifically. The
 * `[sampling.shock]` note in `packs/clinical/models.default.toml` records a CPU-only run
 * where one cold case measured 324 s and every case came back reading `cannot reach
 * llama-server` — a deadline expiring, dressed as a server that was down. Someone who has
 * just cloned this and is watching a ~4 GB model generate at 0.6 tok/s has no way to tell
 * "slow" from "broken", and `-ngl 99` in the start command implies a GPU that may not exist.
 */
export const findDevices = (enginePath: string): string[] => {
  const out = engineQuery(enginePath, ['--list-devices'])
  if (!out) return []
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && l !== '(none)')
}

/** Where a set of weights was found, so the report can say how it knows. */
export type WeightsSource = 'LLAMA_MODEL' | 'profiles.toml' | 'llama.cpp cache' | 'llama.cpp -hf cache'

export interface WeightsFound {
  path: string
  source: WeightsSource
  /** Set when the file is there but is not the declared number of bytes. */
  sizeMismatch?: { expected: number; actual: number }
}

export interface FindWeightsOptions {
  env?: NodeJS.ProcessEnv
  /** The profile's `model` from profiles.toml — the repository's own statement of location. */
  modelPath?: string
  /** The engine, used to ask it what it has cached. Skipped when absent. */
  enginePath?: string
}

/**
 * The declared weights on this machine, if they can be found — and how.
 *
 * Four sources, most authoritative first, because each is a different kind of claim:
 *
 * 1. `LLAMA_MODEL`, which is what someone launching by hand would pass.
 * 2. The profile's `model` in profiles.toml. This one was the hole: the repository states
 *    where its weights are, and a check that ignored that file reported "not cached, ~4.6 GB
 *    to download" on a machine holding the exact bytes at the path its own config named.
 * 3. The llama.cpp cache directories, matched by filename suffix — llama.cpp decorates a
 *    cached download with the repo it came from, and that decoration is its business.
 * 4. The engine itself, via `--cache-list`, which is the only ANSWER rather than a guess
 *    about where an answer might be written. It is asked last because it costs a subprocess.
 *
 * A file found at the declared size is a find. A file found at the wrong size is reported
 * with the mismatch rather than as a miss: a half-finished download is a specific problem
 * with a specific fix, and calling it "absent" hides that the path is right.
 */
export const findWeights = (
  declared: DeclaredWeights | undefined,
  o: FindWeightsOptions = {},
): WeightsFound | undefined => {
  const env = o.env ?? process.env
  const sized = (path: string, source: WeightsSource): WeightsFound => {
    const found: WeightsFound = { path, source }
    if (declared?.sizeBytes) {
      try {
        const actual = statSync(path).size
        if (actual !== declared.sizeBytes) found.sizeMismatch = { expected: declared.sizeBytes, actual }
      } catch {
        // Unreadable for a reason that is not this check's to diagnose.
      }
    }
    return found
  }

  if (env.LLAMA_MODEL) {
    const p = expandTilde(env.LLAMA_MODEL)
    if (existsSync(p)) return sized(p, 'LLAMA_MODEL')
  }
  if (o.modelPath) {
    const p = expandTilde(o.modelPath)
    if (existsSync(p)) return sized(p, 'profiles.toml')
  }
  if (!declared?.hfFile) return undefined

  for (const dir of cacheDirs(env)) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    const hit = entries.find((e) => e === declared.hfFile || e.endsWith(`_${declared.hfFile}`))
    if (hit) return sized(join(dir, hit), 'llama.cpp cache')
  }

  // The engine's own listing, which is an answer rather than a guess about where an answer
  // might be written. `--cache-list` prints one `repo:quant` per cached model, and it is the
  // same flag on `llama-cli` and `llama-server` — they share llama.cpp's argument parser, so
  // there is nothing to gain by preferring one binary over the other.
  //
  // Matched on repo AND quant. The repo alone is not the identity of a set of weights: one
  // repository publishes every quantisation, so a machine holding `…-GGUF:Q8_0` would satisfy
  // a repo-only match for a pack that pinned Q4_0 — and this pack pins weights by sha256
  // precisely because which bytes ran is the whole claim.
  if (o.enginePath && declared.hfRepo) {
    const listing = engineQuery(o.enginePath, ['--cache-list'])
    if (listing) {
      const repo = declared.hfRepo.toLowerCase()
      const quant = declaredQuant(declared.hfFile)
      const wanted = quant ? `${repo}:${quant.toLowerCase()}` : repo
      const hit = listing
        .toLowerCase()
        .split('\n')
        .some((line) => line.includes(wanted))
      if (hit) {
        return {
          path: `${declared.hfRepo}${quant ? `:${quant}` : ''} (in the engine’s own cache)`,
          source: 'llama.cpp -hf cache',
        }
      }
    }
  }
  return undefined
}

/**
 * The default weights a pack declares, or undefined when it declares none.
 *
 * The `[generation]` block exists so a stored result stays attributable to exact bytes, and
 * until now nothing read it — the sha256 and the size were a statement to a human. The same
 * declaration answers "is it here yet", which is the one question a fresh clone has.
 *
 * A pack with no models file is not an error: only a pack that pins a model has one to miss.
 */
export const declaredWeights = (pack: Pack): DeclaredWeights | undefined => {
  if (!pack.has('models')) return undefined
  const generation = pack.toml<{
    generation?: { hf_repo?: string; hf_file?: string; size_bytes?: number }
  }>('models').generation
  if (!generation) return undefined
  return { hfRepo: generation.hf_repo, hfFile: generation.hf_file, sizeBytes: generation.size_bytes }
}

export interface PreflightOptions {
  url?: string
  declared?: DeclaredWeights
  env?: NodeJS.ProcessEnv
  /** The profile's `model` from profiles.toml, unexpanded. See `findWeights`. */
  modelPath?: string
  /** Override the machine-dependent engine search. See `engineCandidates`. */
  engineCandidates?: string[]
  /**
   * Ask the engine what it can offload to. Off by default: the gate ahead of every `extract`
   * runs this check, and it has no use for an answer it would not print.
   */
  devices?: boolean
}

/** Look at the machine. One network probe, a few filesystem questions, no side effects. */
export const preflight = async (o: PreflightOptions = {}): Promise<PreflightResult> => {
  const env = o.env ?? process.env
  const url = (o.url ?? env.LLAMA_URL ?? DEFAULT_URL).replace(/\/+$/, '')
  const serverUp = await probeServer(url)
  const engine = findEngine(env, o.engineCandidates ?? engineCandidates())
  return {
    url,
    serverUp,
    binary: engine?.path,
    binaryOnPath: engine?.onPath,
    weights: findWeights(o.declared, { env, modelPath: o.modelPath, enginePath: engine?.path }),
    declared: o.declared,
    devices: o.devices && engine ? findDevices(engine.path) : undefined,
  }
}

/** Decimal GB, which is how the README and the pack's own comment quote this download. */
const gb = (bytes?: number): string => (bytes ? `~${(bytes / 1e9).toFixed(1)} GB` : 'size not declared')

/**
 * The command that starts a server for this result, with the weights it would load.
 *
 * A LOCAL file that was found wins over `LLAMA_HF`, and the ordering is the whole point:
 * `-hf` re-fetches into the engine's own cache, so handing someone that command while their
 * weights sit at a path this check just read would spend 4.6 GB to arrive back where they
 * started. Only when nothing was found locally is a download the right advice.
 */
export const startCommand = (r: PreflightResult): string => {
  const port = (() => {
    try {
      return new URL(r.url).port || '8080'
    } catch {
      return '8080'
    }
  })()
  const local = r.weights && r.weights.source !== 'llama.cpp -hf cache' ? r.weights.path : undefined
  const model = local
    ? `LLAMA_MODEL=${local}`
    : r.declared?.hfRepo
      ? `LLAMA_HF=${r.declared.hfRepo}`
      : 'LLAMA_MODEL=/path/to/weights.gguf'
  // `-ngl 99` offloads layers to a GPU. Printed only when there might be one: on a box the
  // engine says has no devices it is a flag that does nothing, and suggesting it implies the
  // run is about to be fast. `devices` undefined means the question was not asked, so it stays.
  const offload = r.devices && r.devices.length === 0 ? '' : '-ngl 99 '
  return `LLAMA_PORT=${port} ${model} scripts/${ENGINE}.sh ${offload}--no-webui --parallel 1`
}

export interface BlockerOptions {
  /**
   * The caller starts model backends itself, so a dark port is expected rather than broken.
   *
   * True for the interactive server, which spawns a backend on first request and sweeps it
   * after an idle window — there, "nothing is listening yet" is the normal state a minute
   * before the first request, and refusing over it would refuse the thing that fixes it.
   * The ENGINE still has to exist: nothing can spawn a binary that is not there.
   */
  managed?: boolean
}

/**
 * Why this run cannot start, or undefined when nothing here stops it.
 *
 * Only a missing ENGINE and a dark port block. A weights miss never blocks on its own: see
 * `weights` above, and `-hf` fetches on first use regardless — it changes what the user
 * should expect to happen next (a download), not whether the command is worth running.
 */
export const blocker = (r: PreflightResult, o: BlockerOptions = {}): string | undefined => {
  if (r.serverUp) return undefined
  if (o.managed && r.binary) return undefined
  if (!r.binary) {
    // The one reader who has nothing yet, and the only one for whom a bare repository link
    // is not an instruction. llama.cpp is the only supported backend, so naming how to get it
    // is this message's job rather than an aside.
    const install =
      'Install llama.cpp — the only backend this supports:\n\n' +
      '  macOS          brew install llama.cpp\n' +
      '  Linux          check your package manager first (e.g. pacman -S llama.cpp,\n' +
      '                 apt search llama.cpp); otherwise build from source\n' +
      '  from source    https://github.com/ggml-org/llama.cpp  (cmake -B build && cmake --build build)\n\n' +
      `However it arrives, this needs \`${ENGINE}\` on your PATH — or set ALKOR_LLAMA_BIN to it.`

    // In managed mode the caller spawns backends itself, so telling the reader to launch one
    // by hand describes a different program than the one they just ran.
    if (o.managed) {
      return (
        `${ENGINE} could not be found. Nothing was started.\n` +
        'Looked on PATH, at ALKOR_LLAMA_BIN, and in the usual build and install locations.\n\n' +
        `${install}\n\n` +
        'Then run ./start again — it loads models for you, but it cannot spawn a binary\n' +
        'that is not installed.'
      )
    }
    return (
      `${ENGINE} could not be found, and nothing is listening at ${r.url}.\n` +
      'Looked on PATH, at ALKOR_LLAMA_BIN, and in the usual build and install locations.\n' +
      'This harness talks to a server you start; it does not bundle one.\n\n' +
      `${install}\n\n` +
      'Then start it:\n\n' +
      `  ${startCommand(r)}\n\n` +
      'Already running one elsewhere? Point this run at it with --url.'
    )
  }
  const weights = r.declared?.hfFile
    ? r.weights
      ? `The declared weights are here: ${r.weights.path} (${r.weights.source}).`
      : `The declared weights (${r.declared.hfFile}, ${gb(r.declared.sizeBytes)}) were not found,\n` +
        'so the first start downloads them. That is the download, not a hang.'
    : ''
  return (
    `Nothing is listening at ${r.url}, and ${ENGINE} is installed but not running.\n` +
    (weights ? `${weights}\n` : '') +
    '\nStart it in another shell:\n\n' +
    `  ${startCommand(r)}\n\n` +
    'Already running one elsewhere? Point this run at it with --url.'
  )
}

/** One line per check, in the order a first run depends on them. What `doctor` prints. */
export const report = (r: PreflightResult): string[] => {
  // Wide enough for the longest label, so the findings line up as a column rather than as
  // sentences that happen to start near each other.
  const label = (s: string) => s.padEnd(ENGINE.length + 2)
  const indent = label('')

  const engine = !r.binary
    ? 'NOT FOUND — build or install llama.cpp'
    : r.binaryOnPath
      ? r.binary
      : `${r.binary}\n${indent}found, but NOT on PATH — scripts/${ENGINE}.sh execs the bare name.\n` +
        `${indent}Add its directory to PATH, or set ALKOR_LLAMA_BIN to this path.`

  let weights: string
  if (!r.declared?.hfFile) {
    weights = '(none declared — pass --profile to check a pack’s own)'
  } else if (r.weights) {
    weights = `${r.weights.path}\n${indent}found via ${r.weights.source}`
    if (r.weights.sizeMismatch) {
      const { expected, actual } = r.weights.sizeMismatch
      weights +=
        `\n${indent}SIZE MISMATCH — declared ${expected} bytes, found ${actual}.\n` +
        `${indent}A partial download, or different weights under the declared name.`
    }
  } else {
    weights =
      `not found — ${r.declared.hfFile}, ${gb(r.declared.sizeBytes)}, downloaded on first start\n` +
      `${indent}looked at: LLAMA_MODEL, the profile's model in profiles.toml,\n` +
      `${indent}${cacheDirs().join(', ')}${r.binary ? `,\n${indent}and ${ENGINE} --cache-list` : ''}`
  }

  const lines = [
    `${label(ENGINE)}${engine}`,
    `${label('weights')}${weights}`,
    `${label('server')}${r.serverUp ? `up at ${r.url}` : `nothing listening at ${r.url}`}`,
  ]

  // Only when it was asked for, and only worth a line when the answer changes what to expect.
  if (r.devices) {
    lines.push(
      r.devices.length
        ? `${label('devices')}${r.devices.join(', ')}`
        : `${label('devices')}none — CPU only, so -ngl offloads nothing\n` +
          `${indent}Expect minutes per case, not seconds. That is slow, not broken:\n` +
          `${indent}a cold case on a CPU-only box has measured 324s.`,
    )
  }
  return lines
}
