/**
 * The verifier profile's input contract, pinned the way `test/package.test.ts` pins the
 * public API.
 *
 * The verifier is a checkpoint in the pipeline: it takes `{document, extraction}`, never
 * anything narrower. These tests exist because the pipeline USED to hand it a narrower
 * object — the extraction step's report — and the result was a 0.0s "step failed" in the
 * web UI (no `document`) or a model round-trip against the literal string "undefined"
 * (no `extraction`). Both failure modes are refused loudly here, and the refusal is
 * asserted to reach the model never.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loadPack } from '../src/core/pack.ts'
import type { ReviewContext, ReviewResult } from '../src/core/profile.ts'
import type { Provider } from '../src/core/client.ts'

const verifier = (await import('../src/profiles/verifier/profile.ts')).PROFILE

// The in-tree verifier pack is part of this checkout, so the success path can be run
// without a server: a stub provider stands in for llama-server.
const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'verifier'))

const review = (o: { ctx: ReviewContext; provider?: Provider }): Promise<ReviewResult> =>
  verifier.review!({ ...o.ctx, provider: o.provider })

const neverCalledProvider: Provider = {
  chat: async () => {
    throw new Error('the model must not be called when the verifier input is invalid')
  },
  toolChat: async () => {
    throw new Error('toolChat must not be called')
  },
  streamChat: async () => {
    throw new Error('streamChat must not be called')
  },
  identify: async () => {
    throw new Error('identify must not be called')
  },
}

const base = (text: string): ReviewContext => ({
  pack, // unused by the refusing paths, but a faithful contract still carries it
  baseUrl: undefined,
  trace: { write: () => {}, close: () => {} } as never,
  input: { kind: 'text', text, label: 'verify-input' },
  options: {},
})

test('verifier refuses input with no document field without calling a model', async () => {
  const result = await review({
    ctx: base(JSON.stringify({ extraction: { bp: { value: '120/80', quote: 'BP 120/80' } } })),
    provider: neverCalledProvider,
  })
  assert.equal(result.ok, false)
  assert.match(result.text, /document/)
})

test('verifier refuses input with no extraction field without calling a model', async () => {
  const result = await review({
    ctx: base(JSON.stringify({ document: 'Patient BP 120/80.' })),
    provider: neverCalledProvider,
  })
  assert.equal(result.ok, false)
  assert.match(result.text, /extraction/)
})

test('verifier refuses a null extraction without calling a model', async () => {
  const result = await review({
    ctx: base(JSON.stringify({ document: 'Patient BP 120/80.', extraction: null })),
    provider: neverCalledProvider,
  })
  assert.equal(result.ok, false)
  assert.match(result.text, /extraction/)
})

test('verifier runs the model when both document and extraction are present', async () => {
  let calls = 0
  const stubProvider: Provider = {
    chat: async (o) => {
      calls++
      assert.ok(o.userPrompt.includes('Patient BP 120/80'), 'the document reaches the prompt')
      assert.ok(o.userPrompt.includes('bp'), 'the extraction reaches the prompt')
      return JSON.stringify({ verified: true, confidence: 1.0, issues: [] })
    },
    toolChat: async () => ({ content: null, toolCalls: [] }),
    streamChat: async () => ({ content: '', toolCalls: [], chunks: 0 }),
    identify: async () => ({ model: 'stub', identified: true, warning: undefined }),
  }

  const result = await review({
    ctx: base(
      JSON.stringify({
        document: 'Patient BP 120/80.',
        extraction: { bp: { value: '120/80', quote: 'BP 120/80' } },
      }),
    ),
    provider: stubProvider,
  })

  assert.equal(calls, 1)
  assert.equal(result.ok, true)
  assert.deepEqual(result.report, { verified: true, confidence: 1.0, issues: [] })
})

test('verifier decodes a constrained JSON completion passed by a pipeline', async () => {
  let calls = 0
  const stubProvider: Provider = {
    chat: async (o) => {
      calls++
      assert.ok(o.userPrompt.includes('"bp": "120/80"'), 'decoded extraction reaches the prompt as an object')
      return JSON.stringify({ verified: true, confidence: 1.0, issues: [] })
    },
    toolChat: async () => ({ content: null, toolCalls: [] }),
    streamChat: async () => ({ content: '', toolCalls: [], chunks: 0 }),
    identify: async () => ({ model: 'stub', identified: true, warning: undefined }),
  }

  const result = await review({
    ctx: base(JSON.stringify({ document: 'Patient BP 120/80.', extraction: '{"bp":"120/80"}' })),
    provider: stubProvider,
  })
  assert.equal(result.ok, true)
  assert.equal(calls, 1)
})

test('verifier refuses a plain-text extraction without calling a model', async () => {
  const result = await review({
    ctx: base(JSON.stringify({ document: 'Patient BP 120/80.', extraction: 'not JSON' })),
    provider: neverCalledProvider,
  })
  assert.equal(result.ok, false)
  assert.match(result.text, /JSON object/)
})
