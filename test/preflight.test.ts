/**
 * The check that runs before a verb reaches the network.
 *
 * What these tests pin is the DECISION rather than the wording: which of the three findings
 * refuses a run and which only colours the advice. The distinction is the whole point of the
 * module — a missing engine is certain, and a weights file this did not happen to find is not,
 * because llama.cpp caches under a name of its own choosing and `-hf` fetches on first use.
 * A check that refused on the second would send someone to re-download what they already have.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  blocker,
  cacheDirs,
  declaredQuant,
  ENGINE,
  findDevices,
  findEngine,
  findOnPath,
  findWeights,
  preflight,
  report,
  startCommand,
} from '../src/core/preflight.ts'

const scratch = () => mkdtempSync(join(tmpdir(), 'alkor-preflight-'))

/** A directory holding an executable `name`, as a PATH entry would. */
const binDir = (name: string): string => {
  const dir = scratch()
  const file = join(dir, name)
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
  return dir
}

/** A server that answers /health, which is all `probeServer` asks of one. */
const serveHealth = async (): Promise<{ url: string; close: () => Promise<void> }> => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"status":"ok"}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close()
      await once(server, 'close')
    },
  }
}

const WEIGHTS = { hfRepo: 'org/some-GGUF', hfFile: 'some-Q4_0.gguf', sizeBytes: 4_590_807_392 }

// --- finding the engine ----------------------------------------------------------------

test('the engine is found on PATH, and a non-executable file of the same name is not', () => {
  const dir = binDir(ENGINE)
  assert.equal(findOnPath(ENGINE, { PATH: dir }), join(dir, ENGINE))

  // A directory entry that is not executable is not the engine. Reporting it as installed
  // would trade "not on PATH" for a permission error from somewhere much further down.
  const inert = scratch()
  writeFileSync(join(inert, ENGINE), 'not executable')
  chmodSync(join(inert, ENGINE), 0o644)
  assert.equal(findOnPath(ENGINE, { PATH: inert }), undefined)
})

test('an empty or absent PATH finds nothing rather than throwing', () => {
  assert.equal(findOnPath(ENGINE, {}), undefined)
  assert.equal(findOnPath(ENGINE, { PATH: '' }), undefined)
})

// --- finding the weights ---------------------------------------------------------------

test('weights are matched by suffix, because llama.cpp decorates a cached download', () => {
  const cache = scratch()
  // The shape llama.cpp actually writes: the repo folded into the filename.
  writeFileSync(join(cache, `org_some-GGUF_${WEIGHTS.hfFile}`), '')
  assert.equal(findWeights(WEIGHTS, { env: { LLAMA_CACHE: cache } })?.path, join(cache, `org_some-GGUF_${WEIGHTS.hfFile}`))
})

test('an explicit LLAMA_MODEL outranks the cache, since it is what the launcher would pass', () => {
  const dir = scratch()
  const model = join(dir, 'elsewhere.gguf')
  writeFileSync(model, '')
  assert.equal(findWeights(WEIGHTS, { env: { LLAMA_MODEL: model } })?.path, model)
  // Named but absent is not a find: a stale env var must not read as weights on disk.
  assert.equal(findWeights(WEIGHTS, { env: { LLAMA_MODEL: join(dir, 'gone.gguf') } }), undefined)
})

test('a missing cache directory is a miss, not a crash', () => {
  assert.equal(findWeights(WEIGHTS, { env: { LLAMA_CACHE: join(scratch(), 'never-created') } }), undefined)
  // A pack that declares no model has nothing to miss.
  assert.equal(findWeights(undefined, { env: {} }), undefined)
})

test('LLAMA_CACHE is consulted ahead of the default location', () => {
  const dirs = cacheDirs({ LLAMA_CACHE: '/custom/cache' })
  assert.equal(dirs[0], '/custom/cache')
  assert.ok(dirs.some((d) => d.endsWith(join('.cache', 'llama.cpp'))))
})

// --- what refuses a run ----------------------------------------------------------------

test('a reachable server passes the check whatever the local machine is missing', async () => {
  const s = await serveHealth()
  // No engine on PATH and no weights anywhere: the run is pointed at a server that already
  // has both, which is exactly what --url is for.
  const r = await preflight({ url: s.url, declared: WEIGHTS, env: { PATH: scratch() }, engineCandidates: [] })
  assert.equal(r.serverUp, true)
  assert.equal(r.binary, undefined)
  assert.equal(r.weights, undefined)
  assert.equal(blocker(r), undefined, 'a run that can reach a server must never be refused')
  await s.close()
})

test('a missing engine and a dark port refuses, and names the engine', async () => {
  // Port 1 on loopback: nothing listens there, and it fails fast.
  const r = await preflight({ url: 'http://127.0.0.1:1', declared: WEIGHTS, env: { PATH: scratch() }, engineCandidates: [] })
  const why = blocker(r)
  assert.ok(why, 'no engine and no server is the one case that is certainly broken')
  assert.match(why, new RegExp(`${ENGINE} could not be found`))
  assert.match(why, /llama\.cpp/, 'it has to say what to install, not only what is missing')
})

test('an installed engine with a dark port refuses over the SERVER, not the install', async () => {
  const r = await preflight({ url: 'http://127.0.0.1:1', declared: WEIGHTS, env: { PATH: binDir(ENGINE) }, engineCandidates: [] })
  const why = blocker(r)
  assert.ok(why)
  assert.doesNotMatch(why, /could not be found/)
  assert.match(why, /not running/)
  // The command it prints must carry the port the run would have used and the declared repo,
  // or it is advice for a different machine.
  assert.match(why, /LLAMA_PORT=1\b/)
  assert.match(why, /LLAMA_HF=org\/some-GGUF/)
})

test('uncached weights change the advice but never refuse on their own', async () => {
  const s = await serveHealth()
  const r = await preflight({ url: s.url, declared: WEIGHTS, env: { PATH: binDir(ENGINE) }, engineCandidates: [] })
  assert.equal(r.weights, undefined)
  assert.equal(blocker(r), undefined, 'a weights miss is uncertain — -hf fetches on first use')
  await s.close()

  // With the server down it is mentioned, so a 4.6 GB download is expected rather than
  // mistaken for a hung start.
  const down = await preflight({ url: 'http://127.0.0.1:1', declared: WEIGHTS, env: { PATH: binDir(ENGINE) }, engineCandidates: [] })
  assert.match(blocker(down)!, /4\.6 GB/)
  assert.match(blocker(down)!, /download/)
})

test('the report states all three findings whether or not anything is wrong', async () => {
  const r = await preflight({ url: 'http://127.0.0.1:1', declared: WEIGHTS, env: { PATH: scratch() }, engineCandidates: [] })
  const lines = report(r)
  assert.equal(lines.length, 3)
  assert.match(lines[0]!, /NOT FOUND/)
  assert.match(lines[1]!, /not found/)
  assert.match(lines[2]!, /nothing listening/)
})

// --- the sources that were missing ------------------------------------------------------

test('the profile’s own model path in profiles.toml is consulted, and tilde-expanded', () => {
  // The hole this closes: profiles.toml declares `model = "~/models/...gguf"`, and a check
  // that read only the llama.cpp cache reported "not found, ~4.6 GB to download" on a machine
  // holding the exact bytes at the path its own configuration named.
  const dir = scratch()
  const model = join(dir, 'declared.gguf')
  writeFileSync(model, '')
  const found = findWeights({ ...WEIGHTS, sizeBytes: undefined }, { env: {}, modelPath: model })
  assert.equal(found?.path, model)
  assert.equal(found?.source, 'profiles.toml')

  // A `~` path is resolved the way the spawn resolves it, or the check disagrees with the run.
  const home = scratch()
  mkdirSync(join(home, 'models'))
  writeFileSync(join(home, 'models', 'tilde.gguf'), '')
  const viaTilde = findWeights(
    { ...WEIGHTS, sizeBytes: undefined },
    { env: { HOME: home }, modelPath: join(home, 'models', 'tilde.gguf') },
  )
  assert.equal(viaTilde?.source, 'profiles.toml')
})

test('a file of the wrong size is reported as a mismatch, not as absent', () => {
  const dir = scratch()
  const model = join(dir, 'partial.gguf')
  writeFileSync(model, 'nowhere near 4.6 GB')
  const found = findWeights(WEIGHTS, { env: {}, modelPath: model })
  assert.equal(found?.path, model, 'the path is right, so saying "absent" would hide the real fault')
  assert.ok(found?.sizeMismatch, 'a half-finished download has a specific fix')
  assert.equal(found.sizeMismatch.expected, WEIGHTS.sizeBytes)

  // At the declared size there is nothing to report.
  const exact = join(dir, 'exact.gguf')
  writeFileSync(exact, 'x'.repeat(64))
  assert.equal(findWeights({ ...WEIGHTS, sizeBytes: 64 }, { env: {}, modelPath: exact })?.sizeMismatch, undefined)
})

test('XDG_CACHE_HOME is honoured, because llama.cpp honours it', () => {
  const xdg = scratch()
  mkdirSync(join(xdg, 'llama.cpp'))
  writeFileSync(join(xdg, 'llama.cpp', `org_some-GGUF_${WEIGHTS.hfFile}`), '')
  const found = findWeights({ ...WEIGHTS, sizeBytes: undefined }, { env: { XDG_CACHE_HOME: xdg } })
  assert.equal(found?.source, 'llama.cpp cache')
  assert.ok(cacheDirs({ XDG_CACHE_HOME: '/moved' }).includes(join('/moved', 'llama.cpp')))
})

test('ALKOR_LLAMA_BIN names the engine when PATH does not, and PATH still wins when both work', () => {
  const offPath = join(binDir(ENGINE), ENGINE)
  const viaEnv = findEngine({ ALKOR_LLAMA_BIN: offPath, PATH: scratch() }, [])
  assert.equal(viaEnv?.path, offPath)
  assert.equal(viaEnv?.onPath, false, 'the launch script execs the bare name, so this is worth saying')

  const dir = binDir(ENGINE)
  assert.equal(findEngine({ PATH: dir }, [])?.onPath, true)
  assert.equal(findEngine({ PATH: scratch() }, [])?.path, undefined)
})

test('a build tree off PATH is found, and reported as off PATH', () => {
  const built = join(binDir(ENGINE), ENGINE)
  const found = findEngine({ PATH: scratch() }, [built])
  assert.equal(found?.path, built)
  assert.equal(found?.onPath, false)
  // The report has to say so: "installed" and "the documented commands work" differ here.
  assert.match(report({ url: 'http://x', serverUp: false, binary: built, binaryOnPath: false })[0]!, /NOT on PATH/)
})

test('weights already on disk are started with LLAMA_MODEL, never re-fetched with -hf', async () => {
  const dir = scratch()
  const model = join(dir, 'have-it.gguf')
  writeFileSync(model, '')
  const r = await preflight({
    url: 'http://127.0.0.1:1',
    declared: { ...WEIGHTS, sizeBytes: undefined },
    modelPath: model,
    env: { PATH: binDir(ENGINE) },
    engineCandidates: [],
  })
  const why = blocker(r)!
  assert.match(why, new RegExp(`LLAMA_MODEL=${model}`))
  assert.doesNotMatch(why, /LLAMA_HF/, 'a -hf command here would spend 4.6 GB to arrive where we already are')
  assert.doesNotMatch(why, /download/)
})

// --- what the engine itself can be asked ------------------------------------------------

test('a quantisation is read off the declared filename, since a repo publishes all of them', () => {
  assert.equal(declaredQuant('gemma-4-E4B-it-Q4_0.gguf'), 'Q4_0')
  assert.equal(declaredQuant('Qwen3-4B-Q4_K_M.gguf'), 'Q4_K_M')
  assert.equal(declaredQuant('model-IQ3_XXS.gguf'), 'IQ3_XXS')
  assert.equal(declaredQuant('model-BF16.gguf'), 'BF16')
  // No quant in the name is not a failure — the caller falls back to the repo alone.
  assert.equal(declaredQuant('plain.gguf'), undefined)
  assert.equal(declaredQuant(undefined), undefined)
})

test('the engine’s cache listing must match repo AND quant', () => {
  // A stub engine standing in for `llama-server --cache-list`: same contract, no 4 GB of weights.
  const dir = scratch()
  const fake = join(dir, ENGINE)
  writeFileSync(
    fake,
    '#!/bin/sh\necho "number of models in cache: 1"\necho "   1. org/some-GGUF:Q8_0"\n',
  )
  chmodSync(fake, 0o755)

  // Q8_0 is cached; the pack pins Q4_0. Matching the repo alone would call this a hit and
  // report weights that are not the pinned bytes.
  assert.equal(
    findWeights({ hfRepo: 'org/some-GGUF', hfFile: 'some-Q4_0.gguf' }, { env: {}, enginePath: fake }),
    undefined,
    'a different quantisation of the same repo is different weights',
  )
  const match = findWeights({ hfRepo: 'org/some-GGUF', hfFile: 'some-Q8_0.gguf' }, { env: {}, enginePath: fake })
  assert.equal(match?.source, 'llama.cpp -hf cache')
  assert.match(match!.path, /Q8_0/)
})

test('an engine that will not answer leaves us no worse off than not asking', () => {
  const dir = scratch()
  const broken = join(dir, ENGINE)
  writeFileSync(broken, '#!/bin/sh\nexit 1\n')
  chmodSync(broken, 0o755)
  assert.equal(findWeights({ hfRepo: 'org/x-GGUF', hfFile: 'x-Q4_0.gguf' }, { env: {}, enginePath: broken }), undefined)
  assert.deepEqual(findDevices(broken), [])
})

test('no offload device drops -ngl from the advice, because it would offload nothing', () => {
  const base = { url: 'http://127.0.0.1:8081', serverUp: false, declared: WEIGHTS }
  assert.doesNotMatch(startCommand({ ...base, devices: [] }), /-ngl/)
  assert.match(startCommand({ ...base, devices: ['CUDA0: NVIDIA'] }), /-ngl 99/)
  // Not asked is not the same as none: the flag stays rather than being quietly dropped.
  assert.match(startCommand(base), /-ngl 99/)
})

test('with no engine, managed mode sends you back to ./start, not to a manual server', async () => {
  const nothing = { url: 'http://127.0.0.1:8081', declared: WEIGHTS, env: { PATH: '' }, engineCandidates: [] }
  const r = await preflight(nothing)

  const managed = blocker(r, { managed: true })!
  assert.match(managed, /run \.\/start again/)
  assert.doesNotMatch(managed, /llama-server\.sh/, './start spawns backends — this would describe another program')
  assert.doesNotMatch(managed, /--url/, 'nothing was started; pointing elsewhere is not the next step')

  const manual = blocker(r)!
  assert.match(manual, /llama-server\.sh/, 'the CLI path really does need a server started by hand')

  // Both have to say how to GET llama.cpp: this is the one reader who has nothing, and a bare
  // repository link is not an instruction.
  for (const why of [managed, manual]) {
    assert.match(why, /brew install llama\.cpp/)
    assert.match(why, /github\.com\/ggml-org\/llama\.cpp/)
    assert.match(why, /ALKOR_LLAMA_BIN/)
  }
})
