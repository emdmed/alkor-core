/**
 * The coding profile: mode `agentic`, six tools, its own model, no contract pack.
 *
 * It needs a different model from any extraction profile on purpose. gemma-3-4b has no
 * tool support in its chat template — asked to use tools it emits Gemma's own
 * ```tool_code fence, which llama-server does not parse into `tool_calls`, so the loop
 * sees nothing. Qwen3 carries a tool-calling template llama.cpp understands. Per-profile
 * model and server config is what makes that a setting rather than a fork.
 */
import type { EvalContext, EvalVerdict, ProfileModule } from '../../core/profile.ts'
import { runToolSelectionEval } from './eval.ts'
import { TOOLS } from './tools.ts'

export const CODING_MODEL = {
  /** Suggested GGUF; the server is started separately and serves whatever it was given. */
  gguf: 'Qwen3-4B-Q4_K_M.gguf',
  /** Must be started with --jinja, or the tools field is ignored and you get prose. */
  requiresJinja: true,
}

/**
 * Short and imperative. A long prompt does not make a 4B follow more rules; it dilutes the
 * few that matter and eats the context the tool results need. The rules chosen here are
 * the ones the tools cannot enforce for themselves.
 */
export const CODING_SYSTEM_PROMPT = `You are a coding assistant working in a code repository.

Use the tools to inspect and change files. Rules:
- If you are given a file path, call read_file on it directly. Do not list the directory first.
- Use list_files or search only when you do NOT know where something is.
- Read a file before you change it.
- One tool call at a time. Wait for the result before deciding what to do next.
- If read_file says a file is not found, then use list_files to see what exists.
- When the task is already complete and nothing needs checking, call done immediately with your answer. Always finish by calling done.`

/**
 * The interactive variant. The eval prompt above is written for one task run to
 * completion — "always finish by calling done", everything framed as "the task" — and a 4B
 * follows that literally, calling done after answering a question the user was about to
 * follow up on. Here `done` ends a TURN, and a plain answer is a legitimate way to end one,
 * so both are spelled out. The rules that survive are the ones the tools cannot enforce
 * for themselves, unchanged.
 */
export const CODING_CHAT_PROMPT = `You are a coding assistant working in a code repository, talking with a developer.

Use the tools to inspect and change files. Rules:
- If you are given a file path, call read_file on it directly. Do not list the directory first.
- Use list_files or search only when you do NOT know where something is.
- Read a file before you change it.
- One tool call at a time. Wait for the result before deciding what to do next.
- If read_file says a file is not found, then use list_files to see what exists.
- If a question can be answered without touching the repository, just answer it in plain text.
- Call done when you have finished acting and want to report back. Answering in plain text is also fine.
- The conversation continues after you answer, so do not summarise everything you have ever done.
- If the user declines a tool call, do not retry it. Ask what they would prefer.`

export const CODING_MAX_ITERATIONS = 12

export const PROFILE: ProfileModule = {
  name: 'coding',
  mode: 'agentic',
  needsPack: false,
  systemPrompt: CODING_SYSTEM_PROMPT,
  chatSystemPrompt: CODING_CHAT_PROMPT,
  tools: TOOLS,
  maxIterations: CODING_MAX_ITERATIONS,
  topology: {
    stages: [
      { name: 'llm-call', repeatable: true },
      {
        name: 'tool-call',
        kind: 'decision',
        repeatable: true,
        routes: TOOLS.map((tool) => ({ name: tool.name })),
      },
    ],
  },
  async runEval(ctx: EvalContext): Promise<EvalVerdict> {
    const r = await runToolSelectionEval({ baseUrl: ctx.baseUrl, trace: ctx.trace })
    // Tool selection is the gate: argument accuracy is meaningless on a call that picked
    // the wrong tool, and a loop cannot recover from a tool it never reaches for.
    return {
      pass: r.correctTool === r.total,
      summary: `correct tool ${r.correctTool}/${r.total}, valid call ${r.valid}/${r.total}, correct args ${r.correctArgs}/${r.argsChecked}`,
    }
  },
}
