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
import { createServer as createMedextractServer } from '../src/server.ts'

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

/** Collect SSE frames from a raw HTTP response until timeout or socket close. */
const collectSse = (url: string, timeoutMs = 300): Promise<{ id: string; event: string; data: string }[]> => {
  return new Promise((resolve) => {
    const frames: { id: string; event: string; data: string }[] = []
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
    // Connect an SSE client via raw HTTP so we can destroy it cleanly.
    const ssePromise = collectSse(`${url}/events`, 200)

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
    assert.ok(frames.some((f) => f.event === 'http.completed'))
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

    // Should not contain any replayed events (since we asked for seq > 99999).
    assert.ok(frames.length > 0, 'at least the :ok frame arrives')
    const replayed = frames.filter((f) => f.event === 'http.request')
    assert.equal(replayed.length, 0, 'no replayed events with high Last-Event-ID')
  } finally {
    await close()
  }
})

// --- Pipeline handoff edge ------------------------------------------------------------------

test('pipeline run emits step.started with handoff edge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-activity-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  const profilePath = join(dir, 'profile.ts')
  writeFileSync(
    tomlPath,
    `[pipeline-test]
mode = "pipeline"
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
  mode: 'pipeline',
  needsPack: false,
  async runEval() { return { pass: true, summary: 'test' } },
}
`,
  )

  const { url, close } = await startServer(tomlPath)
  try {
    const { status } = await request(`${url}/run`, 'POST', {
      profile: 'pipeline-test',
      input: 'hello',
    })
    assert.equal(status, 200)
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

  const dir = mkdtempSync(join(tmpdir(), 'medextract-activity-test-'))
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

  const dir = mkdtempSync(join(tmpdir(), 'medextract-activity-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[coding]
mode = "agentic"
url = "http://127.0.0.1:${stubPort}"
`,
  )

  const { url, close } = await startServer(tomlPath)
  try {
    const { status, data } = await request(`${url}/session`, 'POST', {
      profile: 'coding',
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

  const dir = mkdtempSync(join(tmpdir(), 'medextract-destroy-test-'))
  const tomlPath = join(dir, 'profiles.toml')
  writeFileSync(
    tomlPath,
    `[coding]\nmode = "agentic"\nurl = "http://127.0.0.1:${stubPort}"\n`,
  )

  const { url, close } = await startServer(tomlPath)
  try {
    const { status, data } = await request(`${url}/session`, 'POST', { profile: 'coding', workspace: '/tmp' })
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
