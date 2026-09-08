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
  assert.equal(typeof (data as any).sessions, 'number')
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
