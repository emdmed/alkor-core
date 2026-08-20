/**
 * llama-server transport: one POST to /v1/chat/completions.
 *
 * The sampler settings here are fixed rather than configurable, and that is the point.
 * When a second runtime evaluates the same model against the same contract pack, any
 * difference in the request body — a sampler default, a missing cache_prompt — shows up
 * as an eval delta that looks like a model difference. A profile chooses its prompts and
 * its schema; it does not get to choose its temperature.
 */

// `fetch` comes from undici too, deliberately. Node's built-in fetch has its own bundled
// copy of undici and rejects a dispatcher constructed from this package — the rejection
// surfaces as the same opaque `fetch failed` the timeout produced, so the two failures are
// indistinguishable from the outside. Taking both from one module keeps them compatible.
import { Agent, fetch } from 'undici'

export const LLAMA_DEFAULT_URL = 'http://127.0.0.1:8080'

/** Generous: a quantized model on CPU can spend minutes on the long JSON these ask for. */
const TIMEOUT_MS = 900_000

/**
 * Reasoning off, generation bounded. Both halves were paid for in wall-clock before they
 * were written down.
 *
 * **Thinking.** Qwen3 is a hybrid reasoning model and its own chat template turns the
 * reasoning block ON by default, so `--jinja` silently opts every request into it. Measured
 * on this machine, asking `What is 2+2? Answer in one word.`:
 *
 *     thinking on   199 completion tokens, 753 chars of reasoning, ~15s
 *     thinking off    3 completion tokens,   0 chars of reasoning,  0.3s
 *
 * Sixty-six times the tokens to say "four". At ~13.6 tok/s that is the difference between
 * an agentic loop that answers and one that does not finish. The reasoning was never even
 * read: no eval path consumes `reasoning_content`, and an interactive host that shows it
 * only chooses whether to DISPLAY what was already generated and paid for.
 *
 * **The cap.** Without `max_tokens` a single call is unbounded, and one run-away generation
 * hangs a whole run until TIMEOUT_MS — fifteen minutes, at 2.7k tokens of context, which is
 * how this was found. A cap turns that into a truncated reply the loop can see and move
 * past. It is a backstop, not a budget: normal replies are nowhere near it.
 */
const NO_THINKING = { enable_thinking: false }

/** A tool call or a conversational answer. Neither is long; 1k is already generous. */
const MAX_TOKENS_REPLY = 1024

/**
 * Constrained extraction gets far more headroom, and it is not a stylistic choice: a
 * grammar BLOCKS EOS while an array is open, so the model cannot stop until it reaches
 * `]`. An early trial ran to 3483 tokens. Capping this at the reply limit would truncate
 * mid-array and turn every long extraction into a parse failure — the cap must sit above
 * anything the schema can legitimately produce, or it stops being a backstop and becomes
 * the bug.
 */
const MAX_TOKENS_EXTRACTION = 8192

/**
 * Node's built-in fetch gives up after 300s of waiting for response HEADERS, and a
 * non-streaming completion sends nothing until the whole JSON exists — so a slow model
 * silently hit a 300s ceiling while `TIMEOUT_MS` claimed 900s. Measured: Qwen3-4B at 7.1
 * tok/s over a 15k-token prompt was killed at 300.0s and again at 300.75s on the retry,
 * which read as `fetch failed` and scored the case as an extraction failure — a transport
 * limit wearing a model result's clothing.
 *
 * Both timeouts are disabled here so `AbortSignal.timeout(TIMEOUT_MS)` is the ONE deadline,
 * which is what the constant was always supposed to mean. Streaming callers do not need
 * this (headers arrive at once, and every token resets the body timeout), but they share
 * the dispatcher harmlessly.
 */
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

export interface ChatOptions {
  baseUrl?: string
  model?: string
  systemPrompt: string
  userPrompt: string
  label: string
  /** JSON Schema to constrain decoding (DEC-LOCAL-3). Omit to leave decoding free. */
  schema?: object
  /**
   * `json_schema.name` in the request body. Defaults to `extraction`.
   *
   * It exists because a pack may DECLARE this label. llama.cpp does not act on it, so it
   * changes no output — but the pack owner's own runtime sends whatever the manifest
   * says, and a body that differs from the one under measurement is precisely what the
   * byte pins exist to prevent. A field nobody reads is still a field in the bytes.
   */
  schemaName?: string
  /**
   * Completion cap. Defaults to MAX_TOKENS_EXTRACTION.
   *
   * Also a parity field rather than a tuning knob. The default is a harness-wide backstop
   * chosen for an unbounded array; a pack whose owner runs a smaller cap in production —
   * 2048 is a common one — must be measured at the cap it runs, or a truncation that
   * happens in the product cannot happen in the eval. The profile passes
   * the pack's number; nothing else may pass one.
   */
  maxTokens?: number
  signal?: AbortSignal
}

export class LlamaError extends Error {}

/**
 * What a completion actually cost, counted by the server with the MODEL'S OWN tokeniser.
 *
 * There is no second way to get this right. A `text.length / 4` estimate is off by enough on
 * tool-heavy JSON to be misleading in exactly the situation the number exists for — deciding
 * whether the next question fits — and every tokeniser differs, so the harness cannot hold a
 * table of its own. llama-server already counts this per request; the only work is asking for
 * it and carrying it back.
 *
 * `promptTokens` is the WHOLE conversation as the server saw it, not the newest message.
 */
export interface Usage {
  promptTokens: number
  completionTokens: number
  /** prompt + completion: what the NEXT request re-sends, once this reply joins the history. */
  totalTokens: number
  /** Prompt tokens served from the KV cache rather than re-evaluated. Cost, not occupancy. */
  cachedTokens?: number
}

const readUsage = (u: any): Usage | undefined => {
  if (!u || typeof u.total_tokens !== 'number') return undefined
  return {
    promptTokens: Number(u.prompt_tokens) || 0,
    completionTokens: Number(u.completion_tokens) || 0,
    totalTokens: Number(u.total_tokens) || 0,
    cachedTokens: typeof u.prompt_tokens_details?.cached_tokens === 'number'
      ? u.prompt_tokens_details.cached_tokens
      : undefined,
  }
}

export interface ToolCall {
  id: string
  type: string
  function: { name: string; arguments: string }
}

export interface ToolChatOptions {
  messages: unknown[]
  /** May be empty: a conversation with no tools is a conversation, not a broken loop. */
  tools: unknown[]
  baseUrl?: string
  model?: string
  label: string
}

/**
 * The tool fields, present only when there are tools.
 *
 * An EMPTY `tools: []` is not the same request as no `tools` field at all. llama-server
 * takes the presence of the field as a request to apply the template's tool syntax, so a
 * toolless conversation would be handed the scaffolding for calls it can never make — and
 * on a model whose template has no tool support at all (gemma-3, a common choice for
 * extraction) that is an outright template error rather than a wasted section of prompt.
 * A profile with no tools is exactly how an extract profile gets a chat window, so this is
 * the difference between that working and not.
 */
const toolFields = (tools: unknown[]): Record<string, unknown> =>
  tools.length ? { tools, tool_choice: 'auto' } : {}

/**
 * Tool-calling variant. Requires the server to be started with `--jinja`, which is what
 * makes llama-server apply the model's own chat template and parse tool calls back out of
 * the completion. Without it the `tools` field is ignored and the model answers in prose.
 *
 * Temperature stays at 0: tool selection is a decision, not a place we want diversity.
 */
export const toolChat = async (
  o: ToolChatOptions,
): Promise<{ content: string | null; toolCalls: ToolCall[]; usage?: Usage }> => {
  const baseUrl = (o.baseUrl ?? process.env.LLAMA_URL ?? LLAMA_DEFAULT_URL).replace(/\/+$/, '')
  const url = `${baseUrl}/v1/chat/completions`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: o.model ?? process.env.LLAMA_MODEL ?? 'local',
        temperature: 0,
        stream: false,
        cache_prompt: true,
        max_tokens: MAX_TOKENS_REPLY,
        chat_template_kwargs: NO_THINKING,
        messages: o.messages,
        ...toolFields(o.tools),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      dispatcher,
    })
  } catch (e) {
    throw new LlamaError(
      `cannot reach llama-server at ${baseUrl} for ${o.label}: ${(e as Error).message} — ` +
        'start it with `scripts/llama-server.sh` (it must be started with --jinja for tool calls)',
    )
  }
  if (!res.ok) {
    throw new LlamaError(`llama-server (${o.label}) returned HTTP ${res.status}: ${await res.text().catch(() => '')}`)
  }

  const envelope = (await res.json()) as any
  if (envelope?.error) {
    throw new LlamaError(`llama-server (${o.label}) error: ${envelope.error.message ?? 'unknown error'}`)
  }
  const msg = envelope?.choices?.[0]?.message
  // A non-streamed envelope carries `usage` unasked — no request-body change here, so the
  // pinned body above stays byte-identical to what it was.
  return {
    content: msg?.content ?? null,
    toolCalls: (msg?.tool_calls as ToolCall[]) ?? [],
    usage: readUsage(envelope?.usage),
  }
}

export interface StreamChatOptions extends ToolChatOptions {
  /** Called with each content fragment as it arrives. */
  onToken?(text: string): void
  /** Reasoning fragments, when the server separates them (Qwen3 and friends). */
  onReasoning?(text: string): void
  signal?: AbortSignal
  /**
   * Transport seam, so the SSE reader can be tested without a server — the same device
   * `runAgent` uses for the tool loop. It has to be explicit rather than a `globalThis`
   * stub because `fetch` is imported from undici above, deliberately.
   */
  fetchImpl?: typeof fetch
}

export interface StreamResult {
  content: string | null
  toolCalls: ToolCall[]
  reasoning?: string
  /** Fragments seen. Not a tokeniser count — a live rate readout, nothing more. */
  chunks: number
  /**
   * Absent on an aborted turn: the server sends the usage frame after the last content
   * frame, and a cancelled read never reaches it. Callers must treat that as "unchanged",
   * never as zero — an interrupted turn still left its partial reply in the context.
   */
  usage?: Usage
  /** The caller's signal fired; content and toolCalls hold whatever had arrived. */
  aborted?: boolean
}

/**
 * Streaming tool-calling chat, for interactive use.
 *
 * This is a SEPARATE function rather than a `stream` flag on `toolChat`, and that is not
 * fastidiousness. The request body above is pinned so a second runtime evaluating the same
 * model produces comparable numbers; a flag on that function is a flag that eventually gets
 * set on the eval path, changing the body under a measurement that is supposed to be
 * stable. A chat is not a measurement, so it gets its own door.
 *
 * Returns the same shape `toolChat` does, so a loop can use either without caring.
 */
export const streamChat = async (o: StreamChatOptions): Promise<StreamResult> => {
  const baseUrl = (o.baseUrl ?? process.env.LLAMA_URL ?? LLAMA_DEFAULT_URL).replace(/\/+$/, '')
  const url = `${baseUrl}/v1/chat/completions`
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout

  let res: Response
  try {
    res = await (o.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: o.model ?? process.env.LLAMA_MODEL ?? 'local',
        temperature: 0,
        stream: true,
        // A streamed response carries no `usage` unless asked: the default SSE tail is a
        // `finish_reason` frame and nothing else. This adds one extra frame, after the
        // content, holding the counts the header's context readout is built on.
        //
        // Safe HERE and not in `toolChat` above, which is deliberate. This function is the
        // non-measurement door — the eval path never takes it — so a body change costs
        // nothing in comparability, which is the whole reason the two are separate.
        stream_options: { include_usage: true },
        cache_prompt: true,
        max_tokens: MAX_TOKENS_REPLY,
        chat_template_kwargs: NO_THINKING,
        messages: o.messages,
        ...toolFields(o.tools),
      }),
      signal,
      dispatcher,
    })
  } catch (e) {
    if (o.signal?.aborted) return { content: null, toolCalls: [], chunks: 0, aborted: true }
    throw new LlamaError(
      `cannot reach llama-server at ${baseUrl} for ${o.label}: ${(e as Error).message} — ` +
        'start it with `scripts/llama-server.sh` (it must be started with --jinja for tool calls)',
    )
  }
  if (!res.ok) {
    throw new LlamaError(`llama-server (${o.label}) returned HTTP ${res.status}: ${await res.text().catch(() => '')}`)
  }
  if (!res.body) throw new LlamaError(`llama-server (${o.label}) returned no body to stream`)

  const acc = newStreamState()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // Cancel the body ourselves rather than trusting fetch's signal to do it. A local server
  // that has stalled mid-generation leaves read() pending indefinitely, and ctrl-c has to
  // work in precisely that case — it is the one the user is most likely to hit.
  const onAbort = () => void reader.cancel().catch(() => {})
  o.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // A read can end mid-frame, so only complete `\n\n`-delimited frames are consumed
      // and the remainder stays buffered for the next one.
      let cut: number
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        if (feedStreamFrame(acc, frame, o)) return finishStream(acc)
      }
    }
    if (buffer.trim()) feedStreamFrame(acc, buffer, o)
  } catch (e) {
    // A user-cancelled turn is an outcome, not a failure: hand back what arrived so the
    // conversation keeps the partial assistant message it already displayed.
    if (o.signal?.aborted) return { ...finishStream(acc), aborted: true }
    // An error the server itself reported already names the cause; do not bury it.
    if (e instanceof LlamaError) throw e
    throw new LlamaError(`llama-server (${o.label}) stream failed: ${(e as Error).message}`)
  } finally {
    o.signal?.removeEventListener('abort', onAbort)
    reader.cancel().catch(() => {})
  }

  // A cancelled reader ends the loop cleanly rather than throwing, so the outcome is
  // decided here as well as in the catch.
  if (o.signal?.aborted) return { ...finishStream(acc), aborted: true }
  return finishStream(acc)
}

interface StreamState {
  content: string
  reasoning: string
  /** Keyed by the delta's `index` — one entry per tool call being assembled. */
  calls: Map<number, { id: string; type: string; name: string; arguments: string }>
  chunks: number
  usage?: Usage
}

const newStreamState = (): StreamState => ({ content: '', reasoning: '', calls: new Map(), chunks: 0 })

/** Returns true when the stream is finished (`data: [DONE]`). */
const feedStreamFrame = (acc: StreamState, frame: string, o: StreamChatOptions): boolean => {
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    if (payload === '[DONE]') return true

    let chunk: any
    try {
      chunk = JSON.parse(payload)
    } catch {
      // A malformed frame is not worth killing a turn over; the next one usually carries
      // the same text. Skipping beats throwing away a reply that is otherwise complete.
      continue
    }
    if (chunk?.error) {
      throw new LlamaError(`llama-server (${o.label}) error: ${chunk.error.message ?? 'unknown error'}`)
    }

    // BEFORE the delta guard, not after. The usage frame is the one frame with an EMPTY
    // `choices` array — reading it second would mean `continue` had already skipped it, and
    // the counts would silently never arrive.
    const usage = readUsage(chunk?.usage)
    if (usage) acc.usage = usage

    const delta = chunk?.choices?.[0]?.delta
    if (!delta) continue
    acc.chunks += 1

    if (typeof delta.content === 'string' && delta.content) {
      acc.content += delta.content
      o.onToken?.(delta.content)
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      acc.reasoning += delta.reasoning_content
      o.onReasoning?.(delta.reasoning_content)
    }

    // Tool calls arrive fragmented and interleaved, keyed by index: the name and id show
    // up once, then `arguments` accrues one string piece at a time. Nothing may be
    // dispatched until the stream ends, because a half-built argument object is not JSON.
    for (const tc of delta.tool_calls ?? []) {
      const idx = typeof tc.index === 'number' ? tc.index : 0
      const entry = acc.calls.get(idx) ?? { id: '', type: 'function', name: '', arguments: '' }
      if (tc.id) entry.id = tc.id
      if (tc.type) entry.type = tc.type
      if (tc.function?.name) entry.name += tc.function.name
      if (typeof tc.function?.arguments === 'string') entry.arguments += tc.function.arguments
      acc.calls.set(idx, entry)
    }
  }
  return false
}

const finishStream = (acc: StreamState): StreamResult => ({
  content: acc.content || null,
  toolCalls: [...acc.calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([idx, c]) => ({
      // Some builds never send an id for a streamed call, and the tool result message has
      // to carry one back that the server will accept.
      id: c.id || `call_${idx}`,
      type: c.type || 'function',
      function: { name: c.name, arguments: c.arguments },
    })),
  reasoning: acc.reasoning || undefined,
  chunks: acc.chunks,
  usage: acc.usage,
})

export const llamaChat = async (o: ChatOptions): Promise<string> => {
  const baseUrl = (o.baseUrl ?? process.env.LLAMA_URL ?? LLAMA_DEFAULT_URL).replace(/\/+$/, '')
  const url = `${baseUrl}/v1/chat/completions`

  const body: Record<string, unknown> = {
    model: o.model ?? process.env.LLAMA_MODEL ?? 'local',
    // Every pass asks for a JSON contract rather than prose, and two local runs must be
    // comparable (REQ-LOCAL-3).
    temperature: 0,
    stream: false,
    // Lets the server reuse the KV cache across the large shared system prompts.
    cache_prompt: true,
    // Sized for a grammar that cannot stop mid-array — see MAX_TOKENS_EXTRACTION. A
    // profile may substitute the cap its pack owner actually runs; see ChatOptions.
    max_tokens: o.maxTokens ?? MAX_TOKENS_EXTRACTION,
    chat_template_kwargs: NO_THINKING,
    messages: [
      { role: 'system', content: o.systemPrompt },
      { role: 'user', content: o.userPrompt },
    ],
  }
  if (o.schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: o.schemaName ?? 'extraction', strict: true, schema: o.schema },
    }
  }

  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      dispatcher,
    })
  } catch (e) {
    // REQ-LOCAL-4: name the endpoint and how to fix it, never a bare transport error.
    throw new LlamaError(
      `cannot reach llama-server at ${baseUrl} for ${o.label}: ${(e as Error).message} — ` +
        'start it with `scripts/llama-server.sh` or set LLAMA_URL',
    )
  }

  if (!res.ok) {
    // A non-2xx carries the server's own diagnosis (bad request, context overflow, no
    // model loaded) — surface it verbatim, it is the fix.
    throw new LlamaError(
      `llama-server (${o.label}) returned HTTP ${res.status}: ${await res.text().catch(() => '')}`,
    )
  }

  const envelope = (await res.json()) as any
  if (envelope?.error) {
    throw new LlamaError(`llama-server (${o.label}) error: ${envelope.error.message ?? 'unknown error'}`)
  }
  const content = envelope?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new LlamaError(`${o.label} envelope missing .choices[0].message.content`)
  }
  return content
}
