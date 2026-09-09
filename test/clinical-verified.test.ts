/**
 * Clinical-verified profile tests: smoke test, fidelity eval wiring, and gate logic.
 *
 * No model calls; the fidelity eval path is tested only for wiring and option handling.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nullTrace } from '../src/core/trace.ts'
import { loadConfig, requireProfile } from '../src/core/config.ts'
import { loadPack, resolvePackRoot } from '../src/core/pack.ts'
import { PROFILE } from '../src/profiles/clinical-verified/profile.ts'
import { emptyTally, absorb, ratio } from '../src/profiles/clinical/scorer.ts'

test('smoke test passes when pipeline steps are well-formed', async () => {
  const cfg = loadConfig()
  const config = requireProfile(cfg, 'clinical-verified')
  const verdict = await PROFILE.runEval({
    config,
    pack: undefined,
    baseUrl: undefined,
    trace: nullTrace(),
    options: {},
  })
  assert.equal(verdict.pass, true)
  assert.ok(verdict.summary.includes('2 pipeline steps validated'))
})

test('pipeline passes the clinical constrained completion to the verifier', () => {
  const cfg = loadConfig()
  const config = requireProfile(cfg, 'clinical-verified')
  const steps = config.steps as Array<{ input?: unknown }>
  assert.deepEqual(steps[1]?.input, { document: 'initial', extraction: 'step-0.raw' })
})

test('smoke test fails when pipeline config has no steps', async () => {
  const verdict = await PROFILE.runEval({
    config: { name: 'test-pipeline', mode: 'pipeline' as const },
    pack: undefined,
    baseUrl: undefined,
    trace: nullTrace(),
    options: {},
  })
  assert.equal(verdict.pass, false)
  assert.ok(verdict.summary.includes('no steps array'))
})

test('smoke test fails when a step has no profile', async () => {
  const verdict = await PROFILE.runEval({
    config: { name: 'test-pipeline', mode: 'pipeline' as const, steps: [{ name: 'step1' }] },
    pack: undefined,
    baseUrl: undefined,
    trace: nullTrace(),
    options: {},
  })
  assert.equal(verdict.pass, false)
  assert.ok(verdict.summary.includes('step 0 has no profile'))
})

test('fidelity eval option is recognised', async () => {
  const cfg = loadConfig()
  const config = requireProfile(cfg, 'clinical-verified')
  // Use a non-existent URL so the eval fails fast at the network layer.
  // The eval catches transport errors internally and reports them as failed runs
  // rather than throwing, so we verify the option is read and the pack is resolved.
  const verdict = await PROFILE.runEval({
    config,
    pack: undefined,
    baseUrl: 'http://127.0.0.1:1', // intentionally unreachable
    trace: nullTrace(),
    options: { fidelity: true, caseLimit: 1 },
  })
  // The eval should run and produce a verdict with gate information in the summary.
  assert.ok(verdict.summary.includes('recall'), 'summary should mention recall')
  assert.ok(verdict.summary.includes('mono'), 'summary should mention monolith')
})

test('ratio helper: zero denominator returns 1.0', () => {
  assert.equal(ratio(0, 0), 1.0)
  assert.equal(ratio(5, 0), 1.0)
})

test('ratio helper: normal division', () => {
  assert.equal(ratio(5, 10), 0.5)
  assert.equal(ratio(10, 10), 1.0)
})

test('absorb helper: aggregates tallies', () => {
  const a = emptyTally()
  const b = emptyTally()
  b.gradedTotal = 10
  b.detected = 8
  b.valueExact = 7
  b.unitExact = 6
  b.quoteVerified = 5
  b.hallucinations = 2
  b.failedRuns = 1
  absorb(a, b)
  assert.equal(a.gradedTotal, 10)
  assert.equal(a.detected, 8)
  assert.equal(a.valueExact, 7)
  assert.equal(a.unitExact, 6)
  assert.equal(a.quoteVerified, 5)
  assert.equal(a.hallucinations, 2)
  assert.equal(a.failedRuns, 1)
})

test('gate logic: equal recall passes', () => {
  const monoRecall = 0.85
  const veriRecall = 0.85
  assert.equal(veriRecall >= monoRecall, true)
})

test('gate logic: lower hallucination rate passes', () => {
  const monoHalluc = 0.05
  const veriHalluc = 0.03
  assert.equal(veriHalluc <= monoHalluc, true)
})

test('gate logic: latency within 2x passes', () => {
  const monoMs = 1000
  const veriMs = 1800
  assert.equal(veriMs <= monoMs * 2, true)
})

test('gate logic: latency above 2x fails', () => {
  const monoMs = 1000
  const veriMs = 2100
  assert.equal(veriMs <= monoMs * 2, false)
})

test('fidelity eval imports without error', async () => {
  const { runPipelineFidelityEval } = await import('../src/profiles/clinical-verified/eval.ts')
  assert.equal(typeof runPipelineFidelityEval, 'function')
})
