/**
 * A minimal agentic profile, for the server tests that exercise SESSIONS rather than any
 * particular domain: one terminal tool, no pack, no model of its own.
 *
 * It exists because those tests need a profile in `agentic` mode and this project has no
 * built-in one — the coding agent that used to serve the purpose was a software-engineering
 * worked example in a medical harness, and went. What the tests are actually about is the
 * session loop (create, send, tool call, delete), which needs a toolset and a prompt and
 * nothing else. Keeping that here rather than in a real profile means no domain profile has
 * to carry a tool it does not want in order to keep the transport tested.
 */
export const PROFILE = {
  name: 'assistant',
  mode: 'agentic',
  needsPack: false,
  systemPrompt: 'You are a test assistant. Call done when you have an answer.',
  chatSystemPrompt: 'You are a test assistant, talking with a user. Call done when you have an answer.',
  maxIterations: 4,
  tools: [
    {
      name: 'done',
      description: 'Call this when the task is complete, with your answer.',
      parameters: {
        type: 'object',
        properties: { answer: { type: 'string', description: 'Your final answer.' } },
        required: ['answer'],
      },
      // The loop intercepts a terminal tool and never calls execute; the flag is how it knows.
      terminal: true,
      execute({ answer }) {
        return String(answer ?? '')
      },
    },
  ],
  topology: {
    stages: [
      { name: 'llm-call', repeatable: true },
      { name: 'tool-call', kind: 'decision', repeatable: true, routes: [{ name: 'done' }] },
    ],
  },
  async runEval() {
    return { pass: true, summary: 'fixture profile: nothing to measure' }
  },
}
