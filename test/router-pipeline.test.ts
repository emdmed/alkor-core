/**
 * Router and pipeline modes: unit tests for classification and multi-model orchestration.
 *
 * The router is tested without a model: rule-based routing is deterministic and the unit
 * tests exist to pin the edge cases (overlapping rules, confidence precedence, default
 * fallback). Model-based routing is tested only in integration: a real model call is a
 * transport test, and the router's `modelRoute` function is a thin wrapper around the
 * same `llamaChat` that the extraction tests already exercise.
 *
 * The pipeline is tested with stub profiles that return fixed results, so the tests
 * exercise the orchestration logic (step order, input resolution, failure propagation)
 * without requiring a server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { route, type RouteRule, type RouterOptions } from '../src/modes/router.ts'
import { ROUTER_RULES as CLINICAL_RULES } from '../src/profiles/router/profile.ts'
import { runPipeline, buildPipeline, type PipelineStep, type PipelineOptions } from '../src/modes/pipeline.ts'
import type { ProfileModule, ReviewResult, EvalVerdict } from '../src/core/profile.ts'

// ---------------------------------------------------------------------------
// Router tests
// ---------------------------------------------------------------------------

test('route with keyword match selects the correct profile', async () => {
  const result = await route({
    input: 'Patient BP 120/80, HR 72',
    rules: CLINICAL_RULES,
    defaultProfile: 'unknown',
  })
  assert.equal(result.profile, 'clinical')
  assert.equal(result.confidence, 0.9)
  assert.ok(result.reason.includes('vitals-extraction'))
})

test('route with no match falls back to default', async () => {
  const result = await route({
    input: 'Hello, how are you today?',
    rules: CLINICAL_RULES,
    defaultProfile: 'general',
  })
  assert.equal(result.profile, 'general')
  assert.equal(result.confidence, 0)
  assert.ok(result.reason.includes('default'))
})

test('route with no rules and no model returns unknown', async () => {
  const result = await route({
    input: 'anything',
    defaultProfile: 'default',
  })
  assert.equal(result.profile, 'default')
  assert.equal(result.confidence, 0)
})

test('route with regex match selects the correct profile', async () => {
  const rules: RouteRule[] = [
    { name: 'bp-pattern', profile: 'vitals', regex: [/BP\s+\d{2,3}\/\d{2,3}/], confidence: 1.0 },
  ]
  const result = await route({ input: 'BP 120/80', rules, defaultProfile: 'unknown' })
  assert.equal(result.profile, 'vitals')
  assert.equal(result.confidence, 1.0)
})

test('route with predicate match selects the correct profile', async () => {
  const rules: RouteRule[] = [
    { name: 'short-input', profile: 'brief', predicate: (i) => i.length < 10, confidence: 1.0 },
  ]
  const result = await route({ input: 'hi', rules, defaultProfile: 'unknown' })
  assert.equal(result.profile, 'brief')
  assert.equal(result.confidence, 1.0)
})

test('higher confidence rule overrides earlier match', async () => {
  const rules: RouteRule[] = [
    { name: 'weak-match', profile: 'A', keywords: ['test'], confidence: 0.5 },
    { name: 'strong-match', profile: 'B', keywords: ['test'], confidence: 0.9 },
  ]
  const result = await route({ input: 'test', rules, defaultProfile: 'unknown' })
  assert.equal(result.profile, 'B')
  assert.equal(result.confidence, 0.9)
})

test('definitive confidence (1.0) short-circuits further rules', async () => {
  const rules: RouteRule[] = [
    { name: 'definitive', profile: 'A', keywords: ['test'], confidence: 1.0 },
    { name: 'later', profile: 'B', keywords: ['test'], confidence: 0.9 },
  ]
  const result = await route({ input: 'test', rules, defaultProfile: 'unknown' })
  assert.equal(result.profile, 'A')
  assert.equal(result.confidence, 1.0)
})

test('route is case-insensitive for keywords', async () => {
  const rules: RouteRule[] = [
    { name: 'bp', profile: 'vitals', keywords: ['BP'] },
  ]
  const result = await route({ input: 'bp 120/80', rules, defaultProfile: 'unknown' })
  assert.equal(result.profile, 'vitals')
})

test('multiple keywords in one rule: any match triggers', async () => {
  const rules: RouteRule[] = [
    { name: 'vitals', profile: 'clinical', keywords: ['bp', 'temp', 'hr'] },
  ]
  const result = await route({ input: 'temperature is 37.1', rules, defaultProfile: 'unknown' })
  assert.equal(result.profile, 'clinical')
})

// ---------------------------------------------------------------------------
// Pipeline tests
// ---------------------------------------------------------------------------

const mockExtractProfile = (name: string, returnValue: Record<string, unknown>): ProfileModule => ({
  name,
  mode: 'extract',
  needsPack: false,
  async review(): Promise<ReviewResult> {
    return { text: `mock ${name}`, ok: true, raw: JSON.stringify(returnValue), report: returnValue }
  },
  async runEval(): Promise<EvalVerdict> {
    return { pass: true, summary: 'mock eval' }
  },
})

const mockFailingProfile = (name: string): ProfileModule => ({
  name,
  mode: 'extract',
  needsPack: false,
  async review(): Promise<ReviewResult> {
    return { text: `mock ${name}`, ok: false, raw: 'error' }
  },
  async runEval(): Promise<EvalVerdict> {
    return { pass: false, summary: 'mock eval fail' }
  },
})

test('pipeline runs all steps and returns final output', async () => {
  const profiles = new Map<string, ProfileModule>([
    ['extractor', mockExtractProfile('extractor', { value: 'extracted' })],
    ['verifier', mockExtractProfile('verifier', { verified: true })],
  ])
  const packs = new Map<string, undefined>([['extractor', undefined], ['verifier', undefined]])
  const baseUrls = new Map<string, undefined>([['extractor', undefined], ['verifier', undefined]])

  const result = await runPipeline({
    initialInput: 'test document',
    steps: buildPipeline([
      { name: 'extract', profile: 'extractor' },
      { name: 'verify', profile: 'verifier', input: 'step-0' },
    ]),
    profiles,
    packs,
    baseUrls,
  })

  assert.equal(result.stoppedEarly, false)
  assert.equal(result.steps.length, 2)
  assert.equal(result.steps[0]!.ok, true)
  assert.equal(result.steps[1]!.ok, true)
  assert.equal((result.final as any)?.verified, true)
})

test('pipeline stops early on step failure', async () => {
  const profiles = new Map<string, ProfileModule>([
    ['extractor', mockFailingProfile('extractor')],
    ['verifier', mockExtractProfile('verifier', { verified: true })],
  ])
  const packs = new Map<string, undefined>([['extractor', undefined], ['verifier', undefined]])
  const baseUrls = new Map<string, undefined>([['extractor', undefined], ['verifier', undefined]])

  const result = await runPipeline({
    initialInput: 'test document',
    steps: buildPipeline([
      { name: 'extract', profile: 'extractor' },
      { name: 'verify', profile: 'verifier', input: 'step-0' },
    ]),
    profiles,
    packs,
    baseUrls,
  })

  assert.equal(result.stoppedEarly, true)
  assert.equal(result.steps.length, 1)
  assert.equal(result.steps[0]!.ok, false)
  assert.equal(result.final, undefined)
})

test('pipeline passes initial input to first step', async () => {
  let receivedInput: unknown
  const profile: ProfileModule = {
    name: 'echo',
    mode: 'extract',
    needsPack: false,
    async review(ctx): Promise<ReviewResult> {
      receivedInput = ctx.input.kind === 'text' ? ctx.input.text : ctx.input.name
      return { text: 'echo', ok: true, raw: 'echo' }
    },
    async runEval(): Promise<EvalVerdict> {
      return { pass: true, summary: 'echo' }
    },
  }

  const profiles = new Map<string, ProfileModule>([['echo', profile]])
  const packs = new Map<string, undefined>([['echo', undefined]])
  const baseUrls = new Map<string, undefined>([['echo', undefined]])

  await runPipeline({
    initialInput: 'hello world',
    steps: buildPipeline([{ name: 'echo', profile: 'echo' }]),
    profiles,
    packs,
    baseUrls,
  })

  assert.equal(receivedInput, 'hello world')
})

test('pipeline resolves input references across steps', async () => {
  const profiles = new Map<string, ProfileModule>([
    ['step1', mockExtractProfile('step1', { data: 'step1-output' })],
    ['step2', mockExtractProfile('step2', { data: 'step2-output' })],
  ])
  const packs = new Map<string, undefined>([['step1', undefined], ['step2', undefined]])
  const baseUrls = new Map<string, undefined>([['step1', undefined], ['step2', undefined]])

  let step2Input: unknown
  const step2WithCapture: ProfileModule = {
    name: 'step2',
    mode: 'extract',
    needsPack: false,
    async review(ctx): Promise<ReviewResult> {
      step2Input = ctx.input.kind === 'text' ? ctx.input.text : ctx.input.name
      return { text: 'step2', ok: true, raw: 'step2', report: { data: 'step2-output' } }
    },
    async runEval(): Promise<EvalVerdict> {
      return { pass: true, summary: 'step2' }
    },
  }
  profiles.set('step2', step2WithCapture)

  await runPipeline({
    initialInput: 'initial',
    steps: buildPipeline([
      { name: 'step1', profile: 'step1' },
      { name: 'step2', profile: 'step2', input: 'step-0' },
    ]),
    profiles,
    packs,
    baseUrls,
  })

  // The step2 input should be the step1 output (the report object).
  const parsed = JSON.parse(step2Input as string)
  assert.equal(parsed.data, 'step1-output')
})

test('pipeline resolves input.field references', async () => {
  let capturedInput: unknown
  const profile: ProfileModule = {
    name: 'step2',
    mode: 'extract',
    needsPack: false,
    async review(ctx): Promise<ReviewResult> {
      capturedInput = ctx.input.kind === 'text' ? ctx.input.text : ctx.input.name
      return { text: 'step2', ok: true, raw: 'step2' }
    },
    async runEval(): Promise<EvalVerdict> {
      return { pass: true, summary: 'step2' }
    },
  }

  const profiles = new Map<string, ProfileModule>([
    ['step1', mockExtractProfile('step1', { data: 'step1-data' })],
    ['step2', profile],
  ])
  const packs = new Map<string, undefined>([['step1', undefined], ['step2', undefined]])
  const baseUrls = new Map<string, undefined>([['step1', undefined], ['step2', undefined]])

  await runPipeline({
    initialInput: 'initial',
    steps: buildPipeline([
      { name: 'step1', profile: 'step1' },
      { name: 'step2', profile: 'step2', input: 'step-0', field: 'report' },
    ]),
    profiles,
    packs,
    baseUrls,
  })

  const parsed = JSON.parse(capturedInput as string)
  assert.equal(parsed.data, 'step1-data')
})

test('pipeline reports missing profile as failure', async () => {
  const profiles = new Map<string, ProfileModule>()
  const packs = new Map<string, undefined>()
  const baseUrls = new Map<string, undefined>()

  const result = await runPipeline({
    initialInput: 'test',
    steps: buildPipeline([{ name: 'missing', profile: 'nonexistent' }]),
    profiles,
    packs,
    baseUrls,
  })

  assert.equal(result.stoppedEarly, true)
  assert.equal(result.steps[0]!.ok, false)
  assert.ok(result.steps[0]!.error!.includes('not found'))
})

test('pipeline reports total wall time', async () => {
  const profiles = new Map<string, ProfileModule>([
    ['fast', mockExtractProfile('fast', { ok: true })],
  ])
  const packs = new Map<string, undefined>([['fast', undefined]])
  const baseUrls = new Map<string, undefined>([['fast', undefined]])

  const result = await runPipeline({
    initialInput: 'test',
    steps: buildPipeline([{ name: 'fast', profile: 'fast' }]),
    profiles,
    packs,
    baseUrls,
  })

  assert.equal(result.stoppedEarly, false)
  assert.ok(result.totalMs >= 0)
  assert.ok(result.totalMs < 1000, 'mock profile should be nearly instant')
})

test('buildPipeline converts simple objects to PipelineSteps', () => {
  const steps = buildPipeline([
    { name: 'a', profile: 'A' },
    { name: 'b', profile: 'B', input: 'step-0', field: 'report' },
  ])
  assert.equal(steps.length, 2)
  assert.equal(steps[0]!.name, 'a')
  assert.equal(steps[0]!.profile, 'A')
  assert.equal(steps[1]!.input, 'step-0')
  assert.equal(steps[1]!.field, 'report')
})

test('clinical pipeline routes vitals note to vital-signs via internal router', async () => {
  const { routeClinicalShape } = await import('../src/profiles/clinical/clinical-router.ts')

  const clinicalProfile: ProfileModule = {
    name: 'clinical',
    mode: 'extract',
    needsPack: false,
    async review(ctx): Promise<ReviewResult> {
      const text = ctx.input.kind === 'text' ? ctx.input.text : ctx.input.name
      const route = routeClinicalShape(text)
      return { text: `routed to ${route.task}`, ok: true, raw: JSON.stringify({ task: route.task }), report: { routedTask: route.task, shape: route.shape } }
    },
    async runEval(): Promise<EvalVerdict> {
      return { pass: true, summary: 'mock clinical eval' }
    },
  }

  const profiles = new Map<string, ProfileModule>([['clinical', clinicalProfile]])
  const packs = new Map<string, undefined>([['clinical', undefined]])
  const baseUrls = new Map<string, undefined>([['clinical', undefined]])

  const result = await runPipeline({
    initialInput: 'Patient BP 120/80, HR 72, feeling well.',
    steps: buildPipeline([{ name: 'extract', profile: 'clinical' }]),
    profiles,
    packs,
    baseUrls,
  })

  assert.equal(result.stoppedEarly, false)
  assert.equal(result.steps.length, 1)
  assert.equal(result.steps[0]!.ok, true)
  assert.equal((result.steps[0]!.report as any)?.routedTask, 'vital-signs')
  assert.equal((result.steps[0]!.report as any)?.shape, 'vitals-note')
})

test('clinical pipeline routes dialogue transcript to transcript via internal router', async () => {
  const { routeClinicalShape } = await import('../src/profiles/clinical/clinical-router.ts')

  const clinicalProfile: ProfileModule = {
    name: 'clinical',
    mode: 'extract',
    needsPack: false,
    async review(ctx): Promise<ReviewResult> {
      const text = ctx.input.kind === 'text' ? ctx.input.text : ctx.input.name
      const route = routeClinicalShape(text)
      return { text: `routed to ${route.task}`, ok: true, raw: JSON.stringify({ task: route.task }), report: { routedTask: route.task, shape: route.shape } }
    },
    async runEval(): Promise<EvalVerdict> {
      return { pass: true, summary: 'mock clinical eval' }
    },
  }

  const profiles = new Map<string, ProfileModule>([['clinical', clinicalProfile]])
  const packs = new Map<string, undefined>([['clinical', undefined]])
  const baseUrls = new Map<string, undefined>([['clinical', undefined]])

  const result = await runPipeline({
    initialInput: 'Doctor: How are you?\nPatient: I have chest pain.',
    steps: buildPipeline([{ name: 'extract', profile: 'clinical' }]),
    profiles,
    packs,
    baseUrls,
  })

  assert.equal(result.stoppedEarly, false)
  assert.equal(result.steps.length, 1)
  assert.equal(result.steps[0]!.ok, true)
  assert.equal((result.steps[0]!.report as any)?.routedTask, 'transcript')
  assert.equal((result.steps[0]!.report as any)?.shape, 'dialogue')
})

test('clinical pipeline explicit --task overrides internal router', async () => {
  const { routeClinicalShape } = await import('../src/profiles/clinical/clinical-router.ts')

  const clinicalProfile: ProfileModule = {
    name: 'clinical',
    mode: 'extract',
    needsPack: false,
    async review(ctx): Promise<ReviewResult> {
      // Simulate explicit --task override: skip the router
      const task = ctx.options.task === 'transcript' ? 'transcript' : (routeClinicalShape(ctx.input.kind === 'text' ? ctx.input.text : ctx.input.name).task)
      return { text: `routed to ${task}`, ok: true, raw: JSON.stringify({ task }), report: { routedTask: task } }
    },
    async runEval(): Promise<EvalVerdict> {
      return { pass: true, summary: 'mock clinical eval' }
    },
  }

  const profiles = new Map<string, ProfileModule>([['clinical', clinicalProfile]])
  const packs = new Map<string, undefined>([['clinical', undefined]])
  const baseUrls = new Map<string, undefined>([['clinical', undefined]])

  const result = await runPipeline({
    initialInput: 'Patient BP 120/80, HR 72, feeling well.',
    steps: buildPipeline([{ name: 'extract', profile: 'clinical', options: { task: 'transcript' } }]),
    profiles,
    packs,
    baseUrls,
  })

  assert.equal(result.stoppedEarly, false)
  assert.equal(result.steps.length, 1)
  assert.equal(result.steps[0]!.ok, true)
  assert.equal((result.steps[0]!.report as any)?.routedTask, 'transcript')
})

test('router profile eval runs confusion matrix and reports accuracy', async () => {
  const { PROFILE } = await import('../src/profiles/router/profile.ts')
  const verdict = await PROFILE.runEval({
    config: { name: 'router', mode: 'router' } as any,
    baseUrl: undefined,
    trace: { write: () => {}, close: () => {} } as any,
    options: {},
  })
  // The confusion matrix eval with the current rules does not clear the gate (63% accuracy).
  // What we assert is that it runs and produces a meaningful summary with the expected format.
  assert.ok(verdict.summary.includes('accuracy'))
  assert.ok(verdict.summary.includes('per-class precision'))
  assert.ok(verdict.summary.includes('per-class recall'))
  assert.ok(verdict.summary.includes('d4-5 accuracy'))
})

test('verifier profile eval detects missing quote', async () => {
  const { PROFILE } = await import('../src/profiles/verifier/profile.ts')
  // The verifier needs a pack, so we skip this test if the pack is not present.
  // This is the same pattern the clinical tests use: pack-dependent tests skip when
  // the pack is absent on a checkout that does not carry the reference data.
  try {
    const { loadPack, resolvePackRoot } = await import('../src/core/pack.ts')
    const pack = loadPack(resolvePackRoot('verifier', { configured: 'packs/verifier', base: process.cwd() }))
    const verdict = await PROFILE.runEval({
      config: { name: 'verifier', mode: 'extract', pack: 'packs/verifier' } as any,
      pack,
      baseUrl: undefined,
      trace: { write: () => {}, close: () => {} } as any,
      options: {},
    })
    // The verifier eval may or may not pass depending on the model availability.
    // What we assert here is that it runs and produces a summary.
    assert.ok(verdict.summary.length > 0)
  } catch (e: any) {
    if (e.message?.includes('pack') || e.message?.includes('manifest')) {
      console.log('SKIP: verifier pack not available')
      return
    }
    throw e
  }
})

// ---------------------------------------------------------------------------
// Context directory / checkpoint tests
// ---------------------------------------------------------------------------

test('pipeline writes checkpoint to context directory after each step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-pipeline-'))
  try {
    const profiles = new Map<string, ProfileModule>([
      ['step1', mockExtractProfile('step1', { data: 'step1-data' })],
      ['step2', mockExtractProfile('step2', { data: 'step2-data' })],
    ])
    const packs = new Map<string, undefined>([['step1', undefined], ['step2', undefined]])
    const baseUrls = new Map<string, undefined>([['step1', undefined], ['step2', undefined]])

    await runPipeline({
      initialInput: 'initial',
      steps: buildPipeline([
        { name: 'step1', profile: 'step1' },
        { name: 'step2', profile: 'step2', input: 'step-0', field: 'report' },
      ]),
      profiles,
      packs,
      baseUrls,
      contextDir: dir,
    })

    assert.ok(existsSync(join(dir, 'context.json')), 'context.json should exist')
    assert.ok(existsSync(join(dir, 'step-0.json')), 'step-0.json should exist')
    assert.ok(existsSync(join(dir, 'step-1.json')), 'step-1.json should exist')

    const context = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'))
    assert.equal(context.completedStep, 1)
    assert.equal(context.initialInput, 'initial')
    assert.equal(context.results.length, 2)
    assert.equal(context.state['initial'], 'initial')
    assert.equal(context.state['step-0'].output.data, 'step1-data')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pipeline resumes from checkpoint and skips completed steps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-pipeline-'))
  try {
    let step2Called = false
    const step2Profile: ProfileModule = {
      name: 'step2',
      mode: 'extract',
      needsPack: false,
      async review(ctx): Promise<ReviewResult> {
        step2Called = true
        return { text: 'step2', ok: true, raw: 'step2', report: { data: 'step2-resumed' } }
      },
      async runEval(): Promise<EvalVerdict> {
        return { pass: true, summary: 'step2' }
      },
    }

    const profiles = new Map<string, ProfileModule>([
      ['step1', mockExtractProfile('step1', { data: 'step1-data' })],
      ['step2', step2Profile],
    ])
    const packs = new Map<string, undefined>([['step1', undefined], ['step2', undefined]])
    const baseUrls = new Map<string, undefined>([['step1', undefined], ['step2', undefined]])

    // First run: only step 0 completes.
    await runPipeline({
      initialInput: 'initial',
      steps: buildPipeline([
        { name: 'step1', profile: 'step1' },
        { name: 'step2', profile: 'step2', input: 'step-0', field: 'report' },
      ]),
      profiles,
      packs,
      baseUrls,
      contextDir: dir,
      runStep: 0,
    })

    assert.ok(!step2Called, 'step 2 should not be called on first run')

    // Second run: resume from step 1.
    const result = await runPipeline({
      initialInput: 'initial',
      steps: buildPipeline([
        { name: 'step1', profile: 'step1' },
        { name: 'step2', profile: 'step2', input: 'step-0', field: 'report' },
      ]),
      profiles,
      packs,
      baseUrls,
      contextDir: dir,
    })

    assert.ok(step2Called, 'step 2 should be called on resume')
    assert.equal(result.steps.length, 2)
    assert.equal((result.final as any).data, 'step2-resumed')
    assert.equal(result.stoppedEarly, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pipeline runStep 0 overwrites existing checkpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-pipeline-'))
  try {
    const profiles = new Map<string, ProfileModule>([
      ['step1', mockExtractProfile('step1', { data: 'first' })],
    ])
    const packs = new Map<string, undefined>([['step1', undefined]])
    const baseUrls = new Map<string, undefined>([['step1', undefined]])

    // First run.
    await runPipeline({
      initialInput: 'first-run',
      steps: buildPipeline([{ name: 'step1', profile: 'step1' }]),
      profiles,
      packs,
      baseUrls,
      contextDir: dir,
      runStep: 0,
    })

    const first = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'))
    assert.equal(first.initialInput, 'first-run')

    // Re-run step 0 with different input.
    profiles.set('step1', mockExtractProfile('step1', { data: 'second' }))
    await runPipeline({
      initialInput: 'second-run',
      steps: buildPipeline([{ name: 'step1', profile: 'step1' }]),
      profiles,
      packs,
      baseUrls,
      contextDir: dir,
      runStep: 0,
    })

    const second = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'))
    assert.equal(second.initialInput, 'second-run')
    assert.equal(second.state['step-0'].output.data, 'second')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pipeline runStep > 0 throws when no checkpoint exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-pipeline-'))
  try {
    const profiles = new Map<string, ProfileModule>([['step2', mockExtractProfile('step2', { data: 'x' })]])
    const packs = new Map<string, undefined>([['step2', undefined]])
    const baseUrls = new Map<string, undefined>([['step2', undefined]])

    await assert.rejects(
      runPipeline({
        initialInput: 'initial',
        steps: buildPipeline([{ name: 'step1', profile: 'step1' }, { name: 'step2', profile: 'step2' }]),
        profiles,
        packs,
        baseUrls,
        contextDir: dir,
        runStep: 1,
      }),
      /no checkpoint/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pipeline re-running a step replaces the old result in the checkpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-pipeline-'))
  try {
    let callCount = 0
    const step2Profile: ProfileModule = {
      name: 'step2',
      mode: 'extract',
      needsPack: false,
      async review(): Promise<ReviewResult> {
        callCount++
        return { text: `call-${callCount}`, ok: true, raw: `call-${callCount}`, report: { count: callCount } }
      },
      async runEval(): Promise<EvalVerdict> {
        return { pass: true, summary: 'step2' }
      },
    }

    const profiles = new Map<string, ProfileModule>([
      ['step1', mockExtractProfile('step1', { data: 'step1' })],
      ['step2', step2Profile],
    ])
    const packs = new Map<string, undefined>([['step1', undefined], ['step2', undefined]])
    const baseUrls = new Map<string, undefined>([['step1', undefined], ['step2', undefined]])

    // Run full pipeline once.
    await runPipeline({
      initialInput: 'initial',
      steps: buildPipeline([
        { name: 'step1', profile: 'step1' },
        { name: 'step2', profile: 'step2', input: 'step-0' },
      ]),
      profiles,
      packs,
      baseUrls,
      contextDir: dir,
    })

    assert.equal(callCount, 1)
    const first = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'))
    assert.equal(first.results.length, 2)
    assert.equal(first.results[1].text, 'call-1')

    // Re-run step 1 only (the second step, profile step2).
    await runPipeline({
      initialInput: 'initial',
      steps: buildPipeline([
        { name: 'step1', profile: 'step1' },
        { name: 'step2', profile: 'step2', input: 'step-0' },
      ]),
      profiles,
      packs,
      baseUrls,
      contextDir: dir,
      runStep: 1,
    })

    assert.equal(callCount, 2)
    const second = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'))
    assert.equal(second.results.length, 2)
    assert.equal(second.results[1].text, 'call-2')
    // Step 0 should be unchanged.
    assert.equal(second.results[0].text, 'mock step1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pipeline failure still writes checkpoint so resume can continue after a fix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-pipeline-'))
  try {
    let secondAttempt = false
    const flakyProfile: ProfileModule = {
      name: 'flaky',
      mode: 'extract',
      needsPack: false,
      async review(): Promise<ReviewResult> {
        if (!secondAttempt) {
          throw new Error('server not ready: model not loaded yet')
        }
        return { text: 'ok', ok: true, raw: 'ok', report: { fixed: true } }
      },
      async runEval(): Promise<EvalVerdict> {
        return { pass: true, summary: 'flaky' }
      },
    }

    const profiles = new Map<string, ProfileModule>([
      ['step1', mockExtractProfile('step1', { data: 'step1' })],
      ['flaky', flakyProfile],
    ])
    const packs = new Map<string, undefined>([['step1', undefined], ['flaky', undefined]])
    const baseUrls = new Map<string, undefined>([['step1', undefined], ['flaky', undefined]])

    // First run: step 1 fails.
    const first = await runPipeline({
      initialInput: 'initial',
      steps: buildPipeline([
        { name: 'step1', profile: 'step1' },
        { name: 'flaky', profile: 'flaky', input: 'step-0' },
      ]),
      profiles,
      packs,
      baseUrls,
      contextDir: dir,
    })

    assert.equal(first.stoppedEarly, true)
    assert.equal(first.steps.length, 2)
    assert.ok(first.steps[1]!.error!.includes('server not ready'))

    // Checkpoint should exist with the failure recorded.
    const checkpoint = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'))
    assert.equal(checkpoint.completedStep, 1)
    assert.equal(checkpoint.results[1].ok, false)

    // Fix the issue and resume.
    secondAttempt = true
    const second = await runPipeline({
      initialInput: 'initial',
      steps: buildPipeline([
        { name: 'step1', profile: 'step1' },
        { name: 'flaky', profile: 'flaky', input: 'step-0' },
      ]),
      profiles,
      packs,
      baseUrls,
      contextDir: dir,
    })

    assert.equal(second.stoppedEarly, false)
    assert.equal(second.steps.length, 2)
    assert.equal((second.final as any).fixed, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pipeline re-run truncates stale downstream results and state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-pipeline-'))
  try {
    const profiles = new Map<string, ProfileModule>([
      ['step1', mockExtractProfile('step1', { data: 'step1-v1' })],
      ['step2', mockExtractProfile('step2', { data: 'step2-v1' })],
      ['step3', mockExtractProfile('step3', { data: 'step3-v1' })],
    ])
    const packs = new Map<string, undefined>([['step1', undefined], ['step2', undefined], ['step3', undefined]])
    const baseUrls = new Map<string, undefined>([['step1', undefined], ['step2', undefined], ['step3', undefined]])

    // Run full pipeline.
    await runPipeline({
      initialInput: 'initial',
      steps: buildPipeline([
        { name: 'step1', profile: 'step1' },
        { name: 'step2', profile: 'step2', input: 'step-0' },
        { name: 'step3', profile: 'step3', input: 'step-1' },
      ]),
      profiles,
      packs,
      baseUrls,
      contextDir: dir,
    })

    const first = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'))
    assert.equal(first.results.length, 3)
    assert.equal(first.state['step-1'].output.data, 'step2-v1')
    assert.equal(first.state['step-2'].output.data, 'step3-v1')

    // Re-run step 1 with updated profile.
    profiles.set('step2', mockExtractProfile('step2', { data: 'step2-v2' }))
    const result = await runPipeline({
      initialInput: 'initial',
      steps: buildPipeline([
        { name: 'step1', profile: 'step1' },
        { name: 'step2', profile: 'step2', input: 'step-0' },
        { name: 'step3', profile: 'step3', input: 'step-1' },
      ]),
      profiles,
      packs,
      baseUrls,
      contextDir: dir,
      runStep: 1,
    })

    assert.equal(result.steps.length, 2)
    assert.equal((result.steps[0]!.output as any).data, 'step1-v1')
    assert.equal((result.steps[1]!.output as any).data, 'step2-v2')
    assert.equal(result.stoppedEarly, false)
    // Final must be the highest step, not the last array element.
    assert.equal((result.final as any).data, 'step2-v2')

    const second = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'))
    assert.equal(second.results.length, 2)
    assert.equal(second.state['step-1'].output.data, 'step2-v2')
    assert.equal(second.state['step-2'], undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
