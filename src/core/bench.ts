/**
 * What a run COST, counted the same way its correctness is: per case, from the server, on
 * the graded pass itself.
 *
 * There is no separate benchmark verb, and that is the point. A timing pass that ran its
 * own prompts would measure something adjacent to the product — a different cap, a cold
 * cache, a shorter note — and the two numbers would drift apart exactly as a measured
 * contract and a used contract do. The eval already sends the bytes the application sends;
 * timing them costs one extra field in the trace and nothing in the request body.
 *
 * **Everything here is server-counted except `wallMs`.** llama-server returns a `timings`
 * object unasked on the non-streamed path: prompt tokens and milliseconds, predicted tokens
 * and milliseconds, and how much of the prompt came out of the KV cache. Those are counted
 * with the model's own tokeniser inside the process doing the work. `wallMs` is the client
 * round-trip and is deliberately kept apart from them: the gap between the two is transport
 * and queueing, which is real cost an application pays and which a server-side number will
 * never show.
 *
 * A timing figure is worth less than a correctness figure and must be read with more care:
 * it belongs to a machine, a build, a quantisation, a context size, a slot count and a
 * thermal state, none of which the pack can pin. `benchConditions` in the trace records the
 * ones the server will admit to. The rest is why a speed claim names a machine or is not a
 * claim.
 */

/** One completion, as the server counted it. */
export interface Timings {
  /** Prompt tokens evaluated — NOT including the ones served from cache. */
  promptTokens: number
  promptMs: number
  predictedTokens: number
  predictedMs: number
  /** Prompt tokens the KV cache already held. The `cache_prompt` claim, as a number. */
  cachedTokens: number
}

/**
 * One graded case-run: the server's counts plus what the caller waited.
 *
 * `attempts` is 2 when the first request failed at transport and `extract` retried. A retry
 * doubles the latency an application sees, so it is summed into `wallMs` rather than hidden —
 * a model that needs a second pass on a fifth of the corpus is slower in the only sense that
 * matters, and a per-attempt average would report it as fast.
 *
 * It counts requests SENT, which is not the same as completions read, and the difference was
 * a real undercount: this field was once derived from the array of per-completion metrics,
 * which only fills in after a reply has been parsed out of the envelope. So the one case worth
 * counting — an attempt that died at transport and a retry that worked — reported one attempt,
 * zero retries, and none of the seconds it spent failing. `extract` now counts both halves and
 * hands them over separately; see ExtractOutcome.
 */
export interface BenchSample extends Timings {
  case: string
  wallMs: number
  attempts: number
}

export interface BenchSummary {
  samples: number
  retries: number
  wall: {
    totalMs: number
    /** The FIRST sample, kept apart: it pays the cold KV cache the other 20 inherit. */
    firstMs: number
    medianMs: number
    p95Ms: number
    minMs: number
    maxMs: number
  }
  generation: { tokens: number; ms: number; perSecond: number }
  prompt: {
    tokens: number
    ms: number
    perSecond: number
    cachedTokens: number
    /** Share of prompt tokens that never had to be evaluated. */
    cachedShare: number
  }
  /** Wall time the server did not account for: transport, queueing, JSON. */
  overheadMs: number
}

/**
 * Nearest-rank, on a copy. p95 over 21 samples IS the maximum — the rank lands there — so
 * the printed block states the sample count beside it. A percentile quoted without its n is
 * how a single slow case becomes a tail latency.
 */
export const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[Math.min(rank, sorted.length) - 1]!
}

export const median = (values: number[]): number => percentile(values, 50)

/**
 * Aggregate throughput is total tokens over total milliseconds — NOT the mean of the
 * per-case rates. The two differ whenever cases differ in length, and the mean flatters:
 * it gives a 40-token reply the same vote as a 400-token one, so a corpus of short notes
 * with one long one reports a speed no request achieved.
 */
const rate = (tokens: number, ms: number): number => (ms > 0 ? (tokens / ms) * 1000 : 0)

export const summarizeBench = (samples: BenchSample[]): BenchSummary => {
  const walls = samples.map((s) => s.wallMs)
  const sum = (f: (s: BenchSample) => number) => samples.reduce((n, s) => n + f(s), 0)

  const promptTokens = sum((s) => s.promptTokens)
  const cachedTokens = sum((s) => s.cachedTokens)
  const promptMs = sum((s) => s.promptMs)
  const predictedTokens = sum((s) => s.predictedTokens)
  const predictedMs = sum((s) => s.predictedMs)
  const totalMs = sum((s) => s.wallMs)

  return {
    samples: samples.length,
    retries: sum((s) => Math.max(0, s.attempts - 1)),
    wall: {
      totalMs,
      firstMs: samples[0]?.wallMs ?? 0,
      medianMs: median(walls),
      p95Ms: percentile(walls, 95),
      minMs: walls.length ? Math.min(...walls) : 0,
      maxMs: walls.length ? Math.max(...walls) : 0,
    },
    generation: { tokens: predictedTokens, ms: predictedMs, perSecond: rate(predictedTokens, predictedMs) },
    prompt: {
      tokens: promptTokens,
      ms: promptMs,
      perSecond: rate(promptTokens, promptMs),
      cachedTokens,
      // Denominator is evaluated + cached, which is the whole prompt. `promptTokens` alone
      // would report 100% reuse as 0%.
      cachedShare: promptTokens + cachedTokens > 0 ? cachedTokens / (promptTokens + cachedTokens) : 0,
    },
    // Never negative: the server's clock and the client's are not the same clock, and a
    // round-trip that comes back faster than the sum of its parts is a measurement artefact
    // rather than negative overhead.
    overheadMs: Math.max(0, totalMs - promptMs - predictedMs),
  }
}

/**
 * The conditions a timing claim is only valid under, as the SERVER reports them.
 *
 * Read rather than declared, for the same reason the model label is read: the pack can say
 * what it expects, but the flags that decide a speed — how many layers are on the GPU, how
 * many slots split the cache, how large the context is — belong to whoever started the
 * process. A quantisation is in here because `models.default.toml` names one file and a
 * server may be serving another.
 */
export interface BenchConditions {
  modelPath?: string
  quant?: string
  ctx?: number
  slots?: number
}

const ms = (n: number): string => (n >= 10000 ? `${(n / 1000).toFixed(1)}s` : `${n.toFixed(0)}ms`)

/**
 * The printed block. Deliberately states its own denominators: a reader who cannot see
 * whether 24 tok/s came from 21 samples or from one has been given a number to quote rather
 * than a number to check.
 */
export const formatBench = (b: BenchSummary, conditions?: BenchConditions): string[] => {
  const lines = [
    `generation  ${b.generation.perSecond.toFixed(1)} tok/s   ` +
      `(${b.generation.tokens} tokens in ${ms(b.generation.ms)}, server-counted)`,
    `prompt      ${b.prompt.perSecond.toFixed(1)} tok/s   ` +
      `(${b.prompt.tokens} evaluated, ${b.prompt.cachedTokens} from cache = ` +
      `${(b.prompt.cachedShare * 100).toFixed(0)}% reuse)`,
    `latency     median ${ms(b.wall.medianMs)}  p95 ${ms(b.wall.p95Ms)}  ` +
      `min ${ms(b.wall.minMs)}  max ${ms(b.wall.maxMs)}   over ${b.samples} case-runs`,
    `first case  ${ms(b.wall.firstMs)}   cold cache, counted in the total and named here`,
    `wall total  ${ms(b.wall.totalMs)}   of which ${ms(b.overheadMs)} is transport, not the model` +
      (b.retries ? `   ·   ${b.retries} retried case${b.retries === 1 ? '' : 's'}` : ''),
  ]
  if (conditions) {
    lines.push(
      `conditions  ${conditions.quant ?? '(quant unknown)'} · ctx ${conditions.ctx ?? '?'} · ` +
        `${conditions.slots ?? '?'} slot(s) · sequential, cache_prompt on — a speed belongs to a machine`,
    )
  }
  return lines
}
