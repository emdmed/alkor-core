/**
 * Extract mode: single-shot constrained output over one document. No tool loop — the
 * model is asked for a structured reading of the text, not for a sequence of actions.
 *
 * The mode does not know what a valid result looks like. The caller supplies a `parse`
 * function, and the mode's only judgement is whether that function threw; the shape of
 * the answer belongs to the profile, not to the runtime.
 *
 * One retry, and only for a request that never produced a completion (REQ-DEMO-3). A
 * TRANSPORT failure is worth retrying: a connection reset or a server that was still loading
 * says nothing about the model's answer, and a hosted provider retries the same class.
 *
 * A PARSE failure is not, and retrying one was a measured waste. The request body is
 * identical, the temperature is 0 and the server is greedy, so the second attempt reproduces
 * the first: on the unconstrained gemma-3-4b arm of this pack, 30 of 30 cases retried, 0
 * recovered, and the run took 987s against the constrained arm's 510s. It also bought a
 * format failure two chances at a contract while a wrong VALUE got one — an asymmetry
 * between the two things the eval reports side by side.
 */
import { llamaChat, LlamaError } from '../core/client.ts'
import type { Timings } from '../core/bench.ts'

export interface ExtractOutcome<T> {
  parsed?: T
  /**
   * Why there is no reading. When the attempt reached the server and its reply would not
   * parse, this is that one diagnosis; when the request itself failed twice, it carries both.
   */
  error?: string
  raw?: string
  /**
   * What each attempt cost, in order. Two entries means the parse failed and the pass ran
   * twice — the caller waited for both, so a cost summed from this array is what the
   * application actually paid rather than what a successful request costs.
   *
   * An attempt whose REQUEST failed contributes nothing HERE: there is no completion to have
   * spent tokens on, and a zero-token entry would drag a throughput figure down with a request
   * that never generated anything. What it cost in wall clock is in `lostMs` below, and the
   * fact that it happened is in `attempts` — both of which used to be nowhere.
   */
  cost: { timings?: Timings; wallMs: number }[]
  /**
   * How many times the request was actually SENT, including attempts that never came back.
   *
   * `cost.length` was standing in for this and undercounted exactly the case worth counting:
   * `onMetrics` fires only after a completion is read, so a case whose first attempt failed at
   * transport and whose retry succeeded reported one attempt — and `summarizeBench` derives
   * `retries` from that, so the retry was invisible in the cost of the run that paid for it.
   */
  attempts: number
  /**
   * Wall time spent on attempts that produced no completion.
   *
   * Kept apart from `cost` rather than folded into it, because the two answer different
   * questions: `cost` is what generating tokens cost, and this is what waiting for nothing
   * cost. A caller summing a case's latency wants both; a caller computing tokens per second
   * wants only the first, and adding a 30-second timeout to that denominator would report a
   * model as slow when what was slow was a server that was down.
   */
  lostMs: number
}

export interface ExtractOptions<T> {
  systemPrompt: string
  document: string
  /** Turns the completion into the profile's own shape, or throws with a diagnosis. */
  parse: (raw: string) => T
  schema?: object
  /** Passed through to the client; see ChatOptions. All four are parity fields. */
  schemaName?: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  baseUrl?: string
  /**
   * Passed through to the client. Off makes a run slower and comparable — see the client, and
   * core/stability.ts, where the measured flip that motivates it is written down.
   */
  cachePrompt?: boolean
  label?: string
}

export const extract = async <T,>(o: ExtractOptions<T>): Promise<ExtractOutcome<T>> => {
  // Accumulated across attempts rather than per attempt, so a retried case reports the
  // latency the caller actually waited. Every return path below carries the whole array.
  const cost: ExtractOutcome<T>['cost'] = []
  // Counted here rather than derived from `cost`, which counts COMPLETIONS. See `attempts`.
  let attempts = 0
  let lostMs = 0
  /** Everything the caller waited for, in the shape every return path below carries. */
  const spent = () => ({ cost, attempts, lostMs })

  /** `retryable` is true only when no completion came back at all. See the header. */
  const attempt = async (): Promise<{ outcome: ExtractOutcome<T>; retryable: boolean }> => {
    let raw: string
    let finishReason: string | undefined
    attempts++
    // The client measures its own round trip and reports it through `onMetrics`, which only
    // fires on a completion. This clock is the one that survives a request that never
    // produced one — which is precisely the attempt that used to cost nothing on paper.
    const startedAt = performance.now()
    try {
      raw = await llamaChat({
        systemPrompt: o.systemPrompt,
        userPrompt: o.document,
        label: o.label ?? 'extraction',
        schema: o.schema,
        schemaName: o.schemaName,
        maxTokens: o.maxTokens,
        temperature: o.temperature,
        timeoutMs: o.timeoutMs,
        baseUrl: o.baseUrl,
        cachePrompt: o.cachePrompt,
        onMetrics: (m) => {
          cost.push({ timings: m.timings, wallMs: m.wallMs })
          finishReason = m.finishReason
        },
      })
    } catch (e) {
      // A LlamaError is the transport speaking: unreachable server, HTTP status, an envelope
      // with no content. Anything else escaping the client is a bug here, not a bad reply,
      // and retrying it would only hide it.
      lostMs += performance.now() - startedAt
      return { outcome: { error: (e as Error).message, ...spent() }, retryable: e instanceof LlamaError }
    }
    try {
      return { outcome: { parsed: o.parse(raw), raw, ...spent() }, retryable: false }
    } catch (e) {
      // A reply cut off by the cap is not a model that cannot write JSON, and the two have
      // different fixes — raise the pack's cap, or fix the prompt. The parser cannot tell
      // them apart because it only sees the text; the server said so, so say it here.
      const truncated =
        finishReason === 'length'
          ? ` — the completion stopped at the ${o.maxTokens ?? 'default'}-token cap, so this JSON is cut off rather than wrong`
          : ''
      return { outcome: { error: `${(e as Error).message}${truncated}`, raw, ...spent() }, retryable: false }
    }
  }

  const first = await attempt()
  // A reply that arrived and would not parse is the result. Retrying an identical request
  // against a greedy sampler asks the same question twice and pays for both answers.
  if (first.outcome.parsed !== undefined || !first.retryable) return first.outcome

  const second = await attempt()
  if (second.outcome.parsed !== undefined) return second.outcome
  // Both diagnoses, concatenated: a retried request usually fails differently from the
  // attempt, and which pair of messages you get is the fastest read on whether the server
  // is down, still loading, or refusing the body.
  return { error: `${first.outcome.error}; retry: ${second.outcome.error}`, raw: second.outcome.raw, ...spent() }
}

/**
 * An extraction, phrased as the exchange it would have been if it had happened in a
 * conversation — for a host that runs both, so the next question can be about the result.
 *
 * This lives at the mode boundary rather than in a profile because it contains no domain:
 * it is the generic act of telling a conversation what the one-shot pass beside it just
 * did. The rendered text is the PROFILE's, unaltered, so the model reads what the user
 * reads.
 *
 * User-then-assistant rather than a `tool` message: nothing called a tool, and a `tool`
 * role with no preceding `tool_calls` is rejected by the server. The document is included
 * whole — at 32k of context a clinical note is affordable, and a conversation about a
 * document only one side has read produces confident answers about sentences that are not
 * in it.
 */
export const briefing = (label: string, document: string, rendered: string): { user: string; assistant: string } => ({
  user: `Here is the document under review (${label}). Read it; I may ask about it.\n\n---\n${document.trim()}\n---`,
  assistant:
    `I have read it. The constrained extraction pass over it produced:\n\n${rendered}\n\n` +
    `Ask me about any of it — why something was or was not detected, what the evidence supports, or what the document leaves open.`,
})
