/**
 * Extract mode: single-shot constrained output over one document. No tool loop — the
 * model is asked for a structured reading of the text, not for a sequence of actions.
 *
 * The mode does not know what a valid result looks like. The caller supplies a `parse`
 * function, and the mode's only judgement is whether that function threw; the shape of
 * the answer belongs to the profile, not to the runtime.
 *
 * One retry (REQ-DEMO-3): a small local model misses a JSON contract more often than a
 * hosted one, and the retry is the same concession a hosted provider makes, not a
 * relaxation added for the local path.
 */
import { llamaChat } from '../core/client.ts'

export interface ExtractOutcome<T> {
  parsed?: T
  /** Both the attempt and its retry failed; the string carries both diagnoses. */
  error?: string
  raw?: string
}

export interface ExtractOptions<T> {
  systemPrompt: string
  document: string
  /** Turns the completion into the profile's own shape, or throws with a diagnosis. */
  parse: (raw: string) => T
  schema?: object
  /** Passed through to the client; see ChatOptions. Both are parity fields. */
  schemaName?: string
  maxTokens?: number
  baseUrl?: string
  label?: string
}

export const extract = async <T,>(o: ExtractOptions<T>): Promise<ExtractOutcome<T>> => {
  const attempt = async (): Promise<ExtractOutcome<T>> => {
    let raw: string
    try {
      raw = await llamaChat({
        systemPrompt: o.systemPrompt,
        userPrompt: o.document,
        label: o.label ?? 'extraction',
        schema: o.schema,
        schemaName: o.schemaName,
        maxTokens: o.maxTokens,
        baseUrl: o.baseUrl,
      })
    } catch (e) {
      return { error: (e as Error).message }
    }
    try {
      return { parsed: o.parse(raw), raw }
    } catch (e) {
      return { error: (e as Error).message, raw }
    }
  }

  const first = await attempt()
  if (first.parsed !== undefined) return first
  const second = await attempt()
  if (second.parsed !== undefined) return second
  // Both diagnoses, concatenated: the retry usually fails differently from the attempt,
  // and which pair of messages you get is the fastest read on whether it is the model or
  // the contract that is wrong.
  return { error: `${first.error}; retry: ${second.error}`, raw: second.raw }
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
