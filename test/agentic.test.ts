/**
 * The agentic loop's exit conditions.
 *
 * The loop was the one part of the harness with no test, which is how it shipped with an
 * unreachable `no_tool_call` outcome: the code nudged a silent model until the step cap
 * while its own comment claimed it gave up after one nudge. Every branch of "why did this
 * run end" is pinned here, because each one costs real inference time to discover live.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAgent } from '../src/modes/agentic.ts'
import type { ToolDef } from '../src/core/tools.ts'

const noop = (): ToolDef[] => {
  const calls: string[] = []
  return [
    {
      name: 'read_file',
      description: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: () => {
        calls.push('read_file')
        return 'file contents'
      },
    },
    { name: 'done', description: 'finish', parameters: { type: 'object', properties: {}, required: [] }, terminal: true, execute: () => '' },
  ]
}

/** A canned reply with one tool call. */
const callsTool = (name: string, args: Record<string, unknown> = {}) => ({
  content: null,
  toolCalls: [{ id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})

/** A canned reply that answers in prose instead of acting. */
const prose = (text: string) => ({ content: text, toolCalls: [] })

/** Replays a fixed script of replies and records how many times it was asked. */
const scripted = (replies: any[]) => {
  const state = { calls: 0 }
  const chat = async () => {
    const r = replies[Math.min(state.calls, replies.length - 1)]
    state.calls += 1
    return r
  }
  return { chat: chat as any, state }
}

const run = (replies: any[], extra: Record<string, unknown> = {}) => {
  const { chat, state } = scripted(replies)
  return runAgent({ systemPrompt: 's', task: 't', workspace: '/tmp', tools: noop(), chat, ...extra }).then((res) => ({
    res,
    state,
  }))
}

test('a terminal tool call ends the run as done, carrying its answer', async () => {
  const { res } = await run([callsTool('read_file'), callsTool('done', { answer: 'fixed it' })])
  assert.equal(res.stop, 'done')
  assert.equal(res.answer, 'fixed it')
  assert.equal(res.steps, 2)
  assert.deepEqual(res.toolsUsed, ['read_file', 'done'])
})

test('two consecutive prose replies end the run instead of nudging to the step cap', async () => {
  // The bug this file exists for: the loop used to spend every remaining step re-nudging
  // a model that had already decided it was finished.
  const { res, state } = await run([prose('done\nThe bug has been fixed.')], { maxSteps: 12 })
  assert.equal(res.stop, 'no_tool_call')
  assert.equal(res.steps, 2, 'one reply, one nudged retry')
  assert.equal(state.calls, 2, 'must not keep paying for inference after the nudge failed')
})

test('the give-up diagnosis quotes what the model said instead of acting', async () => {
  const { res } = await run([prose('done\nThe bug in add() has been fixed.')])
  assert.match(res.error!, /no tool call/)
  assert.match(res.error!, /never called done/)
  assert.match(res.error!, /The bug in add\(\) has been fixed\./)
})

test('one prose reply is nudged, and a run that recovers still succeeds', async () => {
  const { res } = await run([prose('I think it is fine.'), callsTool('done', { answer: 'ok' })])
  assert.equal(res.stop, 'done')
  assert.equal(res.answer, 'ok')
})

test('the prose count is consecutive, so an isolated lapse never accumulates', async () => {
  const { res } = await run([
    prose('thinking...'),
    callsTool('read_file'),
    prose('thinking again...'),
    callsTool('read_file'),
    callsTool('done', { answer: 'ok' }),
  ])
  assert.equal(res.stop, 'done', 'two non-adjacent prose replies must not trip the cap')
})

test('a model that keeps calling tools hits the step cap, which is a failure', async () => {
  const { res } = await run([callsTool('read_file')], { maxSteps: 4 })
  assert.equal(res.stop, 'step_cap')
  assert.equal(res.steps, 4)
})

test('an invented tool is reported back to the model rather than ending the run', async () => {
  const { res } = await run([callsTool('grep_files'), callsTool('done', { answer: 'ok' })])
  assert.equal(res.stop, 'done')
  assert.deepEqual(res.toolsUsed, ['grep_files', 'done'])
})

test('a transport failure ends the run as an error, not as a step cap', async () => {
  const chat = async () => {
    throw new Error('cannot reach llama-server')
  }
  const res = await runAgent({ systemPrompt: 's', task: 't', workspace: '/tmp', tools: noop(), chat: chat as any })
  assert.equal(res.stop, 'error')
  assert.match(res.error!, /cannot reach llama-server/)
})

test('maxProseReplies of 1 gives up immediately, without a nudge', async () => {
  const { res, state } = await run([prose('all done')], { maxProseReplies: 1 })
  assert.equal(res.stop, 'no_tool_call')
  assert.equal(state.calls, 1)
})
