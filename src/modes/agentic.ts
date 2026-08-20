/**
 * Agentic mode: the tool-calling loop.
 *
 * Two decisions here are specific to small models rather than inherited from how hosted
 * agents are usually written:
 *
 * 1. **Termination is a tool.** Small models are bad at *stopping* — left to their own
 *    judgement they re-read files they have already read and re-run the test they just
 *    ran until the step cap fires. Making `done` an explicit call turns "decide to stop"
 *    from a fuzzy judgement into a discrete action with a slot in the schema, and makes
 *    the loop's exit condition unambiguous instead of sniffed out of prose.
 * 2. **A step cap is a real outcome, not a safety net.** Hitting it is reported, not
 *    silently treated as success.
 * 3. **Prose is not an answer, and repeated prose is not worth paying for.** A model that
 *    has stopped calling tools has usually decided it is finished and is describing that
 *    in words — Qwen3-4B will happily emit the literal text `done\n...` instead of calling
 *    `done`. One nudge recovers it when the omission was an accident; a second identical
 *    reply means it will not be recovered, and every further round trip is a wasted
 *    inference at local speeds. So consecutive prose replies are capped separately from
 *    the step cap, and they end the loop with their own outcome.
 */
import { toolChat, type ToolCall, type Usage } from '../core/client.ts'
import { toolSpecs, dispatchCall, type ToolDef } from '../core/tools.ts'
import type { Trace } from '../core/trace.ts'

export interface AgenticOptions {
  systemPrompt: string
  task: string
  workspace: string
  /** The profile's toolset. The mode runs whatever it is given and defines none itself. */
  tools: ToolDef[]
  maxSteps?: number
  /**
   * How many CONSECUTIVE replies without a tool call to tolerate before giving up. The
   * default of 2 is "nudge once, then give up": the first prose reply earns a reminder,
   * a second in a row ends the run. Counted consecutively, so a model that answers in
   * prose, is nudged, then works normally for six more steps starts from zero again.
   */
  maxProseReplies?: number
  baseUrl?: string
  trace?: Trace
  /** Transport seam, so the loop can be tested without a server. Defaults to the real one. */
  chat?: typeof toolChat
}

export interface AgenticResult {
  answer?: string
  /** Why the loop ended. Only 'done' is success; the CLI exits nonzero for the rest. */
  stop: 'done' | 'step_cap' | 'no_tool_call' | 'error'
  steps: number
  toolsUsed: string[]
  error?: string
  /**
   * What the conversation occupied at the LAST model call. Not a sum: every step re-sends
   * the whole history, so `promptTokens` is already cumulative and adding the steps would
   * count the same context up to twelve times. `session.ts` reports it for the same reason
   * and with the same caveat — on a tool-bearing step it is a floor, because the results
   * are appended after the call that measured it.
   */
  usage?: Usage
  /**
   * `promptTokens` at every step, oldest first. The SHAPE of context growth, which the
   * final figure alone cannot show: a run that climbs steadily is doing new work, and one
   * that climbs in a sawtooth is re-reading what it already read. This is the measurement
   * the whole loop is being judged on when the question is whether a 32k window is the
   * binding constraint, so it is returned rather than left in the trace.
   */
  contextTrail: number[]
}

export const runAgent = async (o: AgenticOptions): Promise<AgenticResult> => {
  const maxSteps = o.maxSteps ?? 12
  const maxProseReplies = o.maxProseReplies ?? 2
  const chat = o.chat ?? toolChat
  const byName = new Map(o.tools.map((t) => [t.name, t]))
  const specs = toolSpecs(o.tools)
  const terminalName = o.tools.find((t) => t.terminal)?.name
  const messages: any[] = [
    { role: 'system', content: o.systemPrompt },
    { role: 'user', content: o.task },
  ]
  const toolsUsed: string[] = []
  const contextTrail: number[] = []
  let usage: Usage | undefined
  let proseReplies = 0

  for (let step = 0; step < maxSteps; step++) {
    let reply: { content: string | null; toolCalls: ToolCall[]; usage?: Usage }
    try {
      reply = await chat({ messages, tools: specs, baseUrl: o.baseUrl, label: `step-${step}` })
    } catch (e) {
      return { stop: 'error', steps: step, toolsUsed, error: (e as Error).message, usage, contextTrail }
    }
    usage = reply.usage ?? usage
    if (reply.usage) contextTrail.push(reply.usage.promptTokens)

    o.trace?.write({
      step,
      content: reply.content,
      toolCalls: reply.toolCalls,
      promptTokens: reply.usage?.promptTokens,
      cachedTokens: reply.usage?.cachedTokens,
    })

    if (!reply.toolCalls.length) {
      // No tool call. Prose is never accepted as an answer — that would let the model
      // "finish" without ever having acted — so nudge, and stop once nudging has visibly
      // failed rather than repeating it until the step cap.
      messages.push({ role: 'assistant', content: reply.content ?? '' })
      proseReplies += 1

      if (proseReplies >= maxProseReplies || step === maxSteps - 1) {
        // Report what it said instead of acting: when a model narrates a completed task
        // it never performed, that excerpt is the whole diagnosis.
        const said = (reply.content ?? '').trim().replace(/\s+/g, ' ')
        return {
          stop: 'no_tool_call',
          steps: step + 1,
          toolsUsed,
          usage,
          contextTrail,
          error:
            `stopped after ${proseReplies} consecutive replies with no tool call` +
            (terminalName ? ` (it never called ${terminalName})` : '') +
            (said ? `; last said: ${said.slice(0, 200)}${said.length > 200 ? '…' : ''}` : ''),
        }
      }

      messages.push({
        role: 'user',
        content: terminalName
          ? `Reply with a tool call. If the task is complete, call ${terminalName} with your answer.`
          : 'Reply with a tool call.',
      })
      continue
    }

    proseReplies = 0
    messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: reply.toolCalls })

    for (const call of reply.toolCalls) {
      // Recorded before the tool is resolved: an invented tool is still something the
      // model reached for, and the eval grades that.
      toolsUsed.push(call.function.name)

      const d = dispatchCall(call, byName)
      if (d.kind === 'error') {
        messages.push({ role: 'tool', tool_call_id: call.id, content: d.content })
        continue
      }
      if (d.kind === 'terminal') {
        return { answer: String(d.args.answer ?? ''), stop: 'done', steps: step + 1, toolsUsed, usage, contextTrail }
      }

      // A batch run consents to everything by starting: `mutates` is a signal for an
      // interactive host, and this loop deliberately does not consult it.
      const result = d.tool.execute(d.args, o.workspace)
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      // Size, not content: the trail above says the context grew, and this says which
      // result grew it. A run that dies of context is diagnosed by the pair.
      o.trace?.write({ turn: 'tool', step, name: d.tool.name, args: d.args, chars: result.length })
    }
  }

  return { stop: 'step_cap', steps: maxSteps, toolsUsed, usage, contextTrail }
}
