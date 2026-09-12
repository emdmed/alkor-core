/**
 * LLM transport: one POST to /v1/chat/completions.
 *
 * The sampler settings here are fixed rather than configurable, and that is the point.
 * When a second runtime evaluates the same model against the same contract pack, any
 * difference in the request body — a sampler default, a missing cache_prompt — shows up
 * as an eval delta that looks like a model difference.
 *
 * The ONE exception is a value the pack itself declares. A profile may pass the temperature,
 * the cap and the deadline its `models` file states, and nothing else — the same argument
 * that already applies to `max_tokens`: a pack whose application runs a different sampler
 * must be measured at the sampler it runs, or the eval measures something adjacent to the
 * product. Every one of those three has a harness default here, so a profile that passes
 * nothing sends exactly the bytes it always did.
 *
 * A declared setting that is REPORTED and not SENT is worse than either choice: the header,
 * the trace `run` event and any result copied out of them would all name a sampling that
 * never reached the wire. That is what these parameters exist to prevent.
 */

// `fetch` comes from undici too, deliberately. Node's built-in fetch has its own bundled
// copy of undici and rejects a dispatcher constructed from this package — the rejection
// surfaces as the same opaque `fetch failed` the timeout produced, so the two failures are
// indistinguishable from the outside. Taking both from one module keeps them compatible.
import { Agent, fetch } from 'undici'
import type { BenchConditions, Timings } from './bench.ts'

export const DEFAULT_URL = 'http://127.0.0.1:8080'
export const LLAMA_DEFAULT_URL = DEFAULT_URL

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
  /**
   * Sampler temperature. Defaults to 0, which is what a graded task must run at: the pass
   * emits a JSON contract, and two runs over one note that disagree are measuring dice.
   *
   * A parity field like `maxTokens`, and passed for the same reason — a pack that declares
   * a non-zero temperature must be MEASURED at it rather than described as running it. See
   * `seed` in the body below, which is what keeps a non-zero temperature reproducible.
   */
  temperature?: number
  /**
   * Per-request deadline in milliseconds. Defaults to TIMEOUT_MS, the harness backstop.
   *
   * Declared per task because the tasks are not alike: a pass whose user message is a whole
   * assembled record spends several times another's on prefill alone, and one deadline
   * covering both is either too tight for the long task or no bound at all on the short one.
   */
  timeoutMs?: number
  /**
   * Let the server reuse the KV cache of a shared prefix. Defaults to true.
   *
   * A parity field again, and the one whose default is a trade rather than a convention. It
   * is worth 60-88% of prefill on a corpus of notes behind one large system prompt, and it is
   * also the reason two runs of the same bytes can disagree: a different set of preceding
   * requests leaves a different KV prefix, which changes how the batch is split, which changes
   * the last bits of the logits, which flips a near-tied argmax. Measured on this harness —
   * `"weight 61.4 kg"` in a 21-note run, `"Weight 61.4 kg"` in a five-note one, same model,
   * same note, same bytes.
   *
   * So a caller that needs a run comparable with somebody else's passes false and pays the
   * prefill. Nothing about turning it off makes decoding deterministic in general; it removes
   * the one source of variation this harness has actually caught in the act.
   */
  cachePrompt?: boolean
  signal?: AbortSignal
  /**
   * Override the default `chat_template_kwargs` (e.g. to enable thinking for a profile
   * that needs it). Defaults to `{ enable_thinking: false }`.
   */
  chatTemplateKwargs?: Record<string, unknown>
  /**
   * Sink for what the completion cost. Called once, on success only.
   *
   * A sink rather than a changed return type: `chat` returns the completion string
   * and is exported to out-of-tree profiles, so widening it would break every caller to
   * serve the ones that care. Nothing in the REQUEST changes when this is passed — the
   * server returns `timings` unasked on the non-streamed path, so a measured run and an
   * unmeasured one send identical bytes, which is the property the pins exist to protect.
   */
  onMetrics?(m: { timings?: Timings; usage?: Usage; wallMs: number; finishReason?: string }): void
}

export class ChatError extends Error {}

export { ChatError as LlamaError }

// Re-exported through this module's own surface: a caller reading timings off a completion
// is already importing the transport, and a second import path for the shape it gets back
// is one more thing to keep in step.
export type { BenchConditions, Timings } from './bench.ts'

/**
 * What a completion actually cost, counted by the server with the MODEL'S OWN tokeniser.
 *
 * There is no second way to get this right. A `text.length / 4` estimate is off by enough on
 * tool-heavy JSON to be misleading in exactly the situation the number exists for — deciding
 * whether the next question fits — and every tokeniser differs, so the harness cannot hold a
 * table of its own. The server already counts this per request; the only work is asking for
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

/**
 * The server's own `timings`, normalised.
 *
 * Non-standard — an OpenAI envelope has no such field — so it is read defensively and a
 * server that omits it yields undefined rather than zeros. Zeros would be worse than a gap:
 * they aggregate into a throughput figure that looks measured and is not.
 *
 * `prompt_n` counts the tokens actually EVALUATED; `cache_n` counts the ones the KV cache
 * already held. They are kept apart here because their sum is the prompt and their ratio is
 * the whole argument for running the corpus sequentially.
 */
const readTimings = (t: any): Timings | undefined => {
  if (!t || typeof t.predicted_ms !== 'number') return undefined
  return {
    promptTokens: Number(t.prompt_n) || 0,
    promptMs: Number(t.prompt_ms) || 0,
    predictedTokens: Number(t.predicted_n) || 0,
    predictedMs: Number(t.predicted_ms) || 0,
    cachedTokens: Number(t.cache_n) || 0,
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
 * An EMPTY `tools: []` is not the same request as no `tools` field at all. The server
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
 * makes the server apply the model's own chat template and parse tool calls back out of
 * the completion. Without it the `tools` field is ignored and the model answers in prose.
 *
 * Temperature stays at 0: tool selection is a decision, not a place we want diversity.
 */
export const toolChat = async (
  o: ToolChatOptions,
): Promise<{ content: string | null; toolCalls: ToolCall[]; usage?: Usage }> => {
  const baseUrl = (o.baseUrl ?? process.env.LLAMA_URL ?? DEFAULT_URL).replace(/\/+$/, '')
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
    throw new ChatError(
      `cannot reach server at ${baseUrl} for ${o.label}: ${(e as Error).message} — ` +
        'check the server is running and reachable' +
        (o.tools?.length ? ', and that it was started with --jinja, which tool calls need' : ''),
    )
  }
  if (!res.ok) {
    throw new ChatError(`server (${o.label}) returned HTTP ${res.status}: ${await res.text().catch(() => '')}`)
  }

  const envelope = (await res.json()) as any
  if (envelope?.error) {
    throw new ChatError(`server (${o.label}) error: ${envelope.error.message ?? 'unknown error'}`)
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
  const baseUrl = (o.baseUrl ?? process.env.LLAMA_URL ?? DEFAULT_URL).replace(/\/+$/, '')
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
    throw new ChatError(
      `cannot reach server at ${baseUrl} for ${o.label}: ${(e as Error).message} — ` +
        'check the server is running and reachable' +
        (o.tools?.length ? ', and that it was started with --jinja, which tool calls need' : ''),
    )
  }
  if (!res.ok) {
    throw new ChatError(`server (${o.label}) returned HTTP ${res.status}: ${await res.text().catch(() => '')}`)
  }
  if (!res.body) throw new ChatError(`server (${o.label}) returned no body to stream`)

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
    if (e instanceof ChatError) throw e
    throw new ChatError(`server (${o.label}) stream failed: ${(e as Error).message}`)
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
      throw new ChatError(`server (${o.label}) error: ${chunk.error.message ?? 'unknown error'}`)
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

/**
 * What the server says it is actually serving.
 *
 * The harness does not start servers, so the model behind a URL is whatever someone
 * launched — which is not necessarily what the pack declares. That gap is not hypothetical:
 * the same pack was deliberately run against three different models on one afternoon, and
 * a result recorded as "the model in models.default.toml" would have been wrong for two of
 * them. A number is only reproducible if it names the thing that produced it, and the only
 * honest source for that is the server.
 *
 * Best effort: a server too old to expose /v1/models, or one that is simply down, yields
 * undefined rather than an error. Failing a run over a label would be worse than recording
 * that the label was unavailable.
 */
export const serverModel = async (baseUrl: string = DEFAULT_URL): Promise<string | undefined> => {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/models`, { dispatcher })
    if (!res.ok) return undefined
    const body = (await res.json()) as { data?: { id?: string }[] }
    return body.data?.[0]?.id
  } catch {
    return undefined
  }
}

/**
 * The conditions a SPEED is only valid under, read from the server that will produce it.
 *
 * Same argument as `serverModel` one function up, applied to the other half of a result: a
 * pack can declare a context size and a slot count, but the process actually serving the
 * request is whatever someone launched, and a timing recorded against the declaration is
 * wrong the first time those differ. Best effort — an older server, or a build with
 * `--no-props`, yields undefined rather than failing a run over a label.
 */
export const serverProps = async (baseUrl: string = DEFAULT_URL): Promise<BenchConditions | undefined> => {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/props`, { dispatcher })
    if (!res.ok) return undefined
    const body = (await res.json()) as any
    return {
      modelPath: typeof body.model_path === 'string' ? body.model_path : undefined,
      quant: typeof body.model_ftype === 'string' ? body.model_ftype : undefined,
      ctx: Number(body.default_generation_settings?.n_ctx) || undefined,
      slots: Number(body.total_slots) || undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * Reachability probe for a base URL: one GET /health, 2s deadline.
 *
 * This answers "is ANYTHING listening" — `identifyServer` is the loader check, and it is
 * best effort for a reason that does not apply here. The server probes every configured
 * backend at startup so it can say "start llama-server first" instead of a dashboard that
 * claims LIVE over a dark model port, and a run refuses to start when every backend is dark.
 */
export const probeServer = async (baseUrl: string = DEFAULT_URL): Promise<boolean> => {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(2000),
      dispatcher,
    })
    // Any answer under 500 is a server that is up; an HTTP error still proves a listener.
    return res.status < 500
  } catch {
    return false
  }
}

/**
 * What produced this run, resolved ONCE, and whether it can be named at all.
 *
 * The two functions above are best effort by design — failing an eval over a label would be
 * the wrong trade — but "best effort" was where it stopped, and that left a real hole: a run
 * against a server too old to expose `/v1/models` recorded `(server did not say)` and then
 * printed a number in exactly the format of a number that names its model. A result nobody
 * can attribute is not reproducible, and nothing in the output treated it as a problem.
 *
 * So the gap is now a value rather than a string. `identified` is false when the server would
 * not say what it is serving; `warning` is the sentence to print. A consumer reading the trace
 * can refuse to quote a number whose `run` event says `identified: false`, which is the point
 * of recording it: the harness cannot know whether a given number is about to be pasted into a
 * README, and the file it wrote is the only thing that can say "not this one".
 *
 * Resolved once per RUN rather than once per task. Three tasks asking the same server the same
 * two questions is three round-trips for one answer, and — worse — three chances for the tasks
 * to disagree about what they were run against.
 */
export interface ServerIdentity {
  /** What the server said it is serving, or undefined when it would not say. */
  model?: string
  /** The flags a SPEED is valid under, or undefined when `/props` was unavailable. */
  props?: BenchConditions
  /** False when the model could not be resolved. A result recorded this way is unreproducible. */
  identified: boolean
  /** One line, printed at the top of a run and recorded in the trace. Absent when all is well. */
  warning?: string
}

/** The label to print when the server would not name itself. One spelling, in one place. */
export const UNIDENTIFIED = '(server did not say)'

export const identifyServer = async (baseUrl?: string): Promise<ServerIdentity> => {
  const [model, props] = await Promise.all([serverModel(baseUrl), serverProps(baseUrl)])
  const missing = [!model && 'which model it is serving', !props && 'the flags it was started with'].filter(
    Boolean,
  ) as string[]
  return {
    model,
    props,
    identified: Boolean(model),
    warning: missing.length
      ? `the server at ${baseUrl ?? DEFAULT_URL} would not say ${missing.join(' or ')} — ` +
        (model
          ? 'the correctness numbers below stand, but any SPEED quoted from this run names no conditions'
          : 'a number from this run cannot be attributed to a model and should not be quoted as one')
      : undefined,
  }
}

/**
 * The request body, built and not sent.
 *
 * Extracted from `chat` so the pinned body can be INSPECTED without running a model. The
 * body is pinned precisely so a second runtime can be compared against it field for field, and
 * a pin whose only witness is a live server is a pin nobody checks: the comparison would cost a
 * 2.5 GB download and a warm GPU, so it would be run once and then trusted.
 *
 * `scripts/pin-body.ts` prints this, and the Rust runtime in the desktop app asserts byte
 * equality against what it prints. Nothing about the request changed when this was lifted out —
 * `chat` calls it, so there is one body rather than a body and a description of one.
 */
export const chatBody = (o: ChatOptions): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    model: o.model ?? process.env.LLAMA_MODEL ?? 'local',
    // Every pass asks for a JSON contract rather than prose, and two local runs must be
    // comparable (REQ-LOCAL-3). The pack may declare this; 0 is the default and the only
    // value a graded task should be running at.
    temperature: o.temperature ?? 0,
    /**
     * Pinned, and NOT redundant at temperature 0.
     *
     * Greedy decoding makes the seed inert for the sampler, so this changes nothing about
     * the runs measured before it was added. It is here for the case the parameter above now
     * makes possible: a pack that declares a non-zero temperature would otherwise produce a
     * different corpus reading on every run, with nothing in the request saying so.
     *
     * It does NOT make a run bit-reproducible, and nothing here should be read as claiming
     * that. Measured on this harness: the same note, the same model, the same bytes, scored
     * twice — once inside a 21-note run and once inside a 5-note `--difficulty 5` run —
     * returned `"weight 61.4 kg"` and `"Weight 61.4 kg"`. `cache_prompt` below is why. A
     * different set of preceding notes leaves a different KV prefix, which changes how the
     * batch is split, which changes the last bits of the logits, which flips a near-tied
     * argmax. One capital letter, and under a case-sensitive quote rule that is the
     * difference between a verified span and a fabricated one. A scoped run is therefore not
     * interchangeable with the same cases inside a full one.
     */
    seed: 0,
    stream: false,
    // Lets the server reuse the KV cache across the large shared system prompts.
    cache_prompt: o.cachePrompt ?? true,
    // Sized for a grammar that cannot stop mid-array — see MAX_TOKENS_EXTRACTION. A
    // profile may substitute the cap its pack owner actually runs; see ChatOptions.
    max_tokens: o.maxTokens ?? MAX_TOKENS_EXTRACTION,
    chat_template_kwargs: { ...NO_THINKING, ...o.chatTemplateKwargs },
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
  return body
}

export const chat = async (o: ChatOptions): Promise<string> => {
  const baseUrl = (o.baseUrl ?? process.env.LLAMA_URL ?? DEFAULT_URL).replace(/\/+$/, '')
  const url = `${baseUrl}/v1/chat/completions`
  const body = chatBody(o)

  const timeout = AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS)
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout

  // Around the fetch AND the body read, because an application waits for both. The server
  // never sees this clock, which is exactly why it is worth keeping: the difference between
  // it and the server's own milliseconds is the transport nobody budgets for.
  const startedAt = performance.now()

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
    // This path never sends tools, so it does not mention --jinja: the first thing a reader
    // hits on a fresh clone is this message, and a hint about tool calls sends them to debug
    // a template when what they actually have is no server.
    throw new ChatError(
      `cannot reach server at ${baseUrl} for ${o.label}: ${(e as Error).message} — ` +
        'start one with scripts/llama-server.sh (see README, Quickstart), or point this run ' +
        'at a server that is already up with --url',
    )
  }

  if (!res.ok) {
    // A non-2xx carries the server's own diagnosis (bad request, context overflow, no
    // model loaded) — surface it verbatim, it is the fix.
    throw new ChatError(
      `server (${o.label}) returned HTTP ${res.status}: ${await res.text().catch(() => '')}`,
    )
  }

  const envelope = (await res.json()) as any
  if (envelope?.error) {
    throw new ChatError(`server (${o.label}) error: ${envelope.error.message ?? 'unknown error'}`)
  }
  const content = envelope?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new ChatError(`${o.label} envelope missing .choices[0].message.content`)
  }
  // After the content check, so a failed call contributes no sample. A completion that
  // could not be read is a correctness event; averaging its latency into a throughput
  // figure would let a model that fails fast look quick.
  o.onMetrics?.({
    timings: readTimings(envelope?.timings),
    usage: readUsage(envelope?.usage),
    wallMs: performance.now() - startedAt,
    // Carried back so a caller whose parse fails can say WHY. `length` means the cap cut the
    // completion off mid-JSON, which is a budget the pack set rather than a model that
    // cannot write JSON — and those two have different fixes.
    finishReason: typeof envelope?.choices?.[0]?.finish_reason === 'string' ? envelope.choices[0].finish_reason : undefined,
  })
  return content
}

export const llamaChat = chat

/**
 * Provider interface: the seam the LLM transport is reached through.
 *
 * **llama.cpp is the only supported backend.** It is what the functions above speak to, what
 * every number in this repository was measured against, and what the preflight check looks
 * for. Nothing else is tested, and a result from another runtime is not comparable with one
 * here until someone has shown that it is — see the parity tests, which compare serialized
 * bytes rather than deep-equality for exactly that reason.
 *
 * The interface exists so the modes can be unit-tested without a server, and so an
 * out-of-tree profile can supply its own adapter at its own risk. That is a seam, not a
 * promise of portability: satisfying these four methods is the easy part, and reproducing a
 * grammar-constrained decode is not.
 */
export interface Provider {
  chat(o: ChatOptions): Promise<string>
  toolChat(o: ToolChatOptions): Promise<{ content: string | null; toolCalls: ToolCall[]; usage?: Usage }>
  streamChat(o: StreamChatOptions): Promise<StreamResult>
  identify(baseUrl?: string): Promise<ServerIdentity>
}

/** The default provider implementation backed by the built-in HTTP client. */
export const defaultProvider: Provider = {
  chat,
  toolChat,
  streamChat,
  identify: identifyServer,
}
