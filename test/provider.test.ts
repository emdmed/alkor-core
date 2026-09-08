/**
 * Provider abstraction: a custom LLM backend can be injected into every mode.
 *
 * The built-in provider is an HTTP client that speaks OpenAI-compatible chat completions
 * to llama-server. Replacing it with a test double proves the interface boundary is real
 * and that every mode delegates to it rather than importing the client directly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extract } from '../src/modes/extract.ts'
import { runAgent } from '../src/modes/agentic.ts'
import { createSession } from '../src/modes/session.ts'
import { route } from '../src/modes/router.ts'
import { ChatError } from '../src/core/client.ts'
import type { Provider, Usage } from '../src/core/client.ts'

const makeProvider = (reply: string): Provider => ({
  chat: async () => reply,
  toolChat: async () => ({ content: reply, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
  streamChat: async () => ({ content: reply, toolCalls: [], chunks: 1, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
  identify: async () => ({ model: 'stub', identified: true }),
})

const toolProvider = (toolName: string, args: Record<string, unknown>): Provider => ({
  chat: async () => JSON.stringify({ profile: toolName, confidence: 1, reason: 'test' }),
  toolChat: async () => ({
    content: null,
    toolCalls: [{ id: 'c1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }),
  streamChat: async () => ({
    content: null,
    toolCalls: [{ id: 'c1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
    chunks: 1,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }),
  identify: async () => ({ model: 'stub', identified: true }),
})

test('extract uses a custom provider', async () => {
  const provider = makeProvider('{"value": 42}')
  const result = await extract({
    systemPrompt: 's',
    document: 'd',
    parse: (raw) => JSON.parse(raw),
    provider,
  })
  assert.equal(result.parsed?.value, 42)
  assert.equal(result.raw, '{"value": 42}')
})

test('extract retries a transport failure from a custom provider', async () => {
  let calls = 0
  const provider: Provider = {
    chat: async () => {
      calls++
      if (calls === 1) throw new ChatError('first call fails')
      return '{"value": 99}'
    },
    toolChat: async () => ({ content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
    streamChat: async () => ({ content: '', toolCalls: [], chunks: 0, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
    identify: async () => ({ model: 'stub', identified: true }),
  }
  const result = await extract({
    systemPrompt: 's',
    document: 'd',
    parse: (raw) => JSON.parse(raw),
    provider,
  })
  assert.equal(result.parsed?.value, 99)
  assert.equal(calls, 2)
})

test('runAgent uses a custom provider', async () => {
  const provider = toolProvider('done', { answer: 'fixed' })
  const result = await runAgent({
    systemPrompt: 's',
    task: 't',
    workspace: '/tmp',
    tools: [{ name: 'done', description: 'finish', parameters: { type: 'object', properties: {}, required: [] }, terminal: true, execute: () => '' }],
    provider,
  })
  assert.equal(result.stop, 'done')
  assert.equal(result.answer, 'fixed')
})

test('session uses a custom provider for prose', async () => {
  const provider = makeProvider('Hello from stub')
  const session = createSession({
    systemPrompt: 's',
    workspace: '/tmp',
    tools: [],
    stream: false,
    provider,
  })
  const result = await session.send('hi')
  assert.equal(result.stop, 'answered')
  assert.equal(result.answer, 'Hello from stub')
})

test('route uses a custom provider for model fallback', async () => {
  const provider = makeProvider('{"profile": "test", "confidence": 0.9, "reason": "model"}')
  const result = await route({
    input: 'hello',
    rules: [],
    defaultProfile: 'default',
    model: { profiles: ['test', 'default'], maxTokens: 64 },
    provider,
  })
  assert.equal(result.profile, 'test')
  assert.equal(result.confidence, 0.9)
  assert.ok(result.reason.includes('model'))
})
