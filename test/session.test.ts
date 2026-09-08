/**
 * The conversation's semantics, and specifically where they INVERT the eval loop's.
 *
 * `runAgent` treats a reply with no tool call as a failure to act, because in an eval a
 * model narrating work it never did is the bug being measured. A conversation is the
 * opposite: answering a question in prose is the point. These tests pin that inversion,
 * plus the consent gate, because both are cheap to break and expensive to notice — a
 * regression shows up as a chat that badgers you, or as a write that never asked.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession, type Consent } from '../src/modes/session.ts'
import type { ToolDef } from '../src/core/tools.ts'

const tools = (log: string[] = []): ToolDef[] => [
  {
    name: 'read_file',
    description: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: () => {
      log.push('read_file')
      return 'file contents'
    },
  },
  {
    name: 'write_file',
    description: 'write',
    parameters: { type: 'object', properties: {}, required: [] },
    mutates: true,
    preview: () => '+ new line',
    execute: () => {
      log.push('write_file')
      return 'wrote 1 line'
    },
  },
  { name: 'done', description: 'finish', parameters: { type: 'object', properties: {}, required: [] }, terminal: true, execute: () => '' },
]

const callsTool = (name: string, args: Record<string, unknown> = {}) => ({
  content: null,
  toolCalls: [{ id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})
const prose = (text: string) => ({ content: text, toolCalls: [] })

/** Replays a script, and records the messages it was sent each time. */
const scripted = (replies: any[]) => {
  const seen: any[][] = []
  const state = { calls: 0 }
  const chat = async (o: any) => {
    seen.push(structuredClone(o.messages))
    return replies[Math.min(state.calls++, replies.length - 1)]
  }
  return { chat: chat as any, seen, state }
}

const make = (replies: any[], extra: Record<string, unknown> = {}) => {
  const log: string[] = []
  const { chat, seen, state } = scripted(replies)
  const session = createSession({ systemPrompt: 's', workspace: '/tmp', tools: tools(log), chat, ...extra })
  return { session, log, seen, state }
}

test('prose ends the turn as an ANSWER — the inversion vs the eval loop', async () => {
  const { session, state } = make([prose('It parses the manifest.')])
  const res = await session.send('what does pack.ts do?')
  assert.equal(res.stop, 'answered')
  assert.equal(res.answer, 'It parses the manifest.')
  assert.equal(state.calls, 1, 'a conversation must not nudge a model for answering')
})

test('a terminal tool ends the turn, not the conversation', async () => {
  const { session } = make([callsTool('done', { answer: 'fixed it' }), prose('anything else?')])
  const first = await session.send('fix the bug')
  assert.equal(first.stop, 'done')
  assert.equal(first.answer, 'fixed it')

  const second = await session.send('thanks')
  assert.equal(second.stop, 'answered', 'the session must still be usable after done')
})

test('messages persist, so a later turn still sees earlier tool results', async () => {
  const { session, seen } = make([callsTool('read_file'), prose('it holds the registry'), prose('yes')])
  await session.send('read pack.ts')
  await session.send('is it cached?')

  const last = seen.at(-1)!
  assert.equal(last[0].role, 'system')
  assert.ok(
    last.some((m: any) => m.role === 'tool' && m.content === 'file contents'),
    'the second turn lost the first turn tool result',
  )
  assert.equal(last.filter((m: any) => m.role === 'user').length, 2)
})

test('a mutating tool asks before it runs, and a refusal never executes it', async () => {
  const asked: string[] = []
  const { session, log } = make([callsTool('write_file'), prose('ok, what would you prefer?')], {
    approve: async ({ tool }: any) => {
      asked.push(tool.name)
      return 'no' as Consent
    },
  })
  const res = await session.send('rewrite it')
  assert.deepEqual(asked, ['write_file'])
  assert.deepEqual(log, [], 'a declined tool must not execute')
  assert.equal(res.stop, 'answered', 'a refusal steers the turn; it does not crash it')
})

test('the refusal reaches the model as a tool result it can act on', async () => {
  const { session, seen } = make([callsTool('write_file'), prose('understood')], {
    approve: async () => 'no' as Consent,
  })
  await session.send('rewrite it')
  const toolMsg = seen.at(-1)!.find((m: any) => m.role === 'tool')
  assert.match(toolMsg.content, /declined/)
  assert.match(toolMsg.content, /Do not retry/, 'without this a small model reissues the identical call')
})

test('interrupting AT the consent prompt stops the turn without running the tool', async () => {
  // The consent prompt is the one place a turn parks on a human rather than on the GPU, so
  // it is where ctrl-c is most likely to be pressed — and where an abort that only reaches
  // the transport does nothing at all.
  const ctl = new AbortController()
  const { session, log } = make([callsTool('write_file'), prose('unreachable')], {
    approve: async ({ signal }: any) => {
      ctl.abort()
      return signal?.aborted ? ('no' as Consent) : ('yes' as Consent)
    },
  })
  const res = await session.send('rewrite it', ctl.signal)
  assert.equal(res.stop, 'aborted')
  assert.deepEqual(log, [], 'an interrupted turn must not go on to write')
})

test('an interrupt does not let the calls queued behind it run', async () => {
  const ctl = new AbortController()
  const { session, log } = make(
    [
      {
        content: null,
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'write_file', arguments: '{}' } },
        ],
      },
      prose('unreachable'),
    ],
    {
      approve: async () => {
        ctl.abort()
        return 'yes' as Consent
      },
    },
  )
  const res = await session.send('rewrite both', ctl.signal)
  assert.equal(res.stop, 'aborted')
  assert.deepEqual(log, [], 'stopped has to mean before the next write, not after this reply')
})

test('the consent gate is handed the turn signal, so a host can stop waiting on it', async () => {
  const ctl = new AbortController()
  let seenSignal: AbortSignal | undefined
  const { session } = make([callsTool('write_file'), prose('ok')], {
    approve: async ({ signal }: any) => {
      seenSignal = signal
      return 'no' as Consent
    },
  })
  await session.send('rewrite it', ctl.signal)
  assert.equal(seenSignal, ctl.signal)
})

test('a read-only tool is never sent to the consent gate', async () => {
  let asked = 0
  const { session, log } = make([callsTool('read_file'), prose('here it is')], {
    approve: async () => {
      asked++
      return 'yes' as Consent
    },
  })
  await session.send('read it')
  assert.equal(asked, 0)
  assert.deepEqual(log, ['read_file'])
})

test('"always" stops the asking for that tool, for this session only', async () => {
  let asked = 0
  const { session, log } = make([callsTool('write_file'), callsTool('write_file'), prose('done')], {
    approve: async () => {
      asked++
      return 'always' as Consent
    },
  })
  await session.send('rewrite it')
  await session.send('and again')
  assert.equal(asked, 1, 'always must not re-prompt')
  assert.deepEqual(log, ['write_file', 'write_file'])
  assert.deepEqual([...session.alwaysAllow], ['write_file'])
})

test('the step cap is per turn, so a long conversation is not a runaway loop', async () => {
  const { session } = make([callsTool('read_file')], { maxStepsPerTurn: 3 })
  const first = await session.send('keep reading')
  assert.equal(first.stop, 'step_cap')
  assert.equal(first.steps, 3)

  const second = await session.send('again')
  assert.equal(second.steps, 3, 'the next turn starts from a fresh budget')
})

test('an unknown tool is reported to the model rather than ending the turn', async () => {
  const { session, seen } = make([callsTool('grep_files'), prose('let me try again')])
  const res = await session.send('find it')
  assert.equal(res.stop, 'answered')
  assert.deepEqual(res.toolsUsed, ['grep_files'])
  assert.match(seen.at(-1)!.find((m: any) => m.role === 'tool').content, /no tool named 'grep_files'/)
})

test('a transport failure ends the turn as an error and leaves the session usable', async () => {
  let fail = true
  const chat = async () => {
    if (fail) throw new Error('cannot reach server')
    return prose('back')
  }
  const session = createSession({ systemPrompt: 's', workspace: '/tmp', tools: tools(), chat: chat as any })
  const first = await session.send('hi')
  assert.equal(first.stop, 'error')
  assert.match(first.error!, /cannot reach server/)

  fail = false
  assert.equal((await session.send('hi again')).stop, 'answered')
})

test('reset forgets the conversation but keeps the system prompt', async () => {
  const { session, seen } = make([prose('a'), prose('b')])
  await session.send('first')
  session.reset()
  await session.send('second')
  const last = seen.at(-1)!
  assert.equal(last.length, 2)
  assert.equal(last[0].role, 'system')
  assert.equal(last[1].content, 'second')
})

test('an empty toolset is a plain conversation, not a broken loop', async () => {
  // How an extract profile gets a chat: the same session with nothing to dispatch. Every
  // turn is one model call ending in prose, and the transport is told there are no tools at
  // all — an empty `tools: []` asks a template for syntax it may not have, and the model
  // this path runs (gemma-3) has none.
  const { chat, seen, state } = scripted([prose('Blood pressure of 148/92 is stage 2 hypertension.')])
  const session = createSession({ systemPrompt: 's', workspace: '/tmp', tools: [], chat })
  const res = await session.send('what does grade B mean?')
  assert.equal(res.stop, 'answered')
  assert.equal(res.steps, 1, 'nothing to dispatch means nothing to loop over')
  assert.deepEqual(res.toolsUsed, [])
  assert.equal(state.calls, 1)
  assert.equal(seen.length, 1)
})

test('a toolless conversation still accumulates history across turns', async () => {
  const { chat, seen } = scripted([prose('a'), prose('b')])
  const session = createSession({ systemPrompt: 's', workspace: '/tmp', tools: [], chat })
  await session.send('first')
  await session.send('second')
  assert.deepEqual(
    seen.at(-1)!.map((m: any) => m.role),
    ['system', 'user', 'assistant', 'user'],
  )
})

test('remember() puts work done outside the loop into the conversation', async () => {
  // The extraction is a separate constrained request, not a tool call, and it is the thing
  // the next question is about. Without this the user discusses a document the model has
  // never seen.
  const { chat, seen } = scripted([prose('because the note only mentions arthralgia')])
  const session = createSession({ systemPrompt: 's', workspace: '/tmp', tools: [], chat })
  session.remember('here is the note: ...', 'the extraction found 3 descriptors')

  await session.send('why no arthritis?')
  const last = seen.at(-1)!
  assert.deepEqual(
    last.map((m: any) => m.role),
    ['system', 'user', 'assistant', 'user'],
  )
  assert.match(last[2].content, /3 descriptors/)
  // Never a `tool` role: nothing called a tool, and a tool message with no matching
  // tool_calls before it is rejected by the server.
  assert.ok(!last.some((m: any) => m.role === 'tool'))
})

test('remembered context is dropped by /clear along with everything else', async () => {
  const { chat, seen } = scripted([prose('ok')])
  const session = createSession({ systemPrompt: 's', workspace: '/tmp', tools: [], chat })
  session.remember('a note', 'a result')
  session.reset()
  await session.send('fresh start')
  assert.equal(seen.at(-1)!.length, 2)
})

test('a resumed conversation runs under the CURRENT system prompt, not the recorded one', async () => {
  // A prompt is code, and it gets fixed. Replaying yesterday's copy would silently run a
  // conversation against a version the repo no longer ships — and prompt bugs are the
  // failure mode this harness spends the most effort on.
  const { session, seen } = make([prose('ok')])
  session.load([
    { role: 'system', content: 'STALE PROMPT' },
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
  ])
  await session.send('follow up')

  const last = seen.at(-1)!
  assert.equal(last.filter((m: any) => m.role === 'system').length, 1)
  assert.equal(last[0].content, 's')
  assert.equal(last[1].content, 'earlier question')
  assert.equal(last.at(-1).content, 'follow up')
})

/**
 * Context accounting across a multi-step turn.
 *
 * The mistake this pins is summing. Every step re-sends the whole conversation, so each
 * step's `promptTokens` is cumulative and already contains the one before it — adding them
 * up would report a turn that used a few thousand tokens as having used tens of thousands,
 * and the header would show a comfortable conversation as nearly out of window. The last
 * measurement is the answer; the earlier ones are prefixes of it.
 */
test('a turn reports the LAST step\'s usage, never the sum of its steps', async () => {
  const { chat } = scripted([
    { ...callsTool('read_file'), usage: { promptTokens: 1000, completionTokens: 20, totalTokens: 1020 } },
    { ...prose('here it is'), usage: { promptTokens: 1400, completionTokens: 60, totalTokens: 1460 } },
  ])
  const s = createSession({ systemPrompt: 'sys', workspace: '/tmp', tools: tools(), chat })
  const res = await s.send('what is in a.ts?')
  assert.equal(res.stop, 'answered')
  assert.equal(res.usage?.totalTokens, 1460, '1020 + 1460 would double-count the shared prefix')
})

test('a turn that ends badly still reports the size it last measured', async () => {
  // The step cap is exactly when "how much room is left" gets asked, so it is the worst
  // possible moment to hand back nothing.
  const { chat } = scripted([
    { ...callsTool('read_file'), usage: { promptTokens: 900, completionTokens: 15, totalTokens: 915 } },
  ])
  const s = createSession({ systemPrompt: 'sys', workspace: '/tmp', tools: tools(), maxStepsPerTurn: 2, chat })
  const res = await s.send('loop forever')
  assert.equal(res.stop, 'step_cap')
  assert.equal(res.usage?.totalTokens, 915)
})

test('a server that reports no usage yields none, rather than a zero that reads as empty', async () => {
  const { chat } = scripted([prose('hi')])
  const s = createSession({ systemPrompt: 'sys', workspace: '/tmp', tools: [], chat })
  assert.equal((await s.send('hello')).usage, undefined)
})
