/**
 * Cancelling a run.
 *
 * The properties that matter. One: a cancel must reach the model call, whoever made it —
 * which is why it rides on the PROVIDER rather than through `ReviewContext`, so an
 * out-of-tree profile is cancellable without having heard of cancellation. Two: a cancelled
 * run must not be recorded, reported or counted as a failed one; the harness declining and
 * the operator pressing stop are different events and only one of them says anything about
 * the model. Three: a run that has ended is no longer cancellable, or `DELETE` reports
 * success and stops nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as nodeCreateServer, type Server } from 'node:http'
import { isolateTraces } from './traces.ts'
import { CancelledError, withCancellation, type Provider } from '../src/core/client.ts'
import { runWorkflow, buildWorkflow } from '../src/modes/workflow.ts'
import { runAgent } from '../src/modes/agentic.ts'
import { listRuns, RUN_FOOTER_EVENT } from '../src/core/runs.ts'
import { nullTrace } from '../src/core/trace.ts'
import type { ProfileModule } from '../src/core/profile.ts'
import { createServer as createAlkorServer } from '../src/server.ts'

isolateTraces('cancel')

// --- The provider wrapper ---------------------------------------------------------------

/** A provider that reports what it was handed and never reaches a network. */
const spyProvider = (
  onChat: (o: { signal?: AbortSignal; label: string }) => Promise<string> = async () => 'ok',
): Provider & { calls: number } => {
  const p = {
    calls: 0,
    async chat(o: any) {
      p.calls++
      return onChat(o)
    },
    async toolChat(o: any) {
      p.calls++
      await onChat(o)
      return { content: 'ok', toolCalls: [] }
    },
    async streamChat(o: any) {
      p.calls++
      await onChat(o)
      return { content: 'ok', toolCalls: [], chunks: 1 }
    },
    async identify() {
      return { model: 'test', identified: true } as any
    },
  }
  return p as Provider & { calls: number }
}

test('the signal reaches every call, without the caller passing it', async () => {
  const controller = new AbortController()
  let seen: AbortSignal | undefined
  const inner = spyProvider(async (o) => {
    seen = o.signal
    return 'ok'
  })
  const wrapped = withCancellation(inner, controller.signal)

  await wrapped.chat({ messages: [], label: 'one' } as any)
  assert.ok(seen, 'chat must receive a signal it never asked for')
  assert.equal(seen!.aborted, false)

  await wrapped.toolChat({ messages: [], tools: [], label: 'two' } as any)
  assert.ok(seen)
  await wrapped.streamChat({ messages: [], tools: [], label: 'three' } as any)
  assert.ok(seen)
})

test("a caller's own signal survives being merged with the run's", async () => {
  const run = new AbortController()
  const own = new AbortController()
  let seen: AbortSignal | undefined
  const wrapped = withCancellation(
    spyProvider(async (o) => {
      seen = o.signal
      return 'ok'
    }),
    run.signal,
  )
  await wrapped.chat({ messages: [], label: 'merged', signal: own.signal } as any)
  assert.equal(seen!.aborted, false)
  // Either source must be able to fire it.
  own.abort()
  assert.equal(seen!.aborted, true)
})

test('a call that has not started yet is refused rather than spent', async () => {
  const controller = new AbortController()
  const inner = spyProvider()
  const wrapped = withCancellation(inner, controller.signal)
  controller.abort()
  await assert.rejects(() => wrapped.chat({ messages: [], label: 'late' } as any), CancelledError)
  // The point of refusing early: nothing was generated for a run nobody is waiting for.
  assert.equal(inner.calls, 0)
})

test('an abort mid-call is reported as cancelled, not as a missing server', async () => {
  const controller = new AbortController()
  // What the real transport does: `chat` dresses an aborted fetch up as a dead endpoint.
  const wrapped = withCancellation(
    spyProvider(async () => {
      controller.abort()
      throw new Error('cannot reach server at http://127.0.0.1:8081 — start one with scripts/llama-server.sh')
    }),
    controller.signal,
  )
  await assert.rejects(
    () => wrapped.chat({ messages: [], label: 'midflight' } as any),
    (e: Error) => e instanceof CancelledError && !e.message.includes('llama-server'),
  )
})

test('a failure that is NOT a cancel keeps its own error', async () => {
  const controller = new AbortController()
  const wrapped = withCancellation(
    spyProvider(async () => {
      throw new Error('server returned HTTP 500')
    }),
    controller.signal,
  )
  await assert.rejects(
    () => wrapped.chat({ messages: [], label: 'broken' } as any),
    (e: Error) => !(e instanceof CancelledError) && e.message.includes('HTTP 500'),
  )
})

// --- The loops --------------------------------------------------------------------------

/** A `code`-mode profile that records when it ran. */
const countingProfile = (ran: string[]): ProfileModule =>
  ({
    name: 'counter',
    mode: 'code',
    needsPack: false,
    async review(ctx: any) {
      ran.push(ctx.input.label ?? 'step')
      return { ok: true, text: 'done', report: { done: true } }
    },
  }) as unknown as ProfileModule

test('a workflow cancelled between steps does not start the next one', async () => {
  const ran: string[] = []
  const controller = new AbortController()
  const profile = {
    name: 'counter',
    mode: 'code',
    needsPack: false,
    async review() {
      ran.push('step')
      // Cancel arrives while step 0 is running, which is the case the provider cannot
      // catch: a code step never touches one.
      controller.abort()
      return { ok: true, text: 'done', report: { done: true } }
    },
  } as unknown as ProfileModule

  const steps = buildWorkflow([
    { name: 'first', profile: 'counter' },
    { name: 'second', profile: 'counter' },
    { name: 'third', profile: 'counter' },
  ])
  const result = await runWorkflow({
    initialInput: 'x',
    steps,
    profiles: new Map([['counter', profile]]),
    packs: new Map([['counter', undefined]]),
    baseUrls: new Map([['counter', undefined]]),
    trace: nullTrace(),
    signal: controller.signal,
  })

  assert.equal(ran.length, 1, 'only the step that was already running may run')
  assert.equal(result.stoppedEarly, true)
  const last = result.steps.at(-1)
  assert.equal(last?.ok, false)
  assert.match(String(last?.error), /cancelled/)
})

test('a workflow nobody cancelled runs every step', async () => {
  const ran: string[] = []
  const steps = buildWorkflow([
    { name: 'first', profile: 'counter' },
    { name: 'second', profile: 'counter' },
  ])
  const result = await runWorkflow({
    initialInput: 'x',
    steps,
    profiles: new Map([['counter', countingProfile(ran)]]),
    packs: new Map([['counter', undefined]]),
    baseUrls: new Map([['counter', undefined]]),
    trace: nullTrace(),
    signal: new AbortController().signal,
  })
  assert.equal(ran.length, 2)
  assert.equal(result.stoppedEarly, false)
})

test('an agent cancelled mid-run stops before executing another tool', async () => {
  const controller = new AbortController()
  let iterations = 0
  const result = await runAgent({
    systemPrompt: 'x',
    task: 'y',
    workspace: '/tmp',
    tools: [],
    maxIterations: 5,
    signal: controller.signal,
    chat: (async () => {
      iterations++
      controller.abort()
      return { content: 'thinking', toolCalls: [] }
    }) as any,
  })
  // `cancelled` is its own outcome: an agent stopped by an operator did not fail, and an
  // eval counting it as one would be measuring who was watching.
  assert.equal(result.stop, 'cancelled')
  assert.equal(iterations, 1)
})

// --- Over HTTP ---------------------------------------------------------------------------

/** Completion requests this stub has received, so a test can wait for one to be in flight. */
const stubRequests: string[] = []

/**
 * A backend that accepts a completion request and never answers it.
 *
 * Indistinguishable from a very slow model to everything upstream, which is the point: the
 * run has to be stopped by the cancel rather than by the reply arriving.
 */
const createStubServer = (): Server => {
  const server = nodeCreateServer((req, res) => {
    // Only the COMPLETION hangs. The server identifies a backend before it runs against it
    // — `/health`, `/props`, `/v1/models` — and a stub that swallowed those would hang the
    // run before the model call this test is about had even been made.
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', data: [{ id: 'stub' }], default_generation_settings: {} }))
      return
    }
    stubRequests.push(req.url ?? '')
    // No response, ever.
  })
  server.listen(0, '127.0.0.1')
  return server
}

/** A server whose one profile blocks until released, so a run can be caught in flight. */
const slowServer = async (): Promise<{
  url: string
  release: () => void
  started: () => Promise<void>
  close: () => Promise<void>
  dir: string
}> => {
  const dir = mkdtempSync(join(tmpdir(), 'alkor-cancel-'))
  const modulePath = join(dir, 'slow.mjs')
  const tomlPath = join(dir, 'profiles.toml')
  const gate = join(dir, 'release')
  writeFileSync(tomlPath, `[slow]\nmode = "code"\nmodule = "${modulePath}"\n`)
  // Polls a file rather than taking a callback: the profile is loaded in this process but
  // through a URL import, so it does not share module state with the test.
  writeFileSync(
    modulePath,
    "import { existsSync, writeFileSync } from 'node:fs'\n" +
      "const sleep = (ms) => new Promise((r) => setTimeout(r, ms))\n" +
      'export const PROFILE = {\n' +
      "  name: 'slow', mode: 'code', needsPack: false,\n" +
      '  async review(ctx) {\n' +
      `    writeFileSync('${join(dir, 'started')}', '1')\n` +
      `    for (let i = 0; i < 600 && !existsSync('${gate}'); i++) await sleep(10)\n` +
      "    return { ok: true, text: 'finished', report: { finished: true } }\n" +
      '  },\n' +
      '}\n',
  )

  const server: Server = await createAlkorServer(tomlPath)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }

  // A function, not a promise started here: the tests that never wait for a run to begin
  // would otherwise leave this polling — and rejecting — after they have finished.
  const started = async () => {
    const { existsSync } = await import('node:fs')
    for (let i = 0; i < 600; i++) {
      if (existsSync(join(dir, 'started'))) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('the run never started')
  }

  return {
    url: `http://127.0.0.1:${port}`,
    release: () => writeFileSync(gate, '1'),
    started,
    dir,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('DELETE /run/:id stops a run in flight, and the run says cancelled', async () => {
  const { url, started, release, close } = await slowServer()
  try {
    const runPromise = fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'slow', input: 'anything' }),
    })
    await started()

    // The run id is not on the response yet — it is still open — so find it the way an
    // operator would: the run is the one in flight.
    const listed = (await (await fetch(`${url}/runs?profile=slow&limit=1`)).json()) as any
    const runId = listed.runs[0].runId as string

    const cancel = await fetch(`${url}/run/${runId}`, { method: 'DELETE' })
    assert.equal(cancel.status, 200)
    assert.equal(((await cancel.json()) as any).cancelling, true)

    release()
    const res = await runPromise
    // 499, not 500: the harness did not fault, the caller stopped it.
    assert.equal(res.status, 499)
    const body = (await res.json()) as any
    assert.equal(body.cancelled, true)
    assert.equal(body.runId, runId)

    // And the recording says cancelled rather than failed, which is the distinction a
    // listing has to be able to make.
    const foot = readFileSync(body.trace, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((l) => l.event === RUN_FOOTER_EVENT)
    assert.equal(foot.ok, false)
    assert.equal(foot.cancelled, true)
    assert.equal(foot.cancelledBy, 'request')

    const summary = listRuns({ profile: 'slow' }).find((r) => r.runId === runId)
    assert.equal(summary?.outcome?.cancelled, true)
  } finally {
    await close()
  }
})

test('a run whose caller disconnects cancels itself, and says so', async () => {
  const { url, started, release, close } = await slowServer()
  try {
    const abort = new AbortController()
    const runPromise = fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'slow', input: 'anything' }),
      signal: abort.signal,
    }).catch(() => undefined)
    await started()

    const listed = (await (await fetch(`${url}/runs?profile=slow&limit=1`)).json()) as any
    const runId = listed.runs[0].runId as string
    const tracePath = listed.runs[0].path as string

    // The tab closes. Nothing is waiting for this run any more.
    abort.abort()
    await runPromise
    release()

    // Wait for the server to finish unwinding the run it no longer has a caller for.
    for (let i = 0; i < 300; i++) {
      const summary = listRuns({ profile: 'slow' }).find((r) => r.runId === runId)
      if (summary?.outcome) break
      await new Promise((r) => setTimeout(r, 10))
    }
    const foot = readFileSync(tracePath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((l) => l.event === RUN_FOOTER_EVENT)
    assert.equal(foot.cancelled, true)
    assert.equal(foot.cancelledBy, 'disconnect')
  } finally {
    await close()
  }
})

test('a run blocked in a MODEL CALL is stopped promptly, not at the next boundary', async () => {
  // The case the whole feature is for. On this hardware a run is inside a model call for
  // almost all of its life — 19.5s median, 107.7s cold — so a cancel that only took effect
  // at step boundaries would be a cancel that does nothing for the minute that matters.
  // The backend here accepts the request and never answers, which is a slow model as far as
  // anything upstream can tell.
  const dir = mkdtempSync(join(tmpdir(), 'alkor-cancel-llm-'))
  const hanging = createStubServer()
  await once(hanging, 'listening')
  const { port: llmPort } = hanging.address() as { port: number }

  const modulePath = join(dir, 'caller.mjs')
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[caller]\nmode = "code"\nmodule = "${modulePath}"\nurl = "http://127.0.0.1:${llmPort}"\n`,
  )
  writeFileSync(
    modulePath,
    "export const PROFILE = { name: 'caller', mode: 'code', needsPack: false,\n" +
      '  async review(ctx) {\n' +
      "    const text = await ctx.provider.chat({ baseUrl: ctx.baseUrl, systemPrompt: 's', userPrompt: 'u', label: 'hanging' })\n" +
      "    return { ok: true, text }\n" +
      '  } }\n',
  )

  const server: Server = await createAlkorServer(tomlPath)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  try {
    const startedAt = Date.now()
    const runPromise = fetch(`http://127.0.0.1:${port}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'caller', input: 'anything' }),
    })
    // Wait until the backend has actually received the request, so the cancel lands
    // mid-call rather than before it started — that is a different code path.
    for (let i = 0; i < 500 && stubRequests.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(stubRequests.length, 1, 'the model call must be in flight')

    const listed = (await (await fetch(`http://127.0.0.1:${port}/runs?profile=caller&limit=1`)).json()) as any
    const runId = listed.runs[0].runId as string
    await fetch(`http://127.0.0.1:${port}/run/${runId}`, { method: 'DELETE' })

    const res = await runPromise
    const elapsed = Date.now() - startedAt
    assert.equal(res.status, 499)
    // The harness backstop is 900s and this backend never answers, so anything that waited
    // for the call to finish on its own would be here for fifteen minutes.
    assert.ok(elapsed < 10_000, `the run took ${elapsed}ms to stop`)
    const body = (await res.json()) as any
    // And the message names a cancel rather than a llama-server that was never down.
    assert.match(String(body.error), /cancelled/)
    assert.ok(!String(body.error).includes('llama-server'))
  } finally {
    server.closeAllConnections()
    server.close()
    await once(server, 'close')
    hanging.closeAllConnections()
    hanging.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a run that has finished is no longer cancellable', async () => {
  const { url, release, close } = await slowServer()
  try {
    release()
    const res = await fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'slow', input: 'anything' }),
    })
    const { runId } = (await res.json()) as any
    assert.equal(res.status, 200)

    // A DELETE that reported success here would be a cancel that stopped nothing.
    const cancel = await fetch(`${url}/run/${runId}`, { method: 'DELETE' })
    assert.equal(cancel.status, 404)
    assert.match(String(((await cancel.json()) as any).error), /in flight/)
  } finally {
    await close()
  }
})

test('a completed run is not recorded as cancelled', async () => {
  const { url, release, close } = await slowServer()
  try {
    release()
    const res = await fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'slow', input: 'anything' }),
    })
    const body = (await res.json()) as any
    // A run nobody touched, recorded as what it was. This is the control for the two
    // cancellation tests above rather than a test of the `writableFinished` guard: by the
    // time 'close' fires on a normal response the footer is already written, so that guard
    // is not observable from here.
    const foot = readFileSync(body.trace, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((l) => l.event === RUN_FOOTER_EVENT)
    assert.equal(foot.ok, true)
    assert.equal(foot.cancelled, undefined)
  } finally {
    await close()
  }
})
