/**
 * The tool contract, and nothing else.
 *
 * Core defines what a tool IS — a name, a description, a JSON Schema, and something to
 * run — and defines no tools. A profile supplies its own set, so a coding agent and, say,
 * a data-wrangling agent share the loop without sharing a toolbox.
 *
 * `terminal` is the one flag the loop itself cares about. Small models are bad at
 * stopping, so termination is modelled as a tool call rather than as a judgement about
 * prose; marking the tool rather than matching a magic name keeps the mode from knowing
 * that this profile happens to spell it `done`.
 *
 * `mutates` is marked the same way and for the same reason. An interactive host must ask
 * before a call changes something, and it must do so without knowing that this particular
 * profile spells its writer `write_file`. Core still defines no tools and knows nothing
 * about what a preview looks like — the profile renders that.
 */
import type { ToolCall } from './client.ts'

export interface ToolDef {
  name: string
  description: string
  parameters: object
  /** The loop returns as soon as this is called; `execute` is never invoked. */
  terminal?: boolean
  /**
   * This call changes something outside the process. A batch runner may ignore the flag;
   * an interactive host must obtain consent before `execute`. The loop itself does not
   * care — only the host does.
   */
  mutates?: boolean
  /**
   * What this call is about to do, for a consent prompt. Free-form text; the host prints
   * it verbatim and never parses it. Only meaningful alongside `mutates`.
   */
  preview?(args: Record<string, any>, root: string): string
  execute(args: Record<string, any>, root: string): string
}

/** OpenAI-shaped tool list for the request body. */
export const toolSpecs = (tools: ToolDef[]) =>
  tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))

/**
 * A tool call resolved against a toolset, but NOT yet run.
 *
 * Stopping short of execution is the point: the eval loop runs `call` immediately, while
 * an interactive host has to ask the user first, and both need the same answer to "which
 * tool is this and what are its arguments". Executing here would force the consent
 * decision into core, which has no business making it.
 */
export type Dispatch =
  /** The call cannot be run. `content` goes back to the model as the tool result. */
  | { kind: 'error'; content: string }
  /** A terminal tool. The caller decides what ending the run or the turn means. */
  | { kind: 'terminal'; tool: ToolDef; args: Record<string, any> }
  | { kind: 'call'; tool: ToolDef; args: Record<string, any> }

/**
 * Both failure messages are addressed to the MODEL, not to a log. A small model recovers
 * well from "here is what exists instead" and not at all from a stack trace, so the wording
 * is part of the contract: it is what the next step reads.
 */
export const dispatchCall = (call: ToolCall, byName: Map<string, ToolDef>): Dispatch => {
  const tool = byName.get(call.function.name)
  if (!tool) {
    return {
      kind: 'error',
      content: `error: no tool named '${call.function.name}'. Available: ${[...byName.keys()].join(', ')}`,
    }
  }

  let args: Record<string, any> = {}
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
  } catch {
    return {
      kind: 'error',
      content: `error: arguments for '${call.function.name}' were not valid JSON. Send a JSON object.`,
    }
  }

  return { kind: tool.terminal ? 'terminal' : 'call', tool, args }
}
