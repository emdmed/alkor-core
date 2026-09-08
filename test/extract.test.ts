/**
 * Extract mode's retry policy, over a real socket.
 *
 * A stubbed client would not answer the question these tests exist for, which is HOW MANY
 * REQUESTS a failure costs. That is a property of the transport boundary, so the tests serve
 * one: a throwaway HTTP server that counts what arrives and replies with whatever the case
 * needs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { extract } from '../src/modes/extract.ts'
import { createActivity, withActivityScope } from '../src/core/activity.ts'
import type { Provider } from '../src/core/client.ts'

interface Reply {
  status?: number
  content?: string
  finishReason?: string
}

/** Serve `replies` in order, repeating the last one, and record every request body. */
const serve = async (replies: Reply[]): Promise<{ url: string; bodies: string[]; close: () => Promise<void> }> => {
  const bodies: string[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const reply = replies[Math.min(bodies.length, replies.length - 1)]!
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      if (reply.status && reply.status !== 200) {
        res.writeHead(reply.status, { 'Content-Type': 'text/plain' })
        res.end('upstream is unhappy')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: reply.content ?? '{}' }, finish_reason: reply.finishReason ?? 'stop' }],
          timings: { prompt_n: 10, prompt_ms: 10, predicted_n: 5, predicted_ms: 50, cache_n: 0 },
        }),
      )
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: async () => {
      server.close()
      await once(server, 'close')
    },
  }
}

const run = (url: string, parse: (raw: string) => unknown, maxTokens?: number) =>
  extract({ systemPrompt: 'sys', document: 'doc', parse, baseUrl: url, maxTokens, label: 'test' })

const asJson = (raw: string): unknown => JSON.parse(raw)

test('a reply that parses is the result, and costs one request', async () => {
  const s = await serve([{ content: '{"ok": true}' }])
  const out = await run(s.url, asJson)
  assert.deepEqual(out.parsed, { ok: true })
  assert.equal(s.bodies.length, 1)
  await s.close()
})

/**
 * The measured waste this policy exists to end: temperature 0, greedy decoding, an identical
 * body — the second attempt reproduces the first. On the unconstrained gemma-3-4b arm of the
 * reference pack, 30 of 30 cases retried and none recovered, at twice the wall clock.
 */
test('a reply that will not parse is NOT retried', async () => {
  const s = await serve([{ content: '```json\n{"ok": true}\n```' }])
  const out = await run(s.url, asJson)
  assert.equal(out.parsed, undefined)
  assert.equal(s.bodies.length, 1, 'asking a greedy sampler the same question twice buys nothing')
  assert.ok(out.raw?.startsWith('```'), 'the completion is still recorded, so it can be re-scored offline')
  await s.close()
})

/** A request that never produced a completion says nothing about the model. That is retried. */
test('a transport failure is retried once, and both diagnoses are kept', async () => {
  const s = await serve([{ status: 503 }])
  const out = await run(s.url, asJson)
  assert.equal(out.parsed, undefined)
  assert.equal(s.bodies.length, 2)
  assert.match(out.error!, /503/)
  assert.match(out.error!, /retry:/)
  await s.close()
})

test('a transport failure that clears on the retry produces a reading', async () => {
  const s = await serve([{ status: 503 }, { content: '{"ok": 1}' }])
  const out = await run(s.url, asJson)
  assert.deepEqual(out.parsed, { ok: 1 })
  assert.equal(s.bodies.length, 2)
  await s.close()
})

/**
 * The retry has to be visible in what the run COST, and it was not.
 *
 * Per-completion metrics only arrive once a reply has been parsed out of the envelope, so the
 * failed first attempt contributed no entry — and `attempts` was derived from that array. The
 * case that paid for two requests reported one, `summarizeBench` therefore reported zero
 * retries, and the seconds spent waiting for the 503 were in no number anywhere.
 */
test('a retried case reports two attempts and the time the first one wasted', async () => {
  const s = await serve([{ status: 503 }, { content: '{"ok": 1}' }])
  const out = await run(s.url, asJson)
  assert.equal(out.attempts, 2, 'requests sent, not completions read')
  assert.equal(out.cost.length, 1, 'only one attempt ever produced tokens')
  assert.ok(out.lostMs > 0, 'the failed attempt cost wall clock, and the caller waited for it')
  await s.close()
})

test('a case that never reached the server still says how many times it tried', async () => {
  const s = await serve([{ status: 503 }])
  const out = await run(s.url, asJson)
  assert.equal(out.attempts, 2)
  assert.equal(out.cost.length, 0, 'no completion, so nothing to charge tokens for')
  assert.ok(out.lostMs > 0)
  await s.close()
})

test('an unretried success is one attempt and nothing lost', async () => {
  const s = await serve([{ content: '{"ok": true}' }])
  const out = await run(s.url, asJson)
  assert.equal(out.attempts, 1)
  assert.equal(out.lostMs, 0)
  await s.close()
})

/**
 * A cap that cut the JSON off is a budget the pack set, not a model that cannot write JSON.
 * The parser only sees the text and cannot tell; the server said so.
 */
test('a completion stopped by the cap says so', async () => {
  const s = await serve([{ content: '{"history": ["a", "b"', finishReason: 'length' }])
  const out = await run(s.url, asJson, 2048)
  assert.equal(out.parsed, undefined)
  assert.match(out.error!, /2048-token cap/)
  assert.match(out.error!, /cut off rather than wrong/)
  await s.close()
})

/** The pack's declared sampling has to reach the wire, or the header and trace describe a run
 * that did not happen. */
test('the declared sampling is in the request body', async () => {
  const s = await serve([{ content: '{}' }])
  await extract({
    systemPrompt: 'sys',
    document: 'doc',
    parse: asJson,
    baseUrl: s.url,
    maxTokens: 1234,
    temperature: 0.25,
    label: 'test',
  })
  const body = JSON.parse(s.bodies[0]!)
  assert.equal(body.max_tokens, 1234)
  assert.equal(body.temperature, 0.25)
  assert.equal(body.seed, 0, 'pinned, so a non-zero temperature is still reproducible')
  await s.close()
})

test('nothing declared sends the harness defaults', async () => {
  const s = await serve([{ content: '{}' }])
  await run(s.url, asJson)
  const body = JSON.parse(s.bodies[0]!)
  assert.equal(body.temperature, 0, 'a graded pass is greedy unless the pack says otherwise')
  assert.equal(body.cache_prompt, true)
  await s.close()
})

/**
 * Prefix reuse is a condition of the RESULT, not a performance knob: it is why the same bytes
 * can come back with a different capital, and a run that gives it up is the one that can be
 * compared with somebody else's byte for byte. A flag that did not reach the body would leave
 * the header claiming a reproducible run that never was one.
 */
test('--no-cache-prompt reaches the request body', async () => {
  const s = await serve([{ content: '{}' }])
  await extract({ systemPrompt: 'sys', document: 'doc', parse: asJson, baseUrl: s.url, cachePrompt: false, label: 'test' })
  assert.equal(JSON.parse(s.bodies[0]!).cache_prompt, false)
  await s.close()
})

test('extract paints prompt-assembly and parse stages on the activity bus', async () => {
  const a = createActivity()
  const fake: Provider = {
    chat: async () => '{"value": 42}',
    toolChat: async () => ({ content: null, toolCalls: [] }),
    streamChat: async () => ({ content: null, toolCalls: [], chunks: 0 }),
    identify: async () => ({ identified: true }),
  }
  await withActivityScope({ runId: 'run-9' }, () =>
    extract({
      systemPrompt: 'sys',
      document: 'doc',
      parse: asJson,
      provider: fake,
      activity: a,
      label: 'painted',
      maxTokens: 100,
    }),
  )

  const stages = a.recent().filter((e) => e.kind === 'stage')
  const names = stages.map((e: any) => `${e.name}:${e.status}`)
  assert.deepEqual(names, ['prompt-assembly:started', 'prompt-assembly:completed', 'parse:started', 'parse:completed'])

  const completed = stages.find((e: any) => e.name === 'prompt-assembly' && e.status === 'completed') as any
  assert.equal(completed.runId, 'run-9')
  assert.deepEqual(
    { constrained: completed.detail.constrained, maxTokens: completed.detail.maxTokens, promptChars: completed.detail.promptChars, documentChars: completed.detail.documentChars },
    { constrained: false, maxTokens: 100, promptChars: 3, documentChars: 3 },
  )
  const parse = stages.find((e: any) => e.name === 'parse' && e.status === 'completed') as any
  assert.deepEqual(parse.detail, { ok: true })
})

test('extract paints a failed parse with ok:false on the activity bus', async () => {
  const a = createActivity()
  const fake: Provider = {
    chat: async () => 'not-json',
    toolChat: async () => ({ content: null, toolCalls: [] }),
    streamChat: async () => ({ content: null, toolCalls: [], chunks: 0 }),
    identify: async () => ({ identified: true }),
  }
  const out = await extract({
    systemPrompt: 'sys',
    document: 'doc',
    parse: asJson,
    provider: fake,
    activity: a,
    label: 'painted-fail',
  })
  assert.ok(out.parsed === undefined)
  assert.ok(out.error)
  const parse = a.recent().find((e: any) => e.kind === 'stage' && e.name === 'parse' && e.status === 'completed') as any
  assert.equal(parse.detail.ok, false)
  assert.ok(typeof parse.detail.reason === 'string')
})
