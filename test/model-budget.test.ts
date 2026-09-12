/**
 * The resident-model budget: what keeps a multi-model deployment inside the memory of the
 * laptop it is running on.
 *
 * Three behaviours are covered here because each one is a way the machine dies without it:
 * a second model admitted beside a first that already fills the budget, two models loading
 * their weights at the same moment (the peak is the sum), and a workflow that brings up
 * every step's model before step 0 and holds them for the run. The spawn seam is faked, as
 * everywhere else in this suite — a real llama-server is not part of `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlamaManager, type SpawnFn, type SpawnResult } from '../src/core/llama-manager.ts'
import { modelBudgetBytes, footprintBytesFor } from '../src/server.ts'
import { runWorkflow } from '../src/modes/workflow.ts'
import type { ProfileModule, ReviewResult } from '../src/core/profile.ts'
import type { EvalVerdict } from '../src/core/profile.ts'

const GiB = 1024 ** 3

/** A spawn whose backends answer immediately, tracking which ports are up. */
const makeInstant = () => {
  const up = new Set<string>()
  const spawn: SpawnFn = (_binary, args) => {
    const port = String(args[args.indexOf('--port') + 1])
    up.add(port)
    let exited: (r: { code: number | null; signal: NodeJS.Signals | null }) => void
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
      exited = r
    })
    const result: SpawnResult = {
      pid: Number(port),
      exit,
      // A child that dies when asked, so a stop costs a tick rather than the SIGKILL grace.
      kill: (signal) => {
        up.delete(port)
        exited({ code: null, signal: signal ?? 'SIGTERM' })
        return true
      },
      stdout: () => '',
      stderr: () => '',
    }
    return result
  }
  const probe = async (url?: string) => up.has(new URL(url ?? 'http://127.0.0.1:1').port)
  return { spawn, probe, up }
}

test('a model that does not fit evicts the least recently used idle backend', async () => {
  const { spawn, probe } = makeInstant()
  const stops: Array<{ url: string; reason?: string }> = []
  const m = new LlamaManager({
    idleMs: 10_000,
    budgetBytes: 10 * GiB,
    spawnArgs: [],
    pollMs: 5,
    startTimeoutMs: 2000,
    spawn,
    probe,
    emit: (e) => {
      if (e.state === 'stopped') stops.push({ url: e.baseUrl, reason: e.reason })
    },
  })
  const a = 'http://127.0.0.1:18140'
  const b = 'http://127.0.0.1:18141'
  const c = 'http://127.0.0.1:18142'
  for (const [url, name] of [[a, 'a'], [b, 'b'], [c, 'c']] as const) {
    m.register({ baseUrl: url, model: `/models/${name}.gguf`, footprintBytes: 4 * GiB })
  }

  assert.equal(await m.ensure(a), true)
  assert.equal(await m.ensure(b), true)
  assert.equal(m.resources().residentBytes, 8 * GiB, 'both fit under the budget')

  // `b` has sat unused since; `a` is the one still being worked with. Set rather than
  // slept for: both starts land in the same millisecond, and a tie is not what is tested.
  ;(m as any).entries.get(b).lastUsed = Date.now() - 60_000
  m.touch(a)
  assert.equal(await m.ensure(c), true)

  assert.equal(m.status(b).state, 'stopped', 'the least recently used backend made the room')
  assert.equal(m.status(a).state, 'running')
  assert.equal(m.status(c).state, 'running')
  assert.deepEqual(stops, [{ url: b, reason: 'evicted' }])
  assert.equal(m.resources().residentBytes, 8 * GiB)
})

test('a pinned backend is not evicted, and a start that cannot fit says why', async () => {
  const { spawn, probe } = makeInstant()
  const m = new LlamaManager({
    idleMs: 10_000,
    budgetBytes: 10 * GiB,
    spawnArgs: [],
    pollMs: 5,
    // Short, because this start is expected to wait for room that never comes.
    startTimeoutMs: 60,
    spawn,
    probe,
  })
  const front = 'http://127.0.0.1:18143'
  const other = 'http://127.0.0.1:18144'
  m.register({ baseUrl: front, model: '/models/front.gguf', footprintBytes: 8 * GiB, pinned: true })
  m.register({ baseUrl: other, model: '/models/other.gguf', footprintBytes: 8 * GiB })

  assert.equal(await m.ensure(front), true)
  assert.equal(await m.ensure(other), false, 'nothing evictable, so the start is refused')
  assert.equal(m.status(front).state, 'running', 'the front door survives')
  assert.match(m.describe(other), /model budget/)
  assert.match(m.describe(other), /pinned or mid-request/)
})

test('a backend serving a request is waited for, not evicted out from under it', async () => {
  const { spawn, probe } = makeInstant()
  const m = new LlamaManager({
    idleMs: 10_000,
    budgetBytes: 10 * GiB,
    spawnArgs: [],
    pollMs: 5,
    startTimeoutMs: 1000,
    spawn,
    probe,
  })
  const busy = 'http://127.0.0.1:18145'
  const next = 'http://127.0.0.1:18146'
  m.register({ baseUrl: busy, model: '/models/busy.gguf', footprintBytes: 8 * GiB })
  m.register({ baseUrl: next, model: '/models/next.gguf', footprintBytes: 8 * GiB })

  assert.equal(await m.ensure(busy), true)
  const call = m.track(busy)
  call.acquire()

  // The admission waits out the generation rather than aborting it, and takes the room the
  // moment the call ends — which is what lets step 2 of a workflow follow a long step 1.
  const started = m.ensure(next)
  setTimeout(() => call.release(), 30)
  assert.equal(await started, true)
  assert.equal(m.status(busy).state, 'stopped', 'evicted only once it was no longer answering')
  assert.equal(m.status(next).state, 'running')
})

test('a model larger than the whole budget still runs when nothing else is resident', async () => {
  const { spawn, probe } = makeInstant()
  const m = new LlamaManager({
    idleMs: 10_000,
    budgetBytes: 2 * GiB,
    spawnArgs: [],
    pollMs: 5,
    startTimeoutMs: 500,
    spawn,
    probe,
  })
  const only = 'http://127.0.0.1:18147'
  m.register({ baseUrl: only, model: '/models/big.gguf', footprintBytes: 6 * GiB })

  // One model at a time is what a small machine can do; refusing would leave it unable to
  // do even that.
  assert.equal(await m.ensure(only), true)
  assert.equal(m.status(only).state, 'running')
})

test('two backends do not load their weights at the same time', async () => {
  const up = new Set<string>()
  let loading = 0
  let peakLoading = 0
  const spawn: SpawnFn = (_binary, args) => {
    const port = String(args[args.indexOf('--port') + 1])
    loading++
    peakLoading = Math.max(peakLoading, loading)
    // Weights take a moment to read; the port answers only once they have.
    setTimeout(() => {
      loading--
      up.add(port)
    }, 40)
    return {
      pid: Number(port),
      exit: new Promise(() => {}),
      kill: () => {
        up.delete(port)
        return true
      },
      stdout: () => '',
      stderr: () => '',
    }
  }
  const m = new LlamaManager({
    idleMs: 10_000,
    spawnArgs: [],
    pollMs: 5,
    startTimeoutMs: 2000,
    spawn,
    probe: async (url?: string) => up.has(new URL(url ?? 'http://127.0.0.1:1').port),
  })
  const one = 'http://127.0.0.1:18148'
  const two = 'http://127.0.0.1:18149'
  m.register({ baseUrl: one, model: '/models/one.gguf' })
  m.register({ baseUrl: two, model: '/models/two.gguf' })

  const [a, b] = await Promise.all([m.ensure(one), m.ensure(two)])
  assert.equal(a, true)
  assert.equal(b, true)
  assert.equal(peakLoading, 1, 'the second start waited for the first to finish loading')
})

test('the budget reads sizes, percentages, and the unbounded escape hatch', () => {
  assert.equal(modelBudgetBytes('6GiB', 0), 6 * GiB)
  assert.equal(modelBudgetBytes('512MiB', 0), 512 * 1024 ** 2)
  assert.equal(modelBudgetBytes('50%', 1000), 500)
  assert.equal(modelBudgetBytes('0', 1000), 0, 'zero is unbounded, not a refusal to start anything')
  assert.equal(modelBudgetBytes(undefined, 1000), 600, 'the default leaves the rest of the machine its share')
  assert.equal(modelBudgetBytes('what?', 1000), 600, 'an unreadable setting falls back rather than refusing to boot')
})

test('a footprint counts the weights and the context window it will serve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alkor-footprint-'))
  try {
    const model = join(dir, 'tiny.gguf')
    writeFileSync(model, Buffer.alloc(1024))

    const small = footprintBytesFor(model, 4096)!
    const large = footprintBytesFor(model, 32768)!
    assert.ok(small > 1024, 'the KV cache is part of what a backend costs')
    assert.ok(large > small, 'a longer context costs more than a shorter one on the same weights')

    // A profile that has measured its own hardware is believed over the estimate.
    assert.equal(footprintBytesFor(model, 32768, '6GiB'), 6 * GiB)
    // And a model that is not on this machine is unknown, not free.
    assert.equal(footprintBytesFor(join(dir, 'absent.gguf'), 4096), undefined)
    assert.equal(footprintBytesFor(undefined, 4096), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const mockProfile = (name: string, mode: ProfileModule['mode']): ProfileModule => ({
  name,
  mode,
  needsPack: false,
  async review(): Promise<ReviewResult> {
    return { text: `ran ${name}`, ok: true, raw: '{}', report: { name } }
  },
  async runEval(): Promise<EvalVerdict> {
    return { pass: true, summary: 'mock' }
  },
})

test('a workflow loads each step model at its step, and never a deterministic step', async () => {
  const asked: Array<string | undefined> = []
  const result = await runWorkflow({
    initialInput: 'note',
    steps: [
      { name: 'extract', profile: 'extractor', input: 'initial' },
      { name: 'check', profile: 'checker', input: 'step-0.output' },
      { name: 'verify', profile: 'verifier', input: 'step-1.output' },
    ],
    profiles: new Map([
      ['extractor', mockProfile('extractor', 'extract')],
      ['checker', mockProfile('checker', 'code')],
      ['verifier', mockProfile('verifier', 'extract')],
    ]),
    packs: new Map([['extractor', undefined], ['checker', undefined], ['verifier', undefined]]),
    baseUrls: new Map([
      ['extractor', 'http://127.0.0.1:18150'],
      ['checker', 'http://127.0.0.1:18151'],
      ['verifier', 'http://127.0.0.1:18152'],
    ]),
    ensureBackend: async (baseUrl) => {
      asked.push(baseUrl)
      return null
    },
  })

  assert.equal(result.stoppedEarly, false)
  assert.deepEqual(
    asked,
    ['http://127.0.0.1:18150', 'http://127.0.0.1:18152'],
    'one backend per model step, in step order, and none for the code step',
  )
})

test('a step whose model cannot be made usable fails that step, not the request', async () => {
  const result = await runWorkflow({
    initialInput: 'note',
    steps: [
      { name: 'extract', profile: 'extractor', input: 'initial' },
      { name: 'verify', profile: 'verifier', input: 'step-0.output' },
    ],
    profiles: new Map([
      ['extractor', mockProfile('extractor', 'extract')],
      ['verifier', mockProfile('verifier', 'extract')],
    ]),
    packs: new Map([['extractor', undefined], ['verifier', undefined]]),
    baseUrls: new Map([
      ['extractor', 'http://127.0.0.1:18153'],
      ['verifier', 'http://127.0.0.1:18154'],
    ]),
    ensureBackend: async (baseUrl) =>
      baseUrl?.endsWith('18154') ? 'no model backend is reachable at 18154 — over the model budget' : null,
  })

  assert.equal(result.stoppedEarly, true)
  assert.equal(result.steps[0]!.ok, true)
  assert.equal(result.steps[1]!.ok, false)
  assert.match(String(result.steps[1]!.error), /model budget/)
})
