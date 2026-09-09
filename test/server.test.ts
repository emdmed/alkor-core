/**
 * Server mode: HTTP endpoints for routing, running profiles, and managing sessions.
 *
 * Tests exercise the server without a real LLM server where possible. Rule-based routing
 * and session management are tested with no model. The session send endpoint is tested
 * against a stub HTTP server that mimics a llama-server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createMedextractServer } from '../src/server.ts'
import type { SpawnFn } from '../src/core/llama-manager.ts'

const startServer = async (configPath?: string): Promise<{ server: Server; url: string; close: () => Promise<void> }> => {
  const server = await createMedextractServer(configPath)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

const request = async (url: string, method: string, body?: unknown): Promise<{ status: number; data: unknown }> => {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

test('health endpoint returns profiles and session count', async () => {
  const { url, close } = await startServer()
  const { status, data } = await request(`${url}/health`, 'GET')
  assert.equal(status, 200)
  assert.ok(Array.isArray((data as any).profiles))
  assert.ok((data as any).profiles.includes('clinical'))
  assert.ok((data as any).profiles.includes('router'))
  assert.ok(Array.isArray((data as any).topology?.pipelines))
  const topologyProfiles = (data as any).topology?.profiles as any[]
  const router = topologyProfiles.find((profile) => profile.name === 'router')
  assert.equal(router.pinned, true)
  const routerTargets = router.topology.stages
    .flatMap((stage: any) => stage.routes ?? [])
    .map((route: any) => route.targetProfile)
  assert.deepEqual(routerTargets, ['clinical', 'transcriptor', 'verifier'])
  const clinical = topologyProfiles.find((profile) => profile.name === 'clinical')
  assert.ok(clinical.topology.stages[0].routes.some((route: any) => route.name === 'shock-extraction'))
  assert.equal(clinical.topology.stages[0].routes.find((route: any) => route.name === 'shock-extraction').feeds, 'shock')
  assert.equal(clinical.topology.stages[0].routes.find((route: any) => route.name === 'summary').available, false)
  const verified = (data as any).topology.pipelines.find((pipeline: any) => pipeline.name === 'clinical-verified')
  assert.deepEqual(verified.steps[1].input, [
    { name: 'document', ref: 'initial' },
    { name: 'extraction', ref: 'step-0.raw' },
  ])
  assert.equal(typeof (data as any).sessions, 'number')
  await close()
})

test('health reports each configured model backend and its reachability', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-health-test-'))

  // A loopback port that is guaranteed to refuse: bind an ephemeral listener, then let it
  // go. Nothing else can take the port before the probe (loopback, immediate).
  const dead = createServer(() => {})
  dead.listen(0, '127.0.0.1')
  await once(dead, 'listening')
  const { port: deadPort } = dead.address() as { port: number }
  await new Promise<void>((resolve) => dead.close(() => resolve()))

  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(tomlPath, `[dead]\nmode = "extract"\nurl = "http://127.0.0.1:${deadPort}"\n`)

  const { url, close } = await startServer(tomlPath)
  try {
    const { status, data } = await request(`${url}/health`, 'GET')
    assert.equal(status, 200)
    const models = (data as any).models as Array<{
      baseUrl: string
      reachable: boolean
      managed?: boolean
      state?: string
    }>
    assert.ok(Array.isArray(models))
    // The profile's own backend plus the process-wide fallback are both listed.
    const entry = models.find((m) => m.baseUrl === `http://127.0.0.1:${deadPort}`)
    assert.ok(entry, `health models must include the dead backend (got ${models.map((m) => m.baseUrl).join(', ')})`)
    assert.equal(entry.reachable, false)
    // No `model` in the toml, so this backend is unmanaged: DOWN means "you start it",
    // never "spawn on demand". The dashboard's MODEL OFFLINE badge keys off this.
    assert.equal(entry.managed, false)
    assert.equal(entry.state, 'stopped')
  } finally {
    await close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run with every backend down refuses with 503, not a silent failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-503-test-'))

  const dead = createServer(() => {})
  dead.listen(0, '127.0.0.1')
  await once(dead, 'listening')
  const { port: deadPort } = dead.address() as { port: number }
  await new Promise<void>((resolve) => dead.close(() => resolve()))

  const modulePath = join(dir, 'extract-down.mjs')
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[extract-down]\nmode = "extract"\nmodule = "${modulePath}"\nurl = "http://127.0.0.1:${deadPort}"\n`,
  )
  writeFileSync(
    modulePath,
    "export const PROFILE = { name: 'extract-down', mode: 'extract', needsPack: false, async runEval() { return { pass: true, summary: 'test' } } }\n",
  )

  const { url, close } = await startServer(tomlPath)
  try {
    const { status, data } = await request(`${url}/run`, 'POST', { profile: 'extract-down', input: 'hi' })
    assert.equal(status, 503)
    assert.ok(String((data as any).error).includes('llama-server'))
  } finally {
    await close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session keeps its prompt in memory while its llama-server starts on demand', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-session-start-test-'))

  // Reserve and release a port so the first readiness probe sees a genuinely dark backend.
  const reservation = createServer(() => {})
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const { port } = reservation.address() as { port: number }
  await new Promise<void>((resolve) => reservation.close(() => resolve()))

  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[coding]\nmode = "agentic"\nurl = "http://127.0.0.1:${port}"\nmodel = "/models/fake.gguf"\n`,
  )

  const prompts: string[] = []
  let starts = 0
  let backend: Server | undefined
  let announceSpawn!: () => void
  const spawned = new Promise<void>((resolve) => (announceSpawn = resolve))
  const spawn: SpawnFn = (_binary, args) => {
    starts++
    let stopped = false
    let exitResolve!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => (exitResolve = resolve),
    )
    const timer = setTimeout(() => {
      if (stopped) return
      backend = createServer(async (req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"status":"ok"}')
          return
        }
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"data":[{"id":"fake-model"}]}')
          return
        }
        if (req.url === '/props') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{}')
          return
        }
        if (req.url === '/v1/chat/completions') {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          prompts.push(body.messages.at(-1)?.content)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              choices: [{ message: { content: 'ready answer', tool_calls: [] } }],
              usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
            }),
          )
          return
        }
        res.writeHead(404)
        res.end()
      })
      backend.listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1')
    }, 40)
    announceSpawn()
    return {
      pid: 1234,
      exit,
      kill: (signal) => {
        stopped = true
        clearTimeout(timer)
        backend?.close()
        exitResolve({ code: null, signal: signal ?? 'SIGTERM' })
        return true
      },
      stdout: () => '',
      stderr: () => '',
    }
  }

  const medextract = await createMedextractServer(tomlPath, {
    llamaManager: { spawn, pollMs: 5, startTimeoutMs: 2000 },
  })
  medextract.listen(0, '127.0.0.1')
  await once(medextract, 'listening')
  const url = `http://127.0.0.1:${(medextract.address() as { port: number }).port}`

  try {
    const created = await request(`${url}/session`, 'POST', { profile: 'coding', stream: false })
    assert.equal(created.status, 200)
    assert.equal(starts, 0, 'creating an empty session does not wake the model')

    const pending = request(`${url}/session/${(created.data as any).id}/send`, 'POST', {
      text: 'held until ready',
    })
    await spawned
    assert.equal(prompts.length, 0, 'the prompt is not dispatched while the backend is loading')

    const sent = await pending
    assert.equal(sent.status, 200)
    assert.equal((sent.data as any).answer, 'ready answer')
    assert.deepEqual(prompts, ['held until ready'])
    assert.equal(starts, 1)
  } finally {
    medextract.closeAllConnections()
    medextract.close()
    await once(medextract, 'close')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loopback browser origins may read the feed over CORS', async () => {
  const { url, close } = await startServer()
  const res = await fetch(`${url}/health`, {
    headers: { Origin: 'http://localhost:5173' },
  })
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  await res.json()
  await close()
})

test('foreign origins are refused CORS by default', async () => {
  const { url, close } = await startServer()
  const res = await fetch(`${url}/health`, {
    headers: { Origin: 'https://not-your-server.example' },
  })
  assert.equal(res.headers.get('access-control-allow-origin'), null)
  await res.json()
  await close()
})

test('OPTIONS preflight for a loopback origin is answered', async () => {
  const { url, close } = await startServer()
  const res = await fetch(`${url}/run`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://127.0.0.1:5173' },
  })
  assert.equal(res.status, 204)
  assert.ok((res.headers.get('access-control-allow-methods') ?? '').includes('POST'))
  await close()
})

test('route endpoint classifies input with rules', async () => {
  const { url, close } = await startServer()
  const { status, data } = await request(`${url}/route`, 'POST', {
    input: 'Patient BP 120/80, HR 72',
    rules: [
      { name: 'vitals', profile: 'clinical', keywords: ['bp', 'blood pressure'], confidence: 0.9 },
    ],
    defaultProfile: 'unknown',
  })
  assert.equal(status, 200)
  assert.equal((data as any).profile, 'clinical')
  assert.equal((data as any).confidence, 0.9)
  assert.ok((data as any).reason.includes('vitals'))
  await close()
})

test('route endpoint falls back to default', async () => {
  const { url, close } = await startServer()
  const { status, data } = await request(`${url}/route`, 'POST', {
    input: 'Hello world',
    rules: [
      { name: 'vitals', profile: 'clinical', keywords: ['bp'], confidence: 0.9 },
    ],
    defaultProfile: 'general',
  })
  assert.equal(status, 200)
  assert.equal((data as any).profile, 'general')
  assert.equal((data as any).confidence, 0)
  assert.ok((data as any).reason.includes('default'))
  await close()
})

test('route without explicit rules or a model 503s when the pinned gateway is unreachable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-gateway-test-'))

  const dead = createServer(() => {})
  dead.listen(0, '127.0.0.1')
  await once(dead, 'listening')
  const { port: deadPort } = dead.address() as { port: number }
  await new Promise<void>((resolve) => dead.close(() => resolve()))

  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(tomlPath, `[router]\nmode = "router"\npinned = true\nurl = "http://127.0.0.1:${deadPort}"\n`)

  const { url, close } = await startServer(tomlPath)
  try {
    const { status, data } = await request(`${url}/route`, 'POST', {
      input: 'a free-form prompt the rules cannot see',
    })
    assert.equal(status, 503)
    assert.ok(String((data as any).error).includes('no model backend is reachable'))
  } finally {
    await close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('route without explicit rules routes through the pinned gateway model', async () => {
  // A stub front-door: answers /health so the gateway is reachable, and classifies any
  // chat request the rules miss as clinical.
  const stub = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ profile: 'clinical', confidence: 0.8, reason: 'stub' }),
              },
            },
          ],
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  stub.listen(0, '127.0.0.1')
  await once(stub, 'listening')
  const { port: stubPort } = stub.address() as { port: number }

  const dir = mkdtempSync(join(tmpdir(), 'medextract-gateway-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[router]
mode = "router"
pinned = true
url = "http://127.0.0.1:${stubPort}"
model = "~/models/q.gguf"
`,
  )

  const { url, close } = await startServer(tomlPath)
  try {
    const { status, data } = await request(`${url}/route`, 'POST', {
      input: 'what should I do with this?',
    })
    assert.equal(status, 200)
    // The stub is only reached because the gateway's own rules did not match the input.
    assert.equal((data as any).profile, 'clinical')
    assert.equal((data as any).confidence, 0.8)
    assert.ok(String((data as any).reason).startsWith('model:'))
  } finally {
    await close()
    stub.closeAllConnections()
    stub.close()
    await once(stub, 'close')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('route endpoint requires input', async () => {
  const { url, close } = await startServer()
  const { status, data } = await request(`${url}/route`, 'POST', {})
  assert.equal(status, 400)
  assert.ok((data as any).error.includes('input is required'))
  await close()
})

test('run endpoint with router profile uses compiled rules', async () => {
  const { url, close } = await startServer()
  const { status, data } = await request(`${url}/run`, 'POST', {
    profile: 'router',
    input: 'Patient BP 120/80, HR 72',
  })
  assert.equal(status, 200)
  assert.equal((data as any).ok, true)
  assert.ok((data as any).text.includes('clinical'))
  assert.deepEqual((data as any).output, (data as any).report)
  await close()
})

test('run endpoint refuses unknown profile', async () => {
  const { url, close } = await startServer()
  const { status, data } = await request(`${url}/run`, 'POST', {
    profile: 'nonexistent',
    input: 'hello',
  })
  assert.equal(status, 400)
  assert.ok((data as any).error.includes('unknown profile'))
  await close()
})

test('run endpoint requires input', async () => {
  const { url, close } = await startServer()
  const { status, data } = await request(`${url}/run`, 'POST', {
    profile: 'router',
  })
  assert.equal(status, 400)
  assert.ok((data as any).error.includes('input is required'))
  await close()
})

test('session create, reset, load, and delete', async () => {
  const { url, close } = await startServer()

  // Create
  const { status: createStatus, data: createData } = await request(`${url}/session`, 'POST', {
    profile: 'coding',
    workspace: '/tmp',
  })
  assert.equal(createStatus, 200)
  const id = (createData as any).id
  assert.ok(typeof id === 'string')
  assert.equal((createData as any).profile, 'coding')

  // Reset
  const { status: resetStatus, data: resetData } = await request(`${url}/session/${id}/reset`, 'POST', {})
  assert.equal(resetStatus, 200)
  assert.equal((resetData as any).ok, true)

  // Load
  const { status: loadStatus, data: loadData } = await request(`${url}/session/${id}/load`, 'POST', {
    messages: [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ],
  })
  assert.equal(loadStatus, 200)
  assert.equal((loadData as any).ok, true)

  // Delete
  const { status: delStatus, data: delData } = await request(`${url}/session/${id}`, 'DELETE')
  assert.equal(delStatus, 200)
  assert.equal((delData as any).ok, true)

  // Verify deleted
  const { status: del2Status } = await request(`${url}/session/${id}/reset`, 'POST', {})
  assert.equal(del2Status, 404)

  await close()
})

test('session send to nonexistent session', async () => {
  const { url, close } = await startServer()
  const { status, data } = await request(`${url}/session/nonexistent-uuid/send`, 'POST', {
    text: 'hello',
  })
  assert.equal(status, 404)
  assert.ok((data as any).error.includes('not found'))
  await close()
})

test('session send with stub llama-server', async () => {
  // Start a stub llama-server that returns prose for any chat request.
  const stub = createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Hello from stub',
                tool_calls: [],
              },
            },
          ],
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  stub.listen(0, '127.0.0.1')
  await once(stub, 'listening')
  const { port: stubPort } = stub.address() as { port: number }

  // Create a temp profiles.toml that points the coding profile at the stub.
  const dir = mkdtempSync(join(tmpdir(), 'medextract-server-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[coding]
mode = "agentic"
url = "http://127.0.0.1:${stubPort}"
`,
  )

  const { url, close } = await startServer(tomlPath)

  // Create session with stream: false so the server uses toolChat instead of streamChat.
  const { status, data } = await request(`${url}/session`, 'POST', {
    profile: 'coding',
    workspace: '/tmp',
    stream: false,
  })
  assert.equal(status, 200)
  const id = (data as any).id

  // Send a message
  const { status: sendStatus, data: sendData } = await request(`${url}/session/${id}/send`, 'POST', {
    text: 'hello',
  })
  assert.equal(sendStatus, 200)
  assert.equal((sendData as any).stop, 'answered')
  assert.equal((sendData as any).answer, 'Hello from stub')
  assert.equal((sendData as any).steps, 1)

  await close()
  stub.closeAllConnections()
  stub.close()
  await once(stub, 'close')
  rmSync(dir, { recursive: true, force: true })
})

test('session send with streaming stub returns answer, not aborted', async () => {
  const stub = createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":" from"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":" stub"},"finish_reason":"stop"}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  stub.listen(0, '127.0.0.1')
  await once(stub, 'listening')
  const { port: stubPort } = stub.address() as { port: number }

  const dir = mkdtempSync(join(tmpdir(), 'medextract-server-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[coding]
mode = "agentic"
url = "http://127.0.0.1:${stubPort}"
`,
  )

  const { url, close } = await startServer(tomlPath)

  const { status, data } = await request(`${url}/session`, 'POST', {
    profile: 'coding',
    workspace: '/tmp',
    stream: true,
  })
  assert.equal(status, 200)
  const id = (data as any).id

  const { status: sendStatus, data: sendData } = await request(`${url}/session/${id}/send`, 'POST', {
    text: 'hello',
  })
  assert.equal(sendStatus, 200)
  assert.equal((sendData as any).stop, 'answered')
  assert.equal((sendData as any).answer, 'Hello from stub')

  await close()
  stub.closeAllConnections()
  stub.close()
  await once(stub, 'close')
  rmSync(dir, { recursive: true, force: true })
})

test('session send with tool-calling stub returns tool result, not aborted', async () => {
  const stub = createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'done', arguments: '{"answer":"Task done"}' },
                  },
                ],
              },
            },
          ],
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  stub.listen(0, '127.0.0.1')
  await once(stub, 'listening')
  const { port: stubPort } = stub.address() as { port: number }

  const dir = mkdtempSync(join(tmpdir(), 'medextract-server-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[coding]
mode = "agentic"
url = "http://127.0.0.1:${stubPort}"
`,
  )

  const { url, close } = await startServer(tomlPath)

  const { status, data } = await request(`${url}/session`, 'POST', {
    profile: 'coding',
    workspace: '/tmp',
    stream: false,
  })
  assert.equal(status, 200)
  const id = (data as any).id

  const { status: sendStatus, data: sendData } = await request(`${url}/session/${id}/send`, 'POST', {
    text: 'hello',
  })
  assert.equal(sendStatus, 200)
  assert.equal((sendData as any).stop, 'done')
  assert.equal((sendData as any).answer, 'Task done')

  await close()
  stub.closeAllConnections()
  stub.close()
  await once(stub, 'close')
  rmSync(dir, { recursive: true, force: true })
})
