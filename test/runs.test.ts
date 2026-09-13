/**
 * Recorded runs: writing them, indexing them, and serving them back.
 *
 * Three properties carry the weight. One: a run driven through the server leaves the same
 * kind of file a CLI verb leaves, because a result the repository cannot reproduce is not a
 * measurement and the dashboard was the one surface producing those. Two: an absent footer is
 * never read as a pass — the difference between "this run refused" and "this process was
 * killed" is exactly the distinction the product is built on. Three: a run id arrives over
 * HTTP, so resolving one must go through the listing rather than through path concatenation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { isolateTraces } from './traces.ts'
import { composeRedactors, openTrace } from '../src/core/trace.ts'
import {
  listRuns,
  readRun,
  RunError,
  RUN_FOOTER_EVENT,
  RUN_HEADER_EVENT,
} from '../src/core/runs.ts'
import { TRACE_SPEC } from '../src/core/trace.ts'
import { createServer as createAlkorServer } from '../src/server.ts'

const TRACES = isolateTraces('runs')

/** A trace file written by hand, so a test can state exactly what is on disk. */
const writeTrace = (profile: string, name: string, lines: unknown[]): string => {
  const dir = join(TRACES, profile)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.jsonl`)
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
  return path
}

const header = (runId: string, profile: string) => ({
  traceSpec: TRACE_SPEC,
  event: RUN_HEADER_EVENT,
  runId,
  profile,
  inputChars: 4,
  inputDigest: 'abcd',
})

const footer = (runId: string, ok: boolean, extra: object = {}) => ({
  traceSpec: TRACE_SPEC,
  event: RUN_FOOTER_EVENT,
  runId,
  ok,
  wallMs: 12,
  ...extra,
})

// --- The store ------------------------------------------------------------------------

test('a listing is newest first, by the moment each run STARTED', () => {
  writeTrace('alpha', '2026-01-01T00-00-00-000Z--11111111-1111-4111-8111-111111111111', [
    header('11111111-1111-4111-8111-111111111111', 'alpha'),
    footer('11111111-1111-4111-8111-111111111111', true),
  ])
  writeTrace('alpha', '2026-01-02T00-00-00-000Z--22222222-2222-4222-8222-222222222222', [
    header('22222222-2222-4222-8222-222222222222', 'alpha'),
    footer('22222222-2222-4222-8222-222222222222', true),
  ])

  const runs = listRuns({ profile: 'alpha' })
  assert.deepEqual(
    runs.map((run) => run.runId),
    ['22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111'],
  )
  // The stamp is decoded back to the instant it encodes, not left as a filename.
  assert.equal(runs[0]?.startedAt, '2026-01-02T00:00:00.000Z')
  assert.equal(runs[0]?.id, 'alpha/2026-01-02T00-00-00-000Z--22222222-2222-4222-8222-222222222222')
  assert.equal(runs[0]?.profile, 'alpha')
})

test('the outcome comes off the footer, error and all', () => {
  writeTrace('beta', '2026-02-01T00-00-00-000Z--33333333-3333-4333-8333-333333333333', [
    header('33333333-3333-4333-8333-333333333333', 'beta'),
    footer('33333333-3333-4333-8333-333333333333', false, { error: 'step 2 could not reach its backend' }),
  ])
  const [run] = listRuns({ profile: 'beta' })
  assert.equal(run?.outcome?.ok, false)
  assert.equal(run?.outcome?.error, 'step 2 could not reach its backend')
  assert.equal(run?.outcome?.wallMs, 12)
})

test('a trace with NO footer reports no outcome, rather than reading as a pass', () => {
  // What a killed process leaves: a header, some work, and nothing closing it.
  writeTrace('beta', '2026-02-02T00-00-00-000Z--44444444-4444-4444-8444-444444444444', [
    header('44444444-4444-4444-8444-444444444444', 'beta'),
    { traceSpec: TRACE_SPEC, event: 'run', kind: 'review', task: 'shock' },
  ])
  const run = listRuns({ profile: 'beta' }).find((entry) => entry.startedAt === '2026-02-02T00:00:00.000Z')
  assert.ok(run)
  assert.equal(run.outcome, undefined)
})

test('a half-written last line does not hide the outcome above it', () => {
  const dir = join(TRACES, 'gamma')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, '2026-03-01T00-00-00-000Z--55555555-5555-4555-8555-555555555555.jsonl')
  writeFileSync(
    path,
    `${JSON.stringify(header('55555555-5555-4555-8555-555555555555', 'gamma'))}\n` +
      `${JSON.stringify(footer('55555555-5555-4555-8555-555555555555', true))}\n` +
      '{"event":"trunc',
  )
  const [run] = listRuns({ profile: 'gamma' })
  assert.equal(run?.outcome?.ok, true)
})

test('a CLI trace — no run id in its name — is listed beside the server\'s own', () => {
  writeTrace('delta', '2026-04-01T00-00-00-000Z', [{ traceSpec: TRACE_SPEC, event: 'run', kind: 'review' }])
  const [run] = listRuns({ profile: 'delta' })
  assert.equal(run?.runId, undefined)
  assert.equal(run?.startedAt, '2026-04-01T00:00:00.000Z')
  assert.equal(run?.id, 'delta/2026-04-01T00-00-00-000Z')
  // It can still be fetched — by the listed id, which is the only one it has.
  assert.equal(readRun(run!.id, { events: false }).summary.profile, 'delta')
})

test('a name that is not a stamp is listed without inventing a start time', () => {
  writeTrace('delta', 'hand-written', [{ traceSpec: TRACE_SPEC, event: 'run' }])
  const run = listRuns({ profile: 'delta' }).find((entry) => entry.id === 'delta/hand-written')
  assert.ok(run)
  assert.equal(run.startedAt, undefined)
})

test('limit bounds the listing', () => {
  const runs = listRuns({ limit: 2 })
  assert.equal(runs.length, 2)
  assert.deepEqual(listRuns({ limit: 0 }), [])
})

test('a missing trace directory is an empty list, not a failure', () => {
  const saved = process.env.TRACE_DIR
  process.env.TRACE_DIR = join(TRACES, 'nothing-here')
  try {
    assert.deepEqual(listRuns(), [])
  } finally {
    process.env.TRACE_DIR = saved
  }
})

// --- Resolution -----------------------------------------------------------------------

test('a run is fetched by the run id its caller was handed', () => {
  const { summary, trace } = readRun('33333333-3333-4333-8333-333333333333')
  assert.equal(summary.profile, 'beta')
  assert.equal(trace?.events.length, 2)
  assert.equal(trace?.events[0]?.event, RUN_HEADER_EVENT)
})

test('events can be skipped, for a caller that only wants the verdict', () => {
  const { summary, trace } = readRun('33333333-3333-4333-8333-333333333333', { events: false })
  assert.equal(trace, undefined)
  assert.equal(summary.outcome?.ok, false)
})

test('an id is matched against the listing, never joined onto a path', () => {
  writeFileSync(join(TRACES, 'secret.jsonl'), '{"event":"run"}\n')
  for (const attempt of [
    '../secret',
    'beta/../../secret',
    '/etc/passwd',
    'beta/2026-02-01T00-00-00-000Z--33333333-3333-4333-8333-333333333333/../../secret',
  ]) {
    assert.throws(() => readRun(attempt), RunError, `'${attempt}' must not resolve`)
  }
})

test('an unknown run is a RunError rather than an empty answer', () => {
  assert.throws(() => readRun('99999999-9999-4999-8999-999999999999'), RunError)
})

test('a lookup resolves the oldest run in a busy directory without reading the rest', () => {
  // Resolution runs on NAMES now; only the matched file is opened. The open COUNT is not
  // assertable here — Node snapshots named imports from builtins, so `openSync` cannot be
  // counted from a test — so this pins the behaviour that had to keep working when the
  // reading moved out of the matching: the worst case for a newest-first catalogue is the
  // oldest entry, and it must still resolve, footer and all.
  const dir = join(TRACES, 'busy')
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < 40; i++) {
    const stamp = new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString().replace(/[:.]/g, '-')
    const runId = `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
    writeFileSync(
      join(dir, `${stamp}--${runId}.jsonl`),
      `${JSON.stringify(header(runId, 'busy'))}\n${JSON.stringify(footer(runId, i === 0))}\n`,
    )
  }

  const oldest = readRun('00000000-0000-4000-8000-000000000000', { events: false })
  assert.equal(oldest.summary.profile, 'busy')
  assert.equal(oldest.summary.startedAt, '2026-06-01T00:00:00.000Z')
  // The footer is still read for the one that matched, which is the half that moved.
  assert.equal(oldest.summary.outcome?.ok, true)

  const newest = readRun('00000039-0000-4000-8000-000000000000', { events: false })
  assert.equal(newest.summary.outcome?.ok, false)
  // And the listing over the same directory is still newest-first.
  assert.equal(listRuns({ profile: 'busy', limit: 1 })[0]?.runId, '00000039-0000-4000-8000-000000000000')
})

// --- Writing --------------------------------------------------------------------------

test('a trace opened with a run id carries it in the filename, on a boundary that parses', () => {
  const trace = openTrace('epsilon', undefined, '66666666-6666-4666-8666-666666666666')
  trace.write({ event: RUN_HEADER_EVENT })
  const [run] = listRuns({ profile: 'epsilon' })
  assert.equal(run?.runId, '66666666-6666-4666-8666-666666666666')
  // The stamp survived the split: its own dashes are single, the boundary is double.
  assert.ok(run?.startedAt, 'the stamp must still decode')
})

test('composed redactors apply in order, and none is the identity', () => {
  const drop = (field: string) => (e: Record<string, unknown>) => {
    const out = { ...e }
    delete out[field]
    return out
  }
  const both = composeRedactors(drop('completion'), drop('error'))
  assert.deepEqual(both({ keep: 1, completion: 'x', error: 'y' }), { keep: 1 })
  assert.deepEqual(composeRedactors()({ completion: 'x' }), { completion: 'x' })
})

// --- Over HTTP ------------------------------------------------------------------------

const startServer = async (): Promise<{ url: string; close: () => Promise<void> }> => {
  const server: Server = await createAlkorServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

const get = async (url: string): Promise<{ status: number; data: any }> => {
  const res = await fetch(url)
  return { status: res.status, data: await res.json().catch(() => null) }
}

test('a run driven over HTTP is recorded, and the response says where', async () => {
  const { url, close } = await startServer()
  try {
    // The router runs on compiled rules, so this is a whole run with no model in it.
    const res = await fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'router', input: 'Patient BP 120/80, HR 72' }),
    })
    const body = (await res.json()) as { runId: string; trace: string }
    assert.equal(res.status, 200)
    assert.ok(body.trace.startsWith(TRACES), `trace must land under ${TRACES}, got ${body.trace}`)

    // The envelope is on disk, both halves of it.
    const lines = readFileSync(body.trace, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const head = lines.find((l) => l.event === RUN_HEADER_EVENT)
    const foot = lines.find((l) => l.event === RUN_FOOTER_EVENT)
    assert.equal(head?.runId, body.runId)
    assert.equal(head?.via, '/run')
    assert.equal(head?.mode, 'router')
    // Metadata about the input, never the input: the digest and the length, and no note.
    assert.equal(head?.inputChars, 'Patient BP 120/80, HR 72'.length)
    assert.ok(!JSON.stringify(head).includes('120/80'))
    assert.equal(foot?.ok, true)
    assert.equal(typeof foot?.wallMs, 'number')

    // And it is reachable by the id the caller was handed.
    const fetched = await get(`${url}/runs/${body.runId}`)
    assert.equal(fetched.status, 200)
    assert.equal(fetched.data.runId, body.runId)
    assert.equal(fetched.data.profile, 'router')
    assert.equal(fetched.data.outcome.ok, true)
    assert.ok(Array.isArray(fetched.data.events))

    const listed = await get(`${url}/runs?profile=router`)
    assert.equal(listed.status, 200)
    assert.ok(listed.data.runs.some((run: any) => run.runId === body.runId))
  } finally {
    await close()
  }
})

test('a run that throws is footed as a failure, carrying what went wrong', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alkor-run-fail-'))
  const modulePath = join(dir, 'code-boom.mjs')
  const tomlPath = join(dir, 'profiles.toml')
  // `code` is a deterministic mode: it computes, so this is a real run with no model behind
  // it, and the only thing it does is fail.
  writeFileSync(tomlPath, `[code-boom]\nmode = "code"\nmodule = "${modulePath}"\n`)
  writeFileSync(
    modulePath,
    "export const PROFILE = { name: 'code-boom', mode: 'code', needsPack: false, " +
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
      body: JSON.stringify({ profile: 'code-boom', input: 'anything' }),
    })
    const body = (await res.json()) as { runId: string; trace: string; error: string }
    assert.equal(res.status, 500)
    // The refusal names the recording, so a caller holding a 500 can still read the run.
    assert.ok(body.trace.startsWith(TRACES))

    const foot = readFileSync(body.trace, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((l) => l.event === RUN_FOOTER_EVENT)
    assert.equal(foot?.ok, false)
    assert.equal(foot?.error, 'the rule table is empty')

    const [run] = listRuns({ profile: 'code-boom' })
    assert.equal(run?.runId, body.runId)
    assert.equal(run?.outcome?.ok, false)
  } finally {
    server.closeAllConnections()
    server.close()
    await once(server, 'close')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a workflow trace is redacted by its STEPS, not only by the wrapper that opened it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alkor-wf-redact-'))
  const stepPath = join(dir, 'leaky.mjs')
  const wfPath = join(dir, 'wrapper.mjs')
  const tomlPath = join(dir, 'profiles.toml')

  // The hazard this guards: a workflow traces under the WRAPPER's name, and the wrapper
  // declares no redactor — the profile that touches documents is the step. Every step writes
  // into the wrapper's file, so a composition that stopped at the wrapper would put this
  // step's raw completion on disk while the profile doing the reading appeared to have
  // redaction configured.
  writeFileSync(
    stepPath,
    "export const PROFILE = { name: 'leaky', mode: 'code', needsPack: false, " +
      "redact: (e) => (typeof e.completion === 'string' ? { ...e, completion: '[elided]' } : e), " +
      "async review(ctx) { ctx.trace.write({ event: 'review', completion: 'BP 148/92, the note verbatim' }); " +
      "return { ok: true, text: 'step done', report: { done: true } } } }\n",
  )
  // The wrapper declares no redaction of its own — that is the whole point of the test — and
  // a `review` only because a profile with neither `review` nor `runEval` cannot be loaded.
  // Workflow mode dispatches to the steps, so it is never called.
  writeFileSync(
    wfPath,
    "export const PROFILE = { name: 'wrapper', mode: 'workflow', needsPack: false, " +
      "async review() { return { ok: true, text: 'never reached' } } }\n",
  )
  writeFileSync(
    tomlPath,
    `[leaky]\nmode = "code"\nmodule = "${stepPath}"\n\n` +
      `[wrapper]\nmode = "workflow"\nmodule = "${wfPath}"\n` +
      'steps = [{ name = "only", profile = "leaky", final = true }]\n',
  )

  const server: Server = await createAlkorServer(tomlPath)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'wrapper', input: 'a note' }),
    })
    const body = (await res.json()) as { trace: string }
    assert.equal(res.status, 200)
    const text = readFileSync(body.trace, 'utf8')
    assert.ok(text.includes('[elided]'), 'the step\'s own redactor must have run')
    assert.ok(!text.includes('148/92'), `the raw completion reached disk:\n${text}`)
  } finally {
    server.closeAllConnections()
    server.close()
    await once(server, 'close')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a request refused before a run id is minted records nothing at all', async () => {
  const { url, close } = await startServer()
  try {
    const before = listRuns({ profile: 'router' }).length
    const res = await fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'router', input: '' }),
    })
    assert.equal(res.status, 400)
    // No dated empty file in the directory the real recordings live in.
    assert.equal(listRuns({ profile: 'router' }).length, before)
  } finally {
    await close()
  }
})

test('the listing endpoint refuses a limit that is not a count', async () => {
  const { url, close } = await startServer()
  try {
    const { status, data } = await get(`${url}/runs?limit=-3`)
    assert.equal(status, 400)
    assert.ok(String(data.error).includes('limit'))
  } finally {
    await close()
  }
})

test('a browser page may read a run\'s metadata but not its contents', async () => {
  const { url, close } = await startServer()
  try {
    const res = await fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'router', input: 'Patient BP 120/80, HR 72' }),
    })
    const { runId } = (await res.json()) as { runId: string }

    // Any local port is a loopback origin, and none of them is this operator's dashboard.
    const page = { Origin: 'http://localhost:1234' }

    // The listing is metadata — a run history needs it and it carries no content.
    const listed = await fetch(`${url}/runs?profile=router`, { headers: page })
    assert.equal(listed.status, 200)
    assert.equal(listed.headers.get('access-control-allow-origin'), 'http://localhost:1234')

    // The summary alone is metadata too.
    const summary = await fetch(`${url}/runs/${runId}?events=0`, { headers: page })
    assert.equal(summary.status, 200)

    // The events are not. Refused rather than emptied: a run returned with no events reads
    // as a run that recorded nothing, which is a lie about the file.
    const content = await fetch(`${url}/runs/${runId}`, { headers: page })
    assert.equal(content.status, 403)
    const body = (await content.json()) as { error: string; events?: unknown }
    assert.equal(body.events, undefined)
    assert.match(body.error, /ALKOR_TRACE_CORS/)

    // A caller with no Origin is not a page — curl, a script, a cron job — and is allowed.
    const script = await fetch(`${url}/runs/${runId}`)
    assert.equal(script.status, 200)
    assert.ok(Array.isArray(((await script.json()) as any).events))
  } finally {
    await close()
  }
})

test('ALKOR_TRACE_CORS names the page that may read trace contents', async () => {
  const saved = process.env.ALKOR_TRACE_CORS
  process.env.ALKOR_TRACE_CORS = 'http://localhost:5173'
  const { url, close } = await startServer()
  try {
    const res = await fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'router', input: 'Patient BP 120/80, HR 72' }),
    })
    const { runId } = (await res.json()) as { runId: string }

    const allowed = await fetch(`${url}/runs/${runId}`, { headers: { Origin: 'http://localhost:5173' } })
    assert.equal(allowed.status, 200)
    // Naming one origin does not admit its neighbours.
    const other = await fetch(`${url}/runs/${runId}`, { headers: { Origin: 'http://localhost:1234' } })
    assert.equal(other.status, 403)
  } finally {
    await close()
    if (saved === undefined) delete process.env.ALKOR_TRACE_CORS
    else process.env.ALKOR_TRACE_CORS = saved
  }
})

test('an unknown run over HTTP is a 404 that names what was asked for', async () => {
  const { url, close } = await startServer()
  try {
    const { status, data } = await get(`${url}/runs/not-a-run`)
    assert.equal(status, 404)
    assert.ok(String(data.error).includes('not-a-run'))
  } finally {
    await close()
  }
})

test('ALKOR_SERVER_TRACE=0 records nothing and says so', async () => {
  const saved = process.env.ALKOR_SERVER_TRACE
  process.env.ALKOR_SERVER_TRACE = '0'
  const { url, close } = await startServer()
  try {
    const before = readdirSync(join(TRACES, 'router')).length
    const res = await fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'router', input: 'Patient BP 120/80, HR 72' }),
    })
    const body = (await res.json()) as { trace: string }
    assert.equal(res.status, 200)
    assert.equal(body.trace, '(not recorded)')
    assert.equal(readdirSync(join(TRACES, 'router')).length, before)
  } finally {
    await close()
    if (saved === undefined) delete process.env.ALKOR_SERVER_TRACE
    else process.env.ALKOR_SERVER_TRACE = saved
  }
})
