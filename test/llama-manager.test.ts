/**
 * Managed llama-server lifecycle: spawn on demand, idle-stop to free memory, and never
 * stop a backend that is mid-request. The spawn seam is faked here — a real llama-server
 * is not part of `npm test`, by rule. The fake spawn behaves enough like the real child to
 * exercise readiness polling, exit detection, and kill semantics on Node without a GPU.
 *
 * Spawn flags are covered structurally rather than by exact value: the model path goes
 * through `os.homedir()` expansion on this machine, which is not portable to assert. The
 * port, ctx, and default args are what the manager derives from the spec and the host.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { LlamaManager, withTouching, type SpawnResult, type SpawnFn } from '../src/core/llama-manager.ts'
import type { Provider } from '../src/core/client.ts'

interface Fake {
  args: string[][]
  stopAll(): void
}

const makeWorld = () => {
  const fake: Fake = { args: [], stopAll: () => {} }
  const httpServers: Server[] = []
  let counter = 0

  const spawn: SpawnFn = (binary, args) => {
    const port = Number(args[args.indexOf('--port') + 1] ?? '8080')
    const http = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    httpServers.push(http)
    http.listen(port, '127.0.0.1')
    const pid = ++counter
    fake.args.push([...args])

    let exitResolve: (r: { code: number | null; signal: NodeJS.Signals | null }) => void
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
      exitResolve = r
    })
    const result: SpawnResult = {
      pid,
      exit,
      kill: (signal) => {
        http.close()
        exitResolve({ code: null, signal: signal ?? 'SIGTERM' })
        return true
      },
      stdout: () => '',
      stderr: () => '',
    }
    if (!http.listening) {
      // The host told us the port won't answer; this variant never comes up.
    }
    return result
  }

  fake.stopAll = () => {
    for (const h of httpServers) {
      try {
        h.close()
      } catch {
        // already closed
      }
    }
  }
  return { fake, spawn }
}

/** A spawn that behaves like a child that never binds its port (crash/port taken): probes
 * refuse, so the manager must give up on its own deadline. No listener is kept, so the run
 * cannot be held open by the fork after the failure. */
const silentSpawn: SpawnFn = (binary, args) => {
  let exitResolve: (r: { code: number | null; signal: NodeJS.Signals | null }) => void
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    exitResolve = r
  })
  return {
    pid: 1,
    exit,
    kill: (signal) => {
      exitResolve({ code: null, signal: signal ?? 'SIGTERM' })
      return true
    },
    stdout: () => '',
    stderr: () => 'llama-server: could not bind port',
  }
}

test('spawns on ensure when down, reports ready, and stops idle on sweep', async () => {
  const { fake, spawn } = makeWorld()
  const events: string[] = []
  const m = new LlamaManager({
    idleMs: 10_000,
    spawnArgs: ['--no-webui', '--parallel', '1'],
    pollMs: 20,
    startTimeoutMs: 2000,
    spawn,
    emit: (e) => events.push(`${e.state}`),
  })
  m.register({ baseUrl: 'http://127.0.0.1:18081', model: '~/models/q.gguf', ctx: 4096 })

  const ok = await m.ensure('http://127.0.0.1:18081')
  assert.equal(ok, true)
  const args = fake.args[0] ?? []
  assert.ok(args[0] === '--model' && (args[1] ?? '').endsWith('q.gguf'), `model arg points at the model file (got ${args.join(' ')})`)
  assert.deepEqual(args.slice(2), ['--port', '18081', '--jinja', '--ctx-size', '4096', '--no-webui', '--parallel', '1'])
  assert.ok(events.includes('starting') && events.includes('ready'))
  assert.equal(m.status('http://127.0.0.1:18081').state, 'running')

  await m.sweep()
  assert.equal(m.status('http://127.0.0.1:18081').state, 'running', 'not yet idle -> no stop')

  ;(m as any).entries.get('http://127.0.0.1:18081').lastUsed = Date.now() - 60_000
  await m.sweep()
  assert.equal(m.status('http://127.0.0.1:18081').state, 'stopped')
  assert.ok(events.includes('stopped'))
  fake.stopAll()
})

test('a backend that cannot come up fails fast and reports the reason', async () => {
  const m = new LlamaManager({
    idleMs: 10_000,
    spawnArgs: [],
    pollMs: 10,
    startTimeoutMs: 80,
    spawn: silentSpawn,
  })
  m.register({ baseUrl: 'http://127.0.0.1:18090', model: '~/models/q.gguf' })
  const ok = await m.ensure('http://127.0.0.1:18090')
  assert.equal(ok, false)
  assert.equal(m.status('http://127.0.0.1:18090').state, 'failed')
})

test('a backend with no model is never spawned — the host starts it itself', async () => {
  const { fake, spawn } = makeWorld()
  const m = new LlamaManager({ idleMs: 10_000, spawnArgs: [], pollMs: 5, spawn })
  m.register({ baseUrl: 'http://127.0.0.1:18095' })
  const ok = await m.ensure('http://127.0.0.1:18095')
  assert.equal(ok, false)
  assert.deepEqual(fake.args, [])
  fake.stopAll()
})

test('a pinned backend is exempt from the idle sweep', async () => {
  const { fake, spawn } = makeWorld()
  const m = new LlamaManager({ idleMs: 10_000, spawnArgs: [], pollMs: 10, startTimeoutMs: 2000, spawn })
  m.register({ baseUrl: 'http://127.0.0.1:18112', model: '~/models/q.gguf', pinned: true })
  m.register({ baseUrl: 'http://127.0.0.1:18113', model: '~/models/q.gguf' })

  assert.equal(await m.ensure('http://127.0.0.1:18112'), true)
  assert.equal(await m.ensure('http://127.0.0.1:18113'), true)
  assert.equal(m.status('http://127.0.0.1:18112').pinned, true)
  assert.equal(m.status('http://127.0.0.1:18113').pinned, false)

  for (const url of ['http://127.0.0.1:18112', 'http://127.0.0.1:18113']) {
    ;(m as any).entries.get(url).lastUsed = Date.now() - 60_000
  }
  await m.sweep()
  assert.equal(m.status('http://127.0.0.1:18112').state, 'running', 'pinned backend survives the sweep')
  assert.equal(m.status('http://127.0.0.1:18113').state, 'stopped', 'an ordinary backend is swept when idle')
  fake.stopAll()
})

test('a workflow reservation keeps a later backend alive between long pipeline steps', async () => {
  const { fake, spawn } = makeWorld()
  const url = 'http://127.0.0.1:18114'
  const m = new LlamaManager({ idleMs: 10_000, spawnArgs: [], pollMs: 10, startTimeoutMs: 2000, spawn })
  m.register({ baseUrl: url, model: '~/models/verifier.gguf' })

  assert.equal(await m.ensure(url), true)
  const reservation = m.track(url)
  reservation.acquire()
  ;(m as any).entries.get(url).lastUsed = Date.now() - 60_000

  await m.sweep()
  assert.equal(m.status(url).state, 'running', 'reserved future step survives the idle sweep')

  reservation.release()
  ;(m as any).entries.get(url).lastUsed = Date.now() - 60_000
  await m.sweep()
  assert.equal(m.status(url).state, 'stopped', 'backend becomes sweepable after the workflow')
  fake.stopAll()
})

test('withTouching bumps in-flight around a call so a long generation is not swept', async () => {
  let released = false
  const gate = new Promise<void>((r) => setTimeout(r, 20))
  const fakeProvider: Provider = {
    chat: async (_o) => {
      await gate
      return 'hi'
    },
    toolChat: async (_o) => null as any,
    streamChat: async (_o) => null as any,
    identify: async (_o) => ({ model: 'm', identified: true }) as any,
  }
  let inFlight = 0
  const track = (_url: string) => ({
    acquire: () => {
      inFlight++
    },
    release: () => {
      inFlight--
      released = true
    },
  })
  const wrapped = withTouching(fakeProvider, track, 'http://127.0.0.1:18081')
  const p = wrapped.chat({ systemPrompt: 's', userPrompt: 'u', label: 'test' })
  assert.equal(inFlight, 1, 'call in flight while awaiting')
  await p
  assert.equal(inFlight, 0)
  assert.equal(released, true)
})
