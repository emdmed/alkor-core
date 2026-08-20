/**
 * The SSE reader.
 *
 * Tested through `streamChat` with a stubbed fetch rather than by exporting the parser,
 * because the two things that actually break are boundary conditions of the TRANSPORT, not
 * of the parse: a read that ends mid-frame, and a tool call whose arguments arrive in
 * pieces across several frames. A unit test of a parser handed whole frames would pass
 * while both were broken.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamChat, LlamaError } from '../src/core/client.ts'

/** The stubbed transport for the test currently running. */
let fetchImpl: any

/** Serves `chunks` as the response body, split exactly where the test says. */
const serve = (chunks: string[], init: { status?: number; body?: boolean } = {}) => {
  fetchImpl = (async () => {
    if (init.status && init.status !== 200) {
      return new Response('boom', { status: init.status })
    }
    const stream = new ReadableStream({
      start(ctl) {
        const enc = new TextEncoder()
        for (const c of chunks) ctl.enqueue(enc.encode(c))
        ctl.close()
      },
    })
    return new Response(stream, { status: 200 })
  }) as any
}

const frame = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`

const call = () => streamChat({ messages: [], tools: [], label: 'test', fetchImpl })

test('content deltas accumulate and are reported as they arrive', async () => {
  const seen: string[] = []
  serve([frame({ content: 'Hello' }), frame({ content: ' world' }), 'data: [DONE]\n\n'])
  const res = await streamChat({ messages: [], tools: [], label: 'test', fetchImpl, onToken: (t) => seen.push(t) })
  assert.equal(res.content, 'Hello world')
  assert.deepEqual(seen, ['Hello', ' world'])
  assert.equal(res.chunks, 2)
})

test('a read that ends mid-frame is buffered, not dropped', async () => {
  // The single most likely real-world failure: chunk boundaries have nothing to do with
  // frame boundaries.
  const whole = frame({ content: 'abc' })
  serve([whole.slice(0, 12), whole.slice(12), 'data: [DONE]\n\n'])
  assert.equal((await call()).content, 'abc')
})

test('tool call arguments reassemble across frames', async () => {
  serve([
    frame({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] }),
    frame({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"' } }] }),
    frame({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }),
    'data: [DONE]\n\n',
  ])
  const res = await call()
  assert.equal(res.toolCalls.length, 1)
  assert.equal(res.toolCalls[0].function.name, 'read_file')
  assert.deepEqual(JSON.parse(res.toolCalls[0].function.arguments), { path: 'a.ts' })
  assert.equal(res.toolCalls[0].id, 'c1')
})

test('parallel tool calls stay separate and keep their index order', async () => {
  serve([
    frame({ tool_calls: [{ index: 1, function: { name: 'search', arguments: '{}' } }] }),
    frame({ tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{}' } }] }),
    'data: [DONE]\n\n',
  ])
  const res = await call()
  assert.deepEqual(
    res.toolCalls.map((t) => t.function.name),
    ['read_file', 'search'],
  )
})

test('a streamed call with no id still gets one, since the tool result must cite it', async () => {
  serve([frame({ tool_calls: [{ index: 0, function: { name: 'done', arguments: '{}' } }] }), 'data: [DONE]\n\n'])
  assert.ok((await call()).toolCalls[0].id)
})

test('reasoning is separated from content rather than mixed into it', async () => {
  const think: string[] = []
  serve([frame({ reasoning_content: 'hmm' }), frame({ content: 'answer' }), 'data: [DONE]\n\n'])
  const res = await streamChat({ messages: [], tools: [], label: 'test', fetchImpl, onReasoning: (t) => think.push(t) })
  assert.equal(res.content, 'answer')
  assert.equal(res.reasoning, 'hmm')
  assert.deepEqual(think, ['hmm'])
})

test('a malformed frame is skipped rather than discarding the whole reply', async () => {
  serve([frame({ content: 'a' }), 'data: {not json\n\n', frame({ content: 'b' }), 'data: [DONE]\n\n'])
  assert.equal((await call()).content, 'ab')
})

test('an error frame surfaces the server diagnosis verbatim', async () => {
  serve([`data: ${JSON.stringify({ error: { message: 'context overflow' } })}\n\n`])
  await assert.rejects(call(), (e: Error) => e instanceof LlamaError && /context overflow/.test(e.message))
})

test('a non-2xx names the endpoint and carries the body, as the blocking path does', async () => {
  serve([], { status: 503 })
  await assert.rejects(call(), (e: Error) => e instanceof LlamaError && /503/.test(e.message))
})

test('an aborted stream returns what arrived instead of throwing', async () => {
  const ctl = new AbortController()
  fetchImpl = (async () => {
    const enc = new TextEncoder()
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(frame({ content: 'partial' })))
          // Never closes: the abort is the only way out, which is the real shape of a
          // user hitting ctrl-c halfway through a slow local generation.
        },
      }),
      { status: 200 },
    )
  }) as any

  const p = streamChat({ messages: [], tools: [], label: 'test', fetchImpl, signal: ctl.signal, onToken: () => ctl.abort() })
  const res = await p
  assert.equal(res.aborted, true)
  assert.equal(res.content, 'partial')
})

/**
 * An empty toolset must not put a `tools` field on the wire.
 *
 * `tools: []` is not the same request as no tools at all: llama-server takes the field's
 * presence as a request to apply the template's tool syntax, and the model an extract
 * profile chats with (gemma-3) has none — which is a template error, not a wasted section
 * of prompt. This is the difference between a toolless conversation working and not, and it
 * is invisible from the response, so it is asserted on the body.
 */
const bodyOf = async (tools: unknown[]): Promise<any> => {
  let sent: any
  const impl = (async (_url: string, init: any) => {
    sent = JSON.parse(init.body)
    return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 })
  }) as any
  await streamChat({ messages: [{ role: 'user', content: 'hi' }], tools, label: 'test', fetchImpl: impl })
  return sent
}

test('a toolless conversation sends no tools field at all', async () => {
  const body = await bodyOf([])
  assert.ok(!('tools' in body), 'an empty tools array asks a template for syntax it may not have')
  assert.ok(!('tool_choice' in body))
})

test('a toolset is still sent, with tool_choice, exactly as before', async () => {
  const spec = { type: 'function', function: { name: 'read_file', description: 'read', parameters: {} } }
  const body = await bodyOf([spec])
  assert.deepEqual(body.tools, [spec])
  assert.equal(body.tool_choice, 'auto')
})

/**
 * Usage, which the header's context readout is built on.
 *
 * The usage frame is the ONE frame with an empty `choices` array, so it is reachable only by
 * a reader that looks at `usage` before it gives up on the delta. That ordering is a single
 * line and reverting it fails nothing else — the reply still arrives, the counts just
 * silently never do, and the readout stays blank in a way that looks like "not measured yet".
 */
test('the usage frame is read even though it carries no delta', async () => {
  serve([
    frame({ content: 'hi' }),
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 1021, completion_tokens: 88, total_tokens: 1109, prompt_tokens_details: { cached_tokens: 1013 } },
    })}\n\n`,
    'data: [DONE]\n\n',
  ])
  const res = await call()
  assert.equal(res.content, 'hi', 'the empty-choices frame must not disturb the reply')
  assert.deepEqual(res.usage, { promptTokens: 1021, completionTokens: 88, totalTokens: 1109, cachedTokens: 1013 })
  assert.equal(res.chunks, 1, 'the usage frame is not a content chunk and must not inflate the rate')
})

test('a stream that ends without a usage frame reports none rather than zero', async () => {
  // What an INTERRUPTED turn looks like. Zero would read as "the conversation is empty",
  // which is the opposite of true — the partial reply is still in the context.
  serve([frame({ content: 'partial' }), 'data: [DONE]\n\n'])
  assert.equal((await call()).usage, undefined)
})

test('usage is asked for explicitly, since a stream carries none by default', async () => {
  const body = await bodyOf([])
  assert.deepEqual(body.stream_options, { include_usage: true })
})
