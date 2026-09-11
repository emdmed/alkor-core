/**
 * Full routing and flow integration tests.
 *
 * Five end-to-end scenarios that exercise the complete pipeline:
 *   router → clinical extraction → verifier
 *
 * Each case uses a different input shape that routes through a different clinical task,
 * and every test asserts both the routing decision and the final pipeline result.
 *
 * No model calls; mock profiles simulate the extraction and verification steps so the
 * tests run deterministically and fast.  The routing logic itself is the real code.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { route } from '../src/modes/router.ts'
import { ROUTER_RULES as CLINICAL_RULES } from '../src/profiles/router/profile.ts'
import { routeClinicalShape, DEFAULT_CLINICAL_RULES } from '../src/profiles/clinical/clinical-router.ts'
import { runWorkflow, buildWorkflow } from '../src/modes/workflow.ts'
import type { ProfileModule, ReviewResult, EvalVerdict } from '../src/core/profile.ts'
import { loadPack } from '../src/core/pack.ts'

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRouterProfile = (): ProfileModule => ({
  name: 'router',
  mode: 'router',
  needsPack: false,
  async review(ctx): Promise<ReviewResult> {
    const text = ctx.input.kind === 'text' ? ctx.input.text : `(case ${ctx.input.name})`
    const result = await route({
      input: text,
      rules: CLINICAL_RULES,
      defaultProfile: 'clinical',
    })
    // The real router profile returns `ok: result.confidence > 0`, which means
    // unmatched inputs stop the pipeline early.  For these integration tests we
    // always return `ok: true` so the pipeline reaches the clinical extraction
    // and verifier steps regardless, letting us test the full flow.
    return {
      text: `routed to ${result.profile} (confidence ${(result.confidence * 100).toFixed(0)}%)`,
      ok: true,
      raw: JSON.stringify(result),
      report: result,
    }
  },
  async runEval(): Promise<EvalVerdict> {
    return { pass: true, summary: 'mock router eval' }
  },
})

const mockClinicalProfile = (): ProfileModule => ({
  name: 'clinical',
  mode: 'extract',
  needsPack: true,
  async review(ctx): Promise<ReviewResult> {
    const text = ctx.input.kind === 'text' ? ctx.input.text : `(case ${ctx.input.name})`

    // Use the real clinical router to decide the task.
    const routeResult = routeClinicalShape(text)

    // Build a synthetic extraction report keyed by the routed task.
    const report: Record<string, unknown> = {
      routedTask: routeResult.task,
      shape: routeResult.shape,
      confidence: routeResult.confidence,
      reason: routeResult.reason,
      // Task-specific synthetic data so downstream verifiers have something to chew on.
      ...(routeResult.task === 'vital-signs' && {
        blood_pressure: { systolic: 120, diastolic: 80, unit: 'mmHg' },
        heart_rate: { value: 72, unit: 'bpm' },
      }),
      ...(routeResult.task === 'transcript' && {
        presenting_complaint: { text: 'chest pain', quote: 'I have chest pain.' },
        medications: [],
      }),
      ...(routeResult.task === 'shock' && {
        category: 'septic',
        categoryConfidence: 0.95,
      }),
      ...(routeResult.task === 'summary' && {
        diagnoses: ['hypertension'],
        medications: ['amlodipine'],
      }),
    }

    return {
      text: `clinical extraction: ${routeResult.task}`,
      ok: true,
      raw: JSON.stringify(report),
      report,
    }
  },
  async runEval(): Promise<EvalVerdict> {
    return { pass: true, summary: 'mock clinical eval' }
  },
})

const mockVerifierProfile = (): ProfileModule => ({
  name: 'verifier',
  mode: 'extract',
  needsPack: false,
  async review(ctx): Promise<ReviewResult> {
    const text = ctx.input.kind === 'text' ? ctx.input.text : `(case ${ctx.input.name})`

    // The real verifier's contract: {document, extraction}. The pipeline composes the
    // step input from a template, so this mock parses the same two fields the real
    // profile demands, rather than the extraction report alone.
    let document: string
    let report: Record<string, unknown> | undefined
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      document = String(parsed.document ?? '')
      report = (parsed.extraction ?? undefined) as Record<string, unknown> | undefined
    } catch {
      return { text: 'verifier: could not parse report', ok: false }
    }
    if (!document) return { text: 'verifier: missing document', ok: false }
    if (!report || typeof report !== 'object') {
      return { text: 'verifier: missing extraction', ok: false }
    }

    const verified = Boolean(report.routedTask)
    const issues: unknown[] = []
    if (!report.routedTask) issues.push({ field: 'routedTask', issue: 'missing', severity: 'high' })

    const verificationReport = {
      verified,
      confidence: verified ? 0.95 : 0.3,
      issues,
      checkedFields: Object.keys(report),
    }

    return {
      text: `verification: ${verified ? 'PASS' : 'FAIL'} (${issues.length} issues)`,
      ok: verified && issues.length === 0,
      raw: JSON.stringify(verificationReport),
      report: verificationReport,
    }
  },
  async runEval(): Promise<EvalVerdict> {
    return { pass: true, summary: 'mock verifier eval' }
  },
})

const buildTestPipeline = (
  initialInput: string,
  contextDir?: string,
) => {
  const profiles = new Map<string, ProfileModule>([
    ['router', mockRouterProfile()],
    ['clinical', mockClinicalProfile()],
    ['verifier', mockVerifierProfile()],
  ])
  const packs = new Map<string, undefined | typeof pack>([
    ['router', undefined],
    ['clinical', pack],
    ['verifier', undefined],
  ])
  const baseUrls = new Map<string, undefined>([['router', undefined], ['clinical', undefined], ['verifier', undefined]])

  return runWorkflow({
    initialInput,
    steps: buildWorkflow([
      { name: 'route', profile: 'router' },
      { name: 'extract', profile: 'clinical', input: 'initial' },
      { name: 'verify', profile: 'verifier', input: { document: 'initial', extraction: 'step-1.report' } },
    ]),
    profiles,
    packs,
    baseUrls,
    contextDir,
  })
}

// ---------------------------------------------------------------------------
// Case 1: Vitals note routes through vital-signs extraction
// ---------------------------------------------------------------------------

test('full flow: vitals note → clinical → vital-signs → verified', async () => {
  const input = `Patient BP 148/92 mmHg, HR 78 bpm, T 36.4°C, SpO2 97%, weight 82.5 kg, height 171 cm.`

  // 1. Router classification
  const routerResult = await route({ input, rules: CLINICAL_RULES, defaultProfile: 'clinical' })
  assert.equal(routerResult.profile, 'clinical', 'router should send vitals to clinical')
  assert.ok(routerResult.confidence > 0, 'router should have confidence > 0')

  // 2. Clinical internal router
  const clinicalRoute = routeClinicalShape(input)
  assert.equal(clinicalRoute.shape, 'vitals-note', 'clinical router should detect vitals-note shape')
  assert.equal(clinicalRoute.task, 'vital-signs', 'clinical router should choose vital-signs task')
  assert.equal(clinicalRoute.confidence, 0.9, 'vitals-note confidence should be 0.9')

  // 3. Full pipeline
  const result = await buildTestPipeline(input)

  assert.equal(result.stoppedEarly, false, 'pipeline should complete all three steps')
  assert.equal(result.steps.length, 3, 'pipeline should have 3 steps')
  assert.equal(result.steps[0]!.ok, true, 'router step should succeed')
  assert.equal(result.steps[1]!.ok, true, 'clinical step should succeed')
  assert.equal(result.steps[2]!.ok, true, 'verifier step should succeed')

  // 4. Final result verification
  const finalReport = result.final as Record<string, unknown> | undefined
  assert.ok(finalReport, 'pipeline should have a final report')
  assert.equal(finalReport!.verified, true, 'verification should pass')
  assert.equal(finalReport!.confidence, 0.95, 'verification confidence should be 0.95')
  assert.deepStrictEqual(finalReport!.checkedFields, [
    'routedTask', 'shape', 'confidence', 'reason',
    'blood_pressure', 'heart_rate',
  ])
})

// ---------------------------------------------------------------------------
// Case 2: Doctor-patient dialogue routes through transcript extraction
// ---------------------------------------------------------------------------

test('full flow: doctor-patient dialogue → clinical → transcript → verified', async () => {
  const input = `Dr: How are you today?
Pt: I have chest pain when I walk up hills.
Dr: Does it settle when you stop?
Pt: Yes, within a couple of minutes.`

  // 1. Router classification
  const routerResult = await route({ input, rules: CLINICAL_RULES, defaultProfile: 'clinical' })
  // The dialogue does not contain vitals keywords, so the router falls back to default 'clinical'.
  assert.equal(routerResult.profile, 'clinical', 'router should default to clinical for dialogue')

  // 2. Clinical internal router
  const clinicalRoute = routeClinicalShape(input)
  assert.equal(clinicalRoute.shape, 'dialogue', 'clinical router should detect dialogue shape')
  assert.equal(clinicalRoute.task, 'transcript', 'clinical router should choose transcript task')
  assert.equal(clinicalRoute.confidence, 0.95, 'dialogue confidence should be 0.95')

  // 3. Full pipeline
  const result = await buildTestPipeline(input)

  assert.equal(result.stoppedEarly, false, 'pipeline should complete all three steps')
  assert.equal(result.steps.length, 3)
  assert.equal(result.steps[0]!.ok, true)
  assert.equal(result.steps[1]!.ok, true)
  assert.equal(result.steps[2]!.ok, true)

  // 4. Final result verification
  const finalReport = result.final as Record<string, unknown> | undefined
  assert.ok(finalReport)
  assert.equal(finalReport!.verified, true)
  assert.deepStrictEqual(finalReport!.checkedFields, [
    'routedTask', 'shape', 'confidence', 'reason',
    'presenting_complaint', 'medications',
  ])
})

// ---------------------------------------------------------------------------
// Case 3: Dictated note routes through transcript extraction
// ---------------------------------------------------------------------------

test('full flow: dictated note → clinical → transcript → verified', async () => {
  const input = `Dictation: BP 120 over 80, heart rate 72, temperature 36.4, patient reports no chest pain.`

  // 1. Router classification
  const routerResult = await route({ input, rules: CLINICAL_RULES, defaultProfile: 'clinical' })
  // Dictation marker overrides vitals keywords because rule confidence is 0.95 > 0.9.
  assert.equal(routerResult.profile, 'transcriptor', 'router should send dictation to transcriptor')
  assert.ok(routerResult.reason.includes('dictation'), 'router reason should mention dictation')

  // 2. Clinical internal router (used when the pipeline still runs clinical anyway)
  const clinicalRoute = routeClinicalShape(input)
  assert.equal(clinicalRoute.shape, 'dictation', 'clinical router should detect dictation shape')
  assert.equal(clinicalRoute.task, 'transcript', 'clinical router should choose transcript task')
  assert.equal(clinicalRoute.confidence, 0.95)

  // 3. Full pipeline (the pipeline always runs clinical for extraction, even when router says transcriptor)
  const result = await buildTestPipeline(input)

  assert.equal(result.stoppedEarly, false)
  assert.equal(result.steps.length, 3)
  assert.equal(result.steps[0]!.ok, true)
  assert.equal(result.steps[1]!.ok, true)
  assert.equal(result.steps[2]!.ok, true)

  // 4. Final result verification
  const finalReport = result.final as Record<string, unknown> | undefined
  assert.ok(finalReport)
  assert.equal(finalReport!.verified, true)
})

// ---------------------------------------------------------------------------
// Case 4: Shock exam JSON routes through shock categorization
// ---------------------------------------------------------------------------

test('full flow: shock exam JSON → clinical → shock → verified', async () => {
  const input = JSON.stringify({
    hypotension: { systolic: 78, diastolic: 38, duration_minutes: 90 },
    heart_rate: 118,
    skin_temperature: 'warm',
    jugular_venous_pressure: 'normal_or_low',
    capillary_refill: 'brisk',
    pulse_volume: 'bounding',
    lung_exam: 'clear',
  })

  // 1. Router classification
  const routerResult = await route({ input, rules: CLINICAL_RULES, defaultProfile: 'clinical' })
  assert.equal(routerResult.profile, 'clinical', 'router should send JSON to clinical')

  // 2. Clinical internal router
  const clinicalRoute = routeClinicalShape(input)
  assert.equal(clinicalRoute.shape, 'exam-json', 'clinical router should detect exam-json shape')
  assert.equal(clinicalRoute.task, 'shock', 'clinical router should choose shock task')
  assert.equal(clinicalRoute.confidence, 1.0, 'exam-json confidence should be definitive 1.0')

  // 3. Full pipeline
  const result = await buildTestPipeline(input)

  assert.equal(result.stoppedEarly, false)
  assert.equal(result.steps.length, 3)
  assert.equal(result.steps[0]!.ok, true)
  assert.equal(result.steps[1]!.ok, true)
  assert.equal(result.steps[2]!.ok, true)

  // 4. Final result verification
  const finalReport = result.final as Record<string, unknown> | undefined
  assert.ok(finalReport)
  assert.equal(finalReport!.verified, true)
  assert.deepStrictEqual(finalReport!.checkedFields, [
    'routedTask', 'shape', 'confidence', 'reason',
    'category', 'categoryConfidence',
  ])
})

// ---------------------------------------------------------------------------
// Case 5: Summary input routes through patient summary extraction
// ---------------------------------------------------------------------------

test('full flow: summary input → clinical → summary → verified', async () => {
  const input = `notes/patient-a.note.txt
notes/patient-b.note.txt
notes/patient-c.note.txt`

  // 1. Router classification
  const routerResult = await route({ input, rules: CLINICAL_RULES, defaultProfile: 'clinical' })
  assert.equal(routerResult.profile, 'clinical', 'router should send summary input to clinical')

  // 2. Clinical internal router
  const clinicalRoute = routeClinicalShape(input)
  assert.equal(clinicalRoute.shape, 'summary-input', 'clinical router should detect summary-input shape')
  assert.equal(clinicalRoute.task, 'summary', 'clinical router should choose summary task')
  assert.equal(clinicalRoute.confidence, 1.0, 'summary-input confidence should be definitive 1.0')

  // 3. Full pipeline
  const result = await buildTestPipeline(input)

  assert.equal(result.stoppedEarly, false)
  assert.equal(result.steps.length, 3)
  assert.equal(result.steps[0]!.ok, true)
  assert.equal(result.steps[1]!.ok, true)
  assert.equal(result.steps[2]!.ok, true)

  // 4. Final result verification
  const finalReport = result.final as Record<string, unknown> | undefined
  assert.ok(finalReport)
  assert.equal(finalReport!.verified, true)
  assert.deepStrictEqual(finalReport!.checkedFields, [
    'routedTask', 'shape', 'confidence', 'reason',
    'diagnoses', 'medications',
  ])
})

// ---------------------------------------------------------------------------
// Checkpoint persistence: full flow writes and resumes
// ---------------------------------------------------------------------------

test('full flow: workflow context is written after each step and resumes correctly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-full-flow-'))
  try {
    const input = 'Patient BP 120/80, HR 72, T 36.5°C.'

    // First run with context directory.
    const result = await buildTestPipeline(input, dir)

    assert.equal(result.stoppedEarly, false)
    assert.ok(existsSync(join(dir, 'context.json')), 'context.json should be written')
    assert.ok(existsSync(join(dir, 'step-0.json')), 'step-0.json should be written')
    assert.ok(existsSync(join(dir, 'step-1.json')), 'step-1.json should be written')
    assert.ok(existsSync(join(dir, 'step-2.json')), 'step-2.json should be written')

    const context = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'))
    assert.equal(context.completedStep, 2, 'completedStep should be 2 (last step index)')
    assert.equal(context.initialInput, input)
    assert.equal(context.results.length, 3)
    assert.equal(context.values['initial'], input)
    assert.ok(context.values['step-0'].output, 'step-0 output should exist')
    assert.ok(context.values['step-1'].output, 'step-1 output should exist')
    assert.ok(context.values['step-2'].output, 'step-2 output should exist')

    // Verify the clinical extraction report was checkpointed correctly.
    const step1 = JSON.parse(readFileSync(join(dir, 'step-1.json'), 'utf8'))
    assert.equal(step1.profile, 'clinical')
    assert.equal(step1.ok, true)
    assert.equal((step1.report as Record<string, unknown>).routedTask, 'vital-signs')

    // Verify the verifier report was checkpointed correctly.
    const step2 = JSON.parse(readFileSync(join(dir, 'step-2.json'), 'utf8'))
    assert.equal(step2.profile, 'verifier')
    assert.equal(step2.ok, true)
    assert.equal((step2.report as Record<string, unknown>).verified, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Rule precedence: dictation marker wins over vitals keywords
// ---------------------------------------------------------------------------

test('full flow: dictation marker takes precedence over vitals-note in clinical router', async () => {
  // This input contains BOTH vitals abbreviations AND a dictation marker.
  // The clinical router should choose dictation (confidence 0.95) over vitals-note (0.9).
  const input = `Dictation: BP 120/80, HR 72, temperature 36.5, SpO2 97%.`

  const clinicalRoute = routeClinicalShape(input)
  assert.equal(clinicalRoute.shape, 'dictation', 'dictation should win over vitals-note')
  assert.equal(clinicalRoute.task, 'transcript')
  assert.equal(clinicalRoute.confidence, 0.95)

  // The external router also should route to transcriptor for this input.
  const routerResult = await route({ input, rules: CLINICAL_RULES, defaultProfile: 'clinical' })
  assert.equal(routerResult.profile, 'transcriptor')
})

// ---------------------------------------------------------------------------
// Edge case: exam-json wins over dialogue when both are present
// ---------------------------------------------------------------------------

test('full flow: exam-json shape wins over dialogue when both present (confidence 1.0 > 0.95)', async () => {
  const input = JSON.stringify({ heart_rate: 110, skin_temperature: 'cool' }) +
    '\nDr: How are you?\nPt: I feel dizzy.'

  const clinicalRoute = routeClinicalShape(input)
  assert.equal(clinicalRoute.shape, 'exam-json', 'exam-json should win with confidence 1.0')
  assert.equal(clinicalRoute.task, 'shock')
  assert.equal(clinicalRoute.confidence, 1.0)
})

// ---------------------------------------------------------------------------
// Edge case: non-clinical input falls through to default
// ---------------------------------------------------------------------------

test('full flow: non-clinical input falls through to default task', async () => {
  const input = 'Hello world, this is a test with no medical terms.'

  const clinicalRoute = routeClinicalShape(input)
  assert.equal(clinicalRoute.shape, 'note', 'non-clinical input should be note shape')
  assert.equal(clinicalRoute.task, 'vital-signs', 'default task should be vital-signs')
  assert.equal(clinicalRoute.confidence, 0, 'confidence should be 0 for default')
})
