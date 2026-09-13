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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as nodeCreateServer, type Server } from 'node:http'
import { isolateTraces } from './traces.ts'
import { CancelledError, withCancellation, type Provider } from '../src/core/client.ts'
import { runWorkflow, buildWorkflow } from '../src/modes/workflow.ts'
import { runAgent } from '../src/modes/agentic.ts'
import { listRuns, RUN_FOOTER_EVENT, RUN_HEADER_EVENT } from '../src/core/runs.ts'
import { nullTrace, type Trace } from '../src/core/trace.ts'
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
const slowServer = async (blockMs = 6000): Promise<{
  url: string
  release: () => void
  started: () => Promise<void>
  close: () => Promise<void>
  dir: string
}> => {
  const dir = mkdtempSync(join(tmpdir(), 'alkor-cancel-'))
  const modulePath = join(dir, 'slow.mjs')
  const tomlPath = join(dir, 'profiles.toml')
  const afterPath = join(dir, 'after.mjs')
  const wfPath = join(dir, 'wf.mjs')
  const gate = join(dir, 'release')
  // Two ways to drive the same blocking profile: on its own, where a cancel cannot reach it
  // at all (a `code` review that ignores the provider runs to completion), and inside a
  // workflow, where the step boundary is the seam the cancel lands on. The pair is what
  // separates "the cancel stopped the run" from "the cancel arrived after it finished".
  writeFileSync(
    tomlPath,
    `[slow]\nmode = "code"\nmodule = "${modulePath}"\n\n` +
      `[after]\nmode = "code"\nmodule = "${afterPath}"\n\n` +
      `[wf]\nmode = "workflow"\nmodule = "${wfPath}"\n` +
      'steps = [{ name = "block", profile = "slow" }, { name = "after", profile = "after" }]\n',
  )
  writeFileSync(
    afterPath,
    "export const PROFILE = { name: 'after', mode: 'code', needsPack: false, " +
      "async review() { return { ok: true, text: 'second step ran', report: { second: true } } } }\n",
  )
  writeFileSync(
    wfPath,
    "export const PROFILE = { name: 'wf', mode: 'workflow', needsPack: false, " +
      "async review() { return { ok: true, text: 'never reached' } } }\n",
  )
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
      `    for (let i = 0; i < ${Math.ceil(blockMs / 10)} && !existsSync('${gate}'); i++) await sleep(10)\n` +
      "    return { ok: true, text: 'finished', report: { finished: true } }\n" +
      '  },\n' +
      '}\n',
  )

  // A trace directory per server, not per file. Two tests that both drive `wf` would
  // otherwise share one, and "the newest wf run" — which is how a test finds the id of a
  // request still in flight — could resolve to the PREVIOUS test's run, which already has
  // an outcome and the wrong `cancelledBy`. That is a real flake, seen roughly one run in
  // three, and it is the listing being ambiguous rather than the server being wrong.
  const traceDir = join(dir, 'traces')
  const outerTraceDir = process.env.TRACE_DIR
  process.env.TRACE_DIR = traceDir

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
      if (outerTraceDir === undefined) delete process.env.TRACE_DIR
      else process.env.TRACE_DIR = outerTraceDir
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('a cancelled workflow returns everything it got through', async () => {
  const { url, started, release, close } = await slowServer()
  try {
    const runPromise = fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'wf', input: 'anything' }),
    })
    await started()

    // The run id is not on the response yet — it is still open — so find it the way an
    // operator would: the run is the one in flight.
    const listed = (await (await fetch(`${url}/runs?profile=wf&limit=1`)).json()) as any
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

    // THE POINT: the work the run got through comes back with it. Step one finished before
    // the cancel landed, and throwing that away because the run also reports a stop is the
    // mistake `WorkflowResult.final` exists to prevent.
    assert.ok(Array.isArray(body.steps), 'the steps that ran must come back')
    assert.equal(body.steps[0].name, 'block')
    assert.equal(body.steps[0].ok, true)
    assert.ok(body.steps[0].report, 'the finished step keeps its output')
    // The step the cancel PREVENTED is recorded too, as not-ok and saying why. Naming it is
    // worth more than omitting it: a reader comparing this run to a complete one can see
    // where the chain stopped rather than inferring it from a short list.
    const blocked = body.steps.find((step: any) => step.name === 'after')
    assert.ok(blocked, 'the step that never ran must still be named')
    assert.equal(blocked.ok, false)
    assert.match(String(blocked.error), /cancelled/)

    // The recording says cancelled rather than failed, which is the distinction a listing
    // has to be able to make.
    const foot = readFileSync(body.trace, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((l) => l.event === RUN_FOOTER_EVENT)
    assert.equal(foot.ok, false)
    assert.equal(foot.cancelled, true)
    assert.equal(foot.cancelledBy, 'request')

    const summary = listRuns({ profile: 'wf' }).find((r) => r.runId === runId)
    assert.equal(summary?.outcome?.cancelled, true)
  } finally {
    await close()
  }
})

test('a cancel that arrives too late does not discard a finished run', async () => {
  const { url, started, release, close } = await slowServer()
  try {
    // `slow` on its own is a `code` review that never consults the provider, so nothing can
    // interrupt it — it runs to completion whatever the caller asks. That is the race, and
    // the run that won it must come back as the finished run it is.
    const runPromise = fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'slow', input: 'anything' }),
    })
    await started()
    const listed = (await (await fetch(`${url}/runs?profile=slow&limit=1`)).json()) as any
    const runId = listed.runs[0].runId as string
    await fetch(`${url}/run/${runId}`, { method: 'DELETE' })
    release()

    const res = await runPromise
    assert.equal(res.status, 200, 'a run that finished is a run that finished')
    const body = (await res.json()) as any
    assert.equal(body.ok, true)
    assert.equal(body.text, 'finished')

    // Both facts, and they are not the same fact: it completed, and a cancel was asked for.
    const foot = readFileSync(body.trace, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((l) => l.event === RUN_FOOTER_EVENT)
    assert.equal(foot.ok, true)
    assert.equal(foot.cancelled, undefined, 'finished work must not be filed as cancelled')
    assert.equal(foot.cancelRequested, 'request')
  } finally {
    await close()
  }
})

test('a workflow whose caller disconnects cancels itself, and says so', async () => {
  const { url, started, close } = await slowServer(1200)
  try {
    const abort = new AbortController()
    const runPromise = fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'wf', input: 'anything' }),
      signal: abort.signal,
    }).catch(() => undefined)
    await started()

    const listed = (await (await fetch(`${url}/runs?profile=wf&limit=1`)).json()) as any
    const runId = listed.runs[0].runId as string
    const tracePath = listed.runs[0].path as string

    // The tab closes. Nothing is waiting for this run any more.
    //
    // NOT followed by release(). A socket close has no observable event on this side, so
    // releasing the gate immediately raced the server noticing the disconnect — the step
    // finished first, the workflow completed, and the run was recorded as the successful
    // run it had become. Letting the step's own budget expire instead makes the ordering a
    // fact rather than a hope: the abort lands at once, the step ends a second later.
    abort.abort()
    await runPromise

    // Wait for the server to finish unwinding the run it no longer has a caller for.
    for (let i = 0; i < 300; i++) {
      const summary = listRuns({ profile: 'wf' }).find((r) => r.runId === runId)
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

test('a run that FAILED is no longer cancellable either', async () => {
  // The `finally` removes the registration, so it has to survive the failure path as well
  // as the success one. A stale entry is worse than a missing one: DELETE would report that
  // it had stopped something.
  const dir = mkdtempSync(join(tmpdir(), 'alkor-fail-reg-'))
  const modulePath = join(dir, 'boom.mjs')
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(tomlPath, `[boom]\nmode = "code"\nmodule = "${modulePath}"\n`)
  writeFileSync(
    modulePath,
    "export const PROFILE = { name: 'boom', mode: 'code', needsPack: false, " +
      "async review() { throw new Error('the rule table is empty') } }\n",
  )

  const server: Server = await createAlkorServer(tomlPath)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'boom', input: 'anything' }),
    })
    assert.equal(res.status, 500)
    const { runId } = (await res.json()) as any
    const cancel = await fetch(`http://127.0.0.1:${port}/run/${runId}`, { method: 'DELETE' })
    assert.equal(cancel.status, 404)
  } finally {
    server.closeAllConnections()
    server.close()
    await once(server, 'close')
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A trace whose write fails at a chosen event, and nothing else.
 *
 * The recording-failure paths cannot be reached by filling a disk from a test, so the server
 * takes an `openRunTrace` seam — the same device `sseBufferBytes` uses to reach the SSE
 * overflow branch.
 */
const brittleTrace = (failOn: string): { trace: Trace; written: string[] } => {
  const written: string[] = []
  return {
    written,
    trace: {
      path: '/dev/null/brittle.jsonl',
      write(event) {
        if (event.event === failOn) throw new Error(`ENOSPC: no space left on device, write '${failOn}'`)
        written.push(String(event.event))
      },
      close() {},
    },
  }
}

test('a run whose HEADER cannot be written answers, and leaves nothing registered', async () => {
  // The window this guards: registration used to sit outside the try that removes it, with
  // the header write in between. A failure here left an entry in the map forever — and a
  // later DELETE would report that it had stopped something.
  const { trace } = brittleTrace(RUN_HEADER_EVENT)
  const server: Server = await createAlkorServer(undefined, { openRunTrace: async () => trace })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'router', input: 'Patient BP 120/80, HR 72' }),
    })
    // The caller is answered rather than left hanging on a write they cannot see.
    assert.equal(res.status, 500)
    const { runId } = (await res.json()) as any
    assert.ok(runId, 'the refusal must still name the run')
    const cancel = await fetch(`http://127.0.0.1:${port}/run/${runId}`, { method: 'DELETE' })
    assert.equal(cancel.status, 404, 'the run must not still be registered as in flight')
  } finally {
    server.closeAllConnections()
    server.close()
    await once(server, 'close')
  }
})

test('a FOOTER that cannot be written does not cost the caller their answer', async () => {
  const { trace, written } = brittleTrace(RUN_FOOTER_EVENT)
  const server: Server = await createAlkorServer(undefined, { openRunTrace: async () => trace })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'router', input: 'Patient BP 120/80, HR 72' }),
    })
    // The run produced a reading; a disk that filled while recording it must not turn that
    // into a failure. The file is left without a footer, which a reader correctly reads as
    // "no outcome recorded".
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as any).ok, true)
    assert.ok(written.includes(RUN_HEADER_EVENT))
    assert.ok(!written.includes(RUN_FOOTER_EVENT))
  } finally {
    server.closeAllConnections()
    server.close()
    await once(server, 'close')
  }
})

test('a run whose trace cannot be opened registers nothing to leak', async (t) => {
  // The trace is opened BEFORE the run is registered, so a failure here must leave the map
  // untouched rather than an entry nothing will ever remove. Proving it needs a directory
  // the process cannot write to, which root does not have — skip rather than pass vacuously.
  // Deliberately NOT the slow fixture: that one owns TRACE_DIR for its own isolation and
  // would quietly undo the read-only directory this test is built on.
  const readOnly = mkdtempSync(join(tmpdir(), 'alkor-ro-'))
  chmodSync(readOnly, 0o500)
  try {
    writeFileSync(join(readOnly, 'probe'), 'x')
    t.skip('this process can write to a read-only directory (running as root?)')
    return
  } catch {
    // Good: the directory really is read-only.
  }

  const savedTraceDir = process.env.TRACE_DIR
  process.env.TRACE_DIR = readOnly
  const server: Server = await createAlkorServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'router', input: 'Patient BP 120/80, HR 72' }),
    })
    // The run never started: it could not be recorded, and recording is not optional when
    // it has been asked for.
    assert.equal(res.status, 500)
    const { runId } = (await res.json()) as any
    if (runId) {
      const cancel = await fetch(`http://127.0.0.1:${port}/run/${runId}`, { method: 'DELETE' })
      assert.equal(cancel.status, 404, 'a run that never started must not be registered')
    }
  } finally {
    server.closeAllConnections()
    server.close()
    await once(server, 'close')
    if (savedTraceDir === undefined) delete process.env.TRACE_DIR
    else process.env.TRACE_DIR = savedTraceDir
    chmodSync(readOnly, 0o700)
    rmSync(readOnly, { recursive: true, force: true })
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
