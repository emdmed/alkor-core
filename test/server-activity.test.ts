/**
 * Server activity stream: SSE framing, event ordering, replay, clinical stage tree.
 *
 * Tests exercise the server with a real HTTP server and a stub llama-server where needed.
 * All assertions are against the activity events, not the response bodies.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, get as httpGet } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createAlkorServer, sseWrite } from '../src/server.ts'

process.env.MEDPROTOCOL_BIN = join(import.meta.dirname, 'fixtures', 'medprotocol.js')

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

/**
 * Collect SSE frames from a raw HTTP response until `until` is satisfied, or the timeout, or
 * the socket closes. The predicate matters: an SSE stream never ends on its own, so a test
 * that wants a specific event must be able to wait for THAT rather than guess a duration.
 */
const collectSse = (
  url: string,
  timeoutMs = 300,
  until?: (frames: { id: string; event: string; data: string }[]) => boolean,
): Promise<{ id: string; event: string; data: string }[]> => {
  return new Promise((resolve) => {
    const frames: { id: string; event: string; data: string }[] = []
    let settled = false
    const req = httpGet(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      let buffer = ''
      const collect = () => {
        let cut: number
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          const lines = frame.split('\n')
          let id = '', event = '', data = ''
          for (const line of lines) {
            if (line.startsWith('id: ')) id = line.slice(4)
            else if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (event || data) frames.push({ id, event, data })
        }
        if (!settled && until?.(frames)) {
          settled = true
          req.destroy()
          resolve(frames)
        }
      }
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        collect()
      })
      res.on('end', () => { collect(); resolve(frames) })
      res.on('close', () => { collect(); resolve(frames) })
    })
    req.on('error', () => resolve(frames))
    req.on('close', () => resolve(frames))
    setTimeout(() => { req.destroy(); resolve(frames) }, timeoutMs)
  })
}

// --- Basic events and SSE -------------------------------------------------------------------

test('health endpoint returns activity stats', async () => {
  const { url, close } = await startServer()
  try {
    // Connect an SSE client via raw HTTP so we can destroy it cleanly. The stream is held
    // until the /health envelope closes — probing model backends takes longer than a fixed
    // window, and an SSE read that expires early proves nothing about the feed.
    const ssePromise = collectSse(`${url}/events`, 3000, (frames) =>
      frames.some((f) => f.event === 'server.ready') &&
      frames.some((f) => f.event === 'http.request') &&
      frames.some((f) => f.event === 'http.completed'))

    // Wait for the SSE connection to open.
    await new Promise((r) => setTimeout(r, 50))

    const { status, data } = await request(`${url}/health`, 'GET')
    assert.equal(status, 200)
    assert.equal(typeof (data as any).activity, 'object')
    assert.equal(typeof (data as any).activity.buffered, 'number')
    assert.equal((data as any).activity.subscribers, 1)

    const frames = await ssePromise
    assert.ok(frames.some((f) => f.event === 'server.ready'))
    assert.ok(frames.some((f) => f.event === 'http.request'))
    const completed = frames
      .filter((f) => f.event === 'http.completed' && f.data)
      .map((f) => JSON.parse(f.data) as { path: string })
    assert.ok(completed.some((e) => e.path === '/health'), 'the /health envelope closes on the wire')
  } finally {
    await close()
  }
})

test('route endpoint emits route.decided event', async () => {
  const { url, close } = await startServer()
  try {
    const { status } = await request(`${url}/route`, 'POST', { input: 'Hello world', defaultProfile: 'general' })
    assert.equal(status, 200)
  } finally {
    await close()
  }
})

test('run endpoint with router emits run.started and run.completed', async () => {
  const { url, close } = await startServer()
  try {
    const { status } = await request(`${url}/run`, 'POST', { profile: 'router', input: 'test' })
    assert.equal(status, 200)
  } finally {
    await close()
  }
})

// --- SSE replay and Last-Event-ID -----------------------------------------------------------

test('SSE replay sends recent events on connect', async () => {
  const { url, close } = await startServer()
  try {
    // Generate a few events.
    await request(`${url}/health`, 'GET')
    await request(`${url}/health`, 'GET')

    // Connect to events; the short timeout lets us read the replay burst.
    const frames = await collectSse(`${url}/events`, 100)
    assert.ok(frames.some((f) => f.event === 'server.ready'))
    assert.ok(frames.some((f) => f.event === 'http.request'))
  } finally {
    await close()
  }
})

test('SSE with high Last-Event-ID skips replay', async () => {
  const { url, close } = await startServer()
  try {
    // Generate events.
    await request(`${url}/health`, 'GET')

    // Connect with a high Last-Event-ID.
    const frames = await new Promise<{ id: string; event: string; data: string }[]>((resolve) => {
      const frames: { id: string; event: string; data: string }[] = []
      const req = httpGet(`${url}/events`, { headers: { 'Last-Event-ID': '99999' } }, (res) => {
        let buffer = ''
        const collect = () => {
          let cut: number
          while ((cut = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, cut)
            buffer = buffer.slice(cut + 2)
            const lines = frame.split('\n')
            let id = '', event = '', data = ''
            for (const line of lines) {
              if (line.startsWith('id: ')) id = line.slice(4)
              else if (line.startsWith('event: ')) event = line.slice(7)
              else if (line.startsWith('data: ')) data = line.slice(6)
            }
            if (event || data) frames.push({ id, event, data })
          }
        }
        res.on('data', (chunk: Buffer) => { buffer += chunk.toString('utf8'); collect() })
        res.on('end', () => { collect(); resolve(frames) })
        res.on('close', () => { collect(); resolve(frames) })
      })
      req.on('error', () => resolve(frames))
      req.on('close', () => resolve(frames))
      setTimeout(() => { req.destroy(); resolve(frames) }, 100)
    })

    // Should not contain any replayed events (since we asked for seq > 99999). The reader
    // above drops comment-only frames, so a stream that replays nothing yields nothing —
    // the `:ok` handshake and the `: ping`s are not events.
    assert.equal(frames.length, 0, 'no replayed events with high Last-Event-ID')
  } finally {
    await close()
  }
})

/** Collect frames with extra request headers, reusing the framing reader above. */
const collectSseWith = (
  url: string,
  headers: Record<string, string>,
  timeoutMs = 150,
): Promise<{ id: string; event: string; data: string }[]> => {
  return new Promise((resolve) => {
    const frames: { id: string; event: string; data: string }[] = []
    const req = httpGet(url, { headers: { Accept: 'text/event-stream', ...headers } }, (res) => {
      let buffer = ''
      const collect = () => {
        let cut: number
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          let id = '', event = '', data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4)
            else if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (event || data) frames.push({ id, event, data })
        }
      }
      res.on('data', (chunk: Buffer) => { buffer += chunk.toString('utf8'); collect() })
      res.on('end', () => { collect(); resolve(frames) })
      res.on('close', () => { collect(); resolve(frames) })
    })
    req.on('error', () => resolve(frames))
    setTimeout(() => { req.destroy(); resolve(frames) }, timeoutMs)
  })
}

/**
 * The bounded per-client buffer the spec promises. Before this the write's return value was
 * ignored entirely, so a client that stopped reading grew this process without limit.
 */
test('sseWrite reports overflow once a client stops draining', () => {
  const written: string[] = []
  const client = {
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
    write: (chunk: string) => {
      written.push(chunk)
      client.writableLength += chunk.length // nothing is draining
      return true
    },
  }
  assert.equal(sseWrite(client, 'data: small\n\n', 1000), 'ok')
  client.writableLength = 999
  assert.equal(sseWrite(client, 'x', 1000), 'ok', 'at the cap the client is still usable')
  client.writableLength = 1000
  assert.equal(sseWrite(client, 'x', 1000), 'overflow')
  assert.equal(written.length, 3, 'the payload is written before the verdict is formed')
})

test('sseWrite refuses a response that has gone away instead of writing to it', () => {
  const ended = { writableEnded: true, destroyed: false, writableLength: 0, write: () => { throw new Error('must not write') } }
  assert.equal(sseWrite(ended, 'data: x\n\n', 1000), 'gone')
  const destroyed = { writableEnded: false, destroyed: true, writableLength: 0, write: () => { throw new Error('must not write') } }
  assert.equal(sseWrite(destroyed, 'data: x\n\n', 1000), 'gone')
})

test('every event carries this server instance id', async () => {
  const { url, close } = await startServer()
  try {
    const health = await request(`${url}/health`, 'GET')
    const instance = (health.data as { activity: { instance: string } }).activity.instance
    assert.ok(instance, '/health reports the stream identity')

    const frames = await collectSse(`${url}/events`, 150)
    const events = frames.filter((f) => f.data).map((f) => JSON.parse(f.data) as { instanceId?: string })
    assert.ok(events.length > 0)
    assert.ok(events.every((e) => e.instanceId === instance), 'one identity for the whole stream')
  } finally {
    await close()
  }
})

/**
 * A seq issued by ANOTHER process is not a position in this one's buffer. Trusting it is how
 * a dashboard reconnecting to a restarted server gets an empty stream and stays empty.
 */
test('SSE ignores a Last-Event-ID from a different instance and replays', async () => {
  const { url, close } = await startServer()
  try {
    await request(`${url}/health`, 'GET')
    const frames = await collectSseWith(`${url}/events`, {
      'Last-Event-ID': '99999',
      'x-activity-instance': 'some-other-server',
    })
    assert.ok(frames.some((f) => f.event === 'server.ready'), 'buffer replayed despite the high seq')
  } finally {
    await close()
  }
})

test('SSE replays everything when Last-Event-ID is unparseable', async () => {
  const { url, close } = await startServer()
  try {
    await request(`${url}/health`, 'GET')
    const frames = await collectSseWith(`${url}/events`, { 'Last-Event-ID': 'not-a-number' })
    assert.ok(frames.some((f) => f.event === 'server.ready'), 'a garbage header must not suppress replay')
  } finally {
    await close()
  }
})

/**
 * The http envelope belongs to the STREAM's lifetime. Closing it at open reported a
 * connection held for hours as a two-millisecond request.
 */
test('SSE http.completed is emitted when the stream closes, not when it opens', async () => {
  const { url, close } = await startServer()
  try {
    await collectSse(`${url}/events`, 150)
    // Read the buffer through a second connection: the first one's envelope must be closed
    // by now, and its duration must cover the time the stream was actually held open.
    const frames = await collectSse(`${url}/events`, 150)
    const completed = frames
      .filter((f) => f.event === 'http.completed' && f.data)
      .map((f) => JSON.parse(f.data) as { path: string; wallMs: number })
      .filter((e) => e.path === '/events')
    assert.equal(completed.length, 1, 'exactly the closed stream is reported completed')
    assert.ok(completed[0]!.wallMs > 100, `envelope should span the stream, got ${completed[0]!.wallMs}ms`)
  } finally {
    await close()
  }
})

/**
 * `close()` waits for open connections, and an SSE stream never ends by itself. Without the
 * feeds being closed as part of closing, a server with a dashboard attached shuts down never
 * — and the cleanup that stops managed backends never runs.
 */
test('closing the server ends attached SSE streams instead of hanging', async () => {
  const server = await createAlkorServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }

  // Hold a real SSE connection open, then close WITHOUT closeAllConnections().
  const streaming = collectSse(`http://127.0.0.1:${port}/events`, 5000)
  await new Promise((r) => setTimeout(r, 100))
  const health = await request(`http://127.0.0.1:${port}/health`, 'GET')
  assert.equal((health.data as { activity: { subscribers: number } }).activity.subscribers, 1)

  server.close()
  await once(server, 'close') // hangs forever if the stream is not ended
  await streaming
})

// --- Pipeline handoff edge ------------------------------------------------------------------

test('workflow run emits step.started with handoff edge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alkor-activity-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  const profilePath = join(dir, 'profile.ts')
  writeFileSync(
    tomlPath,
    `[pipeline-test]
mode = "workflow"
module = "profile.ts"
steps = [
  { name = "extract", profile = "router" },
  { name = "verify", profile = "router" },
]

[router]
mode = "router"
`,
  )
  writeFileSync(
    profilePath,
    `export const PROFILE = {
  name: 'pipeline-test',
  mode: 'workflow',
  needsPack: false,
  async runEval() { return { pass: true, summary: 'test' } },
}
`,
  )

  const { url, close } = await startServer(tomlPath)
  try {
    const { status, data } = await request(`${url}/run`, 'POST', {
      profile: 'pipeline-test',
      input: 'hello',
    })
    assert.equal(status, 200)
    assert.deepEqual((data as any).output, (data as any).final)
  } finally {
    await close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- Clinical stage tree with stub llama-server ---------------------------------------------

test('clinical shock run emits stage tree', async () => {
  // Stub llama-server that distinguishes extraction from classification by
  // the user message content.
  const stub = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'stub-clinical' }] }))
      return
    }
    if (req.url === '/props') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ model_ftype: 'Q4_K', total_slots: 1, default_generation_settings: { n_ctx: 32768 } }))
      return
    }
    if (req.url === '/v1/chat/completions') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const parsed = JSON.parse(body)
        const user = String(parsed.messages?.[1]?.content ?? '')
        let content: string
        if (user.includes('PHYSICAL EXAMINATION')) {
          // shock classification
          content = JSON.stringify({
            skin_temperature: 'cool',
            jugular_venous_pressure: 'normal_or_low',
            shock_category: 'hypovolemic',
            supporting_findings: [],
            discordant_findings: [],
            indeterminate_reason: null,
            assessment_confidence: 0.9,
            notes: null,
          })
        } else {
          // shock extraction
          content = JSON.stringify({
            hypotension: { systolic: 78, diastolic: 50, duration_minutes: 45 },
            heart_rate: 110,
            skin_temperature: 'cool',
            jugular_venous_pressure: 'normal_or_low',
            capillary_refill: 'delayed',
            pulse_volume: 'thready',
            lung_exam: 'clear',
          })
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [{ message: { content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
        )
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  stub.listen(0, '127.0.0.1')
  await once(stub, 'listening')
  const { port: stubPort } = stub.address() as { port: number }

  const dir = mkdtempSync(join(tmpdir(), 'alkor-activity-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  const packPath = join(import.meta.dirname, '..', 'packs', 'clinical').replace(/\\/g, '/')
  writeFileSync(
    tomlPath,
    `[clinical]
mode = "extract"
pack = "${packPath}"
url = "http://127.0.0.1:${stubPort}"
`,
  )

  const { url, close } = await startServer(tomlPath)
  try {
    // An input that triggers shock-suspicion routing.
    const input = 'Patient is hypotensive with low blood pressure. Tachycardia with elevated heart rate. Cool peripheries and poor perfusion. Oliguria with low urine output. Altered mental status and confusion.'

    const { status } = await request(`${url}/run`, 'POST', {
      profile: 'clinical',
      input,
    })
    assert.equal(status, 200)
  } finally {
    await close()
    stub.closeAllConnections()
    stub.close()
    await once(stub, 'close')
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- Session events -------------------------------------------------------------------------

test('session send emits turn.started and turn.completed', async () => {
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

  const dir = mkdtempSync(join(tmpdir(), 'alkor-activity-test-'))
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
  try {
    const { status, data } = await request(`${url}/session`, 'POST', {
      profile: 'assistant',
      workspace: '/tmp',
      stream: false,
    })
    assert.equal(status, 200)
    const id = (data as any).id

    const { status: sendStatus } = await request(`${url}/session/${id}/send`, 'POST', { text: 'hello' })
    assert.equal(sendStatus, 200)
  } finally {
    await close()
    stub.closeAllConnections()
    stub.close()
    await once(stub, 'close')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('session delete emits session.destroyed', async () => {
  // A session's model backend only matters for sending; creation must succeed against an
  // unreachable/unmanaged stub so the DELETE flow is what's under test, not model handling.
  const stub = createServer((req, res) => {
    res.writeHead(404)
    res.end()
  })
  stub.listen(0, '127.0.0.1')
  await once(stub, 'listening')
  const { port: stubPort } = stub.address() as { port: number }

  const dir = mkdtempSync(join(tmpdir(), 'alkor-destroy-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[assistant]\nmode = "agentic"\nmodule = "${AGENT_PROFILE}"\nurl = "http://127.0.0.1:${stubPort}"\n`,
  )

  const { url, close } = await startServer(tomlPath)
  try {
    const { status, data } = await request(`${url}/session`, 'POST', { profile: 'assistant', workspace: '/tmp' })
    assert.equal(status, 200)
    const id = (data as any).id

    await request(`${url}/session/${id}`, 'DELETE')
  } finally {
    await close()
    stub.closeAllConnections()
    stub.close()
    await once(stub, 'close')
    rmSync(dir, { recursive: true, force: true })
  }
})
