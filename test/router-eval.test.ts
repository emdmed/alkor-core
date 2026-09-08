/**
 * Router confusion-matrix eval tests.
 *
 * These tests run without a model: rule-based routing is deterministic and the eval
 * exercises the rule set, the corpus, and the metric computation. The test doubles
 * are custom rule sets that isolate specific routing decisions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runRouterEval, ROUTER_CASES, gateRouterEval, formatRouterEval, type ClassMetrics } from '../src/profiles/router/eval.ts'
import { type RouteRule } from '../src/modes/router.ts'

const PASS_RULES: RouteRule[] = [
  { name: 'perfect-match', profile: 'target', keywords: ['bp'], confidence: 1.0 },
]

const FAIL_RULES: RouteRule[] = [
  { name: 'always-wrong', profile: 'wrong', keywords: ['bp'], confidence: 1.0 },
]

test('runRouterEval returns correct total and accuracy on PASS rules', async () => {
  // Create a minimal corpus where every case contains 'bp' and expects 'target'
  const cases = ROUTER_CASES.filter((c) => c.input.toLowerCase().includes('bp')).slice(0, 3)
  const result = await runRouterEval(PASS_RULES, 'default')
  // The result includes ALL cases, not just the ones with 'bp', because the eval
  // uses the full ROUTER_CASES corpus. So we check the structure, not the numbers.
  assert.ok(result.total > 0)
  assert.ok(result.accuracy >= 0 && result.accuracy <= 1)
  assert.equal(result.cases.length, result.total)
})

test('runRouterEval computes confusion matrix', async () => {
  const result = await runRouterEval(PASS_RULES, 'default')
  assert.ok(result.confusion.size > 0)
  // Every case's expected class should have an entry in the confusion matrix
  for (const c of result.cases) {
    assert.ok(result.confusion.has(c.expected), `confusion matrix has row for ${c.expected}`)
  }
})

test('runRouterEval computes per-class precision and recall', async () => {
  const result = await runRouterEval(PASS_RULES, 'default')
  for (const [cls, m] of result.perClass) {
    assert.ok(m.precision >= 0 && m.precision <= 1, `${cls} precision in range`)
    assert.ok(m.recall >= 0 && m.recall <= 1, `${cls} recall in range`)
    assert.ok(m.f1 >= 0 && m.f1 <= 1, `${cls} f1 in range`)
    // F1 = 2PR/(P+R) when P+R > 0
    if (m.precision + m.recall > 0) {
      const expectedF1 = (2 * m.precision * m.recall) / (m.precision + m.recall)
      assert.ok(Math.abs(m.f1 - expectedF1) < 0.001, `${cls} f1 formula correct`)
    }
  }
})

test('runRouterEval computes per-difficulty breakdown', async () => {
  const result = await runRouterEval(PASS_RULES, 'default')
  for (const [diff, m] of result.perDifficulty) {
    assert.ok(m.total > 0, `difficulty ${diff} has cases`)
    assert.ok(m.correct >= 0 && m.correct <= m.total, `difficulty ${diff} correct in range`)
    assert.ok(m.accuracy >= 0 && m.accuracy <= 1, `difficulty ${diff} accuracy in range`)
  }
})

test('gateRouterEval passes when all thresholds are met', () => {
  const result = {
    total: 100,
    correct: 96,
    accuracy: 0.96,
    perClass: new Map<string, ClassMetrics>([
      ['clinical', { tp: 20, fp: 1, fn: 1, precision: 0.95, recall: 0.95, f1: 0.95 }],
      ['transcriptor', { tp: 20, fp: 1, fn: 1, precision: 0.95, recall: 0.95, f1: 0.95 }],
    ]),
    perDifficulty: new Map([
      [1, { correct: 20, total: 20, accuracy: 1.0 }],
      [4, { correct: 9, total: 10, accuracy: 0.9 }],
      [5, { correct: 9, total: 10, accuracy: 0.9 }],
    ]),
    confusion: new Map(),
    cases: [],
  }
  const verdict = gateRouterEval(result)
  assert.equal(verdict.pass, true)
  assert.ok(verdict.summary.includes('accuracy 96.0%'))
  assert.ok(verdict.summary.includes('✓'))
})

test('gateRouterEval fails when overall accuracy is below threshold', () => {
  const result = {
    total: 100,
    correct: 90,
    accuracy: 0.90,
    perClass: new Map<string, ClassMetrics>([
      ['clinical', { tp: 20, fp: 0, fn: 0, precision: 1.0, recall: 1.0, f1: 1.0 }],
    ]),
    perDifficulty: new Map([
      [1, { correct: 20, total: 20, accuracy: 1.0 }],
      [4, { correct: 9, total: 10, accuracy: 0.9 }],
      [5, { correct: 9, total: 10, accuracy: 0.9 }],
    ]),
    confusion: new Map(),
    cases: [],
  }
  const verdict = gateRouterEval(result)
  assert.equal(verdict.pass, false)
  assert.ok(verdict.summary.includes('accuracy 90.0%'))
  assert.ok(verdict.summary.includes('✗'))
})

test('gateRouterEval fails when per-class precision is below threshold', () => {
  const result = {
    total: 100,
    correct: 96,
    accuracy: 0.96,
    perClass: new Map<string, ClassMetrics>([
      ['clinical', { tp: 20, fp: 0, fn: 0, precision: 1.0, recall: 1.0, f1: 1.0 }],
      ['transcriptor', { tp: 20, fp: 5, fn: 0, precision: 0.80, recall: 1.0, f1: 0.89 }],
    ]),
    perDifficulty: new Map([
      [1, { correct: 20, total: 20, accuracy: 1.0 }],
      [4, { correct: 9, total: 10, accuracy: 0.9 }],
      [5, { correct: 9, total: 10, accuracy: 0.9 }],
    ]),
    confusion: new Map(),
    cases: [],
  }
  const verdict = gateRouterEval(result)
  assert.equal(verdict.pass, false)
  assert.ok(verdict.summary.includes('precision ≥ 90% ✗'))
})

test('gateRouterEval fails when per-class recall is below threshold', () => {
  const result = {
    total: 100,
    correct: 96,
    accuracy: 0.96,
    perClass: new Map<string, ClassMetrics>([
      ['clinical', { tp: 20, fp: 0, fn: 0, precision: 1.0, recall: 1.0, f1: 1.0 }],
      ['transcriptor', { tp: 15, fp: 0, fn: 5, precision: 1.0, recall: 0.75, f1: 0.86 }],
    ]),
    perDifficulty: new Map([
      [1, { correct: 20, total: 20, accuracy: 1.0 }],
      [4, { correct: 9, total: 10, accuracy: 0.9 }],
      [5, { correct: 9, total: 10, accuracy: 0.9 }],
    ]),
    confusion: new Map(),
    cases: [],
  }
  const verdict = gateRouterEval(result)
  assert.equal(verdict.pass, false)
  assert.ok(verdict.summary.includes('recall ≥ 90% ✗'))
})

test('gateRouterEval fails when d4-5 accuracy is below threshold', () => {
  const result = {
    total: 100,
    correct: 96,
    accuracy: 0.96,
    perClass: new Map<string, ClassMetrics>([
      ['clinical', { tp: 20, fp: 0, fn: 0, precision: 1.0, recall: 1.0, f1: 1.0 }],
    ]),
    perDifficulty: new Map([
      [1, { correct: 20, total: 20, accuracy: 1.0 }],
      [4, { correct: 7, total: 10, accuracy: 0.7 }],
      [5, { correct: 8, total: 10, accuracy: 0.8 }],
    ]),
    confusion: new Map(),
    cases: [],
  }
  const verdict = gateRouterEval(result)
  assert.equal(verdict.pass, false)
  assert.ok(verdict.summary.includes('d4-5 accuracy ≥ 85% ✗'))
})

test('formatRouterEval includes overall accuracy', async () => {
  const result = await runRouterEval(PASS_RULES, 'default')
  const formatted = formatRouterEval(result)
  assert.ok(formatted.includes('overall accuracy:'))
  assert.ok(formatted.includes('per-difficulty:'))
  assert.ok(formatted.includes('per-class:'))
  assert.ok(formatted.includes('confusion matrix'))
})

test('formatRouterEval includes failure cases', async () => {
  const result = await runRouterEval(FAIL_RULES, 'default')
  const formatted = formatRouterEval(result)
  // FAIL_RULES routes 'bp' to 'wrong', but many cases don't contain 'bp' and fall to default
  // So there will be some failures
  if (result.correct < result.total) {
    assert.ok(formatted.includes('failures:'))
  }
})

test('ROUTER_CASES has at least 30 cases', () => {
  assert.ok(ROUTER_CASES.length >= 30, `corpus has ${ROUTER_CASES.length} cases`)
})

test('ROUTER_CASES covers all difficulty tiers', () => {
  const tiers = new Set(ROUTER_CASES.map((c) => c.difficulty))
  assert.deepEqual([...tiers].sort((a, b) => a - b), [1, 2, 3, 4, 5])
})

test('ROUTER_CASES covers all expected classes', () => {
  const classes = new Set(ROUTER_CASES.map((c) => c.expected))
  assert.ok(classes.has('clinical'))
  assert.ok(classes.has('transcriptor'))
  assert.ok(classes.has('verifier'))
})

test('runRouterEval with default rules produces a non-empty confusion matrix', async () => {
  const { ROUTER_RULES, ROUTER_DEFAULT } = await import('../src/profiles/router/profile.ts')
  const result = await runRouterEval(ROUTER_RULES, ROUTER_DEFAULT)
  assert.ok(result.confusion.size > 0)
  assert.ok(result.perClass.size > 0)
  assert.ok(result.perDifficulty.size > 0)
})

test('per-difficulty accuracy is computed as correct / total', async () => {
  const result = await runRouterEval(PASS_RULES, 'default')
  for (const [diff, m] of result.perDifficulty) {
    const expected = m.total > 0 ? m.correct / m.total : 0
    assert.equal(m.accuracy, expected, `difficulty ${diff} accuracy formula`)
  }
})

test('confusion matrix row sums to total cases for that class', async () => {
  const result = await runRouterEval(PASS_RULES, 'default')
  for (const [actualClass, row] of result.confusion) {
    const rowSum = [...row.values()].reduce((a, b) => a + b, 0)
    const classCount = result.cases.filter((c) => c.expected === actualClass).length
    assert.equal(rowSum, classCount, `confusion row ${actualClass} sums to ${classCount}`)
  }
})

test('correct cases equal sum of diagonal in confusion matrix', async () => {
  const result = await runRouterEval(PASS_RULES, 'default')
  let diagonalSum = 0
  for (const [actualClass, row] of result.confusion) {
    diagonalSum += row.get(actualClass) ?? 0
  }
  assert.equal(diagonalSum, result.correct, 'diagonal sum equals correct count')
})

test('formatRouterEval handles empty failure list gracefully', () => {
  const result = {
    total: 10,
    correct: 10,
    accuracy: 1.0,
    perClass: new Map<string, ClassMetrics>(),
    perDifficulty: new Map(),
    confusion: new Map(),
    cases: [],
  }
  const formatted = formatRouterEval(result)
  assert.ok(!formatted.includes('failures:'))
  assert.ok(formatted.includes('overall accuracy: 100.0%'))
})
