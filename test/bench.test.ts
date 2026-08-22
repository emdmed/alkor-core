/**
 * The cost side of a run, checked without a model.
 *
 * A timing figure fails the same way a score does: it does not look like an error, it looks
 * like a number. Every test here is about a plausible wrong answer — a mean of rates instead
 * of an aggregate rate, a cache share computed against the wrong denominator, a retry
 * counted as one request, a missing `timings` object aggregated as zero.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBench, median, percentile, summarizeBench, type BenchSample } from '../src/core/bench.ts'

const sample = (over: Partial<BenchSample> = {}): BenchSample => ({
  case: 'c',
  wallMs: 1000,
  attempts: 1,
  promptTokens: 100,
  promptMs: 200,
  predictedTokens: 50,
  predictedMs: 500,
  cachedTokens: 0,
  ...over,
})

test('percentile is nearest-rank, and p95 of a small sample IS the maximum', () => {
  const v = [10, 20, 30, 40, 50]
  assert.equal(percentile(v, 50), 30)
  assert.equal(percentile(v, 95), 50, 'five samples cannot resolve a 95th percentile')
  assert.equal(percentile(v, 0), 10, 'a zero percentile must not index -1')
  assert.equal(percentile([], 95), 0)
  // Order of arrival must not matter, and the caller's array must not be reordered.
  const unsorted = [50, 10, 30]
  assert.equal(median(unsorted), 30)
  assert.deepEqual(unsorted, [50, 10, 30], 'summarising must not mutate the samples')
})

/**
 * The failure this file exists for. Averaging per-case rates gives a 40-token reply the
 * same vote as a 400-token one, so a corpus of short notes with one long one reports a
 * speed no request achieved. Aggregate is total tokens over total milliseconds.
 */
test('throughput is total tokens over total time, not the mean of per-case rates', () => {
  const b = summarizeBench([
    sample({ predictedTokens: 10, predictedMs: 1000 }), // 10 tok/s
    sample({ predictedTokens: 900, predictedMs: 9000 }), // 100 tok/s
  ])
  assert.equal(b.generation.tokens, 910)
  assert.equal(b.generation.ms, 10000)
  assert.equal(b.generation.perSecond, 91, 'the mean of 10 and 100 would be 55')
})

test('cache reuse is a share of the WHOLE prompt, evaluated plus cached', () => {
  const b = summarizeBench([sample({ promptTokens: 20, cachedTokens: 980 })])
  assert.equal(b.prompt.cachedShare, 0.98)
  // The interesting boundary: a fully cached prompt evaluates zero tokens. Dividing by the
  // evaluated count alone would report total reuse as no reuse.
  const all = summarizeBench([sample({ promptTokens: 0, cachedTokens: 1000 })])
  assert.equal(all.prompt.cachedShare, 1)
  const none = summarizeBench([sample({ promptTokens: 0, cachedTokens: 0 })])
  assert.equal(none.prompt.cachedShare, 0, 'no prompt at all must not divide by zero')
})

test('a retried case is one sample that cost two passes', () => {
  const b = summarizeBench([sample({ attempts: 2, wallMs: 2500 }), sample()])
  assert.equal(b.samples, 2, 'a retry is not a second case')
  assert.equal(b.retries, 1)
  assert.equal(b.wall.maxMs, 2500, 'the caller waited for both passes')
})

test('the first case is named apart, because it pays the cold cache', () => {
  const b = summarizeBench([sample({ wallMs: 9000 }), sample({ wallMs: 1000 }), sample({ wallMs: 1200 })])
  assert.equal(b.wall.firstMs, 9000)
  assert.equal(b.wall.medianMs, 1200, 'the cold start must not drag the median')
  assert.equal(b.wall.totalMs, 11200, 'and it is still counted in the total')
})

/**
 * Overhead is what the server never saw. It is the argument for measuring a client-side
 * clock at all, and it must not go negative when the two clocks disagree.
 */
test('overhead is wall time the server did not account for, and never negative', () => {
  const b = summarizeBench([sample({ wallMs: 1000, promptMs: 200, predictedMs: 500 })])
  assert.equal(b.overheadMs, 300)
  const skewed = summarizeBench([sample({ wallMs: 100, promptMs: 200, predictedMs: 500 })])
  assert.equal(skewed.overheadMs, 0, 'a round-trip faster than its parts is skew, not a negative cost')
})

/**
 * A server that reports no timings contributes zeros to the token counts, and a zero
 * denominator must not become an infinite or NaN rate — that is the shape in which an
 * unmeasured run gets quoted as a measured one.
 */
test('an unmeasured sample yields no rate rather than a nonsense one', () => {
  const b = summarizeBench([sample({ promptTokens: 0, promptMs: 0, predictedTokens: 0, predictedMs: 0 })])
  assert.equal(b.generation.perSecond, 0)
  assert.equal(b.prompt.perSecond, 0)
  assert.ok(Number.isFinite(b.generation.perSecond) && Number.isFinite(b.prompt.perSecond))
})

test('the printed block states its own denominators', () => {
  const lines = formatBench(summarizeBench([sample(), sample()]), { quant: 'Q4_K_M', ctx: 32768, slots: 1 }).join('\n')
  assert.match(lines, /tok\/s/)
  assert.match(lines, /over 2 case-runs/, 'a percentile without its n is how one slow case becomes a tail')
  assert.match(lines, /Q4_K_M/, 'a speed belongs to a quantisation')
  assert.match(lines, /ctx 32768/)
})
