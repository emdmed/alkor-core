/**
 * Provider wrapper: correct events, and the wrapped provider receives byte-identical
 * options (the pin — `client.ts` is not touched, and the request body stays identical).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withActivity, createActivity } from '../src/core/activity.ts'
import type { Provider, ChatOptions, ToolChatOptions, StreamChatOptions, StreamResult } from '../src/core/client.ts'

test('wrapped chat emits llm.request and llm.response on success', async () => {
  const a = createActivity()
  const bodies: ChatOptions[] = []
  const fake: Provider = {
    chat: async (o) => { bodies.push(o); return 'ok' },
    toolChat: async () => ({ content: null, toolCalls: [] }),
    streamChat: async () => ({ content: null, toolCalls: [], chunks: 0 }),
    identify: async () => ({ identified: true }),
  }
  const wrapped = withActivity(fake, a)
  const opts: ChatOptions = {
    systemPrompt: 'sys',
    userPrompt: 'user',
    label: 'test-label',
    baseUrl: 'http://127.0.0.1:9999',
    model: 'm1',
    schema: { type: 'object' },
  }
  const result = await wrapped.chat(opts)
  assert.equal(result, 'ok')
  assert.equal(bodies.length, 1)
  // Byte-identical pass-through: the same object reference.
  assert.equal(bodies[0]!, opts)

  const events = a.recent(4)
  assert.equal(events[0]!.kind, 'llm.request')
  assert.equal((events[0] as any).label, 'test-label')
  assert.equal((events[0] as any).constrained, true)
  assert.equal((events[0] as any).messageCount, 2)
  // The llm-call stage pairs with the request: one stageId shared by started and completed,
  // equal to the request id, so a dashboard can join the node to this record.
  assert.equal(events[1]!.kind, 'stage')
  assert.equal((events[1] as any).name, 'llm-call')
  assert.equal((events[1] as any).status, 'started')
  assert.equal((events[2] as any).name, 'llm-call')
  assert.equal((events[2] as any).status, 'completed')
  assert.equal((events[2] as any).detail, (events[2] as any).detail) // present, whatever it is
  assert.equal((events[1] as any).stageId, (events[0] as any).requestId)
  assert.equal((events[2] as any).stageId, (events[0] as any).requestId)
  assert.deepEqual((events[2] as any).detail, { ok: true })
  assert.equal(events[3]!.kind, 'llm.response')
})

test('wrapped chat emits llm.error on failure', async () => {
  const a = createActivity()
  const fake: Provider = {
    chat: async () => { throw new Error('network down') },
    toolChat: async () => ({ content: null, toolCalls: [] }),
    streamChat: async () => ({ content: null, toolCalls: [], chunks: 0 }),
    identify: async () => ({ identified: true }),
  }
  const wrapped = withActivity(fake, a)
  await assert.rejects(
    () => wrapped.chat({ systemPrompt: 's', userPrompt: 'u', label: 'l' }),
    /network down/,
  )
  const events = a.recent(4)
  assert.equal(events[0]!.kind, 'llm.request')
  // The failed call still closes its stage node — as a completed node that failed.
  assert.equal((events[2] as any).status, 'completed')
  assert.deepEqual((events[2] as any).detail, { ok: false })
  assert.equal(events[3]!.kind, 'llm.error')
  assert.equal((events[3] as any).message, 'network down')
})

test('wrapped toolChat emits llm.request and llm.response with usage', async () => {
  const a = createActivity()
  const fake: Provider = {
    chat: async () => 'ok',
    toolChat: async () => ({
      content: 'hi',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 2 },
    }),
    streamChat: async () => ({ content: null, toolCalls: [], chunks: 0 }),
    identify: async () => ({ identified: true }),
  }
  const wrapped = withActivity(fake, a)
  const opts: ToolChatOptions = { messages: [{ role: 'user' }], tools: [], label: 'tchat' }
  const result = await wrapped.toolChat(opts)
  assert.equal(result.content, 'hi')

  const events = a.recent(4)
  assert.equal((events[0] as any).messageCount, 1)
  assert.equal((events[3] as any).promptTokens, 10)
  assert.equal((events[3] as any).completionTokens, 5)
  assert.equal((events[3] as any).cachedTokens, 2)
})

test('wrapped streamChat emits llm.request and llm.response with chunks', async () => {
  const a = createActivity()
  const fake: Provider = {
    chat: async () => 'ok',
    toolChat: async () => ({ content: null, toolCalls: [] }),
    streamChat: async () => ({
      content: 'hi',
      toolCalls: [],
      chunks: 3,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
    identify: async () => ({ identified: true }),
  }
  const wrapped = withActivity(fake, a)
  const opts: StreamChatOptions = { messages: [{ role: 'user' }], tools: [], label: 'schat' }
  const result = await wrapped.streamChat(opts)
  assert.equal(result.chunks, 3)

  const events = a.recent(4)
  assert.equal((events[3] as any).chunks, 3)
})

test('identify is passed through unchanged', async () => {
  const a = createActivity()
  const fake: Provider = {
    chat: async () => 'ok',
    toolChat: async () => ({ content: null, toolCalls: [] }),
    streamChat: async () => ({ content: null, toolCalls: [], chunks: 0 }),
    identify: async (baseUrl) => ({ identified: true, model: baseUrl }),
  }
  const wrapped = withActivity(fake, a)
  const id = await wrapped.identify('http://example.com')
  assert.equal(id.model, 'http://example.com')
  assert.equal(a.recent().length, 0)
})

test('byte-identical pass-through: the body the wrapped provider sees is unchanged', async () => {
  const a = createActivity()
  const seen: ToolChatOptions[] = []
  const fake: Provider = {
    chat: async () => 'ok',
    toolChat: async (o) => { seen.push(o); return { content: null, toolCalls: [] } },
    streamChat: async () => ({ content: null, toolCalls: [], chunks: 0 }),
    identify: async () => ({ identified: true }),
  }
  const wrapped = withActivity(fake, a)
  const opts: ToolChatOptions = {
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user' }],
    tools: [{ type: 'function', function: { name: 'f' } }],
    baseUrl: 'http://127.0.0.1:8080',
    model: 'm',
    label: 'l',
  }
  await wrapped.toolChat(opts)
  assert.equal(seen.length, 1)
  // Same reference, not a clone — the wrapper adds nothing to the request.
  assert.equal(seen[0]!, opts)
})
