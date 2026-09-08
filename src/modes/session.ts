/**
 * A multi-turn conversation over the agentic loop.
 *
 * This is NOT `runAgent` with a longer lifetime. Four things are deliberately inverted,
 * and the first is the one that matters:
 *
 * 1. **Prose is an ANSWER here, not a failure.** `runAgent` nudges a model that replies
 *    without calling a tool, and gives up if it does it twice, because in an eval a model
 *    narrating work it never performed is exactly the bug being measured. In a
 *    conversation, "what does this file do?" answered in prose is the correct outcome.
 *    Carrying that nudge into chat would mean badgering the model for a tool call every
 *    time you asked it a question.
 * 2. **A terminal tool ends the TURN, not the run.** The conversation continues, with
 *    every tool result still in context.
 * 3. **Messages persist**, so turn two can refer to what turn one read.
 * 4. **The step cap is per turn**, since a long conversation is not a runaway loop.
 *
 * And one addition with no counterpart in the eval: a `mutates` tool asks for consent
 * before it runs. That suspends the loop mid-turn, which is why `approve` is async — it
 * keeps the loop linear rather than turning it into a state machine the host has to drive.
 *
 * **An empty toolset is a legitimate session, and it is a plain conversation.** The loop
 * degenerates to exactly one model call per turn, always ending `answered`, because prose
 * with nothing to dispatch is the only outcome reachable. That is how a profile with no
 * tools gets a chat: the same message history, streaming, interrupt
 * and transcript, with the branches it cannot reach simply never taken. A second
 * "conversation without tools" loop would be the same code with the interesting half
 * deleted, and would drift from this one the first time streaming or aborting changed.
 */
import { toolChat, streamChat, type Provider, type ToolCall, type Usage } from '../core/client.ts'
import { toolSpecs, dispatchCall, type ToolDef } from '../core/tools.ts'
import type { Trace } from '../core/trace.ts'

/** What the host decided about one consent prompt. `always` lasts for this session only. */
export type Consent = 'yes' | 'no' | 'always'

export interface SessionOptions {
  systemPrompt: string
  workspace: string
  tools: ToolDef[]
  /** Steps allowed within a single turn. A conversation is not bounded by this. */
  maxStepsPerTurn?: number
  baseUrl?: string
  trace?: Trace
  /** Stream tokens. Falls back to a single blocking request when false. */
  stream?: boolean
  /**
   * Asked before any tool marked `mutates` runs. Omit to auto-approve everything, which is
   * what a non-interactive caller wants. The turn's signal is passed through so a host that
   * blocks on a human can stop blocking when the turn is interrupted.
   */
  approve?(call: { tool: ToolDef; args: Record<string, any>; signal?: AbortSignal }): Promise<Consent>
  onToken?(text: string): void
  onReasoning?(text: string): void
  onToolCall?(name: string, args: Record<string, any>): void
  onToolResult?(name: string, result: string): void
  /** Transport seam, so a session can be tested without a server — as `runAgent` has. */
  chat?: typeof toolChat
  /** A custom LLM provider; defaults to the built-in HTTP client. */
  provider?: Provider
}

export interface TurnResult {
  /** What to show the user. Prose, or a terminal tool's answer. */
  answer?: string
  /**
   * Why the turn ended. 'answered' is prose, 'done' is a terminal tool call — both are
   * success. The rest are not.
   */
  stop: 'answered' | 'done' | 'step_cap' | 'aborted' | 'error'
  steps: number
  toolsUsed: string[]
  error?: string
  /**
   * What the conversation occupies now, from the LAST model call of the turn.
   *
   * The last one and not a sum: every step re-sends the whole history, so adding the steps
   * together would count the same context up to twelve times and report a conversation as
   * overflowing a window it comfortably fits in. Each call's `promptTokens` is already
   * cumulative; the final one is therefore the answer, and the earlier ones are prefixes
   * of it.
   *
   * Undefined when no call completed — an error on the first step, or an abort, neither of
   * which learned anything new about the size of the conversation.
   */
  usage?: Usage
}

export interface Session {
  send(text: string, signal?: AbortSignal): Promise<TurnResult>
  /** The live conversation, including tool messages. Inspected by the host, not mutated. */
  readonly messages: unknown[]
  /** Forget everything but the system prompt. */
  reset(): void
  /**
   * Adopt a saved conversation. The system prompt is taken from THIS session rather than
   * from the transcript: a resumed conversation should run under the prompt the code ships
   * today, not the one that happened to be current when it was recorded.
   */
  load(saved: unknown[]): void
  /**
   * Put work done OUTSIDE the loop into the conversation, as the exchange it would have
   * been if a tool had done it.
   *
   * A constrained extraction is the case this exists for: it is a separate
   * constrained request, not a tool call, and its result is the single most likely thing
   * the next question is about ("why was arthritis missed?"). Without this the user would
   * be discussing a document the model cannot see. It is recorded as user-then-assistant
   * rather than as a tool message because there is no tool call for a result to answer,
   * and a `tool` role with no matching `tool_calls` is rejected by the server.
   */
  remember(user: string, assistant: string): void
  /** Tools the user chose to stop being asked about. In memory, never persisted. */
  readonly alwaysAllow: ReadonlySet<string>
}

export const createSession = (o: SessionOptions): Session => {
  const maxSteps = o.maxStepsPerTurn ?? 12
  const byName = new Map(o.tools.map((t) => [t.name, t]))
  const specs = toolSpecs(o.tools)
  const alwaysAllow = new Set<string>()
  let messages: any[] = [{ role: 'system', content: o.systemPrompt }]

  /** One model call, streaming or not, normalised to the same shape either way. */
  const ask = async (signal?: AbortSignal) => {
    if (o.chat || o.stream === false) {
      const chat = o.provider?.toolChat ?? o.chat ?? toolChat
      const r = await chat({ messages, tools: specs, baseUrl: o.baseUrl, label: 'chat' })
      return { ...r, aborted: false }
    }
    const stream = o.provider?.streamChat ?? streamChat
    return stream({
      messages,
      tools: specs,
      baseUrl: o.baseUrl,
      label: 'chat',
      signal,
      onToken: o.onToken,
      onReasoning: o.onReasoning,
    })
  }

  const send = async (text: string, signal?: AbortSignal): Promise<TurnResult> => {
    messages.push({ role: 'user', content: text })
    const toolsUsed: string[] = []

    /**
     * The newest measurement of the conversation's size, carried across steps so that every
     * exit below reports one — including the ones that end BADLY. A turn that hit the step
     * cap is precisely when the user wants to know how much window is left, and returning
     * nothing there would blank the readout at the moment it matters most.
     *
     * On a tool-bearing step it is a floor rather than an exact figure: the tool results are
     * appended after the call that measured it, so the true occupancy is this plus results
     * the next request will be the first to count.
     */
    let usage: Usage | undefined

    for (let step = 0; step < maxSteps; step++) {
      let reply: { content: string | null; toolCalls: ToolCall[]; usage?: Usage; aborted?: boolean }
      try {
        reply = await ask(signal)
      } catch (e) {
        return { stop: 'error', steps: step, toolsUsed, error: (e as Error).message, usage }
      }
      usage = reply.usage ?? usage

      o.trace?.write({ turn: 'assistant', step, content: reply.content, toolCalls: reply.toolCalls })

      if (reply.aborted) {
        // Keep the partial reply in context. Dropping it would leave the conversation
        // claiming the model never spoke, which is not what the user just watched.
        if (reply.content) messages.push({ role: 'assistant', content: reply.content })
        return { answer: reply.content ?? undefined, stop: 'aborted', steps: step + 1, toolsUsed, usage }
      }

      if (!reply.toolCalls.length) {
        // The inversion. In an eval this is a failure to act; in a conversation it is the
        // model answering, which is the whole point of asking.
        messages.push({ role: 'assistant', content: reply.content ?? '' })
        return { answer: reply.content ?? '', stop: 'answered', steps: step + 1, toolsUsed, usage }
      }

      messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: reply.toolCalls })

      for (const call of reply.toolCalls) {
        // Checked per call, not just per step. A reply can carry several calls, and a turn
        // interrupted at a consent prompt must not go on to run the ones behind it — the
        // user stopped the turn, and "stopped" has to mean before the next write.
        if (signal?.aborted) return { stop: 'aborted', steps: step + 1, toolsUsed, usage }

        toolsUsed.push(call.function.name)
        const d = dispatchCall(call, byName)

        if (d.kind === 'error') {
          messages.push({ role: 'tool', tool_call_id: call.id, content: d.content })
          continue
        }
        if (d.kind === 'terminal') {
          const answer = String(d.args.answer ?? '')
          messages.push({ role: 'tool', tool_call_id: call.id, content: answer })
          return { answer, stop: 'done', steps: step + 1, toolsUsed, usage }
        }

        o.onToolCall?.(d.tool.name, d.args)

        if (d.tool.mutates && o.approve && !alwaysAllow.has(d.tool.name)) {
          const verdict = await o.approve({ tool: d.tool, args: d.args, signal })
          // The prompt itself can be interrupted — it is the one place a turn parks
          // indefinitely, waiting on a human rather than on the GPU, so it is exactly where
          // ctrl-c has to land. An abort is a refusal: nothing runs.
          if (signal?.aborted) return { stop: 'aborted', steps: step + 1, toolsUsed, usage }
          if (verdict === 'always') alwaysAllow.add(d.tool.name)
          if (verdict === 'no') {
            // A refusal is a tool RESULT, not an exception. The model gets to see it and
            // ask what to do instead; throwing would end a turn the user only wanted to
            // steer. The instruction not to retry matters — a small model will otherwise
            // reissue the identical call and burn the step cap on it.
            const content = `error: the user declined to run '${d.tool.name}'. Do not retry it; ask what to do instead.`
            messages.push({ role: 'tool', tool_call_id: call.id, content })
            o.onToolResult?.(d.tool.name, content)
            o.trace?.write({ turn: 'tool', name: d.tool.name, declined: true })
            continue
          }
        }

        const result = d.tool.execute(d.args, o.workspace)
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })
        o.onToolResult?.(d.tool.name, result)
        o.trace?.write({ turn: 'tool', name: d.tool.name, args: d.args, result })
      }
    }

    return { stop: 'step_cap', steps: maxSteps, toolsUsed, usage }
  }

  return {
    send,
    get messages() {
      return messages
    },
    reset() {
      messages = [{ role: 'system', content: o.systemPrompt }]
    },
    load(saved) {
      messages = [{ role: 'system', content: o.systemPrompt }, ...(saved as any[]).filter((m) => m?.role !== 'system')]
    },
    remember(user, assistant) {
      messages.push({ role: 'user', content: user }, { role: 'assistant', content: assistant })
    },
    get alwaysAllow() {
      return alwaysAllow
    },
  }
}
