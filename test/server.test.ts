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
import { createServer as createAlkorServer } from '../src/server.ts'
import type { SpawnFn } from '../src/core/llama-manager.ts'

/** A profile in agentic mode for the session tests; this project ships no built-in one. */
const AGENT_PROFILE = join(import.meta.dirname, 'fixtures', 'agent-profile.mjs')

const startServer = async (configPath?: string): Promise<{ server: Server; url: string; close: () => Promise<void> }> => {
  const server = await createAlkorServer(configPath)
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
  assert.ok(Array.isArray((data as any).topology?.workflows))
  assert.deepEqual((data as any).topology?.pipeline, {
    router: 'workflow-router',
    workflows: ['clinical-verified'],
    defaultWorkflow: 'clinical-verified',
  })
  const topologyProfiles = (data as any).topology?.profiles as any[]
  const router = topologyProfiles.find((profile) => profile.name === 'router')
  assert.equal(router.pinned, false)
  const routerTargets = router.topology.stages
    .flatMap((stage: any) => stage.routes ?? [])
    .map((route: any) => route.targetProfile)
  assert.deepEqual(routerTargets, ['clinical', 'transcriptor', 'verifier'])
  const workflowRouter = topologyProfiles.find((profile) => profile.name === 'workflow-router')
  assert.equal(workflowRouter.pinned, true)
  const workflowTargets = workflowRouter.topology.stages
    .flatMap((stage: any) => stage.routes ?? [])
    .map((route: any) => route.targetProfile)
  assert.deepEqual(workflowTargets, ['clinical-verified'])
  // The gateway's fan and the configured workflow catalogue are the same set, asserted as a
  // relation rather than as two copies of one list: a workflow added to `[pipeline]` that the
  // router has no rule for is a card on the dashboard nothing can ever route to.
  assert.deepEqual([...workflowTargets].sort(), [...(data as any).topology.pipeline.workflows].sort())
  const clinical = topologyProfiles.find((profile) => profile.name === 'clinical')
  // Found by KIND, not by position. The clinical profile publishes the front-door vitals pass
  // and its CLI calculation ahead of the decision now, so the decision is no longer stage zero
  // and an index here would be asserting about a stage with no routes at all.
  const decision = clinical.topology.stages.find((stage: any) => stage.kind === 'decision')
  assert.ok(decision, 'the clinical profile publishes no decision stage')
  assert.ok(decision.routes.some((route: any) => route.name === 'shock-extraction'))
  assert.equal(decision.routes.find((route: any) => route.name === 'shock-extraction').feeds, 'shock')
  // The fan is clinical questions only: transcription, note formatting and summarisation are
  // tooling reached by `--task`, so none of them is drawn as a route. See `TOOLING_TASKS`.
  for (const tooling of ['summary', 'note-format', 'transcript']) {
    assert.ok(
      !decision.routes.some((route: any) => route.name === tooling),
      `tooling task '${tooling}' is published as a clinical route`,
    )
  }
  const verified = (data as any).topology.workflows.find((pipeline: any) => pipeline.name === 'clinical-verified')
  assert.deepEqual(verified.steps[1].input, [
    { name: 'document', ref: 'initial' },
    { name: 'extraction', ref: 'step-0.output' },
  ])
  assert.equal(verified.steps[1].profile, 'clinical-verifier')
  assert.equal(verified.steps[2].profile, 'verifier')
  assert.equal(verified.steps[2].input, 'step-1.output')
  assert.equal(typeof (data as any).sessions, 'number')
  // The dashboard can be pointed at any alkor, so the badge it draws has to come from the
  // server that answers rather than from the build the page was served from.
  const { HARNESS_STAGE, HARNESS_VERSION } = await import('../src/core/version.ts')
  assert.equal((data as any).harness?.version, HARNESS_VERSION)
  // Compared through the wire's own spelling: a release version carries no stage, and JSON
  // drops the key rather than sending null.
  assert.equal((data as any).harness?.stage ?? undefined, HARNESS_STAGE)
  await close()
})

test('health reports each configured model backend and its reachability', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alkor-health-test-'))

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
  const dir = mkdtempSync(join(tmpdir(), 'alkor-503-test-'))

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
  const dir = mkdtempSync(join(tmpdir(), 'alkor-session-start-test-'))

  // Reserve and release a port so the first readiness probe sees a genuinely dark backend.
  const reservation = createServer(() => {})
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const { port } = reservation.address() as { port: number }
  await new Promise<void>((resolve) => reservation.close(() => resolve()))

  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[assistant]\nmode = "agentic"\nmodule = "${AGENT_PROFILE}"\nurl = "http://127.0.0.1:${port}"\nmodel = "/models/fake.gguf"\n`,
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

  const alkor = await createAlkorServer(tomlPath, {
    llamaManager: { spawn, pollMs: 5, startTimeoutMs: 2000 },
  })
  alkor.listen(0, '127.0.0.1')
  await once(alkor, 'listening')
  const url = `http://127.0.0.1:${(alkor.address() as { port: number }).port}`

  try {
    const created = await request(`${url}/session`, 'POST', { profile: 'assistant', stream: false })
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
    alkor.closeAllConnections()
    alkor.close()
    await once(alkor, 'close')
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
  const dir = mkdtempSync(join(tmpdir(), 'alkor-gateway-test-'))

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

  const dir = mkdtempSync(join(tmpdir(), 'alkor-gateway-test-'))
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

test('workflow endpoint routes to a workflow and supports an explicit diagnostic override', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alkor-pipeline-front-door-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  const routerPath = join(dir, 'workflow-router.mjs')
  const workflowPath = join(dir, 'workflow.mjs')
  const workerPath = join(dir, 'worker.mjs')
  writeFileSync(
    tomlPath,
    `[pipeline]
router = "choose"
workflows = ["alpha", "beta"]
default = "alpha"

[choose]
mode = "router"
module = "workflow-router.mjs"

[alpha]
mode = "workflow"
module = "workflow.mjs"
steps = [{ name = "work", profile = "worker", input = "initial" }]

[beta]
mode = "workflow"
module = "workflow.mjs"
steps = [{ name = "work", profile = "worker", input = "initial" }]

[worker]
mode = "router"
module = "worker.mjs"
`,
  )
  writeFileSync(
    routerPath,
    `export const PROFILE = {
  name: 'choose', mode: 'router', needsPack: false,
  async review(ctx) {
    const input = ctx.input.text
    const profile = input.includes('beta') ? 'beta' : 'alpha'
    return { text: profile, ok: true, report: { profile, confidence: 1, reason: 'rule: test' } }
  },
  async runEval() { return { pass: true, summary: 'test' } },
}
`,
  )
  writeFileSync(
    workflowPath,
    `export const PROFILE = {
  name: 'workflow', mode: 'workflow', needsPack: false,
  async runEval() { return { pass: true, summary: 'test' } },
}
`,
  )
  writeFileSync(
    workerPath,
    `export const PROFILE = {
  name: 'worker', mode: 'router', needsPack: false,
  async review(ctx) { return { text: 'done', ok: true, report: { received: ctx.input.text } } },
  async runEval() { return { pass: true, summary: 'test' } },
}
`,
  )

  const { url, close } = await startServer(tomlPath)
  try {
    const routed = await request(`${url}/pipeline`, 'POST', { input: 'choose beta' })
    assert.equal(routed.status, 200)
    assert.equal((routed.data as any).workflow, 'beta')
    assert.equal((routed.data as any).route.profile, 'beta')
    assert.equal((routed.data as any).final.received, 'choose beta')

    const forced = await request(`${url}/pipeline`, 'POST', { input: 'choose beta', workflow: 'alpha' })
    assert.equal(forced.status, 200)
    assert.equal((forced.data as any).workflow, 'alpha')
    assert.equal((forced.data as any).route.reason, 'manual workflow override')
  } finally {
    await close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('session create, reset, load, and delete', async () => {
  // Its own config, because the session lifecycle is what is under test and this project
  // configures no agentic profile — a medical deployment has no reason to.
  const dir = mkdtempSync(join(tmpdir(), 'alkor-session-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(tomlPath, `[assistant]\nmode = "agentic"\nmodule = "${AGENT_PROFILE}"\n`)
  const { url, close } = await startServer(tomlPath)

  // Create
  const { status: createStatus, data: createData } = await request(`${url}/session`, 'POST', {
    profile: 'assistant',
    workspace: '/tmp',
  })
  assert.equal(createStatus, 200)
  const id = (createData as any).id
  assert.ok(typeof id === 'string')
  assert.equal((createData as any).profile, 'assistant')

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
  rmSync(dir, { recursive: true, force: true })
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

  // Create a temp profiles.toml that points the fixture agent profile at the stub.
  const dir = mkdtempSync(join(tmpdir(), 'alkor-server-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[assistant]
mode = "agentic"
module = "${AGENT_PROFILE}"
url = "http://127.0.0.1:${stubPort}"
`,
  )

  const { url, close } = await startServer(tomlPath)

  // Create session with stream: false so the server uses toolChat instead of streamChat.
  const { status, data } = await request(`${url}/session`, 'POST', {
    profile: 'assistant',
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
  assert.equal((sendData as any).iterations, 1)

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

  const dir = mkdtempSync(join(tmpdir(), 'alkor-server-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[assistant]
mode = "agentic"
module = "${AGENT_PROFILE}"
url = "http://127.0.0.1:${stubPort}"
`,
  )

  const { url, close } = await startServer(tomlPath)

  const { status, data } = await request(`${url}/session`, 'POST', {
    profile: 'assistant',
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

  const dir = mkdtempSync(join(tmpdir(), 'alkor-server-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[assistant]
mode = "agentic"
module = "${AGENT_PROFILE}"
url = "http://127.0.0.1:${stubPort}"
`,
  )

  const { url, close } = await startServer(tomlPath)

  const { status, data } = await request(`${url}/session`, 'POST', {
    profile: 'assistant',
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

/**
 * The run id on the response is what lets a caller read the feed for the run it just made.
 * Both endings must carry it: a success is useless to correlate without it, and a FAILURE is
 * the case that matters — the only account of what went wrong is in the events, and without
 * an id there is no way to say which events those were.
 */
test('a run names its run id on success and on failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alkor-runid-test-'))
  const okModule = join(dir, 'code-ok.mjs')
  const boomModule = join(dir, 'code-boom.mjs')
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[code-ok]\nmode = "code"\nmodule = "${okModule}"\n\n[code-boom]\nmode = "code"\nmodule = "${boomModule}"\n`,
  )
  // `code` runs no model, so both profiles reach their review with no backend at all.
  writeFileSync(
    okModule,
    "export const PROFILE = { name: 'code-ok', mode: 'code', needsPack: false, async review() { return { report: { ok: true } } }, async runEval() { return { pass: true, summary: 'test' } } }\n",
  )
  writeFileSync(
    boomModule,
    "export const PROFILE = { name: 'code-boom', mode: 'code', needsPack: false, async review() { throw new Error('the third step exploded') }, async runEval() { return { pass: true, summary: 'test' } } }\n",
  )

  const { url, close } = await startServer(tomlPath)
  try {
    const { status, data } = await request(`${url}/run`, 'POST', { profile: 'code-ok', input: 'hi' })
    assert.equal(status, 200)
    assert.match(String((data as any).runId), /^[0-9a-f-]{36}$/)

    const failed = await request(`${url}/run`, 'POST', { profile: 'code-boom', input: 'hi' })
    assert.equal(failed.status, 500)
    assert.equal((failed.data as any).error, 'the third step exploded')
    assert.match(String((failed.data as any).runId), /^[0-9a-f-]{36}$/)
    assert.equal((failed.data as any).profile, 'code-boom')
  } finally {
    await close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A refusal raised before the run starts still names the run, for the same reason. */
test('an unreachable backend refuses with the run id attached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alkor-runid-down-test-'))

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
    assert.match(String((data as any).runId), /^[0-9a-f-]{36}$/)
  } finally {
    await close()
    rmSync(dir, { recursive: true, force: true })
  }
})
