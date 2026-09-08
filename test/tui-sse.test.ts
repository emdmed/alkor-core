/**
 * SSE client: replay burst, Last-Event-ID resume, heartbeats, reconnect, activitySpec refusal.
 *
 * Tests against an in-process node:http server exactly as test/server-activity.test.ts does.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { setTimeout } from 'node:timers/promises'
import { ACTIVITY_SPEC, type ActivityEvent } from '../src/core/activity.ts'
import { createSseClient, type SseOptions, type SseConnectionStatus } from '../src/tui/sse.ts'

/** Start a controllable SSE server on a fixed port. */
const startSseServer = async (port: number): Promise<{
  server: Server
  sendEvent: (event: ActivityEvent) => void
  sendHeartbeat: () => void
  close: () => Promise<void>
  headers: () => Record<string, string | string[] | undefined>[]
}> => {
  const receivedHeaders: Record<string, string | string[] | undefined>[] = []
  let clientRes: any = null

  const server = createServer((req, res) => {
    receivedHeaders.push(req.headers)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(':ok\n\n')
    clientRes = res

    req.on('close', () => {
      clientRes = null
    })
  })

  server.listen(port, '127.0.0.1')
  await once(server, 'listening')

  const sendEvent = (event: ActivityEvent) => {
    if (clientRes) {
      clientRes.write(`id: ${event.seq}\n`)
      clientRes.write(`event: ${event.kind}\n`)
      clientRes.write(`data: ${JSON.stringify(event)}\n\n`)
    }
  }

  const sendHeartbeat = () => {
    if (clientRes) {
      clientRes.write(': ping\n\n')
    }
  }

  const close = async () => {
    server.closeAllConnections()
    server.close()
    await once(server, 'close')
  }

  return { server, sendEvent, sendHeartbeat, close, headers: () => receivedHeaders }
}

/** Create a minimal client and collect events. */
const collectEvents = (url: string, o?: Partial<SseOptions>): {
  events: ActivityEvent[]
  connections: SseConnectionStatus[]
  client: ReturnType<typeof createSseClient>
} => {
  const events: ActivityEvent[] = []
  const connections: SseConnectionStatus[] = []
  const client = createSseClient({
    url,
    onEvent: (e) => events.push(e),
    onConnection: (s) => connections.push(s),
    backoffMs: 50,
    maxBackoffMs: 200,
    ...o,
  })
  return { events, connections, client }
}

const baseEvent = (seq: number, kind: ActivityEvent['kind']): ActivityEvent => ({
  activitySpec: ACTIVITY_SPEC,
  seq,
  ts: new Date().toISOString(),
  kind,
} as ActivityEvent)

test('SSE client receives events on connect', async () => {
  const port = 19_001
  const { sendEvent, close } = await startSseServer(port)
  const { events, client } = collectEvents(`http://127.0.0.1:${port}/events`)

  await setTimeout(50) // let connection open
  sendEvent(baseEvent(1, 'server.ready'))
  sendEvent(baseEvent(2, 'http.request'))

  await setTimeout(50)
  assert.equal(events.length, 2)
  assert.equal(events[0]!.seq, 1)
  assert.equal(events[1]!.seq, 2)

  client.close()
  await close()
})

test('SSE dedup by seq and tolerates gaps', async () => {
  const port = 19_002
  const { sendEvent, close } = await startSseServer(port)
  const { events, client } = collectEvents(`http://127.0.0.1:${port}/events`)

  await setTimeout(50)
  sendEvent(baseEvent(1, 'server.ready'))
  sendEvent(baseEvent(1, 'server.ready')) // duplicate
  sendEvent(baseEvent(5, 'http.request')) // gap

  await setTimeout(50)
  assert.equal(events.length, 2)
  assert.equal(events[0]!.seq, 1)
  assert.equal(events[1]!.seq, 5)

  client.close()
  await close()
})

test('SSE heartbeats are ignored', async () => {
  const port = 19_003
  const { sendEvent, sendHeartbeat, close } = await startSseServer(port)
  const { events, client } = collectEvents(`http://127.0.0.1:${port}/events`)

  await setTimeout(50)
  sendEvent(baseEvent(1, 'server.ready'))
  sendHeartbeat()
  sendHeartbeat()
  sendEvent(baseEvent(2, 'http.completed'))

  await setTimeout(50)
  assert.equal(events.length, 2)
  assert.equal(events[0]!.kind, 'server.ready')
  assert.equal(events[1]!.kind, 'http.completed')

  client.close()
  await close()
})

test('SSE Last-Event-ID skips replay', async () => {
  const port = 19_004
  const { sendEvent, close, headers } = await startSseServer(port)
  const { events, client } = collectEvents(`http://127.0.0.1:${port}/events`)

  await setTimeout(50)
  sendEvent(baseEvent(1, 'server.ready'))
  sendEvent(baseEvent(2, 'http.request'))

  await setTimeout(50)
  // Kill the first connection by stopping the server
  await close()

  // Start a new server on the same port
  const { sendEvent: send2, close: close2, headers: headers2 } = await startSseServer(port)

  await setTimeout(150) // wait for reconnect (backoffMs is 50, so first retry is ~50ms)
  // The reconnect should have Last-Event-ID: 2
  const reconnectHeaders = headers2()
  const lastIdHeader = reconnectHeaders.find((h) => h['last-event-id'] === '2')
  assert.ok(lastIdHeader, 'reconnect should send Last-Event-ID: 2')

  // Server sends a new event
  send2(baseEvent(3, 'http.completed'))

  await setTimeout(50)
  // Should only have event 3, not the replay of 1 and 2
  assert.ok(events.some((e) => e.seq === 1), 'original event 1 received')
  assert.ok(events.some((e) => e.seq === 2), 'original event 2 received')
  assert.ok(events.some((e) => e.seq === 3), 'reconnected event 3 received')
  // No duplicates of 1 and 2
  assert.equal(events.filter((e) => e.seq === 1).length, 1)
  assert.equal(events.filter((e) => e.seq === 2).length, 1)

  client.close()
  await close2()
})

test('SSE wrong activitySpec sets refused and stops reconnecting', async () => {
  const port = 19_005
  const { close, server } = await startSseServer(port)
  // Override the server to send bad activitySpec
  server.closeAllConnections()
  server.close()
  await once(server, 'close')

  const badServer = createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(':ok\n\n')
    const event = { ...baseEvent(1, 'server.ready'), activitySpec: 99 }
    res.write(`id: 1\nevent: server.ready\ndata: ${JSON.stringify(event)}\n\n`)
    // Keep connection open so client doesn't immediately reconnect
  })
  badServer.listen(port, '127.0.0.1')
  await once(badServer, 'listening')

  const { events, connections, client } = collectEvents(`http://127.0.0.1:${port}/events`)

  await setTimeout(100)
  assert.equal(events.length, 0) // refused event is not passed to onEvent
  const refused = connections.find((c) => c.kind === 'refused')
  assert.ok(refused, 'should emit refused status')
  assert.ok((refused as any).reason.includes('99'))

  client.close()
  badServer.closeAllConnections()
  badServer.close()
  await once(badServer, 'close')
})

test('SSE reconnect on server kill resumes without duplicates', async () => {
  const port = 19_006
  const { sendEvent, close } = await startSseServer(port)
  const { events, client } = collectEvents(`http://127.0.0.1:${port}/events`)

  await setTimeout(50)
  sendEvent(baseEvent(1, 'server.ready'))
  sendEvent(baseEvent(2, 'http.request'))

  await setTimeout(50)
  // Kill server
  await close()

  // Restart on same port
  const { sendEvent: send2, close: close2 } = await startSseServer(port)
  await setTimeout(150) // wait for reconnect

  send2(baseEvent(3, 'http.completed'))
  send2(baseEvent(4, 'profile.loaded'))

  await setTimeout(50)
  // All 4 events, no duplicates
  assert.equal(new Set(events.map((e) => e.seq)).size, events.length)
  assert.ok(events.some((e) => e.seq === 1))
  assert.ok(events.some((e) => e.seq === 2))
  assert.ok(events.some((e) => e.seq === 3))
  assert.ok(events.some((e) => e.seq === 4))

  client.close()
  await close2()
})
